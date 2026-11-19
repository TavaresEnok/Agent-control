import assert from 'node:assert/strict';
import {execFile as execFileCb} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
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
  verifyToolsAgainstLock,
} from '../deploy/modules/dependencias/collect.mjs';
import {verifyDependenciasLock} from '../deploy/modules/dependencias/verify-lock.mjs';

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

  const lockResult = verifyDependenciasLock(moduleDir);
  assert.equal(lockResult.ok, true);
  assert.equal(lockResult.toolCount, 4);
  assert.equal(lockResult.totalLockedPackages, 109);

  const lockMeta = JSON.parse(await readFile(join(moduleDir, 'dependencias-tools.lock.json'), 'utf8')) as {
    packageLockSha256: string;
    offlineRegistrySha256: string;
    dependencies: Record<string, {version: string; integrity: string; resolved: string}>;
  };
  const npmLockBytes = await readFile(join(moduleDir, 'package-lock.json'));
  const regBytes = await readFile(join(moduleDir, 'offline-registry.json'));
  assert.equal(createHash('sha256').update(npmLockBytes).digest('hex'), lockMeta.packageLockSha256);
  assert.equal(createHash('sha256').update(regBytes).digest('hex'), lockMeta.offlineRegistrySha256);

  const synthToolsDir = await mkdtemp(join(tmpdir(), 'dep-lock-check-'));
  try {
    await copyFile(join(moduleDir, 'dependencias-tools.lock.json'), join(synthToolsDir, 'dependencias-tools.lock.json'));
    for (const [name, expected] of Object.entries(lockMeta.dependencies)) {
      const pkgDir = join(synthToolsDir, 'node_modules', name);
      await mkdir(pkgDir, {recursive: true});
      await writeFile(join(pkgDir, 'package.json'), JSON.stringify({name, version: expected.version}), 'utf8');
    }
    const verified = await verifyToolsAgainstLock(synthToolsDir);
    assert.equal(verified['npm-check-updates'], '23.1.1');
    assert.equal(verified['@ast-grep/cli'], '0.51.3');
    assert.equal(verified['@ast-grep/cli-linux-x64-gnu'], '0.51.3');
    assert.equal(verified.jscodeshift, '17.4.0');

    await writeFile(
      join(synthToolsDir, 'node_modules', 'jscodeshift', 'package.json'),
      JSON.stringify({name: 'jscodeshift', version: '0.0.1'}),
      'utf8'
    );
    await assert.rejects(() => verifyToolsAgainstLock(synthToolsDir), /Versão divergente para jscodeshift/);
  } finally {
    await rm(synthToolsDir, {recursive: true, force: true});
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

test('runCollection prova contrato CLI do ncu 23.1.1, caminho offline real, isolamento de config e dependências sem metadados', async () => {
  const binDir = await mkdtemp(join(tmpdir(), 'dep-bins-'));
  const mixedRepo = await mkdtemp(join(tmpdir(), 'dep-mixed-'));
  const noMetaRepo = await mkdtemp(join(tmpdir(), 'dep-nometa-'));
  try {
    // Harness que reproduz exatamente o contrato CLI e lilconfig do npm-check-updates@23.1.1
    const contractNcu = join(binDir, 'contract-ncu.cjs');
    await writeFile(
      contractNcu,
      [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const args = process.argv.slice(2);',
        'const getArg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };',
        'if (!args.includes("--jsonUpgraded")) { process.stderr.write("Missing --jsonUpgraded\\n"); process.exit(1); }',
        'const depArg = getArg("--dep");',
        'if (depArg !== "prod,dev,optional,peer") { process.stderr.write("Invalid --dep\\n"); process.exit(1); }',
        'const cfgPath = getArg("--configFilePath");',
        'const cfgName = getArg("--configFileName");',
        'if (!cfgPath || !cfgName) { process.stderr.write("Missing configFilePath/configFileName\\n"); process.exit(1); }',
        'const validRcNames = new Set([".ncurc", ".ncurc.json", ".ncurc.yaml", ".ncurc.yml", ".ncurc.mjs", ".ncurc.cjs", ".ncurc.js"]);',
        'if (!validRcNames.has(cfgName)) {',
        '  const ext = path.extname(cfgName) || cfgName;',
        '  process.stderr.write(`Config file error: No loader specified for extension ${ext}\\n`);',
        '  process.exit(1);',
        '}',
        'const fullCfg = path.join(cfgPath, cfgName);',
        'if (!fs.existsSync(fullCfg)) { process.stderr.write(`Config file ${cfgName} not found in ${cfgPath}\\n`); process.exit(1); }',
        'if (cfgName.endsWith(".json")) JSON.parse(fs.readFileSync(fullCfg, "utf8"));',
        'const forbiddenRoots = JSON.parse(process.env.AC_TEST_FORBIDDEN_ROOTS || "[]");',
        'for (const r of forbiddenRoots) {',
        '  if (path.resolve(cfgPath).startsWith(path.resolve(r))) { process.stderr.write("Config not isolated from repo\\n"); process.exit(1); }',
        '}',
        'const pkgFile = getArg("--packageFile");',
        'if (!pkgFile || !fs.existsSync(pkgFile)) { process.stderr.write("Missing --packageFile\\n"); process.exit(1); }',
        'for (const r of forbiddenRoots) {',
        '  if (path.resolve(pkgFile).startsWith(path.resolve(r))) { process.stderr.write("PackageFile not isolated from repo\\n"); process.exit(1); }',
        '}',
        'const regType = getArg("--registryType");',
        'const regPath = getArg("--registry");',
        'if (regType !== "json" || !regPath || !fs.existsSync(regPath)) { process.stderr.write("Missing json registry\\n"); process.exit(1); }',
        'const reg = JSON.parse(fs.readFileSync(regPath, "utf8"));',
        'const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));',
        'const out = {};',
        'for (const sec of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {',
        '  const block = pkg[sec] || {};',
        '  for (const [name, spec] of Object.entries(block)) {',
        '    const latest = reg[name];',
        '    if (typeof latest !== "string") continue;',
        '    const clean = String(spec).replace(/^[\\^~>=<\\s]+/, "");',
        '    if (/^\\d+\\.\\d+\\.\\d+$/.test(clean) && clean !== latest) {',
        '      const prefix = String(spec).startsWith("^") ? "^" : String(spec).startsWith("~") ? "~" : "";',
        '      out[name] = `${prefix}${latest}`;',
        '    }',
        '  }',
        '}',
        'process.stdout.write(`${JSON.stringify(out)}\\n`);',
      ].join('\n'),
      'utf8'
    );
    await chmod(contractNcu, 0o755);

    const contractAstGrep = join(binDir, 'contract-ast-grep.cjs');
    await writeFile(
      contractAstGrep,
      [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const args = process.argv.slice(2);',
        'if (args[0] !== "scan" || args[1] !== "--config" || !fs.existsSync(args[2]) || args[3] !== "--json=compact") {',
        '  process.stderr.write("Invalid ast-grep CLI args\\n");',
        '  process.exit(2);',
        '}',
        'if (process.env.AC_TEST_FORCE_ASTGREP_EMPTY_FAIL === "1") {',
        '  process.stderr.write("error: forced ast-grep config failure\\n");',
        '  process.exit(2);',
        '}',
        'const target = args[4];',
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
    await chmod(contractAstGrep, 0o755);

    const contractJscodeshift = join(binDir, 'contract-jscodeshift.cjs');
    await writeFile(
      contractJscodeshift,
      [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'const args = process.argv.slice(2);',
        'if (!args.includes("--run-in-band") || !args.includes("--silent") || !args.some(a => a.startsWith("--parser=")) || !args.includes("-t")) {',
        '  process.stderr.write("Invalid jscodeshift CLI args\\n");',
        '  process.exit(2);',
        '}',
        'const files = args.filter(a => a.endsWith(".js") || a.endsWith(".ts"));',
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
    await chmod(contractJscodeshift, 0o755);

    process.env.AC_TEST_FORBIDDEN_ROOTS = JSON.stringify([
      resolve(fixtureDefect),
      resolve(fixtureClean),
      resolve(mixedRepo),
      resolve(noMetaRepo),
    ]);

    const dirtyResult = await runCollection({
      repoRoot: fixtureDefect,
      ncuBin: contractNcu,
      astGrepBin: contractAstGrep,
      jscodeshiftBin: contractJscodeshift,
      ncuVersion: '23.1.1',
      astGrepVersion: '0.51.3',
      jscodeshiftVersion: '17.4.0',
    });
    validateModuleOutput(dirtyResult);
    assert.equal(dirtyResult.coverage.some(c => c.status === 'failed'), false);
    assert.equal(dirtyResult.coverage.some(c => c.tool === 'npm-check-updates' && c.detail.includes('sem_metadados=0')), true);
    assert.equal(dirtyResult.findings.some(f => f.tool === 'npm-check-updates' && f.rule === 'NCU-OUTDATED-MAJOR' && f.evidence.includes('^5.3.0')), true);
    assert.equal(dirtyResult.findings.some(f => f.tool === 'npm-check-updates' && f.rule === 'NCU-OUTDATED-MINOR' && f.evidence.includes('^4.18.1')), true);
    assert.equal(dirtyResult.findings.some(f => f.tool === 'npm-check-updates' && f.rule === 'NCU-OUTDATED-PATCH' && f.evidence.includes('^4.8.4')), true);
    assert.equal(dirtyResult.findings.some(f => f.tool === 'ast-grep' && f.rule === 'ASTGREP-EXPRESS5-APP-DEL'), true);
    assert.equal(dirtyResult.findings.some(f => f.tool === 'jscodeshift' && f.rule === 'JSCODESHIFT-NODE-BUFFER-CTOR'), true);
    assert.equal(dirtyResult.findings.some(f => f.tool === 'sbom-lockfile' && f.rule === 'LOCKFILE-DRIFT'), true);

    const cleanResult = await runCollection({
      repoRoot: fixtureClean,
      ncuBin: contractNcu,
      astGrepBin: contractAstGrep,
      jscodeshiftBin: contractJscodeshift,
      ncuVersion: '23.1.1',
      astGrepVersion: '0.51.3',
      jscodeshiftVersion: '17.4.0',
    });
    validateModuleOutput(cleanResult);
    assert.equal(cleanResult.coverage.some(c => c.status === 'failed'), false);
    assert.equal(cleanResult.findings.length, 0);

    // Repositório misto com config hostil no repo + dependência real + dependência sem metadados no registro offline
    await writeFile(
      join(mixedRepo, 'package.json'),
      JSON.stringify(
        {
          name: 'mixed-meta-repo',
          version: '1.0.0',
          dependencies: {
            express: '^4.17.1',
            'pacote-privado-sem-metadados': '^1.2.3',
          },
        },
        null,
        2
      )
    );
    await writeFile(
      join(mixedRepo, 'package-lock.json'),
      JSON.stringify(
        {
          name: 'mixed-meta-repo',
          version: '1.0.0',
          lockfileVersion: 3,
          packages: {
            '': {name: 'mixed-meta-repo', version: '1.0.0'},
            'node_modules/express': {version: '4.17.1'},
            'node_modules/pacote-privado-sem-metadados': {version: '1.2.3'},
          },
        },
        null,
        2
      )
    );
    await writeFile(join(mixedRepo, '.ncurc.js'), 'throw new Error("Config do repositório não pode rodar");\n');
    await writeFile(join(mixedRepo, '.ncurc.json'), '{"reject":["express"]}\n');

    const mixedResult = await runCollection({
      repoRoot: mixedRepo,
      ncuBin: contractNcu,
      astGrepBin: contractAstGrep,
      jscodeshiftBin: contractJscodeshift,
      ncuVersion: '23.1.1',
      astGrepVersion: '0.51.3',
      jscodeshiftVersion: '17.4.0',
    });
    validateModuleOutput(mixedResult);
    assert.equal(mixedResult.coverage.some(c => c.status === 'failed'), false);
    assert.equal(
      mixedResult.findings.some(f => f.tool === 'npm-check-updates' && f.rule === 'NCU-OUTDATED-MAJOR' && f.evidence.includes('express')),
      true
    );
    assert.equal(
      mixedResult.coverage.some(
        c =>
          c.tool === 'npm-check-updates' &&
          c.status === 'skipped' &&
          c.detail.includes('pacotes=pacote-privado-sem-metadados') &&
          c.detail.includes('motivo=ausente_no_registro_offline')
      ),
      true
    );
    assert.equal(
      mixedResult.coverage.some(c => c.tool === 'sbom-lockfile' && c.detail.includes('sem_metadados=1')),
      true
    );

    // Repositório em que NENHUMA dependência tem metadados no registro offline
    await writeFile(
      join(noMetaRepo, 'package.json'),
      JSON.stringify(
        {
          name: 'only-missing-meta',
          version: '1.0.0',
          dependencies: {
            'pacote-sem-metadados-a': '^1.0.0',
          },
        },
        null,
        2
      )
    );
    const noMetaResult = await runCollection({
      repoRoot: noMetaRepo,
      ncuBin: contractNcu,
      astGrepBin: contractAstGrep,
      jscodeshiftBin: contractJscodeshift,
      ncuVersion: '23.1.1',
      astGrepVersion: '0.51.3',
      jscodeshiftVersion: '17.4.0',
    });
    validateModuleOutput(noMetaResult);
    assert.equal(noMetaResult.coverage.some(c => c.status === 'failed'), false);
    const noMetaSummary = noMetaResult.coverage.find(c => c.tool === 'npm-check-updates');
    assert.ok(noMetaSummary);
    assert.equal(noMetaSummary.status, 'skipped');
    assert.equal(noMetaSummary.detail.includes('verificadas_registro=0; sem_metadados=1'), true);
    assert.equal(noMetaSummary.detail.includes('nenhuma_dependencia_no_registro_offline'), true);

    // Falha de ferramenta (ncu inexistente)
    const failedNcu = await runCollection({
      repoRoot: fixtureClean,
      ncuBin: join(binDir, 'nao-existe-ncu'),
      astGrepBin: contractAstGrep,
      jscodeshiftBin: contractJscodeshift,
      ncuVersion: '23.1.1',
      astGrepVersion: '0.51.3',
      jscodeshiftVersion: '17.4.0',
    });
    validateModuleOutput(failedNcu);
    assert.equal(failedNcu.coverage.some(c => c.tool === 'npm-check-updates' && c.status === 'failed'), true);

    // Falha de ast-grep sem JSON (exit != 0 e stdout vazio)
    process.env.AC_TEST_FORCE_ASTGREP_EMPTY_FAIL = '1';
    const failedAstGrep = await runCollection({
      repoRoot: fixtureClean,
      ncuBin: contractNcu,
      astGrepBin: contractAstGrep,
      jscodeshiftBin: contractJscodeshift,
      ncuVersion: '23.1.1',
      astGrepVersion: '0.51.3',
      jscodeshiftVersion: '17.4.0',
    });
    validateModuleOutput(failedAstGrep);
    assert.equal(failedAstGrep.coverage.some(c => c.tool === 'ast-grep' && c.status === 'failed'), true);
  } finally {
    delete process.env.AC_TEST_FORBIDDEN_ROOTS;
    delete process.env.AC_TEST_FORCE_ASTGREP_EMPTY_FAIL;
    await rm(binDir, {recursive: true, force: true});
    await rm(mixedRepo, {recursive: true, force: true});
    await rm(noMetaRepo, {recursive: true, force: true});
  }
});
