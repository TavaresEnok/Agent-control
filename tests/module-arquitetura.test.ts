import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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

test('entrypoint recusa rede ativa, socket e path traversal', () => {
  const entrypoint = readFileSync(join(moduleDir, 'entrypoint.sh'), 'utf8');
  assert.match(entrypoint, /ARQUITETURA_PATH_FORBIDDEN/);
  assert.match(entrypoint, /ARQUITETURA_SOCKET_FORBIDDEN/);
  assert.match(entrypoint, /ARQUITETURA_NETWORK_FORBIDDEN/);
  assert.match(entrypoint, /\/sys\/class\/net\/\*/);
  assert.match(entrypoint, /\/var\/run\/docker\.sock/);
  assert.match(entrypoint, /unset\s+"\$name"/);

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
    symlinkSync('/etc/passwd', join(src, 'src', 'escape.ts'));

    const res = copyRepoSafely(src, dst);
    assert.deepEqual(res.copiedFiles, ['src/ok.ts']);
    assert.equal(res.skipped.includes('src/escape.ts'), true);
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
    ['src/index.ts', 'src/legacy-dead.ts', 'src/shared/format.ts'],
    new Set(['src/index.ts']),
  );
  assert.equal(knipOut.findings.some(f => f.rule === 'KNIP-UNUSED-FILE' && f.file === 'src/legacy-dead.ts' && f.line === 1), true);
  assert.equal(knipOut.findings.some(f => f.rule === 'KNIP-UNUSED-EXPORT' && f.file === 'src/shared/format.ts' && f.line === 5), true);
  assert.equal(knipOut.findings.some(f => f.rule === 'KNIP-UNUSED-DEPENDENCY' && f.line === 9), true);
  assert.equal(knipOut.perFileCoverage.length, 3);

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
    'src/domain/order.ts': "import {buildRoutePrefix} from '../routes/orders.js';\nimport {readStoredFactor} from '../infra/memory-store.js';\n",
    'src/services/cycle-alpha.ts': "// comentario\nimport {continueCycleChain} from './cycle-beta.js';\n",
  };
  assert.equal(findImportLine(sourceMap['src/services/cycle-alpha.ts'], './cycle-beta.js'), 2);
  assert.equal(findImportLine(sourceMap['src/domain/order.ts'], '../infra/memory-store.js'), 2);

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
              circular: false,
              rules: [{name: 'layer-domain-to-presentation', severity: 'error'}],
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
  assert.equal(depOut.findings.some(f => f.rule === 'DEPCRUISE-LAYER-DOMAIN-TO-PRESENTATION' && f.line === 1 && f.severity === 'alta'), true);
  assert.equal(depOut.findings.some(f => f.rule === 'DEPCRUISE-LAYER-DOMAIN-TO-INFRA' && f.line === 2 && f.severity === 'alta'), true);
  assert.equal(depOut.findings.some(f => f.rule === 'DEPCRUISE-NO-CIRCULAR' && f.line === 2 && f.severity === 'alta'), true);
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

  const knipCfg = buildKnipConfig(
    cleanFixture,
    ['package.json', 'src/index.ts', 'src/routes/orders.ts'],
    moduleDir,
  );
  assert.deepEqual(knipCfg.entry, ['src/index.ts']);
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
      assert.equal(row.status, 'skipped');
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
