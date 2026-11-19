import assert from 'node:assert/strict';
import {execFile as execFileCb} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {EventEmitter} from 'node:events';
import {fetchLatestVersion, fetchRegistryVersion, type RegistryRequestOptions} from '../deploy/modules/dependencias/fetch-registry.mjs';
import {
  analyzeLockfileAndSbom,
  classifySemverRisk,
  discoverRepoFiles,
  findLineInPackageJson,
  parseAstGrepJson,
  resolveRegistrySnapshot,
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
const codemodHandshakeFixture = [
  'function writeReport(file, source, events = [], overrides = {}) {',
  '  const {AC_JSCODESHIFT_REPORT: report, AC_JSCODESHIFT_NONCE: nonce} = process.env;',
  '  const sha256 = require("node:crypto").createHash("sha256").update(source).digest("hex");',
  '  const header = {kind:"source",file,nonce,sha256,...overrides};',
  '  fs.writeFileSync(report, [header, ...events].map(event => JSON.stringify(event)).join("\\n")+"\\n");',
  '  return report;',
  '}',
].join('\n');

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
  assert.equal(lockResult.toolCount, 9);
  assert.equal(lockResult.totalLockedPackages, 132);
  assert.match(dockerfile, /^COPY schemas\/ \.\/schemas\//m);

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
        '  const before = "app.del(\'/items/:id\', (_req: any, res: any) => {";',
        '  const start = Buffer.byteLength(text.slice(0, text.indexOf(before)));',
        '  const range = {byteOffset:{start,end:start+Buffer.byteLength(before)},start:{line:1,column:2},end:{line:1,column:2+before.length}};',
        '  process.stdout.write(JSON.stringify([{ruleId:"express5-app-del-ts",severity:"error",message:"app.del removido",file:serverFile,range,text:before}]));',
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
        codemodHandshakeFixture,
        'const args = process.argv.slice(2);',
        'if (!args.includes("--run-in-band") || !args.includes("--fail-on-error") || !args.some(a => a.startsWith("--parser=")) || !args.includes("-t")) {',
        '  process.stderr.write("Invalid jscodeshift CLI args\\n");',
        '  process.exit(2);',
        '}',
        'const files = args.filter(a => a.endsWith(".js") || a.endsWith(".ts"));',
        'for (const f of files) {',
        '  const orig = fs.readFileSync(f, "utf8");',
        '  if (orig.includes("new Buffer(")) {',
        '    writeReport(f, orig, [{file:f,line:5,column:14,rule:"JSCODESHIFT-NODE-BUFFER-CTOR",severity:"alta",message:"new Buffer obsoleto",before:"new Buffer(payload)",after:"Buffer.from(payload)",review:false}]);',
        '    fs.writeFileSync(f, orig.replace("new Buffer(payload)", "Buffer.from(payload)"));',
        '  } else writeReport(f, orig);',
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
    await writeFile(join(root, 'syft.cdx.json'), JSON.stringify({bomFormat: 'CycloneDX', specVersion: '1.6', components: [
      {type: 'library', name: 'foo', version: '1.0.0', purl: 'pkg:pypi/foo@1.0.0'},
      {type: 'library', name: 'bad', version: '1.0.0', purl: 'pkg:npm/%ZZ@1.0.0'},
      {type: 'library', name: 'foo', version: '1.0.0', purl: 'pkg:npm/foo@1.0.0'},
      {type: 'library', name: 'foo', version: '1.8.0', purl: 'pkg:npm/foo@1.8.0'},
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
      'extra.mts': '// comentário\r\nconst í = "🐱"; res.send(\r\n  200, í\r\n);\r\n',
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
    assert.deepEqual(ast.findings.filter(f => f.file === 'extra.mts').map(f => [f.line, f.evidence]),
      [[2, 'Revisão necessária: res.send(\r\n  200, í\r\n)']]);
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

test('ast-grep atribui somente diagnósticos com trecho, bytes e posições Unicode confirmados', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dep-ast-lines-'));
  try {
    const invalidFiles = ['start-byte.ts', 'end-byte.ts', 'start-line.ts', 'end-line.ts',
      'start-column.ts', 'end-column.ts', 'text.ts', 'unicode.ts', 'invalid-utf8.ts'];
    const sourceFiles = ['valid.ts', ...invalidFiles, 'clean.ts']
      .map(rel => ({rel, fullPath: join(root, rel), ext: '.ts'}));
    const content = '// comentário\r\nconst í = "🐱"; res.send(\r\n  200, í\r\n);\r\n';
    for (const {rel, fullPath} of sourceFiles) {
      await writeFile(fullPath, rel === 'invalid-utf8.ts' ? Buffer.from([0xff]) : content);
    }
    const astGrepBin = join(root, 'ast-fixture');
    await writeFile(astGrepBin, [
      '#!/usr/bin/env node',
      'const target = process.argv[6];',
      'const {join} = require("node:path");',
      `const files = ${JSON.stringify(sourceFiles.map(src => src.rel))};`,
      'for (const file of files.filter(file => file !== "invalid-utf8.ts")) console.error(`sg: entity|file|${join(target,file)}: language=TypeScript,appliedRuleCount=1`);',
      'const diagnostic = name => ({file:join(target,name),ruleId:"synthetic-ts",severity:"error",',
      '  text:"res.send(\\r\\n  200, í\\r\\n)",range:{byteOffset:{start:35,end:58},start:{line:1,column:15},end:{line:3,column:1}}});',
      'const rows = [...files.filter(file => !["clean.ts","invalid-utf8.ts"].includes(file)), "unknown.ts"].map(diagnostic);',
      'rows[1].range.byteOffset.start++;',
      'rows[2].range.byteOffset.end = 1000;',
      'rows[3].range.start.line = 0;',
      'rows[4].range.end.line = 2;',
      'rows[5].range.start.column++;',
      'rows[6].range.end.column++;',
      'rows[7].text = rows[7].text.replace("200", "201");',
      'rows[8].range = {byteOffset:{start:29,end:32},start:{line:1,column:12},end:{line:1,column:12}};',
      'rows[8].text = "���";',
      'console.log(JSON.stringify(rows));',
      'process.exitCode = 1;',
    ].join('\n'), {mode: 0o755});
    const result = await runAstGrepCheck({sourceFiles, isoSrcDir: root, astGrepBin,
      astGrepVersion: 'sintetica', sgConfigPath: join(moduleDir, 'sgconfig.yml')});
    assert.deepEqual(result.findings.map(f => [f.file, f.line, f.evidence]),
      [['valid.ts', 2, 'Revisão necessária: res.send(\r\n  200, í\r\n)']]);
    assert.equal(result.coverage[0].status, 'failed');
    assert.match(result.coverage[0].detail, /falhas=9; diagnosticos_sem_arquivo=1/);
    for (const file of invalidFiles) {
      const error = file === 'invalid-utf8.ts' ? 'fonte_nao_utf8' : 'diagnostico_invalido';
      assert.ok(result.coverage.some(row => row.status === 'failed' &&
        row.detail.includes(`arquivo=${file}; erro=${error}`)), file);
    }
    assert.ok(result.coverage.some(row => row.status === 'ok' && row.detail.includes('arquivo=clean.ts; achados=0')));
    await writeFile(astGrepBin, '#!/usr/bin/env node\nprocess.exitCode = 2;\n');
    const failed = await runAstGrepCheck({sourceFiles, isoSrcDir: root, astGrepBin,
      astGrepVersion: 'sintetica', sgConfigPath: join(moduleDir, 'sgconfig.yml')});
    assert.match(failed.coverage[0].detail, /^exit=2; erro=/);
    assert.ok(failed.coverage.some(row => row.status === 'failed' &&
      row.detail === 'arquivo=invalid-utf8.ts; erro=fonte_nao_utf8'));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('consulta do registro termina em timeout ou limite de bytes com resposta sintética', async () => {
  let destroyed = false;
  const hanging = () => Object.assign(new EventEmitter(), {destroy() { destroyed = true; }});
  await assert.rejects(fetchLatestVersion('synthetic', {get: hanging, timeoutMs: 20}), /timeout/);
  assert.equal(destroyed, true);
  const oversized: NonNullable<RegistryRequestOptions['get']> = (_url, cb) => {
    const req = Object.assign(new EventEmitter(), {destroy() {}});
    const res = Object.assign(new EventEmitter(), {statusCode: 200, destroy() {}, resume() {}});
    queueMicrotask(() => { cb(res); res.emit('data', Buffer.alloc(20)); });
    return req;
  };
  await assert.rejects(fetchLatestVersion('synthetic', {get: oversized, timeoutMs: 1000, maxBytes: 10}), /limite de bytes/);
  for (const [statusCode, body] of [
    [404, ''], [503, ''], [200, '[]'],
    [200, JSON.stringify({name: '', version: '1.2.3'})],
    [200, JSON.stringify({name: '  ', version: '1.2.3'})],
  ] as const) {
    let responseClosed = false;
    let requestClosed = false;
    const get: NonNullable<RegistryRequestOptions['get']> = (_url, respond) => {
      const response = Object.assign(new EventEmitter(), {statusCode, destroy() { responseClosed = true; }, resume() {}});
      queueMicrotask(() => {
        respond(response);
        if (statusCode === 200) { response.emit('data', Buffer.from(body)); response.emit('end'); }
      });
      return Object.assign(new EventEmitter(), {destroy() { requestClosed = true; }});
    };
    const request = fetchRegistryVersion('synthetic', '1.2.3', {get});
    if (statusCode === 404) assert.equal(await request, null);
    else await assert.rejects(request, statusCode === 503 ? /HTTP 503/ : /metadados de versão inválidos/);
    if (statusCode !== 200) {
      assert.ok(responseClosed);
      assert.ok(requestClosed);
    }
  }
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
    const content = "const n = 10;\r\n\tnew Buffer(\r\n\t\tn); url.parse('/rota'); transport.send(200, body);";
    await writeFile(join(src, 'app.js'), content); await writeFile(join(dst, 'app.js'), content);
    const files = [{rel: 'app.js', fullPath: join(src, 'app.js'), ext: '.js'}];
    const js = await runJscodeshiftCheck({sourceFiles: files, isoSrcDir: src, isoCodemodDir: dst, workRoot: root, jscodeshiftBin: join(moduleDir, 'node_modules/.bin/jscodeshift'), jscodeshiftVersion: '17.4.0', transformPath: join(moduleDir, 'codemods/upgrade-rewrites.cjs')});
    assert.equal(await readFile(join(dst, 'app.js'), 'utf8'), content);
    assert.equal(js.findings.length, 2);
    assert.ok(js.findings.every(f => f.evidence.includes('Revisão necessária')));
    assert.deepEqual(js.findings.map(f => [f.line, f.evidence]), [
      [2, 'Revisão necessária: new Buffer(\r\n\t\tn)'],
      [3, "Revisão necessária: url.parse('/rota')"],
    ]);
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

test('jscodeshift 17.4.0 executa o transformador real em .mts e .cts sem alterar as cópias', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dep-codemod-typescript-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const isoSrcDir = join(root, 'src');
  const isoCodemodDir = join(root, 'codemod');
  await mkdir(isoSrcDir);
  await mkdir(isoCodemodDir);
  const samples = {
    'legacy.mts': "export const n: number = 8;\r\n\tnew Buffer(n);\r\n",
    'legacy.cts': "const path: string = '/test';\nurl.parse(path);\n",
    'modern.cts': "const data: string = '🐈';\r\nBuffer.from(data);\r\n",
  };
  const sourceFiles = [];
  for (const [rel, content] of Object.entries(samples)) {
    const fullPath = join(isoSrcDir, rel);
    await writeFile(fullPath, content);
    await writeFile(join(isoCodemodDir, rel), content);
    sourceFiles.push({rel, fullPath, ext: rel.slice(-4)});
  }
  const jscodeshiftBin = join(moduleDir, 'node_modules/.bin/jscodeshift');
  const transformPath = join(moduleDir, 'codemods/upgrade-rewrites.cjs');
  assert.match((await execFile(jscodeshiftBin, ['--version'])).stdout, /jscodeshift: 17\.4\.0/);
  const target = join(isoCodemodDir, 'modern.cts');
  const report = join(root, 'clean.ndjson');
  const nonce = 'clean-synthetic';
  const clean = await execFile(jscodeshiftBin,
    ['--run-in-band', '--fail-on-error', '--parser=ts', '--extensions=cts', '-t', transformPath, target],
    {env: {...process.env, AC_JSCODESHIFT_REPORT: report, AC_JSCODESHIFT_NONCE: nonce}});
  assert.match(clean.stdout, /0 errors[\s\S]+1 skipped[\s\S]+0 ok/);
  assert.deepEqual((await readFile(report, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line)), [{
    file: target, nonce, kind: 'source', sha256: createHash('sha256').update(samples['modern.cts']).digest('hex'),
  }]);

  const result = await runJscodeshiftCheck({sourceFiles, isoSrcDir, isoCodemodDir, workRoot: root,
    jscodeshiftBin, jscodeshiftVersion: '17.4.0', transformPath});
  assert.ok(result.coverage.every(row => row.status === 'ok'));
  assert.ok(result.coverage.some(row => row.detail === 'arquivo=modern.cts; correspondencias=0'));
  assert.deepEqual(result.findings.map(f => [f.file, f.line, f.evidence]), [
    ['legacy.mts', 2, 'Revisão necessária: new Buffer(n)'],
    ['legacy.cts', 2, 'Revisão necessária: url.parse(path)'],
  ]);
  for (const [rel, content] of Object.entries(samples)) {
    assert.deepEqual(await readFile(join(isoCodemodDir, rel)), Buffer.from(content));
    assert.deepEqual(await readFile(join(isoSrcDir, rel)), Buffer.from(content));
  }
});

test('lock do workspace prevalece e o achado aponta para a entrada efetivamente resolvida', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dep-workspace-'));
  try {
    await mkdir(join(root, 'packages/a/plugins/b'), {recursive: true});
    await writeFile(join(root, 'package.json'), '{"workspaces":{"packages":["packages/*","packages/a/plugins/b"]}}');
    await writeFile(join(root, 'packages/a/package.json'),
      '{"workspaces":["plugins/*"],"dependencies":{"foo":"^2.0.0","outdated":"^1.0.0","broken":"^2.0.0","ghost":"^1.0.0"}}');
    await writeFile(join(root, 'packages/a/package-lock.json'),
      '{"packages":{"node_modules/foo":{"version":"2.0.0"},"node_modules/broken":{"version":"2.0.0"},"node_modules/nested":{"version":"3.0.0"}}}');
    await writeFile(join(root, 'packages/a/plugins/b/package.json'), '{"dependencies":{"nested":"^1.0.0"}}');

    const lockText = [
      '{ "lockfileVersion": 2, "packages": {',
      '  "node_modules/foo": {"version":"2.2.0"}, "node_modules/outdated": {"version":"2.0.0"},',
      '  "packages/a/node_modules/foo": {"version":"1.0.0"},',
      '  "packages/a/node_modules/outdated": {"version":"1.0.0"},',
      '  "packages/a/node_modules/broken": 1,',
      '  "node_modules/broken": {"version":"2.0.0"},',
      '  "packages/a/plugins/b/node_modules/nested": {"version":"1.0.0"}',
      '}, "dependencies": {"ghost": {"version":"1.0.0"}} }',
    ].join('\n');
    await writeFile(join(root, 'package-lock.json'), lockText);
    const found = await discoverRepoFiles(root);
    const result = await analyzeLockfileAndSbom({...found, mountedSbomPaths: [], ncuDetectedPackages: new Set(),
      registry: {path: '', versions: {foo: '2.2.0', outdated: '2.0.0', nested: '1.5.0'}}});
    const mismatch = result.findings.find(finding => finding.rule === 'LOCKFILE-VERSION-MISMATCH');
    assert.equal(mismatch?.file, 'package-lock.json');
    assert.equal(mismatch?.line, 3);
    assert.match(mismatch?.evidence ?? '', /packages\/a\/node_modules\/foo/);
    const outdated = result.findings.find(finding => finding.rule === 'LOCKFILE-OUTDATED-RESOLVED');
    assert.equal(outdated?.line, 4);
    assert.match(outdated?.evidence ?? '', /packages\/a\/node_modules\/outdated/);
    assert.ok(result.findings.some(finding => finding.rule === 'LOCKFILE-OUTDATED-RESOLVED' &&
      finding.file === 'package-lock.json' && finding.line === 7 &&
      finding.evidence.includes('packages/a/plugins/b/node_modules/nested')));
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
    assert.ok(missing.findings.some(finding => finding.rule === 'LOCKFILE-MISSING' &&
      finding.file === 'packages/a/plugins/b/package.json' && finding.evidence.endsWith('diretório raiz.')));

    await writeFile(join(root, 'package-lock.json'), '{"packages":{"node_modules/foo":{"version":"2.0.0"}}}');
    await writeFile(join(root, 'npm-shrinkwrap.json'), lockText);
    const withShrinkwrap = await discoverRepoFiles(root);
    const byShrinkwrap = await analyzeLockfileAndSbom({...withShrinkwrap, mountedSbomPaths: [], registry: null, ncuDetectedPackages: new Set()});
    assert.ok(byShrinkwrap.findings.some(finding => finding.rule === 'LOCKFILE-VERSION-MISMATCH' &&
      finding.file === 'npm-shrinkwrap.json' && finding.line === 3));

    const registryPath = join(root, 'registry.json');
    await writeFile(registryPath, '{"outdated":"2.0.0","nested":"1.5.0"}');
    const collected = await runCollection({repoRoot: root, registryPath,
      ncuBin: join(moduleDir, 'node_modules/.bin/ncu'), ncuVersion: '23.1.1',
      astGrepVersion: 'sintetica', jscodeshiftVersion: 'sintetica'});
    const updates = collected.findings.filter(f => f.rule.startsWith('NCU-OUTDATED'));
    assert.deepEqual(updates.map(f => f.file), ['packages/a/package.json', 'packages/a/plugins/b/package.json']);
    assert.match(updates[0].evidence, /npm-shrinkwrap\.json#packages\/a\/node_modules\/outdated="1.0.0"; registro="2.0.0"/);
    assert.match(updates[1].evidence, /npm-shrinkwrap\.json#packages\/a\/plugins\/b\/node_modules\/nested="1.0.0"; registro="1.5.0"/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('ncu isola propostas inválidas, preserva propostas válidas e exige identidade travada do alias', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dep-ncu-output-'));
  try {
    for (const name of ['bad-type', 'bad-name', 'bad-range', 'bad-registry', 'bad-json', 'valid']) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, 'package.json'),
        JSON.stringify({name, dependencies: {foo: '^1.0.0', bar: '^1.0.0', repo: 'github:example/test#semver:^1.0.0'}}));
      await writeFile(join(root, name, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, packages: {
        'node_modules/foo': {version: '1.0.0'}, 'node_modules/bar': {version: '1.0.0'},
      }}));
    }
    const registryPath = join(root, 'registry.json');
    await writeFile(registryPath, '{"foo":"2.0.0","bar":"2.0.0","repo":"2.0.0"}');
    const fake = join(root, 'ncu-fixture');
    await writeFile(fake, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const file = process.argv[process.argv.indexOf("--packageFile") + 1];',
      'const {name, dependencies} = JSON.parse(fs.readFileSync(file));',
      'if (dependencies.repo || process.env.NPM_CONFIG_OFFLINE !== "true") process.exit(4);',
      'const messages = {"bad-type":{foo:{version:"2.0.0"}},"bad-name":{other:"2.0.0"},',
      '  "bad-range":{foo:"stable"},"bad-registry":{foo:"^999.0.0"},valid:{}};',
      'process.stdout.write(name === "bad-json" ? "{" : JSON.stringify({...messages[name],bar:"^2.0.0"}));',
    ].join('\n'));
    await chmod(fake, 0o755);
    const output = await runCollection({repoRoot: root, registryPath, ncuBin: fake,
      ncuVersion: 'sintetica', astGrepVersion: 'sintetica', jscodeshiftVersion: 'sintetica'});
    for (const [name, detail, status] of [
      ['bad-type', 'pacote=foo; erro=tipo_alvo_invalido', 'failed'],
      ['bad-name', 'pacote=other; erro=pacote_nao_declarado', 'failed'],
      ['bad-range', 'pacote=foo; secao=dependencies; motivo=alvo_nao_comparavel', 'skipped'],
      ['bad-registry', 'pacote=foo; secao=dependencies; motivo=alvo_nao_confirmado_no_registro', 'skipped'],
      ['bad-json', 'Saída JSON inválida', 'failed'],
    ]) {
      assert.ok(output.coverage.some(row => row.tool === 'npm-check-updates' && row.status === status &&
        row.detail.startsWith(`arquivo=${name}/package.json;`) && row.detail.includes(detail)), name);
    }
    assert.deepEqual(output.findings.filter(f => f.rule.startsWith('NCU-OUTDATED')).map(f => f.file),
      ['bad-name/package.json', 'bad-range/package.json', 'bad-registry/package.json', 'bad-type/package.json', 'valid/package.json']);

    const aliasRepo = join(root, 'alias');
    await mkdir(aliasRepo);
    await writeFile(join(aliasRepo, 'package.json'), JSON.stringify({dependencies: {
      'local-name': 'npm:foo@^1.0.0', 'unverified': 'npm:foo@^1.0.0',
      'different': 'npm:foo@^1.0.0', 'incompatible': 'npm:foo@^1.0.0',
    }}));
    const options = {repoRoot: aliasRepo, registryPath,
      ncuBin: join(moduleDir, 'node_modules/.bin/ncu'), ncuVersion: '23.1.1',
      astGrepVersion: 'sintetica', jscodeshiftVersion: 'sintetica'};
    const noLock = await runCollection(options);
    assert.ok(noLock.coverage.some(row => row.tool === 'npm-check-updates' &&
      row.status === 'skipped' && row.detail.includes('pacote=local-name; secao=dependencies; motivo=lockfile_ausente')));
    assert.ok(!noLock.findings.some(f => f.rule.startsWith('NCU-OUTDATED')));
    await writeFile(join(aliasRepo, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, packages: {
      'node_modules/local-name': {name: 'foo', version: '1.0.0'},
      'node_modules/unverified': {version: '1.0.0'},
      'node_modules/different': {name: 'bar', version: '1.0.0'},
      'node_modules/incompatible': {name: 'foo', version: '0.9.0'},
    }}));
    const real = await runCollection(options);
    assert.deepEqual(real.findings.filter(f => f.rule.includes('OUTDATED')).map(f => f.evidence),
      ['dependencies: "local-name": "npm:foo@^1.0.0" -> "local-name": "npm:foo@^2.0.0"; package-lock.json#node_modules/local-name="1.0.0"; registro="2.0.0"']);
    const {stdout: exactOutput} = await execFile(options.ncuBin,
      ['--jsonUpgraded', '--removeRange', '--registryType', 'json', '--registry', registryPath, '--packageFile', join(aliasRepo, 'package.json')],
      {cwd: aliasRepo, env: {...process.env, NPM_CONFIG_OFFLINE: 'true', NO_UPDATE_NOTIFIER: '1'}});
    assert.equal(JSON.parse(exactOutput)['local-name'], 'npm:foo@2.0.0');
    assert.ok(real.coverage.some(row => row.tool === 'npm-check-updates' && row.status === 'skipped' &&
      row.detail.includes('pacote=incompatible; secao=dependencies; motivo=versao_travada_incompativel_com_declaracao')));
    assert.ok(real.findings.some(f => f.rule === 'LOCKFILE-VERSION-MISMATCH' && f.message.includes('"incompatible"')));
    for (const tool of ['npm-check-updates', 'sbom-lockfile']) {
      for (const [pkg, reason] of [['unverified', 'identidade_alias_nao_comprovada'], ['different', 'identidade_lockfile_divergente']]) {
        assert.ok(real.coverage.some(row => row.tool === tool && row.status === 'skipped' &&
          row.detail.includes(`pacote=${pkg};`) && row.detail.includes(`motivo=${reason}`)), `${tool}/${pkg}`);
      }
    }
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('ncu comprova avanço semver por seção e preserva as análises de lock das propostas omitidas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dep-ncu-direction-'));
  try {
    const manifest = {
      dependencies: {
        backward: '3.0.0', reducedFloor: '>=1.6.0 <2', union: '^3.0.0 || ^1.0.0',
        renamed: 'npm:real@^1.0.0', gitRef: 'github:example/repo#semver:^1.0.0',
        local: 'file:../local', tagged: 'stable', pin: '1.0.0', range: '^1.0.0',
        same: '1.0.0+build.1', pre: '2.0.0-beta.1', shared: '^1.0.0',
        installedAhead: '^1.0.0', installedEqual: '^1.0.0', lowerBranch: '^1.0.0',
        actualRisk: '>=1.0.0', incompatible: '^1.0.0', wrongName: '^1.0.0', missingEntry: '^1.0.0',
      },
      devDependencies: {shared: '>=1.5.0'},
    };
    const releases = {
      backward: '2.0.0', reducedFloor: '1.9.0', union: '2.0.0', real: '2.0.0',
      renamed: '6.0.0', local: '9.0.0', pin: '1.0.1', range: '1.2.0',
      same: '1.0.0+build.2', pre: '2.0.0', shared: '1.7.0',
      installedAhead: '1.6.0', installedEqual: '1.6.0', lowerBranch: '2.1.0',
      actualRisk: '2.5.0', incompatible: '2.1.0', wrongName: '2.1.0', missingEntry: '2.1.0',
    };
    const targets = {
      backward: '2.0.0', reducedFloor: '>=1.2.0 <2', union: '^2.0.0',
      renamed: 'npm:another@^6.0.0', pin: '1.0.1', range: '^1.2.0',
      same: '1.0.0+build.2', pre: '2.0.0', shared: '^1.5.0',
      installedAhead: '^1.6.0', installedEqual: '^1.6.0', lowerBranch: '^2.0.0 || ^1.5.0',
      actualRisk: '^2.5.0', incompatible: '^2.1.0', wrongName: '^2.1.0', missingEntry: '^2.1.0',
    };
    const manifestText = JSON.stringify(manifest, null, 2);
    await writeFile(join(root, 'package.json'), manifestText);
    const versions = {
      backward: '3.0.0', reducedFloor: '1.7.0', union: '1.0.0', renamed: '1.0.0',
      gitRef: '1.0.0', local: '1.0.0', tagged: '1.0.0', pin: '1.0.0', range: '1.0.0',
      same: '1.0.0+build.1', pre: '2.0.0-beta.1', shared: '1.6.0',
      installedAhead: '1.8.0', installedEqual: '1.6.0', lowerBranch: '1.6.0',
      actualRisk: '2.4.0', incompatible: '0.9.0', wrongName: '1.5.0',
    };
    const packages = Object.fromEntries(Object.entries(versions).map(([pkg, version]) =>
      [`node_modules/${pkg}`, pkg === 'wrongName' ? {name: 'another', version} : {version}]));
    const lockText = JSON.stringify({lockfileVersion: 3, packages}, null, 2);
    await writeFile(join(root, 'package-lock.json'), lockText);
    const registryPath = join(root, 'registry.json');
    await writeFile(registryPath, JSON.stringify(releases));
    const ncuBin = join(root, 'ncu-fixture');
    await writeFile(ncuBin, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const file = process.argv[process.argv.indexOf("--packageFile") + 1];',
      'const {dependencies} = JSON.parse(fs.readFileSync(file));',
      'if (["gitRef","local","tagged"].some(name => Object.hasOwn(dependencies,name))) process.exit(4);',
      `process.stdout.write(JSON.stringify(${JSON.stringify(targets)}));`,
    ].join('\n'), {mode: 0o755});
    const result = await runCollection({repoRoot: root, registryPath, ncuBin, onlineMode: false,
      ncuVersion: 'sintetica', astGrepVersion: 'sintetica', jscodeshiftVersion: 'sintetica'});
    const ncu = result.findings.filter(f => f.rule.startsWith('NCU-OUTDATED'));
    assert.deepEqual(ncu.map(f => f.evidence), [
      'dependencies: "pin": "1.0.0" -> "pin": "1.0.1"; package-lock.json#node_modules/pin="1.0.0"; registro="1.0.1"',
      'dependencies: "range": "^1.0.0" -> "range": "^1.2.0"; package-lock.json#node_modules/range="1.0.0"; registro="1.2.0"',
      'dependencies: "pre": "2.0.0-beta.1" -> "pre": "2.0.0"; package-lock.json#node_modules/pre="2.0.0-beta.1"; registro="2.0.0"',
      'dependencies: "actualRisk": ">=1.0.0" -> "actualRisk": "^2.5.0"; package-lock.json#node_modules/actualRisk="2.4.0"; registro="2.5.0"',
    ]);
    assert.deepEqual(ncu.map(f => f.rule), ['NCU-OUTDATED-PATCH', 'NCU-OUTDATED-MINOR', 'NCU-OUTDATED-PATCH', 'NCU-OUTDATED-MINOR']);
    const lock = result.findings.filter(f => f.rule === 'LOCKFILE-OUTDATED-RESOLVED');
    assert.deepEqual(lock.map(f => /#node_modules\/([^:]+):/.exec(f.evidence)?.[1]), ['reducedFloor', 'union', 'shared', 'lowerBranch', 'shared']);
    assert.ok(result.coverage.some(row => row.status === 'skipped' &&
      row.detail.includes('pacote=backward; secao=dependencies; motivo=direcao_de_atualizacao_nao_comprovada')));
    for (const [pkg, reason] of [
      ['renamed', 'identidade_alterada'],
      ['gitRef', 'declaracao_nao_comparavel'], ['local', 'declaracao_nao_comparavel'], ['tagged', 'declaracao_nao_comparavel'],
      ['installedAhead', 'registro_nao_supera_versao_travada'], ['installedEqual', 'registro_nao_supera_versao_travada'],
      ['lowerBranch', 'alvo_admite_versao_inferior_ao_lock'], ['shared', 'alvo_admite_versao_inferior_ao_lock'],
      ['incompatible', 'versao_travada_incompativel_com_declaracao'], ['wrongName', 'identidade_lockfile_divergente'],
      ['missingEntry', 'entrada_lockfile_ausente'],
    ]) {
      assert.ok(result.coverage.some(row => row.status === 'skipped' &&
        row.detail.includes(`pacote=${pkg}; secao=dependencies; motivo=${reason}`)), pkg);
    }
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), manifestText);
    assert.equal(await readFile(join(root, 'package-lock.json'), 'utf8'), lockText);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('ncu offline exige catálogo válido e omite propostas sem lock npm comprovável', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dep-ncu-lock-utf8-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const [missingLock, invalidLock] = ['missing-lock', 'invalid-lock'].map(name => join(root, name));
  for (const dir of [missingLock, invalidLock]) {
    await mkdir(dir);
    await writeFile(join(dir, 'package.json'), '{"dependencies":{"foo":"^1.0.0"}}');
  }
  const lockBytes = Buffer.concat([
    Buffer.from('{"lockfileVersion":3,"name":"'), Buffer.from([0xff]),
    Buffer.from('","packages":{"node_modules/foo":{"version":"1.0.0"}}}'),
  ]);
  await writeFile(join(invalidLock, 'package-lock.json'), lockBytes);
  const registryPath = join(root, 'catalog.json');
  const options = {repoRoot: root, registryPath, onlineMode: false,
    ncuBin: join(moduleDir, 'node_modules/.bin/ncu'), ncuVersion: '23.1.1',
    astGrepVersion: 'sintetica', jscodeshiftVersion: 'sintetica'};
  const withoutCatalog = await runCollection({...options, ncuBin: join(root, 'nao-executar')});
  assert.deepEqual(withoutCatalog.coverage.filter(row => row.tool === 'npm-check-updates').map(row => [row.status, row.detail]),
    [['skipped', 'modo=offline-json; motivo=registro_ausente; prova_parcial=true']]);
  await writeFile(registryPath, Buffer.concat([
    Buffer.from('{"foo":"2.0.0","'), Buffer.from([0xff]), Buffer.from('":"1.0.0"}'),
  ]));
  const invalidCatalog = await runCollection({...options, ncuBin: join(root, 'nao-executar')});
  assert.deepEqual(invalidCatalog.coverage.filter(row => row.tool === 'npm-check-updates').map(row => [row.status, row.detail]),
    [['skipped', 'modo=offline-json; motivo=registro_invalido; prova_parcial=true']]);

  await writeFile(registryPath, '{"foo":"2.0.0"}');
  const result = await runCollection(options);
  assert.deepEqual(result.coverage.filter(row => row.tool === 'npm-check-updates' && row.detail.includes('pacote=foo'))
    .map(row => [row.status, row.detail]), [
    ['skipped', 'arquivo=invalid-lock/package.json; pacote=foo; secao=dependencies; motivo=lockfile_nao_verificavel; prova_parcial=true'],
    ['skipped', 'arquivo=missing-lock/package.json; pacote=foo; secao=dependencies; motivo=lockfile_ausente; prova_parcial=true'],
  ]);
  assert.ok(!result.coverage.some(row => row.tool === 'npm-check-updates' && row.status === 'failed'));
  assert.ok(!result.findings.some(f => f.rule.startsWith('NCU-OUTDATED')));
  assert.ok(result.findings.some(f => f.rule === 'LOCKFILE-INVALID-JSON' &&
    f.evidence === 'invalid-lock/package-lock.json: lockfile_nao_utf8'));
  assert.ok(result.findings.some(f => f.rule === 'LOCKFILE-MISSING' && f.file === 'missing-lock/package.json'));
  assert.deepEqual(await readFile(join(invalidLock, 'package-lock.json')), lockBytes);
  await writeFile(registryPath, '{"foo":"sem-versao"}');
  const unusable = await runCollection({...options, ncuBin: join(root, 'nao-executar')});
  assert.ok(unusable.coverage.some(row => row.tool === 'npm-check-updates' && row.status === 'skipped'
    && row.detail.includes('registro_sem_versoes_validas')));
  assert.equal(unusable.coverage.some(row => row.tool === 'npm-check-updates' && row.status === 'failed'), false);

});

test('ncu online confirma a publicação exata para npm e alias com catálogo local ausente ou desatualizado', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dep-ncu-online-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const dependencies = {
    ordinary: '^1.0.0', regress: '^1.0.0', alias: 'npm:@synthetic/actual@>=1.0.0',
    identity: '1.0.0', unpublished: '1.0.0', error: '1.0.0', skipRange: '1.0.0',
    git: 'github:example/repo#semver:^1.0.0',
  };
  await writeFile(join(root, 'package.json'), JSON.stringify({dependencies}));
  const packages = Object.fromEntries(Object.keys(dependencies).map(pkg => [`node_modules/${pkg}`, {version: '1.0.0'}]));
  packages['node_modules/ordinary'] = {version: '1.8.0'};
  packages['node_modules/regress'] = {version: '1.8.0'};
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, packages: {
    ...packages, 'node_modules/alias': {name: '@synthetic/actual', version: '3.1.0'},
  }}));
  const ncuBin = join(root, 'ncu-fixture');
  await writeFile(ncuBin, [
    '#!/usr/bin/env node',
    'const fs = require("node:fs"); const args = process.argv.slice(2);',
    'const arg = flag => args[args.indexOf(flag) + 1];',
    'const {dependencies} = JSON.parse(fs.readFileSync(arg("--packageFile")));',
    'const config = fs.readFileSync(process.env.NPM_CONFIG_USERCONFIG, "utf8");',
    'if (arg("--registryType") !== "npm" || arg("--registry") !== "https://registry.npmjs.org/" ||',
    '  !args.includes("--removeRange") || dependencies.git || process.env.NPM_CONFIG_OFFLINE === "true" ||',
    '  config !== "@synthetic:registry=https://registry.npmjs.org/\\n") process.exit(2);',
    'console.log(JSON.stringify({ordinary:"1.8.1",regress:"1.7.0",alias:"npm:@synthetic/actual@3.1.1",',
    '  identity:"2.0.0",unpublished:"2.0.0",error:"2.0.0",skipRange:"^2.0.0"}));',
  ].join('\n'), {mode: 0o755});
  const queries: string[] = [];
  const registryGet: NonNullable<RegistryRequestOptions['get']> = (url, respond) => {
    queries.push(url);
    const [pkg, version] = new URL(url).pathname.slice(1).split('/').map(decodeURIComponent);
    const statusCode = pkg === 'error' ? 503 : pkg === 'unpublished' ? 404 : 200;
    const res = Object.assign(new EventEmitter(), {statusCode, destroy() {}, resume() {}});
    queueMicrotask(() => {
      respond(res);
      if (statusCode === 200) {
        res.emit('data', Buffer.from(JSON.stringify({name: pkg === 'identity' ? 'other' : pkg, version})));
        res.emit('end');
      }
    });
    return Object.assign(new EventEmitter(), {destroy() {}});
  };
  const registryPath = join(root, 'catalog.json');
  const options = {repoRoot: root, onlineMode: true, registryPath, registryGet, ncuBin,
    ncuVersion: 'sintetica', astGrepVersion: 'sintetica', jscodeshiftVersion: 'sintetica'};
  const expected = [
    ['NCU-OUTDATED-PATCH', 'dependencies: "ordinary": "^1.0.0" -> "ordinary": "1.8.1"; package-lock.json#node_modules/ordinary="1.8.0"; registro="1.8.1"; origem=https://registry.npmjs.org/'],
    ['NCU-OUTDATED-PATCH', 'dependencies: "alias": "npm:@synthetic/actual@>=1.0.0" -> "alias": "npm:@synthetic/actual@3.1.1"; package-lock.json#node_modules/alias="3.1.0"; registro="3.1.1"; origem=https://registry.npmjs.org/'],
  ];
  const result = await runCollection(options);
  assert.deepEqual(result.findings.filter(f => f.rule.startsWith('NCU-OUTDATED')).map(f => [f.rule, f.evidence]), expected);
  for (const [pkg, reason] of [['identity', 'alvo_nao_confirmado_no_registro'], ['unpublished', 'alvo_nao_confirmado_no_registro'], ['regress', 'alvo_exato_nao_supera_lock'],
    ['skipRange', 'alvo_online_sem_versao_exata'], ['git', 'declaracao_nao_comparavel']]) {
    assert.ok(result.coverage.some(row => row.tool === 'npm-check-updates' && row.status === 'skipped' &&
      row.detail.includes(`pacote=${pkg}; secao=dependencies; motivo=${reason}`)), pkg);
  }
  const failures = result.coverage.filter(row => row.tool === 'npm-check-updates' && row.status === 'failed');
  assert.equal(failures.length, 3);
  assert.ok(failures.some(row => row.detail.includes('pacote=error; secao=dependencies; erro=consulta_registro_online; detalhe=HTTP 503')));
  assert.deepEqual(queries, [
    'https://registry.npmjs.org/ordinary/1.8.1', 'https://registry.npmjs.org/%40synthetic%2Factual/3.1.1',
    'https://registry.npmjs.org/identity/2.0.0', 'https://registry.npmjs.org/unpublished/2.0.0',
    'https://registry.npmjs.org/error/2.0.0',
  ]);
  await writeFile(registryPath, '{"ordinary":"9.0.0","@synthetic/actual":"1.0.0"}');
  const stale = await runCollection(options);
  assert.deepEqual(stale.findings.filter(f => f.rule.startsWith('NCU-OUTDATED')).map(f => [f.rule, f.evidence]), expected);
});

test('lock npm usa a identidade de aliases modernos e legados e preserva versões fora de semver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dep-lock-alias-'));
  try {
    await mkdir(join(root, 'legacy'));
    await writeFile(join(root, 'package.json'), JSON.stringify({dependencies: {
      local: 'npm:real@^1.0.0', scoped: 'npm:@scope/real@^1.0.0',
      wrong: 'npm:@scope/real@^1.0.0', opaque: '^1.0.0', mismatch: 'npm:real@^2.0.0',
    }}));
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, packages: {
      'node_modules/local': {name: 'real', version: '1.0.0'},
      'node_modules/scoped': {name: '@scope/real', version: '1.0.0'},
      'node_modules/wrong': {name: 'other', version: '1.0.0'},
      'node_modules/opaque': {version: 'release-1'},
      'node_modules/mismatch': {name: 'real', version: '1.0.0'},
    }}, null, 2));
    await writeFile(join(root, 'legacy/package.json'),
      '{"dependencies":{"legacy":"npm:@scope/real@^1.0.0","unverified":"npm:@scope/real@^1.0.0"}}');
    await writeFile(join(root, 'legacy/package-lock.json'),
      '{\n  "lockfileVersion": 1,\n  "dependencies": {\n    "legacy": {"version":"npm:@scope/real@1.0.0"},\n    "unverified": {"version":"1.0.0"}\n  }\n}');
    const found = await discoverRepoFiles(root);
    const result = await analyzeLockfileAndSbom({...found, mountedSbomPaths: [], ncuDetectedPackages: new Set(),
      registry: {path: '', versions: {local: '5.0.0', real: '1.0.0', '@scope/real': '1.2.0', opaque: '5.0.0'}}});
    assert.deepEqual(result.findings.map(f => [f.rule, f.file, f.line]), [
      ['LOCKFILE-OUTDATED-RESOLVED', 'legacy/package-lock.json', 4],
      ['LOCKFILE-OUTDATED-RESOLVED', 'package-lock.json', 8],
      ['LOCKFILE-VERSION-MISMATCH', 'package-lock.json', 19],
    ]);
    assert.ok(result.findings.slice(0, 2).every(f => f.evidence.includes('registro="@scope/real"')));
    assert.ok(result.coverage.some(row => row.status === 'skipped' && row.detail.includes('pacote=wrong;') &&
      row.detail.includes('motivo=identidade_lockfile_divergente')));
    assert.ok(result.coverage.some(row => row.status === 'skipped' && row.detail.includes('pacote=opaque;') &&
      row.detail.includes('motivo=faixa_ou_versao_nao_semver')));
    assert.ok(result.coverage.some(row => row.status === 'skipped' && row.detail.includes('pacote=unverified;') &&
      row.detail.includes('motivo=identidade_alias_nao_comprovada')));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('registro padrão ausente, JSON inválido e fallback válido produzem resultados distintos', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dep-registry-fallback-'));
  const configured = process.env.AC_DEPENDENCIAS_REGISTRY;
  delete process.env.AC_DEPENDENCIAS_REGISTRY;
  t.after(async () => {
    if (configured !== undefined) process.env.AC_DEPENDENCIAS_REGISTRY = configured;
    await rm(root, {recursive: true, force: true});
  });
  const [missing, broken, good] = ['missing', 'bad', 'good'].map(name => join(root, name));
  await writeFile(broken, '{');
  await writeFile(good, '{"foo":"2.0.0"}');
  assert.equal(await resolveRegistrySnapshot(undefined, [missing]), null);
  const registry = await resolveRegistrySnapshot(undefined, [missing, broken]);
  assert.deepEqual(registry, {path: broken, versions: {}, error: 'registro_invalido'});
  assert.deepEqual(await resolveRegistrySnapshot(undefined, [broken, good]),
    {path: good, versions: {foo: '2.0.0'}});
  assert.deepEqual(await resolveRegistrySnapshot(broken, [good]),
    {path: broken, versions: {}, error: 'registro_invalido'});
  const bom = join(root, 'sbom.cdx.json');
  await writeFile(bom, JSON.stringify({bomFormat: 'CycloneDX', specVersion: '1.6', components: [
    {type: 'library', name: 'foo', purl: 'pkg:npm/foo@1.0.0'},
  ]}));
  const result = await analyzeLockfileAndSbom({manifests: [], lockfiles: new Map(), mountedSbomPaths: [],
    sbomFiles: [{rel: 'sbom.cdx.json', fullPath: bom}], registry, ncuDetectedPackages: new Set()});
  assert.equal(result.coverage[0].status, 'failed');
  assert.ok(result.coverage.some(row => row.detail === 'registro=offline; erro=registro_invalido'));
});

test('CycloneDX preserva componentes aninhados e distingue inventário vazio, entradas inválidas e metadados', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dep-cyclonedx-'));
  try {
    const report = (name: string, doc: unknown) => writeFile(join(root, name), JSON.stringify(doc));
    const header = {bomFormat: 'CycloneDX', specVersion: '1.6'};
    await report('bom-empty', header);
    await report('bom-missing-spec', {bomFormat: 'CycloneDX'});
    await report('bom-invalid', {...header, components: [
      null, {}, 42, {name: 'missing-type'}, {type: 'arbitrary', name: 'bad-type'},
      {type: 'application', name: 'bad-children', components: {}},
      {type: 'library', name: 'example', purl: 'pkg:npm/%40scope/example@1.0.0'},
    ]});
    await report('bom-identities', {...header, components: [
      {type: 'library', name: 'purl-error', purl: 'pkg:npm/%XX@1.0.0'},
      {type: 'library', name: 'conflict', version: '2.0.0', purl: 'pkg:npm/conflict@1.0.0'},
      {type: 'application', name: 'assembly', components: [{type: 'library', name: 'example', purl: 'pkg:npm/%40scope/example@1.0.0?arch=all'}]},
    ]});
    await report('bom-unavailable', {...header, components: [
      {type: 'library', name: 'invalid', purl: 'pkg:npm/invalid@1.0.0'},
      {type: 'library', name: 'absent', purl: 'pkg:npm/absent@1.0.0'},
      {type: 'library', name: 'other', purl: 'pkg:pypi/other@2', version: '2'},
    ]});
    await report('bom-metadata', {...header, metadata: {
      component: {type: 'application', name: 'app', components: [
        {type: 'library', name: 'foo', purl: 'pkg:npm/foo@1.0.0'},
      ]},
    }});
    await report('bom-metadata-invalid', {...header, metadata: {component: null}});
    await report('bom-opaque', {...header, components: [
      {type: 'library', name: 'foo', version: 'build-19', purl: 'pkg:npm/foo@build-19'},
    ]});
    const result = await analyzeLockfileAndSbom({manifests: [], lockfiles: new Map(), mountedSbomPaths: [],
      sbomFiles: ['bom-empty', 'bom-missing-spec', 'bom-invalid', 'bom-identities', 'bom-unavailable', 'bom-metadata', 'bom-metadata-invalid', 'bom-opaque']
        .map(rel => ({rel, fullPath: join(root, rel)})),
      ncuDetectedPackages: new Set(), registry: {path: '', versions: {'@scope/example': '2.0.0', foo: '2.0.0', invalid: 'inválida'}}});
    const empty = result.coverage.find(row => row.detail.startsWith('sbom=bom-empty;'));
    assert.equal(empty?.status, 'ok');
    assert.match(empty?.detail ?? '', /componentes=0/);
    assert.ok(result.coverage.some(row => row.status === 'failed' && row.detail === 'sbom=bom-missing-spec; erro=formato_invalido'));
    assert.ok(result.coverage.some(row => row.status === 'failed' && row.detail.includes('sbom=bom-metadata-invalid;')));
    assert.ok(result.coverage.some(row => row.status === 'ok' &&
      row.detail.includes('sbom=bom-metadata; componentes=2;') && row.detail.includes('achados=1')));
    assert.ok(result.coverage.some(row => row.status === 'skipped' &&
      row.detail.includes('sbom=bom-opaque;') && row.detail.includes('versao_componente_nao_comparavel=1')));
    const invalid = result.coverage.find(row => row.detail.startsWith('sbom=bom-invalid;'));
    assert.equal(invalid?.status, 'failed');
    assert.match(invalid?.detail ?? '', /erro=esquema_cyclonedx_invalido; versao=1.6; campo="\/components\/0"; regra=type/);
    const invalidIdentity = result.coverage.find(row => row.detail.startsWith('sbom=bom-identities;'));
    assert.equal(invalidIdentity?.status, 'failed');
    assert.match(invalidIdentity?.detail ?? '', /purl_npm_invalida=1/);
    assert.match(invalidIdentity?.detail ?? '', /versao_componente_invalida=1/);
    assert.deepEqual(result.findings.map(f => f.file), ['bom-identities', 'bom-metadata']);
    assert.match(result.findings[0].evidence, /@scope\/example@1.0.0 -> 2.0.0/);
    assert.match(result.findings[1].evidence, /foo@1.0.0 -> 2.0.0/);
    const unavailable = result.coverage.find(row => row.detail.startsWith('sbom=bom-unavailable;'));
    assert.equal(unavailable?.status, 'failed');
    assert.match(unavailable?.detail ?? '', /sem_metadados=2; metadados_invalidos=1/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('CycloneDX valida campos e referências conforme a versão declarada', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dep-cyclonedx-version-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const component = {type: 'library', name: 'foo', version: '1.0.0', purl: 'pkg:npm/foo@1.0.0'};
  const cases: {rel: string; specVersion: string; data: object; error?: RegExp}[] = [
    ...Array.from({length: 6}, (_, i) => ({
      rel: `valid-1.${i + 2}`, specVersion: `1.${i + 2}`, data: {version: 1, components: [component]},
    })),
    {rel: 'old-missing-version', specVersion: '1.4', data: {components: [component]}, error: /regra=required/},
    {rel: 'new-type-in-old-version', specVersion: '1.5', data: {
      components: [{...component, type: 'cryptographic-asset'}],
    }, error: /campo="\/components\/0\/type"; regra=enum/},
    {rel: 'bad-license', specVersion: '1.6', data: {
      components: [{...component, licenses: [{license: {id: 'not-a-license-list-value'}}]}],
    }, error: /campo="\/components\/0\/licenses\/0\/license\/id"; regra=enum/},
    {rel: 'bad-timestamp', specVersion: '1.7', data: {
      components: [component], metadata: {timestamp: 'yesterday'},
    }, error: /campo="\/metadata\/timestamp"; regra=format/},
    {rel: 'duplicated', specVersion: '1.6', data: {components: [
      component, {name: component.name, purl: component.purl, version: component.version, type: component.type},
    ]}, error: /campo="\/components"; regra=uniqueItems/},
    {rel: 'unsupported', specVersion: '9.9', data: {components: [component]},
      error: /erro=versao_cyclonedx_nao_suportada; versao="9.9"/},
  ];
  const sbomFiles = cases.map(({rel}) => ({rel, fullPath: join(root, rel)}));
  for (const {rel, specVersion, data} of cases) {
    await writeFile(join(root, rel), JSON.stringify({bomFormat: 'CycloneDX', specVersion, ...data}));
  }
  const result = await analyzeLockfileAndSbom({manifests: [], lockfiles: new Map(), mountedSbomPaths: [],
    sbomFiles, ncuDetectedPackages: new Set(), registry: {path: '', versions: {foo: '2.0.0'}}});
  assert.equal(result.coverage[0].status, 'failed');
  assert.deepEqual(result.findings.map(f => f.file), cases.filter(row => !row.error).map(row => row.rel));
  for (const {rel, error} of cases) {
    const row = result.coverage.find(c => c.detail.startsWith(`sbom=${rel};`));
    assert.equal(row?.status, error ? 'failed' : 'ok', rel);
    if (error) assert.match(row?.detail ?? '', error);
  }
});

test('limites de bytes preservam provas de outros SBOMs e distinguem artefatos desaparecidos', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dep-sbom-bytes-'));
  try {
    const large = Buffer.alloc(19 * 1024 * 1024, ' ');
    large.write('{"bomFormat":"CycloneDX","specVersion":"1.6"}');
    for (const name of ['volume-a', 'volume-b', 'volume-c', 'volume-d']) {
      await writeFile(join(root, name), large);
    }
    await writeFile(join(root, 'last'), '{"bomFormat":"CycloneDX","specVersion":"1.6","components":[{"type":"library","name":"foo","purl":"pkg:npm/foo@1.0.0"}]}');
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
    const first = {type: 'library', name: 'foo', purl: 'pkg:npm/foo@1.0.0'};
    const other = {type: 'library', name: 'non-npm', purl: 'pkg:pypi/non-npm@1.0.0'};
    const files = ['first', 'later'].map(rel => ({rel, fullPath: join(root, rel)}));
    await writeFile(files[0].fullPath, JSON.stringify({
      bomFormat: 'CycloneDX', specVersion: '1.6',
      components: [first, ...Array.from({length: 19_999}, (_, i) => ({...other, 'bom-ref': `other-${i}`}))],
    }));
    await writeFile(files[1].fullPath, JSON.stringify({bomFormat: 'CycloneDX', specVersion: '1.6', components: [first]}));
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
    const sourceFiles = ['incomplete.js', 'unchanged.js', 'gone.js', 'empty.js', 'wrong-nonce.js',
      'wrong-file.js', 'wrong-hash.js', 'review-line.js', 'review-text.js', 'review-changed.js',
      'nochange-changed.js', 'exit.js', 'hang.js', 'good.js']
      .map(rel => ({rel, fullPath: join(isoSrcDir, rel), ext: '.js'}));
    for (const source of sourceFiles) {
      await writeFile(source.fullPath, 'original();\n');
      await copyFile(source.fullPath, join(isoCodemodDir, source.rel));
    }
    const jscodeshiftBin = join(root, 'codemod-fixture');
    await writeFile(jscodeshiftBin, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      codemodHandshakeFixture,
      'const file = process.argv.at(-1), report = process.env.AC_JSCODESHIFT_REPORT;',
      'const source = fs.readFileSync(file, "utf8");',
      'const patch = {file,line:1,column:0,rule:"TEST-RULE",severity:"media",message:"synthetic",before:"original()",after:"different()",review:false};',
      'const review = {...patch,review:true};',
      'switch (require("node:path").basename(file)) {',
      '  case "incomplete.js": writeReport(file, source, [{file}]); break;',
      '  case "unchanged.js": writeReport(file, source, [patch]); break;',
      '  case "gone.js": break;',
      '  case "empty.js": fs.writeFileSync(report, ""); break;',
      '  case "wrong-nonce.js": writeReport(file, source, [], {nonce:"other-run"}); break;',
      '  case "wrong-file.js": writeReport(file, source, [review], {file:file+".other"}); break;',
      '  case "wrong-hash.js": writeReport(file, "other source"); break;',
      '  case "review-line.js": writeReport(file, source, [{...review,line:999}]); break;',
      '  case "review-text.js": writeReport(file, source, [{...review,before:"unrelated()"}]); break;',
      '  case "review-changed.js": writeReport(file, source, [review]); fs.writeFileSync(file, "wrong();"); break;',
      '  case "nochange-changed.js": writeReport(file, source); fs.writeFileSync(file, "wrong();"); break;',
      '  case "exit.js": process.exit(7);',
      '  case "hang.js": fs.writeFileSync(file + ".started", "yes"); setInterval(() => {}, 100); break;',
      '  case "good.js": writeReport(file, source, [review]); break;',
      '}',
    ].join('\n'));
    await chmod(jscodeshiftBin, 0o755);
    const options = {sourceFiles, isoSrcDir, isoCodemodDir, workRoot: root, jscodeshiftBin,
      jscodeshiftVersion: 'sintetica', transformPath: join(moduleDir, 'codemods/upgrade-rewrites.cjs')};
    const result = await runJscodeshiftCheck({...options, fileTimeoutMs: 1000});
    const details = new Map(result.coverage.slice(1).map(row => [row.detail.split(';')[0], row]));
    for (const [file, reason] of [['incomplete.js', 'relatorio_invalido'], ['unchanged.js', 'relatorio_invalido'],
      ['gone.js', 'relatorio_ilegivel'], ['exit.js', 'execucao; codigo=7'], ['hang.js', 'timeout; timeout_ms=1000; prazo=arquivo'],
      ...['empty.js', 'wrong-nonce.js', 'wrong-file.js', 'wrong-hash.js', 'review-line.js', 'review-text.js', 'review-changed.js', 'nochange-changed.js']
        .map(file => [file, 'relatorio_invalido'])]) {
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

test('jscodeshift comprova duas substituições na mesma linha e controle vazio com o binário fixado', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dep-codemod-same-line-'));
  try {
    const isoSrcDir = join(root, 'src');
    const isoCodemodDir = join(root, 'dst');
    await mkdir(isoSrcDir);
    await mkdir(isoCodemodDir);
    const sourceFiles = Object.entries({'patch.js': 'old(); old();\n', 'clean.js': 'clean();\n'})
      .map(([rel, content]) => ({rel, fullPath: join(isoSrcDir, rel), ext: '.js', content}));
    for (const {rel, fullPath, content} of sourceFiles) {
      await writeFile(fullPath, content);
      await copyFile(fullPath, join(isoCodemodDir, rel));
    }
    const transformPath = join(root, 'transform.cjs');
    await writeFile(transformPath, [
      'const fs = require("node:fs");',
      codemodHandshakeFixture,
      'module.exports = ({path: file,source}, {jscodeshift: j}) => {',
      '  const nodes = j(source).find(j.CallExpression, {callee:{name:"old"}}).nodes();',
      '  const events = nodes.map((node, index) => ({file,line:node.loc.start.line,column:node.loc.start.column,',
      '    rule:"TEST-REWRITE",severity:"baixa",message:"synthetic",before:"old()",after:`fresh${index}()`,review:false}));',
      '  writeReport(file, source, events.toReversed());',
      '  return source.replaceAll("old()", () => events.shift().after);',
      '};',
    ].join('\n'));
    const result = await runJscodeshiftCheck({sourceFiles, isoSrcDir, isoCodemodDir, workRoot: root,
      jscodeshiftBin: join(moduleDir, 'node_modules/.bin/jscodeshift'), jscodeshiftVersion: '17.4.0', transformPath});
    assert.deepEqual(result.findings.map(f => [f.file, f.line, f.evidence]), [
      ['patch.js', 1, 'Patch pronto:\n- old()\n+ fresh1()'],
      ['patch.js', 1, 'Patch pronto:\n- old()\n+ fresh0()'],
    ]);
    assert.equal(await readFile(join(isoCodemodDir, 'patch.js'), 'utf8'), 'fresh0(); fresh1();\n');
    assert.equal(await readFile(join(isoSrcDir, 'patch.js'), 'utf8'), 'old(); old();\n');
    assert.equal(await readFile(join(isoCodemodDir, 'clean.js'), 'utf8'), 'clean();\n');
    assert.ok(result.coverage.some(row => row.status === 'ok' && row.detail === 'arquivo=clean.js; correspondencias=0'));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('jscodeshift aplica o prazo total à validação e limpeza do último arquivo', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dep-codemod-deadline-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const rel = 'app.js';
  const fullPath = join(root, rel);
  const marker = join(root, 'fixture-returned');
  await writeFile(fullPath, 'original();\n');
  const jscodeshiftBin = join(root, 'codemod-fixture');
  await writeFile(jscodeshiftBin, [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    codemodHandshakeFixture,
    'const file = process.argv.at(-1);',
    'const report = writeReport(file, fs.readFileSync(file, "utf8"), [',
    '  {file,line:1,column:0,rule:"TEST-REVIEW",severity:"baixa",message:"synthetic",before:"original()",review:true},',
    ']);',
    'fs.writeFileSync(file.replace(/app\.js$/, "fixture-returned"), report);',
  ].join('\n'), {mode: 0o755});
  const options = {sourceFiles: [{rel, fullPath, ext: '.js'}], isoSrcDir: root, isoCodemodDir: root,
    workRoot: root, jscodeshiftBin, jscodeshiftVersion: 'sintetica',
    transformPath: join(moduleDir, 'codemods/upgrade-rewrites.cjs'), totalTimeoutMs: 1000};
  for (const phase of ['relatorio_invalido', 'limpeza_relatorio']) {
    let checksAfterExit = 0;
    const clock = t.mock.method(performance, 'now', () => {
      if (!existsSync(marker)) return 0;
      const report = readFileSync(marker, 'utf8');
      checksAfterExit += 1;
      const expired = phase === 'relatorio_invalido' ? checksAfterExit >= 4 : !existsSync(report);
      return expired ? 1100 : 0;
    });
    try {
      const result = await runJscodeshiftCheck(options);
      assert.ok(result.coverage.some(row => row.status === 'failed' &&
        row.detail.includes(`erro=timeout; timeout_ms=1000; prazo=total; fase=${phase}`)));
      assert.equal(result.findings.length, 0);
      assert.ok(!existsSync(readFileSync(marker, 'utf8')));
    } finally {
      clock.mock.restore();
      await rm(marker, {force: true});
    }
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
      codemodHandshakeFixture,
      'const file = process.argv.at(-1);',
      'const source = fs.readFileSync(file, "utf8");',
      'const event = {file,column:0,rule:"TEST-RULE",severity:"media",message:"synthetic",before:BEFORE,review:true};',
      'writeReport(file, source, Array.from({length:REPEAT}, (_, i) => ({...event,line:i+1})));',
    ].join('\n');
    const options = {sourceFiles, isoSrcDir: root, isoCodemodDir: root, workRoot: root, jscodeshiftBin,
      jscodeshiftVersion: 'sintetica', transformPath: join(moduleDir, 'codemods/upgrade-rewrites.cjs')};

    for (const file of sourceFiles) await writeFile(file.fullPath, 'short();\n'.repeat(3000));
    await writeFile(jscodeshiftBin, makeReport.replace('BEFORE', '"short"').replace('REPEAT', '3000'), {mode: 0o755});
    const count = await runJscodeshiftCheck(options);
    assert.equal(count.findings.length, 5000);
    assert.equal(count.findings.filter(f => f.file === 'file-1.js').length, 2000);
    assert.ok(count.coverage.some(row => row.status === 'skipped' && row.detail.includes('arquivo=file-2.js; motivo=limite_achados_total')));

    for (const file of sourceFiles) await writeFile(file.fullPath, 'x'.repeat(2_000_000));
    await writeFile(jscodeshiftBin, makeReport.replace('BEFORE', 'source').replace('REPEAT', '1'));
    const bytes = await runJscodeshiftCheck(options);
    assert.equal(bytes.findings.length, 8);
    assert.ok(bytes.coverage.some(row => row.status === 'skipped' && row.detail.includes('arquivo=file-8.js; motivo=limite_bytes_total')));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
