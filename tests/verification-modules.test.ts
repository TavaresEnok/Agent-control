import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {Capacity} from '../src/capacity.ts';
import {keepPersonalVerifyLease} from '../src/personal-verify-cli.ts';
import {createModuleExamFixture, moduleExamFixtureAnswer} from './fixtures/module-exam-native.ts';
import {qaStaticFinding, qaStaticTool, reviewFixtureVerdict} from './fixtures/module-exam-review.ts';
import {Refusal} from '../src/contracts.ts';
import {Ledger, VERIFICATION_MODULES, type VerificationModule} from '../src/ledger.ts';
import {moduleCliFailureText, parsePersonalModuleArgs, runPersonalModuleCli} from '../src/personal-module-cli.ts';
import {runPersonalQaCli} from '../src/personal-qa-cli.ts';
import {
  assertModuleRepoRelativePath,
  buildModuleReviewPrompt,
  listModuleReports,
  MODULE_RUNTIME_BIN,
  moduleCollectorArguments,
  parseModuleCollectorOutput,
  prepareModuleSnapshot,
  removeModuleSnapshot,
  readModuleAchadoMarkdown,
  readModuleReport,
  readPinnedModuleImage,
  recheckModuleFindings,
  requestModuleCorrection,
  runBoundedCollectorProcess,
  runVerificationModule,
} from '../src/verification-modules.ts';
import {REMEDIATION_ACCEPTANCE} from '../src/verify-types.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const exec = promisify(execFile);
const databaseUrl = process.env.AC_TEST_DATABASE_URL;
const PINNED_IMAGE = `sha256:${'ab'.repeat(32)}`;
const PINNED_TAGGED = `localhost:5000/ac-module-qa:1.0.0@sha256:${'cd'.repeat(32)}`;

async function initGitRepo(root: string, appendedSource = ''): Promise<{repo: string; commit: string}> {
  const repo = join(root, 'repo');
  await mkdir(join(repo, 'src'), {recursive: true});
  await writeFile(join(repo, 'src', 'app.ts'), 'export function main() {\n  return 42;\n}\n' + appendedSource, {mode: 0o644});
  await writeFile(join(repo, 'src', 'db.ts'), 'export const query = "SELECT * FROM users";\n', {mode: 0o644});
  await writeFile(join(repo, 'README.md'), '# Projeto Teste\n', {mode: 0o644});
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  await exec('git', ['init'], {cwd: repo, env});
  await exec('git', ['add', '.'], {cwd: repo, env});
  await exec('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'initial'], {cwd: repo, env});
  const commit = (await exec('git', ['rev-parse', 'HEAD'], {cwd: repo, env})).stdout.trim();
  return {repo, commit};
}

async function writePersonalInstallation(
  root: string,
  opts: {
    databaseUrl: string;
    projectId: string;
    label?: string;
    repo: string;
    owner: string;
    dataDirectory: string;
    activation?: 'personal' | 'locked';
  },
): Promise<string> {
  const file = join(root, 'installation.json');
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      mode: 'administration-only',
      activation: opts.activation ?? 'personal',
      databaseUrl: opts.databaseUrl,
      dataDirectory: opts.dataDirectory,
      project: {
        id: opts.projectId,
        label: opts.label ?? 'ProjetoModulos',
        repo: opts.repo,
        owner: opts.owner,
      },
      http: {listen: '127.0.0.1', port: 18425, publicOrigin: 'http://127.0.0.1:18425'},
      happier: {
        upstreamOrigin: 'http://127.0.0.1:18421',
        webOrigin: 'http://127.0.0.1:18420',
        publicServerOrigin: 'http://127.0.0.1:18421',
      },
    }),
    {mode: 0o600},
  );
  await chmod(file, 0o600);
  return file;
}

test('package.json e scripts declaram as oito CLIs personal:<modulo>', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {scripts?: Record<string, string>};
  assert.equal(VERIFICATION_MODULES.length, 8);
  assert.deepEqual([...VERIFICATION_MODULES], [
    'qa',
    'arquitetura',
    'dependencias',
    'banco',
    'prontidao',
    'desempenho',
    'documentacao',
    'conformidade',
  ]);
  for (const mod of VERIFICATION_MODULES) {
    const scriptCommand = pkg.scripts?.[`personal:${mod}`];
    assert.equal(scriptCommand, `node scripts/personal-${mod}.mjs`);
    const scriptPath = join('scripts', `personal-${mod}.mjs`);
    const info = await stat(scriptPath);
    assert.equal(info.isFile(), true);
  }
});

test('moduleCollectorArguments e readPinnedModuleImage exigem digest fixado, /repo ro, raiz ro, sem rede e sem socket', async () => {
  const args = moduleCollectorArguments({
    image: PINNED_IMAGE,
    repository: '/var/verify/snapshot',
    memoryBytes: 536_870_912,
    nanoCpus: 1_500_000_000,
    pidsLimit: 128,
  });
  assert.equal(args[0], MODULE_RUNTIME_BIN);
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.equal(args[args.indexOf('--user') + 1], '65532:65532');
  assert.equal(args.includes('--read-only'), true);
  assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
  assert.equal(args[args.indexOf('--security-opt') + 1], 'no-new-privileges');
  assert.equal(args[args.indexOf('--pids-limit') + 1], '128');
  assert.equal(args[args.indexOf('--memory') + 1], '536870912');
  assert.equal(args[args.indexOf('--memory-swap') + 1], '536870912');
  assert.equal(args[args.indexOf('--cpus') + 1], '1.5');
  assert.equal(args.includes('--entrypoint'), false);
  const mounts = args.filter((_item, idx) => args[idx - 1] === '--mount');
  assert.deepEqual(mounts, ['type=bind,src=/var/verify/snapshot,dst=/repo,readonly']);
  assert.equal(args.some(item => item.includes('.sock')), false);
  assert.equal(args.at(-1), PINNED_IMAGE);

  const taggedArgs = moduleCollectorArguments({image: PINNED_TAGGED, repository: '/var/verify/snapshot'});
  assert.equal(taggedArgs.at(-1), PINNED_TAGGED);

  assert.throws(
    () => moduleCollectorArguments({image: 'ac-module-qa:latest', repository: '/var/verify/snapshot'}),
    (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_IMAGE_UNPINNED',
  );
  assert.throws(
    () => moduleCollectorArguments({image: `ac-module-qa:latest@${PINNED_IMAGE}`, repository: '/var/verify/snapshot'}),
    (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_IMAGE_UNPINNED',
  );
  assert.throws(
    () => moduleCollectorArguments({image: PINNED_IMAGE, repository: '/var/verify/../escape'}),
    (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_PATH_FORBIDDEN',
  );
  assert.throws(
    () => moduleCollectorArguments({image: PINNED_IMAGE, repository: '/var/run/containerd.sock'}),
    (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_SOCKET_FORBIDDEN',
  );
  assert.throws(
    () => moduleCollectorArguments({image: PINNED_IMAGE, repository: '/tmp/repo --network host'}),
    (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_NETWORK_FORBIDDEN',
  );

  const root = await mkdtemp(join(tmpdir(), 'ac-mod-digest-'));
  try {
    await assert.rejects(
      () => readPinnedModuleImage('arquitetura', root),
      (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_IMAGE_UNPINNED',
    );
    const modDir = join(root, 'deploy', 'modules', 'arquitetura');
    await mkdir(modDir, {recursive: true});
    await writeFile(join(modDir, 'digest.txt'), `${PINNED_IMAGE}\n`, {mode: 0o644});
    assert.equal(await readPinnedModuleImage('arquitetura', root), PINNED_IMAGE);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('prepareModuleSnapshot extrai commit isolado legível por 65532 sem arquivos uncommitted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-mod-snap-'));
  let snapshot = '';
  try {
    const {repo, commit} = await initGitRepo(root);
    await writeFile(join(repo, 'src', 'app.ts'), 'dirty\n');
    await writeFile(join(repo, 'src', 'untracked.ts'), 'untracked\n');
    snapshot = await prepareModuleSnapshot(repo, commit);
    assert.notEqual(snapshot, repo);
    assert.equal((await stat(snapshot)).mode & 0o777, 0o755);
    assert.equal((await stat(join(snapshot, 'src'))).mode & 0o777, 0o755);
    assert.equal((await stat(join(snapshot, 'src', 'app.ts'))).mode & 0o777, 0o644);
    assert.equal(await readFile(join(snapshot, 'src', 'app.ts'), 'utf8'), 'export function main() {\n  return 42;\n}\n');
    await assert.rejects(() => stat(join(snapshot, 'src', 'untracked.ts')));
  } finally {
    if (snapshot) await removeModuleSnapshot(snapshot);
    await rm(root, {recursive: true, force: true});
  }
});

test('parseModuleCollectorOutput e runBoundedCollectorProcess validam caminhos, limites de stdout, linhas e strings', async () => {
  const valid = parseModuleCollectorOutput(JSON.stringify({
    coverage: [
      {tool: 'knip', version: '5.1.0', status: 'ok', detail: '12 arquivos analisados'},
      {tool: 'knip', version: '5.1.0', status: 'ok', detail: 'arquivo src/app.ts: 1 export verificado'},
      {tool: 'jscpd', version: '4.0.5', status: 'skipped', detail: 'menos de 2 blocos elegíveis'},
    ],
    findings: [
      {
        tool: 'knip',
        rule: 'unused-export',
        file: 'src/app.ts',
        line: 1,
        severity: 'baixa',
        message: 'Export main não referenciado.',
        evidence: 'export function main() {',
      },
    ],
  }));
  assert.equal(valid.coverage.length, 3);
  assert.equal(valid.findings.length, 1);
  assert.equal(valid.findings[0]?.line, 1);

  // Limite de stdout na leitura do JSON e no processo em execução
  assert.throws(
    () => parseModuleCollectorOutput(JSON.stringify({coverage: valid.coverage, findings: []}), {maxStdoutBytes: 20}),
    (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_STDOUT_LIMIT',
  );
  await assert.rejects(
    () => runBoundedCollectorProcess(
      [process.execPath, '-e', 'process.stdout.write("x".repeat(4096))'],
      {timeoutMs: 5000, maxStdoutBytes: 512},
    ),
    (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_STDOUT_LIMIT',
  );

  // Linha inválida (< 1 ou não inteira)
  for (const badLine of [0, -1, 1.5, '1', null]) {
    assert.throws(
      () => parseModuleCollectorOutput(JSON.stringify({
        coverage: [{tool: 'knip', version: '5.1.0', status: 'ok', detail: 'ok'}],
        findings: [{
          tool: 'knip',
          rule: 'r1',
          file: 'src/app.ts',
          line: badLine,
          severity: 'media',
          message: 'msg',
          evidence: 'ev',
        }],
      })),
      (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_COLLECTOR_INVALID',
    );
  }

  // Caminhos proibidos
  const badPaths = [
    '../secret.ts',
    '/etc/passwd',
    'src/../fora.ts',
    'src\\win.ts',
    '.git/config',
    '.ai/work',
    'node_modules/pkg/index.js',
    '.env',
    '.env.production',
    '.claude/settings.json',
    '.codex/auth.json',
    '.grok/config.json',
    '.mcp.json',
    '.husky/pre-commit',
  ];
  const namedFile = 'telas/Código de barras..test.ts';
  assert.equal(assertModuleRepoRelativePath(namedFile), namedFile);
  const namedOutput = parseModuleCollectorOutput(JSON.stringify({
    coverage: [{tool: 'knip', version: '5.1.0', status: 'ok', detail: 'analisado'}],
    findings: [{tool: 'knip', rule: 'unused', file: namedFile, line: 1, severity: 'baixa', message: 'não utilizado', evidence: 'localizado'}],
  }));
  assert.equal(namedOutput.findings[0]?.file, namedFile);
  for (const unsafe of ['telas/../config', 'telas/ .env/token', ' origem.ts', 'telas/oculto\u202e.ts']) {
    assert.throws(() => assertModuleRepoRelativePath(unsafe));
  }
  for (const badPath of badPaths) {
    assert.throws(
      () => assertModuleRepoRelativePath(badPath),
      (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_PATH_FORBIDDEN',
      badPath,
    );
    assert.throws(
      () => parseModuleCollectorOutput(JSON.stringify({
        coverage: [{tool: 'knip', version: '5.1.0', status: 'ok', detail: 'ok'}],
        findings: [{
          tool: 'knip',
          rule: 'r1',
          file: badPath,
          line: 1,
          severity: 'media',
          message: 'msg',
          evidence: 'ev',
        }],
      })),
      (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_PATH_FORBIDDEN',
      badPath,
    );
  }

  // Status, severity, strings vazias ou chaves extras
  assert.throws(
    () => parseModuleCollectorOutput(JSON.stringify({
      coverage: [{tool: 'knip', version: '5.1.0', status: 'unknown', detail: 'ok'}],
      findings: [],
    })),
    (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_COLLECTOR_INVALID',
  );
  assert.throws(
    () => parseModuleCollectorOutput(JSON.stringify({
      coverage: [{tool: 'knip', version: '5.1.0', status: 'ok', detail: 'ok'}],
      findings: [{
        tool: 'knip',
        rule: 'r1',
        file: 'src/app.ts',
        line: 1,
        severity: 'critica',
        message: 'msg',
        evidence: 'ev',
      }],
    })),
    (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_COLLECTOR_INVALID',
  );
  assert.throws(
    () => parseModuleCollectorOutput(JSON.stringify({coverage: [], findings: []})),
    (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_COLLECTOR_INVALID',
  );
  assert.throws(
    () => parseModuleCollectorOutput(JSON.stringify({
      coverage: [{tool: 'knip', version: '5.1.0', status: 'ok', detail: 'ok'}],
      findings: [],
      extra: true,
    })),
    (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_COLLECTOR_INVALID',
  );
});

test('buildModuleReviewPrompt exclui conclusões do autor/examinador dos pedidos de revisão', () => {
  const prompt = buildModuleReviewPrompt({
    module: 'arquitetura',
    achadoId: 'ACH-001',
    tool: 'dependency-cruiser',
    rule: 'no-circular',
    file: 'src/app.ts',
    line: 12,
    evidence: 'src/app.ts -> src/db.ts -> src/app.ts',
    codeExcerpt: 'import {query} from "./db.ts";',
    message: 'CONCLUSAO_DO_AUTOR_NAO_DEVE_ENTRAR',
    scenario: 'CENARIO_DO_AUTOR_SECRETO',
    suggestion: 'SUGESTAO_DO_AUTOR_SECRETA',
    conclusion: 'CONCLUSAO_FINAL_PROIBIDA',
  });
  assert.equal(prompt.includes('dependency-cruiser'), true);
  assert.equal(prompt.includes('no-circular'), true);
  assert.equal(prompt.includes('src/app.ts'), true);
  assert.equal(JSON.parse(prompt).line, 12);
  assert.match(JSON.parse(prompt).hypothesis, /no-circular/);
  assert.equal(prompt.includes('CONCLUSAO_DO_AUTOR_NAO_DEVE_ENTRAR'), false);
  assert.equal(prompt.includes('CENARIO_DO_AUTOR_SECRETO'), false);
  assert.equal(prompt.includes('SUGESTAO_DO_AUTOR_SECRETA'), false);
  assert.equal(prompt.includes('CONCLUSAO_FINAL_PROIBIDA'), false);
});

test('migração 104, ensureExamContext, isolamento de contexto, relatórios, falha de ferramenta na cobertura e conversão idempotente em tarefas nos 8 módulos', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const database = await isolatedDatabase(databaseUrl!, 'vmodbase');
  const db = new Ledger(database.url);
  const root = await mkdtemp(join(tmpdir(), 'ac-vmod-base-'));
  const dataDirectory = join(root, 'data');
  let examFixture: Awaited<ReturnType<typeof createModuleExamFixture>> | undefined;
  let stopMainLease: (() => void) | undefined;
  try {
    await mkdir(dataDirectory, {recursive: true, mode: 0o700});
    await db.migrate();

    const principal = 'owner-modulos';
    const viewer = 'viewer-modulos';
    const stranger = 'stranger-modulos';
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const skipped = 'test.skip("processa pedidos", () => {})';
    const {repo, commit} = await initGitRepo(root, skipped + ';\n');
    const otherRepo = join(root, 'other-repo');
    await mkdir(otherRepo, {recursive: true});

    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2),($3,$4)', [projectId, 'Projeto Principal', otherProjectId, 'Outro Projeto']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner'),($1,$3,'viewer'),($4,$5,'owner')", [
      projectId,
      principal,
      viewer,
      otherProjectId,
      stranger,
    ]);
    await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2),($3,$4)', [
      projectId,
      repo,
      otherProjectId,
      otherRepo,
    ]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    // Reserva sintética real: reverificação não deve fabricar identidade de revisor.
    const capacity = new Capacity(db);
    const accountId = randomUUID();
    const profileId = randomUUID();
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await capacity.configure(principal, {programmingLimit: 4, evaluationLimit: 2});
    await capacity.registerModel(principal, {provider: 'claude', model: 'fixture-model', efforts: ['medium'], roles: ['specialist'], source: 'synthetic://module-test'});
    await capacity.addAccount(principal, projectId, {id: accountId, provider: 'claude', label: 'Synthetic reviewer', resourceIdentity: `fixture-${accountId}`, mode: 'synthetic', eligibility: 'documented_supported', eligibilitySource: 'synthetic://module-test', maxConcurrent: 2});
    await capacity.addProfile(principal, projectId, {id: profileId, accountId, model: 'fixture-model', effort: 'medium', role: 'specialist'});
    await capacity.observeQuota(principal, accountId, {status: 'available', source: 'synthetic://module-test', ttlSeconds: 3600});
    examFixture = await createModuleExamFixture({root, repo, ledger: db, owner: principal, project: projectId, answer(launch) {
      const task = JSON.parse(launch.task);
      if (launch.provider === 'codex') {
        assert.equal(task.tool, `${task.module}-tool`);
        assert.equal(task.rule, `${task.module}-rule-${task.file === 'src/app.ts' ? '01' : '02'}`);
        assert.equal(task.code, task.file === 'src/app.ts' ? 'return 42;' : 'export const query = "SELECT * FROM users";');
        assert.doesNotMatch(launch.task, /Defeito detectado|Ponto secundário/);
      }
      return moduleExamFixtureAnswer(launch);
    }});
    const {runtime, profiles, docker} = examFixture;
    const policyRevision = await capacity.publish(principal, projectId, 0, {schemaVersion: 1, maxProgrammersPerContext: 1, maxEvaluatorsPerContext: 2, roles: {specialist: {regular: [...profiles, profileId], emergency: []}}});

    // Sem contexto principal ainda -> VERIFY_CONTEXT_REQUIRED
    await assert.rejects(
      () => db.ensureExamContext(principal, projectId, 'qa'),
      (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_CONTEXT_REQUIRED',
    );

    const mainContext = await db.createContext(principal, projectId, randomUUID());
    const otherMainContext = await db.createContext(stranger, otherProjectId, randomUUID());
    const mainAuthority = await db.acquire(principal, mainContext, randomUUID(), 'live-gateway-manager', 60);
    stopMainLease = keepPersonalVerifyLease(db, mainAuthority, 5000, () => {});

    // Autorização em ensureExamContext: viewer e estranho são recusados com PROJECT_FORBIDDEN
    await assert.rejects(
      () => db.ensureExamContext(viewer, projectId, 'qa'),
      (err: unknown) => err instanceof Refusal && err.code === 'PROJECT_FORBIDDEN',
    );
    await assert.rejects(
      () => db.ensureExamContext(stranger, projectId, 'qa'),
      (err: unknown) => err instanceof Refusal && err.code === 'PROJECT_FORBIDDEN',
    );
    await assert.rejects(
      () => db.ensureExamContext(principal, projectId, 'invalido' as VerificationModule),
      (err: unknown) => err instanceof Refusal && err.code === 'INVALID_CONTRACT',
    );

    // Cria e reutiliza contextos dedicados para os 8 módulos, todos isolados do contexto principal e entre si
    const moduleContexts = new Map<VerificationModule, string>();
    for (const mod of VERIFICATION_MODULES) {
      const first = await db.ensureExamContext(principal, projectId, mod);
      const second = await db.ensureExamContext(principal, projectId, mod);
      assert.equal(first.contextId, second.contextId);
      assert.equal(first.mainContextId, mainContext);
      assert.notEqual(first.contextId, mainContext);
      assert.equal(moduleContexts.has(mod), false);
      for (const existingId of moduleContexts.values()) {
        assert.notEqual(first.contextId, existingId);
      }
      moduleContexts.set(mod, first.contextId);
      await capacity.assignPolicy(principal, first.contextId, policyRevision);
    }

    // Guarda de vínculo ao contexto correto: tentar rodar módulo 'qa' com autoridade do contexto principal ou de 'banco' falha
    const bancoAuth = await db.acquire(principal, moduleContexts.get('banco')!, randomUUID(), 'personal-banco', 60);
    await assert.rejects(
      () => runVerificationModule({
        module: 'qa',
        ledger: db,
        principal,
        authority: mainAuthority,
        projectId,
        repoPath: repo,
        dataDirectory,
        commit,
        collectorOutput: {
          coverage: [{tool: 'vitest', version: '2.1.0', status: 'ok', detail: '1 suite'}],
          findings: [],
        },
      }),
      (err: unknown) => err instanceof Refusal && err.code === 'EXAM_CONTEXT_MISMATCH',
    );
    await assert.rejects(
      () => runVerificationModule({
        module: 'qa',
        ledger: db,
        principal,
        authority: bancoAuth,
        projectId,
        repoPath: repo,
        dataDirectory,
        commit,
        collectorOutput: {
          coverage: [{tool: 'vitest', version: '2.1.0', status: 'ok', detail: '1 suite'}],
          findings: [],
        },
      }),
      (err: unknown) => err instanceof Refusal && err.code === 'EXAM_CONTEXT_MISMATCH',
    );
    await db.releaseLease(bancoAuth);

    // Verifica que o trigger SQL também bloqueia vínculo incorreto direto no banco
    const fakeIntentId = randomUUID();
    await db.pool.query(
      `INSERT INTO ac_intents (id, context_id, principal_id, digest, command, operation_id, run_id, manager_epoch, plan_revision)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,1,0)`,
      [fakeIntentId, mainContext, principal, '0'.repeat(64), JSON.stringify({schemaVersion: 1}), randomUUID(), randomUUID()],
    );
    await assert.rejects(
      () => db.pool.query(
        `INSERT INTO ac_verify_runs (id, project_id, context_id, intent_id, principal_id, commit_id, status, report_dir, module)
         VALUES ($1,$2,$3,$4,$5,$6,'running','pending','qa')`,
        [randomUUID(), projectId, mainContext, fakeIntentId, principal, commit],
      ),
      /VERIFY_RUN_EXAM_CONTEXT_MISMATCH/,
    );
    await assert.rejects(
      () => db.pool.query(
        `INSERT INTO ac_verify_runs (id, project_id, context_id, intent_id, principal_id, commit_id, status, report_dir, module)
         VALUES ($1,$2,$3,$4,$5,$6,'running','pending','qa')`,
        [randomUUID(), otherProjectId, mainContext, fakeIntentId, principal, commit],
      ),
      /VERIFY_RUN_CONTEXT_PROJECT_MISMATCH/,
    );
    void otherMainContext;

    const installationPath = await writePersonalInstallation(root, {
      databaseUrl: database.url,
      projectId,
      repo,
      owner: principal,
      dataDirectory,
    });

    // Preserva personal:qa show|set|clear
    const shownDefault = await runPersonalQaCli([installationPath, 'ProjetoModulos', 'show']);
    assert.match(shownDefault[0] ?? '', /QA padrão/);

    // Executa cada uma das 8 CLIs personal:<modulo> (qa via runPersonalQaCli e os demais via runPersonalModuleCli)
    for (const mod of VERIFICATION_MODULES) {
      const collectorSample = {
        coverage: [
          {tool: `${mod}-tool`, version: '1.2.3', status: 'ok' as const, detail: `módulo ${mod}: 2 arquivos medidos`},
          {tool: `${mod}-tool`, version: '1.2.3', status: 'ok' as const, detail: 'arquivo src/app.ts: 3 linhas verificadas'},
          {tool: `${mod}-tool`, version: '1.2.3', status: 'ok' as const, detail: 'rota GET /health: requisito R-01 verificado'},
          {tool: `${mod}-optional`, version: '0.9.0', status: 'skipped' as const, detail: 'sem alvo opcional configurado'},
        ],
        findings: [
          {
            tool: `${mod}-tool`,
            rule: `${mod}-rule-01`,
            file: 'src/app.ts',
            line: 2,
            severity: 'alta' as const,
            message: `Defeito detectado pelo módulo ${mod} em src/app.ts.`,
            evidence: 'return 42;',
          },
          {
            tool: `${mod}-tool`,
            rule: `${mod}-rule-02`,
            file: 'src/db.ts',
            line: 1,
            severity: 'media' as const,
            message: `Ponto secundário em src/db.ts no módulo ${mod}.`,
            evidence: 'SELECT * FROM users',
          },
        ],
      };

      const deps = {collectorOutput: collectorSample, moduleExamRuntime: async () => runtime};
      const cliOut = mod === 'qa'
        ? await runPersonalQaCli([installationPath, projectId], deps)
        : await runPersonalModuleCli(mod, [installationPath, 'ProjetoModulos'], deps);

      const [runId, reportDir] = cliOut;
      assert.ok(runId && reportDir);
      assert.equal(reportDir.endsWith(`-${mod}`), true);
      assert.equal(((await lstat(reportDir)).mode & 0o777), 0o700);
      assert.equal(((await lstat(join(reportDir, 'README.md'))).mode & 0o777), 0o600);
      assert.equal(((await lstat(join(reportDir, 'cobertura.md'))).mode & 0o777), 0o600);
      assert.equal(((await lstat(join(reportDir, 'achados.json'))).mode & 0o777), 0o600);
      assert.equal(((await lstat(join(reportDir, 'achados', 'ACH-001.md'))).mode & 0o777), 0o600);

      // Verifica vínculo do run ao contexto dedicado do módulo no banco
      const runRow = (await db.pool.query<{context_id: string; module: string; status: string; report_dir: string}>(
        'SELECT context_id::text AS context_id, module, status, report_dir FROM ac_verify_runs WHERE id=$1',
        [runId],
      )).rows[0];
      assert.equal(runRow?.context_id, moduleContexts.get(mod));
      assert.equal(runRow?.module, mod);
      assert.equal(runRow?.status, 'done');
      assert.equal(runRow?.report_dir, reportDir);

      // Verifica linhas adicionais de cobertura por arquivo, rota e requisito
      const toolCovRows = (await db.pool.query<{seq: number; tool: string; status: string; detail: string}>(
        'SELECT seq, tool, status, detail FROM ac_verify_tool_coverage WHERE run_id=$1 ORDER BY seq',
        [runId],
      )).rows;
      assert.equal(toolCovRows.length, 4);
      assert.match(toolCovRows[1]?.detail ?? '', /arquivo src\/app\.ts/);
      assert.match(toolCovRows[2]?.detail ?? '', /rota GET \/health: requisito R-01/);
      assert.equal(toolCovRows[3]?.status, 'skipped');

      // Leitura estruturada do relatório privado
      const readBack = await readModuleReport(dataDirectory, projectId, runId, mod);
      assert.equal(readBack.summary.id, runId);
      assert.equal(readBack.summary.module, mod);
      assert.equal(readBack.summary.counts.alta, 0);
      assert.equal(readBack.summary.counts.media, 0);
      assert.equal(readBack.summary.toolFailures, 0);
      assert.equal(readBack.achados.length, 2);
      assert.ok(readBack.achados.every(finding => finding.status === 'provavel' && finding.verifier === null));
      assert.match(readBack.coverageMarkdown, /arquivo src\/app\.ts: 3 linhas verificadas/);
      assert.match(readBack.coverageMarkdown, /rota GET \/health: requisito R-01 verificado/);
      const achadoMd = await readModuleAchadoMarkdown(dataDirectory, projectId, runId, 'ACH-001', mod);
      assert.match(achadoMd, /Onde: src\/app\.ts:2/);
      assert.match(achadoMd, /Prova: return 42;/);
      assert.match(achadoMd, new RegExp(REMEDIATION_ACCEPTANCE));

      // Use a synthetic previously confirmed run for the correction-only assertions.
      await assert.rejects(runPersonalModuleCli(mod, [installationPath, projectId, '--corrigir', runId, 'ACH-001']),
        (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_FINDING_MISSING');
      await db.pool.query("UPDATE ac_verify_findings SET status='confirmado' WHERE run_id=$1", [runId]);
      // Conversão idempotente de achados em tarefas do produto via CLI (--corrigir)
      const fix1 = await runPersonalModuleCli(mod, [
        installationPath,
        projectId,
        '--corrigir',
        runId,
        'ACH-002',
        'ACH-001',
        'ACH-002',
      ]);
      const fix2 = await runPersonalModuleCli(mod, [
        installationPath,
        projectId,
        '--corrigir',
        runId,
        'ACH-001',
        'ACH-002',
      ]);
      assert.deepEqual(fix1, fix2);
      const firstPaths = ['src/app.ts', `tests/${mod}/ach-001.test.ts`];
      const secondPaths = ['src/db.ts', `tests/${mod}/ach-002.test.ts`];
      assert.deepEqual(fix1.slice(2), [...firstPaths, ...secondPaths]);
      if (mod === 'qa') {
        assert.deepEqual(await runPersonalModuleCli(mod, [installationPath, projectId, '--corrigir', runId!, 'ACH-001']),
          [fix1[0], ...firstPaths]);
        await db.pool.query("UPDATE ac_verify_findings SET status='fechado' WHERE run_id=$1 AND achado_id='ACH-001'", [runId]);
        assert.deepEqual(await runPersonalModuleCli(mod, [installationPath, projectId, '--corrigir', runId!, 'ACH-001', 'ACH-002']), fix1);
        await db.pool.query("UPDATE ac_verify_findings SET status='confirmado' WHERE run_id=$1 AND achado_id='ACH-001'", [runId]);
      }

      const remRows = (await db.pool.query<{
        finding_ids: string[];
        message_local_id: string;
        write_paths: string[];
        regression_test: string;
        acceptance: string;
      }>(
        'SELECT finding_ids, message_local_id, write_paths, regression_test, acceptance FROM ac_verify_remediations WHERE run_id=$1 ORDER BY finding_ids',
        [runId],
      )).rows;
      assert.equal(remRows.length, 2);
      assert.deepEqual(remRows.map(row => row.message_local_id), fix1.slice(0, 2));
      assert.deepEqual(remRows.map(row => row.finding_ids), [['ACH-001'], ['ACH-002']]);
      assert.deepEqual(remRows.map(row => row.write_paths), [firstPaths, secondPaths]);
      assert.match(remRows[0]?.regression_test ?? '', new RegExp(`tests/${mod}/ach-001\\.test\\.ts`));
      assert.equal(remRows[0]?.acceptance, REMEDIATION_ACCEPTANCE);

      const mainMsg = (await db.pool.query<{text: string; role: string}>(
        'SELECT text, role FROM ac_personal_messages WHERE context_id=$1 AND local_id=$2',
        [mainContext, fix1[0]],
      )).rows[0];
      assert.equal(mainMsg?.role, 'owner');
      assert.match(mainMsg?.text ?? '', new RegExp(`Projeto: ${projectId}`));
      assert.match(mainMsg?.text ?? '', /- src\/app\.ts/);
      assert.doesNotMatch(mainMsg?.text ?? '', /src\/db\.ts/);
      assert.match(mainMsg?.text ?? '', new RegExp(REMEDIATION_ACCEPTANCE));
      // A tarefa de correção inclui a descrição; prompts de revisão omitem conclusões.
      assert.match(mainMsg?.text ?? '', /Defeito detectado pelo módulo/);
    }
    assert.equal(docker.logs.filter(launch => launch.provider === 'codex').length, 16);
    docker.check();

    const legacyAuthority = await db.acquire(principal, moduleContexts.get('arquitetura')!, randomUUID(), 'legacy-review-fixture', 60);
    try {
      const legacyCollector = {coverage: [{tool: 'fixture', version: '1', status: 'ok', detail: 'leitura'}],
        findings: ['RETORNO', 'OUTRA-REGRA', 'OUTRO-ARQUIVO'].map(rule => ({tool: 'fixture', rule, file: 'src/app.ts', line: 2,
          severity: 'baixa', message: 'CONCLUSAO_NAO_ENVIADA', evidence: 'return 42;'}))};
      let firstBinding: string | undefined;
      const reviewed = await runVerificationModule({module: 'arquitetura', ledger: db, principal, authority: legacyAuthority,
        projectId, repoPath: repo, dataDirectory, commit, collectorOutput: legacyCollector,
        worker: {async run(call) {
          const task = JSON.parse(call.task);
          assert.equal(task.code, 'return 42;');
          assert.doesNotMatch(call.task, /CONCLUSAO_NAO_ENVIADA/);
          firstBinding ??= task.binding;
          return JSON.stringify({kind: 'confirmacao', status: 'confirmado',
            binding: task.rule === 'OUTRO-ARQUIVO' ? task.binding : firstBinding,
            proof: task.rule === 'OUTRO-ARQUIVO' ? 'export const query = "SELECT * FROM users";' : task.code,
            reason: 'A linha retorna diretamente o literal `42`.'});
        }},
      });
      assert.deepEqual(reviewed.achados.map(finding => finding.status), ['provavel', 'provavel', 'provavel']);
    } finally {
      await db.releaseLease(legacyAuthority);
    }

    // O gerente do contexto principal permanece intacto e com o mesmo epoch após rodar todos os 8 módulos
    const mainMgr = (await db.pool.query<{epoch: string; active: boolean}>(
      'SELECT epoch::text AS epoch, lease_until > clock_timestamp() AS active FROM ac_managers WHERE context_id=$1',
      [mainContext],
    )).rows[0];
    assert.equal(Number(mainMgr?.epoch), mainAuthority.epoch);
    assert.equal(mainMgr?.active, true);

    // Falha de ferramenta: fica registrada na cobertura, grava o relatório no disco e no banco, e faz a CLI sair com erro (VERIFY_TOOLS_FAILED)
    let failedResultRunId = '';
    let failedResultDir = '';
    await assert.rejects(
      () => runPersonalModuleCli(
        'dependencias',
        [installationPath, projectId],
        {
          collectorOutput: {
            coverage: [
              {tool: 'npm-check-updates', version: '17.1.0', status: 'ok', detail: 'package.json verificado'},
              {tool: 'renovate-local', version: '39.0.0', status: 'failed', detail: 'configuração inválida em renovate.json'},
            ],
            findings: [
              {
                tool: 'npm-check-updates',
                rule: 'outdated-major',
                file: 'src/app.ts',
                line: 1,
                severity: 'baixa',
                message: 'Atualização disponível.',
                evidence: 'version 1.0.0 -> 2.0.0',
              },
            ],
          },
          onResult(result) {
            failedResultRunId = result.runId;
            failedResultDir = result.directory;
          },
        },
      ),
      (err: unknown) => {
        assert.equal(err instanceof Refusal, true);
        assert.equal((err as Refusal).code, 'VERIFY_TOOLS_FAILED');
        assert.match(moduleCliFailureText(err, 'dependencias'), /cobertura do relatório/);
        return true;
      },
    );
    assert.notEqual(failedResultRunId, '');
    assert.notEqual(failedResultDir, '');
    const failedReport = await readModuleReport(dataDirectory, projectId, failedResultRunId, 'dependencias');
    assert.equal(failedReport.summary.toolFailures, 1);
    assert.match(failedReport.coverageMarkdown, /renovate-local \| 39\.0\.0 \| failed \| configuração inválida/);
    assert.match(failedReport.readmeMarkdown, /## Falhas de ferramentas/);
    assert.equal(failedReport.achados.length, 1);

    const [recheckRunId] = await runPersonalQaCli([installationPath, projectId], {collectorOutput: {
      coverage: [{tool: qaStaticTool, version: '1', status: 'ok', detail: 'leitura local'}],
      findings: [qaStaticFinding('src/app.ts', 4, skipped + ';')],
    }});
    const recheckBefore = await readModuleReport(dataDirectory, projectId, recheckRunId!, 'qa');
    // Reverificação sem conclusão do autor e isolamento da transação.
    const seenTasks: string[] = [];
    let recheckIntent = '';
    const qaAuth = await db.acquire(principal, moduleContexts.get('qa')!, randomUUID(), 'recheck-qa', 60);
    try {
      // A failed database transaction must not publish its tentative verdict.
      await db.pool.query(`CREATE FUNCTION synthetic_recheck_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic rollback'; END $$`);
      await db.pool.query('CREATE TRIGGER synthetic_recheck_failure BEFORE UPDATE ON ac_verify_findings FOR EACH ROW EXECUTE FUNCTION synthetic_recheck_failure()');
      const recheckInput = {module: 'qa' as const, runId: recheckRunId!,
        achadoIds: ['ACH-001'], dataDirectory, projectId};
      const reviewer = {provider: 'claude', model: 'fixture-model', profileId, accountId, grantId: randomUUID()};
      const response = (task: string) => ({reviewer, output: JSON.stringify(reviewFixtureVerdict(JSON.parse(task), skipped))});
      await assert.rejects(recheckModuleFindings(db, principal, qaAuth, {...recheckInput,
        review: async ({task}) => response(task)}), /synthetic rollback/);
      assert.equal((await readModuleReport(dataDirectory, projectId, recheckRunId!)).achados[0]?.status, recheckBefore.achados[0]?.status);
      assert.equal((await db.pool.query('SELECT status FROM ac_verify_findings WHERE run_id=$1', [recheckRunId])).rows[0]?.status,
        recheckBefore.achados[0]?.status);
      assert.equal((await db.pool.query("SELECT 1 FROM ac_audit WHERE kind='module.finding_rechecked' AND detail->>'runId'=$1",
        [recheckRunId])).rowCount, 0);
      await db.pool.query('DROP TRIGGER synthetic_recheck_failure ON ac_verify_findings');
      await db.pool.query('DROP FUNCTION synthetic_recheck_failure()');
      // Two real requests use the same HEAD, so only the generation can
      // reject the older conflicting verdict after both workers have run.
      let markOlderStarted!: () => void;
      let finishOlder!: () => void;
      const olderStarted = new Promise<void>(resolve => {markOlderStarted = resolve;});
      const olderMayFinish = new Promise<void>(resolve => {finishOlder = resolve;});
      let olderIntent = '';
      const older = recheckModuleFindings(db, principal, qaAuth, {...recheckInput, async review(call) {
        olderIntent = call.intentId;
        markOlderStarted();
        await olderMayFinish;
        return response(call.task);
      }});
      const olderRejected = assert.rejects(older,
        (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_RUN_CONFLICT');
      void olderRejected.catch(() => undefined);
      let rechecked: Awaited<ReturnType<typeof recheckModuleFindings>>;
      try {
        await Promise.race([olderStarted, older]);
        rechecked = await recheckModuleFindings(db, principal, qaAuth, {
          ...recheckInput,
          async review(call) {
            seenTasks.push(call.task);
            recheckIntent = call.intentId;
            assert.equal(call.examiner, null);
            return response(call.task);
          },
        });
      } finally {
        finishOlder();
        await olderRejected;
      }
      assert.deepEqual(rechecked, {results: [{id: 'ACH-001', status: 'reaberto'}], publication: 'published'});
      assert.equal(seenTasks.length, 1);
      assert.doesNotMatch(seenTasks[0]!, /CONCLUSAO_DO_AUTOR/);
      assert.equal((await db.pool.query('SELECT state FROM ac_intents WHERE id=$1', [recheckIntent])).rows[0]?.state, 'done');
      assert.equal((await db.pool.query('SELECT state FROM ac_intents WHERE id=$1', [olderIntent])).rows[0]?.state, 'failed');
      const updated = await readModuleReport(dataDirectory, projectId, recheckRunId!, 'qa');
      assert.equal(updated.achados[0]?.status, 'reaberto');
      assert.equal((await db.pool.query('SELECT status FROM ac_verify_findings WHERE run_id=$1', [recheckRunId])).rows[0]?.status, 'reaberto');
    } finally {
      await db.releaseLease(qaAuth);
    }

    // Arquivo fora do snapshot não gera achado: o relatório registra falha do coletor.
    const outsideSecret = join(root, 'outside.txt');
    await writeFile(outsideSecret, 'SEGREDO_FORA\n');
    await symlink(outsideSecret, join(repo, 'src', 'symlink.ts'));
    const arqAuth = await db.acquire(principal, moduleContexts.get('arquitetura')!, randomUUID(), 'symlink-check', 60);
    try {
      const invalid = await runVerificationModule({
          module: 'arquitetura',
          ledger: db,
          principal,
          authority: arqAuth,
          projectId,
          repoPath: repo,
          dataDirectory,
          commit,
          collectorOutput: {
            coverage: [{tool: 'knip', version: '5.1.0', status: 'ok', detail: '1 arquivo'}],
            findings: [{
              tool: 'knip',
              rule: 'symlink-rule',
              file: 'src/symlink.ts',
              line: 1,
              severity: 'alta',
              message: 'Não deve aceitar symlink.',
              evidence: 'symlink',
            }],
          },
        });
      assert.equal(invalid.hasToolFailure, true);
      assert.deepEqual(invalid.achados, []);
      assert.deepEqual(invalid.coverage, []);
    } finally {
      await db.releaseLease(arqAuth);
    }

    // --descartar remove o relatório privado do disco
    const beforeDiscard = await listModuleReports(dataDirectory, projectId, 'dependencias');
    assert.equal(beforeDiscard.some(item => item.id === failedResultRunId), true);
    await db.pool.query('DELETE FROM ac_memberships WHERE project_id=$1 AND principal_id=$2', [projectId, principal]);
    await assert.rejects(() => runPersonalModuleCli('dependencias', [installationPath, projectId, '--descartar', failedResultRunId]),
      (error: unknown) => error instanceof Refusal && error.code === 'PROJECT_FORBIDDEN');
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [projectId, principal]);
    const discardOut = await runPersonalModuleCli('dependencias', [installationPath, projectId, '--descartar', failedResultRunId]);
    assert.deepEqual(discardOut, ['Relatório descartado.']);
    assert.deepEqual(await runPersonalModuleCli('dependencias', [installationPath, projectId, '--descartar', failedResultRunId]), ['Relatório descartado.']);
    assert.match((await db.pool.query('SELECT report_dir FROM ac_verify_runs WHERE id=$1', [failedResultRunId])).rows[0]?.report_dir, /^discarded(?::|$)/);
    const afterDiscard = await listModuleReports(dataDirectory, projectId, 'dependencias');
    assert.equal(afterDiscard.some(item => item.id === failedResultRunId), false);

    // parsePersonalModuleArgs valida argumentos da CLI
    assert.throws(
      () => parsePersonalModuleArgs('qa', [installationPath]),
      (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_USAGE',
    );
    assert.throws(
      () => parsePersonalModuleArgs('qa', [installationPath, projectId, '--corrigir', randomUUID()]),
      (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_USAGE',
    );

    // Concorrência: mesmo módulo em paralelo recusa com VERIFY_ALREADY_RUNNING (409), enquanto outro módulo roda em paralelo no seu próprio contexto dedicado
    let releaseFirstCollector!: () => void;
    const firstCollectorGate = new Promise<void>(resolveGate => {
      releaseFirstCollector = resolveGate;
    });
    let firstCollectorStarted!: () => void;
    const firstStartedPromise = new Promise<void>(resolveStarted => {
      firstCollectorStarted = resolveStarted;
    });

    const runningQa = runPersonalModuleCli('qa', [installationPath, projectId], {
      runCollector: async () => {
        firstCollectorStarted();
        await firstCollectorGate;
        return {
          coverage: [{tool: 'qa-runner', version: '1.0.0', status: 'ok', detail: 'suite paralela'}],
          findings: [],
        };
      },
    });
    await firstStartedPromise;

    await assert.rejects(
      () => runPersonalModuleCli('qa', [installationPath, projectId], {
        collectorOutput: {
          coverage: [{tool: 'qa-runner', version: '1.0.0', status: 'ok', detail: 'duplicado'}],
          findings: [],
        },
      }),
      (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_ALREADY_RUNNING' && err.status === 409,
    );

    // Enquanto 'qa' está rodando, 'prontidao' roda normalmente em paralelo no seu próprio contexto
    const parallelProntidao = await runPersonalModuleCli('prontidao', [installationPath, projectId], {
      collectorOutput: {
        coverage: [{tool: 'tls-check', version: '1.0.0', status: 'ok', detail: 'paralelo com qa'}],
        findings: [],
      },
    });
    assert.equal(parallelProntidao.length, 2);

    releaseFirstCollector();
    const finishedQa = await runningQa;
    assert.equal(finishedQa.length, 2);

    // Interrupção por SIGINT (Ctrl-C) marca run e intent como failed e libera o lease
    await assert.rejects(
      () => runPersonalModuleCli('documentacao', [installationPath, projectId], {
        runCollector: async () => {
          setImmediate(() => {
            process.emit('SIGINT', 'SIGINT');
          });
          await new Promise(resolveWait => setTimeout(resolveWait, 300));
          return {
            coverage: [{tool: 'typedoc', version: '0.26.0', status: 'ok', detail: 'interrompido'}],
            findings: [],
          };
        },
      }),
      (err: unknown) => err instanceof Refusal && err.code === 'EXAM_INTERRUPTED',
    );
    const interruptedDoc = (await db.pool.query<{status: string; intent_state: string}>(
      `SELECT r.status, i.state AS intent_state
       FROM ac_verify_runs r JOIN ac_intents i ON i.id = r.intent_id
       WHERE r.project_id = $1 AND r.module = 'documentacao'
       ORDER BY r.created_at DESC LIMIT 1`,
      [projectId],
    )).rows[0];
    assert.equal(interruptedDoc?.status, 'failed');
    assert.equal(interruptedDoc?.intent_state, 'failed');

    // Diretório de dados dentro do repositório é recusado com VERIFY_REPORT_INSIDE_REPO
    await mkdir(join(repo, 'sub-data'));
    const docAuth = await db.acquire(principal, moduleContexts.get('documentacao')!, randomUUID(), 'inside-repo-check', 60);
    try {
      await assert.rejects(
        () => runVerificationModule({
          module: 'documentacao',
          ledger: db,
          principal,
          authority: docAuth,
          projectId,
          repoPath: repo,
          dataDirectory: join(repo, 'sub-data'),
          commit,
          collectorOutput: {
            coverage: [{tool: 'typedoc', version: '0.26.0', status: 'ok', detail: 'ok'}],
            findings: [],
          },
        }),
        (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_REPORT_INSIDE_REPO',
      );
    } finally {
      await db.releaseLease(docAuth);
    }

    // Isolamento entre projetos em requestModuleCorrection
    const otherAuth = await db.acquire(stranger, otherMainContext, randomUUID(), 'other-mgr', 60);
    try {
      await assert.rejects(
        () => requestModuleCorrection(db, stranger, otherAuth, {
          module: 'qa',
          runId: finishedQa[0]!,
          achadoIds: ['ACH-001'],
          dataDirectory,
          projectId,
        }),
        (err: unknown) => err instanceof Refusal && (err.code === 'CONTEXT_FORBIDDEN' || err.code === 'PROJECT_SCOPE_MISMATCH'),
      );
      await assert.rejects(
        () => requestModuleCorrection(db, stranger, otherAuth, {
          module: 'qa',
          runId: finishedQa[0]!,
          achadoIds: ['ACH-001'],
          dataDirectory,
          projectId: otherProjectId,
        }),
        (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_RUN_MISSING',
      );
    } finally {
      await db.releaseLease(otherAuth);
    }
  } finally {
    stopMainLease?.();
    await examFixture?.docker.close();
    await db.close();
    await database.close();
    await rm(root, {recursive: true, force: true});
  }
});
