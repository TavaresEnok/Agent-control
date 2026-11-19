import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  clampLine,
  copyRepoSafely,
  crossCheckMarkdownAgainstTypedoc,
  extractMermaidBlocks,
  normalizeRepoPath,
  parseDepcruiseReport,
  parseTypedocReport,
  runCollector,
  sanitizeTsConfigInWork,
  validateMermaidDocuments,
} from '../deploy/modules/documentacao/collect.mjs';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const MODULE_DEPLOY_DIR = join(ROOT_DIR, 'deploy', 'modules', 'documentacao');
const FIXTURES = join(ROOT_DIR, 'tests', 'fixtures', 'module-documentacao');
const FIXTURE_DEFECTIVE_DIR = join(FIXTURES, 'defective');
const FIXTURE_CLEAN_DIR = join(FIXTURES, 'control-clean');
const VALID_SEVERITIES = new Set(['alta', 'media', 'baixa', 'informativa']);
const VALID_STATUSES = new Set(['ok', 'failed', 'skipped']);

type CoverageItem = {
  tool: string;
  version: string;
  status: 'ok' | 'failed' | 'skipped';
  detail: string;
};

type FindingItem = {
  tool: string;
  rule: string;
  file: string;
  line: number;
  severity: 'alta' | 'media' | 'baixa' | 'informativa';
  message: string;
  evidence: string;
};

type CollectorOutput = {
  coverage: CoverageItem[];
  findings: FindingItem[];
};

function assertValidCollectorContract(output: CollectorOutput): void {
  assert.ok(Array.isArray(output.coverage), 'coverage deve ser array');
  assert.ok(Array.isArray(output.findings), 'findings deve ser array');
  for (const row of output.coverage) {
    assert.equal(typeof row.tool, 'string');
    assert.ok(row.tool.length > 0);
    assert.equal(typeof row.version, 'string');
    assert.ok(row.version.length > 0);
    assert.ok(VALID_STATUSES.has(row.status), `status inválido: ${row.status}`);
    assert.equal(typeof row.detail, 'string');
    assert.ok(row.detail.length > 0);
  }
  for (const item of output.findings) {
    assert.equal(typeof item.tool, 'string');
    assert.ok(item.tool.length > 0);
    assert.equal(typeof item.rule, 'string');
    assert.ok(item.rule.startsWith('DOC-'), `regra inesperada: ${item.rule}`);
    assert.equal(typeof item.file, 'string');
    assert.ok(item.file.length > 0);
    assert.equal(item.file.startsWith('/'), false, `file deve ser relativo: ${item.file}`);
    assert.equal(item.file.includes('..'), false, `file não pode conter ..: ${item.file}`);
    assert.equal(Number.isInteger(item.line), true);
    assert.ok(item.line >= 1, `line deve ser >= 1: ${item.line}`);
    assert.ok(VALID_SEVERITIES.has(item.severity), `severity inválida: ${item.severity}`);
    assert.equal(typeof item.message, 'string');
    assert.ok(item.message.length > 0);
    assert.equal(typeof item.evidence, 'string');
    assert.ok(item.evidence.length > 0);
  }
}

function readArtifact(output: CollectorOutput, name: string): string {
  const chunks = output.coverage
    .filter(row => row.tool.endsWith(':artefato') && row.status === 'ok')
    .map(row => JSON.parse(row.detail) as {artifact: string; part: number; parts: number; content: string})
    .filter(chunk => chunk.artifact === name)
    .sort((a, b) => a.part - b.part);
  assert.ok(chunks.length, `artefato ausente: ${name}`);
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.part, index + 1);
    assert.equal(chunk.parts, chunks.length);
  }
  return chunks.map(chunk => chunk.content).join('');
}

function assertGeneratedArtifacts(output: CollectorOutput): void {
  const api = JSON.parse(readArtifact(output, 'api.json')) as {name: string; file: string; summaryText: string}[];
  assert.ok(api.some(symbol => symbol.name === 'calculateInvoice' && symbol.file === 'src/billing.ts' && symbol.summaryText));
  const diagram = readArtifact(output, 'dependencias.mmd');
  assert.match(diagram, /flowchart/);
  assert.match(diagram, /api\.ts/);
  assert.match(diagram, /billing\.ts/);
}

test('lockfiles, Dockerfile e entrypoint do módulo 8 fixam versões, integridade e guardas', () => {
  const pkg = JSON.parse(readFileSync(join(MODULE_DEPLOY_DIR, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const lockRaw = readFileSync(join(MODULE_DEPLOY_DIR, 'package-lock.json'), 'utf8');
  const lockSha256 = createHash('sha256').update(lockRaw).digest('hex');
  const pkgLock = JSON.parse(lockRaw) as {
    lockfileVersion: number;
    packages: Record<string, {version?: string; integrity?: string; resolved?: string; license?: string}>;
  };
  const toolsLock = JSON.parse(readFileSync(join(MODULE_DEPLOY_DIR, 'tools.lock.json'), 'utf8')) as {
    baseImage: {name: string; digest: string};
    lockfileVersion: number;
    packageLockSha256: string;
    dependencies: Record<string, {version: string; license: string; integrity: string; resolved: string}>;
  };
  const dockerfile = readFileSync(join(MODULE_DEPLOY_DIR, 'Dockerfile'), 'utf8');
  const entrypoint = readFileSync(join(MODULE_DEPLOY_DIR, 'documentacao-entrypoint.sh'), 'utf8');

  assert.equal(toolsLock.packageLockSha256, lockSha256);
  assert.equal(toolsLock.lockfileVersion, 3);
  assert.equal(pkgLock.lockfileVersion, 3);
  assert.match(toolsLock.baseImage.digest, /^sha256:[a-f0-9]{64}$/);

  const expectedTools = ['typedoc', 'dependency-cruiser', 'mermaid', 'typescript', 'jsdom'];
  assert.deepEqual(Object.keys(toolsLock.dependencies).sort(), expectedTools.slice().sort());

  for (const name of expectedTools) {
    const pin = toolsLock.dependencies[name];
    assert.ok(pin, `ferramenta ausente em tools.lock.json: ${name}`);
    assert.equal(pkg.dependencies[name], pin.version);
    assert.match(pin.version, /^\d+\.\d+\.\d+$/);
    assert.match(pin.integrity, /^sha512-[A-Za-z0-9+/=]+$/);
    assert.match(pin.resolved, /^https:\/\/registry\.npmjs\.org\/.+\.tgz$/);

    const inLock = pkgLock.packages[`node_modules/${name}`];
    assert.ok(inLock, `pacote ausente em package-lock.json: node_modules/${name}`);
    assert.equal(inLock.version, pin.version);
    assert.equal(inLock.integrity, pin.integrity);
    assert.equal(inLock.resolved, pin.resolved);
    assert.equal(inLock.license, pin.license);
  }

  for (const [location, pkgInfo] of Object.entries(pkgLock.packages)) {
    if (!location) continue;
    assert.match(pkgInfo.resolved ?? '', /^https:\/\/registry\.npmjs\.org\//);
    assert.match(pkgInfo.integrity ?? '', /^sha512-/);
  }

  assert.match(dockerfile, new RegExp(`FROM node@${toolsLock.baseImage.digest}`));
  assert.equal(/latest/i.test(dockerfile), false);
  assert.ok(dockerfile.includes(lockSha256));
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /USER 65532:65532/);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/documentacao-entrypoint\.sh"\]/);

  assert.match(entrypoint, /DOCUMENTACAO_PATH_FORBIDDEN/);
  assert.match(entrypoint, /DOCUMENTACAO_SOCKET_FORBIDDEN/);
  assert.match(entrypoint, /DOCUMENTACAO_LOGIN_FORBIDDEN/);
  assert.match(entrypoint, /DOCUMENTACAO_NETWORK_FORBIDDEN/);
  assert.match(entrypoint, /DOCUMENTACAO_PRIVILEGED_USER_FORBIDDEN/);
  assert.match(entrypoint, /DOCUMENTACAO_REPO_UNREADABLE/);
});

test('o entrypoint recusa argumentos sintéticos de travessia e socket', () => {
  const entrypointPath = join(MODULE_DEPLOY_DIR, 'documentacao-entrypoint.sh');

  const traversal = spawnSync('sh', [entrypointPath, '../escape'], {encoding: 'utf8'});
  assert.equal(traversal.status, 78);
  assert.match(traversal.stderr, /DOCUMENTACAO_PATH_FORBIDDEN/);

  const sockArg = spawnSync('sh', [entrypointPath, '/var/run/docker.sock'], {encoding: 'utf8'});
  assert.equal(sockArg.status, 78);
  assert.match(sockArg.stderr, /DOCUMENTACAO_SOCKET_FORBIDDEN/);
});

test('copyRepoSafely e sanitizeTsConfigInWork descartam symlinks, configs executáveis e plugins', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'doc-safe-copy-'));
  const srcDir = join(tempRoot, 'src-repo');
  const dstDir = join(tempRoot, 'dst-repo');
  try {
    mkdirSync(join(srcDir, 'src'), {recursive: true});
    mkdirSync(join(srcDir, 'node_modules', 'evil'), {recursive: true});
    mkdirSync(join(srcDir, '.git'), {recursive: true});

    writeFileSync(join(srcDir, 'src', 'index.ts'), 'export const x = 1;\n');
    writeFileSync(join(srcDir, 'README.md'), '# Doc\n');
    writeFileSync(join(srcDir, 'typedoc.json'), JSON.stringify({plugin: ['./evil-plugin.js']}));
    writeFileSync(join(srcDir, '.dependency-cruiser.js'), 'module.exports = {};');
    writeFileSync(join(srcDir, 'node_modules', 'evil', 'index.js'), 'process.exit(1);');
    writeFileSync(join(srcDir, '.git', 'config'), '[core]');
    writeFileSync(join(srcDir, 'huge.bin'), Buffer.alloc(64, 0x41));
    symlinkSync(join(srcDir, 'src', 'index.ts'), join(srcDir, 'src', 'link.ts'));

    const {copiedFiles, skipped} = copyRepoSafely(srcDir, dstDir, {maxFileBytes: 32});
    assert.deepEqual(copiedFiles.sort(), ['README.md', 'src/index.ts']);
    assert.ok(skipped.includes('typedoc.json'));
    assert.ok(skipped.includes('.dependency-cruiser.js'));
    assert.ok(skipped.includes('huge.bin'));
    assert.ok(skipped.includes('src/link.ts'));
    assert.ok(skipped.includes('node_modules'));
    assert.equal(existsSync(join(dstDir, 'typedoc.json')), false);
    assert.equal(existsSync(join(dstDir, '.dependency-cruiser.js')), false);
    assert.equal(existsSync(join(dstDir, 'node_modules')), false);

    writeFileSync(join(srcDir, 'package.json'), JSON.stringify({
      name: 'synthetic',
      imports: {'#internal': './src/index.ts'},
      typedocOptions: {plugin: ['./plugin.cjs']},
      scripts: {test: 'never-run'},
    }));
    copyRepoSafely(srcDir, dstDir);
    assert.deepEqual(JSON.parse(readFileSync(join(dstDir, 'package.json'), 'utf8')), {
      name: 'synthetic',
      imports: {'#internal': './src/index.ts'},
    });

    const tsPath = sanitizeTsConfigInWork(dstDir, ['src/index.ts']);
    const safeTs = JSON.parse(readFileSync(tsPath, 'utf8')) as {
      compilerOptions: {plugins: unknown[]; types: unknown[]; noEmit: boolean};
    };
    assert.deepEqual(safeTs.compilerOptions.plugins, []);
    assert.deepEqual(safeTs.compilerOptions.types, []);
    assert.equal(safeTs.compilerOptions.noEmit, true);

    assert.equal(normalizeRepoPath('/repo/src/api.ts', '/repo'), 'src/api.ts');
    assert.equal(normalizeRepoPath('../../etc/passwd', '/repo'), '.');
    assert.equal(normalizeRepoPath('/outro/src/api.ts', '/repo'), '.');
    assert.equal(clampLine(0), 1);
    assert.equal(clampLine(-9), 1);
    assert.equal(clampLine(14.8), 14);
  } finally {
    rmSync(tempRoot, {recursive: true, force: true});
  }
});

test('as ferramentas fixadas encontram os defeitos e aprovam o controle limpo no teste local', {
  skip: process.env.C8_TEST_LOCAL_TOOLS !== '1',
}, async () => {
  const defectiveResult = (await runCollector({
    repoDir: FIXTURE_DEFECTIVE_DIR,
    toolsRoot: MODULE_DEPLOY_DIR,
  })) as CollectorOutput;

  assertValidCollectorContract(defectiveResult);
  assertGeneratedArtifacts(defectiveResult);

  const tdCov = defectiveResult.coverage.find(c => c.tool === 'typedoc');
  const dcCov = defectiveResult.coverage.find(c => c.tool === 'dependency-cruiser');
  const mmCov = defectiveResult.coverage.find(c => c.tool === 'mermaid');
  assert.ok(tdCov && tdCov.status === 'ok' && tdCov.version === '0.28.20');
  assert.ok(dcCov && dcCov.status === 'ok' && dcCov.version === '18.8.0');
  assert.ok(mmCov && mmCov.status === 'ok' && mmCov.version === '12.3.0');

  // Cobertura adicional por arquivo
  assert.ok(defectiveResult.coverage.some(c => c.tool === 'typedoc:file' && c.detail.includes('arquivo=src/billing.ts')));
  assert.ok(defectiveResult.coverage.some(c => c.tool === 'dependency-cruiser:file' && c.detail.includes('arquivo=src/api.ts')));
  assert.ok(defectiveResult.coverage.some(c => c.tool === 'mermaid:file' && c.detail.includes('arquivo=README.md')));

  const rules = new Set(defectiveResult.findings.map(f => `${f.tool}:${f.rule}:${f.file}`));
  assert.ok(rules.has('typedoc:DOC-TYPEDOC-PARAM-DESATUALIZADO:src/billing.ts'));
  assert.ok(rules.has('typedoc:DOC-TYPEDOC-SIMBOLO-SEM-DOC:src/billing.ts'));
  assert.ok(rules.has('typedoc:DOC-TYPEDOC-LINK-QUEBRADO:src/api.ts'));
  assert.ok(rules.has('typedoc:DOC-TYPEDOC-MARKDOWN-ASSINATURA-DESATUALIZADA:README.md'));
  assert.ok(rules.has('dependency-cruiser:DOC-DEPCRUISE-DEPENDENCIA-DOCUMENTADA-INEXISTENTE:README.md'));
  assert.ok(rules.has('mermaid:DOC-MERMAID-MODULO-INEXISTENTE:README.md'));
  assert.ok(rules.has('mermaid:DOC-MERMAID-SINTAXE-INVALIDA:README.md'));
  assert.equal(defectiveResult.findings.find(item => item.rule === 'DOC-MERMAID-SINTAXE-INVALIDA')?.line, 22);

  // Controle limpo
  const cleanResult = (await runCollector({
    repoDir: FIXTURE_CLEAN_DIR,
    toolsRoot: MODULE_DEPLOY_DIR,
  })) as CollectorOutput;

  assertValidCollectorContract(cleanResult);
  assert.equal(cleanResult.coverage.find(c => c.tool === 'typedoc')?.status, 'ok');
  assert.equal(cleanResult.coverage.find(c => c.tool === 'dependency-cruiser')?.status, 'ok');
  assert.equal(cleanResult.coverage.find(c => c.tool === 'mermaid')?.status, 'ok');
  assert.deepEqual(cleanResult.findings, []);
  assertGeneratedArtifacts(cleanResult);
});

test('os analisadores distinguem a documentação com defeitos do controle limpo', async () => {
  const readDefective = (rel: string) => readFileSync(join(FIXTURE_DEFECTIVE_DIR, rel), 'utf8');
  const readClean = (rel: string) => readFileSync(join(FIXTURE_CLEAN_DIR, rel), 'utf8');

  const defectiveBlocks = extractMermaidBlocks(['README.md'], readDefective);
  assert.equal(defectiveBlocks.length, 2);

  const cleanBlocks = extractMermaidBlocks(['README.md'], readClean);
  assert.equal(cleanBlocks.length, 2);

  const syntheticTypedocJson = {
    schemaVersion: '2.0',
    id: 0,
    name: 'fixture',
    kind: 1,
    children: [
      {
        id: 1,
        name: 'src/billing',
        kind: 2,
        children: [
          {
            id: 2,
            name: 'calculateInvoice',
            kind: 64,
            sources: [{fileName: 'src/billing.ts', line: 8}],
            signatures: [
              {
                id: 3,
                name: 'calculateInvoice',
                kind: 4096,
                comment: {summary: [{kind: 'text', text: 'Calcula o valor final da fatura.'}]},
                parameters: [
                  {id: 4, name: 'amountCents', kind: 32768, comment: {summary: [{kind: 'text', text: 'Valor'}]}},
                  {id: 5, name: 'taxRate', kind: 32768, comment: {summary: [{kind: 'text', text: 'Taxa'}]}},
                ],
              },
            ],
          },
          {
            id: 6,
            name: 'undocumentedCharge',
            kind: 64,
            sources: [{fileName: 'src/billing.ts', line: 12}],
            signatures: [{id: 7, name: 'undocumentedCharge', kind: 4096, parameters: []}],
          },
        ],
      },
      {
        id: 8,
        name: 'src/api',
        kind: 2,
        children: [
          {
            id: 9,
            name: 'handleBillingRoute',
            kind: 64,
            sources: [{fileName: 'src/api.ts', line: 10}],
            signatures: [
              {
                id: 10,
                name: 'handleBillingRoute',
                kind: 4096,
                comment: {summary: [{kind: 'text', text: 'Processa rota.'}]},
                parameters: [
                  {id: 11, name: 'customerId', kind: 32768},
                  {id: 12, name: 'amountCents', kind: 32768},
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const tdParsed = parseTypedocReport(
    syntheticTypedocJson,
    [
      '[warning] The signature src/billing.calculateInvoice has an @param with name "obsoleteDiscount", which was not used',
      '[warning] Failed to resolve link to "MissingTaxTable" in comment for src/api.handleBillingRoute',
    ].join('\n'),
    FIXTURE_DEFECTIVE_DIR,
    readDefective,
  );
  assert.equal(tdParsed.findings.length, 3);
  const mdCross = crossCheckMarkdownAgainstTypedoc(['README.md'], tdParsed.symbols, readDefective);
  assert.equal(mdCross.length, 1);
  assert.equal(mdCross[0]?.rule, 'DOC-TYPEDOC-MARKDOWN-ASSINATURA-DESATUALIZADA');
  assert.equal(mdCross[0]?.line, 7);

  const mdCrossClean = crossCheckMarkdownAgainstTypedoc(['README.md'], tdParsed.symbols, readClean);
  assert.deepEqual(mdCrossClean, []);

  const depJson = {
    modules: [
      {
        source: 'src/api.ts',
        dependencies: [{module: './billing.ts', resolved: 'src/billing.ts', coreModule: false, circular: false, couldNotResolve: false}],
        dependents: [],
        orphan: false,
      },
      {
        source: 'src/billing.ts',
        dependencies: [],
        dependents: ['src/api.ts'],
        orphan: false,
      },
    ],
  };
  const depDefective = parseDepcruiseReport(
    depJson,
    'flowchart LR\n  1["api.ts"]-->2["billing.ts"]',
    FIXTURE_DEFECTIVE_DIR,
    defectiveBlocks,
    readDefective,
  );
  assert.equal(depDefective.findings.length, 1);
  assert.equal(depDefective.findings[0]?.rule, 'DOC-DEPCRUISE-DEPENDENCIA-DOCUMENTADA-INEXISTENTE');

  const depClean = parseDepcruiseReport(
    depJson,
    'flowchart LR\n  1["api.ts"]-->2["billing.ts"]',
    FIXTURE_CLEAN_DIR,
    cleanBlocks,
    readClean,
  );
  assert.deepEqual(depClean.findings, []);

  const deterministicMermaidParser = async (code: string) => {
    if (code.includes('--->|')) {
      throw new Error("Parse error on line 2:\n...-->|fatura quebrada\nExpecting 'PIPE'");
    }
    return {diagramType: 'flowchart-v2'};
  };

  const mmDefective = await validateMermaidDocuments(
    ['README.md'],
    defectiveBlocks,
    new Set(['README.md', 'src/api.ts', 'src/billing.ts']),
    deterministicMermaidParser,
    'flowchart LR\n  A-->B',
  );
  assert.equal(mmDefective.findings.some(f => f.rule === 'DOC-MERMAID-SINTAXE-INVALIDA'), true);
  assert.equal(mmDefective.findings.some(f => f.rule === 'DOC-MERMAID-MODULO-INEXISTENTE'), true);

  const mmClean = await validateMermaidDocuments(
    ['README.md'],
    cleanBlocks,
    new Set(['README.md', 'src/api.ts', 'src/billing.ts']),
    deterministicMermaidParser,
    'flowchart LR\n  A-->B',
  );
  assert.deepEqual(mmClean.findings, []);
});

test('falha individual de ferramenta fica registrada na cobertura como failed sem abortar as demais', async () => {
  const result = (await runCollector({
    repoDir: FIXTURE_CLEAN_DIR,
    execFn: (bin: string) => {
      if (String(bin).includes('typedoc')) {
        return {status: 2, stdout: '', stderr: 'erro simulado no typedoc'};
      }
      return {status: 1, stdout: '', stderr: 'erro simulado no depcruise'};
    },
    mermaidParseFn: async () => ({diagramType: 'flowchart-v2'}),
  })) as CollectorOutput;

  assertValidCollectorContract(result);
  const td = result.coverage.find(c => c.tool === 'typedoc');
  const dc = result.coverage.find(c => c.tool === 'dependency-cruiser');
  const mm = result.coverage.find(c => c.tool === 'mermaid');
  assert.equal(td?.status, 'failed');
  assert.match(td?.detail ?? '', /status=2/);
  assert.equal(dc?.status, 'failed');
  assert.match(dc?.detail ?? '', /status=1/);
  assert.equal(mm?.status, 'ok');
});

test('um arquivo de saída deixado por ferramenta que falhou não vira cobertura bem-sucedida', async () => {
  const result = await runCollector({
    repoDir: FIXTURE_CLEAN_DIR,
    execFn: (bin, args) => {
      if (bin.endsWith('/typedoc')) {
        const options = JSON.parse(readFileSync(args[1], 'utf8')) as {json: string};
        writeFileSync(options.json, JSON.stringify({kind: 1, name: 'incompleto'}));
        return {status: 5};
      }
      const output = args[args.indexOf('--output-to') + 1];
      mkdirSync(dirname(output), {recursive: true});
      writeFileSync(output, args.includes('json') ? '{"modules":[]}' : 'flowchart LR\nA --> B');
      return {status: args.includes('json') ? 0 : 1};
    },
    mermaidParseFn: async () => ({diagramType: 'flowchart-v2'}),
  });
  assert.equal(result.coverage.find(row => row.tool === 'typedoc')?.status, 'failed');
  assert.equal(result.coverage.find(row => row.tool === 'dependency-cruiser')?.status, 'failed');
  assert.equal(result.coverage.find(row => row.tool.endsWith(':artefato')), undefined);
  assert.deepEqual(result.findings, []);
});

test(
  'laboratório real em contêiner pelo digest encontra os defeitos plantados e aprova o controle limpo',
  {skip: process.env.AC_MODULE_LAB !== '1'},
  () => {
    const digestPath = join(MODULE_DEPLOY_DIR, 'digest.txt');
    assert.equal(existsSync(digestPath), true, 'deploy/modules/documentacao/digest.txt deve existir para o laboratório');
    const pinnedImage = readFileSync(digestPath, 'utf8').trim();
    assert.match(
      pinnedImage,
      /^(?:[a-z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/,
      `Referência de imagem inválida em digest.txt: ${pinnedImage}`,
    );

    const runContainer = (repoMountPath: string): CollectorOutput => {
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
        '256',
        '--memory',
        '1073741824',
        '--memory-swap',
        '1073741824',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,size=512m',
        '--mount',
        `type=bind,src=${resolve(repoMountPath)},dst=/repo,readonly`,
        pinnedImage,
      ];
      const res = spawnSync('docker', args, {
        encoding: 'utf8',
        timeout: 300_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(res.status, 0, `Contêiner falhou (${res.status}): ${res.stderr}`);
      const parsed = JSON.parse(res.stdout) as CollectorOutput;
      assertValidCollectorContract(parsed);
      return parsed;
    };

    const defectiveOut = runContainer(FIXTURE_DEFECTIVE_DIR);
    assertGeneratedArtifacts(defectiveOut);
    for (const toolName of ['typedoc', 'dependency-cruiser', 'mermaid']) {
      const row = defectiveOut.coverage.find(c => c.tool === toolName);
      assert.ok(row, `ferramenta ausente na cobertura: ${toolName}`);
      assert.equal(row.status, 'ok');
    }
    const foundRules = new Set(defectiveOut.findings.map(f => f.rule));
    assert.ok(foundRules.has('DOC-TYPEDOC-PARAM-DESATUALIZADO'));
    assert.ok(foundRules.has('DOC-TYPEDOC-SIMBOLO-SEM-DOC'));
    assert.ok(foundRules.has('DOC-TYPEDOC-LINK-QUEBRADO'));
    assert.ok(foundRules.has('DOC-TYPEDOC-MARKDOWN-ASSINATURA-DESATUALIZADA'));
    assert.ok(foundRules.has('DOC-DEPCRUISE-DEPENDENCIA-DOCUMENTADA-INEXISTENTE'));
    assert.ok(foundRules.has('DOC-MERMAID-MODULO-INEXISTENTE'));
    assert.ok(foundRules.has('DOC-MERMAID-SINTAXE-INVALIDA'));

    const cleanOut = runContainer(FIXTURE_CLEAN_DIR);
    for (const toolName of ['typedoc', 'dependency-cruiser', 'mermaid']) {
      const row = cleanOut.coverage.find(c => c.tool === toolName);
      assert.ok(row, `ferramenta ausente na cobertura do controle limpo: ${toolName}`);
      assert.equal(row.status, 'ok');
    }
    assert.deepEqual(cleanOut.findings, []);
    assertGeneratedArtifacts(cleanOut);
  },
);
