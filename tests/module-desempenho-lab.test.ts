import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

type CollectorOutput = {
  coverage: {tool: string; version: string; status: 'ok' | 'failed' | 'skipped'; detail: string; files?: string[]}[];
  findings: {tool: string; rule: string; file: string; line: number; evidence: string}[];
};
type SnapshotModule = {
  prepareModuleSnapshot(repo: string, commit: string): Promise<string>;
  removeModuleSnapshot(snapshot: string): Promise<void>;
};
type PerformanceModule = {
  runPerformanceModule(input: {snapshotPath: string; imageDigest: string; recoveryDirectory: string}): Promise<CollectorOutput>;
};

// A rotina de produção aciona 'docker' indiretamente. O laboratório exige opt-in.
const enabled = process.env.AC_MODULE_LAB === '1';
const root = new URL('./fixtures/module-desempenho/', import.meta.url);
const moduleRoot = new URL('../deploy/modules/desempenho/', import.meta.url);
const run = promisify(execFile);
const toolNames = ['lighthouse-ci', 'k6', 'node-cpu-prof', 'pg_stat_statements'];

async function measure(fixture?: 'defective' | 'clean', staticOnly = false) {
  const {prepareModuleSnapshot, removeModuleSnapshot} =
    await import(new URL('../src/verification-modules.ts', import.meta.url).href) as SnapshotModule;
  const {runPerformanceModule} = await import(new URL('orchestrator.mjs', moduleRoot).href) as PerformanceModule;
  const imageDigest = (await readFile(new URL('digest.txt', moduleRoot), 'utf8')).trim();
  const temp = await mkdtemp(join(tmpdir(), 'ac-perf-lab-source-'));
  const repo = join(temp, 'repo');
  try {
    if (fixture) await cp(fileURLToPath(new URL(fixture, root)), repo, {recursive: true});
    else await mkdir(repo);
    if (staticOnly) {
      const file = join(repo, 'desempenho.config.json');
      const config = JSON.parse(await readFile(file, 'utf8'));
      config.server.entry = 'backend-ausente.mjs';
      await writeFile(file, JSON.stringify(config));
    }
    const git = async (args: string[]) => (await run('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: repo,
      env: {PATH: '/usr/local/bin:/usr/bin:/bin', HOME: temp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'},
      timeout: 15_000,
    })).stdout.trim();
    await git(['init', '-q']);
    await git(['add', '.']);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture sintética', '--allow-empty']);
    const snapshotPath = await prepareModuleSnapshot(repo, await git(['rev-parse', 'HEAD']));
    try { return await runPerformanceModule({snapshotPath, imageDigest, recoveryDirectory: join(temp, 'recuperacao')}); }
    finally { await removeModuleSnapshot(snapshotPath); }
  } finally { await rm(temp, {recursive: true, force: true}); }
}

async function sourceLine(fixture: string, file: string, marker: RegExp) {
  const lines = (await readFile(new URL(`${fixture}/${file}`, root), 'utf8')).split(/\r?\n/);
  const index = lines.findIndex(line => marker.test(line));
  assert.ok(index >= 0, `marcador ausente em ${fixture}/${file}`);
  return index + 1;
}

function expectStatus(output: CollectorOutput, tool: string, status: 'ok' | 'failed' | 'skipped') {
  const row = output.coverage.find(entry => entry.tool === tool);
  assert.equal(row?.status, status, `${tool}: ${JSON.stringify(output.coverage)}`);
}

function expectMeasurement(output: CollectorOutput, tool: string, file: string, evidence: RegExp) {
  assert.ok(output.coverage.some(row => row.tool === tool && row.status === 'ok'
    && row.files?.includes(file) && evidence.test(row.detail)), JSON.stringify(output.coverage));
}

test('laboratório real: rotina local mede as quatro ferramentas no defeito e no controle', {skip: !enabled}, async () => {
  const defect = await measure('defective');
  const clean = await measure('clean');
  for (const [name, output, fn, query] of [
    ['defective', defect, 'computeHeavyReport', 'queries/lenta.sql'],
    ['clean', clean, 'computeCachedReport', 'queries/rapida.sql'],
  ] as const) {
    for (const tool of toolNames) expectStatus(output, tool, 'ok');
    expectStatus(output, 'isolamento-http', 'ok');
    expectMeasurement(output, 'lighthouse-ci:rota:/', 'public/index.html', /score=.*LCP=.*CLS=.*TBT=/);
    expectMeasurement(output, 'k6:rota:/api/relatorio', 'server.mjs', /requisições=3; p95=[\d.]+ms; falhas=0\.00%/);
    const cpuLine = await sourceLine(name, 'server.mjs', new RegExp(`^function ${fn}\\(`));
    expectMeasurement(output, 'node-cpu-prof:arquivo', 'server.mjs',
      new RegExp(`arquivo=server\\.mjs:${cpuLine}; função=${fn}.*amostras próprias=\\d+/[1-9]\\d*`));
    const sqlLine = await sourceLine(name, query, /^SELECT\b/);
    expectMeasurement(output, 'pg_stat_statements:consulta', query,
      new RegExp(`:${sqlLine}; .*queryid=-?\\d+; antes=0 chamadas/.*depois=3 chamadas/`));
  }
  assert.ok(defect.findings.some(f => f.tool === 'lighthouse-ci'
    && ['LH-CLS-SHIFT', 'LH-TBT-BLOCKING'].includes(f.rule) && f.file === 'public/index.html' && f.evidence.includes('rota=/ ')),
  JSON.stringify(defect.findings));
  const declaredRoute = await sourceLine('defective', 'desempenho.config.json', /"path": "\/api\/relatorio"/);
  assert.ok(defect.findings.some(f => f.tool === 'k6' && f.rule === 'K6-THRESHOLD-LATENCY-P95'
    && f.file === 'desempenho.config.json' && f.line === declaredRoute && f.evidence.includes('rota=/api/relatorio ')), JSON.stringify(defect.findings));
  const cpuLine = await sourceLine('defective', 'server.mjs', /^function computeHeavyReport\(/);
  assert.ok(defect.findings.some(f => f.rule === 'CPU-PROF-HOTSPOT' && f.file === 'server.mjs' && f.line === cpuLine));
  const sqlLine = await sourceLine('defective', 'queries/lenta.sql', /^SELECT\b/);
  assert.ok(defect.findings.some(f => ['PG-QUERY-SLOW-MEAN', 'PG-QUERY-SLOW-MAX'].includes(f.rule)
    && f.file === 'queries/lenta.sql' && f.line === sqlLine), JSON.stringify(defect.findings));
  assert.deepEqual(clean.findings, []);
});

test('laboratório real: sem backend, mede somente o recorte HTTP estático e preserva CPU e SQL', {skip: !enabled}, async () => {
  const output = await measure('clean', true);
  expectStatus(output, 'isolamento-http', 'failed');
  expectStatus(output, 'servidor-isolado', 'failed');
  expectStatus(output, 'recorte-http-estatico', 'ok');
  for (const tool of toolNames) expectStatus(output, tool, 'ok');
  expectMeasurement(output, 'lighthouse-ci:rota:/', 'public/index.html', /LCP=/);
  expectMeasurement(output, 'k6:rota:/', 'public/index.html', /requisições=3/);
  assert.ok(!output.coverage.some(row => row.tool === 'k6:rota:/api/relatorio'));
  assert.deepEqual(output.findings, []);
});

test('laboratório real: snapshot vazio registra omissões nas quatro ferramentas', {skip: !enabled}, async () => {
  const output = await measure();
  for (const tool of toolNames) expectStatus(output, tool, 'skipped');
  assert.deepEqual(output.findings, []);
});
