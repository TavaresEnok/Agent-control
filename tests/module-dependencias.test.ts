import assert from 'node:assert/strict';
import {execFile as execFileCb} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {
  analyzeLockfileAndSbom,
  classifySemverRisk,
  discoverRepoFiles,
  findLineInPackageJson,
  parseAstGrepJson,
  runCollection,
  satisfiesRange,
  toRepoRelPath,
  validateModuleOutput,
} from '../deploy/modules/dependencias/collect.mjs';

const execFile = promisify(execFileCb);
const require = createRequire(import.meta.url);

const moduleDir = fileURLToPath(new URL('../deploy/modules/dependencias/', import.meta.url));
const fixtureDefect = fileURLToPath(new URL('./fixtures/module-dependencias/com-defeito/', import.meta.url));
const fixtureClean = fileURLToPath(new URL('./fixtures/module-dependencias/limpo/', import.meta.url));

test('Dockerfile e lockfiles do módulo dependencias são imutáveis e sem usuário root final', async () => {
  const dockerfile = await readFile(join(moduleDir, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^FROM\s+node@sha256:[a-f0-9]{64}/m);
  assert.doesNotMatch(dockerfile, /:latest\b/i);
  assert.match(dockerfile, /\bUSER\s+65532:65532\b/);
  assert.match(dockerfile, /\bENTRYPOINT\s+\["\/usr\/local\/bin\/dependencias-entrypoint\.sh"\]/);
  assert.match(dockerfile, /verify-lock\.mjs/);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);

  const lockMeta = JSON.parse(await readFile(join(moduleDir, 'dependencias-tools.lock.json'), 'utf8')) as {
    packageLockSha256: string;
    offlineRegistrySha256: string;
    dependencies: Record<string, {version: string; integrity: string; resolved: string}>;
  };
  const npmLockBytes = await readFile(join(moduleDir, 'package-lock.json'));
  const regBytes = await readFile(join(moduleDir, 'offline-registry.json'));
  assert.equal(createHash('sha256').update(npmLockBytes).digest('hex'), lockMeta.packageLockSha256);
  assert.equal(createHash('sha256').update(regBytes).digest('hex'), lockMeta.offlineRegistrySha256);

  const npmLock = JSON.parse(npmLockBytes.toString('utf8')) as {
    packages: Record<string, {version: string; integrity: string; resolved: string}>;
  };
  for (const [name, expected] of Object.entries(lockMeta.dependencies)) {
    const actual = npmLock.packages[`node_modules/${name}`];
    assert.ok(actual, `Falta entrada em package-lock.json para ${name}`);
    assert.equal(actual.version, expected.version);
    assert.equal(actual.integrity, expected.integrity);
    assert.equal(actual.resolved, expected.resolved);
  }
});

test('entrypoint endurecido recusa travessia, sockets e limpa tokens do ambiente', async () => {
  const entrypointPath = join(moduleDir, 'entrypoint.sh');
  const entrypoint = await readFile(entrypointPath, 'utf8');
  assert.match(entrypoint, /unset\s+"\$name"/);
  assert.match(entrypoint, /GH_TOKEN/);
  assert.match(entrypoint, /NPM_TOKEN/);
  assert.match(entrypoint, /ANTHROPIC_API_KEY/);
  assert.match(entrypoint, /DEPENDENCIAS_PATH_FORBIDDEN/);
  assert.match(entrypoint, /DEPENDENCIAS_SOCKET_FORBIDDEN/);
  assert.match(entrypoint, /DEPENDENCIAS_REPO_MISSING/);

  for (const [arg, expectedErr] of [
    ['../etc', 'DEPENDENCIAS_PATH_FORBIDDEN'],
    ['/var/run/docker.sock', 'DEPENDENCIAS_SOCKET_FORBIDDEN'],
  ]) {
    await assert.rejects(
      () => execFile(entrypointPath, [arg], {env: {...process.env, AC_MODULE_REPO: fixtureClean}}),
      (err: unknown) => {
        const e = err as {code?: number; stderr?: string};
        return e.code === 78 && typeof e.stderr === 'string' && e.stderr.includes(expectedErr);
      }
    );
  }
});

test('regras ast-grep têm IDs únicos e codemod jscodeshift carrega sem erro', async () => {
  const rulesDir = join(moduleDir, 'rules');
  const entries = (await readdir(rulesDir)).filter(name => name.endsWith('.yml')).sort();
  assert.equal(entries.length, 10);
  const ids = new Set<string>();
  for (const name of entries) {
    const content = await readFile(join(rulesDir, name), 'utf8');
    const idMatch = /^id:\s*([A-Za-z0-9_-]+)\s*$/m.exec(content);
    assert.ok(idMatch, `Falta id em ${name}`);
    assert.equal(ids.has(idMatch[1]), false, `ID duplicado em ${name}: ${idMatch[1]}`);
    ids.add(idMatch[1]);
    assert.match(content, /^language:\s+(TypeScript|JavaScript)\s*$/m);
    assert.match(content, /^severity:\s+(error|warning|info|hint)\s*$/m);
    assert.match(content, /^fix:\s+/m);
  }
  const transform = require(join(moduleDir, 'codemods', 'upgrade-rewrites.cjs'));
  assert.equal(typeof transform, 'function');
});

test('helpers de semver, linha em package.json, caminhos e parse do ast-grep', () => {
  assert.equal(classifySemverRisk('^4.17.1', '^5.3.0').severity, 'alta');
  assert.equal(classifySemverRisk('^4.17.15', '^4.18.1').severity, 'media');
  assert.equal(classifySemverRisk('^4.8.3', '^4.8.4').severity, 'baixa');
  assert.equal(satisfiesRange('4.17.1', '^4.17.1'), true);
  assert.equal(satisfiesRange('5.0.0', '^4.17.1'), false);
  assert.equal(satisfiesRange('4.13.19', '^4.13.0'), true);
  assert.equal(toRepoRelPath('/src/app.ts'), 'src/app.ts');
  assert.equal(toRepoRelPath('../segredo.txt', 'fallback.json'), 'fallback.json');

  const pkgText = [
    '{',
    '  "name": "app",',
    '  "dependencies": {',
    '    "express": "^4.17.1",',
    '    "lodash": "^4.17.15"',
    '  },',
    '  "devDependencies": {',
    '    "lodash": "^4.17.21"',
    '  }',
    '}',
  ].join('\n');
  assert.equal(findLineInPackageJson(pkgText, 'express', 'dependencies'), 4);
  assert.equal(findLineInPackageJson(pkgText, 'lodash', 'dependencies'), 5);
  assert.equal(findLineInPackageJson(pkgText, 'lodash', 'devDependencies'), 8);

  const parsed = parseAstGrepJson(
    JSON.stringify([
      {
        ruleId: 'express5-res-send-status-ts',
        severity: 'error',
        message: 'res.send(status, body) removido',
        file: '/tmp/work/src/src/server.ts',
        range: {start: {line: 2, column: 4}},
        text: 'res.send(200, {ok: true})',
        replacement: 'res.status(200).send({ok: true})',
      },
    ]),
    '/tmp/work/src'
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].file, 'src/server.ts');
  assert.equal(parsed[0].line, 3);
  assert.equal(parsed[0].severity, 'alta');
  assert.equal(parsed[0].rule, 'ASTGREP-EXPRESS5-RES-SEND-STATUS');
  assert.match(parsed[0].evidence, /Reescrita pronta: res\.status\(200\)\.send\(\{ok: true\}\)/);
});

test('descoberta ignora symlinks e análise de lockfile + SBOM detecta defeito sem acusar controle limpo', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dep-symlink-'));
  try {
    await writeFile(join(scratch, 'package.json'), '{"name":"s","dependencies":{"hono":"^4.13.19"}}\n');
    await mkdir(join(scratch, 'src'));
    await writeFile(join(scratch, 'src', 'ok.ts'), 'export const x = 1;\n');
    await symlink('/etc/passwd', join(scratch, 'src', 'evil.ts'));
    const discovered = await discoverRepoFiles(scratch);
    assert.equal(discovered.skippedSymlinks, 1);
    assert.equal(discovered.sourceFiles.length, 1);
    assert.equal(discovered.sourceFiles[0].rel, 'src/ok.ts');
  } finally {
    await rm(scratch, {recursive: true, force: true});
  }

  const registry = {
    path: join(moduleDir, 'offline-registry.json'),
    versions: JSON.parse(await readFile(join(moduleDir, 'offline-registry.json'), 'utf8')) as Record<string, string>,
  };

  const dirtyDiscovered = await discoverRepoFiles(fixtureDefect);
  const dirtySbom = await analyzeLockfileAndSbom({
    manifests: dirtyDiscovered.manifests,
    lockfiles: dirtyDiscovered.lockfiles,
    sbomFiles: dirtyDiscovered.sbomFiles,
    registry,
    ncuDetectedPackages: new Set(['package.json:express', 'package.json:lodash', 'package.json:socket.io-client', 'package.json:chalk']),
  });
  assert.equal(dirtySbom.findings.some(f => f.rule === 'LOCKFILE-DRIFT' && f.evidence.includes('chalk')), true);
  assert.equal(dirtySbom.findings.some(f => f.rule === 'SBOM-OUTDATED-COMPONENT' && f.evidence.includes('axios@0.21.1')), true);

  const cleanDiscovered = await discoverRepoFiles(fixtureClean);
  const cleanSbom = await analyzeLockfileAndSbom({
    manifests: cleanDiscovered.manifests,
    lockfiles: cleanDiscovered.lockfiles,
    sbomFiles: cleanDiscovered.sbomFiles,
    registry,
    ncuDetectedPackages: new Set(),
  });
  assert.equal(cleanSbom.findings.length, 0);
});

test('runCollection entrega contrato válido com cobertura detalhada e registra falha de ferramenta', async () => {
  const binDir = await mkdtemp(join(tmpdir(), 'dep-bins-'));
  try {
    const fakeNcu = join(binDir, 'fake-ncu.cjs');
    await writeFile(
      fakeNcu,
      [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        'const pkgIdx = args.indexOf("--packageFile");',
        'const pkg = JSON.parse(require("node:fs").readFileSync(args[pkgIdx + 1], "utf8"));',
        'if (pkg.dependencies && pkg.dependencies.express) {',
        '  process.stdout.write(JSON.stringify({express: "^5.3.0", lodash: "^4.18.1", "socket.io-client": "^4.8.4"}));',
        '} else {',
        '  process.stdout.write("{}");',
        '}',
      ].join('\n'),
      'utf8'
    );
    await chmod(fakeNcu, 0o755);

    const fakeAstGrep = join(binDir, 'fake-ast-grep.cjs');
    await writeFile(
      fakeAstGrep,
      [
        '#!/usr/bin/env node',
        'const target = process.argv[process.argv.length - 1];',
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const serverFile = path.join(target, "src", "server.ts");',
        'const text = fs.existsSync(serverFile) ? fs.readFileSync(serverFile, "utf8") : "";',
        'if (text.includes("app.del(")) {',
        '  process.stdout.write(JSON.stringify([{ruleId:"express5-app-del-ts",severity:"error",message:"app.del removido",file:serverFile,range:{start:{line:1,column:2}},text:"app.del(\'/items/:id\', ...)",replacement:"app.delete(\'/items/:id\', ...)"}]));',
        '  process.exit(1);',
        '} else {',
        '  process.stdout.write("[]");',
        '}',
      ].join('\n'),
      'utf8'
    );
    await chmod(fakeAstGrep, 0o755);

    const fakeJscodeshift = join(binDir, 'fake-jscodeshift.cjs');
    await writeFile(
      fakeJscodeshift,
      [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'const files = process.argv.filter(a => a.endsWith(".js") || a.endsWith(".ts"));',
        'for (const f of files) {',
        '  const orig = fs.readFileSync(f, "utf8");',
        '  if (orig.includes("new Buffer(")) {',
        '    fs.writeFileSync(f, orig.replace("new Buffer(payload)", "Buffer.from(payload)"));',
        '    if (process.env.AC_JSCODESHIFT_REPORT) {',
        '      fs.appendFileSync(process.env.AC_JSCODESHIFT_REPORT, JSON.stringify({file:f,line:5,rule:"JSCODESHIFT-NODE-BUFFER-CTOR",severity:"alta",message:"new Buffer obsoleto",before:"new Buffer(payload)",after:"Buffer.from(payload)"})+"\\n");',
        '    }',
        '  }',
        '}',
      ].join('\n'),
      'utf8'
    );
    await chmod(fakeJscodeshift, 0o755);

    const dirtyResult = await runCollection({
      repoRoot: fixtureDefect,
      ncuBin: fakeNcu,
      astGrepBin: fakeAstGrep,
      jscodeshiftBin: fakeJscodeshift,
      ncuVersion: '23.1.1',
      astGrepVersion: '0.51.3',
      jscodeshiftVersion: '17.4.0',
    });
    validateModuleOutput(dirtyResult);
    assert.equal(dirtyResult.coverage.some(c => c.status === 'failed'), false);
    assert.equal(dirtyResult.coverage.some(c => c.detail.includes('arquivo=package.json')), true);
    assert.equal(dirtyResult.coverage.some(c => c.detail.includes('arquivo=src/server.ts')), true);
    assert.equal(dirtyResult.findings.some(f => f.tool === 'npm-check-updates' && f.rule === 'NCU-OUTDATED-MAJOR'), true);
    assert.equal(dirtyResult.findings.some(f => f.tool === 'ast-grep' && f.rule === 'ASTGREP-EXPRESS5-APP-DEL'), true);
    assert.equal(dirtyResult.findings.some(f => f.tool === 'jscodeshift' && f.rule === 'JSCODESHIFT-NODE-BUFFER-CTOR'), true);
    assert.equal(dirtyResult.findings.some(f => f.tool === 'sbom-lockfile' && f.rule === 'LOCKFILE-DRIFT'), true);

    const cleanResult = await runCollection({
      repoRoot: fixtureClean,
      ncuBin: fakeNcu,
      astGrepBin: fakeAstGrep,
      jscodeshiftBin: fakeJscodeshift,
      ncuVersion: '23.1.1',
      astGrepVersion: '0.51.3',
      jscodeshiftVersion: '17.4.0',
    });
    validateModuleOutput(cleanResult);
    assert.equal(cleanResult.coverage.some(c => c.status === 'failed'), false);
    assert.equal(cleanResult.findings.length, 0);

    const failedResult = await runCollection({
      repoRoot: fixtureClean,
      ncuBin: join(binDir, 'nao-existe-ncu'),
      astGrepBin: fakeAstGrep,
      jscodeshiftBin: fakeJscodeshift,
      ncuVersion: '23.1.1',
      astGrepVersion: '0.51.3',
      jscodeshiftVersion: '17.4.0',
    });
    validateModuleOutput(failedResult);
    assert.equal(failedResult.coverage.some(c => c.tool === 'npm-check-updates' && c.status === 'failed'), true);
  } finally {
    await rm(binDir, {recursive: true, force: true});
  }
});
