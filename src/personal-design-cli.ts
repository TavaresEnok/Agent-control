import {installationVolumes} from './personal-disk.ts';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Refusal} from './contracts.ts';
import {finishExamIntent, withExamSignals} from './exam-intent.ts';
import {EXAM_LOGIN_BUSY_TEXT, EXAM_LOGIN_RESTORE_FAILED_TEXT, EXAM_LOGIN_STALE_TEXT} from './exam-login.ts';
import {UnstartedExamRetirementPending} from './native-execution-supervisor.ts';
import {openDesignBrowser} from './design-browser.ts';
import {parseDesignArgs, parseDesignInvocation, readDesignLoginFile, readDesignRepository, resolvePersonalDesign, type ResolvedPersonalDesign} from './design-command.ts';
import {DesignCreateModelFailure, MAX_CREATE_TASK_CHARS, runDesignCreate, type CreateExam} from './design-create.ts';
import {readRebuildImagePin, removeActiveDesignContainers} from './design-image-run.ts';
import {runDesignModule} from './design-module.ts';
import {formatDesignPrepare, prepareDesignSpecialist} from './design-prepare.ts';
import {readReferenceFiles} from './design-reference-files.ts';
import {approveDesignBaseline} from './design-regression.ts';
import {readDesignCaptureFiles} from './design-report.ts';
import {loadInstallation} from './installation.ts';
import {assertInstallationMigrations,migrationsPendingText} from './installation-readiness.ts';
import {Ledger} from './ledger.ts';
import {containFailure} from './failure-log.ts';
import {assertInternalDesignNetwork, readDesignTrustCa, stageDesignTrustCa} from './design-trust.ts';
import {examStopText} from './exam-breaker.ts';
import {examDependencyText} from './exam-preflight.ts';
import {trackExamProgress} from './verify-command.ts';

const messages: Record<string, string> = {
  DESIGN_USAGE: 'Uso: npm run personal:design -- <instalação.json> <projectId> --url <url> [--login-file <arquivo>] [--ca <arquivo.pem>] [--esperar-cota]',
  DESIGN_TRUST_CA_INVALID: 'O --ca tem que ser um arquivo PEM só com certificados de CA, e a URL tem que ser https num host .local.',
  DESIGN_TRUST_CA_NETWORK: 'O --ca só é aceito com a rede design-homologation interna (sem saída para a internet).',
  DESIGN_TRUST_CA_FAILED: 'O certificado da homologação não fecha na CA informada em --ca, ou o host não respondeu em HTTPS.',
  PERSONAL_ACTIVATION_REQUIRED: 'O exame de design só roda numa instalação pessoal.',
  NOT_FOUND: 'Projeto não encontrado.',
  DESIGN_CONTEXT_REQUIRED: 'O projeto não tem um contexto para o exame.',
  DESIGN_BUSY: 'Já existe uma execução de design em andamento neste projeto.',
  CAPACITY_BUSY: 'As vagas de execução para o design estão ocupadas. Repita com --esperar-cota para esperar na fila.',
  CAPACITY_QUEUED: 'Há outro exame na frente da fila de capacidade. Repita com --esperar-cota para esperar a vez.',
  DESIGN_WORKER_UNAVAILABLE: 'O runtime pessoal não está ativo.',
  DESIGN_EXTERNAL_TARGET: 'A URL tem que ficar em localhost, 127.0.0.1 ou num host .local.',
  DESIGN_TARGET_ESCAPE: 'A URL aponta para outro destino.',
  DESIGN_TARGET_UNREACHABLE: 'O contêiner não alcança o localhost do host. Use --servir <pasta>.',
  DESIGN_SERVE_INVALID: 'A pasta de --servir tem que ser um diretório.',
  DESIGN_CAPTURE_LOGIN_FAILED: 'A autenticação da captura de design falhou.',
  DESIGN_LOGIN_MODE: 'O arquivo de login tem que estar no modo 0600.',
  DESIGN_LOGIN_INVALID: 'O arquivo de login não tem os campos esperados.',
  DESIGN_COMMIT_INVALID: 'Não foi possível ler o commit do repositório.',
  DESIGN_PROVIDER_MUST_DIFFER: 'O revisor tem que ser outro provedor.',
  DESIGN_REVIEWER_UNAVAILABLE: 'Falta o perfil Claude Opus 5.5 medium de revisão na conta prioritária da cadeia specialist; rode `npm run personal:design -- preparar <instalação.json> <projectId> --aplicar`.',
  EXAM_PROVIDER_UNSUPPORTED: 'O exame de leitura só aceita uma conta Claude.',
  DESIGN_EXAM_TIMEOUT: 'O exame passou do tempo.',
  DESIGN_REPO_UNREADABLE: 'Não foi possível ler o repositório do projeto.',
  DESIGN_PASSWORD_LEAK: 'A senha de login apareceria no relatório.',
  DESIGN_BROWSER_MISSING: 'O Chrome do painel não está disponível para a captura.',
  DESIGN_IMAGE_FAILED: 'A imagem de design não entregou os achados.',
  DESIGN_IMAGE_TIMEOUT: 'A imagem de design passou do tempo.',
  DESIGN_IMAGE_UNPINNED: 'A imagem de design não está fixada pelo digest.',
  DESIGN_CREATE_MODEL_UNAVAILABLE: 'Confira o catálogo e os perfis Claude da conta prioritária. O design exige Opus 5.5 high para criar, examinar e fazer a crítica visual.',
  DESIGN_PREPARE_NO_CLAUDE: 'O projeto não tem conta Claude.',
  PROJECT_ACCOUNTS_UNAVAILABLE: 'Nenhuma conta permitida para este projeto está ativa e disponível no runtime para o papel solicitado.',
  DESIGN_CATALOG_SHARED_EFFORT: 'O catálogo de Claude Opus 5.5 ou Sonnet 5.5 é compartilhado com outros papéis e não tem todos os esforços de specialist; nada foi gravado. Rode a prévia (sem --aplicar) para ver o modelo, os esforços e os papéis afetados.',
  DESIGN_PREPARE_ACCOUNT_UNAVAILABLE: 'A conta prioritária informada não é uma conta Claude ativa deste projeto.',
  CONTROL_ADMIN_REQUIRED: 'Falta o administrador de controle para registrar ou atualizar os modelos Claude no catálogo.',
  PROJECT_OWNER_REQUIRED: 'Só o dono do projeto prepara o exame.',
  DESIGN_CREATE_INVALID: 'O pedido de criação não tem telas ou rodadas válidas.',
  DESIGN_CREATE_PROMPT_TOO_LARGE: `O prompt de criação excedeu o limite de ${MAX_CREATE_TASK_CHARS} caracteres; reduza o briefing ou o retrabalho.`,
  DESIGN_CREATE_MODEL_FAILED: 'O modelo não devolveu as telas.',
  DESIGN_VISUAL_UNJUDGED: 'A crítica visual foi pedida e nenhuma tela foi julgada.',
  DESIGN_VISUAL_NO_SCREENS: 'A crítica visual foi pedida, mas nenhuma tela entrou no exame.',
  EXAM_LOGIN_STALE: EXAM_LOGIN_STALE_TEXT,
  EXAM_LOGIN_BUSY: EXAM_LOGIN_BUSY_TEXT,
  EXAM_LOGIN_RESTORE_FAILED: EXAM_LOGIN_RESTORE_FAILED_TEXT,
  EXAM_INTERRUPTED: 'O exame foi interrompido.',
  DESIGN_REFERENCE_INVALID: 'A referência tem que ser PNG ou JPG.',
  DESIGN_REFERENCE_LIMIT: 'O exame aceita no máximo 10 referências.',
  DESIGN_CONFIG_INVALID: 'O design.config.json do projeto é inválido.',
};

/** Known codes keep their Portuguese line. Anything else is one fixed sentence, so a path or secret never reaches the terminal. */
export function designCliFailureText(error: unknown): string {
  if (error instanceof UnstartedExamRetirementPending) return `A retirada do job ${error.jobId} ficou pendente. Verifique o Docker e repita: npm run personal:maintenance -- <instalação.json> --abandonar-design ${error.jobId}`;
  if (error instanceof DesignCreateModelFailure) return `O modelo não devolveu as telas. Causa: ${error.causeCode}.`;
  const code = error instanceof Refusal ? error.code : error instanceof Error ? error.message : '';
  if (code === 'MIGRATIONS_PENDING') return `${code}. ${migrationsPendingText}`;
  const dependency = examDependencyText(error);
  if (dependency) return dependency;
  if (Object.hasOwn(messages, code)) return messages[code]!;
  // Um código de recusa só tem letras maiúsculas e sublinhado: mostrá-lo não vaza caminho nem segredo e diz onde olhar.
  if (error instanceof Refusal && /^[A-Z][A-Z0-9_]{2,63}$/.test(code)) return `O exame de design falhou (código ${code}).`;
  return 'O exame de design falhou.';
}

/** The report is already on disk. A stale login or an incomplete visual exam still exits non-zero. */
export function designExamStatus(result: {
  stopped?: string | null;
  loginStale?: boolean;
  captureLoginFailed?: boolean;
  visualUnjudged?: boolean;
  visualRequested?: number;
  visualJudged?: number;
  visualMissing?: readonly string[];
}): {code: number; lines: string[]} {
  const lines: string[] = [];
  if (result.stopped) lines.push(examStopText(result.stopped));
  if (result.loginStale) lines.push(EXAM_LOGIN_STALE_TEXT);
  if (result.captureLoginFailed) lines.push('Uma ou mais rotas perderam a sessão autenticada. Consulte o relatório de design.');
  if (result.visualUnjudged) {
    if (result.visualRequested === 0) {
      lines.push(messages.DESIGN_VISUAL_NO_SCREENS!);
    } else if ((result.visualJudged ?? 0) > 0 && result.visualMissing && result.visualMissing.length > 0) {
      lines.push(`A crítica visual ficou incompleta. Telas sem nota completa: ${result.visualMissing.join(', ')}.`);
    } else {
      lines.push(messages.DESIGN_VISUAL_UNJUDGED!);
    }
  }
  return {code: lines.length > 0 ? 1 : 0, lines};
}

function readPinnedImage(): string {
  try {
    return readRebuildImagePin(readFileSync(join(process.cwd(), 'deploy/design-image-digest.txt'), 'utf8'));
  } catch (error) {
    if (error instanceof Refusal) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? String((error as {code?: unknown}).code) : '';
    if (code === 'ENOENT') throw new Refusal('DESIGN_IMAGE_UNPINNED');
    throw error;
  }
}

function dockerFinished(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', args, {stdio: 'ignore'});
    child.on('error', () => reject(new Refusal('DESIGN_IMAGE_FAILED')));
    child.on('close', code => {
      if (code === 0) resolvePromise();
      else reject(new Refusal('DESIGN_IMAGE_FAILED'));
    });
  });
}

function readyScript(url: string): string {
  return `fetch(${JSON.stringify(url)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`;
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** HTML da pasta servida. `index.html` na raiz vira `/`. Não entra em node_modules. Profundidade máxima 4, no máximo 40 rotas. */
export async function routesFromStaticFolder(root: string): Promise<{route: string}[]> {
  const found: string[] = [];
  const seen = new Set<string>([root]);
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const here = prefix === '' ? 0 : prefix.split('/').length;
    if (here >= 4) return;
    let names: string[];
    try {
      names = (await readdir(directory)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name === 'node_modules') continue;
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      const segments = rel.split('/').length;
      if (segments > 4) continue;
      const path = join(directory, name);
      const listed = await lstat(path).catch(() => undefined /* absent or unreadable means not present here */);
      if (!listed) continue;
      const real = await realpath(path).catch(() => '');
      if (!real || !pathInside(root, real) || seen.has(real)) continue;
      const info = await lstat(real).catch(() => undefined /* absent or unreadable means not present here */);
      if (!info) continue;
      if (info.isDirectory()) {
        if (segments >= 4) continue;
        seen.add(real);
        await visit(real, rel);
        continue;
      }
      if (info.isFile() && name.endsWith('.html')) {
        seen.add(real);
        found.push(rel);
      }
    }
  };
  await visit(root, '');
  found.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return found.slice(0, 40).map(rel => ({route: rel === 'index.html' ? '/' : `/${rel}`}));
}

async function servedRoot(folder: string): Promise<string> {
  if (folder.length < 1 || folder.length > 400 || folder.includes('\0')) throw new Refusal('DESIGN_SERVE_INVALID', 400);
  const real = await realpath(resolve(folder)).catch(() => '');
  if (!real) throw new Refusal('DESIGN_SERVE_INVALID', 400);
  const info = await stat(real).catch(() => undefined /* absent or unreadable means not present here */);
  if (!info?.isDirectory()) throw new Refusal('DESIGN_SERVE_INVALID', 400);
  if (/[,:\r\n]/.test(real)) throw new Refusal('DESIGN_SERVE_INVALID', 400);
  return real;
}

function servedUrl(route: string): string {
  if (route === '/') return 'http://design-servir.local:8080/';
  const path = route.split('/').map(part => encodeURIComponent(part)).join('/');
  return `http://design-servir.local:8080${path.startsWith('/') ? path : `/${path}`}`;
}

export function servedDesignTarget(origin: string, loginUrl?: string): string {
  if (loginUrl === undefined) return origin;
  const target = new URL(origin);
  const requested = new URL(loginUrl);
  target.pathname = requested.pathname;
  target.search = requested.search;
  target.hash = requested.hash;
  return target.href;
}

function findingOnHtml(file: string, htmlPath: string): boolean {
  const route = `/${htmlPath}`;
  const head = file.split(/[\s?#]/)[0] ?? '';
  return file === htmlPath || head === htmlPath || head === route;
}

/**
 * Sobe as telas geradas só na rede de homologação.
 * A pasta public vai para /srv. O original em design-criacoes continua 0600.
 */
async function withCreatedServer<T>(
  pin: string,
  files: readonly {path: string; text: string}[],
  run: (origin: string, repo: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'design-create-serve-'));
  const name = `ac-design-create-${randomUUID().slice(0, 8)}`;
  const first = files.find(file => file.path.endsWith('.html'))?.path ?? 'index.html';
  try {
    const pub = join(root, 'public');
    await mkdir(pub, {mode: 0o755});
    await chmod(root, 0o755);
    await chmod(pub, 0o755);
    for (const file of files) {
      const path = join(pub, file.path);
      await writeFile(path, file.text, {mode: 0o644});
      await chmod(path, 0o644);
    }
    await dockerFinished(['rm', '-f', name]).catch(() => undefined /* removes a stale container of the same name, if any */);
    await dockerFinished([
      'run', '-d', '--name', name,
      '--network', 'design-homologation',
      '--network-alias', 'design-create.local',
      '--user', '65532:65532',
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '64',
      '--memory', '256m',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
      '--env', 'HOME=/tmp',
      '--env', 'TMPDIR=/tmp',
      '--env', 'DESIGN_STATIC_ROOT=/srv',
      '--entrypoint', 'node',
      '--pull', 'never',
      '--mount', `type=bind,source=${pub},destination=/srv,readonly`,
      pin,
      '/opt/design-tools/serve-static.mjs',
    ]);
    await dockerFinished([
      'run', '--rm', '--pull', 'never', '--network', 'design-homologation', '--entrypoint', 'node', pin,
      '-e', readyScript(`http://design-create.local:8080/${first}`),
    ]);
    return await run('http://design-create.local:8080', root);
  } finally {
    await dockerFinished(['rm', '-f', name]).catch(() => undefined /* container cleanup is best effort */);
    await rm(root, {recursive: true, force: true});
  }
}

/** Sobe a pasta do exame na rede de homologação e espera o primeiro HTML responder. */
async function withServedDirectory<T>(
  pin: string,
  folder: string,
  run: (origin: string, routes: readonly {route: string}[], files: readonly {path: string; text: string}[]) => Promise<T>,
): Promise<T> {
  const directory = await servedRoot(folder);
  const discovered = await routesFromStaticFolder(directory);
  const routes = discovered.length > 0 ? discovered : [{route: '/'}];
  const servedFiles = (await readDesignRepository(directory)).filter(file => /\.html?$/i.test(file.path));
  const name = `ac-design-servir-${randomUUID().slice(0, 8)}`;
  const probe = routes.find(item => item.route === '/')?.route ?? routes[0]?.route ?? '/';
  try {
    await dockerFinished(['rm', '-f', name]).catch(() => undefined /* container cleanup is best effort */);
    await dockerFinished([
      'run', '-d', '--name', name,
      '--network', 'design-homologation',
      '--network-alias', 'design-servir.local',
      '--user', '65532:65532',
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '64',
      '--memory', '256m',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
      '--env', 'HOME=/tmp',
      '--env', 'TMPDIR=/tmp',
      '--env', 'DESIGN_STATIC_ROOT=/srv',
      '--entrypoint', 'node',
      '--pull', 'never',
      '--mount', `type=bind,source=${directory},destination=/srv,readonly`,
      pin,
      '/opt/design-tools/serve-static.mjs',
    ]);
    await dockerFinished([
      'run', '--rm', '--pull', 'never', '--network', 'design-homologation', '--entrypoint', 'node', pin,
      '-e', readyScript(servedUrl(probe)),
    ]);
    return await run('http://design-servir.local:8080', routes, servedFiles);
  } finally {
    await dockerFinished(['rm', '-f', name]).catch(() => undefined /* container cleanup is best effort */);
  }
}

function fail(error: unknown): never {
  console.error(designCliFailureText(error));
  process.exit(1);
  throw error instanceof Error ? error : new Error('O exame de design falhou.');
}

/** The ledger refuses a lease longer than 60s. A model call outlasts that, so renew it until the exam returns. */
export function keepPersonalDesignLease<T>(ledger: {heartbeat: (authority: T) => Promise<unknown>}, authority: T, everyMs = 5000) {
  const timer = setInterval(() => {
    void Promise.resolve(ledger.heartbeat(authority)).catch(() => undefined /* a lost lease is refused at the next fenced write */);
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

async function runPrepare(invocation: {installationPath: string; projectId: string; apply: boolean; primaryAccountId?: string}) {
  const config = await loadInstallation(resolve(invocation.installationPath));
  if (config.activation !== 'personal') throw new Refusal('PERSONAL_ACTIVATION_REQUIRED', 403);
  const project = [config.project, ...config.projects].find(item => item.id === invocation.projectId);
  if (!project) throw new Refusal('NOT_FOUND', 404);
  const ledger = new Ledger(config.databaseUrl, config.installationAuthority?.token, undefined, installationVolumes(config));
  try {
    await assertInstallationMigrations(ledger);
    const report = await prepareDesignSpecialist({
      ledger,
      owner: project.owner,
      projectId: project.id,
      apply: invocation.apply,
      ...(invocation.primaryAccountId === undefined ? {} : {primaryAccountId: invocation.primaryAccountId}),
      ...(project.allowedAccountIds === undefined ? {} : {allowedAccountIds: project.allowedAccountIds}),
    });
    console.log(formatDesignPrepare(report));
  } finally {
    await ledger.close();
  }
}

/** Shared exam/create lifecycle: keeps lease, catches Ctrl-C/SIGTERM, finalizes the intent (`done` or `failed`), and closes the ledger. */
export async function runDesignSession<T>(
  resolved: Pick<ResolvedPersonalDesign, 'ledger' | 'authority' | 'intentId' | 'close' | 'interrupt'>,
  run: () => Promise<T>,
  outcomeForResult: (result: T) => 'done' | 'failed' = () => 'done',
  cleanup?: () => Promise<void>,
): Promise<T> {
  const stopLease = keepPersonalDesignLease(resolved.ledger, resolved.authority);
  let outcome: 'done' | 'failed' = 'failed';
  let failed = false;
  try {
    const result = await withExamSignals(() => run(), () => resolved.interrupt?.());
    outcome = outcomeForResult(result);
    return result;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    stopLease();
    // Ctrl-C ou SIGTERM: o contêiner da imagem não morre com o cliente docker.
    await removeActiveDesignContainers().catch(() => undefined /* best-effort; a container left behind ends at its own deadline */);
    if (cleanup) await cleanup().catch(() => undefined /* best-effort cleanup; the original error is what the caller sees */);
    await finishExamIntent(
      resolved.ledger,
      {intentId: resolved.intentId, contextId: resolved.authority.contextId},
      outcome,
    ).catch(containFailure('EXAM_INTENT_NOT_CLOSED', undefined));
    try {
      await resolved.close();
    } catch (error) {
      if (!failed) throw error;
    }
  }
}

async function main() {
  const invocation = parseDesignInvocation(process.argv.slice(2));
  if (invocation.kind === 'prepare') {
    await runPrepare(invocation);
    return;
  }
  if (invocation.kind === 'approve') {
    const config = await loadInstallation(resolve(invocation.installationPath));
    if (config.activation !== 'personal') throw new Refusal('PERSONAL_ACTIVATION_REQUIRED', 403);
    const captures = await readDesignCaptureFiles(config.dataDirectory, invocation.projectId, invocation.runId);
    if (captures.length === 0) throw new Refusal('DESIGN_IMAGE_FAILED');
    const directory = await approveDesignBaseline({dataDirectory: config.dataDirectory, projectId: invocation.projectId, captures});
    console.log(directory);
    return;
  }
  if (invocation.kind === 'create') {
    await runCreate(invocation);
    return;
  }
  const parsed = parseDesignArgs(invocation.argv);
  const opened = parsed.loginFile === undefined ? undefined : await readDesignLoginFile(parsed.loginFile);
  let trust: Awaited<ReturnType<typeof stageDesignTrustCa>> | undefined;
  try {
    if (parsed.caFile !== undefined) await assertInternalDesignNetwork();
    trust = parsed.caFile === undefined ? undefined : await stageDesignTrustCa(await readDesignTrustCa(parsed.caFile));
  } catch (error) {
    opened?.wipe();
    fail(error);
  }
  let examStatus: {code: number; lines: string[]} = {code: 0, lines: []};
  let browser: Awaited<ReturnType<typeof openDesignBrowser>> | undefined;
  try {
    const resolved = await resolvePersonalDesign(invocation.argv, undefined, true);
    examStatus = await runDesignSession(
      resolved,
      async () => {
        const pinnedImage = readPinnedImage();
        const runId = randomUUID();
        // andamento/<runId>.json with this node's PID, phase and counts: `personal:status` follows the exam without pgrep.
        const tracked = trackExamProgress(resolved.dataDirectory, resolved.projectId, runId, 'design');
        const preflight = resolved.preflight ? () => resolved.preflight!([pinnedImage]) : undefined;
        try {
        const files = await readDesignRepository(resolved.repo);
        const referenceFiles = invocation.references.length === 0 ? undefined : await readReferenceFiles(invocation.references);
        const examAt = async (targetUrl: string, routes?: readonly {route: string}[], servedFiles?: readonly {path: string; text: string}[]) => {
          // O servidor estático só existe na rede da imagem, inclusive quando --url aponta para loopback.
          if (opened !== undefined && !new URL(targetUrl).hostname.endsWith('.local')) {
            browser = await openDesignBrowser(targetUrl);
          }
          return runDesignModule({
            activation: 'personal',
            projectId: resolved.projectId,
            mapEnabled: resolved.economy?.map,
            batch: resolved.economy?.batch === false ? false : {tokens: resolved.economy?.batchTokens ?? 40_000, files: resolved.economy?.batchFiles ?? 8},
            repo: resolved.repo,
            targetUrl,
            dataDirectory: resolved.dataDirectory,
            ...(resolved.ledger.launchVolumes ? {launchVolumes: resolved.ledger.launchVolumes} : {}),
            intentId: resolved.intentId,
            runId,
            createdAt: new Date(),
            commit: resolved.commit,
            files: servedFiles !== undefined && servedFiles.length > 0 ? servedFiles : files,
            worker: resolved.worker,
            reserve: resolved.reserve,
            release: resolved.release,
            ...(browser === undefined ? {} : {driver: browser.driver}),
            image: {pinnedImage},
            scoreVisual: true,
            recordStates: true,
            regressionThreshold: invocation.threshold,
            ...(referenceFiles === undefined ? {} : {referenceFiles}),
            ...(opened === undefined ? {} : {login: opened.login}),
            ...(trust === undefined ? {} : {trustCa: trust.path}),
            ...(routes === undefined ? {} : {routes}),
            ...(resolved.economy?.maxModelCalls !== undefined ? {maxModelCalls: resolved.economy.maxModelCalls} : {}),
            ...(preflight ? {preflight} : {}),
            onProgress: ({phase, judged, total, modelCalls, lastFailureCode, failureStreak}) => {
              void tracked.update({phase, judged, total, modelCalls, failureStreak, ...(lastFailureCode ? {lastFailureCode} : {})});
            },
          });
        };
        const result = invocation.serveDir === undefined
          ? await examAt(parsed.url)
          : await withServedDirectory(pinnedImage, invocation.serveDir,
            (origin, routes, servedFiles) => examAt(servedDesignTarget(origin, opened === undefined ? undefined : parsed.url), routes, servedFiles));
        console.log(runId);
        console.log(result.directory);
        const status = designExamStatus(result);
        await tracked.finish(result.stopped ? 'stopped' : status.code === 0 ? 'done' : 'failed',
          result.stopped ? {note: examStopText(result.stopped), lastFailureCode: result.stopped} : {});
        return status;
        } catch (error) {
          await tracked.finish('failed', error instanceof Refusal ? {lastFailureCode: error.code} : {});
          throw error;
        }
      },
      status => (status.code === 0 ? 'done' : 'failed'),
      async () => {
        await browser?.close();
      },
    );
  } catch (error) {
    opened?.wipe();
    await trust?.dispose();
    fail(error);
  }
  opened?.wipe();
  await trust?.dispose();
  for (const line of examStatus.lines) console.error(line);
  process.exit(examStatus.code);
}

async function runCreate(invocation: {installationPath: string; projectId: string; briefing: string; references: string[]; screens: number; rounds: number}) {
  const resolved = await resolvePersonalDesign([], {installationPath: invocation.installationPath, projectId: invocation.projectId});
  await runDesignSession(resolved, async () => {
    const runId = randomUUID();
    const briefing = await readFile(invocation.briefing, 'utf8');
    const references = invocation.references.length === 0 ? [] : await readReferenceFiles(invocation.references);
    const pinnedImage = readPinnedImage();
    const created = await runDesignCreate({
      dataDirectory: resolved.dataDirectory,
      ...(resolved.ledger.launchVolumes ? {launchVolumes: resolved.ledger.launchVolumes} : {}),
      runId,
      repository: resolved.repo,
      briefing,
      screens: invocation.screens,
      rounds: invocation.rounds,
      referenceNote: references.length === 0 ? '' : `${references.length} referências visuais.`,
      worker: resolved.worker,
      reserve: () => resolved.reserve('specialist', undefined, {purpose: 'create'}),
      release: seat => resolved.release(seat),
      intentId: resolved.intentId,
      examine: async (_round, files, context) => {
        const exam = await withCreatedServer(pinnedImage, files, (origin, repo) => runDesignModule({
          activation: 'personal',
          projectId: resolved.projectId,
          mapEnabled: resolved.economy?.map,
          batch: resolved.economy?.batch === false ? false : {tokens: resolved.economy?.batchTokens ?? 40_000, files: resolved.economy?.batchFiles ?? 8},
          repo,
          targetUrl: origin,
          dataDirectory: resolved.dataDirectory,
          ...(resolved.ledger.launchVolumes ? {launchVolumes: resolved.ledger.launchVolumes} : {}),
          intentId: resolved.intentId,
          runId: randomUUID(),
          createdAt: new Date(),
          commit: resolved.commit,
          files,
          worker: resolved.worker,
          reserve: resolved.reserve,
          release: resolved.release,
          image: {pinnedImage, timeoutMs: 1_800_000},
          scoreVisual: true,
          regressionThreshold: 0.1,
          routes: files.filter(file => file.path.endsWith('.html')).map(file => ({route: `/${file.path}`})),
          ...(references.length === 0 ? {} : {referenceFiles: references}),
          createMode: true,
          brandTokens: context.tokens,
        }));
        const screens = files.filter(file => file.path.endsWith('.html')).map(file => {
          const related = exam.findings.filter(item => findingOnHtml(item.file, file.path));
          return {
            name: file.path.slice(0, -'.html'.length),
            rejected: exam.visualLow || related.some(item => item.severity === 'alta'),
            findings: related,
            visualNotes: exam.visualLow ? ['nota visual abaixo de 8'] : [],
          };
        });
        if (exam.loginStale) {
          console.log(exam.directory);
          throw new Refusal('EXAM_LOGIN_STALE');
        }
        if (exam.visualUnjudged) {
          console.log(exam.directory);
          throw new Refusal('DESIGN_VISUAL_UNJUDGED');
        }
        const report: CreateExam = {screens, notes: []};
        return report;
      },
    });
    console.log(runId);
    console.log(created.directory);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(fail);
}
