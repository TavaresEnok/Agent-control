import assert from 'node:assert/strict';
import {execFile as execFileCb} from 'node:child_process';
import {chmod, cp, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {validateModuleOutput} from '../deploy/modules/dependencias/collect.mjs';

const execFile = promisify(execFileCb);
const enabled = process.env.AC_MODULE_LAB === '1';
const moduleDir = fileURLToPath(new URL('../deploy/modules/dependencias/', import.meta.url));
const digestPath = join(moduleDir, 'digest.txt');
const lockPath = join(moduleDir, 'dependencias-tools.lock.json');
const fixtureDefect = fileURLToPath(new URL('./fixtures/module-dependencias/com-defeito/', import.meta.url));
const fixtureClean = fileURLToPath(new URL('./fixtures/module-dependencias/limpo/', import.meta.url));

async function readPinnedModuleImage() {
  const raw = (await readFile(digestPath, 'utf8')).trim().split(/\s+/)[0] ?? '';
  assert.match(raw, /(?:^|@)sha256:[a-f0-9]{64}$/, `digest.txt inválido ou ausente: ${raw}`);
  return raw;
}

/** Ensures synthetic temp fixtures are traversable/readable by non-root container UID 65532 without following symlinks. */
async function ensureWorldReadableTree(rootDir: string) {
  const info = await lstat(rootDir);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(rootDir, 0o755);
    const entries = await readdir(rootDir);
    for (const entry of entries) {
      await ensureWorldReadableTree(join(rootDir, entry));
    }
    return;
  }
  if (info.isFile()) {
    await chmod(rootDir, 0o644);
  }
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
  const lockMeta = JSON.parse(await readFile(lockPath, 'utf8')) as {
    dependencies: Record<string, {version: string}>;
  };
  const expectedVersions: Record<string, string> = {
    'npm-check-updates': lockMeta.dependencies['npm-check-updates'].version,
    'ast-grep': lockMeta.dependencies['@ast-grep/cli'].version,
    jscodeshift: lockMeta.dependencies.jscodeshift.version,
    'sbom-lockfile': '1.0.0',
  };

  const dirty = await runCollectorContainer(image, fixtureDefect);
  for (const [tool, expectedVer] of Object.entries(expectedVersions)) {
    const row = dirty.coverage.find(c => c.tool === tool);
    assert.ok(row, `Falta cobertura da ferramenta ${tool}`);
    assert.equal(row.status, 'ok', `${tool} falhou: ${row.detail}`);
    assert.equal(row.version, expectedVer, `Versão divergente para ${tool}: ${row.version} != ${expectedVer}`);
  }
  assert.equal(dirty.coverage.some(c => c.status === 'failed'), false);

  assert.equal(
    dirty.findings.some(f => f.tool === 'npm-check-updates' && f.rule === 'NCU-OUTDATED-MAJOR' && f.file === 'package.json' && f.severity === 'baixa' && f.evidence.includes('express')),
    true
  );
  assert.equal(
    dirty.findings.some(f => f.tool === 'npm-check-updates' && f.rule === 'NCU-OUTDATED-MINOR' && f.file === 'package.json' && f.severity === 'informativa' && f.evidence.includes('lodash')),
    true
  );
  assert.equal(
    dirty.findings.some(f => f.tool === 'npm-check-updates' && f.rule === 'NCU-OUTDATED-PATCH' && f.file === 'package.json' && f.severity === 'informativa' && f.evidence.includes('socket.io-client')),
    true
  );
  assert.equal(
    dirty.findings.some(f => f.tool === 'npm-check-updates' && f.rule === 'NCU-UNPINNED-RANGE' && f.evidence.includes('chalk')),
    true
  );
  assert.equal(
    dirty.findings.some(f => f.tool === 'ast-grep' && f.rule === 'ASTGREP-EXPRESS5-APP-DEL' && f.file === 'src/server.ts' && f.evidence.includes('Revisão necessária')),
    true
  );
  assert.equal(
    dirty.findings.some(f => f.tool === 'ast-grep' && f.rule === 'ASTGREP-EXPRESS5-RES-SEND-STATUS' && f.file === 'src/server.ts' && f.evidence.includes('Revisão necessária')),
    true
  );
  assert.equal(
    dirty.findings.some(f => f.tool === 'ast-grep' && f.rule === 'ASTGREP-EXPRESS5-RES-JSON-STATUS' && f.file === 'src/server.ts' && f.evidence.includes('Revisão necessária')),
    true
  );
  assert.equal(
    dirty.findings.some(f => f.tool === 'ast-grep' && f.rule === 'ASTGREP-LODASH4-REMOVED-PLUCK' && f.file === 'src/server.ts' && f.evidence.includes('Revisão necessária')),
    true
  );
  assert.equal(
    dirty.findings.some(f => f.tool === 'jscodeshift' && f.rule === 'JSCODESHIFT-NODE-BUFFER-CTOR' && f.file === 'src/legacy-utils.js' && f.evidence.includes('Revisão necessária')),
    true
  );
  assert.equal(
    dirty.findings.some(f => f.tool === 'jscodeshift' && f.rule === 'JSCODESHIFT-NODE-URL-PARSE' && f.file === 'src/legacy-utils.js' && f.evidence.includes('Revisão necessária')),
    true
  );
  assert.equal(
    dirty.findings.some(f => f.tool === 'jscodeshift' && f.rule === 'JSCODESHIFT-NODE-UTIL-ISARRAY' && f.file === 'src/legacy-utils.js' && f.evidence.includes('Revisão necessária')),
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
  for (const [tool, expectedVer] of Object.entries(expectedVersions)) {
    const row = clean.coverage.find(c => c.tool === tool);
    assert.ok(row, `Falta cobertura da ferramenta ${tool} no controle limpo`);
    assert.equal(row.status, 'ok', `${tool} falhou no controle limpo: ${row.detail}`);
    assert.equal(row.version, expectedVer);
  }
  assert.equal(clean.findings.length, 0);

  const scratch = await mkdtemp(join(tmpdir(), 'dep-lab-sym-'));
  try {
    await cp(fixtureClean, scratch, {recursive: true});
    await symlink('/etc/passwd', join(scratch, 'src', 'symlinked.ts'));
    await ensureWorldReadableTree(scratch);
    const withSymlink = await runCollectorContainer(image, scratch);
    assert.equal(withSymlink.coverage.some(c => c.status === 'failed'), false);
    assert.equal(withSymlink.findings.length, 0);
    assert.equal(withSymlink.coverage.some(c => c.tool === 'repo-guard' && c.detail.includes('symlinks_ignorados=1')), true);
  } finally {
    await rm(scratch, {recursive: true, force: true});
  }

  const mixedScratch = await mkdtemp(join(tmpdir(), 'dep-lab-meta-'));
  try {
    await writeFile(
      join(mixedScratch, 'package.json'),
      JSON.stringify(
        {
          name: 'lab-mixed-metadata',
          version: '1.0.0',
          dependencies: {
            express: '^4.17.1',
            'pacote-sem-metadados-interno': '^1.2.3',
          },
        },
        null,
        2
      )
    );
    const manifest = JSON.parse(await readFile(join(mixedScratch, 'package.json'), 'utf8'));
    await writeFile(join(mixedScratch, 'package-lock.json'), JSON.stringify({
      name: manifest.name, version: manifest.version, lockfileVersion: 3,
      packages: {'': manifest, 'node_modules/express': {version: '4.17.1'},
        'node_modules/pacote-sem-metadados-interno': {version: '1.2.3'}},
    }));
    await writeFile(join(mixedScratch, '.ncurc.js'), 'throw new Error("hostile repo config executed");\n');
    await writeFile(join(mixedScratch, '.ncurc.json'), '{"reject":["express"]}\n');
    await ensureWorldReadableTree(mixedScratch);
    const mixed = await runCollectorContainer(image, mixedScratch);
    assert.equal(mixed.coverage.some(c => c.status === 'failed'), false);
    assert.equal(
      mixed.findings.some(f => f.tool === 'npm-check-updates' && f.rule === 'NCU-OUTDATED-MAJOR' && f.evidence.includes('express')),
      true
    );
    assert.equal(
      mixed.coverage.some(
        c =>
          c.tool === 'npm-check-updates' &&
          c.status === 'skipped' &&
          c.detail.includes('pacote-sem-metadados-interno') &&
          c.detail.includes('ausente_no_registro_offline')
      ),
      true
    );
  } finally {
    await rm(mixedScratch, {recursive: true, force: true});
  }

  const noMetaScratch = await mkdtemp(join(tmpdir(), 'dep-lab-nometa-'));
  try {
    await writeFile(
      join(noMetaScratch, 'package.json'),
      JSON.stringify(
        {
          name: 'lab-only-missing-metadata',
          version: '1.0.0',
          dependencies: {
            'pacote-sem-metadados-a': '^1.0.0',
          },
        },
        null,
        2
      )
    );
    await ensureWorldReadableTree(noMetaScratch);
    const noMeta = await runCollectorContainer(image, noMetaScratch);
    assert.equal(noMeta.coverage.some(c => c.status === 'failed'), false);
    const ncuSummary = noMeta.coverage.find(c => c.tool === 'npm-check-updates');
    assert.ok(ncuSummary);
    assert.equal(ncuSummary.status, 'skipped');
    assert.equal(ncuSummary.detail.includes('sem_metadados=1'), true);
    assert.equal(ncuSummary.detail.includes('nenhuma_dependencia_no_registro_offline'), true);
  } finally {
    await rm(noMetaScratch, {recursive: true, force: true});
  }
});

test('imagem de dependências aplica a receita de charset do OpenRewrite e mede o controle corrigido', {skip: !enabled}, async t => {
  const image = await readPinnedModuleImage();
  const dir = await mkdtemp(join(tmpdir(), 'ac-dependencias-java-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  await chmod(dir, 0o755);
  const file = 'Demo.java';
  const oldCall = 'java.nio.charset.Charset.forName("UTF-8")';
  const newValue = 'java.nio.charset.StandardCharsets.UTF_8';
  const source = 'class Demo {\n  java.nio.charset.Charset encoding() { return ' + oldCall + '; }\n}\n';
  await writeFile(join(dir, file), source, {mode: 0o644});
  const first = await runCollectorContainer(image, dir);
  const finding = first.findings.find(row => row.tool === 'openrewrite' && row.file === file);
  assert.equal(finding?.rule, 'charset-standard-utf8');
  assert.equal(finding.line, 2);
  assert.ok(first.coverage.some(row => row.tool === 'openrewrite' && row.status === 'ok' && row.detail.includes('achados=1')));
  assert.equal(await readFile(join(dir, file), 'utf8'), source);
  await writeFile(join(dir, file), source.replace(oldCall, newValue));
  const control = await runCollectorContainer(image, dir);
  assert.equal(control.findings.some(row => row.tool === 'openrewrite'), false);
  assert.ok(control.coverage.some(row => row.tool === 'openrewrite' && row.status === 'ok' && row.detail.includes('achados=0')));
});
