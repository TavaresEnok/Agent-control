import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmod, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

type CollectorOutput = {
  coverage: {tool: string; version: string; status: 'ok' | 'failed' | 'skipped'; detail: string}[];
  findings: {
    tool: string;
    rule: string;
    file: string;
    line: number;
    severity: 'alta' | 'media' | 'baixa' | 'informativa';
    message: string;
    evidence: string;
  }[];
};

const enabled = process.env.AC_MODULE_LAB === '1';
const defectiveDir = fileURLToPath(new URL('./fixtures/module-desempenho/defective/', import.meta.url));
const cleanDir = fileURLToPath(new URL('./fixtures/module-desempenho/clean/', import.meta.url));
const digestPath = fileURLToPath(new URL('../deploy/modules/desempenho/digest.txt', import.meta.url));

export function parsePinnedModuleDigest(raw: string): string {
  const value = raw.trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (!value || value.includes('..') || /\s/.test(value) || /(^|[/:])latest($|@)/i.test(value)) {
    throw new Error(`Digest inválido em deploy/modules/desempenho/digest.txt: ${value}`);
  }
  if (/^(?:[a-z0-9._/:-]+@)?sha256:[a-f0-9]{64}$/.test(value)) {
    return value;
  }
  throw new Error(`Digest não fixado em deploy/modules/desempenho/digest.txt: ${value}`);
}

function runCollectorContainer(image: string, repoPath: string): CollectorOutput {
  const res = spawnSync(
    'docker',
    [
      'run', '--rm',
      '--network', 'none',
      '--read-only',
      '--user', '65532:65532',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '256',
      '--memory', '2g',
      '--memory-swap', '2g',
      '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1g',
      '--mount', `type=bind,src=${repoPath},dst=/repo,readonly`,
      image,
    ],
    {encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024},
  );
  assert.equal(res.status, 0, `Contêiner falhou (exit=${res.status}):\nstderr=${res.stderr}\nstdout=${res.stdout}`);
  const parsed = JSON.parse(res.stdout.trim()) as CollectorOutput;
  assert.ok(Array.isArray(parsed.coverage));
  assert.ok(Array.isArray(parsed.findings));
  for (const row of parsed.coverage) {
    assert.ok(['ok', 'failed', 'skipped'].includes(row.status), JSON.stringify(row));
    assert.ok(row.tool.length > 0 && row.version.length > 0 && row.detail.length > 0, JSON.stringify(row));
  }
  for (const item of parsed.findings) {
    assert.ok(['alta', 'media', 'baixa', 'informativa'].includes(item.severity), JSON.stringify(item));
    assert.ok(Number.isInteger(item.line) && item.line >= 1, JSON.stringify(item));
    assert.ok(!item.file.startsWith('/') && !item.file.includes('..') && item.file.length > 0, JSON.stringify(item));
  }
  return parsed;
}

test('laboratório real: imagem detecta defeitos plantados na fixture defeituosa e zera no controle limpo', {skip: !enabled}, async () => {
  const image = parsePinnedModuleDigest(await readFile(digestPath, 'utf8'));

  const defectiveOut = runCollectorContainer(image, defectiveDir);
  for (const tool of ['lighthouse-ci', 'k6', 'node-cpu-prof', 'pg_stat_statements']) {
    const row = defectiveOut.coverage.find(c => c.tool === tool);
    assert.ok(row, `Falta cobertura de ${tool}`);
    assert.equal(row.status, 'ok', `${tool} não executou ok: ${row.detail}`);
  }
  // Linhas adicionais por rota/arquivo/consulta
  assert.ok(defectiveOut.coverage.some(c => c.tool.startsWith('lighthouse-ci:rota:')));
  assert.ok(defectiveOut.coverage.some(c => c.tool.startsWith('k6:rota:')));
  assert.ok(defectiveOut.coverage.some(c => c.tool.startsWith('node-cpu-prof:arquivo:')));
  assert.ok(defectiveOut.coverage.some(c => c.tool.startsWith('pg_stat_statements:consulta:')));

  assert.ok(
    defectiveOut.findings.some(f => f.tool === 'lighthouse-ci' && (f.rule === 'LH-CLS-SHIFT' || f.rule === 'LH-TBT-BLOCKING') && f.file === 'public/index.html'),
    JSON.stringify(defectiveOut.findings, null, 2),
  );
  assert.ok(
    defectiveOut.findings.some(f => f.tool === 'k6' && f.rule === 'K6-THRESHOLD-LATENCY-P95' && f.file === 'server.mjs'),
    JSON.stringify(defectiveOut.findings, null, 2),
  );
  assert.ok(
    defectiveOut.findings.some(f => f.tool === 'node-cpu-prof' && f.rule === 'CPU-PROF-HOTSPOT' && f.file === 'server.mjs'),
    JSON.stringify(defectiveOut.findings, null, 2),
  );
  assert.ok(
    defectiveOut.findings.some(f => f.tool === 'pg_stat_statements' && (f.rule === 'PG-QUERY-SLOW-MEAN' || f.rule === 'PG-QUERY-SLOW-MAX') && f.file === 'queries/lenta.sql'),
    JSON.stringify(defectiveOut.findings, null, 2),
  );

  const cleanOut = runCollectorContainer(image, cleanDir);
  for (const tool of ['lighthouse-ci', 'k6', 'node-cpu-prof', 'pg_stat_statements']) {
    const row = cleanOut.coverage.find(c => c.tool === tool);
    assert.ok(row, `Falta cobertura de ${tool} no controle limpo`);
    assert.equal(row.status, 'ok', `${tool} falhou no controle limpo: ${row.detail}`);
  }
  assert.equal(cleanOut.findings.length, 0, `Controle limpo acusou defeitos inesperados: ${JSON.stringify(cleanOut.findings, null, 2)}`);

  const emptyRepo = await mkdtemp(join(tmpdir(), 'perf-empty-repo-'));
  try {
    await chmod(emptyRepo, 0o755);
    const emptyOut = runCollectorContainer(image, emptyRepo);
    for (const tool of ['lighthouse-ci', 'k6', 'node-cpu-prof', 'pg_stat_statements']) {
      const row = emptyOut.coverage.find(c => c.tool === tool);
      assert.ok(row);
      assert.equal(row.status, 'skipped', `${tool} deveria ficar skipped em repo vazio: ${JSON.stringify(row)}`);
    }
    assert.equal(emptyOut.findings.length, 0);
  } finally {
    await rm(emptyRepo, {recursive: true, force: true});
  }
});
