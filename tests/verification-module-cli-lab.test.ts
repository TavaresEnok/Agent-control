import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {Refusal, type Authority} from '../src/contracts.ts';
import {Ledger, VERIFICATION_MODULES, type VerificationModule} from '../src/ledger.ts';
import {runPersonalModuleCli} from '../src/personal-module-cli.ts';
import {
  assertVerificationModule,
  parseModuleCollectorOutput,
  readModuleAchadoMarkdown,
  readModuleReport,
  readPinnedModuleImage,
} from '../src/verification-modules.ts';
import {REMEDIATION_ACCEPTANCE} from '../src/verify-types.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const exec = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, '..');
const LAB_ENABLED = process.env.AC_MODULE_LAB === '1';
const CLEAN_SUBDIR_NAMES = new Set(['clean', 'limpo', 'control-clean', 'controle-limpo']);
// Ledger.heartbeat renews for 15 seconds regardless of the initial lease duration.
const MAIN_MANAGER_HEARTBEAT_MS = 5_000;

type ModuleLabExpectation = {
  /** Known defective fixture subpath relative to repo root. */
  fixtureCandidates: readonly string[];
  /** Active tools expected to report `ok` in coverage when running offline against the defective fixture. */
  expectedOkTools: readonly string[];
  /** Predicate selecting the planted defect used when testing `--corrigir`. */
  matchFinding: (finding: {
    id: string;
    title: string;
    reference: string;
    status: string;
    where: {file: string; line: number | null};
    sources: string[];
    proof: string;
  }) => boolean;
  /** Optional extra check on `cobertura.md` (e.g. per-file / per-route / per-requirement rows). */
  coverageDetailPattern?: RegExp;
};

const MODULE_EXPECTATIONS: Readonly<Record<VerificationModule, ModuleLabExpectation>> = {
  qa: {
    fixtureCandidates: ['tests/fixtures/module-qa'],
    expectedOkTools: [
      'node-test-v8',
      'stryker-mutator',
      'qa-propriedades-funcionais',
      'qa-auditoria-estatica-testes',
      'axe-core',
      'swagger-parser',
    ],
    matchFinding: f =>
      f.where.file === 'src/defective-pricing.ts'
      && (f.title.startsWith('QA-COBERTURA-FUNCAO-SEM-TESTE')
        || f.title.startsWith('QA-STRYKER-MUTANTE-SOBREVIVENTE')),
    coverageDetailPattern: /qa-arquivo:src\/defective-pricing\.ts/,
  },
  arquitetura: {
    fixtureCandidates: ['tests/fixtures/module-arquitetura/defective'],
    expectedOkTools: ['knip', 'ast-complexity', 'jscpd', 'dependency-cruiser'],
    matchFinding: f =>
      f.where.file === 'src/legacy-dead.ts' && f.title.startsWith('KNIP-UNUSED-FILE'),
    coverageDetailPattern: /knip:file/,
  },
  dependencias: {
    fixtureCandidates: ['tests/fixtures/module-dependencias/com-defeito'],
    expectedOkTools: ['npm-check-updates', 'ast-grep', 'jscodeshift', 'sbom-lockfile'],
    matchFinding: f =>
      f.where.file === 'src/server.ts' && f.title.startsWith('ASTGREP-EXPRESS5-APP-DEL'),
  },
  banco: {
    fixtureCandidates: ['tests/fixtures/module-banco/defective'],
    expectedOkTools: ['squawk', 'pg-migrate', 'pg_restore', 'pg_stat_statements', 'EXPLAIN', 'dexter'],
    matchFinding: f =>
      f.where.file === 'db/migrations/002_revision.sql' && f.title.startsWith('SQUAWK-BAN-DROP-COLUMN'),
    coverageDetailPattern: /pg-migrate:fresh:/,
  },
  prontidao: {
    fixtureCandidates: ['tests/fixtures/module-prontidao/defective'],
    expectedOkTools: ['prontidao-audit', 'gitleaks', 'hadolint', 'trivy'],
    matchFinding: f =>
      f.where.file === 'src/tls-client.ts'
      && f.sources.includes('prontidao-audit')
      && /^rejectUnauthorized\s*:\s*false\b/.test(f.proof),
    coverageDetailPattern: /prontidao:requisito:/,
  },
  desempenho: {
    fixtureCandidates: ['tests/fixtures/module-desempenho/defective'],
    expectedOkTools: ['lighthouse-ci', 'k6', 'node-cpu-prof', 'pg_stat_statements'],
    matchFinding: f =>
      f.where.file === 'server.mjs'
      && (f.title.startsWith('K6-THRESHOLD-LATENCY-P95') || f.title.startsWith('CPU-PROF-HOTSPOT')),
    coverageDetailPattern: /node-cpu-prof:arquivo:/,
  },
  documentacao: {
    fixtureCandidates: ['tests/fixtures/module-documentacao/defective'],
    expectedOkTools: ['typedoc', 'dependency-cruiser', 'mermaid'],
    matchFinding: f =>
      f.where.file === 'src/billing.ts'
      && f.sources.includes('DOC-TYPEDOC-SIMBOLO-SEM-DOC')
      && f.title.includes('\"undocumentedCharge\"'),
    coverageDetailPattern: /typedoc:file/,
  },
  conformidade: {
    fixtureCandidates: ['tests/fixtures/module-conformidade/com-defeito'],
    expectedOkTools: ['scancode-toolkit', 'presidio-analyzer', 'npm-license-policy', 'lgpd-static', 'ort'],
    matchFinding: f =>
      f.where.file === 'package-lock.json' && f.title.startsWith('ORT_STRONG_COPYLEFT_DECLARED'),
    coverageDetailPattern: /ort:file/,
  },
};

/** Parses `AC_MODULE_LAB_MODULE` or `AC_MODULE_LAB_MODULES` so the manager can run one module or all eight. */
export function resolveSelectedLabModules(env: NodeJS.ProcessEnv = process.env): VerificationModule[] {
  const rawSingle = env.AC_MODULE_LAB_MODULE?.trim();
  const rawList = env.AC_MODULE_LAB_MODULES?.trim();
  const raw = rawSingle || rawList;
  if (!raw || raw.toLowerCase() === 'all') {
    return [...VERIFICATION_MODULES];
  }
  const seen = new Set<VerificationModule>();
  const selected: VerificationModule[] = [];
  for (const token of raw.split(',').map(part => part.trim()).filter(Boolean)) {
    const mod = assertVerificationModule(token);
    if (!seen.has(mod)) {
      seen.add(mod);
      selected.push(mod);
    }
  }
  if (selected.length === 0) {
    throw new Error('AC_MODULE_LAB_SELECTION_EMPTY');
  }
  return selected;
}

async function nonEmptyDirectory(dirPath: string): Promise<boolean> {
  try {
    const info = await stat(dirPath);
    if (!info.isDirectory()) return false;
    const entries = await readdir(dirPath);
    return entries.some(name => !CLEAN_SUBDIR_NAMES.has(name));
  } catch {
    return false;
  }
}

/** Resolves the defective fixture directory for a module, failing explicitly when missing. */
export async function resolveModuleDefectiveFixture(
  module: VerificationModule,
  rootDir = REPO_ROOT,
): Promise<string> {
  const spec = MODULE_EXPECTATIONS[module];
  for (const candidate of spec.fixtureCandidates) {
    const full = resolve(rootDir, candidate);
    if (await nonEmptyDirectory(full)) {
      return full;
    }
  }
  throw new Error(
    `FIXTURE_MISSING: nenhuma fixture com defeito encontrada para o módulo '${module}' em ${spec.fixtureCandidates.join(', ')}`,
  );
}

/** Ensures both pinned digest and defective fixture exist when the lab runs. */
export async function resolveModuleLabInputs(
  module: VerificationModule,
  rootDir = REPO_ROOT,
): Promise<{module: VerificationModule; image: string; fixtureDir: string}> {
  const image = await readPinnedModuleImage(module, rootDir);
  const fixtureDir = await resolveModuleDefectiveFixture(module, rootDir);
  return {module, image, fixtureDir};
}

async function normalizeRepoPermissions(dirPath: string): Promise<void> {
  const info = await lstat(dirPath);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(dirPath, 0o755);
    for (const entry of await readdir(dirPath)) {
      await normalizeRepoPermissions(join(dirPath, entry));
    }
    return;
  }
  if (info.isFile()) {
    await chmod(dirPath, (info.mode & 0o111) !== 0 ? 0o755 : 0o644);
  }
}

async function buildSyntheticGitRepoFromFixture(
  root: string,
  fixtureDir: string,
): Promise<{repo: string; commit: string}> {
  const repo = join(root, 'repo');
  await cp(fixtureDir, repo, {recursive: true});
  await normalizeRepoPermissions(repo);

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Lab',
    GIT_AUTHOR_EMAIL: 'lab@example.com',
    GIT_COMMITTER_NAME: 'Lab',
    GIT_COMMITTER_EMAIL: 'lab@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  await exec('git', ['init'], {cwd: repo, env: gitEnv});
  await exec('git', ['add', '-A'], {cwd: repo, env: gitEnv});
  await exec('git', ['-c', 'user.name=Lab', '-c', 'user.email=lab@example.com', 'commit', '-m', 'fixture com defeito'], {
    cwd: repo,
    env: gitEnv,
  });
  const commit = (await exec('git', ['rev-parse', 'HEAD'], {cwd: repo, env: gitEnv})).stdout.trim();

  // Untracked working-tree canary: must never enter the container via `git archive`.
  await writeFile(
    join(repo, 'untracked-working-tree-only.ts'),
    'export const UNTRACKED_SNAPSHOT_CANARY = "do-not-leak";\n',
    {mode: 0o644},
  );
  return {repo, commit};
}

async function writeDisposablePersonalInstallation(
  root: string,
  opts: {
    databaseUrl: string;
    projectId: string;
    label: string;
    repo: string;
    owner: string;
    dataDirectory: string;
  },
): Promise<string> {
  const file = join(root, 'installation.json');
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      mode: 'administration-only',
      activation: 'personal',
      databaseUrl: opts.databaseUrl,
      dataDirectory: opts.dataDirectory,
      project: {
        id: opts.projectId,
        label: opts.label,
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

function buildCleanCliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {...process.env};
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  return env;
}

async function runPersonalCliSubprocess(
  module: VerificationModule,
  args: readonly string[],
): Promise<string[]> {
  const {stdout, stderr} = await exec(
    'npm',
    ['run', `personal:${module}`, '--', ...args],
    {
      cwd: REPO_ROOT,
      env: buildCleanCliEnv(),
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const lines = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('>'));
  if (lines.length === 0) {
    throw new Error(`CLI personal:${module} não imprimiu saída útil. stderr=${stderr}`);
  }
  return lines;
}

async function assertPrivateMode(targetPath: string, expectedMode: number): Promise<void> {
  const info = await lstat(targetPath);
  assert.equal(info.isSymbolicLink(), false, `caminho não pode ser symlink: ${targetPath}`);
  assert.equal(info.mode & 0o777, expectedMode, `permissão esperada ${expectedMode.toString(8)} em ${targetPath}`);
}

function keepMainManagerLease(db: Pick<Ledger, 'heartbeat'>, authority: Authority): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  let failure: Error | undefined;
  const timer = setInterval(() => {
    if (inFlight || failure) return;
    inFlight = db.heartbeat(authority).catch((cause: unknown) => {
      failure = new Error(`Falha no heartbeat do gerente principal (${authority.contextId})`, {cause});
    }).finally(() => {
      inFlight = undefined;
    });
  }, MAIN_MANAGER_HEARTBEAT_MS);
  timer.unref();

  return async () => {
    clearInterval(timer);
    await inFlight;
    if (failure) throw failure;
  };
}

async function verifyModuleEndToEnd(
  db: Ledger,
  databaseUrl: string,
  baseTempRoot: string,
  module: VerificationModule,
  verifyStdoutLimit: boolean,
): Promise<void> {
  const {fixtureDir} = await resolveModuleLabInputs(module, REPO_ROOT);
  const spec = MODULE_EXPECTATIONS[module];

  const modRoot = join(baseTempRoot, module);
  const dataDirectory = join(modRoot, 'data');
  await mkdir(dataDirectory, {recursive: true, mode: 0o700});
  await chmod(dataDirectory, 0o700);

  const principal = `owner-lab-${module}`;
  const projectId = randomUUID();
  const projectLabel = `Lab-${module}`;
  const {repo, commit} = await buildSyntheticGitRepoFromFixture(modRoot, fixtureDir);

  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [projectId, projectLabel]);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [projectId, principal]);
  await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)', [projectId, repo]);

  const mainContext = await db.createContext(principal, projectId, randomUUID());
  const mainInstance = randomUUID();
  const mainAuthority = await db.acquire(principal, mainContext, mainInstance, 'live-gateway-manager', 60);
  const stopHeartbeat = keepMainManagerLease(db, mainAuthority);
  try {
    const installationPath = await writeDisposablePersonalInstallation(modRoot, {
      databaseUrl,
      projectId,
      label: projectLabel,
      repo,
      owner: principal,
      dataDirectory,
    });

    // 1. Disparo real via entrada normal `npm run personal:<modulo>` sem injeção nem mock de Docker
    const runLines = await runPersonalCliSubprocess(module, [installationPath, projectLabel]).catch(async error => {
      const failed = await db.pool.query(
        `SELECT c.tool, c.detail FROM ac_verify_tool_coverage c JOIN ac_verify_runs r ON r.id=c.run_id
         WHERE r.project_id=$1 AND r.module=$2 AND c.status='failed' ORDER BY c.seq`, [projectId, module],
      );
      throw new Error(`Falhas na fixture sintética de ${module}: ${JSON.stringify(failed.rows)}`, {cause: error});
    });
    assert.ok(runLines.length >= 2, `saída inesperada de personal:${module}: ${JSON.stringify(runLines)}`);
    const runId = runLines.at(-2)!;
    const reportDir = runLines.at(-1)!;
    assert.match(runId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(reportDir.startsWith(join(dataDirectory, 'verificacoes', projectId)), true);
    assert.equal(reportDir.endsWith(`-${module}`), true);

    const relFromRepo = relative(repo, reportDir);
    assert.equal(
      relFromRepo === '..' || relFromRepo.startsWith(`..${sep}`) || isAbsolute(relFromRepo),
      true,
      `relatório deve ficar fora do repositório: ${reportDir}`,
    );

    // 2. Permissões privadas no diretório e arquivos do relatório
    await assertPrivateMode(reportDir, 0o700);
    await assertPrivateMode(join(reportDir, 'README.md'), 0o600);
    await assertPrivateMode(join(reportDir, 'mapa.md'), 0o600);
    await assertPrivateMode(join(reportDir, 'cobertura.md'), 0o600);
    await assertPrivateMode(join(reportDir, 'achados.json'), 0o600);
    await assertPrivateMode(join(reportDir, 'run.json'), 0o600);
    await assertPrivateMode(join(reportDir, 'bruto', 'achados-brutos.json'), 0o600);

    // Snapshot do Git: arquivo untracked no working tree não pode vazar para o coletor em contêiner
    const rawCollectorText = await readFile(join(reportDir, 'bruto', 'achados-brutos.json'), 'utf8');
    assert.equal(
      rawCollectorText.includes('untracked-working-tree-only'),
      false,
      `arquivo untracked vazou para o contêiner de ${module}`,
    );

    // 3. Contexto dedicado isolado do contexto principal e do gerente
    const examRow = (await db.pool.query<{context_id: string}>(
      'SELECT context_id::text AS context_id FROM ac_exam_contexts WHERE project_id=$1 AND module=$2',
      [projectId, module],
    )).rows[0];
    assert.ok(examRow, `contexto dedicado ausente para ${module}`);
    assert.notEqual(examRow.context_id, mainContext);

    const runRow = (await db.pool.query<{
      context_id: string;
      intent_id: string;
      module: string;
      commit_id: string;
      status: string;
      report_dir: string;
    }>(
      'SELECT context_id::text AS context_id, intent_id::text AS intent_id, module, commit_id, status, report_dir FROM ac_verify_runs WHERE id=$1',
      [runId],
    )).rows[0];
    assert.equal(runRow?.context_id, examRow.context_id);
    assert.equal(runRow?.module, module);
    assert.equal(runRow?.commit_id, commit);
    assert.equal(runRow?.status, 'done');
    assert.equal(runRow?.report_dir, reportDir);

    const intentRow = (await db.pool.query<{context_id: string; state: string}>(
      'SELECT context_id::text AS context_id, state FROM ac_intents WHERE id=$1',
      [runRow?.intent_id],
    )).rows[0];
    assert.equal(intentRow?.context_id, examRow.context_id);
    assert.equal(intentRow?.state, 'done');

    const mgrRow = (await db.pool.query<{instance_id: string; epoch: string; active: boolean}>(
      `SELECT instance_id::text AS instance_id, epoch::text AS epoch, lease_until > clock_timestamp() AS active
       FROM ac_managers WHERE context_id=$1`,
      [mainContext],
    )).rows[0];
    assert.equal(mgrRow?.instance_id, mainInstance);
    assert.equal(Number(mgrRow?.epoch), mainAuthority.epoch);
    assert.equal(mgrRow?.active, true);

    // 4. Relatório, cobertura de ferramentas e achado comprovado esperado
    const report = await readModuleReport(dataDirectory, projectId, runId, module);
    assert.equal(report.summary.id, runId);
    assert.equal(report.summary.module, module);
    assert.equal(report.summary.commit, commit);
    assert.equal(report.summary.toolFailures, 0);

    const toolCovRows = (await db.pool.query<{tool: string; status: string; detail: string}>(
      'SELECT tool, status, detail FROM ac_verify_tool_coverage WHERE run_id=$1 ORDER BY seq',
      [runId],
    )).rows;
    assert.ok(toolCovRows.length >= 1);
    if (module === 'qa') {
      const gap = toolCovRows.find(row => row.tool === 'qa-requisito:REQ-02');
      assert.equal(gap?.status, 'ok');
      assert.match(gap!.detail, /vínculo sem prova nas três passadas/);
      assert.ok(report.achados.some(f => f.sources.includes('QA-REQUISITO-SEM-PROVA')
        && f.where.file === 'requisitos.md' && f.where.line === 4));
    }
    assert.equal(toolCovRows.some(r => r.status === 'failed'), false, `ferramenta falhou em ${module}: ${JSON.stringify(toolCovRows)}`);
    assert.equal(toolCovRows.some(r => r.status === 'ok'), true, `nenhuma ferramenta ok em ${module}`);

    for (const expectedTool of spec.expectedOkTools) {
      const rows = toolCovRows.filter(r => r.tool === expectedTool);
      assert.ok(rows.length, `ferramenta esperada ausente na cobertura de ${module}: ${expectedTool}`);
      assert.ok(rows.some(r => r.status === 'ok'), `ferramenta ${expectedTool} deveria estar ok em ${module}: ${JSON.stringify(rows)}`);
      assert.equal(report.coverageMarkdown.includes(`| ${expectedTool} |`), true);
    }
    if (spec.coverageDetailPattern) {
      assert.match(report.coverageMarkdown, spec.coverageDetailPattern);
    }

    const measuredFinding = report.achados.find(item => item.status === 'provavel' && spec.matchFinding(item));
    assert.ok(
      measuredFinding,
      `achado medido esperado não encontrado em ${module}. Achados: ${JSON.stringify(report.achados.map(a => ({id: a.id, title: a.title, file: a.where.file, status: a.status})))}`,
    );
    assert.ok(measuredFinding.where.line !== null && measuredFinding.where.line >= 1);
    assert.ok(measuredFinding.proof.length > 0);
    assert.equal(measuredFinding.acceptance, REMEDIATION_ACCEPTANCE);

    const achadoPath = join(reportDir, 'achados', `${measuredFinding.id}.md`);
    await assertPrivateMode(achadoPath, 0o600);
    const achadoMd = await readModuleAchadoMarkdown(dataDirectory, projectId, runId, measuredFinding.id, module);
    assert.equal(achadoMd.includes(`Onde: ${measuredFinding.where.file}:${measuredFinding.where.line}`), true);
    assert.equal(achadoMd.includes('Prova:'), true);
    assert.equal(achadoMd.includes(REMEDIATION_ACCEPTANCE), true);

    assert.equal(measuredFinding.verifier, null);
    await assert.rejects(runPersonalCliSubprocess(module, [installationPath, projectId, '--corrigir', runId, measuredFinding.id]),
      /Achado não encontrado ou não elegível para correção/);

    if (module === 'banco') {
      const migration = 'db/migrations/003_prazo.sql';
      await writeFile(join(repo, migration), 'SELECT pg_sleep(8);\n');
      await exec('git', ['add', '--', migration], {cwd: repo});
      await exec('git', ['-c', 'user.name=Lab', '-c', 'user.email=lab@example.com', 'commit', '-m', 'migração válida excede o prazo do coletor'], {cwd: repo});
      await assert.rejects(() => runPersonalCliSubprocess('banco', [installationPath, projectId]),
        (error: {code?: number; stderr?: string}) => error.code === 1 && !!error.stderr?.includes('registrado na cobertura'));
      const {rows} = await db.pool.query<{report_dir: string; status: string}>(
        'SELECT report_dir, status FROM ac_verify_runs WHERE project_id=$1 AND module=$2 AND id<>$3 ORDER BY created_at DESC LIMIT 1',
        [projectId, module, runId]);
      assert.equal(rows[0]?.status, 'failed');
      const raw = JSON.parse(await readFile(join(rows[0]!.report_dir, 'bruto', 'achados-brutos.json'), 'utf8'));
      assert.ok(raw.coverage.some((row: {tool: string; status: string; detail: string}) =>
        row.tool === 'pg-migrate' && row.status === 'failed' && row.detail.includes('57014') && row.detail.includes(migration)));
      assert.equal(raw.findings.some((finding: {file: string; rule: string}) =>
        finding.file === migration && finding.rule === 'BANCO-MIGRACAO-REJEITADA'), false);
    }

    // 6. Limite real de saída stdout contra o contêiner real (sem mock)
    if (verifyStdoutLimit) {
      await assert.rejects(
        () => runPersonalModuleCli(module, [installationPath, projectId], {maxStdoutBytes: 64}),
        (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_TOOLS_FAILED',
      );
      const limitedRun = (await db.pool.query<{id: string; status: string; intent_state: string; report_dir: string}>(
        `SELECT r.id, r.status, i.state AS intent_state, r.report_dir
         FROM ac_verify_runs r JOIN ac_intents i ON i.id = r.intent_id
         WHERE r.project_id = $1 AND r.module = $2 AND r.id <> $3
         ORDER BY r.created_at DESC LIMIT 1`,
        [projectId, module, runId],
      )).rows[0];
      assert.equal(limitedRun?.status, 'failed');
      assert.equal(limitedRun?.intent_state, 'failed');
      assert.ok(limitedRun);
      const failedCollector = JSON.parse(await readFile(join(limitedRun.report_dir, 'bruto', 'achados-brutos.json'), 'utf8'));
      assert.ok(failedCollector.coverage.some((row: {tool: string; status: string; detail: string}) =>
        row.tool === 'coletor' && row.status === 'failed' && row.detail.includes('VERIFY_STDOUT_LIMIT')));
    }
  } finally {
    try {
      await stopHeartbeat();
    } finally {
      await db.releaseLease(mainAuthority);
    }
  }
}

test('seletores de documentação e prontidão exigem o defeito específico após proteção de segredos', () => {
  const rawFindings = [
    {
      tool: 'typedoc', rule: 'DOC-TYPEDOC-SIMBOLO-SEM-DOC', file: 'src/billing.ts', line: 12,
      severity: 'media',
      message: 'Símbolo público exportado "undocumentedCharge" em src/billing.ts não possui documentação JSDoc/TSDoc.',
      evidence: 'TypeDoc reflection kind=64 name=undocumentedCharge (src/billing.ts:12) sem summary/blockTags',
    },
    {
      tool: 'prontidao-audit', rule: 'PRONTIDAO-TLS-VERIFICACAO-DESABILITADA', file: 'src/tls-client.ts', line: 3,
      severity: 'alta', message: 'Verificação de certificado TLS desabilitada.',
      evidence: 'rejectUnauthorized: false,',
    },
  ];
  const parsed = parseModuleCollectorOutput(JSON.stringify({coverage: [{tool: 'typedoc', version: '1', status: 'ok', detail: 'sintético'}], findings: rawFindings}));
  const findings = parsed.findings.map(f => ({
    id: 'ACH-001', title: `${f.rule}: ${f.message}`, reference: `${f.tool}:${f.rule}`,
    status: 'confirmado', where: {file: f.file, line: f.line}, sources: [f.tool, f.rule], proof: f.evidence,
  }));
  const doc = findings[0]!;
  const tls = findings[1]!;
  assert.equal(MODULE_EXPECTATIONS.documentacao.matchFinding(doc), true);
  assert.equal(MODULE_EXPECTATIONS.prontidao.matchFinding(tls), true);
  assert.equal(tls.sources[1], '[removido: alta entropia]');
  assert.equal(MODULE_EXPECTATIONS.documentacao.matchFinding({...doc, where: {...doc.where, file: 'src/api.ts'}}), false);
  assert.equal(MODULE_EXPECTATIONS.documentacao.matchFinding({...doc, title: doc.title.replace('undocumentedCharge', 'otherCharge')}), false);
  assert.equal(MODULE_EXPECTATIONS.documentacao.matchFinding({...doc, sources: ['typedoc', 'outra-regra']}), false);
  assert.equal(MODULE_EXPECTATIONS.prontidao.matchFinding({...tls, where: {...tls.where, file: '.env'}}), false);
  assert.equal(MODULE_EXPECTATIONS.prontidao.matchFinding({...tls, sources: ['gitleaks']}), false);
  assert.equal(MODULE_EXPECTATIONS.prontidao.matchFinding({...tls, proof: 'rejectUnauthorized: true,'}), false);
});

test('seletor de módulos aceita um módulo, lista ou all e recusa nome inválido', () => {
  assert.deepEqual(resolveSelectedLabModules({}), [...VERIFICATION_MODULES]);
  assert.deepEqual(resolveSelectedLabModules({AC_MODULE_LAB_MODULES: 'all'}), [...VERIFICATION_MODULES]);
  assert.deepEqual(resolveSelectedLabModules({AC_MODULE_LAB_MODULE: 'arquitetura'}), ['arquitetura']);
  assert.deepEqual(
    resolveSelectedLabModules({AC_MODULE_LAB_MODULES: 'qa, dependencias, qa'}),
    ['qa', 'dependencias'],
  );
  assert.throws(
    () => resolveSelectedLabModules({AC_MODULE_LAB_MODULE: 'inexistente'}),
    (err: unknown) => err instanceof Refusal && err.code === 'INVALID_CONTRACT',
  );
});

test('ausência de digest.txt ou fixture com defeito falha explicitamente na resolução do laboratório', async () => {
  const emptyRoot = await mkdtemp(join(tmpdir(), 'ac-cli-lab-missing-'));
  try {
    await assert.rejects(
      () => resolveModuleLabInputs('arquitetura', emptyRoot),
      (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_IMAGE_UNPINNED',
    );
    const modDir = join(emptyRoot, 'deploy', 'modules', 'arquitetura');
    await mkdir(modDir, {recursive: true});
    await writeFile(join(modDir, 'digest.txt'), `sha256:${'ab'.repeat(32)}\n`);
    await assert.rejects(
      () => resolveModuleLabInputs('arquitetura', emptyRoot),
      /FIXTURE_MISSING/,
    );
  } finally {
    await rm(emptyRoot, {recursive: true, force: true});
  }
});

test('heartbeat do gerente não se sobrepõe e propaga falha em voo ao encerrar', async ({mock}) => {
  mock.timers.enable({apis: ['setInterval']});
  const authority = {contextId: randomUUID(), instanceId: randomUUID(), epoch: 1};
  const cause = new Refusal('STALE_MANAGER');
  let rejectHeartbeat!: (reason: unknown) => void;
  const pending = new Promise<void>((_, reject) => {
    rejectHeartbeat = reject;
  });
  const heartbeat = mock.fn(async (received: Authority) => {
    assert.deepEqual(received, authority);
    await pending;
  });
  const stopHeartbeat = keepMainManagerLease({heartbeat}, authority);
  mock.timers.tick(MAIN_MANAGER_HEARTBEAT_MS);
  mock.timers.tick(MAIN_MANAGER_HEARTBEAT_MS);
  assert.equal(heartbeat.mock.callCount(), 1);

  const stopped = stopHeartbeat();
  rejectHeartbeat(cause);
  await assert.rejects(stopped, {cause});
});

test('encerrar heartbeat do gerente cancela novas renovações', async ({mock}) => {
  mock.timers.enable({apis: ['setInterval']});
  const authority = {contextId: randomUUID(), instanceId: randomUUID(), epoch: 1};
  const heartbeat = mock.fn(async () => {});
  const stopHeartbeat = keepMainManagerLease({heartbeat}, authority);
  mock.timers.tick(MAIN_MANAGER_HEARTBEAT_MS);
  await stopHeartbeat();
  mock.timers.tick(MAIN_MANAGER_HEARTBEAT_MS);
  assert.equal(heartbeat.mock.callCount(), 1);
});

test(
  'laboratório ponta a ponta: CLI personal:<modulo>, snapshot Git, imagem real, relatório privado, contexto dedicado e --corrigir idempotente',
  {skip: LAB_ENABLED ? false : 'AC_MODULE_LAB=1 is unset'},
  async () => {
    const databaseUrl = process.env.AC_TEST_DATABASE_URL;
    assert.ok(databaseUrl, 'AC_TEST_DATABASE_URL deve estar definida quando AC_MODULE_LAB=1');

    const modules = resolveSelectedLabModules();
    // Pre-flight fail-fast: missing digest or defective fixture is a hard failure when lab is enabled.
    for (const mod of modules) {
      await resolveModuleLabInputs(mod, REPO_ROOT);
    }

    const database = await isolatedDatabase(databaseUrl, 'vmodclilab');
    const db = new Ledger(database.url);
    const tempRoot = await realpath(await mkdtemp(join(tmpdir(), 'ac-vmod-cli-lab-')));
    try {
      await db.migrate();
      await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");

      for (let idx = 0; idx < modules.length; idx += 1) {
        const mod = modules[idx]!;
        await verifyModuleEndToEnd(db, database.url, tempRoot, mod, idx === 0);
      }
    } finally {
      await db.close();
      await database.close();
      await rm(tempRoot, {recursive: true, force: true});
    }
  },
);
