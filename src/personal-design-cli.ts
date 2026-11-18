import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Refusal} from './contracts.ts';
import {openDesignBrowser} from './design-browser.ts';
import {parseDesignArgs, parseDesignInvocation, readDesignLoginFile, readDesignRepository, resolvePersonalDesign} from './design-command.ts';
import {runDesignCreate} from './design-create.ts';
import {readRebuildImagePin} from './design-image-run.ts';
import {runDesignModule} from './design-module.ts';
import {readReferenceFiles} from './design-reference-files.ts';
import {approveDesignBaseline} from './design-regression.ts';
import {readDesignCaptureFiles} from './design-report.ts';
import {loadInstallation} from './installation.ts';

const messages: Record<string, string> = {
  DESIGN_USAGE: 'Uso: npm run personal:design -- <instalação.json> <projectId> --url <url> [--login-file <arquivo>]',
  PERSONAL_ACTIVATION_REQUIRED: 'O exame de design só roda numa instalação pessoal.',
  NOT_FOUND: 'Projeto não encontrado.',
  DESIGN_CONTEXT_REQUIRED: 'O projeto não tem um contexto para o exame.',
  DESIGN_WORKER_UNAVAILABLE: 'O runtime pessoal não está ativo.',
  DESIGN_EXTERNAL_TARGET: 'A URL tem que ficar em localhost, 127.0.0.1 ou num host .local.',
  DESIGN_TARGET_ESCAPE: 'A URL aponta para outro destino.',
  DESIGN_LOGIN_MODE: 'O arquivo de login tem que estar no modo 0600.',
  DESIGN_LOGIN_INVALID: 'O arquivo de login não tem os campos esperados.',
  DESIGN_COMMIT_INVALID: 'Não foi possível ler o commit do repositório.',
  DESIGN_PROVIDER_MUST_DIFFER: 'O revisor tem que ser outro provedor.',
  EXAM_PROVIDER_UNSUPPORTED: 'O exame de leitura só aceita uma conta Claude.',
  DESIGN_EXAM_TIMEOUT: 'O exame passou do tempo.',
  DESIGN_REPO_UNREADABLE: 'Não foi possível ler o repositório do projeto.',
  DESIGN_PASSWORD_LEAK: 'A senha de login apareceria no relatório.',
  DESIGN_BROWSER_MISSING: 'O Chrome do painel não está disponível para a captura.',
  DESIGN_IMAGE_FAILED: 'A imagem de design não entregou os achados.',
  DESIGN_IMAGE_TIMEOUT: 'A imagem de design passou do tempo.',
  DESIGN_IMAGE_UNPINNED: 'A imagem de design não está fixada pelo digest.',
  DESIGN_CREATE_MODEL_UNAVAILABLE: 'A conta não tem Claude Opus 5.5 com esforço medium.',
  DESIGN_CREATE_INVALID: 'O pedido de criação não tem telas ou rodadas válidas.',
  DESIGN_REFERENCE_INVALID: 'A referência tem que ser PNG ou JPG.',
  DESIGN_REFERENCE_LIMIT: 'O exame aceita no máximo 10 referências.',
  DESIGN_CONFIG_INVALID: 'O design.config.json do projeto é inválido.',
};

/** Known codes keep their Portuguese line. Anything else is one fixed sentence, so a path or secret never reaches the terminal. */
export function designCliFailureText(error: unknown): string {
  const code = error instanceof Refusal ? error.code : error instanceof Error ? error.message : '';
  return Object.hasOwn(messages, code) ? messages[code] : 'O exame de design falhou.';
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

/**
 * Sobe as telas geradas só na rede de homologação.
 * A cópia é 0644 enquanto o contêiner lê; o original em design-criacoes continua 0600.
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
    for (const file of files) await writeFile(join(pub, file.path), file.text, {mode: 0o644});
    await dockerFinished(['rm', '-f', name]).catch(() => undefined);
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
      '--entrypoint', 'node',
      '--pull', 'never',
      '--mount', `type=bind,source=${root},destination=/srv,readonly`,
      pin,
      '/opt/design-tools/serve-lab.mjs',
    ]);
    await dockerFinished([
      'run', '--rm', '--pull', 'never', '--network', 'design-homologation', '--entrypoint', 'node', pin,
      '-e', `fetch("http://design-create.local:8080/${first}").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
    ]);
    return await run('http://design-create.local:8080', root);
  } finally {
    await dockerFinished(['rm', '-f', name]).catch(() => undefined);
    await rm(root, {recursive: true, force: true});
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
    void Promise.resolve(ledger.heartbeat(authority)).catch(() => undefined);
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

async function main() {
  const invocation = parseDesignInvocation(process.argv.slice(2));
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
  let resolved: Awaited<ReturnType<typeof resolvePersonalDesign>> | undefined;
  try {
    resolved = await resolvePersonalDesign(invocation.argv);
    const stopLease = keepPersonalDesignLease(resolved.ledger, resolved.authority);
    const browser = opened === undefined ? undefined : await openDesignBrowser(parsed.url);
    const pinnedImage = readPinnedImage();
    const runId = randomUUID();
    try {
      const result = await runDesignModule({
        activation: 'personal',
        projectId: resolved.projectId,
        repo: resolved.repo,
        targetUrl: parsed.url,
        dataDirectory: resolved.dataDirectory,
        intentId: resolved.intentId,
        runId,
        createdAt: new Date(),
        commit: resolved.commit,
        files: await readDesignRepository(resolved.repo),
        worker: resolved.worker,
        reserve: resolved.reserve,
        release: resolved.release,
        ...(browser === undefined ? {} : {driver: browser.driver}),
        image: {pinnedImage},
        scoreVisual: true,
        recordStates: true,
        regressionThreshold: invocation.threshold,
        ...(invocation.references.length === 0 ? {} : {referenceFiles: await readReferenceFiles(invocation.references)}),
        ...(opened === undefined ? {} : {login: opened.login}),
      });
      console.log(runId);
      console.log(result.directory);
    } finally {
      stopLease();
      await browser?.close();
      await resolved.ledger.pool.query(
        "UPDATE ac_intents SET state='done' WHERE id=$1 AND context_id=$2 AND state='accepted'",
        [resolved.intentId, resolved.authority.contextId],
      ).catch(() => undefined);
    }
  } catch (error) {
    opened?.wipe();
    await resolved?.close();
    fail(error);
  }
  opened?.wipe();
  await resolved?.close();
  process.exit(0);
}

async function runCreate(invocation: {installationPath: string; projectId: string; briefing: string; references: string[]; screens: number; rounds: number}) {
  const resolved = await resolvePersonalDesign([], {installationPath: invocation.installationPath, projectId: invocation.projectId});
  const stopLease = keepPersonalDesignLease(resolved.ledger, resolved.authority);
  const runId = randomUUID();
  try {
    const briefing = await readFile(invocation.briefing, 'utf8');
    const references = invocation.references.length === 0 ? [] : await readReferenceFiles(invocation.references);
    const pinnedImage = readPinnedImage();
    const created = await runDesignCreate({
      dataDirectory: resolved.dataDirectory,
      runId,
      repository: resolved.repo,
      briefing,
      screens: invocation.screens,
      rounds: invocation.rounds,
      referenceNote: references.length === 0 ? '' : `${references.length} referências visuais.`,
      worker: resolved.worker,
      reserve: () => resolved.reserve('specialist'),
      release: seat => resolved.release(seat),
      intentId: resolved.intentId,
      examine: async (_round, files) => {
        const exam = await withCreatedServer(pinnedImage, files, (origin, repo) => runDesignModule({
          activation: 'personal',
          projectId: resolved.projectId,
          repo,
          targetUrl: origin,
          dataDirectory: resolved.dataDirectory,
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
        }));
        const high = exam.findings.some(item => item.severity === 'alta');
        return {high, belowVisual8: exam.visualLow, findings: exam.findings, notes: []};
      },
    });
    console.log(runId);
    console.log(created.directory);
  } finally {
    stopLease();
    await resolved.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(fail);
}
