import {installationVolumes,SpaceBudgetRefusal} from './personal-disk.ts';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Capacity} from './capacity.ts';
import {Id, Refusal, type Authority} from './contracts.ts';
import {withExamSignals} from './exam-intent.ts';
import {clearExamContextCapacityWaits} from './exam-provider.ts';
import {loadInstallation, type Installation} from './installation.ts';
import {assertInstallationMigrations,migrationsPendingText} from './installation-readiness.ts';
import {Ledger, type VerificationModule} from './ledger.ts';
import {abortPersonalVerifyForLeaseLoss, keepPersonalVerifyLease, releasePersonalVerifyLease} from './personal-verify-cli.ts';
import {examRunOptions, trackExamProgress} from './verify-command.ts';
import {examStopText, isImmediateStop, isInfrastructureFailure} from './exam-breaker.ts';
import {examDependencyText, installationExamPreflight} from './exam-preflight.ts';
import {
  authorizeProjectHttpsOrigin,
  probePublishedHttpsOrigins,
  type PassiveHttpsProbeOptions,
  type ProntidaoPassiveEvidence,
} from './prontidao-target.ts';
import {
  assertVerificationModule,
  discardModuleReport,
  moduleRemeasurementTarget,
  recheckModuleFindings,
  reconcileModuleReports,
  requestModuleCorrection,
  runVerificationModule,
  type CollectorRunnerSpec,
  type ModuleCollectorOutput,
  type VerificationModuleRunResult,
} from './verification-modules.ts';
import {composePersonalModuleExamRuntime, createPersonalModuleExam, createPersonalModuleRecheck, type ModuleExamClock, type ModuleExamRuntime} from './module-exam-native.ts';
import {DEFAULT_MODULE_EXAM_BATCH, type ModuleExamBatch} from './module-exam.ts';
import {assertPersonalActivation} from './verify-intent.ts';
import {recoverPersonalOrphanedExams} from './personal-orphaned-exams.ts';
import {failAbandonedVerifyContext} from './verify-abandon.ts';

const moduleActions = '[--esperar-cota | --corrigir <runId> <ACH-001...> | --medir-correcao <runId> | --reverificar <runId> <ACH-001...> | --descartar <runId>]';
const messages: Record<string, string> = {
  PERSONAL_DISK_FULL: 'Disco em 95% ou mais. Libere espaço antes de iniciar outro exame.',
  PERSONAL_SPACE_BUDGET_EXCEEDED: 'O Agent Control está acima do orçamento de espaço. Rode a retenção com npm run personal:maintenance -- <instalação.json> --retencao-automatica (prévia e depois --aplicar) e meça de novo com npm run personal:espaco -- <instalação.json>.',
  VERIFY_USAGE: `Uso: npm run personal:<modulo> -- <instalação.json> <projeto> ${moduleActions}`,
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
  VERIFY_RUN_CONFLICT: 'A execução ou o commit mudou durante a reverificação.',
  VERIFY_RECHECK_CHANGE_UNPROVEN: 'A medição requer um commit posterior ao commit da execução original.',
  VERIFY_RECHECK_IMAGE_GONE: 'A imagem da execução original (--medir-correcao) já saiu do Docker pela retenção, e uma medição em outra imagem não prova o achado. Rode um exame novo do módulo (npm run personal:<modulo> -- <instalação.json> <projeto>), que usa a imagem atual.',
  VERIFY_RECHECK_FAILED: 'A reverificação falhou. Consulte o registro da execução.',
  VERIFY_RECHECK_PREVIOUS_PUBLICATION_PENDING: 'Há vereditos gravados com publicação pendente. Repita a seleção anterior de --reverificar para publicar o relatório.',
  STALE_MANAGER: 'A autoridade sobre o contexto do módulo expirou.',
  VERIFY_REPORT_INSIDE_REPO: 'O diretório de dados não pode ficar dentro do repositório.',
  VERIFY_SECRET_IN_REPORT: 'Um segredo vivo apareceria no relatório.',
  PRONTIDAO_ORIGIN_INVALID: 'Origem HTTPS inválida; informe apenas esquema https:// sem usuário, caminho ou parâmetros.',
  PRONTIDAO_ORIGIN_UNAUTHORIZED: 'A origem HTTPS informada não está declarada e autorizada na instalação ou no projeto.',
  PROVIDER_USAGE_LIMIT: 'PROVIDER_USAGE_LIMIT. A cota do provedor foi atingida. Consulte as pendências no relatório.',
  PROJECT_ACCOUNTS_UNAVAILABLE: 'Nenhuma conta permitida para este projeto está ativa e disponível no runtime para o papel solicitado.',
  CAPACITY_BUSY: 'As vagas de execução do módulo estão ocupadas. Repita o exame quando houver uma vaga.',
  CAPACITY_QUEUED: 'O exame do módulo aguardou na fila de capacidade até o limite sem abrir vaga.',
  EXAM_INTERRUPTED: 'A execução do módulo foi interrompida.',
  MODULE_EXAM_INCOMPLETE: 'O modelo não examinou todos os arquivos do módulo. Consulte o relatório parcial.',
  NATIVE_PRELAUNCH_SETTLEMENT_PENDING: 'A partida de um job do exame ficou pendente de acerto (por exemplo, login da conta Claude vencido). Renove o login, rode npm run personal:maintenance e execute o módulo de novo.',
};

type ExamIncomplete = NonNullable<VerificationModuleRunResult['examIncomplete']> & {directory: string};
/** The incomplete exam, attached to the MODULE_EXAM_INCOMPLETE refusal so the message can name it. */
function incompleteExam(result: VerificationModuleRunResult, examIncomplete: NonNullable<VerificationModuleRunResult['examIncomplete']>) {
  return Object.assign(new Refusal('MODULE_EXAM_INCOMPLETE', 409), {examIncomplete: {...examIncomplete, directory: result.directory}});
}

/** Batch and routing of the modules 2 to 9 from the project's economy. An absent batchFiles or batchTokens takes the
 * module default, not the security one (8 files) that examRunOptions applies; `scope: false` turns the routing off. */
export function moduleExamEconomy(economy: {batch?: boolean; batchTokens?: number; batchFiles?: number; scope?: boolean} | undefined):
  {batch: ModuleExamBatch | false; scope?: false} {
  return {
    batch: economy?.batch === false ? false
      : {tokens: economy?.batchTokens ?? DEFAULT_MODULE_EXAM_BATCH.tokens, files: economy?.batchFiles ?? DEFAULT_MODULE_EXAM_BATCH.files},
    ...(economy?.scope === false ? {scope: false} : {}),
  };
}

/** Lines printed for a finished run: its id, its report and, when any review failed, how many findings stayed unreviewed. */
export function moduleRunLines(result: VerificationModuleRunResult): string[] {
  const {unreviewed} = result;
  return [result.runId, result.directory,
    ...(unreviewed?.count ? [`Achados sem revisão: ${unreviewed.count} (código ${unreviewed.codes.join(', ')})`] : [])];
}

const recheckGuidance: Record<string, string> = {
  MODULE_RECHECK_ORIGINAL_UNKNOWN: 'Recupere o relatório e a cobertura originais para identificar a origem do achado.',
  MODULE_RECHECK_SAME_COMMIT: 'Integre a correção e rode o módulo no novo commit.',
  MODULE_RECHECK_EXAMINER_SESSION_UNPROVEN: 'O diário não prova a execução original do examinador para este arquivo. '
    + 'Relatórios anteriores à migração 115 ou ao vínculo da sessão por arquivo exigem um novo exame do módulo.',
  MODULE_RECHECK_CHANGE_UNPROVEN: 'Confira a linhagem do commit e a alteração no ponto original do achado.',
  MODULE_RECHECK_MODULE_PROOF_MISSING: 'Use --medir-correcao com o ID original e confira a cobertura da ferramenta no commit atual.',
  MODULE_RECHECK_MEASUREMENT_UNPROVEN: 'Confira a identidade do objeto, os registros por arquivo e o critério da regra nas duas revisões.',
  MODULE_RECHECK_FUNCTIONAL_RULE_UNSUPPORTED: 'A regra ainda não dispõe de prova funcional de antes e depois.',
  MODULE_RECHECK_FUNCTIONAL_ORIGIN_UNPROVEN: 'A medição original do módulo não comprova a condição funcional desta regra.',
  MODULE_RECHECK_FUNCTION_IDENTITY_UNPROVEN: 'A declaração original e a atual precisam identificar inequivocamente a mesma função exportada.',
  MODULE_RECHECK_FUNCTIONAL_TEST_UNAVAILABLE: 'Confira o caminho da regressão e a asserção exigida para o objeto e a regra.',
  MODULE_RECHECK_FUNCTIONAL_EXECUTION_UNAVAILABLE: 'A execução isolada não produziu um resultado válido para a asserção no commit atual.',
  MODULE_RECHECK_ORIGINAL_TEST_PASSED: 'O teste de regressão já passou na revisão original.',
  MODULE_RECHECK_CORRECTED_TEST_FAILED: 'A mesma asserção ainda falhou na revisão corrigida.',
  MODULE_RECHECK_CORRECTION_UNEXPLAINED: 'A revisão precisa vincular a regra, o mesmo alvo e os resultados medidos nas duas revisões.',
};

export function moduleCliFailureText(error: unknown, module?: VerificationModule): string {
  const code = error instanceof Refusal ? error.code : error instanceof Error ? error.message : '';
  if (code === 'MIGRATIONS_PENDING') return `${code}. ${migrationsPendingText}`;
  if (error instanceof SpaceBudgetRefusal) return error.detail;
  const dependency = examDependencyText(error);
  if (dependency) return dependency;
  const incomplete = (error as {examIncomplete?: ExamIncomplete} | null)?.examIncomplete;
  if (code === 'MODULE_EXAM_INCOMPLETE' && incomplete) {
    const stop = isInfrastructureFailure(incomplete.code) || isImmediateStop(incomplete.code) ? `${examStopText(incomplete.code)} ` : '';
    return `${stop}O modelo não examinou ${incomplete.unjudged} de ${incomplete.total} arquivos (código ${incomplete.code}). Relatório parcial em ${incomplete.directory}.`;
  }
  if (code === 'VERIFY_USAGE' && module) {
    const origin = module === 'prontidao' ? ' [--origem <https://...>]' : '';
    return `Uso: npm run personal:${module} -- <instalação.json> <projeto>${origin} ${moduleActions}`;
  }
  return messages[code] ?? (code || 'A execução do módulo falhou.');
}

export type ParsedPersonalModuleInvocation =
  | {kind: 'run'; module: VerificationModule; installationPath: string; projectToken: string; origin?: string; waitForQuota?: boolean}
  | {kind: 'discard'; module: VerificationModule; installationPath: string; projectToken: string; runId: string}
  | {kind: 'measure'; module: VerificationModule; installationPath: string; projectToken: string; runId: string}
  | {kind: 'remediate' | 'recheck'; module: VerificationModule; installationPath: string; projectToken: string; runId: string; achadoIds: string[]};

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
  if (rest[0] === '--descartar' || rest[0] === '--medir-correcao') {
    const runId = rest[1];
    if (rest.length !== 2 || !runId || runId.startsWith('--') || !Id.safeParse(runId).success) {
      throw new Refusal('VERIFY_USAGE', 400);
    }
    return {kind: rest[0] === '--descartar' ? 'discard' : 'measure', module, installationPath, projectToken, runId};
  }
  if (rest[0] === '--corrigir' || rest[0] === '--reverificar') {
    const runId = rest[1];
    const achadoIds = rest.slice(2);
    if (!runId || runId.startsWith('--') || !Id.safeParse(runId).success || achadoIds.length === 0) {
      throw new Refusal('VERIFY_USAGE', 400);
    }
    const recheck = rest[0] === '--reverificar';
    if (achadoIds.some(id => recheck ? !/^ACH-\d{3}$/.test(id) : id.startsWith('--'))) {
      throw new Refusal('VERIFY_USAGE', 400);
    }
    return {kind: recheck ? 'recheck' : 'remediate', module, installationPath, projectToken, runId, achadoIds};
  }
  let origin: string | undefined;
  let waitForQuota = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === '--esperar-cota') {
      if (waitForQuota) throw new Refusal('VERIFY_USAGE', 400);
      waitForQuota = true;
      continue;
    }
    if (module === 'prontidao' && (arg === '--origem' || arg.startsWith('--origem='))) {
      if (origin !== undefined) throw new Refusal('VERIFY_USAGE', 400);
      if (arg === '--origem') {
        const value = rest[index + 1];
        if (!value || value.startsWith('--')) throw new Refusal('VERIFY_USAGE', 400);
        origin = value;
        index += 1;
      } else {
        origin = arg.slice('--origem='.length);
        if (!origin || origin.startsWith('--')) throw new Refusal('VERIFY_USAGE', 400);
      }
      continue;
    }
    throw new Refusal('VERIFY_USAGE', 400);
  }
  return {
    kind: 'run',
    module,
    installationPath,
    projectToken,
    ...(origin !== undefined ? {origin} : {}),
    ...(waitForQuota ? {waitForQuota: true} : {}),
  };
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
  /** Tests supply a synthetic native supervisor and an isolated collector. */
  moduleExamRuntime?: () => Promise<ModuleExamRuntime>;
  clock?: ModuleExamClock;
  leaseHeartbeatMs?: number;
  onQuotaWait?: (info: {purpose: 'examiner' | 'reviewer'; file: string; delayMs: number}) => void;
  onResult?: (result: VerificationModuleRunResult) => void;
  /** Dependency check before the run and each examiner batch. Default: the installation's, when the native runtime is active. */
  preflight?: () => Promise<void>;
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

  const ledger = new Ledger(config.databaseUrl, config.installationAuthority?.token, undefined, installationVolumes(config));
  let authority: Authority | undefined;
  let stopRecheckLease: (() => void) | undefined;
  const recheckAbort = parsed.kind === 'recheck' ? new AbortController() : undefined;
  const interruptRecheck = () => recheckAbort?.abort(new Refusal('EXAM_INTERRUPTED'));
  if (recheckAbort) {
    process.on('SIGINT', interruptRecheck);
    process.on('SIGTERM', interruptRecheck);
  }
  try {
    await assertInstallationMigrations(ledger);
    if (parsed.kind === 'discard') {
      await discardModuleReport(ledger, project.owner, config.dataDirectory, project.id, module, parsed.runId);
      return ['Relatório descartado.'];
    }
    if (recheckAbort) {
      await assertPersonalActivation(ledger);
      const membership = await ledger.pool.query("SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner'",
        [project.id, project.owner]);
      if (!membership.rowCount) throw new Refusal('PROJECT_FORBIDDEN', 403);
      recheckAbort.signal.throwIfAborted();
    }
    const exam = await ledger.ensureExamContext(project.owner, project.id, module);
    await recoverPersonalOrphanedExams(config,ledger,{contextId:exam.contextId},true);
    await failAbandonedVerifyContext(ledger,config.dataDirectory,project.owner,exam.contextId);
    authority = await acquirePersonalModule(ledger, project.owner, exam.contextId, module);
    if (recheckAbort) {
      stopRecheckLease = keepPersonalVerifyLease(ledger, authority, 5000,
        () => recheckAbort.abort(new Refusal('VERIFY_LEASE_LOST')));
      recheckAbort.signal.throwIfAborted();
    }
    if (parsed.kind !== 'measure' && exam.mainCapacityPolicyRevision !== null && exam.capacityPolicyRevision !== exam.mainCapacityPolicyRevision) {
      await new Capacity(ledger).assignPolicy(project.owner, exam.contextId, exam.mainCapacityPolicyRevision);
    }

    const runOptions = examRunOptions(project.economy);
    if (parsed.kind === 'recheck') {
      const {results, publication} = await recheckModuleFindings(ledger, project.owner, authority, {
        module, runId: parsed.runId, achadoIds: parsed.achadoIds, dataDirectory: config.dataDirectory, projectId: project.id,
        signal: recheckAbort?.signal,
        review: createPersonalModuleRecheck({ledger, principal: project.owner, authority,
          pollBackoff: runOptions.pollBackoff,
          ...(deps?.clock ? {clock: deps.clock} : {}),
          ...(project.allowedAccountIds ? {allowedAccountIds: project.allowedAccountIds} : {}),
          loadRuntime: deps?.moduleExamRuntime ?? (() => composePersonalModuleExamRuntime(config, ledger, project.allowedAccountIds))}),
      });
      const lines = results.map(result => {
        if (result.status !== 'pendente') return `${result.id} ${result.status}`;
        const guidance = recheckGuidance[result.reason];
        return `${result.id} pendente ${result.reason}${guidance ? ` (${guidance})` : ''}`;
      });
      if (publication === 'pending') {
        lines.push('Vereditos gravados. Publicação do relatório pendente (VERIFY_RECHECK_PUBLICATION_PENDING). Repita o mesmo comando para publicar.');
      }
      return lines;
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
      return [...(corrected.messageLocalIds ?? [corrected.messageLocalId]), ...corrected.writePaths];
    }

    let providerLimited = false;
    const runId = randomUUID();
    const collectorAbort = new AbortController();
    let rejectAbort: (error: unknown) => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    void aborted.catch(() => undefined /* marks the rejection handled; raced below */);
    let stopLease: () => void = () => {};
    stopLease = keepPersonalVerifyLease(ledger, authority, deps?.leaseHeartbeatMs ?? 5000, () => {
      void abortPersonalVerifyForLeaseLoss({
        stopLease() {
          stopLease();
        },
        async stopJob() {
          collectorAbort.abort();
        },
        rejectAbort,
      });
    });

    let runningTask: Promise<VerificationModuleRunResult> | undefined;
    // andamento/<runId>.json with this node's PID: `personal:status` follows the run without pgrep.
    const tracked = trackExamProgress(config.dataDirectory, project.id, runId, module);
    const waitForClaudeQuota = parsed.kind === 'run' && parsed.waitForQuota === true;
    const execute = async (signal: AbortSignal) => {
      const passiveTlsEvidence: ProntidaoPassiveEvidence | undefined =
        module === 'prontidao' && authorizedOrigins.length > 0 && deps?.collectorOutput === undefined
          ? await probePublishedHttpsOrigins(authorizedOrigins, {...deps?.prontidaoProbeOptions, signal})
          : undefined;
      signal.throwIfAborted();
      const measurement = parsed.kind === 'measure' ? await moduleRemeasurementTarget(ledger, project.owner, authority!, {
        projectId: project.id, module, runId: parsed.runId, repo: project.repo, signal,
      }) : undefined;
      const commit = measurement?.commit ?? await readHead(project.repo);
      signal.throwIfAborted();
      const preflight = deps?.preflight ?? (config.nativeBootstrap?.state === 'active' && !deps?.moduleExamRuntime
        ? installationExamPreflight(config, ledger) : undefined);
      const runExam = measurement ? undefined : createPersonalModuleExam({
        ledger, principal: project.owner, authority: authority!, commit,
        mapEnabled: project.economy?.map,
        ...moduleExamEconomy(project.economy),
        toolsOnly: config.nativeBootstrap?.state !== 'active',
        pollBackoff: runOptions.pollBackoff,
        ...(project.allowedAccountIds ? {allowedAccountIds: project.allowedAccountIds} : {}),
        loadRuntime: deps?.moduleExamRuntime ?? (() => composePersonalModuleExamRuntime(config, ledger, project.allowedAccountIds)),
        ...(waitForClaudeQuota ? {waitForClaudeQuota: true} : {}),
        ...(deps?.clock ? {clock: deps.clock} : {}),
        ...(deps?.onQuotaWait ? {onQuotaWait: deps.onQuotaWait} : {}),
        ...(project.economy?.maxModelCalls !== undefined ? {maxModelCalls: project.economy.maxModelCalls} : {}),
        ...(preflight ? {preflight} : {}),
        onProgress: ({phase, judged, total, modelCalls, lastFailureCode, failureStreak}) => {
          void tracked.update({phase, judged, total, modelCalls, failureStreak, ...(lastFailureCode ? {lastFailureCode} : {})});
        },
      });
      return runVerificationModule({
        ...(preflight && runExam ? {preflight} : {}),
        isolation:config.isolation??'simple',
        module,
        ledger,
        principal: project.owner,
        authority: authority!,
        projectId: project.id,
        repoPath: project.repo,
        dataDirectory: config.dataDirectory,
        commit,
        runId,
        signal,
        ...(project.allowedAccountIds ? {allowedAccountIds: project.allowedAccountIds} : {}),
        ...(deps?.clock ? {createdAt: new Date(deps.clock.now())} : {}),
        image: measurement?.image ?? deps?.image,
        ...(measurement && parsed.kind === 'measure' ? {remeasureOf: parsed.runId} : {}),
        ...(deps?.rootDir !== undefined ? {rootDir: deps.rootDir} : {}),
        ...(deps?.timeoutMs !== undefined ? {timeoutMs: deps.timeoutMs} : {}),
        ...(deps?.maxStdoutBytes !== undefined ? {maxStdoutBytes: deps.maxStdoutBytes} : {}),
        ...(passiveTlsEvidence !== undefined ? {passiveTlsEvidence} : {}),
        ...(deps?.collectorOutput !== undefined ? {collectorOutput: deps.collectorOutput} : {}),
        ...(deps?.runCollector !== undefined ? {runCollector: deps.runCollector} : {}),
        examinar: runExam && (async request => {
          const examined = await runExam(request);
          providerLimited = examined.coverage.some(row => row.reason === 'PROVIDER_USAGE_LIMIT')
            || examined.findings.some(finding => finding.failure === 'PROVIDER_USAGE_LIMIT');
          return examined;
        }),
      });
    };
    try {
      const result = await withExamSignals(
        async signal => {
          const runSignals = [signal, collectorAbort.signal];
          if (deps?.prontidaoProbeOptions?.signal) runSignals.push(deps.prontidaoProbeOptions.signal);
          const task = runningTask = execute(AbortSignal.any(runSignals));
          void task.catch(() => undefined /* marks the rejection handled; raced below */);
          return await Promise.race([task, aborted]);
        },
        () => {
          collectorAbort.abort();
        },
      );
      deps?.onResult?.(result);
      const stopCode = result.examIncomplete?.code;
      await tracked.finish(stopCode && (isInfrastructureFailure(stopCode) || isImmediateStop(stopCode)) ? 'stopped'
        : result.examIncomplete || result.hasToolFailure || providerLimited ? 'failed' : 'done',
      stopCode ? {note: examStopText(stopCode), lastFailureCode: stopCode} : {});
      if (providerLimited || result.examIncomplete?.code === 'PROVIDER_USAGE_LIMIT') throw new Refusal('PROVIDER_USAGE_LIMIT', 409);
      if (result.examIncomplete) throw incompleteExam(result, result.examIncomplete);
      if (result.hasToolFailure) {
        throw new Refusal('VERIFY_TOOLS_FAILED', 409);
      }
      return moduleRunLines(result);
    } catch (error) {
      await tracked.finish('failed', error instanceof Refusal ? {lastFailureCode: error.code} : {});
      throw error;
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
  } catch (error) {
    if (recheckAbort && !(error instanceof Refusal)) throw new Refusal('VERIFY_RECHECK_FAILED', 503);
    throw error;
  } finally {
    stopRecheckLease?.();
    try {
      if (authority) {
        await clearExamContextCapacityWaits(ledger.pool, authority.contextId, undefined, authority.epoch);
        await releasePersonalVerifyLease(
          {pool: {query: (sql, params) => ledger.pool.query(sql, (params ?? []) as never[])}},
          authority,
        ).catch(() => undefined /* an unreleased lease expires by itself */);
      }
      await ledger.close();
    } finally {
      if (recheckAbort) {
        process.off('SIGINT', interruptRecheck);
        process.off('SIGTERM', interruptRecheck);
      }
    }
  }
}

export function printClaudeQuotaWait({delayMs}: {delayMs: number}): void {
  console.error(`PROVIDER_USAGE_LIMIT. Aguardando ${Math.round(delayMs / 60000)} minutos pela renovação da cota Claude para retomar o exame.`);
}

async function main(): Promise<void> {
  const rawModule = process.argv[2];
  let module: VerificationModule | undefined;
  try {
    module = assertVerificationModule(rawModule);
    const printed: string[] = [];
    const lines = await runPersonalModuleCli(module, process.argv.slice(3), {
      onQuotaWait: printClaudeQuotaWait,
      onResult(result) {
        for (const line of moduleRunLines(result)) {
          printed.push(line);
          console.log(line);
        }
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
