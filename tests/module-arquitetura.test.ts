import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  analyzeAstComplexity,
  buildKnipConfig,
  clampLine,
  copyRepoSafely,
  findImportLine,
  normalizeRepoPath,
  parseDepcruiseReport,
  parseJscpdComplexityReport,
  parseJscpdReport,
  parseKnipReport,
  runCollector,
} from '../deploy/modules/arquitetura/collect.mjs';

const moduleDir = fileURLToPath(new URL('../deploy/modules/arquitetura/', import.meta.url));
const cleanFixture = fileURLToPath(new URL('./fixtures/module-arquitetura/clean/', import.meta.url));
const defectiveFixture = fileURLToPath(new URL('./fixtures/module-arquitetura/defective/', import.meta.url));

const VALID_STATUSES = new Set(['ok', 'failed', 'skipped']);
const VALID_SEVERITIES = new Set(['alta', 'media', 'baixa', 'informativa']);

function assertValidOutputContract(output: {
  coverage: {tool: string; version: string; status: string; detail: string}[];
  findings: {tool: string; rule: string; file: string; line: number; severity: string; message: string; evidence: string}[];
}): void {
  assert.equal(Array.isArray(output.coverage), true);
  assert.equal(Array.isArray(output.findings), true);
  assert.ok(output.coverage.length >= 1);
  for (const row of output.coverage) {
    assert.equal(typeof row.tool, 'string');
    assert.ok(row.tool.length > 0);
    assert.equal(typeof row.version, 'string');
    assert.ok(row.version.length > 0);
    assert.equal(VALID_STATUSES.has(row.status), true, `status inválido: ${row.status}`);
    assert.equal(typeof row.detail, 'string');
    assert.ok(row.detail.length > 0);
  }
  for (const item of output.findings) {
    assert.equal(typeof item.tool, 'string');
    assert.ok(item.tool.length > 0);
    assert.equal(typeof item.rule, 'string');
    assert.ok(item.rule.length > 0);
    assert.equal(typeof item.file, 'string');
    assert.ok(item.file.length > 0);
    assert.equal(item.file.startsWith('/'), false, item.file);
    assert.equal(item.file.split('/').includes('..'), false, item.file);
    assert.equal(Number.isInteger(item.line), true);
    assert.ok(item.line >= 1);
    assert.equal(VALID_SEVERITIES.has(item.severity), true, `severidade inválida: ${item.severity}`);
    assert.equal(typeof item.message, 'string');
    assert.ok(item.message.length > 0);
    assert.equal(typeof item.evidence, 'string');
    assert.ok(item.evidence.length > 0);
  }
}

function hadolintOnPath(): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, 'hadolint');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

test('Dockerfile e lockfiles fixam base, ferramentas e integridade sem tags mutáveis', () => {
  const dockerfile = readFileSync(join(moduleDir, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^FROM\s+--platform=linux\/amd64\s+node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d/m);
  assert.match(dockerfile, /USER\s+65532:65532/);
  assert.match(dockerfile, /npm ci --omit=dev --no-audit --no-fund/);
  assert.match(dockerfile, /ENTRYPOINT\s+\["\/usr\/local\/bin\/arquitetura-entrypoint\.sh"\]/);
  assert.equal(/\blatest\b/i.test(dockerfile), false);
  assert.equal(dockerfile.includes('<<'), false);

  const pkg = JSON.parse(readFileSync(join(moduleDir, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  for (const name of ['knip', 'jscpd', 'dependency-cruiser', 'typescript']) {
    const version = pkg.dependencies[name];
    assert.ok(version, `dependência ausente: ${name}`);
    assert.match(version, /^\d+\.\d+\.\d+$/, `versão não fixada para ${name}: ${version}`);
  }

  const lockRaw = readFileSync(join(moduleDir, 'package-lock.json'));
  const lockSha = createHash('sha256').update(lockRaw).digest('hex');
  const toolsLock = JSON.parse(readFileSync(join(moduleDir, 'tools.lock.json'), 'utf8')) as {
    packageLockSha256: string;
    dependencies: Record<string, {version: string; integrity: string}>;
  };
  assert.equal(toolsLock.packageLockSha256, lockSha);

  const npmLock = JSON.parse(lockRaw.toString('utf8')) as {
    packages: Record<string, {version: string; integrity: string}>;
  };
  for (const [name, meta] of Object.entries(toolsLock.dependencies)) {
    assert.equal(pkg.dependencies[name], meta.version);
    const lockEntry = npmLock.packages[`node_modules/${name}`];
    assert.ok(lockEntry, `ausente no package-lock: ${name}`);
    assert.equal(lockEntry.version, meta.version);
    assert.equal(lockEntry.integrity, meta.integrity);
  }
});

test('hadolint aceita o Dockerfile do módulo quando disponível no PATH', t => {
  const binary = hadolintOnPath();
  if (!binary) {
    t.skip('hadolint ausente no PATH');
    return;
  }
  const res = spawnSync(binary, [join(moduleDir, 'Dockerfile')], {encoding: 'utf8'});
  assert.equal(res.status, 0, `${res.stdout ?? ''}${res.stderr ?? ''}`);
});

test('entrypoint recusa rede ativa, socket, path traversal e raiz ilegível', () => {
  const entrypoint = readFileSync(join(moduleDir, 'entrypoint.sh'), 'utf8');
  assert.match(entrypoint, /ARQUITETURA_PATH_FORBIDDEN/);
  assert.match(entrypoint, /ARQUITETURA_REPO_UNREADABLE/);
  assert.match(entrypoint, /ARQUITETURA_SOCKET_FORBIDDEN/);
  assert.match(entrypoint, /ARQUITETURA_NETWORK_FORBIDDEN/);
  assert.match(entrypoint, /\[ ! -r \/repo \] \|\| \[ ! -x \/repo \]/);
  assert.match(entrypoint, /\/sys\/class\/net\/\*/);
  assert.match(entrypoint, /\/var\/run\/docker\.sock/);
  assert.match(entrypoint, /unset\s+"\$name"/);
  assert.match(entrypoint, /^export AC_REPO_DIR=\/repo$/m);

  const shSyntax = spawnSync('/bin/sh', ['-n', join(moduleDir, 'entrypoint.sh')], {encoding: 'utf8'});
  assert.equal(shSyntax.status, 0, shSyntax.stderr ?? '');

  const traversal = spawnSync('/bin/sh', [join(moduleDir, 'entrypoint.sh'), '../fora'], {encoding: 'utf8'});
  assert.equal(traversal.status, 78);
  assert.match(traversal.stderr ?? '', /ARQUITETURA_PATH_FORBIDDEN/);

  const sockArg = spawnSync('/bin/sh', [join(moduleDir, 'entrypoint.sh'), '/tmp/x.sock'], {encoding: 'utf8'});
  assert.equal(sockArg.status, 78);
  assert.match(sockArg.stderr ?? '', /ARQUITETURA_SOCKET_FORBIDDEN/);
});

test('normalização de caminhos, linhas e cópia segura ignoram symlinks e travessia', () => {
  assert.equal(normalizeRepoPath('/tmp/work/repo/src/a.ts', '/tmp/work/repo'), 'src/a.ts');
  assert.equal(normalizeRepoPath('./src/../src/b.ts', '/tmp/work/repo'), 'src/b.ts');
  assert.equal(normalizeRepoPath('../../etc/passwd', '/tmp/work/repo'), '.');
  assert.equal(normalizeRepoPath('/src/main.ts', '/tmp/work/repo'), '.');
  assert.equal(normalizeRepoPath(' draft.ts', '/tmp/work/repo'), ' draft.ts');
  assert.equal(normalizeRepoPath('./..draft.ts', '/tmp/work/repo'), '..draft.ts');
  assert.equal(normalizeRepoPath('/tmp/work\\repo/src/a.ts', '/tmp/work/repo'), '.');
  assert.equal(normalizeRepoPath('src/a\\b.ts', '/tmp/work/repo'), '.');
  assert.equal(clampLine(0), 1);
  assert.equal(clampLine(-5), 1);
  assert.equal(clampLine(14.9), 14);

  const src = mkdtempSync(join(tmpdir(), 'arch-copy-src-'));
  const dst = mkdtempSync(join(tmpdir(), 'arch-copy-dst-'));
  try {
    mkdirSync(join(src, 'src'), {recursive: true});
    mkdirSync(join(src, 'node_modules', 'evil'), {recursive: true});
    writeFileSync(join(src, 'src', 'ok.ts'), 'export const ok = 1;\n');
    writeFileSync(join(src, 'node_modules', 'evil', 'bad.js'), 'console.log(1);\n');
    const outside = join(dst, 'outside.txt');
    writeFileSync(outside, 'outside synthetic content');
    symlinkSync(outside, join(src, 'src', 'escape.ts'));

    chmodSync(join(src, 'src', 'ok.ts'), 0o444);
    const res = copyRepoSafely(src, dst);
    assert.equal(statSync(join(dst, 'src', 'ok.ts')).mode & 0o777, 0o600);
    assert.deepEqual(res.copiedFiles, ['src/ok.ts']);
    assert.deepEqual(res.skipped, [
      {file: 'node_modules', reason: 'diretorio_excluido'},
      {file: 'src/escape.ts', reason: 'symlink'},
    ]);
    symlinkSync(src, join(dst, 'alias'));
    assert.throws(() => copyRepoSafely(join(dst, 'alias', 'src'), dst), /ARQUITETURA_REPO_UNREADABLE/);
    assert.throws(() => copyRepoSafely(dst + '/alias/../src', dst), /ARQUITETURA_REPO_UNREADABLE/);
    const refusedDestination = copyRepoSafely(src, join(dst, 'alias', 'uncreated'));
    assert.ok(refusedDestination.failure);
    assert.equal(existsSync(join(src, 'uncreated')), false);
    const target = join(dst, 'busca');
    mkdirSync(target);
    const nested = join(target, 'legivel');
    mkdirSync(nested);
    writeFileSync(join(nested, 'controle.ts'), 'export const controle = 1;');
    chmodSync(target, 0o111);
    try {
      assert.deepEqual(copyRepoSafely(nested, join(dst, 'novo')).copiedFiles, ['controle.ts']);
    } finally { chmodSync(target, 0o700); }
    const limited = copyRepoSafely(src, dst, {maxFiles: 0});
    assert.equal(limited.stoppedAt, 'node_modules');
    assert.equal(existsSync(join(dst, 'src', 'escape.ts')), false);
    assert.equal(existsSync(join(dst, 'node_modules', 'evil', 'bad.js')), false);
  } finally {
    rmSync(src, {recursive: true, force: true});
    rmSync(dst, {recursive: true, force: true});
  }
});

test('parsers de knip, jscpd e dependency-cruiser extraem todos os 5 tipos de achado com evidência e linha >= 1', () => {
  const knipOut = parseKnipReport(
    {
      analyzedFiles: ['src/index.ts', 'src/shared/format.ts'],
      entryFiles: ['src/index.ts'],
      issues: [
        {
          file: 'src/legacy-dead.ts',
          files: [{name: 'src/legacy-dead.ts'}],
          exports: [],
          dependencies: [],
        },
        {
          file: 'src/shared/format.ts',
          files: [],
          exports: [{name: 'unusedFormatter', line: 5}],
          dependencies: [{name: 'unused-dep', line: 9}],
        },
      ],
    },
    '/tmp/repo',
    new Set(['src/index.ts', 'src/legacy-dead.ts', 'src/shared/format.ts', 'src/unmeasured.mts']),
  );
  assert.equal(knipOut.findings.some(f => f.rule === 'KNIP-UNUSED-FILE' && f.file === 'src/legacy-dead.ts' && f.line === 1), true);
  assert.equal(knipOut.findings.some(f => f.rule === 'KNIP-UNUSED-EXPORT' && f.file === 'src/shared/format.ts' && f.line === 5), true);
  assert.equal(knipOut.findings.some(f => f.rule === 'KNIP-UNUSED-DEPENDENCY' && f.line === 9), true);
  assert.deepEqual(knipOut.perFileCoverage.map(({file, role}) => [file, role]), [
    ['src/index.ts', 'entrada'],
    ['src/legacy-dead.ts', 'nao_alcancado'],
    ['src/shared/format.ts', 'modulo'],
  ]);

  const dupOut = parseJscpdReport(
    {
      duplicates: [
        {
          kind: 'exact',
          lines: 14,
          tokens: 68,
          fragment: 'let subtotal = 0;\nfor (const item of items) {}',
          firstFile: {name: 'src/services/billing-legacy.ts', startLoc: {line: 7}, endLoc: {line: 20}},
          secondFile: {name: 'src/services/billing-modern.ts', startLoc: {line: 7}, endLoc: {line: 20}},
        },
      ],
      statistics: {total: {clones: 1, sources: 10, lines: 120, duplicatedLines: 14, percentage: 11.67}},
    },
    '/tmp/repo',
    null,
  );
  assert.equal(dupOut.findings.length, 1);
  assert.equal(dupOut.findings[0]?.rule, 'JSCPD-DUPLICATION');
  assert.equal(dupOut.findings[0]?.file, 'src/services/billing-legacy.ts');
  assert.equal(dupOut.findings[0]?.line, 7);
  assert.equal(dupOut.findings[0]?.severity, 'media');

  const compOut = parseJscpdComplexityReport(
    {
      summary: {
        totalFiles: 2,
        files: [
          {path: 'scripts/heavy.py', complexity: 31, lines: 180, tokens: 900, format: 'python'},
          {path: 'src/index.ts', complexity: 3, lines: 12, tokens: 45, format: 'typescript'},
        ],
      },
    },
    '/tmp/repo',
    null,
    new Set(['src/index.ts']),
  );
  assert.equal(compOut.findings.length, 1);
  assert.equal(compOut.findings[0]?.rule, 'JSCPD-COMPLEXITY-HIGH');
  assert.equal(compOut.findings[0]?.file, 'scripts/heavy.py');

  const sourceMap: Record<string, string> = {
    'src/domain/order.ts': "// import '../routes/orders.js'\nconst ref = '../routes/orders.js';\nimport {buildRoutePrefix} from\n  '../routes/orders.js';\nimport {readStoredFactor} from '../infra/memory-store.js';\n",
    'src/services/cycle-alpha.ts': "// comentario\nimport {continueCycleChain} from './cycle-beta.js';\n",
  };
  assert.equal(findImportLine(sourceMap['src/services/cycle-alpha.ts'], './cycle-beta.js'), 2);
  assert.equal(findImportLine(sourceMap['src/domain/order.ts'], '../infra/memory-store.js'), 5);
  assert.equal(findImportLine(sourceMap['src/domain/order.ts'], '../routes/orders.js'), 4);

  const depOut = parseDepcruiseReport(
    {
      modules: [
        {
          source: 'src/domain/order.ts',
          instability: 1,
          dependents: ['src/routes/orders.ts'],
          dependencies: [
            {
              module: '../routes/orders.js',
              resolved: 'src/routes/orders.ts',
              circular: true,
              rules: [{name: 'layer-domain-to-presentation'}, {name: 'no-circular'}],
            },
            {
              module: '../infra/memory-store.js',
              resolved: 'src/infra/memory-store.ts',
              circular: false,
              rules: [{name: 'layer-domain-to-infra', severity: 'error'}],
            },
          ],
        },
        {
          source: 'src/services/cycle-alpha.ts',
          instability: 0.5,
          dependents: ['src/services/cycle-beta.ts'],
          dependencies: [
            {
              module: './cycle-beta.js',
              resolved: 'src/services/cycle-beta.ts',
              circular: true,
              cycle: [{name: 'src/services/cycle-beta.ts'}, {name: 'src/services/cycle-alpha.ts'}],
              rules: [{name: 'no-circular', severity: 'error'}],
            },
          ],
        },
      ],
    },
    '/tmp/repo',
    rel => sourceMap[rel] ?? '',
  );
  assert.equal(depOut.findings.some(f => f.rule === 'DEPCRUISE-LAYER-DOMAIN-TO-PRESENTATION' && f.line === 4 && f.severity === 'alta'), true);
  assert.equal(depOut.findings.some(f => f.rule === 'DEPCRUISE-LAYER-DOMAIN-TO-INFRA' && f.line === 5 && f.severity === 'alta'), true);
  assert.equal(depOut.findings.some(f => f.rule === 'DEPCRUISE-NO-CIRCULAR' && f.line === 2 && f.severity === 'alta'), true);
  assert.equal(depOut.stats.cycles, 2);
  assert.equal(depOut.findings.filter(f => f.rule === 'DEPCRUISE-NO-CIRCULAR' && f.file === 'src/domain/order.ts').length, 1);
  assert.equal(depOut.stats.layerViolations, 2);
});

test('Knip conserva os achados de produção quando a chamada omite o inventário', () => {
  const result = parseKnipReport({
    analyzedFiles: ['./src/billing.ts', '/synthetic/src/billing.ts', 'src/tests/helper.ts'],
    entryFiles: ['./src/billing.ts'],
    issues: [{file:'src/billing.ts', exports:[{name:'old', line:3}]},
      {file:'src/tests/helper.ts', exports:[{name:'fixture', line:1}]}],
  }, '/synthetic');
  assert.deepEqual(result.findings.map(f => f.file), ['src/billing.ts']);
  assert.equal(result.stats.totalFiles, 1);
  assert.deepEqual(result.perFileCoverage.map(({file, role, issues}) => [file, role, issues]), [['src/billing.ts', 'entrada', 1]]);
});

test('Knip aplica a elegibilidade aos achados e mantém problemas por arquivo e manifesto', () => {
  const result = parseKnipReport({
    analyzedFiles: ['src/main.ts', 'src/tests/ignored.ts', 'src/fixtures/ignored.ts'],
    entryFiles: ['src/main.ts'],
    issues: [
      {file: 'src/main.ts', exports: [{name: 'unused', line: 3}], unresolved: [{name: 'missing', line: 4}]},
      {file: 'src/dead.ts', files: [{name: 'src/dead.ts'}, {name: 'src/tests/dead.ts'}, {name: 'src/fixtures/dead.ts'}]},
      {file: 'src/tests/ignored.ts', exports: [{name: 'ignored', line: 1}], unresolved: [{name: 'ignored', line: 1}]},
      {file: 'src/fixtures/ignored.ts', exports: [{name: 'ignored', line: 1}]},
      {file: 'package.json', dependencies: [{name: 'unused-package', line: 1}]},
      {file: 'src/fixtures/package.json', dependencies: [{name: 'ignored-package', line: 1}]},
    ],
  }, '/synthetic', new Set(['src/main.ts', 'src/dead.ts']));
  assert.deepEqual(result.findings.map(item => item.file), ['src/main.ts', 'src/main.ts', 'src/dead.ts', 'package.json']);
  assert.deepEqual(result.perFileCoverage.map(({file, role, issues}) => [file, role, issues]), [
    ['src/dead.ts', 'nao_alcancado', 1], ['src/main.ts', 'entrada', 2],
  ]);
  assert.deepEqual(result.stats, {totalFiles: 2, entries: 1, unusedFiles: 1, unusedExports: 1, unusedDeps: 2});
});

test('complexidade e buildKnipConfig distinguem a fixture com defeito da fixture limpa', () => {
  const defectiveAst = analyzeAstComplexity(defectiveFixture, [
    'src/index.ts',
    'src/domain/order.ts',
    'src/services/complex-engine.ts',
  ]);
  assert.equal(defectiveAst.findings.some(f => f.file === 'src/services/complex-engine.ts' && f.rule === 'COMPLEXITY-CYCLOMATIC-HIGH'), true);
  assert.equal(defectiveAst.findings.some(f => f.file === 'src/services/complex-engine.ts' && f.rule === 'COMPLEXITY-NESTING-DEEP'), true);

  const cleanAst = analyzeAstComplexity(cleanFixture, [
    'src/index.ts',
    'src/routes/orders.ts',
    'src/services/order-service.ts',
    'src/domain/order.ts',
    'src/infra/memory-store.ts',
    'src/shared/format.ts',
  ]);
  assert.equal(cleanAst.findings.length, 0);
  assert.equal(cleanAst.perFile.length, 6);

  const knipCfg = buildKnipConfig(cleanFixture, ['package.json', 'src/index.ts', 'src/routes/orders.ts']);
  assert.deepEqual(knipCfg.entry, ['src/index.ts']);
  assert.deepEqual(knipCfg.project, ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}']);
});

test('falha de ferramenta aparece na cobertura como failed sem abortar o JSON e repositório vazio vira skipped', () => {
  const emptyRepo = mkdtempSync(join(tmpdir(), 'arch-empty-'));
  try {
    const emptyRes = runCollector({
      repoDir: emptyRepo,
      toolsRoot: moduleDir,
    });
    assertValidOutputContract(emptyRes);
    assert.equal(emptyRes.findings.length, 0);
    for (const row of emptyRes.coverage) {
      assert.equal(row.status, row.tool === 'snapshot' ? 'ok' : 'skipped');
    }
  } finally {
    rmSync(emptyRepo, {recursive: true, force: true});
  }

  const failedTools = runCollector({
    repoDir: defectiveFixture,
    toolsRoot: moduleDir,
    spawnSync: () => ({
      status: 2,
      stdout: '',
      stderr: 'TOOL_BINARY_CRASHED',
      error: undefined,
    }),
  });
  assertValidOutputContract(failedTools);
  for (const tool of ['knip', 'jscpd', 'dependency-cruiser']) {
    const row = failedTools.coverage.find(c => c.tool === tool);
    assert.ok(row, `cobertura ausente para ${tool}`);
    assert.equal(row.status, 'failed');
    assert.match(row.detail, /falha ao executar/i);
  }
  const astRow = failedTools.coverage.find(c => c.tool === 'ast-complexity');
  assert.equal(astRow?.status, 'ok');
});

test('raiz presente porém ilegível falha explicitamente, enquanto projeto acessível sem JS/TS declara skipped', t => {
  const noJsTsRepo = mkdtempSync(join(tmpdir(), 'arch-docs-only-'));
  try {
    writeFileSync(join(noJsTsRepo, 'README.md'), '# Apenas documentação\n');
    chmodSync(noJsTsRepo, 0o755);
    chmodSync(join(noJsTsRepo, 'README.md'), 0o644);
    const docsRes = runCollector({
      repoDir: noJsTsRepo,
      toolsRoot: moduleDir,
      spawnSync: (_cmd, args) => {
        const argv = args as string[];
        const outDir = argv[argv.indexOf('--output') + 1];
        writeFileSync(join(outDir, 'jscpd-report.json'), JSON.stringify({duplicates: []}));
        writeFileSync(join(outDir, 'jscpd-complexity.json'), JSON.stringify({summary: {files: []}}));
        return {status: 0, stdout: '', stderr: ''};
      },
    });
    assertValidOutputContract(docsRes);
    assert.equal(docsRes.findings.length, 0);
    for (const tool of ['knip', 'ast-complexity', 'jscpd', 'dependency-cruiser']) {
      const row = docsRes.coverage.find(c => c.tool === tool);
      assert.ok(row, `cobertura ausente para ${tool}`);
      assert.equal(row.status, 'skipped');
    }
    assert.match(docsRes.coverage.find(c => c.tool === 'knip')?.detail ?? '', /arquivos copiados=1/);
  } finally {
    rmSync(noJsTsRepo, {recursive: true, force: true});
  }

  if (process.getuid?.() === 0) {
    t.skip('usuário root ignora modo 0000 no teste unitário sem contêiner');
    return;
  }

  for (const mode of [0o000, 0o400, 0o100]) {
    const unreadableRepo = mkdtempSync(join(tmpdir(), 'arch-unreadable-'));
    const copyDst = mkdtempSync(join(tmpdir(), 'arch-unreadable-dst-'));
    try {
      mkdirSync(join(unreadableRepo, 'src'), {recursive: true});
      writeFileSync(join(unreadableRepo, 'src', 'index.ts'), 'export const x = 1;\n');
      chmodSync(unreadableRepo, mode);

      assert.throws(() => copyRepoSafely(unreadableRepo, copyDst), /ARQUITETURA_REPO_UNREADABLE/);
      assert.throws(
        () => runCollector({repoDir: unreadableRepo, toolsRoot: moduleDir}),
        /ARQUITETURA_REPO_UNREADABLE/,
      );

      const cliRun = spawnSync(process.execPath, [join(moduleDir, 'collect.mjs')], {
        encoding: 'utf8',
        env: {...process.env, AC_REPO_DIR: unreadableRepo},
      });
      assert.equal(cliRun.status, 1);
      assert.equal((cliRun.stdout ?? '').trim(), '');
      assert.match(cliRun.stderr ?? '', /ARQUITETURA_REPO_UNREADABLE/);
    } finally {
      chmodSync(unreadableRepo, 0o700);
      rmSync(unreadableRepo, {recursive: true, force: true});
      rmSync(copyDst, {recursive: true, force: true});
    }
  }
});

test('cobertura por arquivo reflete apenas os arquivos efetivamente medidos sem atribuir métricas aos ignorados ou não medidos', () => {
  const repo = mkdtempSync(join(tmpdir(), 'arch-coverage-exact-'));
  try {
    cpSync(cleanFixture, repo, {recursive: true});
    writeFileSync(join(repo, 'vite.config.ts'), "import {writeFileSync} from 'node:fs';\nexport default {};\n");
    writeFileSync(join(repo, 'knip.ts'), "import {writeFileSync} from 'node:fs';\nexport default {};\n");
    writeFileSync(join(repo, '.dependency-cruiser.js'), "const fs = require('node:fs');\nmodule.exports = {};\n");

    const measuredByJscpd = ['src/domain/order.ts', 'src/infra/memory-store.ts', 'src/services/order-service.ts'];
    const cleanSrcFiles = [
      'src/domain/order.ts',
      'src/index.ts',
      'src/infra/memory-store.ts',
      'src/routes/orders.ts',
      'src/services/order-service.ts',
      'src/shared/format.ts',
    ];

    const out = runCollector({
      repoDir: repo,
      toolsRoot: moduleDir,
      spawnSync: (cmd, args) => {
        const argList = Array.isArray(args) ? args.map(String) : [];
        const bin = String(cmd);
        if (argList[0]?.endsWith('/knip-worker.mjs')) {
          const stdout = JSON.stringify({issues: [], analyzedFiles: cleanSrcFiles, entryFiles: ['src/index.ts']});
          return {status: 0, stdout, stderr: ''};
        }
        if (bin.endsWith('jscpd') || argList.includes('--reporters')) {
          const outIdx = argList.indexOf('--output');
          const outDir = outIdx >= 0 ? argList[outIdx + 1] : '';
          if (argList.includes('--complexity')) {
            writeFileSync(
              join(outDir, 'jscpd-complexity.json'),
              JSON.stringify({
                summary: {
                  totalFiles: measuredByJscpd.length,
                  files: measuredByJscpd.map(file => ({
                    path: file,
                    complexity: 2,
                    lines: 10,
                    tokens: 45,
                    format: 'typescript',
                  })),
                },
              }),
            );
          } else {
            writeFileSync(
              join(outDir, 'jscpd-report.json'),
              JSON.stringify({
                duplicates: [],
                statistics: {total: {clones: 0, sources: measuredByJscpd.length, lines: 32, duplicatedLines: 0, percentage: 0}},
              }),
            );
          }
          return {status: 0, stdout: '', stderr: '', error: undefined};
        }
        const depOutIdx = argList.indexOf('--output-to');
        const depOutPath = depOutIdx >= 0 ? argList[depOutIdx + 1] : '';
        if (depOutPath) {
          writeFileSync(
            depOutPath,
            JSON.stringify({
              modules: [
                ...cleanSrcFiles.map(source => ({source, instability: 0.5, dependencies: [], dependents: []})),
                {source: 'node:fs', coreModule: true, instability: 0, dependencies: [], dependents: ['vite.config.ts']},
                {source: 'pkg-externo', couldNotResolve: true, instability: 0, dependencies: [], dependents: []},
                {source: 'node_modules/x/index.js', matchesDoNotFollow: true, instability: 0, dependencies: [], dependents: []},
              ],
            }),
          );
        }
        return {status: 0, stdout: '', stderr: '', error: undefined};
      },
    });

    assertValidOutputContract(out);
    const filesFor = (tool: string) =>
      out.coverage
        .filter(c => c.tool === tool)
        .map(c => /^arquivo=([^;]+);/.exec(c.detail)?.[1] ?? '')
        .filter(Boolean)
        .sort();

    assert.deepEqual(filesFor('knip:file'), [...cleanSrcFiles].sort());
    assert.deepEqual(filesFor('jscpd:file'), [...measuredByJscpd].sort());
    assert.deepEqual(filesFor('dependency-cruiser:file'), [...cleanSrcFiles].sort());
    assert.equal(filesFor('ast-complexity:file').includes('src/index.ts'), true);
    assert.match(out.coverage.find(c => c.tool === 'knip')?.detail ?? '', /arquivos=6,/);
    assert.match(out.coverage.find(c => c.tool === 'dependency-cruiser')?.detail ?? '', /modulos=6,/);
    assert.match(out.coverage.find(c => c.tool === 'jscpd')?.detail ?? '', /arquivos_medidos=3,/);
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
});

test('arquivo ilegível com raiz acessível mantém o JSON da falha na cobertura', {skip: process.getuid?.() === 0}, () => {
  const repo = mkdtempSync(join(tmpdir(), 'arch-copy-failure-'));
  try {
    const file = join(repo, 'unreadable.ts');
    writeFileSync(file, 'export const synthetic = 1;\n', {mode: 0o000});
    const child = spawnSync(process.execPath, [join(moduleDir, 'collect.mjs')], {
      encoding: 'utf8',
      env: {...process.env, AC_REPO_DIR: repo},
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout) as ReturnType<typeof runCollector>;
    assertValidOutputContract(result);
    assert.deepEqual(result.findings, []);
    assert.equal(result.coverage.length, 1);
    assert.equal(result.coverage[0]?.tool, 'snapshot');
    assert.equal(result.coverage[0]?.status, 'failed');
    assert.match(result.coverage[0]?.detail ?? '', /falha_copia=EACCES; arquivo="unreadable.ts"/);
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
});

test('snapshot registra omissões e cobertura sinaliza o corte de 500 linhas em cada ferramenta', () => {
  const repo = mkdtempSync(join(tmpdir(), 'arch-coverage-limit-'));
  try {
    const files = Array.from({length: 501}, (_, index) => `module-${index}.ts`);
    for (const file of files) {
      writeFileSync(join(repo, file), 'export const synthetic = 1;\n');
    }
    writeFileSync(join(repo, 'large.ts'), '');
    truncateSync(join(repo, 'large.ts'), 2 * 1024 * 1024 + 1);
    const out = runCollector({
      repoDir: repo,
      toolsRoot: moduleDir,
      spawnSync: (_cmd, args) => {
        const argv = args as string[];
        if (argv[0]?.endsWith('/knip-worker.mjs')) {
          return {status: 0, stderr: '', stdout: JSON.stringify({issues: [], analyzedFiles: files, entryFiles: []})};
        }
        if (argv.includes('--output-to')) {
          writeFileSync(argv[argv.indexOf('--output-to') + 1], JSON.stringify({modules: files.map(source => ({source}))}));
        } else {
          const outDir = argv[argv.indexOf('--output') + 1];
          writeFileSync(join(outDir, 'jscpd-report.json'), JSON.stringify({duplicates: []}));
          writeFileSync(join(outDir, 'jscpd-complexity.json'), JSON.stringify({summary: {files: files.map(path => ({path}))}}));
        }
        return {status: 0, stderr: '', stdout: ''};
      },
    });
    const snapshot = out.coverage.find(row => row.tool === 'snapshot');
    assert.equal(snapshot?.status, 'skipped');
    assert.match(snapshot?.detail ?? '', /limite_arquivos=10000; limite_bytes_por_arquivo=2097152; cobertura_parcial=sim/);
    assert.equal(out.coverage.find(row => row.tool === 'snapshot:omitted')?.detail, 'arquivo="large.ts"; motivo=limite_bytes');
    for (const tool of ['knip', 'ast-complexity', 'jscpd', 'dependency-cruiser']) {
      assert.match(out.coverage.find(row => row.tool === tool)?.detail ?? '', /linhas_por_arquivo=500\/501; limite_linhas=500; cobertura_truncada=sim/);
      assert.equal(out.coverage.filter(row => row.tool === `${tool}:file`).length, 500);
    }
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
});

test('dependency-cruiser mantém a falha quando o processo deixa um JSON válido', () => {
  const out = runCollector({
    repoDir: cleanFixture,
    toolsRoot: moduleDir,
    spawnSync: (_cmd, args) => {
      const argv = args as string[];
      if (argv.includes('--output-to')) {
        writeFileSync(argv[argv.indexOf('--output-to') + 1], JSON.stringify({modules: [{source: 'src/index.ts'}]}));
      }
      return {status: 2, stdout: '', stderr: 'falha sintética'};
    },
  });
  const row = out.coverage.find(item => item.tool === 'dependency-cruiser');
  assert.equal(row?.status, 'failed');
  assert.match(row?.detail ?? '', /status 2: falha sintética/);
  assert.equal(out.coverage.some(item => item.tool === 'dependency-cruiser:file'), false);
});

test('AST mede getters, setters e decisões nos parâmetros sem contar funções aninhadas duas vezes', () => {
  const repo = mkdtempSync(join(tmpdir(), 'arch-accessors-'));
  try {
    const file = 'accessors.ts';
    writeFileSync(join(repo, file), [
      'class Example {',
      '  get value() { return a && b && c; }',
      '  set value(next) { if (next) this.target = next ?? other; }',
      '}',
      'function defaults(x = a ? b : c, y = () => d && e && f) { if (x) return y(); }',
    ].join('\n'));
    const result = analyzeAstComplexity(repo, [file], {fnCyclomaticMedia: 3});
    assert.equal(result.perFile[0]?.functions, 4);
    assert.equal(result.perFile[0]?.fileCyclomatic, 9);
    const findings = result.findings.filter(f => f.rule === 'COMPLEXITY-CYCLOMATIC-HIGH');
    assert.deepEqual(findings.map(({line}) => line).sort(), [2, 3, 5, 5]);
    assert.equal(findings.every(({evidence}) => evidence.includes('complexidade_ciclomatica=3;')), true);
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
});

test('configuração do grafo preserva extends locais com e sem extensão dentro da cópia', () => {
  const temp = mkdtempSync(join(tmpdir(), 'arch-tsconfig-'));
  const repo = join(temp, 'repo');
  try {
    mkdirSync(join(repo, 'config'), {recursive: true});
    writeFileSync(join(temp, 'outside.json'), '{}');
    writeFileSync(join(repo, 'index.ts'), 'export const synthetic = 1;\n');
    writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({
      extends: ['.\\config\\base', './config/other.json', '..\\outside', 'outside-package', '.\\config\\link'],
    }));
    writeFileSync(join(repo, 'config', 'base.json'), JSON.stringify({extends: '..\\shared'}));
    writeFileSync(join(repo, 'shared.json'), JSON.stringify({extends: '..\\outside'}));
    writeFileSync(join(repo, 'config', 'other.json'), '{}');
    symlinkSync(join(temp, 'outside.json'), join(repo, 'config', 'link.json'));
    const output = runCollector({
      repoDir: repo,
      toolsRoot: moduleDir,
      spawnSync: (_cmd, args, options) => {
        const argv = args as string[];
        if (!argv.includes('--output-to')) return {status: 2, stdout: '', stderr: ''};
        const {cwd} = options as {cwd: string};
        const root = JSON.parse(readFileSync(join(cwd, 'tsconfig.json'), 'utf8'));
        assert.deepEqual(root.extends, ['./config/base', './config/other.json']);
        const base = JSON.parse(readFileSync(join(cwd, 'config', 'base.json'), 'utf8'));
        assert.equal(base.extends, '../shared');
        const shared = JSON.parse(readFileSync(join(cwd, 'shared.json'), 'utf8'));
        assert.equal(shared.extends, undefined);
        const config = JSON.parse(readFileSync(argv[argv.indexOf('--config') + 1], 'utf8'));
        assert.equal(config.options.tsConfig.fileName, 'tsconfig.json');
        writeFileSync(argv[argv.indexOf('--output-to') + 1], JSON.stringify({modules: [{source: 'index.ts'}]}));
        return {status: 0, stdout: '', stderr: ''};
      },
    });
    assert.equal(output.coverage.find(row => row.tool === 'dependency-cruiser')?.status, 'ok', JSON.stringify(output.coverage));
  } finally {
    rmSync(temp, {recursive: true, force: true});
  }
});

test('binários fixados medem .mts e .cts no Knip e resolvem alias TS herdado no grafo', {
  skip: !existsSync(join(moduleDir, 'node_modules', '.bin', 'depcruise')) ||
    !existsSync(join(moduleDir, 'node_modules', 'knip', 'package.json')),
}, () => {
  const repo = mkdtempSync(join(tmpdir(), 'arch-pinned-tools-'));
  try {
    cpSync(defectiveFixture, repo, {recursive: true});
    const tsconfigPath = join(repo, 'tsconfig.json');
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
    writeFileSync(tsconfigPath, JSON.stringify({...tsconfig, extends: '.\\tsconfig.base'}));
    writeFileSync(join(repo, 'tsconfig.base.json'), JSON.stringify({
      compilerOptions: {paths: {'@storage': ['./src/infra/memory-store.ts']}},
    }));
    const packagePath = join(repo, 'package.json');
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
    writeFileSync(packagePath, JSON.stringify({...manifest, knip: {entry: ['ignored.ts']}}));
    const pnpmPath = join(repo, 'pnpm-workspace.yaml');
    writeFileSync(pnpmPath, 'packages: []\ninclude: synthetic.yaml\n');
    const originals = [tsconfigPath, join(repo, 'tsconfig.base.json'), packagePath, pnpmPath]
      .map(path => ({path, content: readFileSync(path, 'utf8')}));
    for (const {path} of originals) chmodSync(path, 0o444);
    mkdirSync(join(repo, 'src/tests'), {recursive: true});
    mkdirSync(join(repo, 'src/fixtures'), {recursive: true});
    writeFileSync(join(repo, 'src/tests/ignored.ts'), 'export const ignoredTest = 1;\n');
    writeFileSync(join(repo, 'src/fixtures/ignored.ts'), 'export const ignoredFixture = 1;\n');
    const orderPath = join(repo, 'src/domain/order.ts');
    const order = readFileSync(orderPath, 'utf8').replace('../infra/memory-store.js', '@storage');
    writeFileSync(orderPath, order);

    const out = runCollector({repoDir: repo, toolsRoot: moduleDir});
    assert.equal(out.coverage.find(row => row.tool === 'knip')?.status, 'ok');
    for (const file of ['src/unused.mts', 'src/unused.cts']) {
      assert.ok(out.findings.some(f => f.rule === 'KNIP-UNUSED-FILE' && f.file === file));
      assert.ok(out.coverage.some(row => row.tool === 'knip:file' &&
        row.detail === `arquivo=${file}; papel=nao_alcancado; problemas=1`));
    }
    assert.ok(out.findings.some(f => f.rule === 'DEPCRUISE-LAYER-DOMAIN-TO-INFRA' &&
      f.evidence.includes('src/infra/memory-store.ts') && f.evidence.includes('@storage')));
    assert.equal(out.findings.some(f => /src\/(tests|fixtures)\//.test(f.file)), false);
    assert.equal(out.coverage.some(row => row.tool === 'knip:file' && /src\/(tests|fixtures)\//.test(row.detail)), false);
    for (const {path, content} of originals) {
      assert.equal(readFileSync(path, 'utf8'), content);
      assert.equal(statSync(path).mode & 0o777, 0o444);
    }
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
});

test('jscpd mede SQL em um projeto que contém apenas SQL', {
  skip: !existsSync(join(moduleDir, 'node_modules', '.bin', 'jscpd')),
}, () => {
  const repo = mkdtempSync(join(tmpdir(), 'arch-sql-only-'));
  try {
    writeFileSync(join(repo, 'schema.sql'), [
      'CREATE TABLE synthetic_orders (',
      '  id INTEGER PRIMARY KEY,',
      '  account_id INTEGER NOT NULL,',
      '  city VARCHAR(40) NOT NULL,',
      '  created_at TIMESTAMP NOT NULL,',
      '  status VARCHAR(12) NOT NULL,',
      '  delivery_address VARCHAR(80),',
      '  CONSTRAINT valid_status CHECK (status IN (\'sent\', \'pending\'))',
      ');',
      'CREATE INDEX synthetic_orders_status ON synthetic_orders (account_id, status);',
    ].join('\n'));
    const out = runCollector({repoDir: repo, toolsRoot: moduleDir});
    assert.equal(out.coverage.find(row => row.tool === 'jscpd')?.status, 'ok', JSON.stringify(out.coverage));
    assert.ok(out.coverage.some(row => row.tool === 'jscpd:file' && row.detail.startsWith('arquivo=schema.sql;')));
    assert.equal(out.coverage.find(row => row.tool === 'knip')?.status, 'skipped');
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
});
