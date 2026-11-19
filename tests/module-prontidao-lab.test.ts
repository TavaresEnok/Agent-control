import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const enabled = process.env.AC_MODULE_LAB === '1';
const digestPath = fileURLToPath(new URL('../deploy/modules/prontidao/digest.txt', import.meta.url));
const defectiveDir = fileURLToPath(new URL('./fixtures/module-prontidao/defective', import.meta.url));
const cleanDir = fileURLToPath(new URL('./fixtures/module-prontidao/clean', import.meta.url));

const PINNED_DIGEST = /^(?:[a-z0-9.-]+(?::\d+)?\/)?[a-z0-9._/-]+(?::[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}$|^sha256:[a-f0-9]{64}$/;

type CollectorOutput = {
  coverage: {tool: string; version: string; status: 'ok' | 'failed' | 'skipped'; detail: string}[];
  findings: {tool: string; rule: string; file: string; line: number; severity: string; message: string; evidence: string}[];
};

function runContainer(image: string, repoPath: string, extraArgs: string[] = []) {
  return spawnSync('docker', [
    'run', '--rm',
    '--network', 'none',
    '--read-only',
    '--user', '65532:65532',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '256',
    '--memory', '1g',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,mode=1777,size=512m',
    '--mount', `type=bind,src=${repoPath},dst=/repo,readonly`,
    image,
    ...extraArgs,
  ], {encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024});
}

test('laboratório do módulo 6 (prontidao) detecta defeitos plantados e aprova controle limpo', {skip: !enabled}, () => {
  const image = readFileSync(digestPath, 'utf8').trim();
  assert.match(image, PINNED_DIGEST, 'digest.txt deve conter ID ou referência imutável @sha256');

  // 1. Fixture com defeitos plantados
  const defectiveRun = runContainer(image, defectiveDir);
  assert.equal(defectiveRun.status, 0, defectiveRun.stderr);
  const defectiveOut = JSON.parse(defectiveRun.stdout) as CollectorOutput;

  for (const tool of ['prontidao-audit', 'gitleaks', 'hadolint', 'trivy']) {
    const row = defectiveOut.coverage.find(c => c.tool === tool);
    assert.equal(row?.status, 'ok', `ferramenta ${tool} não ficou ok: ${JSON.stringify(row)}`);
  }
  assert.equal(defectiveOut.coverage.find(c => c.tool === 'testssl.sh')?.status, 'skipped');
  assert.ok(defectiveOut.findings.some(f => f.tool === 'gitleaks' && f.file === '.env'));
  assert.ok(defectiveOut.findings.some(f => f.tool === 'hadolint' && f.file === 'Dockerfile'));
  assert.ok(defectiveOut.findings.some(f => f.tool === 'trivy' && f.file === 'Dockerfile'));
  assert.ok(defectiveOut.findings.some(f => f.tool === 'prontidao-audit' && f.rule === 'PRONTIDAO-TLS-DESATIVADO'));
  assert.ok(defectiveOut.findings.some(f => f.tool === 'prontidao-audit' && f.rule === 'PRONTIDAO-BACKUP-AUSENTE'));
  assert.ok(defectiveOut.findings.some(f => f.tool === 'prontidao-audit' && f.rule === 'PRONTIDAO-REINICIO-AUTOMATICO-AUSENTE'));
  assert.equal(defectiveRun.stdout.includes('synthetic-lab-key-9f8e7d6c5b4a3210fedcba9876543210'), false);

  for (const f of defectiveOut.findings) {
    assert.equal(Number.isInteger(f.line) && f.line >= 1, true);
    assert.equal(f.file.startsWith('/') || f.file.includes('..'), false);
    assert.ok(['alta', 'media', 'baixa', 'informativa'].includes(f.severity));
  }

  // 2. Controle limpo
  const cleanRun = runContainer(image, cleanDir);
  assert.equal(cleanRun.status, 0, cleanRun.stderr);
  const cleanOut = JSON.parse(cleanRun.stdout) as CollectorOutput;
  for (const tool of ['prontidao-audit', 'gitleaks', 'hadolint', 'trivy']) {
    const row = cleanOut.coverage.find(c => c.tool === tool);
    assert.equal(row?.status, 'ok', `ferramenta ${tool} não ficou ok no controle limpo: ${JSON.stringify(row)}`);
  }
  assert.deepEqual(cleanOut.findings, []);

  // 3. Recusa argumentos perigosos
  const traversalRun = runContainer(image, cleanDir, ['--target', '../segredo']);
  assert.notEqual(traversalRun.status, 0);
  const sockRun = runContainer(image, cleanDir, ['--target', '/var/run/docker.sock']);
  assert.notEqual(sockRun.status, 0);
});
