import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const enabled = process.env.AC_MODULE_LAB === '1';
const digestPath = fileURLToPath(new URL('../deploy/modules/arquitetura/digest.txt', import.meta.url));
const defectiveFixture = fileURLToPath(new URL('./fixtures/module-arquitetura/defective/', import.meta.url));
const cleanFixture = fileURLToPath(new URL('./fixtures/module-arquitetura/clean/', import.meta.url));

const SHA_ONLY = /^sha256:[a-f0-9]{64}$/i;
const PINNED_REF = /^[a-z0-9._:/-]+@sha256:[a-f0-9]{64}$/i;

function readPinnedImage(): string {
  const raw = readFileSync(digestPath, 'utf8').trim().split(/\s+/u)[0] ?? '';
  if (SHA_ONLY.test(raw) || PINNED_REF.test(raw)) return raw;
  throw new Error(`Digest inválido ou ausente em deploy/modules/arquitetura/digest.txt: "${raw}"`);
}

function runInContainer(image: string, repoPath: string, network: 'none' | 'bridge' = 'none') {
  return spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      network,
      '--read-only',
      '--user',
      '65532:65532',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '256',
      '--memory',
      '1073741824',
      '--cpus',
      '1',
      '--tmpfs',
      '/tmp:rw,exec,nosuid,nodev,mode=1777,size=512m',
      '--mount',
      `type=bind,src=${repoPath},dst=/repo,readonly`,
      image,
    ],
    {encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024},
  );
}

type CollectorOutput = {
  coverage: {tool: string; version: string; status: string; detail: string}[];
  findings: {tool: string; rule: string; file: string; line: number; severity: string; message: string; evidence: string}[];
};

function assertSchema(out: CollectorOutput): void {
  assert.equal(Array.isArray(out.coverage), true);
  assert.equal(Array.isArray(out.findings), true);
  for (const tool of ['knip', 'ast-complexity', 'jscpd', 'dependency-cruiser']) {
    const row = out.coverage.find(c => c.tool === tool);
    assert.ok(row, `ferramenta ausente na cobertura: ${tool}`);
    assert.equal(row.status, 'ok', `${tool} falhou: ${row.detail}`);
    assert.ok(row.version && row.version !== 'desconhecida', `versão ausente para ${tool}`);
    assert.ok(row.detail.length > 0);
  }
  for (const f of out.findings) {
    assert.equal(typeof f.file, 'string');
    assert.ok(f.file.length > 0 && !f.file.startsWith('/') && !f.file.split('/').includes('..'), f.file);
    assert.equal(Number.isInteger(f.line) && f.line >= 1, true, `${f.rule} linha=${f.line}`);
    assert.equal(['alta', 'media', 'baixa', 'informativa'].includes(f.severity), true, f.severity);
  }
}

test('laboratório módulo 3 encontra os defeitos plantados e não acusa o controle limpo', {skip: !enabled}, () => {
  const image = readPinnedImage();

  const defectiveRun = runInContainer(image, defectiveFixture, 'none');
  assert.equal(defectiveRun.status, 0, `${defectiveRun.stdout ?? ''}\n${defectiveRun.stderr ?? ''}`);
  const defectiveOut = JSON.parse(defectiveRun.stdout.trim()) as CollectorOutput;
  assertSchema(defectiveOut);

  const has = (rule: string, filePart?: string) =>
    defectiveOut.findings.some(f => f.rule === rule && (!filePart || f.file.includes(filePart)));

  assert.equal(has('KNIP-UNUSED-FILE', 'src/legacy-dead.ts'), true);
  assert.equal(has('KNIP-UNUSED-EXPORT', 'src/shared/format.ts'), true);
  assert.equal(has('JSCPD-DUPLICATION', 'billing-'), true);
  assert.equal(has('DEPCRUISE-NO-CIRCULAR', 'cycle-'), true);
  assert.equal(has('DEPCRUISE-LAYER-DOMAIN-TO-PRESENTATION', 'src/domain/order.ts'), true);
  assert.equal(has('DEPCRUISE-LAYER-DOMAIN-TO-INFRA', 'src/domain/order.ts'), true);
  assert.equal(has('COMPLEXITY-CYCLOMATIC-HIGH', 'src/services/complex-engine.ts'), true);
  assert.equal(has('COMPLEXITY-NESTING-DEEP', 'src/services/complex-engine.ts'), true);

  assert.equal(defectiveOut.coverage.some(c => c.tool === 'knip:file'), true);
  assert.equal(defectiveOut.coverage.some(c => c.tool === 'jscpd:file'), true);
  assert.equal(defectiveOut.coverage.some(c => c.tool === 'dependency-cruiser:file'), true);
  assert.equal(defectiveOut.coverage.some(c => c.tool === 'ast-complexity:file'), true);

  const cleanRun = runInContainer(image, cleanFixture, 'none');
  assert.equal(cleanRun.status, 0, `${cleanRun.stdout ?? ''}\n${cleanRun.stderr ?? ''}`);
  const cleanOut = JSON.parse(cleanRun.stdout.trim()) as CollectorOutput;
  assertSchema(cleanOut);
  assert.equal(cleanOut.findings.length, 0, `controle limpo acusou achados: ${JSON.stringify(cleanOut.findings)}`);

  // Prova de segurança: rede ativa é recusada e configs maliciosas no repo não executam
  const netRefusal = runInContainer(image, cleanFixture, 'bridge');
  assert.equal(netRefusal.status, 78);
  assert.match(netRefusal.stderr ?? '', /ARQUITETURA_NETWORK_FORBIDDEN/);

  const untrustedRepo = mkdtempSync(join(tmpdir(), 'arch-untrusted-'));
  try {
    cpSync(cleanFixture, untrustedRepo, {recursive: true});
    writeFileSync(
      join(untrustedRepo, 'vite.config.ts'),
      "import {writeFileSync} from 'node:fs';\nwriteFileSync('/tmp/pwned-vite.txt', '1');\nexport default {};\n",
    );
    writeFileSync(
      join(untrustedRepo, 'knip.ts'),
      "import {writeFileSync} from 'node:fs';\nwriteFileSync('/tmp/pwned-knip.txt', '1');\nexport default {};\n",
    );
    writeFileSync(
      join(untrustedRepo, '.dependency-cruiser.js'),
      "require('node:fs').writeFileSync('/tmp/pwned-depcruise.txt', '1');\nmodule.exports = {};\n",
    );
    writeFileSync(
      join(untrustedRepo, 'package.json'),
      JSON.stringify({name: 'untrusted', version: '1.0.0', type: 'module', main: 'src/index.ts', devDependencies: {vite: '6.0.0'}}),
    );
    const untrustedRun = runInContainer(image, untrustedRepo, 'none');
    assert.equal(untrustedRun.status, 0, untrustedRun.stderr ?? '');
    const untrustedOut = JSON.parse(untrustedRun.stdout.trim()) as CollectorOutput;
    assertSchema(untrustedOut);
  } finally {
    rmSync(untrustedRepo, {recursive: true, force: true});
  }
});
