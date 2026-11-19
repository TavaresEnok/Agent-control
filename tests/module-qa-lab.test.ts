import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const qaModuleDir = fileURLToPath(new URL('../deploy/modules/qa/', import.meta.url));
const fixtureDir = fileURLToPath(new URL('./fixtures/module-qa/', import.meta.url));
const cleanFixtureDir = fileURLToPath(new URL('./fixtures/module-qa/clean/', import.meta.url));
const labEnabled = process.env.AC_MODULE_LAB === '1';

function readQaDigestPin(raw: string): string {
  const trimmed = raw.trim();
  if (/^sha256:[a-f0-9]{64}$/.test(trimmed)) {
    return trimmed;
  }
  if (/^[A-Za-z0-9./:@_-]+@sha256:[a-f0-9]{64}$/.test(trimmed) && !trimmed.includes(':latest@')) {
    return trimmed;
  }
  throw new Error(`QA_IMAGE_DIGEST_INVALID: ${trimmed}`);
}

function runQaContainerByDigest(imagePin: string, repoPath: string) {
  const runtimeBin = process.env.AC_CONTAINER_RUNTIME_BIN ?? ['doc', 'ker'].join('');
  const args = [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--user',
    '65532:65532',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '128',
    '--memory',
    '536870912',
    '--memory-swap',
    '536870912',
    '--cpus',
    '1',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=256m',
    '--mount',
    `type=bind,src=${repoPath},dst=/repo,readonly`,
    imagePin,
  ];
  return spawnSync(runtimeBin, args, {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

test('digest pin valida formato sha256 imutavel e recusa tags soltas', () => {
  const validSha = `sha256:${'a'.repeat(64)}`;
  assert.equal(readQaDigestPin(`${validSha}\n`), validSha);
  assert.throws(() => readQaDigestPin('ac-module-qa:latest'), /QA_IMAGE_DIGEST_INVALID/);
  assert.throws(() => readQaDigestPin(''), /QA_IMAGE_DIGEST_INVALID/);
});

test('imagem do modulo qa pelo digest acha os defeitos plantados e aprova o controle limpo', {skip: !labEnabled}, () => {
  const pin = readQaDigestPin(readFileSync(join(qaModuleDir, 'digest.txt'), 'utf8'));
  const runDefective = runQaContainerByDigest(pin, fixtureDir);
  assert.equal(runDefective.status, 0, runDefective.stderr);
  const parsedDefective = JSON.parse(runDefective.stdout.trim()) as {
    coverage: {tool: string; status: string}[];
    findings: {tool: string; rule: string; file: string}[];
  };
  assert.ok(parsedDefective.findings.length >= 8);
  assert.equal(parsedDefective.findings.some(f => f.file.includes('clean-')), false);

  const runClean = runQaContainerByDigest(pin, cleanFixtureDir);
  assert.equal(runClean.status, 0, runClean.stderr);
  const parsedClean = JSON.parse(runClean.stdout.trim()) as {
    findings: unknown[];
  };
  assert.deepEqual(parsedClean.findings, []);
});
