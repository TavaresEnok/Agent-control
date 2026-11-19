import assert from 'node:assert/strict';
import {execFile as execFileCb} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {EventEmitter} from 'node:events';
import {fetchLatestVersion} from '../deploy/modules/dependencias/fetch-registry.mjs';
import {
  analyzeLockfileAndSbom,
  classifySemverRisk,
  discoverRepoFiles,
  findLineInPackageJson,
  parseAstGrepJson,
  runCollection,
  runAstGrepCheck,
  runJscodeshiftCheck,
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
  assert.equal(lockResult.toolCount, 6);
  assert.equal(lockResult.totalLockedPackages, 113);

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
  assert.equal(entries.length, 15);
  const ids = new Set<string>();
  for (const name of entries) {
    const content = await readFile(join(rulesDir, name), 'utf8');
    const idMatch = /^id:\s*([A-Za-z0-9_-]+)\s*$/m.exec(content);
    assert.ok(idMatch, `Falta id em ${name}`);
    assert.equal(ids.has(idMatch[1]), false, `ID duplicado em ${name}: ${idMatch[1]}`);
    ids.add(idMatch[1]);
    assert.match(content, /^language:\s+(TypeScript|JavaScript|Tsx)\s*$/m);
    assert.match(content, /^severity:\s+(error|warning|info|hint)\s*$/m);
    assert.doesNotMatch(content, /^fix:\s+/m);
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
  assert.match(parsed[0].evidence, /Revisão necessária/);
});

test('descoberta ignora symlinks e análise de lockfile + SBOM detecta defeito sem acusar controle limpo', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dep-symlink-'));
  try {
    await writeFile(join(scratch, 'package.json'), '{"name":"s","dependencies":{"hono":"^4.13.19"}}\n');
    await mkdir(join(scratch, 'src'));
    await writeFile(join(scratch, 'src', 'ok.ts'), 'export const x = 1;\n');
    const symlinkTarget = join(scratch, 'synthetic.txt');
    await writeFile(symlinkTarget, 'synthetic');
    await symlink(symlinkTarget, join(scratch, 'src', 'ignored.ts'));
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
        'if (!args.includes("--inspect") || !args.includes("entity")) process.exit(2);',
        'function trace(dir) {',
        '  for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {',
        '    const file = path.join(dir, entry.name);',
        '    if (entry.isDirectory()) trace(file);',
        '    else process.stderr.write("sg: entity|file|"+file+": language=TypeScript,appliedRuleCount=5\\n");',
        '  }',
        '}',
        'trace(target);',
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
        'if (!args.includes("--run-in-band") || !args.includes("--fail-on-error") || !args.some(a => a.startsWith("--parser=")) || !args.includes("-t")) {',
        '  process.stderr.write("Invalid jscodeshift CLI args\\n");',
        '  process.exit(2);',
        '}',
        'const files = args.filter(a => a.endsWith(".js") || a.endsWith(".ts"));',
        'for (const f of files) {',
        '  const orig = fs.readFileSync(f, "utf8");',
        '  if (orig.includes("new Buffer(")) {',
        '    fs.writeFileSync(f, orig.replace("new Buffer(payload)", "Buffer.from(payload)"));',
        '    if (process.env.AC_JSCODESHIFT_REPORT) {',
        '      fs.appendFileSync(process.env.AC_JSCODESHIFT_REPORT, JSON.stringify({file:f,line:5,rule:"JSCODESHIFT-NODE-BUFFER-CTOR",severity:"alta",message:"new Buffer obsoleto",before:"new Buffer(payload)",after:"Buffer.from(payload)",review:false})+"\\n");',
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
    assert.equal(dirtyResult.findings.some(f => f.tool === 'jscodeshift' && f.rule === 'JSCODESHIFT-NODE-BUFFER-CTOR' && f.evidence.includes('Patch pronto')), true);
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

test('entradas inválidas são isoladas, workspaces e versões de SBOM preservados', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dep-regressoes-'));
  try {
    await mkdir(join(root, 'packages/a'), {recursive: true});
    await mkdir(join(root, 'broken'), {recursive: true});
    await mkdir(join(root, 'other'), {recursive: true});
    await writeFile(join(root, 'package.json'), JSON.stringify({workspaces: ['packages/*']}));
    await writeFile(join(root, 'packages/a/package.json'), JSON.stringify({dependencies: {foo: '~1'}}));
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({packages: {'': {}, 'node_modules/foo': {version: '1.8.0'}}}));
    await writeFile(join(root, 'broken/package.json'), 'null');
    await writeFile(join(root, 'other/package.json'), JSON.stringify({dependencies: {foo: '1.0.0'}}));
    await writeFile(join(root, 'other/package-lock.json'), 'null');
    await writeFile(join(root, 'syft.cdx.json'), JSON.stringify({bomFormat: 'CycloneDX', components: [
      {name: 'foo', version: '1.0.0', purl: 'pkg:pypi/foo@1.0.0'},
      {name: 'bad', version: '1.0.0', purl: 'pkg:npm/%ZZ@1.0.0'},
      {name: 'foo', version: '1.0.0', purl: 'pkg:npm/foo@1.0.0'},
      {name: 'foo', version: '1.8.0', purl: 'pkg:npm/foo@1.8.0'},
    ]}));
    await writeFile(join(root, 'other/sbom.cdx.json'), '{');
    const found = await discoverRepoFiles(root);
    const result = await analyzeLockfileAndSbom({manifests: found.manifests, lockfiles: found.lockfiles, sbomFiles: found.sbomFiles,
      registry: {path: '', versions: {foo: '2.0.0'}}, ncuDetectedPackages: new Set(['packages/a/package.json:foo'])});
    assert.equal(result.findings.some(f => f.rule === 'LOCKFILE-MISSING' || f.rule === 'LOCKFILE-VERSION-MISMATCH'), false);
    assert.equal(result.findings.some(f => f.rule === 'LOCKFILE-INVALID-JSON'), true);
    assert.equal(result.findings.filter(f => f.rule === 'SBOM-OUTDATED-COMPONENT').length, 2);
    for (const label of ['manifesto_invalido', 'lockfile_invalido', 'purl_npm_invalida', 'json_invalido']) {
      assert.ok(result.coverage.some(c => c.status === 'failed' && c.detail.includes(label)), label);
    }
    assert.equal(satisfiesRange('1.8.0', '~1'), true);
    assert.equal(satisfiesRange('1.5.0', '1.2 - 1.6'), true);
    assert.equal(satisfiesRange('1.5.0-beta.1', '^1.2.0'), false);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('limites de descoberta e extensões não medidas são registrados', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dep-limites-'));
  try {
    for (let i = 0; i < 51; i++) {
      const dir = join(root, `m${String(i).padStart(2, '0')}`);
      await mkdir(dir); await writeFile(join(dir, 'package.json'), '{}');
    }
    await mkdir(join(root, 'src'));
    await Promise.all(Array.from({length: 2001}, (_, i) => writeFile(join(root, 'src', `${i}.js`), '')));
    const found = await discoverRepoFiles(root);
    assert.equal(found.skippedManifestLimit, 1);
    assert.equal(found.skippedSourceLimit, 1);
    const bytesDir = join(root, 'bytes'); await mkdir(bytesDir);
    await Promise.all(Array.from({length: 65}, async (_, i) => { const path = join(bytesDir, `${i}.js`); await writeFile(path, ''); await truncate(path, 2 * 1024 * 1024); }));
    const bytes = await discoverRepoFiles(bytesDir);
    assert.equal(bytes.skippedSourceBytes, 1);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('processos atribuem a varredura por arquivo e distinguem sintaxe inválida, saída não zero e relatório limitado', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dep-ferramentas-'));
  try {
    const src = join(root, 'src'); const codemod = join(root, 'codemod');
    await mkdir(src); await mkdir(codemod);
    const files = [];
    for (const [name, content] of Object.entries({
      'view.tsx': 'const x = <div/>; res.send(200, x);',
      'bad.js': 'const = ; res.send(200, x);',
      'bad-missing.ts': 'const x = (1;',
      'extra.mts': 'export const x = 1; res.send(200, x);',
      'extra.cts': 'export const x = 1;',
      'extra.cjs': 'module.exports = () => res.send(200, x);',
      'extra.mjs': 'export const x = 1;',
      'unmeasured.TS': 'export const x = 1;',
    })) {
      files.push({rel: name, fullPath: join(src, name), ext: name.slice(name.lastIndexOf('.')).toLowerCase()});
      await writeFile(join(src, name), content); await writeFile(join(codemod, name), content);
    }
    const astBin = join(moduleDir, 'node_modules/.bin/ast-grep');
    const jsBin = join(moduleDir, 'node_modules/.bin/jscodeshift');
    const ast = await runAstGrepCheck({sourceFiles: files, isoSrcDir: src, astGrepBin: astBin, astGrepVersion: '0.51.3', sgConfigPath: join(moduleDir, 'sgconfig.yml')});
    assert.deepEqual(ast.findings.map(f => f.file).sort(), ['extra.cjs', 'extra.mts', 'view.tsx']);
    assert.ok(ast.findings.every(f => f.rule.includes('SEND-STATUS')));
    for (const file of ['view.tsx', 'extra.mts', 'extra.cts', 'extra.cjs', 'extra.mjs']) {
      assert.ok(ast.coverage.some(c => c.detail.startsWith(`arquivo=${file};`) && c.status === 'ok'), file);
    }
    for (const file of ['bad.js', 'bad-missing.ts']) {
      assert.ok(ast.coverage.some(c => c.detail.startsWith(`arquivo=${file};`) && c.status === 'failed' && c.detail.includes('sintaxe_invalida')));
    }
    assert.ok(ast.coverage.some(c => c.detail.includes('unmeasured.TS') && c.status === 'skipped'));
    const js = await runJscodeshiftCheck({sourceFiles: files.slice(0, 3), isoSrcDir: src, isoCodemodDir: codemod, workRoot: root, jscodeshiftBin: jsBin, jscodeshiftVersion: '17.4.0', transformPath: join(moduleDir, 'codemods/upgrade-rewrites.cjs')});
    assert.ok(js.coverage.some(c => c.detail.includes('bad.js') && c.status === 'failed'));
    assert.ok(js.coverage.some(c => c.detail.includes('view.tsx') && c.status === 'ok'));
    const fake = join(root, 'fake.cjs');
    await writeFile(fake, '#!/usr/bin/env node\nprocess.stdout.write("[]"); process.exit(2);\n'); await chmod(fake, 0o755);
    const failed = await runAstGrepCheck({sourceFiles: files, isoSrcDir: src, astGrepBin: fake, astGrepVersion: 'x', sgConfigPath: join(moduleDir, 'sgconfig.yml')});
    assert.equal(failed.coverage[0].status, 'failed');
    await writeFile(fake, '#!/usr/bin/env node\nrequire("fs").writeFileSync(process.env.AC_JSCODESHIFT_REPORT, "x".repeat(2097153));\n');
    const limited = await runJscodeshiftCheck({sourceFiles: [files[0]], isoSrcDir: src, isoCodemodDir: codemod, workRoot: root, jscodeshiftBin: fake, jscodeshiftVersion: 'x', transformPath: join(moduleDir, 'codemods/upgrade-rewrites.cjs')});
    assert.ok(limited.coverage.some(c => c.status === 'skipped' && c.detail.includes('prova_parcial')));
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('consulta do registro termina em timeout ou limite de bytes com resposta sintética', async () => {
  let destroyed = false;
  const hanging = () => Object.assign(new EventEmitter(), {destroy() { destroyed = true; }});
  await assert.rejects(fetchLatestVersion('synthetic', {get: hanging, timeoutMs: 20}), /timeout/);
  assert.equal(destroyed, true);
  const oversized = (_url: string, cb: (response: EventEmitter & {statusCode: number; destroy(): void}) => void) => {
    const req = Object.assign(new EventEmitter(), {destroy() {}});
    const res = Object.assign(new EventEmitter(), {statusCode: 200, destroy() {}});
    queueMicrotask(() => { cb(res); res.emit('data', Buffer.alloc(20)); });
    return req;
  };
  await assert.rejects(fetchLatestVersion('synthetic', {get: oversized, timeoutMs: 1000, maxBytes: 10}), /limite de bytes/);
});

test('manifestos e registro inválidos não apagam análises de outros arquivos', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dep-invalidos-'));
  try {
    await mkdir(join(root, 'bad')); await mkdir(join(root, 'good'));
    await writeFile(join(root, 'bad/package.json'), 'null');
    await writeFile(join(root, 'good/package.json'), JSON.stringify({dependencies: {foo: '1.0.0', broken: '1.0.0'}}));
    await writeFile(join(root, 'good/package-lock.json'), JSON.stringify({packages: {'node_modules/foo': {version: '1.0.0'}, 'node_modules/broken': {version: '1.0.0'}}}));
    const registry = join(root, 'registro.json'); await writeFile(registry, JSON.stringify({foo: '2.0.0', broken: 'inválido'}));
    const ncu = join(root, 'ncu.cjs');
    await writeFile(ncu, '#!/usr/bin/env node\nconst fs=require("fs"); const a=process.argv; const r=JSON.parse(fs.readFileSync(a[a.indexOf("--registry")+1])); if(r.broken) process.exit(2); process.stdout.write(JSON.stringify({foo:"2.0.0"}));');
    await chmod(ncu, 0o755);
    const out = await runCollection({repoRoot: root, registryPath: registry, ncuBin: ncu, ncuVersion: 'x', astGrepVersion: 'x', jscodeshiftVersion: 'x', astGrepBin: join(moduleDir, 'node_modules/.bin/ast-grep'), jscodeshiftBin: join(moduleDir, 'node_modules/.bin/jscodeshift')});
    assert.ok(out.findings.some(f => f.rule === 'NCU-INVALID-PACKAGE-JSON'));
    assert.ok(out.findings.some(f => f.rule === 'NCU-OUTDATED-MAJOR' && f.file === 'good/package.json'));
    assert.ok(out.coverage.some(c => c.detail.includes('sem_metadados=1')));
    assert.ok(out.coverage.some(c => c.detail.includes('metadados_invalidos=1') && c.status === 'skipped'));
    assert.ok(out.coverage.some(c => c.status === 'failed' && c.detail.includes('manifesto_invalido')));
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('padrões ambíguos requerem revisão e entrada ausente produz JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dep-semantica-'));
  try {
    const src = join(root, 'src'), dst = join(root, 'dst'); await mkdir(src); await mkdir(dst);
    const content = "const n = 10; new Buffer(n); url.parse('/rota'); transport.send(200, body);";
    await writeFile(join(src, 'app.js'), content); await writeFile(join(dst, 'app.js'), content);
    const files = [{rel: 'app.js', fullPath: join(src, 'app.js'), ext: '.js'}];
    const js = await runJscodeshiftCheck({sourceFiles: files, isoSrcDir: src, isoCodemodDir: dst, workRoot: root, jscodeshiftBin: join(moduleDir, 'node_modules/.bin/jscodeshift'), jscodeshiftVersion: '17.4.0', transformPath: join(moduleDir, 'codemods/upgrade-rewrites.cjs')});
    assert.equal(await readFile(join(dst, 'app.js'), 'utf8'), content);
    assert.equal(js.findings.length, 2);
    assert.ok(js.findings.every(f => f.evidence.includes('Revisão necessária')));
    const ast = await runAstGrepCheck({sourceFiles: files, isoSrcDir: src, astGrepBin: join(moduleDir, 'node_modules/.bin/ast-grep'), astGrepVersion: '0.51.3', sgConfigPath: join(moduleDir, 'sgconfig.yml')});
    assert.ok(ast.findings.every(f => !f.evidence.includes('Reescrita pronta')));
    const entrypoint = join(root, 'entrypoint.sh');
    const script = await readFile(join(moduleDir, 'entrypoint.sh'), 'utf8');
    await writeFile(entrypoint, script.replaceAll('/var/run/docker.sock', join(root, 'socket-a')).replaceAll('/run/docker.sock', join(root, 'socket-b')));
    await assert.rejects(execFile('sh', [entrypoint], {env: {...process.env, AC_MODULE_REPO: join(root, 'ausente')}}), (err: any) => {
      assert.equal(err.code, 78); const output = JSON.parse(err.stdout);
      assert.equal(output.coverage[0].status, 'failed'); assert.match(output.coverage[0].detail, /REPO_MISSING/); return true;
    });
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('lock do workspace prevalece e o achado aponta para a entrada efetivamente resolvida', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dep-workspace-'));
  try {
    await mkdir(join(root, 'packages/a'), {recursive: true});
    await writeFile(join(root, 'package.json'), '{"workspaces":{"packages":["packages/*"]}}');
    await writeFile(join(root, 'packages/a/package.json'),
      '{"dependencies":{"foo":"^2.0.0","outdated":"^1.0.0","broken":"^2.0.0","ghost":"^1.0.0"}}');
    await writeFile(join(root, 'packages/a/package-lock.json'),
      '{"packages":{"node_modules/foo":{"version":"2.0.0"},"node_modules/broken":{"version":"2.0.0"}}}');

    const lockText = [
      '{ "lockfileVersion": 2, "packages": {',
      '  "node_modules/foo": {"version":"2.2.0"}, "node_modules/outdated": {"version":"2.0.0"},',
      '  "packages/a/node_modules/foo": {"version":"1.0.0"},',
      '  "packages/a/node_modules/outdated": {"version":"1.0.0"},',
      '  "packages/a/node_modules/broken": 1,',
      '  "node_modules/broken": {"version":"2.0.0"}',
      '}, "dependencies": {"ghost": {"version":"1.0.0"}} }',
    ].join('\n');
    await writeFile(join(root, 'package-lock.json'), lockText);
    const found = await discoverRepoFiles(root);
    const result = await analyzeLockfileAndSbom({...found, mountedSbomPaths: [], ncuDetectedPackages: new Set(),
      registry: {path: '', versions: {foo: '2.2.0', outdated: '2.0.0'}}});
    const mismatch = result.findings.find(finding => finding.rule === 'LOCKFILE-VERSION-MISMATCH');
    assert.equal(mismatch?.file, 'package-lock.json');
    assert.equal(mismatch?.line, 3);
    assert.match(mismatch?.evidence ?? '', /packages\/a\/node_modules\/foo/);
    const outdated = result.findings.find(finding => finding.rule === 'LOCKFILE-OUTDATED-RESOLVED');
    assert.equal(outdated?.line, 4);
    assert.match(outdated?.evidence ?? '', /packages\/a\/node_modules\/outdated/);
    const drift = result.findings.filter(finding => finding.rule === 'LOCKFILE-DRIFT');
    assert.equal(drift.length, 1);
    assert.match(drift[0].evidence, /ghost/);
    assert.ok(result.coverage.some(row => row.status === 'failed' &&
      row.detail.includes('entrada=packages/a/node_modules/broken; erro=entrada_lockfile_invalida')));
    assert.ok(result.coverage.every(row => !row.detail.includes('arquivo=packages/a/package-lock.json')));

    await rm(join(root, 'package-lock.json'));
    const withoutRoot = await discoverRepoFiles(root);
    const missing = await analyzeLockfileAndSbom({...withoutRoot, mountedSbomPaths: [], registry: null, ncuDetectedPackages: new Set()});
    assert.ok(missing.findings.some(finding => finding.rule === 'LOCKFILE-MISSING' &&
      finding.file === 'packages/a/package.json' && finding.evidence.endsWith('diretório raiz.')));

    await writeFile(join(root, 'package-lock.json'), '{"packages":{"node_modules/foo":{"version":"2.0.0"}}}');
    await writeFile(join(root, 'npm-shrinkwrap.json'), lockText);
    const withShrinkwrap = await discoverRepoFiles(root);
    const byShrinkwrap = await analyzeLockfileAndSbom({...withShrinkwrap, mountedSbomPaths: [], registry: null, ncuDetectedPackages: new Set()});
    assert.ok(byShrinkwrap.findings.some(finding => finding.rule === 'LOCKFILE-VERSION-MISMATCH' &&
      finding.file === 'npm-shrinkwrap.json' && finding.line === 3));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('ncu rejeita resultados inválidos por manifesto e aceita o alias confirmado pelo registro offline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dep-ncu-output-'));
  try {
    for (const name of ['bad-type', 'bad-name', 'bad-range', 'bad-registry', 'valid']) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, 'package.json'),
        JSON.stringify({name, dependencies: {foo: '^1.0.0', repo: 'github:example/test#semver:^1.0.0'}}));
    }
    const registryPath = join(root, 'registry.json');
    await writeFile(registryPath, '{"foo":"2.0.0","repo":"2.0.0"}');
    const fake = join(root, 'ncu-fixture');
    await writeFile(fake, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const file = process.argv[process.argv.indexOf("--packageFile") + 1];',
      'const {name, dependencies} = JSON.parse(fs.readFileSync(file));',
      'if (dependencies.repo || process.env.NPM_CONFIG_OFFLINE !== "true") process.exit(4);',
      'const messages = {"bad-type":{foo:{version:"2.0.0"},other:"2.0.0"},"bad-name":{foo:"^2.0.0",other:"2.0.0"},',
      '  "bad-range":{foo:"nonsense"},"bad-registry":{foo:"^999.0.0"},valid:{foo:"^2.0.0"}};',
      'process.stdout.write(JSON.stringify(messages[name]));',
    ].join('\n'));
    await chmod(fake, 0o755);
    const output = await runCollection({repoRoot: root, registryPath, ncuBin: fake,
      ncuVersion: 'sintetica', astGrepVersion: 'sintetica', jscodeshiftVersion: 'sintetica'});
    for (const name of ['bad-type', 'bad-name', 'bad-range', 'bad-registry']) {
      const rows = output.coverage.filter(row => row.tool === 'npm-check-updates' && row.detail.startsWith(`arquivo=${name}/package.json;`));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'failed');
      assert.match(rows[0].detail, /Saída JSON inválida/);
    }
    assert.equal(output.coverage.some(row => row.tool === 'npm-check-updates' && row.status === 'ok' &&
      row.detail.includes('arquivo=valid/package.json')), true);
    assert.deepEqual(output.findings.filter(f => f.rule.startsWith('NCU-OUTDATED')).map(f => f.file), ['valid/package.json']);

    const aliasRepo = join(root, 'alias');
    await mkdir(aliasRepo);
    await writeFile(join(aliasRepo, 'package.json'), '{"dependencies":{"local-name":"npm:foo@^1.0.0"}}');
    const real = await runCollection({repoRoot: aliasRepo, registryPath,
      ncuBin: join(moduleDir, 'node_modules/.bin/ncu'), ncuVersion: '23.1.1',
      astGrepVersion: 'sintetica', jscodeshiftVersion: 'sintetica'});
    assert.ok(real.findings.some(f => f.rule === 'NCU-OUTDATED-MAJOR' && f.evidence.includes('npm:foo@^2.0.0')));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('CycloneDX preserva componentes aninhados e distingue inventário vazio, entradas inválidas e metadados', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dep-cyclonedx-'));
  try {
    const report = (name: string, doc: unknown) => writeFile(join(root, name), JSON.stringify(doc));
    await report('bom-empty', {bomFormat: 'CycloneDX'});
    await report('bom-invalid', {bomFormat: 'CycloneDX', components: [
      null, {}, 42,
      {name: 'bad-children', components: {}},
      {name: 'purl-error', purl: 'pkg:npm/%XX@1.0.0'},
      {name: 'conflict', version: '2.0.0', purl: 'pkg:npm/conflict@1.0.0'},
      {name: 'assembly', components: [{name: 'example', purl: 'pkg:npm/%40scope/example@1.0.0?arch=all'}]},
    ]});
    await report('bom-unavailable', {bomFormat: 'CycloneDX', components: [
      {name: 'invalid', purl: 'pkg:npm/invalid@1.0.0'},
      {name: 'absent', purl: 'pkg:npm/absent@1.0.0'},
      {name: 'other', purl: 'pkg:pypi/other@2', version: '2'},
    ]});
    const result = await analyzeLockfileAndSbom({manifests: [], lockfiles: new Map(), mountedSbomPaths: [],
      sbomFiles: ['bom-empty', 'bom-invalid', 'bom-unavailable'].map(rel => ({rel, fullPath: join(root, rel)})),
      ncuDetectedPackages: new Set(), registry: {path: '', versions: {'@scope/example': '2.0.0', invalid: 'inválida'}}});
    const empty = result.coverage.find(row => row.detail.startsWith('sbom=bom-empty;'));
    assert.equal(empty?.status, 'ok');
    assert.match(empty?.detail ?? '', /componentes=0/);
    const invalid = result.coverage.find(row => row.detail.startsWith('sbom=bom-invalid;'));
    assert.equal(invalid?.status, 'failed');
    assert.match(invalid?.detail ?? '', /componente_invalido=3/);
    assert.match(invalid?.detail ?? '', /componentes_aninhados_invalidos=1/);
    assert.match(invalid?.detail ?? '', /purl_npm_invalida=1/);
    assert.match(invalid?.detail ?? '', /versao_componente_invalida=1/);
    assert.deepEqual(result.findings.map(f => f.file), ['bom-invalid']);
    assert.match(result.findings[0].evidence, /@scope\/example@1.0.0 -> 2.0.0/);
    const unavailable = result.coverage.find(row => row.detail.startsWith('sbom=bom-unavailable;'));
    assert.equal(unavailable?.status, 'failed');
    assert.match(unavailable?.detail ?? '', /sem_metadados=2; metadados_invalidos=1/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('limites de bytes preservam provas de outros SBOMs e distinguem artefatos desaparecidos', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dep-sbom-bytes-'));
  try {
    const large = Buffer.alloc(19 * 1024 * 1024, ' ');
    large.write('{"bomFormat":"CycloneDX"}');
    for (const name of ['volume-a', 'volume-b', 'volume-c', 'volume-d']) {
      await writeFile(join(root, name), large);
    }
    await writeFile(join(root, 'last'), '{"bomFormat":"CycloneDX","components":[{"name":"foo","purl":"pkg:npm/foo@1.0.0"}]}');
    for (const name of ['oversized-sbom', 'package-lock.json']) {
      const file = join(root, name);
      await writeFile(file, '');
      await truncate(file, 21 * 1024 * 1024);
    }
    await writeFile(join(root, 'package.json'), '{"dependencies":{"foo":"^1.0.0"}}');
    await mkdir(join(root, 'gone'));
    await writeFile(join(root, 'gone/package.json'), '{"dependencies":{"foo":"^1.0.0"}}');
    const found = await discoverRepoFiles(root);
    found.lockfiles.set('gone/package-lock.json', join(root, 'gone/package-lock.json'));
    const result = await analyzeLockfileAndSbom({...found, mountedSbomPaths: [join(root, 'no-mount')],
      sbomFiles: ['volume-a', 'volume-b', 'volume-c', 'volume-d', 'oversized-sbom', 'gone-sbom', 'last']
        .map(rel => ({rel, fullPath: join(root, rel)})),
      ncuDetectedPackages: new Set(), registry: {path: '', versions: {foo: '2.0.0'}}});
    for (const file of ['arquivo=package-lock.json;', 'sbom=oversized-sbom;']) {
      assert.ok(result.coverage.some(row => row.status === 'skipped' && row.detail.startsWith(file) &&
        row.detail.includes('motivo=limite_bytes;')));
    }
    assert.ok(result.coverage.some(row => row.status === 'skipped' &&
      row.detail.startsWith('sbom=volume-d;') && row.detail.includes('motivo=limite_bytes_total;')));
    for (const file of ['arquivo=gone/package-lock.json;', 'sbom=gone-sbom;']) {
      assert.ok(result.coverage.some(row => row.status === 'failed' && row.detail.startsWith(file) &&
        row.detail.includes('erro=arquivo_ausente')));
    }
    assert.ok(result.coverage.every(row => !row.detail.includes('no-mount')));
    assert.deepEqual(result.findings.map(f => f.file), ['last']);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('CycloneDX limita componentes agregados e conserva comparações anteriores ao limite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dep-sbom-components-'));
  try {
    const first = {name: 'foo', purl: 'pkg:npm/foo@1.0.0'};
    const other = {name: 'non-npm', purl: 'pkg:pypi/non-npm@1.0.0'};
    const files = ['first', 'later'].map(rel => ({rel, fullPath: join(root, rel)}));
    await writeFile(files[0].fullPath, JSON.stringify({
      bomFormat: 'CycloneDX',
      components: [first, ...Array.from({length: 19_999}, () => other)],
    }));
    await writeFile(files[1].fullPath, JSON.stringify({bomFormat: 'CycloneDX', components: [first]}));
    const result = await analyzeLockfileAndSbom({manifests: [], lockfiles: new Map(), mountedSbomPaths: [],
      sbomFiles: files, ncuDetectedPackages: new Set(), registry: {path: '', versions: {foo: '2.0.0'}}});
    assert.deepEqual(result.findings.map(f => f.file), ['first']);
    assert.ok(result.coverage.some(row => row.status === 'ok' && row.detail.includes('sbom=first; componentes=20000;')));
    assert.ok(result.coverage.some(row => row.status === 'skipped' &&
      row.detail.includes('sbom=later;') && row.detail.includes('motivo=limite_componentes_total')));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('jscodeshift distingue eventos incompletos, alterações sem prova, relatório ausente e timeout real', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dep-codemod-output-'));
  try {
    const isoSrcDir = join(root, 'src');
    const isoCodemodDir = join(root, 'dst');
    await mkdir(isoSrcDir);
    await mkdir(isoCodemodDir);
    const sourceFiles = ['incomplete.js', 'unchanged.js', 'gone.js', 'exit.js', 'hang.js', 'good.js']
      .map(rel => ({rel, fullPath: join(isoSrcDir, rel), ext: '.js'}));
    for (const source of sourceFiles) {
      await writeFile(source.fullPath, 'original();\n');
      await copyFile(source.fullPath, join(isoCodemodDir, source.rel));
    }
    const jscodeshiftBin = join(root, 'codemod-fixture');
    await writeFile(jscodeshiftBin, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const file = process.argv.at(-1), report = process.env.AC_JSCODESHIFT_REPORT;',
      'const event = {file,line:1,rule:"TEST-RULE",severity:"media",message:"synthetic",before:"original()",after:"different()",review:false};',
      'if (file.endsWith("/incomplete.js")) fs.writeFileSync(report, JSON.stringify({file}));',
      'if (file.endsWith("/unchanged.js")) fs.writeFileSync(report, JSON.stringify(event));',
      'if (file.endsWith("/gone.js")) fs.unlinkSync(report);',
      'if (file.endsWith("/exit.js")) process.exit(7);',
      'if (file.endsWith("/hang.js")) { fs.writeFileSync(file + ".started", "yes"); setInterval(() => {}, 100); }',
      'if (file.endsWith("/good.js")) fs.writeFileSync(report, JSON.stringify({...event,review:true}));',
    ].join('\n'));
    await chmod(jscodeshiftBin, 0o755);
    const options = {sourceFiles, isoSrcDir, isoCodemodDir, workRoot: root, jscodeshiftBin,
      jscodeshiftVersion: 'sintetica', transformPath: join(moduleDir, 'codemods/upgrade-rewrites.cjs')};
    const result = await runJscodeshiftCheck({...options, fileTimeoutMs: 1000});
    const details = new Map(result.coverage.slice(1).map(row => [row.detail.split(';')[0], row]));
    for (const [file, reason] of [['incomplete.js', 'relatorio_invalido'], ['unchanged.js', 'relatorio_invalido'],
      ['gone.js', 'relatorio_ilegivel'], ['exit.js', 'execucao; codigo=7'], ['hang.js', 'timeout; timeout_ms=1000; prazo=arquivo']]) {
      const row = details.get(`arquivo=${file}`);
      assert.equal(row?.status, 'failed', file);
      assert.ok(row?.detail.includes(`erro=${reason}`), row?.detail);
    }
    assert.equal(await readFile(join(isoCodemodDir, 'hang.js.started'), 'utf8'), 'yes');
    assert.deepEqual(result.findings.map(f => f.file), ['good.js']);
    assert.match(result.findings[0].evidence, /Revisão necessária/);

    const total = await runJscodeshiftCheck({...options, sourceFiles: sourceFiles.slice(-2), totalTimeoutMs: 500});
    assert.ok(total.coverage.some(row => row.status === 'failed' && /erro=timeout;.*prazo=total/.test(row.detail)));
    assert.ok(total.coverage.some(row => row.status === 'skipped' && row.detail.includes('arquivo=good.js; motivo=limite_tempo_total')));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('jscodeshift limita achados e bytes agregados mesmo com relatórios individuais dentro do limite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dep-codemod-limits-'));
  try {
    const sourceFiles = Array.from({length: 10}, (_, i) => ({rel: `file-${i}.js`, fullPath: join(root, `file-${i}.js`), ext: '.js'}));
    const jscodeshiftBin = join(root, 'codemod-fixture');
    const makeReport = [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const event = {file:process.argv.at(-1),line:1,rule:"TEST-RULE",severity:"media",message:"synthetic",before:BEFORE,review:true};',
      'fs.writeFileSync(process.env.AC_JSCODESHIFT_REPORT, (JSON.stringify(event)+"\\n").repeat(REPEAT));',
    ].join('\n');
    const options = {sourceFiles, isoSrcDir: root, isoCodemodDir: root, workRoot: root, jscodeshiftBin,
      jscodeshiftVersion: 'sintetica', transformPath: join(moduleDir, 'codemods/upgrade-rewrites.cjs')};

    await writeFile(jscodeshiftBin, makeReport.replace('BEFORE', '"short"').replace('REPEAT', '3000'), {mode: 0o755});
    const count = await runJscodeshiftCheck(options);
    assert.equal(count.findings.length, 5000);
    assert.equal(count.findings.filter(f => f.file === 'file-1.js').length, 2000);
    assert.ok(count.coverage.some(row => row.status === 'skipped' && row.detail.includes('arquivo=file-2.js; motivo=limite_achados_total')));

    await writeFile(jscodeshiftBin, makeReport.replace('BEFORE', '"x".repeat(2_000_000)').replace('REPEAT', '1'));
    const bytes = await runJscodeshiftCheck(options);
    assert.equal(bytes.findings.length, 8);
    assert.ok(bytes.coverage.some(row => row.status === 'skipped' && row.detail.includes('arquivo=file-8.js; motivo=limite_bytes_total')));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
