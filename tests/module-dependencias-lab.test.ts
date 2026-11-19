import assert from 'node:assert/strict';
import {execFile as execFileCb} from 'node:child_process';
import {cp, mkdtemp, readFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {validateModuleOutput} from '../deploy/modules/dependencias/collect.mjs';

const execFile = promisify(execFileCb);
const enabled = process.env.AC_MODULE_LAB === '1';
const digestPath = fileURLToPath(new URL('../deploy/modules/dependencias/digest.txt', import.meta.url));
const fixtureDefect = fileURLToPath(new URL('./fixtures/module-dependencias/com-defeito/', import.meta.url));
const fixtureClean = fileURLToPath(new URL('./fixtures/module-dependencias/limpo/', import.meta.url));

async function readPinnedModuleImage() {
  const raw = (await readFile(digestPath, 'utf8')).trim().split(/\s+/)[0] ?? '';
  assert.match(raw, /(?:^|@)sha256:[a-f0-9]{64}$/, `digest.txt inválido ou ausente: ${raw}`);
  return raw;
}

async function runCollectorContainer(image: string, repoPath: string) {
  const {stdout} = await execFile(
    'docker',
    [
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
      '256',
      '--memory',
      '1073741824',
      '--memory-swap',
      '1073741824',
      '--tmpfs',
      '/tmp:rw,exec,nosuid,nodev,mode=1777,size=512m',
      '--env',
      'GH_TOKEN=should-be-unset',
      '--env',
      'NPM_TOKEN=should-be-unset',
      '--mount',
      `type=bind,src=${repoPath},dst=/repo,readonly`,
      image,
    ],
    {timeout: 120_000, maxBuffer: 10 * 1024 * 1024}
  );
  const parsed = JSON.parse(stdout.trim()) as {
    coverage: {tool: string; version: string; status: string; detail: string}[];
    findings: {tool: string; rule: string; file: string; line: number; severity: string; message: string; evidence: string}[];
  };
  validateModuleOutput(parsed);
  return parsed;
}

test('laboratório real do módulo dependencias acha defeitos plantados e aprova controle limpo', {skip: !enabled}, async () => {
  const image = await readPinnedModuleImage();

  const dirty = await runCollectorContainer(image, fixtureDefect);
  for (const tool of ['npm-check-updates', 'ast-grep', 'jscodeshift', 'sbom-lockfile']) {
    const row = dirty.coverage.find(c => c.tool === tool);
    assert.ok(row, `Falta cobertura da ferramenta ${tool}`);
    assert.equal(row.status, 'ok', `${tool} falhou: ${row.detail}`);
  }
  assert.equal(dirty.coverage.some(c => c.status === 'failed'), false);

  assert.equal(
    dirty.findings.some(f => f.tool === 'npm-check-updates' && f.rule === 'NCU-OUTDATED-MAJOR' && f.file === 'package.json' && f.severity === 'alta' && f.evidence.includes('express')),
    true
  );
  assert.equal(
    dirty.findings.some(f => f.tool === 'npm-check-updates' && f.rule === 'NCU-OUTDATED-MINOR' && f.file === 'package.json' && f.severity === 'media' && f.evidence.includes('lodash')),
    true
  );
  assert.equal(
    dirty.findings.some(f => f.tool === 'npm-check-updates' && f.rule === 'NCU-OUTDATED-PATCH' && f.file === 'package.json' && f.severity === 'baixa' && f.evidence.includes('socket.io-client')),
    true
  );
  assert.equal(
    dirty.findings.some(f => f.tool === 'npm-check-updates' && f.rule === 'NCU-UNPINNED-RANGE' && f.evidence.includes('chalk')),
    true
  );
  assert.equal(
    dirty.findings.some(f => f.tool === 'ast-grep' && f.rule === 'ASTGREP-EXPRESS5-APP-DEL' && f.file === 'src/server.ts' && f.evidence.includes('app.delete')),
    true
  );
  assert.equal(
    dirty.findings.some(f => f.tool === 'ast-grep' && f.rule === 'ASTGREP-EXPRESS5-RES-SEND-STATUS' && f.file === 'src/server.ts' && f.evidence.includes('res.status(200).send')),
    true
  );
  assert.equal(
    dirty.findings.some(f => f.tool === 'ast-grep' && f.rule === 'ASTGREP-LODASH4-REMOVED-PLUCK' && f.file === 'src/server.ts' && f.evidence.includes('_.map')),
    true
  );
  assert.equal(
    dirty.findings.some(f => f.tool === 'jscodeshift' && f.rule === 'JSCODESHIFT-NODE-BUFFER-CTOR' && f.file === 'src/legacy-utils.js' && f.evidence.includes('Buffer.from')),
    true
  );
  assert.equal(
    dirty.findings.some(f => f.tool === 'jscodeshift' && f.rule === 'JSCODESHIFT-NODE-URL-PARSE' && f.file === 'src/legacy-utils.js' && f.evidence.includes('new URL')),
    true
  );
  assert.equal(
    dirty.findings.some(f => f.tool === 'jscodeshift' && f.rule === 'JSCODESHIFT-NODE-UTIL-ISARRAY' && f.file === 'src/legacy-utils.js' && f.evidence.includes('Array.isArray')),
    true
  );
  assert.equal(
    dirty.findings.some(f => f.tool === 'sbom-lockfile' && f.rule === 'LOCKFILE-DRIFT' && f.evidence.includes('chalk')),
    true
  );
  assert.equal(
    dirty.findings.some(f => f.tool === 'sbom-lockfile' && f.rule === 'SBOM-OUTDATED-COMPONENT' && f.evidence.includes('axios@0.21.1')),
    true
  );
  assert.equal(dirty.findings.some(f => f.evidence.includes('ws.send')), false);

  const clean = await runCollectorContainer(image, fixtureClean);
  for (const tool of ['npm-check-updates', 'ast-grep', 'jscodeshift', 'sbom-lockfile']) {
    const row = clean.coverage.find(c => c.tool === tool);
    assert.ok(row, `Falta cobertura da ferramenta ${tool} no controle limpo`);
    assert.equal(row.status, 'ok', `${tool} falhou no controle limpo: ${row.detail}`);
  }
  assert.equal(clean.findings.length, 0);

  const scratch = await mkdtemp(join(tmpdir(), 'dep-lab-sym-'));
  try {
    await cp(fixtureClean, scratch, {recursive: true});
    await symlink('/etc/passwd', join(scratch, 'src', 'symlinked.ts'));
    const withSymlink = await runCollectorContainer(image, scratch);
    assert.equal(withSymlink.findings.length, 0);
    assert.equal(withSymlink.coverage.some(c => c.tool === 'repo-guard' && c.detail.includes('symlinks_ignorados=1')), true);
  } finally {
    await rm(scratch, {recursive: true, force: true});
  }
});
