import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Capacity} from './capacity.ts';
import {Id, Refusal, type Authority} from './contracts.ts';
import {withExamSignals} from './exam-intent.ts';
import {loadInstallation, type Installation} from './installation.ts';
import {Ledger, type VerificationModule} from './ledger.ts';
import {abortPersonalVerifyForLeaseLoss, keepPersonalVerifyLease, releasePersonalVerifyLease} from './personal-verify-cli.ts';
import {
  authorizeProjectHttpsOrigin,
  probePublishedHttpsOrigins,
  type PassiveHttpsProbeOptions,
  type ProntidaoPassiveEvidence,
} from './prontidao-target.ts';
import {
  assertVerificationModule,
  discardModuleReport,
  reconcileModuleReports,
  requestModuleCorrection,
  runVerificationModule,
  type CollectorRunnerSpec,
  type ModuleCollectorOutput,
  type VerificationModuleRunResult,
} from './verification-modules.ts';
import type {VerifyWorker} from './verify-types.ts';

const messages: Record<string, string> = {
  VERIFY_USAGE: 'Uso: npm run personal:<modulo> -- <instalação.json> <projeto> [--corrigir <runId> <ACH-001...> | --descartar <runId>]',
  PERSONAL_ACTIVATION_REQUIRED: 'O módulo de verificação só roda numa instalação pessoal.',
  NOT_FOUND: 'Projeto não encontrado.',
  VERIFY_PROJECT_AMBIGUOUS: 'Há mais de um projeto com esse label.',
  VERIFY_CONTEXT_REQUIRED: 'O projeto não tem um contexto para verificar.',
  EXAM_CONTEXT_MISMATCH: 'O contexto do exame não corresponde ao módulo solicitado.',
  PROJECT_SCOPE_MISMATCH: 'O contexto não pertence ao projeto solicitado.',
  PROJECT_FORBIDDEN: 'Acesso negado ao projeto.',
  CONTEXT_FORBIDDEN: 'Acesso negado ao contexto.',
  VERIFY_REPORT_INTEGRITY: 'O relatório confirmado está ausente ou não corresponde ao registro da execução.',
  VERIFY_CONTAINER_CLEANUP_PENDING: 'A remoção do contêiner ainda não pôde ser confirmada. A limpeza permanece pendente.',
  VERIFY_TOOLS_FAILED: 'Uma ou mais ferramentas do módulo falharam (registrado na cobertura do relatório).',
  VERIFY_COLLECTOR_INVALID: 'A saída do coletor é inválida.',
  VERIFY_STDOUT_LIMIT: 'A saída stdout do coletor excedeu o limite permitido.',
  VERIFY_PATH_FORBIDDEN: 'Caminho inválido ou proibido no repositório ou relatório.',
  VERIFY_SOCKET_FORBIDDEN: 'Montagem de socket proibida no coletor.',
  VERIFY_NETWORK_FORBIDDEN: 'Configuração de rede proibida no coletor.',
  VERIFY_LIMITS_INVALID: 'Limites de execução do coletor são inválidos.',
  VERIFY_COMMIT_INVALID: 'Não foi possível ler o commit do repositório.',
  VERIFY_IMAGE_UNPINNED: 'A imagem do módulo não está fixada por digest.',
  VERIFY_ALREADY_RUNNING: 'Já existe uma execução deste módulo em andamento neste projeto.',
  VERIFY_LEASE_LOST: 'A locação da execução do módulo falhou.',
  VERIFY_NOTHING_TO_FIX: 'Selecione ao menos um achado para converter em tarefa.',
  VERIFY_TOO_MANY: 'A operação aceita no máximo 20 achados por vez.',
  VERIFY_FINDING_MISSING: 'Achado não encontrado ou não elegível para correção.',
  VERIFY_RUN_MISSING: 'Execução do módulo não encontrada neste projeto.',
  VERIFY_REPORT_INSIDE_REPO: 'O diretório de dados não pode ficar dentro do repositório.',
  VERIFY_SECRET_IN_REPORT: 'Um segredo vivo apareceria no relatório.',
  PRONTIDAO_ORIGIN_INVALID: 'Origem HTTPS inválida; informe apenas esquema https:// sem usuário, caminho ou parâmetros.',
  PRONTIDAO_ORIGIN_UNAUTHORIZED: 'A origem HTTPS informada não está declarada e autorizada na instalação ou no projeto.',
  EXAM_INTERRUPTED: 'A execução do módulo foi interrompida.',
};

export function moduleCliFailureText(error: unknown, module?: VerificationModule): string {
  const code = error instanceof Refusal ? error.code : error instanceof Error ? error.message : '';
  if (code === 'VERIFY_USAGE' && module) {
    if (module === 'prontidao') {
      return 'Uso: npm run personal:prontidao -- <instalação.json> <projeto> [--origem <https://...>] [--corrigir <runId> <ACH-001...> | --descartar <runId>]';
    }
    return `Uso: npm run personal:${module} -- <instalação.json> <projeto> [--corrigir <runId> <ACH-001...> | --descartar <runId>]`;
  }
  return messages[code] ?? (code || 'A execução do módulo falhou.');
}

export type ParsedPersonalModuleInvocation =
  | {kind: 'run'; module: VerificationModule; installationPath: string; projectToken: string; origin?: string}
  | {kind: 'discard'; module: VerificationModule; installationPath: string; projectToken: string; runId: string}
  | {kind: 'remediate'; module: VerificationModule; installationPath: string; projectToken: string; runId: string; achadoIds: string[]};

export function parsePersonalModuleArgs(
  module: VerificationModule,
  argv: readonly string[],
): ParsedPersonalModuleInvocation {
  assertVerificationModule(module);
  const installationPath = argv[0];
  const projectToken = argv[1];
  if (
    !installationPath
    || !projectToken
    || installationPath.startsWith('--')
    || projectToken.startsWith('--')
  ) {
    throw new Refusal('VERIFY_USAGE', 400);
  }
  const rest = argv.slice(2);
  if (rest.length === 0) {
    return {kind: 'run', module, installationPath, projectToken};
  }
  if (module === 'prontidao' && (rest[0] === '--origem' || rest[0]?.startsWith('--origem='))) {
    let origin: string | undefined;
    if (rest[0] === '--origem') {
      if (rest.length !== 2 || !rest[1] || rest[1].startsWith('--')) {
        throw new Refusal('VERIFY_USAGE', 400);
      }
      origin = rest[1];
    } else {
      if (rest.length !== 1) throw new Refusal('VERIFY_USAGE', 400);
      origin = rest[0].slice('--origem='.length);
      if (!origin || origin.startsWith('--')) throw new Refusal('VERIFY_USAGE', 400);
    }
    return {kind: 'run', module, installationPath, projectToken, origin};
  }
  if (rest[0] === '--descartar') {
    const runId = rest[1];
    if (rest.length !== 2 || !runId || runId.startsWith('--') || !Id.safeParse(runId).success) {
      throw new Refusal('VERIFY_USAGE', 400);
    }
    return {kind: 'discard', module, installationPath, projectToken, runId};
  }
  if (rest[0] === '--corrigir') {
    const runId = rest[1];
    const achadoIds = rest.slice(2);
    if (!runId || runId.startsWith('--') || !Id.safeParse(runId).success || achadoIds.length === 0) {
      throw new Refusal('VERIFY_USAGE', 400);
    }
    if (achadoIds.some(id => id.startsWith('--'))) {
      throw new Refusal('VERIFY_USAGE', 400);
    }
    return {kind: 'remediate', module, installationPath, projectToken, runId, achadoIds};
  }
  throw new Refusal('VERIFY_USAGE', 400);
}

function resolveProject(config: Installation, token: string) {
  const hits = [config.project, ...config.projects].filter(item => item.id === token || item.label === token);
  if (hits.length === 0) throw new Refusal('NOT_FOUND', 404);
  if (hits.length > 1) throw new Refusal('VERIFY_PROJECT_AMBIGUOUS', 409);
  return hits[0]!;
}

function readHead(repoPath: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('/usr/bin/git', ['-C', repoPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/nonexistent',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
    }, (error, stdout) => {
      const commit = (stdout ?? '').trim();
      if (error || !/^[a-f0-9]{40}$/.test(commit)) reject(new Refusal('VERIFY_COMMIT_INVALID', 400));
      else resolvePromise(commit);
    });
  });
}

async function acquirePersonalModule(
  ledger: Ledger,
  principal: string,
  contextId: string,
  module: VerificationModule,
): Promise<Authority> {
  const instanceId = randomUUID();
  try {
    try {
      return await ledger.acquire(principal, contextId, instanceId, `personal-${module}`, 3600);
    } catch (error) {
      if (!(error instanceof Refusal) || error.code !== 'INVALID_LEASE') throw error;
      return await ledger.acquire(principal, contextId, instanceId, `personal-${module}`, 60);
    }
  } catch (error) {
    if (error instanceof Refusal && error.code === 'MANAGER_ACTIVE') {
      throw new Refusal('VERIFY_ALREADY_RUNNING', 409);
    }
    throw error;
  }
}

export type PersonalModuleCliDeps = {
  image?: string;
  rootDir?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  prontidaoProbeOptions?: PassiveHttpsProbeOptions;
  collectorOutput?: unknown;
  runCollector?: (spec: CollectorRunnerSpec) => Promise<string | Buffer | ModuleCollectorOutput>;
  worker?: VerifyWorker;
  onResult?: (result: VerificationModuleRunResult) => void;
};

export async function runPersonalModuleCli(
  module: VerificationModule,
  argv: readonly string[],
  deps?: PersonalModuleCliDeps,
): Promise<string[]> {
  const parsed = parsePersonalModuleArgs(module, argv);
  const config = await loadInstallation(resolve(parsed.installationPath));
  if (config.activation !== 'personal') throw new Refusal('PERSONAL_ACTIVATION_REQUIRED', 403);
  const project = resolveProject(config, parsed.projectToken);

  const authorizedOrigins = parsed.kind === 'run' && module === 'prontidao'
    ? authorizeProjectHttpsOrigin(config, project.id, parsed.origin)
    : [];

  const ledger = new Ledger(config.databaseUrl, config.installationAuthority?.token);
  let authority: Authority | undefined;
  try {
    if (parsed.kind === 'discard') {
      await discardModuleReport(ledger, project.owner, config.dataDirectory, project.id, module, parsed.runId);
      return ['Relatório descartado.'];
    }
    const exam = await ledger.ensureExamContext(project.owner, project.id, module);
    authority = await acquirePersonalModule(ledger, project.owner, exam.contextId, module);
    if (exam.mainCapacityPolicyRevision !== null && exam.capacityPolicyRevision !== exam.mainCapacityPolicyRevision) {
      await new Capacity(ledger).assignPolicy(project.owner, exam.contextId, exam.mainCapacityPolicyRevision);
    }

    if (parsed.kind === 'remediate') {
      await reconcileModuleReports(ledger, project.owner, authority, config.dataDirectory, project.id);
      const corrected = await requestModuleCorrection(ledger, project.owner, authority, {
        module,
        runId: parsed.runId,
        achadoIds: parsed.achadoIds,
        dataDirectory: config.dataDirectory,
        projectId: project.id,
        repoPath: project.repo,
      });
      return [corrected.messageLocalId, ...corrected.writePaths];
    }

    const passiveTlsEvidence: ProntidaoPassiveEvidence | undefined =
      module === 'prontidao' && authorizedOrigins.length > 0 && deps?.collectorOutput === undefined
        ? await probePublishedHttpsOrigins(authorizedOrigins, deps?.prontidaoProbeOptions)
        : undefined;

    const commit = await readHead(project.repo);
    const runId = randomUUID();
    const collectorAbort = new AbortController();
    let rejectAbort: (error: unknown) => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    void aborted.catch(() => undefined);
    let stopLease: () => void = () => {};
    stopLease = keepPersonalVerifyLease(ledger, authority, 5000, () => {
      void abortPersonalVerifyForLeaseLoss({
        stopLease() {
          stopLease();
        },
        async stopJob() {
          collectorAbort.abort();
          await deps?.worker?.stop?.();
        },
        rejectAbort,
      });
    });

    let runningTask: Promise<VerificationModuleRunResult> | undefined;
    try {
      const result = await withExamSignals(
        async () => {
          const task = runningTask = runVerificationModule({
            module,
            ledger,
            principal: project.owner,
            authority: authority!,
            projectId: project.id,
            repoPath: project.repo,
            dataDirectory: config.dataDirectory,
            commit,
            runId,
            signal: collectorAbort.signal,
            ...(deps?.image !== undefined ? {image: deps.image} : {}),
            ...(deps?.rootDir !== undefined ? {rootDir: deps.rootDir} : {}),
            ...(deps?.timeoutMs !== undefined ? {timeoutMs: deps.timeoutMs} : {}),
            ...(deps?.maxStdoutBytes !== undefined ? {maxStdoutBytes: deps.maxStdoutBytes} : {}),
            ...(passiveTlsEvidence !== undefined ? {passiveTlsEvidence} : {}),
            ...(deps?.collectorOutput !== undefined ? {collectorOutput: deps.collectorOutput} : {}),
            ...(deps?.runCollector !== undefined ? {runCollector: deps.runCollector} : {}),
            ...(deps?.worker !== undefined ? {worker: deps.worker} : {}),
          });
          void task.catch(() => undefined);
          return await Promise.race([task, aborted]);
        },
        () => {
          collectorAbort.abort();
          void deps?.worker?.stop?.().catch(() => undefined);
        },
      );
      deps?.onResult?.(result);
      if (result.hasToolFailure) {
        throw new Refusal('VERIFY_TOOLS_FAILED', 409);
      }
      return [result.runId, result.directory];
    } finally {
      stopLease();
      // Let the aborted run stop its collector and finish fenced cleanup before
      // releasing the lease and closing the database pool.
      if (collectorAbort.signal.aborted && runningTask) {
        await runningTask.catch(error => {
          if (error instanceof Refusal && error.code === 'VERIFY_CONTAINER_CLEANUP_PENDING') throw error;
        });
      }
    }
  } finally {
    if (authority) {
      await releasePersonalVerifyLease(
        {pool: {query: (sql, params) => ledger.pool.query(sql, (params ?? []) as never[])}},
        authority,
      ).catch(() => undefined);
    }
    await ledger.close();
  }
}

async function main(): Promise<void> {
  const rawModule = process.argv[2];
  let module: VerificationModule | undefined;
  try {
    module = assertVerificationModule(rawModule);
    const printed: string[] = [];
    const lines = await runPersonalModuleCli(module, process.argv.slice(3), {
      onResult(result) {
        printed.push(result.runId, result.directory);
        console.log(result.runId);
        console.log(result.directory);
      },
    });
    if (printed.length === 0) {
      for (const line of lines) console.log(line);
    }
    process.exit(0);
  } catch (error) {
    console.error(moduleCliFailureText(error, module));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
