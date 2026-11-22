import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
  aggregateUndocumentedSymbols,
  clampLine,
  copyRepoSafely,
  createDefaultMermaidParser,
  crossCheckMarkdownAgainstTypedoc,
  extractMermaidBlocks,
  normalizeRepoPath,
  parseDepcruiseReport,
  parseTypedocReport,
  runCollector,
  sanitizeTsConfigInWork,
  validateMermaidDocuments,
} from '../deploy/modules/documentacao/collect.mjs';
import {assembleDocumentationArtifacts} from '../src/module-documentation-artifacts.ts';
import {hasKnownSecret} from '../src/verify-redact.ts';
import {REMEDIATION_ACCEPTANCE} from '../src/verify-types.ts';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const MODULE_DEPLOY_DIR = join(ROOT_DIR, 'deploy', 'modules', 'documentacao');
const FIXTURES = join(ROOT_DIR, 'tests', 'fixtures', 'module-documentacao');
const FIXTURE_DEFECTIVE_DIR = join(FIXTURES, 'defective');
const FIXTURE_CLEAN_DIR = join(FIXTURES, 'control-clean');
const VALID_SEVERITIES = new Set(['alta', 'media', 'baixa', 'informativa']);
const VALID_STATUSES = new Set(['ok', 'failed', 'skipped']);
const skipLocalTools = process.env.C8_TEST_LOCAL_TOOLS !== '1';

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
    assert.equal(item.file.split('/').includes('..'), false, `file não pode conter segmento ..: ${item.file}`);
    assert.equal(Number.isInteger(item.line), true);
    assert.ok(item.line >= 1, `line deve ser >= 1: ${item.line}`);
    assert.ok(VALID_SEVERITIES.has(item.severity), `severity inválida: ${item.severity}`);
    assert.equal(typeof item.message, 'string');
    assert.ok(item.message.length > 0);
    assert.equal(typeof item.evidence, 'string');
    assert.ok(item.evidence.length > 0);
  }
}

function assertGeneratedArtifacts(output: CollectorOutput): void {
  const {'api.json': catalog, 'dependencias.mmd': diagram} = assembleDocumentationArtifacts(output.coverage);
  assert.equal(catalog.status, 'present');
  assert.equal(diagram.status, 'present');
  const api = JSON.parse(catalog.content) as {name: string; file: string; summaryText: string}[];
  assert.ok(api.some(symbol => symbol.name === 'calculateInvoice' && symbol.file === 'src/billing.ts' && symbol.summaryText));
  assert.match(diagram.content, /flowchart/);
  assert.match(diagram.content, /api\.ts/);
  assert.match(diagram.content, /billing\.ts/);
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

  const expectedTools = ['typedoc', 'dependency-cruiser', 'mermaid', 'typescript', 'jsdom', 'sh-syntax'];
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
  assert.match(dockerfile, /COPY depcruise\.config\.json collect\.mjs report-privacy\.mjs \/opt\/documentacao-tools\//);
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
  skip: skipLocalTools,
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
  // A falta de JSDoc sai agregada por pacote; a amostra guarda a posição de cada símbolo.
  const undocumentedCharge = defectiveResult.findings.find(item => item.tool === 'typedoc'
    && item.rule === 'DOC-TYPEDOC-SIMBOLO-SEM-DOC' && item.evidence.includes('src/billing.ts:12 '));
  assert.equal(undocumentedCharge?.severity, 'informativa');
  assert.match(undocumentedCharge?.evidence ?? '', /src\/billing\.ts:12 \S*undocumentedCharge/);
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
  assert.deepEqual(tdParsed.findings.map(finding => finding.rule), ['DOC-TYPEDOC-SIMBOLO-SEM-DOC']);
  assert.deepEqual(tdParsed.unlocatedWarnings.map(warning => warning.rule),
    ['DOC-TYPEDOC-PARAM-DESATUALIZADO', 'DOC-TYPEDOC-LINK-QUEBRADO']);
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
    false,
    new Map([[defectiveBlocks[0], {unmeasured: 0, moduleEdges: [
      {from: 'src/api.ts', to: 'src/billing.ts', line: 14, rawLine: 'A --> B'},
      {from: 'src/billing.ts', to: 'src/api.ts', line: 15, rawLine: 'B --> A'},
    ]}]]),
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
  assert.equal(mmDefective.findings.some(f => f.rule === 'DOC-MERMAID-MODULO-INEXISTENTE'), false);

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
  const diagram = result.coverage.find(row => row.tool === 'dependency-cruiser:diagrama' && row.detail.includes('arquivo=README.md'));
  assert.equal(diagram?.status, 'skipped');
  assert.match(diagram.detail, /arestas_doc_conferidas=0; arestas_doc_nao_conferidas=0; trechos_doc_nao_medidos=2/);
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

const BASE_FILE = process.env.C8_TEST_BASE_FILE ?? join(ROOT_DIR, 'src', 'verification-modules.ts');

async function validateWithBase(output: CollectorOutput): Promise<CollectorOutput> {
  assertValidCollectorContract(output);
  const stdout = Buffer.from(JSON.stringify(output) + '\n');
  assert.ok(stdout.length <= 8 * 1024 * 1024);
  assert.ok(output.coverage.length >= 1 && output.coverage.length <= 5000);
  assert.ok(output.findings.length <= 999);
  for (const row of output.coverage) assert.ok(row.detail.length <= 2000);
  for (const finding of output.findings) {
    assert.ok(finding.message.length <= 2000 && finding.evidence.length <= 2000);
  }
  if (!process.env.C8_TEST_BASE_FILE && !existsSync(BASE_FILE)) return output;
  const {parseModuleCollectorOutput} = await import(pathToFileURL(BASE_FILE).href) as {
    parseModuleCollectorOutput: (raw: Buffer) => CollectorOutput;
  };
  const validated = parseModuleCollectorOutput(stdout);
  assert.deepEqual(
    validated.coverage.filter(row => row.tool.endsWith(':artefato')),
    output.coverage.filter(row => row.tool.endsWith(':artefato')),
  );
  return validated;
}

function syntheticTools(reflection: unknown, diagram: string, graph: unknown = {modules: []}) {
  const execFn: NonNullable<Parameters<typeof runCollector>[0]>['execFn'] = (bin, args) => {
    if (bin.endsWith('/typedoc')) {
      const {json} = JSON.parse(readFileSync(args[1], 'utf8')) as {json: string};
      writeFileSync(json, JSON.stringify(reflection));
    } else {
      const output = args[args.indexOf('--output-to') + 1];
      writeFileSync(output, args.includes('json') ? JSON.stringify(graph) : diagram);
    }
    return {status: 0};
  };
  return {execFn, mermaidParseFn: async () => ({diagramType: 'flowchart-v2'})};
}

test('as regras de conteúdo protegido do coletor usam os mesmos padrões da publicação', async () => {
  const definitions = (source: string) => source.match(/^const NOT_A_MASK = [\s\S]*?^\];$/m)?.[0];
  const canonical = definitions(readFileSync(join(ROOT_DIR, 'src', 'verify-redact.ts'), 'utf8'));
  assert.ok(canonical);
  assert.equal(definitions(readFileSync(join(MODULE_DEPLOY_DIR, 'report-privacy.mjs'), 'utf8')), canonical);
  const {isSecretClassBasename: hostSecretBasename} = await import('../src/verify-redact.ts');
  const {isSecretClassBasename: collectorSecretBasename} = await import(
    pathToFileURL(join(MODULE_DEPLOY_DIR, 'report-privacy.mjs')).href
  ) as {isSecretClassBasename: (file: string) => boolean};
  for (const sample of ['src/identity.ts', 'src/credentials.ts', 'src/id_rsa.ts', 'src/key.pem', '.env.local', 'kubeconfig.json', 'service-account-dev.json']) {
    assert.equal(collectorSecretBasename(sample), hostSecretBasename(sample), sample);
  }
});

test('o host recusa o caminho no achado normalizado e publica a coleta com omissões', async () => {
  const {parseModuleCollectorOutput, writeModuleReport} = await import('../src/verification-modules.ts');
  const tmp = mkdtempSync(join(tmpdir(), 'doc-private-paths-'));
  const repoDir = join(tmp, 'repo');
  const dataDirectory = join(tmp, 'data');
  const similar = 'Z'.repeat(35);
  const ordinaryFile = `src/${similar}.ts`;
  const protectedFile = `src/${similar}Z.ts`;
  const protectedSegment = `${'Y'.repeat(40)}.ts`;
  const referencedFile = `src/${protectedSegment}`;
  const skippedFile = `src/${'X'.repeat(36)}.txt`;
  const protectedDoc = `doc/${'W'.repeat(36)}.md`;
  const diagram = `flowchart LR\nA["src"] --> B["${similar}Z.ts"]\n`;
  const absolutePath = '/tmp/ac-doc-work-example/repo/' + protectedFile;
  const reflection = {kind: 1, name: 'sintético', children: [
    {kind: 64, name: 'regular', sources: [{fileName: ordinaryFile, line: 1}]},
    {kind: 64, name: 'internal', sources: [{fileName: protectedFile, line: 1}]},
    {kind: 64, name: 'reviewed', sources: [{fileName: referencedFile, line: 1}],
      comment: {summary: [{text: 'Função de teste.'}]}, signatures: [{parameters: [{name: 'current'}]}]},
  ]};
  const graph = {modules: [ordinaryFile, protectedFile, referencedFile].map(source => ({source, dependencies: []}))};
  const common = {dataDirectory, module: 'documentacao' as const, fileCoverage: [], achados: [],
    projectId: '11111111-1111-4111-8111-111111111111', runId: '33333333-3333-4333-8333-333333333333',
    createdAt: new Date('2026-11-19T00:00:00Z'), commit: '0123456789abcdef0123456789abcdef01234567'};
  try {
    mkdirSync(join(repoDir, 'src'), {recursive: true});
    mkdirSync(join(repoDir, 'doc'));
    mkdirSync(dataDirectory, {mode: 0o700});
    writeFileSync(join(repoDir, ordinaryFile), 'export function regular() {}\n');
    writeFileSync(join(repoDir, protectedFile), 'export function internal() {}\n');
    writeFileSync(join(repoDir, referencedFile), 'export function reviewed(current: number) {}\n');
    writeFileSync(join(repoDir, skippedFile), 'Fixture nominal.\n');
    writeFileSync(join(repoDir, protectedDoc), '```mermaid\nflowchart LR\nA --> B\n```\n');
    writeFileSync(join(repoDir, 'README.md'), 'Confira `reviewed(old)` no exemplo.\n');

    assert.equal(hasKnownSecret(protectedFile), true);
    assert.equal(hasKnownSecret(ordinaryFile), false);
    assert.equal(hasKnownSecret(referencedFile), false);
    assert.equal(hasKnownSecret(protectedSegment), true);
    assert.equal(hasKnownSecret(diagram), false);
    assert.equal(hasKnownSecret(absolutePath), false);
    const tools = syntheticTools(reflection, diagram, graph);
    const raw = await runCollector({
      ...tools, repoDir,
      execFn: (bin, args, options) => {
        const result = tools.execFn(bin, args, options);
        return bin.endsWith('/typedoc')
          ? {...result, stderr: `[warning] Failed to resolve link to "${absolutePath}" in comment for internal`}
          : result;
      },
    });
    assertValidCollectorContract(raw);
    const normalized = parseModuleCollectorOutput(JSON.stringify(raw), {module: 'documentacao'});
    assert.deepEqual(normalized.findings.map(finding => finding.file), [ordinaryFile]);
    const legacyPayload = {
      coverage: normalized.coverage,
      findings: [{...normalized.findings[0], file: protectedFile}],
    };
    assert.throws(() => parseModuleCollectorOutput(JSON.stringify(legacyPayload), {module: 'documentacao'}),
      {code: 'VERIFY_PATH_FORBIDDEN'});
    const legacy = {...normalized, findings: [{...normalized.findings[0], file: protectedFile}]};
    assert.equal(legacy.findings[0]?.file, protectedFile);
    assert.equal(hasKnownSecret(legacy.findings[0]!.message), false);
    assert.equal(hasKnownSecret(legacy.findings[0]!.evidence), false);
    await assert.rejects(writeModuleReport({...common, raw: legacy, toolCoverage: legacy.coverage}),
      {code: 'VERIFY_SECRET_IN_REPORT'});
    assert.equal(existsSync(join(dataDirectory, 'verificacoes')), false);

    assert.deepEqual(assembleDocumentationArtifacts(normalized.coverage), {
      'api.json': {status: 'absent'}, 'dependencias.mmd': {status: 'absent'},
    });
    const rows = normalized.coverage;
    assert.ok(rows.some(row => row.tool === 'typedoc:markdown' && row.detail === 'arquivo=README.md; assinaturas_conferidas=1'));
    assert.ok(rows.some(row => row.tool === 'typedoc:file' && row.detail.startsWith(`arquivo=${ordinaryFile};`)));
    assert.ok(rows.some(row => row.tool === 'dependency-cruiser:file' && row.detail.startsWith(`arquivo=${ordinaryFile};`)));
    assert.match(rows.find(row => row.tool === 'typedoc')!.detail, /simbolos_exportados=3/);
    assert.match(rows.find(row => row.tool === 'typedoc')!.detail, /avisos_sem_origem=1/);
    assert.equal(rows.some(row => row.tool === 'typedoc:aviso'), false);
    assert.match(rows.find(row => row.tool === 'dependency-cruiser')!.detail, /modulos=3/);
    assert.match(rows.find(row => row.tool === 'mermaid')!.detail, /blocos_mermaid=1, validos=1/);
    assert.deepEqual(rows.filter(row => row.status === 'failed'), []);
    assert.deepEqual(rows.find(row => row.tool === 'documentacao:privacidade'), {
      tool: 'documentacao:privacidade', version: '1', status: 'skipped',
      detail: 'Proteção de conteúdo. achados_omitidos=2; detalhes_cobertura_omitidos=9; artefatos_omitidos=api.json, dependencias.mmd',
    });
    const report = await writeModuleReport({...common, raw: normalized, toolCoverage: rows});
    assert.equal(existsSync(join(report.directory, 'api.json')), false);
    assert.equal(existsSync(join(report.directory, 'dependencias.mmd')), false);
    const persisted = readFileSync(join(report.directory, 'bruto', 'achados-brutos.json'), 'utf8');
    const rendered = readFileSync(join(report.directory, 'cobertura.md'), 'utf8');
    assert.ok(persisted.includes(ordinaryFile));
    assert.match(rendered, /artefatos_omitidos=api\.json, dependencias\.mmd/);
    for (const protectedName of [protectedFile, protectedSegment, skippedFile, protectedDoc]) {
      assert.equal(JSON.stringify(raw).includes(protectedName), false);
      assert.equal(persisted.includes(protectedName), false);
      assert.equal(rendered.includes(protectedName), false);
    }
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('omissões no catálogo, no grafo e em diagnósticos preservam os produtos independentes', async () => {
  const cleanDiagram = 'flowchart LR\nA-->B\n';
  const safeCatalog = {kind: 1, name: 'sintético', children: [
    {kind: 64, name: 'calculateInvoice', sources: [{fileName: 'src/billing.ts', line: 8}]},
  ]};
  const signaturePart = `ghp_${'Q'.repeat(20)}`;
  const protectedDescription = '"client_secret": "fixture de documentação"';
  const graph = {modules: [{source: 'src/billing.ts', dependencies: []}]};
  const descriptionCatalog = {...safeCatalog, children: [{...safeCatalog.children[0], comment: {summary: [{text: protectedDescription}]}}]};
  const signatureCatalog = {...safeCatalog, children: [{...safeCatalog.children[0], signatures: [{parameters: [{name: signaturePart}]}]}]};
  assert.equal(hasKnownSecret(protectedDescription), true);
  assert.equal(hasKnownSecret(JSON.stringify(descriptionCatalog)), false);
  const withDescription = await runCollector({repoDir: FIXTURE_CLEAN_DIR, ...syntheticTools(descriptionCatalog, cleanDiagram, graph)});
  const withSignature = await runCollector({repoDir: FIXTURE_CLEAN_DIR, ...syntheticTools(signatureCatalog, cleanDiagram, graph)});
  const withGraph = await runCollector({repoDir: FIXTURE_CLEAN_DIR, ...syntheticTools(safeCatalog, `${cleanDiagram}%% ${protectedDescription}\n`, graph)});
  const validateArtifacts = async (output: CollectorOutput) => assembleDocumentationArtifacts((await validateWithBase(output)).coverage);
  for (const output of [withDescription, withSignature]) {
    assert.deepEqual(await validateArtifacts(output), {
      'api.json': {status: 'absent'}, 'dependencias.mmd': {status: 'present', content: cleanDiagram},
    });
    assert.match(output.coverage.find(row => row.tool === 'documentacao:privacidade')!.detail, /artefatos_omitidos=api\.json$/);
  }
  const artifacts = await validateArtifacts(withGraph);
  assert.equal(artifacts['api.json'].status, 'present');
  assert.equal(artifacts['dependencias.mmd'].status, 'absent');
  assert.equal(withGraph.findings.some(finding => finding.file === 'src/billing.ts'), true);
  assert.equal(JSON.stringify(withSignature).includes(signaturePart), false);
  assert.equal(JSON.stringify(withDescription).includes('fixture de documentação'), false);
  assert.equal(JSON.stringify(withGraph).includes('fixture de documentação'), false);
  for (const output of [withDescription, withSignature, withGraph]) {
    for (const tool of ['typedoc', 'dependency-cruiser', 'mermaid']) {
      assert.equal(output.coverage.find(row => row.tool === tool)?.status, 'ok');
    }
  }

  const testTools = syntheticTools(safeCatalog, cleanDiagram, graph);
  const diagnostic = 'aviso sintético '.repeat(14) + signaturePart;
  const withDiagnostics = await runCollector({
    repoDir: FIXTURE_CLEAN_DIR,
    execFn: (bin, args, options) => bin.endsWith('/typedoc')
      ? {status: 1, stderr: diagnostic} : testTools.execFn(bin, args, options),
    mermaidParseFn: async code => {
      if (code !== cleanDiagram) throw new Error(diagnostic);
      return testTools.mermaidParseFn();
    },
  });
  const diagnostics = await validateWithBase(withDiagnostics);
  const typedoc = diagnostics.coverage.find(row => row.tool === 'typedoc');
  assert.equal(typedoc?.status, 'failed');
  assert.equal(typedoc.detail, 'Detalhe omitido por proteção de conteúdo.');
  assert.match(diagnostics.coverage.find(row => row.tool === 'mermaid')!.detail, /invalidos=2/);
  assert.match(diagnostics.coverage.find(row => row.tool === 'documentacao:privacidade')!.detail,
    /achados_omitidos=2; detalhes_cobertura_omitidos=1; artefatos_omitidos=nenhum/);
  assert.equal(JSON.stringify(withDiagnostics).includes(signaturePart), false);
  assert.deepEqual(assembleDocumentationArtifacts(diagnostics.coverage)['dependencias.mmd'],
    {status: 'present', content: cleanDiagram});
});

test('a base recebe as partes e os produtos completos preservam aspas, escapes, Unicode e quebras de linha', async () => {
  const summary = 'Exemplo "sintético" \\ com acentuação e emoji 🧪\r\n\ttrecho\n'.repeat(150) + 'fim.';
  const reflection = {
    kind: 1, name: 'sintético',
    children: [{
      kind: 64, name: 'calculateInvoice', sources: [{fileName: 'src/billing.ts', line: 8}],
      comment: {summary: [{text: summary}]},
    }],
  };
  const graphHeader = 'flowchart LR\n%% ';
  const splitUnicode = graphHeader.padEnd(879, 'a') + '🧪';
  const diagram = splitUnicode + '\r\n\tA["ação e \\ barra"] --> B["fim"]\n';
  const output = await validateWithBase(await runCollector({
    repoDir: FIXTURE_CLEAN_DIR,
    ...syntheticTools(reflection, diagram),
  }));
  const expectedCatalog = parseTypedocReport(reflection, '', FIXTURE_CLEAN_DIR).symbols;
  assert.deepEqual(assembleDocumentationArtifacts([...output.coverage].reverse()), {
    'api.json': {status: 'present', content: JSON.stringify(expectedCatalog, null, 2)},
    'dependencias.mmd': {status: 'present', content: diagram},
  });
  assert.equal(expectedCatalog[0]?.summaryText, summary);
});

test('o coletor mantém artefatos completos no limite e sinaliza a omissão acima dele', async () => {
  const reflection = {kind: 1, name: 'sintético'};
  const limit = 512 * 1024;
  const diagram = 'flowchart LR\n%% '.padEnd(limit - 2, 'a') + 'é';
  const collect = async (text: string) => validateWithBase(await runCollector({
    repoDir: FIXTURE_CLEAN_DIR,
    ...syntheticTools(reflection, text),
  }));
  const atLimit = await collect(diagram);
  assert.deepEqual(assembleDocumentationArtifacts(atLimit.coverage)['dependencias.mmd'], {
    status: 'present', content: diagram,
  });
  const overLimit = await collect(diagram + '\n');
  assert.deepEqual(assembleDocumentationArtifacts(overLimit.coverage), {
    'api.json': {status: 'present', content: '[]'},
    'dependencias.mmd': {status: 'omitted', reason: 'size-limit'},
  });
});

test('cobertura e achados acima do contrato são contabilizados na saída', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'doc-limits-'));
  try {
    writeFileSync(join(tmp, 'index.ts'), 'export const sample = 0;\n');
    writeFileSync(join(tmp, 'ação.ts'), 'export const sample = 0;\n');
    for (let index = 0; index < 5000; index += 1) {
      writeFileSync(join(tmp, 'ignored-' + index + '.txt'), '');
    }
    const missing = {module: './ausente', couldNotResolve: true};
    const graph = {modules: [
      {source: 'ação.ts', dependencies: [missing]},
      {source: 'index.ts', dependencies: Array.from({length: 1001}, () => missing)},
    ]};
    const reflection = {kind: 1, name: 'sintético'};
    const diagram = 'flowchart LR\nA-->B\n';
    const output = await validateWithBase(await runCollector({
      repoDir: tmp, ...syntheticTools(reflection, diagram, graph),
    }));
    assert.equal(output.coverage.length, 5000);
    assert.equal(output.findings.length, 999);
    assert.ok(output.findings.every(finding => finding.file === 'ação.ts' || finding.file === 'index.ts'));
    assert.equal(output.findings.filter(finding => finding.file === 'ação.ts').length, 1);
    const limits = output.coverage.find(row => row.tool === 'documentacao:limites');
    assert.equal(limits?.status, 'failed');
    assert.match(limits?.detail ?? '', /linhas_cobertura_omitidas=[1-9]\d*; achados_omitidos=3/);
    assert.deepEqual(assembleDocumentationArtifacts(output.coverage)['dependencias.mmd'], {
      status: 'present', content: diagram,
    });
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('mensagens, evidências e stdout são limitados mesmo com diagnósticos multibyte', async () => {
  const missing = {module: './' + '界界界界"\\\u0000'.repeat(1400), couldNotResolve: true};
  const graph = {modules: [{source: 'src/billing.ts', dependencies: Array.from({length: 999}, () => missing)}]};
  const output = await validateWithBase(await runCollector({
    repoDir: FIXTURE_CLEAN_DIR,
    ...syntheticTools({kind: 1, name: 'sintético'}, 'flowchart LR\nA-->B\n', graph),
  }));
  assert.ok(output.findings.length > 0 && output.findings.length < 999);
  assert.equal(output.coverage.find(row => row.tool === 'documentacao:limites')?.status, 'failed');
});

test('diagramas só comparam pontas cobertas e conferem cada aresta da cadeia, ignorando comentários', {skip: skipLocalTools}, async () => {
  const root = join(FIXTURES, 'coverage-defect');
  const read = (file: string) => readFileSync(join(root, file), 'utf8');
  const blocks = extractMermaidBlocks(['README.md'], read);
  const graph = {modules: [
    {source: 'src/api.ts', dependencies: [{resolved: 'src/billing.ts'}]},
    {source: 'src/billing.ts', dependencies: []},
    {source: 'src/third.ts', dependencies: []},
  ]};
  const parse = await createDefaultMermaidParser();
  const repoFiles = new Set(['src/api.ts', 'src/billing.ts', 'src/third.ts', 'src/api.test.ts']);
  const validate = (input: typeof blocks) => validateMermaidDocuments(['README.md'], input, repoFiles, parse);
  const validation = await validate(blocks);
  assert.deepEqual(validation.findings, []);
  const defect = parseDepcruiseReport(graph, 'flowchart LR', root, blocks, read, false, validation.documentReferences);
  assert.deepEqual(defect.findings.map(f => f.line), [6, 7, 8, 10]);
  for (const finding of defect.findings) {
    assert.equal(finding.rule, 'DOC-DEPCRUISE-DEPENDENCIA-DOCUMENTADA-INEXISTENTE');
    assert.match(finding.message, /src\/(?:api|billing)\.ts -> src\/third\.ts/);
  }
  const {checkedEdges, skippedEdges, unmeasured, edgeMismatches} = defect.stats;
  assert.deepEqual({checkedEdges, skippedEdges, unmeasured, edgeMismatches}, {
    checkedEdges: 9, skippedEdges: 1, unmeasured: 0, edgeMismatches: 4,
  });
  assert.equal(defect.skippedEdgesByFile.get('README.md'), 1);
  assert.equal(defect.unmeasuredByFile.get('README.md'), 0);
  const control = structuredClone(graph);
  control.modules[0].dependencies.push({resolved: 'src/third.ts'});
  control.modules[1].dependencies.push({resolved: 'src/third.ts'});
  assert.deepEqual(parseDepcruiseReport(control, 'flowchart LR', root, blocks, read, false, validation.documentReferences).findings, []);

  for (const link of ['A -. chama .-> B', 'A == chama ==> B', 'A -- chama & grava = sim --> B', 'A -- "chama -->" --> B']) {
    const code = `flowchart LR\nA["src/api.ts"]; B["src/billing.ts"]\n${link}`;
    const input = [{file: 'README.md', startLine: 1, code}];
    const {documentReferences} = await validate(input);
    const result = parseDepcruiseReport(graph, 'flowchart LR', root, input, read, false, documentReferences);
    assert.equal(result.stats.checkedEdges, 1, link);
    assert.equal(result.stats.unmeasured, 0, link);
    assert.deepEqual(result.findings, [], link);
  }
});

test('origens e diagramas sem medição confiável não geram divergência', async () => {
  const blocks = [{file: 'README.md', startLine: 1, code: 'flowchart LR\nA["src/api.ts"] --> B["src/billing.ts"]'}];
  const target = {source: 'src/billing.ts', dependencies: []};
  const references = new Map([[blocks[0], {unmeasured: 0, moduleEdges: [
    {from: 'src/api.ts', to: 'src/billing.ts', line: 2, rawLine: 'A --> B'},
  ]}]]);
  for (const source of [
    {source: 'src/api.ts', dependencies: [{module: '@app/billing', couldNotResolve: true}]},
    {source: 'src/api.ts'},
    {source: 'src/api.ts', dependencies: [null]},
    {source: 'src/api.ts', dependencies: [], followable: false},
  ]) {
    const result = parseDepcruiseReport({modules: [source, target]}, 'flowchart LR', FIXTURE_CLEAN_DIR, blocks, undefined, false, references);
    assert.deepEqual(result.findings, []);
    assert.equal(result.stats.skippedEdges, 1);
  }
  const graph = {modules: [{source: 'src/api.ts', dependencies: []}, target]};
  const output = await runCollector({
    repoDir: FIXTURE_CLEAN_DIR,
    ...syntheticTools({kind: 1, name: 'x'}, 'flowchart LR\nA --> B', graph),
    mermaidParseFn: async code => {
      if (code.includes('src/api.ts')) throw new Error('Parse error on line 2');
    },
  });
  assert.deepEqual(output.findings.map(finding => finding.rule), ['DOC-MERMAID-SINTAXE-INVALIDA']);
  const diagram = output.coverage.find(row => row.tool === 'dependency-cruiser:diagrama');
  assert.equal(diagram?.status, 'skipped');
  assert.match(diagram.detail, /arestas_doc_conferidas=0; arestas_doc_nao_conferidas=0; trechos_doc_nao_medidos=2/);
});

test('Mermaid compara o grafo efetivo de descrições, rótulos redefinidos e cadeias compactas', {skip: skipLocalTools}, async () => {
  const parse = await createDefaultMermaidParser();
  const files = new Set(['a.ts', 'b.ts', 'c.ts']);
  const graph = {modules: [...files].map(source => ({source, dependencies: []}))};
  const compare = async (body: string) => {
    const file = 'arch.mmd';
    const blocks = [{file, startLine: 10, code: 'flowchart LR\n' + body}];
    const validated = await validateMermaidDocuments([file], blocks, files, parse);
    assert.deepEqual(validated.findings, []);
    return parseDepcruiseReport(graph, '', FIXTURE_CLEAN_DIR, blocks, undefined, false, validated.documentReferences);
  };
  const nodes = 'A["a.ts"]; B["b.ts"]; C["c.ts"]\n';
  const description = 'accDescr {\nA --> B\nX["ausente.ts"]\n}\n';
  const accessibility = await compare(nodes + description);
  assert.deepEqual(accessibility.stats, {
    totalModules: 3, totalDependencies: 0, unresolvedCount: 0, circularCount: 0,
    checkedEdges: 0, skippedEdges: 0, unmeasured: 0, edgeMismatches: 0, hasMermaidDiagram: false,
  });
  const actualEdge = await compare(nodes + description + '%% Comentário\nA --> B');
  assert.deepEqual(actualEdge.findings.map(finding => finding.line), [17]);
  assert.equal(actualEdge.stats.checkedEdges, 1);

  for (const prefix of ['A["a.ts"]\n', 'A["ausente.ts"]\n', '']) {
    const relabeled = await compare(prefix + 'A["Operador"]\nB["b.ts"]\nA --> B');
    assert.equal(relabeled.stats.checkedEdges, 0);
    assert.equal(relabeled.stats.unmeasured, 1);
    assert.deepEqual(relabeled.findings, []);
  }
  for (const nonPath of ['a.ts --> B', 'A["Importa a.ts"] --> B', 'A["a.ts / outro.ts"] --> B']) {
    const partial = await compare('B["b.ts"]\n' + nonPath);
    assert.equal(partial.stats.unmeasured, 1, nonPath);
    assert.deepEqual(partial.findings, [], nonPath);
  }
  const relabeledPath = await compare(nodes + 'A["c.ts"]\nA --> B');
  assert.equal(relabeledPath.stats.checkedEdges, 1);
  assert.match(relabeledPath.findings[0]?.message ?? '', /c\.ts -> b\.ts/);

  for (const chain of ['A-->B==chama==>C', 'A-->B==chama ==>C']) {
    const result = await compare(nodes + chain);
    assert.equal(result.stats.checkedEdges, 2, chain);
    assert.equal(result.stats.unmeasured, 0, chain);
    assert.deepEqual(result.findings.map(finding => finding.line), [12, 12], chain);
    assert.match(result.findings[0]?.message ?? '', /a\.ts -> b\.ts/);
    assert.match(result.findings[1]?.message ?? '', /b\.ts -> c\.ts/);
  }
});

test('subgrafos e nomes de arquivos ambíguos ficam sem medição e entidades preservam a linha da aresta', {
  skip: skipLocalTools,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-mermaid-endpoints-'));
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'tests'));
    for (const file of ['source.ts', 'existing.ts', 'target.ts', 'src/dup.ts', 'tests/dup.ts', 'tests/offgraph.ts']) {
      writeFileSync(join(root, file), '/** Valor. */\nexport const value = 1;\n');
    }
    writeFileSync(join(root, 'src', 'unique.ts'), '/** Valor. */\nexport {value} from "../target";\n');
    const diagram = [
      '---', 'title: Arquitetura', '---', 'flowchart LR',
      'G["ghost.ts"]', 'subgraph G["Camada"]', 'B["source.ts"]', 'end',
      'E["existing.ts"]', 'subgraph E["Camada 2"]', 'U["unique.ts"]', 'end',
      'T["target.ts"]', 'N["<span title="x">#quot; #9829;</span>"]', 'style B fill:#abc;',
      'G --> T', 'T --> E', 'D["dup.ts"] --> T', 'M["missing.ts"] --> T', 'N ~~~ T',
      'F["tests/offgraph.ts"] --> T', 'U --> T',
      '%% Comentário com #quot;', 'B -->|chama #43;| T',
    ];
    const markdownPrefix = ['# Arquitetura', '', '```mermaid'];
    writeFileSync(join(root, 'README.md'), [...markdownPrefix, ...diagram, '```', ''].join('\r\n'));
    const lineOf = (statement: string) => markdownPrefix.length + diagram.indexOf(statement) + 1;
    const result = await runCollector({repoDir: root, toolsRoot: MODULE_DEPLOY_DIR});

    const coverage = result.coverage.find(row => row.tool === 'dependency-cruiser:diagrama');
    assert.equal(coverage?.status, 'ok');
    assert.match(coverage.detail, /arestas_doc_conferidas=2; arestas_doc_nao_conferidas=1; trechos_doc_nao_medidos=5; cobertura parcial/);
    assert.deepEqual(result.findings.map(finding => [finding.rule, finding.line]), [
      ['DOC-MERMAID-MODULO-INEXISTENTE', lineOf('M["missing.ts"] --> T')],
      ['DOC-DEPCRUISE-DEPENDENCIA-DOCUMENTADA-INEXISTENTE', lineOf('B -->|chama #43;| T')],
    ]);
    assert.equal(result.findings[0].evidence, 'M["missing.ts"] --> T');
    assert.match(result.findings[1].evidence, /^aresta documentada: B -->\|chama #43;\| T \|/);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('Mermaid localiza a aresta original após YAML e comentários com aspas HTML normalizadas', {skip: skipLocalTools}, async () => {
  const parse = await createDefaultMermaidParser();
  const files = new Set(['a.ts', 'b.ts']);
  const graph = {modules: [...files].map(source => ({source, dependencies: []}))};
  const file = 'README.md';
  const edge = 'A -->|<span title="x">chama</span>| B';
  const document = [
    '# Arquitetura', '```mermaid', '---', 'title: |',
    "  A -->|<span title='x'>chama</span>| B", '---',
    'flowchart LR', '  A["a.ts"]', '  B["b.ts"]', `%% ${edge} Exemplo escrito: %%{...`, edge, '```',
  ];
  const inspect = async () => {
    const blocks = extractMermaidBlocks([file], () => document.join('\r\n'));
    const validated = await validateMermaidDocuments([file], blocks, files, parse);
    const compared = parseDepcruiseReport(graph, '', FIXTURE_CLEAN_DIR, blocks, undefined, false, validated.documentReferences);
    return {validated, compared};
  };
  const located = await inspect();
  assert.deepEqual(located.validated.findings, []);
  assert.equal(located.compared.stats.checkedEdges, 1);
  assert.equal(located.compared.stats.unmeasured, 0);
  assert.deepEqual(located.compared.findings.map(finding => finding.line), [11]);
  assert.ok(located.compared.findings[0].evidence.startsWith(`aresta documentada: ${edge} |`));

  document.splice(11, 0, edge);
  const repeated = await inspect();
  assert.equal(repeated.compared.stats.checkedEdges, 2);
  assert.deepEqual(repeated.compared.findings.map(finding => finding.line), [11, 12]);

  document.splice(10, 2, 'A --> )');
  const invalid = await inspect();
  assert.deepEqual(invalid.validated.findings.map(finding => [finding.rule, finding.line]), [['DOC-MERMAID-SINTAXE-INVALIDA', 11]]);

  document.splice(10, 1, `A --> B %%{init: {"theme":"default"}}%%`);
  const ambiguous = await inspect();
  assert.deepEqual(ambiguous.validated.findings, []);
  assert.deepEqual(ambiguous.compared.findings, []);
  assert.equal(ambiguous.compared.stats.checkedEdges, 0);
  assert.ok(ambiguous.compared.stats.unmeasured > 0);
});

test('Mermaid atribui a linha reportada de um diagrama de sequência com origem direta', {skip: skipLocalTools}, async () => {
  const parse = await createDefaultMermaidParser();
  const file = 'README.md';
  const validCode = 'sequenceDiagram\nAlice->>Bob: Olá\nBob->>Alice: Resposta';
  const invalidCode = 'sequenceDiagram\nAlice->>Bob: Olá\nAlice -? Bob';
  const blocks = [validCode, invalidCode, `---\ntitle: Conversa\n---\n${invalidCode}`,
    invalidCode.replace('\n', '\n%% Exemplo\n')].map((code, index) => ({file, startLine: 12 + index * 10, code}));
  const output = await validateMermaidDocuments([file], blocks, new Set(), parse);
  assert.deepEqual(output.documentReferences.get(blocks[0]), {moduleNodes: [], moduleEdges: [], unmeasured: 1});
  assert.deepEqual(output.findings.map(finding => [finding.rule, finding.line, finding.message.includes('iniciado')]), [
    ['DOC-MERMAID-SINTAXE-INVALIDA', 24, false],
    ['DOC-MERMAID-SINTAXE-INVALIDA', 32, true],
    ['DOC-MERMAID-SINTAXE-INVALIDA', 42, true],
  ]);

  const syntaxError = "Parse error on line 3:\n...Alice -? Bob\n--------^\nExpecting 'SOLID_ARROW', got 'INVALID'";
  const lexicalError = 'Lexical error on line 3. Unrecognized text.\n...Alice -? Bob\n--------^';
  for (const [message, line] of [
    [syntaxError, 14], [lexicalError, 14], ['Parse error on line 3: Unexpected end of input', 14],
    ['Parse error on line 3', 12], ['Parse error on line 3 em um exemplo', 12],
    ['Parse error on line 3: trecho de um exemplo', 12],
    [syntaxError.replace('line 3', 'line 30'), 12], [`Falha interna: ${syntaxError}`, 12],
    [`${syntaxError} em um exemplo`, 12], [`${lexicalError}\nComentário adicional`, 12],
  ] as const) {
    const error = await validateMermaidDocuments([file], [blocks[0]], new Set(), async () => { throw new Error(message); });
    assert.equal(error.findings[0].line, line, message);
    assert.equal(error.findings[0].message.includes('Linha do erro indeterminada'), line === 12, message);
  }
  const unknownVersion = await validateMermaidDocuments([file], [blocks[0]], new Set(), async () => {
    throw new Error(syntaxError);
  }, '', '12.4.0');
  assert.equal(unknownVersion.findings[0].line, 12);
  assert.match(unknownVersion.findings[0].message, /Linha do erro indeterminada/);
});

test('TypeDoc atribui avisos a membros e ao comentário do símbolo, mesmo com nomes repetidos', {skip: skipLocalTools}, () => {
  const root = join(FIXTURES, 'coverage-defect');
  const read = (file: string) => readFileSync(join(root, file), 'utf8');
  const comment = {summary: [{text: 'Documentado.'}]};
  const fileName = 'src/billing.ts';
  const link = (text: string) => ({summary: [{kind: 'inline-tag', tag: '@link', text}]});
  let nextId = 0;
  const symbolIdMap: Record<number, object> = {};
  const member = (name: string, line: number, kind: number, character: number, doc: object = comment) => {
    const id = ++nextId;
    symbolIdMap[id] = {packageName: '<unknown>', packagePath: join(root, fileName), qualifiedName: name};
    const sources = [{fileName, line, character}];
    return {id, name, kind, sources, comment: doc};
  };
  const callable = (name: string, line: number, kind: number, character: number, doc: object = comment) => ({
    ...member(name, line, kind, character),
    signatures: [member(name, line, 4096, character, doc)],
  });
  const sample = (line: number, doc: object = comment) => {
    const child = callable('sample', line, 64, 16, doc);
    return {kind: 1, name: 'x', children: [child], symbolIdMap};
  };
  const reflection = {kind: 1, name: 'x', children: [
    callable('first', 4, 64, 16), callable('second', 8, 64, 16),
    {...member('Billing', 10, 128, 13), children: [
      callable('charge', 15, 2048, 2, {
        summary: [{kind: 'text', text: 'Charge used to document `@param legacy`.'}],
        blockTags: [{tag: '@see', content: link('MissingCharge').summary}],
      }),
      {...member('hidden', 17, 2048, 10), flags: {isPrivate: true}},
    ]},
    {...member('Contract', 20, 256, 17), children: [callable('submit', 22, 2048, 2)]},
  ], symbolIdMap};
  const parsed = parseTypedocReport(reflection, [
    '[warning] The signature second has an @param with name "legacy", which was not used',
    '[warning] The signature Billing.charge has an @param with name "legacy", which was not used',
    '[warning] Failed to resolve link to "MissingCharge" in comment for Billing.charge',
  ].join('\n'), root, read);
  assert.deepEqual(parsed.findings.map(f => [f.rule, f.line]), [
    ['DOC-TYPEDOC-PARAM-DESATUALIZADO', 6],
    ['DOC-TYPEDOC-PARAM-DESATUALIZADO', 12],
    ['DOC-TYPEDOC-LINK-QUEBRADO', 13],
  ]);
  assert.ok(parsed.symbols.some(s => s.qualifiedName === 'Billing.charge'));
  assert.ok(parsed.symbols.some(s => s.qualifiedName === 'Contract.submit'));
  assert.equal(parsed.symbols.some(s => s.name === 'hidden'), false);

  const source = ['/** Example.', ' * ```js', ' * @param legacy', ' * ```', ' * @param legacy obsolete', ' */',
    'export function sample(current: string) { return current; }'].join('\n');
  const multilineCode = source.replace(' * ```js', ' * Inline ``example').replace(' * ```', ' * end``');
  const exampleWithOpener = source.replace(' * @param legacy\n', ' * const text = "/**";\n');
  const unusedParam = '[warning] The signature sample has an @param with name "legacy", which was not used';
  for (const example of [source, exampleWithOpener]) {
    assert.deepEqual(parseTypedocReport(sample(7), unusedParam, root, () => example).findings
      .map(f => [f.rule, f.line]), [['DOC-TYPEDOC-PARAM-DESATUALIZADO', 5]]);
  }
  for (const example of [source.replace(' * ```\n', ' * Aberto.\n'),
    multilineCode, multilineCode.replace('@param legacy obsolete', 'See the example.')]) {
    const result = parseTypedocReport(
      sample(7), unusedParam, root, () => example,
    );
    assert.deepEqual(result.findings, []);
    assert.equal(result.unlocatedWarnings[0]?.rule, 'DOC-TYPEDOC-PARAM-DESATUALIZADO');
  }

  const anonymous = parseTypedocReport(
    {kind: 1, name: 'x', children: [member('default', 4, 128, 0, link('Missing'))], symbolIdMap},
    '[warning] Failed to resolve link to "Missing" in comment for default', root,
    () => ['/** Public class.', ' * See {@link Missing}.', ' */', 'export default', 'class {}'].join('\n'),
  );
  assert.deepEqual(anonymous.findings.map(f => [f.rule, f.line]), [['DOC-TYPEDOC-LINK-QUEBRADO', 2]]);
  const arrow = parseTypedocReport(
    {kind: 1, name: 'x', children: [callable('default', 4, 64, 15, link('Missing'))], symbolIdMap},
    '[warning] Failed to resolve link to "Missing" in comment for default', root,
    () => ['/** Public arrow.', ' * See {@link Missing}.', ' */', 'export default (current: string) => current'].join('\n'),
  );
  assert.deepEqual(arrow.findings.map(f => [f.rule, f.line]), [['DOC-TYPEDOC-LINK-QUEBRADO', 2]]);

  const ambiguous = parseTypedocReport(
    sample(5, link('Missing')),
    '[warning] Failed to resolve link to "Missing" in comment for sample', root,
    () => ['/** Public function.', ' * See {@link Missing}.', ' * Compare {@link Missing}.', ' */', 'export function sample() {}'].join('\n'),
  );
  assert.deepEqual(ambiguous.findings, []);
  assert.equal(ambiguous.unlocated, 1);

  for (const padding of ['', '\u00A0']) {
    const unclosed = parseTypedocReport(
      sample(5, link('Missing')),
      '[warning] Failed to resolve link to "Missing" in comment for sample', root,
      () => ['/** Public function.', ' * See {@link Missing}.', ' * Compare {' + padding + '@link Missing', ' */',
        'export function sample() {}'].join('\n'),
    );
    assert.deepEqual(unclosed.findings, []);
    assert.equal(unclosed.unlocatedWarnings[0]?.rule, 'DOC-TYPEDOC-LINK-QUEBRADO');
  }

  const sameLine = parseTypedocReport(
    sample(4, link('Missing')),
    '[warning] Failed to resolve link to "Missing" in comment for sample', root,
    () => ['/** Public function.', ' * See {@link Missing} and {@linkplain Missing}.', ' */', 'export function sample() {}'].join('\n'),
  );
  assert.deepEqual(sameLine.findings, []);
  assert.equal(sameLine.unlocated, 1);

  const literalLink = ['/** Public function.', String.raw` * See \{@link Missing \}.`,
    ' * Literal `{@link Missing}`.', ' */', 'export function sample() {}'].join('\n');
  const reflectionWithLiteral = sample(5, link('Missing'));
  const diagnostic = 'Failed to resolve link to "Missing" in comment for sample';
  const withoutLocation = parseTypedocReport(reflectionWithLiteral, `[warning] ${diagnostic}`, root, () => literalLink);
  assert.deepEqual(withoutLocation.findings, []);
  assert.equal(withoutLocation.unlocated, 1);
  const unrelated = parseTypedocReport(reflectionWithLiteral, `[info] Exemplo: ${diagnostic}`, root, () => literalLink);
  assert.deepEqual(unrelated.findings, []);

  const packageLink = '[warning] Failed to resolve link to "@scope/pkg.Missing" in comment for sample';
  const suggested = `${packageLink}. You may have wanted "@scope/pkg!Missing"`;
  const readSuggested = () => ['/** Public function.', ' * See {@link @scope/pkg.Missing}.', ' * Example.', ' */',
    'export function sample() {}'].join('\n');
  const packageReflection = sample(5, link('@scope/pkg.Missing'));
  assert.deepEqual(parseTypedocReport(packageReflection, suggested, root, readSuggested).findings
    .map(f => [f.rule, f.line]), [['DOC-TYPEDOC-LINK-QUEBRADO', 2]]);
  const missingId = parseTypedocReport({...packageReflection, symbolIdMap: {}}, suggested, root, readSuggested);
  assert.deepEqual(missingId.findings, []);
  assert.equal(missingId.unlocated, 1);
  for (const message of [`[warning] ${diagnostic}. You may have wanted qualquer coisa`,
    `${packageLink}. You may have wanted "outro texto"`, `${suggested} em um exemplo`]) {
    assert.deepEqual(parseTypedocReport(reflectionWithLiteral, message, root, readSuggested).findings, [], message);
  }
});

test('TypeDoc exige declaração inequívoca com o nome, o tipo e o identificador do aviso', () => {
  const root = FIXTURE_CLEAN_DIR;
  const diagnostic = '[warning] sample (CallSignature), defined in @scope/pkg/src/api.ts, does not have any documentation';
  const fileName = 'src/api.ts';
  const first = {id: 2, name: 'sample', kind: 4096, sources: [{fileName, line: 2, character: 16}],
    comment: {summary: [{kind: 'text', text: 'Documentado.'}]}};
  const second = {id: 3, name: 'sample', kind: 4096, sources: [{fileName, line: 3, character: 16}]};
  const symbolId = {packageName: '@scope/pkg', packagePath: fileName, qualifiedName: 'sample'};
  const report = {
    kind: 1, name: 'x', symbolIdMap: {1: symbolId, 2: symbolId, 3: symbolId},
    children: [{id: 1, name: 'sample', kind: 64, sources: [...first.sources, ...second.sources],
      signatures: [first, second]}],
  };
  const files = new Map([
    ['package.json', '{"name":"@scope/pkg"}'],
    [fileName, ['/** Documentado. */', 'export function sample(value: string): string;',
      'export function sample(value: number): number;', 'export function sample(value: string | number) { return value; }'].join('\n')],
  ]);
  const parse = (data: object, warning = diagnostic) =>
    parseTypedocReport(data, warning, root, file => files.get(file) ?? '', MODULE_DEPLOY_DIR, new Set(files.keys()));
  const confirmed = parse(report);
  assert.deepEqual(confirmed.findings.map(finding => [finding.file, finding.line]), [[fileName, 3]]);
  assert.equal(confirmed.unlocated, 0);

  for (const signatures of [[{...first, comment: undefined}, second], [first, {...second, sources: []}],
    [first, {...second, sources: [...first.sources, ...second.sources]}]]) {
    const ambiguous = parse({...report, children: [{...report.children[0], signatures}]});
    assert.deepEqual(ambiguous.findings, []);
    assert.equal(ambiguous.unlocated, 1);
  }
  const unconfirmed = parse({...report, symbolIdMap: {1: symbolId}});
  assert.deepEqual(unconfirmed.findings, []);
  assert.equal(unconfirmed.unlocated, 1);
  const collision = parse({
    ...report,
    symbolIdMap: {...report.symbolIdMap, 4: symbolId},
    children: [...report.children, {name: 'sample', kind: 64,
      signatures: [{...second, id: 4, sources: [{fileName: 'nested/src/api.ts', line: 3}]}]}],
  });
  assert.deepEqual(collision.findings, []);
  assert.equal(collision.unlocated, 1);
  const wrongKind = parse(report, diagnostic.replace('(CallSignature)', '(Interface)'));
  assert.deepEqual(wrongKind.findings, []);
  assert.equal(wrongKind.unlocated, 1);
  assert.equal(parse(report, `${diagnostic} em um exemplo`).unlocated, 0);
});

test('TypeDoc publica a posição direta e preserva avisos de aliases e links ambíguos', {skip: skipLocalTools}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-confirmed-position-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"@scope/fixture"}');
    writeFileSync(join(root, 'api.ts'), 'export function original(value: string) { return value; }');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'api.ts'), [
      'import {original} from "../api";',
      '/** @function */',
      'export const alias = original;',
      'function local(value: string) { return value; }',
      '/** @function */',
      'export const sameFileAlias = local;',
      'export function direct() {}',
      '/** Consulte {@link MissingDirect}. */',
      'export function documented() {}',
      '/** Dois links para o mesmo destino.',
      ' * Consulte {@link MissingRepeated}.',
      ' * Compare {\u00A0@link MissingRepeated',
      ' */',
      'export function repeated() {}',
    ].join('\n'));

    const result = await validateWithBase(await runCollector({repoDir: root, toolsRoot: MODULE_DEPLOY_DIR}));
    const coverage = result.coverage.find(row => row.tool === 'typedoc');
    assert.equal(coverage?.status, 'ok', coverage?.detail);
    assert.match(coverage.detail, /avisos_sem_origem=4$/);
    assert.deepEqual(result.findings.filter(finding => finding.tool === 'typedoc')
      .map(finding => [finding.rule, finding.file, finding.line]).sort(), [
      ['DOC-TYPEDOC-LINK-QUEBRADO', 'src/api.ts', 8],
      ['DOC-TYPEDOC-SIMBOLO-SEM-DOC', 'api.ts', 1],
      ['DOC-TYPEDOC-SIMBOLO-SEM-DOC', 'src/api.ts', 7],
    ]);
    const pending = result.coverage.filter(row => row.tool === 'typedoc:aviso');
    assert.equal(pending.length, 4);
    for (const row of pending) {
      assert.equal(row.status, 'skipped');
      assert.match(row.detail, /Linha indeterminada\./);
      assert.doesNotMatch(row.detail, /\bapi\.ts\b/);
    }
    assert.equal(pending.filter(row => row.detail.includes('.alias"')).length, 1);
    assert.equal(pending.filter(row => row.detail.includes('.sameFileAlias"')).length, 1);
    assert.equal(pending.filter(row => row.detail.includes('MissingRepeated')).length, 2);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('TypeDoc usa a declaração de avisos reais com mapas de declaração inequívocos', {skip: skipLocalTools}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-declaration-map-'));
  try {
    const files = {
      'package.json': '{"name":"fixture"}',
      'index.ts': ['Confirmed', 'Empty', 'Nearby', 'Unmapped', 'Wrong', 'Multiple', 'Missing', 'Indexed', 'Hybrid', 'Direct']
        .map(name => `export {${name}} from "./types/${name.toLowerCase()}";`).join('\n'),
      'types/confirmed.d.ts': 'export interface Confirmed {\n}',
      'types/empty.d.ts': 'export interface Empty {}',
      'types/nearby.d.ts': 'export interface Nearby {}',
      'types/unmapped.d.ts': 'export interface Unmapped {}',
      'types/wrong.d.ts': 'export interface Wrong {}',
      'types/multiple.d.ts': '\n\nexport interface Multiple {}',
      'types/missing.d.ts': 'export interface Missing {}',
      'types/indexed.d.ts': 'export interface Indexed {}',
      'types/hybrid.d.ts': 'export interface Hybrid {}',
      'types/direct.d.ts': '\n\n\nexport interface Direct {}',
      'original/confirmed.ts': '\n/** Original. */\nexport interface Confirmed {}',
      'original/empty.ts': '/** Original. */\nexport interface Empty {}',
      'original/nearby.ts': '/** Original. */\nexport interface Nearby {}',
      'original/unmapped.ts': '/** Original. */\nexport interface Unmapped {}',
      'original/wrong.ts': '/** Original. */\nexport interface Different {}',
      'original/indexed.ts': '/** Original. */\nexport interface Indexed {}',
      'original/hybrid.ts': '/** Original. */\nexport interface Hybrid {}',
      'original/other.ts': 'export {};',
    };
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), {recursive: true});
      writeFileSync(join(root, file), body);
    }
    for (const [name, sources, mappings] of [
      // TypeScript 5.9.3 maps the generated name at 1:17 to the original name at 3:17.
      ['confirmed', ['confirmed.ts'], 'AAEA,MAAM,WAAW,SAAS;CAAG'],
      ['empty', ['empty.ts'], ''],
      ['nearby', ['nearby.ts'], 'gBACiB'], // Only a segment at generated column 16.
      ['unmapped', ['unmapped.ts'], 'iB'], // A generated coordinate with no original position.
      ['wrong', ['wrong.ts'], 'iBACiB'], // The mapped name is Different.
      ['multiple', ['confirmed.ts', 'other.ts'], ''],
      ['missing', ['missing.ts'], ''],
    ]) {
      writeFileSync(join(root, `types/${name}.d.ts.map`), JSON.stringify({
        version: 3, file: `${name}.d.ts`, sourceRoot: '../original', sources, names: [], mappings,
      }));
    }
    const sections = [{offset: {line: 0, column: 0},
      map: {version: 3, sources: ['../original/indexed.ts'], names: [], mappings: 'iBACiB'}}];
    writeFileSync(join(root, 'types/indexed.d.ts.map'), JSON.stringify({version: 3, file: 'indexed.d.ts', sections}));
    // The root mapping alone would confirm Hybrid at the exact coordinates.
    writeFileSync(join(root, 'types/hybrid.d.ts.map'), JSON.stringify({
      version: 3, file: 'hybrid.d.ts', sourceRoot: '../original', sources: ['hybrid.ts'], names: [], mappings: 'iBACiB', sections,
    }));
    const result = await runCollector({repoDir: root, toolsRoot: MODULE_DEPLOY_DIR});
    const coverage = result.coverage.find(row => row.tool === 'typedoc');
    assert.equal(coverage?.status, 'ok', coverage?.detail);
    assert.match(coverage.detail, /avisos_sem_origem=8$/);
    const findings = result.findings.filter(finding => finding.rule === 'DOC-TYPEDOC-SIMBOLO-SEM-DOC');
    // Os dois avisos localizados ficam no achado agregado do pacote types.
    assert.deepEqual(findings.map(finding => [finding.file, finding.line]), [['types/confirmed.d.ts', 1]]);
    assert.match(findings[0]?.evidence ?? '', /^TypeDoc: 2 sem documentação em types; .*types\/confirmed\.d\.ts:1 .*types\/direct\.d\.ts:4 /);
    const pending = result.coverage.filter(row => row.tool === 'typedoc:aviso');
    assert.equal(pending.length, 8);
    for (const name of ['Empty', 'Nearby', 'Unmapped', 'Wrong', 'Multiple', 'Missing', 'Indexed', 'Hybrid']) {
      assert.ok(pending.some(row => row.detail.includes(`.${name}"`) && row.detail.includes('Linha indeterminada.')), name);
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('TypeDoc mantém na cobertura o @param ambíguo entre exemplo inline e texto', {skip: skipLocalTools}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-param-position-'));
  try {
    writeFileSync(join(root, 'api.ts'), [
      '/** Exemplo em tag inline {@link',
      ' * @param legacy',
      ' * }. Texto. @param legacy Parâmetro antigo.',
      ' */',
      'export function illustrated(current: string) { return current; }',
      '/** Controle.',
      ' * @param legacy Parâmetro antigo.',
      ' */',
      'export function canonical(current: string) { return current; }',
    ].join('\n'));
    const result = await runCollector({repoDir: root, toolsRoot: MODULE_DEPLOY_DIR});
    assert.equal(result.coverage.find(row => row.tool === 'typedoc')?.status, 'ok');
    assert.deepEqual(result.findings.filter(finding => finding.rule === 'DOC-TYPEDOC-PARAM-DESATUALIZADO')
      .map(finding => [finding.file, finding.line]), [['api.ts', 7]]);
    const pending = result.coverage.filter(row => row.tool === 'typedoc:aviso'
      && row.detail.includes('DOC-TYPEDOC-PARAM-DESATUALIZADO'));
    assert.equal(pending.length, 1);
    assert.match(pending[0].detail, /Linha indeterminada\..*"illustrated".*"@param legacy"/);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('TypeDoc distingue o comentário efetivo do membro, exemplos e tags diretas', {skip: skipLocalTools}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-effective-comment-'));
  try {
    writeFileSync(join(root, 'api.ts'), [
      '/** Contrato da API.',
      ' * @property value Consulte {@link MissingValue}.',
      ' */',
      'export interface Api {',
      '  /** Outra descrição para {@link MissingValue}. */',
      '  value: string;',
      '  /** Consulte {@linkcode MissingDirectMember}. */',
      '  direct: string;',
      '}',
      '/** Visão geral.',
      ' * ``` ts',
      ' * @param legacy Exemplo.',
      ' * ```',
      ' * @param legacy Parâmetro antigo.',
      ' */',
      'export function fenced(current: string) { return current; }',
      '/** Consulte {@link MissingOperation}.',
      ' * @throws {Error} quando o valor é inválido.',
      ' */',
      'export function operate() {}',
      '/** Prepara a operação.',
      ' * @throws Error ao chamar {@linkplain MissingPreparation}.',
      ' */',
      'export function prepare() {}',
      '/** Exemplo documentado.',
      ' * @example Uso',
      ' * ```ts',
      ' * illustrated()',
      ' * ```',
      ' * Consulte {@link MissingExample}.',
      ' */',
      'export function illustrated() {}',
    ].join('\n'));

    const result = await runCollector({repoDir: root, toolsRoot: MODULE_DEPLOY_DIR});
    const coverage = result.coverage.find(row => row.tool === 'typedoc');
    assert.equal(coverage?.status, 'ok', coverage?.detail);
    assert.match(coverage.detail, /avisos_sem_origem=2$/);
    assert.deepEqual(result.findings.filter(finding => finding.tool === 'typedoc')
      .map(finding => [finding.rule, finding.file, finding.line]).sort(), [
      ['DOC-TYPEDOC-LINK-QUEBRADO', 'api.ts', 17],
      ['DOC-TYPEDOC-LINK-QUEBRADO', 'api.ts', 22],
      ['DOC-TYPEDOC-LINK-QUEBRADO', 'api.ts', 7],
      ['DOC-TYPEDOC-PARAM-DESATUALIZADO', 'api.ts', 14],
    ]);
    const pending = result.coverage.filter(row => row.tool === 'typedoc:aviso');
    assert.equal(pending.length, 2);
    assert.ok(pending.some(row => /Linha indeterminada\..*"Api\.value".*\{@link MissingValue\}/.test(row.detail)));
    assert.ok(pending.some(row => /Linha indeterminada\..*"illustrated".*\{@link MissingExample\}/.test(row.detail)));
    const catalog = assembleDocumentationArtifacts(result.coverage)['api.json'];
    assert.equal(catalog.status, 'present');
    if (catalog.status === 'present') {
      const symbols = JSON.parse(catalog.content) as {qualifiedName: string; summaryText: string}[];
      assert.equal(symbols.find(symbol => symbol.qualifiedName === 'Api.value')?.summaryText, 'Consulte MissingValue.');
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('TypeDoc preserva avisos de membros alcançados por @property em namespaces ancestrais', {skip: skipLocalTools}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-ancestor-comment-'));
  try {
    writeFileSync(join(root, 'api.ts'), [
      '/** Namespace externo.',
      ' * @prop Inner.Api.far Consulte {@link MissingFar}.',
      ' */',
      'export namespace Outer {',
      '  /** Namespace interno.',
      '   * @property Api.value Consulte {@link MissingValue} e {@link MissingAncestorOnly}.',
      '   */',
      '  export namespace Inner {',
      '    /** Contrato da API. */',
      '    export interface Api {',
      '      /** Outra descrição para {@link MissingValue}. */',
      '      value: string;',
      '      /** Outra descrição para {@link MissingFar}. */',
      '      far: string;',
      '      /** Consulte {@link MissingDirectMember}. */',
      '      direct: string;',
      '    }',
      '  }',
      '}',
      '/** Consulte {@link MissingIndependent}. */',
      'export function independent() {}',
      '/** @property Api.value Consulte {@link MissingMerged}. */',
      'export namespace Merged {',
      '  /** Contrato da API. */',
      '  export interface Api {',
      '    /** Outra descrição para {@link MissingMerged}. */',
      '    value: string;',
      '    /** Consulte {@link MissingUnproven}. */',
      '    unproven: string;',
      '  }',
      '}',
      'export namespace Merged {',
      '  /** Valor padrão. */',
      '  export const defaultValue = 0;',
      '}',
    ].join('\n'));

    const result = await runCollector({repoDir: root, toolsRoot: MODULE_DEPLOY_DIR});
    const coverage = result.coverage.find(row => row.tool === 'typedoc');
    assert.equal(coverage?.status, 'ok', coverage?.detail);
    assert.equal(coverage.version, '0.28.20');
    assert.deepEqual(result.findings.filter(finding => finding.rule === 'DOC-TYPEDOC-LINK-QUEBRADO')
      .map(finding => [finding.file, finding.line, finding.evidence]).sort(), [
      ['api.ts', 15, '[warning] Failed to resolve link to "MissingDirectMember" in comment for Outer.Inner.Api.direct'],
      ['api.ts', 20, '[warning] Failed to resolve link to "MissingIndependent" in comment for independent'],
    ]);
    const pending = result.coverage.filter(row => row.tool === 'typedoc:aviso');
    const expectedWarnings = [
      ['Merged.Api.unproven', 'MissingUnproven'],
      ['Merged.Api.value', 'MissingMerged'],
      ['Outer.Inner.Api.far', 'MissingFar'],
      ['Outer.Inner.Api.value', 'MissingAncestorOnly'],
      ['Outer.Inner.Api.value', 'MissingValue'],
    ].map(([member, link]) => 'DOC-TYPEDOC-LINK-QUEBRADO. Linha indeterminada. '
      + `Comentário JSDoc de "${member}" contém referência {@link ${link}} para símbolo inexistente.`);
    assert.ok(pending.every(row => row.status === 'skipped'));
    assert.deepEqual(pending.map(row => row.detail).sort(), expectedWarnings);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('TypeDoc verifica comentários de arquivo nas reflexões de projeto e módulo', {skip: skipLocalTools}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-file-comment-'));
  try {
    writeFileSync(join(root, 'api.ts'), [
      '/** @packageDocumentation',
      ' * @property Api.value Consulte {@link MissingFromFile}.',
      ' */',
      '/** Contrato da API. */',
      'export interface Api {',
      '  /** Outra descrição para {@link MissingFromFile}. */',
      '  value: string;',
      '}',
      '/** Consulte {@link MissingDirect}. */',
      'export function direct() {}',
    ].join('\n'));
    for (const prefix of ['', 'api.']) {
      if (prefix) writeFileSync(join(root, 'extra.ts'), '/** Controle. */\nexport const extra = 1;');
      const result = await runCollector({repoDir: root, toolsRoot: MODULE_DEPLOY_DIR});
      const coverage = result.coverage.find(row => row.tool === 'typedoc');
      assert.equal(coverage?.status, 'ok', coverage?.detail);
      assert.deepEqual(result.findings.filter(finding => finding.rule === 'DOC-TYPEDOC-LINK-QUEBRADO')
        .map(finding => [finding.file, finding.line, finding.evidence]), [
        ['api.ts', 9, `[warning] Failed to resolve link to "MissingDirect" in comment for ${prefix}direct`],
      ]);
      const pending = result.coverage.filter(row => row.tool === 'typedoc:aviso');
      assert.deepEqual(pending.map(row => row.detail), [
        'DOC-TYPEDOC-LINK-QUEBRADO. Linha indeterminada. '
          + `Comentário JSDoc de "${prefix}Api.value" contém referência {@link MissingFromFile} para símbolo inexistente.`,
      ]);
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('TypeDoc preserva a origem incerta de @property em módulo ambiente após outra instrução', {skip: skipLocalTools}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-ambient-module-comment-'));
  try {
    const ambientModule = [
      '/** @packageDocumentation',
      ' * @property Api.value Consulte {@link MissingFromModule}.',
      ' */',
      'declare module "api" {',
      '  /** Contrato da API. */',
      '  export interface Api {',
      '    /** Descrição local para {@link MissingFromModule}. */',
      '    value: string;',
      '    /** Consulte {@link MissingDirect}. */',
      '    direct: string;',
      '  }',
      '}',
    ];

    for (const [prefix, newline] of [[';', '\n'], ["declare module 'api' {}", '\r\n']]) {
      writeFileSync(join(root, 'api.ts'), [prefix, ...ambientModule].join(newline));

      const result = await runCollector({repoDir: root, toolsRoot: MODULE_DEPLOY_DIR});
      const coverage = result.coverage.find(row => row.tool === 'typedoc');
      assert.equal(coverage?.status, 'ok', coverage?.detail);
      assert.equal(coverage.version, '0.28.20');
      const catalog = assembleDocumentationArtifacts(result.coverage)['api.json'];
      assert.equal(catalog.status, 'present');
      const symbols = JSON.parse(catalog.content) as {qualifiedName: string; summaryText: string}[];
      assert.equal(symbols.find(symbol => symbol.qualifiedName === 'Api.value')?.summaryText, 'Consulte MissingFromModule.');
      assert.deepEqual(result.findings.filter(finding => finding.rule === 'DOC-TYPEDOC-LINK-QUEBRADO')
        .map(finding => [finding.file, finding.line, finding.evidence]), [
        ['api.ts', 10, '[warning] Failed to resolve link to "MissingDirect" in comment for Api.direct'],
      ]);
      const pending = result.coverage.filter(row => row.tool === 'typedoc:aviso');
      assert.deepEqual(pending.map(row => [row.status, row.detail]), [[
        'skipped', 'DOC-TYPEDOC-LINK-QUEBRADO. Linha indeterminada. '
          + 'Comentário JSDoc de "Api.value" contém referência {@link MissingFromModule} para símbolo inexistente.',
      ]]);
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('TypeDoc localiza a sobrecarga canônica e preserva avisos com escapes ou tags multilinha', {skip: skipLocalTools}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-overload-comments-'));
  try {
    writeFileSync(join(root, 'api.ts'), [
      '/** Primeira sobrecarga. */',
      'export function format(value: string): string;',
      '/** Segunda sobrecarga.',
      String.raw` * Exemplo \\{@link Missing}.`,
      ' * Consulte {@link',
      ' * Missing}.',
      String.raw` * Consulte {@link Missing\}Brace}.`,
      ' * @param old Parâmetro antigo.',
      ' */',
      'export function format(value: number): number;',
      'export function format(value: string | number) { return value; }',
      '/** Consulte {@link Again}. */',
      'export function repeated(value: string): string;',
      '/** Compare {@link Again}. */',
      'export function repeated(value: number): number;',
      'export function repeated(value: string | number) { return value; }',
      'export function withoutDoc(value: string): string;',
      'export function withoutDoc(value: number): number;',
      'export function withoutDoc(value: string | number) { return value; }',
      '/** Primeira sobrecarga. */',
      'export function canonical(value: string): string;',
      '/** Segunda sobrecarga. Consulte {@link MissingCanonical}.',
      ' * @param legacy Parâmetro antigo.',
      ' */',
      'export function canonical(value: number): number;',
      'export function canonical(value: string | number) { return value; }',
    ].join('\n'));
    const result = await runCollector({repoDir: root, toolsRoot: MODULE_DEPLOY_DIR});
    const coverage = result.coverage.find(row => row.tool === 'typedoc');
    assert.equal(coverage?.status, 'ok', coverage?.detail);
    assert.match(coverage.detail, /avisos_sem_origem=7$/);
    assert.deepEqual(result.findings.filter(finding => finding.tool === 'typedoc')
      .map(finding => [finding.rule, finding.file, finding.line]).sort(), [
      ['DOC-TYPEDOC-LINK-QUEBRADO', 'api.ts', 22],
      ['DOC-TYPEDOC-PARAM-DESATUALIZADO', 'api.ts', 23],
    ]);
    const pending = result.coverage.filter(row => row.tool === 'typedoc:aviso');
    for (const warning of ['{@link Missing}', '{@link Missing}Brace}', '@param old']) {
      assert.ok(pending.some(row => row.detail.includes(warning) && row.detail.includes('Linha indeterminada.')), warning);
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('TypeDoc preserva o catálogo sem interpretar mensagens de uma versão desconhecida', () => {
  const tools = mkdtempSync(join(tmpdir(), 'doc-typedoc-version-'));
  try {
    mkdirSync(join(tools, 'node_modules', 'typedoc'), {recursive: true});
    writeFileSync(join(tools, 'node_modules', 'typedoc', 'package.json'), '{"version":"0.29.0"}');
    const reflection = {kind: 1, name: 'x', children: [{name: 'sample', kind: 64, sources: [{fileName: 'sample.ts', line: 2}]}]};
    const output = parseTypedocReport(reflection, '[warning] Failed to resolve link to "Missing" in comment for sample',
      FIXTURE_CLEAN_DIR, () => '/** See {@link Missing}. */\nexport function sample() {}', tools);
    assert.equal(output.symbols[0].file, 'sample.ts');
    assert.deepEqual(output.findings.map(f => [f.rule, f.line]), [['DOC-TYPEDOC-SIMBOLO-SEM-DOC', 2]]);
  } finally {
    rmSync(tools, {recursive: true, force: true});
  }
});

test('TypeDoc localiza avisos reais de exports default e confere assinaturas documentadas inequívocas', {skip: skipLocalTools}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-default-exports-'));
  try {
    const files = {
      'contract.ts': ['/** Configuração.',
        ' * Literal `{@linkcode MissingContract}`.', ' * Consulte {@linkcode MissingContract}.',
        ' */', 'export default', 'interface Config {}'],
      'modes.ts': ['/** Modos.', ' * Consulte {@link MissingMode}.', ' */', 'enum Mode {', '  Active,', '}', 'export default Mode;'],
      'choice.ts': ['/** Escolhas.', ' * Consulte {@link MissingChoice}.', ' */', 'enum Choice {', '  /** Padrão. */ First,', '}', 'export { Choice as default };'],
      'control.ts': ['/** Controle. */', 'export default interface Control {}', '/** Formata. */', 'export function format(current: string) { return current; }',
        '/** Primeiro. */', 'export function repeated(one: string) { return one; }'],
      'other.ts': ['/** Segundo. */', 'export function repeated(two: string) { return two; }'],
      'README.md': ['# API', '`format(current)`', '`format(old)`', '`repeated(old)`'],
    };
    for (const [file, lines] of Object.entries(files)) writeFileSync(join(root, file), lines.join('\n') + '\n');
    const result = await runCollector({repoDir: root, toolsRoot: MODULE_DEPLOY_DIR});
    assert.equal(result.coverage.find(row => row.tool === 'typedoc')?.status, 'ok');
    assert.deepEqual(result.findings.filter(finding => finding.rule === 'DOC-TYPEDOC-LINK-QUEBRADO')
      .map(finding => [finding.file, finding.line]).sort(), [['choice.ts', 2], ['contract.ts', 3], ['modes.ts', 2]]);
    assert.deepEqual(result.findings.filter(finding => finding.rule === 'DOC-TYPEDOC-SIMBOLO-SEM-DOC')
      .map(finding => [finding.file, finding.line]), [['modes.ts', 5]]);
    assert.deepEqual(result.findings.filter(finding => finding.rule === 'DOC-TYPEDOC-MARKDOWN-ASSINATURA-DESATUALIZADA')
      .map(finding => [finding.file, finding.line]), [['README.md', 3]]);
    assert.match(result.coverage.find(row => row.tool === 'typedoc:markdown')?.detail ?? '', /assinaturas_conferidas=2$/);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('Markdown exige assinaturas presentes no relatório TypeDoc', () => {
  const comment = {summary: [{text: 'Documentado.'}]};
  const symbol = (name: string) => ({name, kind: 64, sources: [{fileName: 'src/api.ts', line: 1}], comment});
  const {symbols} = parseTypedocReport({kind: 1, name: 'fixture', children: [
    symbol('incomplete'),
    {...symbol('noArgs'), signatures: [{parameters: []}]},
  ]}, '', FIXTURE_CLEAN_DIR);
  const findings = crossCheckMarkdownAgainstTypedoc(['README.md'], symbols, () => '`incomplete()`\n`noArgs()`\n`noArgs(stale)`');
  assert.deepEqual(findings.map(finding => [finding.rule, finding.line]), [['DOC-TYPEDOC-MARKDOWN-ASSINATURA-DESATUALIZADA', 3]]);
});

test('ferramentas fixadas encontram as quatro arestas ausentes e conferem o controle real', {skip: skipLocalTools}, async () => {
  const root = join(FIXTURES, 'coverage-defect');
  const result = await runCollector({repoDir: root, toolsRoot: MODULE_DEPLOY_DIR});
  assert.equal(result.coverage.find(row => row.tool === 'typedoc')?.status, 'ok');
  assert.equal(result.coverage.find(row => row.tool === 'dependency-cruiser:resolucao'), undefined);
  assert.deepEqual(result.findings.filter(f => f.rule === 'DOC-DEPCRUISE-DEPENDENCIA-DOCUMENTADA-INEXISTENTE').map(f => f.line), [6, 7, 8, 10]);
  const measured = /arestas_doc_conferidas=9, arestas_doc_nao_conferidas=1, trechos_doc_nao_medidos=0/;
  assert.match(result.coverage.find(row => row.tool === 'dependency-cruiser')?.detail ?? '', measured);
  const catalog = assembleDocumentationArtifacts(result.coverage)['api.json'];
  assert.equal(catalog.status, 'present');
  if (catalog.status === 'present') {
    const symbols = JSON.parse(catalog.content) as {qualifiedName: string}[];
    assert.ok(symbols.some(s => s.qualifiedName.endsWith('Billing.charge')));
    assert.ok(symbols.some(s => s.qualifiedName.endsWith('Contract.submit')));
  }
  const params = result.findings.filter(f => f.rule === 'DOC-TYPEDOC-PARAM-DESATUALIZADO');
  assert.ok(params.some(f => f.line === 6));
  assert.ok(params.some(f => f.line === 12));
  assert.ok(params.some(f => f.file === 'src/billing.ts' && f.line === 31 && f.message.includes('"sample"')));
  assert.ok(params.some(f => f.file === 'src/billing.ts' && f.line === 36 && f.message.includes('"default"')));
  assert.ok(result.findings.some(f => f.rule === 'DOC-TYPEDOC-LINK-QUEBRADO' && f.line === 13));
  const clean = await runCollector({repoDir: join(FIXTURES, 'coverage-control'), toolsRoot: MODULE_DEPLOY_DIR});
  assert.equal(clean.coverage.find(row => row.tool === 'dependency-cruiser:resolucao'), undefined);
  assert.match(clean.coverage.find(row => row.tool === 'dependency-cruiser')?.detail ?? '', measured);
  assert.deepEqual(clean.findings, []);
});

test('configurações divergentes ou não analisáveis suspendem a comparação do grafo', {skip: skipLocalTools}, async () => {
  const mermaidParseFn = await createDefaultMermaidParser();
  for (const [config, reason] of [
    ['{"compilerOptions":{"\\u0070aths":{"@app/*":["src/*"]}}}', /paths/],
    ['{"extends":"./base.json"}', /baseUrl/],
    ['{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"}}', /module/],
    ['{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler","customConditions":["development"]}}', /customConditions/],
    ['{"compilerOptions":{"skipLibCheck":true}}', /modo de resolução implícito/],
    ['{ /* JSONC */ "compilerOptions": {}', /configuração não analisada/],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), 'doc-config-'));
    try {
      writeFileSync(join(root, 'index.ts'), 'export const value = 1;\n');
      writeFileSync(join(root, 'billing.ts'), 'export const billing = 1;\n');
      writeFileSync(join(root, 'tsconfig.json'), config);
      writeFileSync(join(root, 'base.json'), '{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["*"]}}}');
      writeFileSync(join(root, 'arch.mmd'), 'flowchart LR\nA["index.ts"] --> B["billing.ts"]\n');
      const graph = {modules: [{source: 'index.ts', dependencies: []}, {source: 'billing.ts', dependencies: []}]};
      const result = await runCollector({
        repoDir: root, ...syntheticTools({kind: 1, name: 'x'}, 'flowchart LR\nA --> B', graph), mermaidParseFn,
      });
      const resolution = result.coverage.find(row => row.tool === 'dependency-cruiser:resolucao');
      assert.equal(resolution?.status, 'skipped');
      assert.match(resolution.detail, reason);
      assert.match(result.coverage.find(row => row.tool === 'dependency-cruiser:diagrama')?.detail ?? '', /arestas_doc_conferidas=0; arestas_doc_nao_conferidas=1/);
      assert.deepEqual(result.findings, []);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  }
});

test('tsc -p seleciona build.json e moduleSuffixes impede falso positivo do grafo isolado', {skip: skipLocalTools}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-module-suffixes-'));
  try {
    writeFileSync(join(root, 'api.ts'), '/** API. */\nexport {billing} from "./billing";\n');
    for (const file of ['billing.ts', 'billing.native.ts']) {
      writeFileSync(join(root, file), '/** Billing. */\nexport const billing = 1;\n');
    }
    writeFileSync(join(root, 'arch.mmd'), 'flowchart LR\nA["api.ts"] --> B["billing.native.ts"]\n');
    const config = {module: 'ESNext', moduleResolution: 'bundler'};
    const manifest = (command: string) => writeFileSync(join(root, 'package.json'), JSON.stringify({scripts: {build: command}}));
    const project = (file: string, suffixes: boolean) => writeFileSync(join(root, file), JSON.stringify({
      compilerOptions: suffixes ? {...config, moduleSuffixes: ['.native', '']} : config,
    }));
    for (const file of ['build.json', 'tsconfig.build.json']) {
      project(file, true);
      const tsc = spawnSync(join(MODULE_DEPLOY_DIR, 'node_modules', '.bin', 'tsc'),
        ['-p', file, '--noEmit', '--traceResolution'], {cwd: root, encoding: 'utf8'});
      assert.equal(tsc.status, 0, tsc.stderr || tsc.stdout);
      assert.match(tsc.stdout, /Module name '\.\/billing' was successfully resolved to '.*\/billing\.native\.ts'/);
    }
    manifest([
      '# Build de exemplo; cd ignored && tsc -p tsconfig.build.json',
      '(true)# comentário; tsc -p tsconfig.ignorado.json',
      "NODE_ENV=production BUILD_LABEL='literal # $ ;'  >/dev/null npx --no-install tsc \\\n-p build.json # ; tsc -p tsconfig.build.json",
      'node -e "require(\'node:fs\').writeFileSync(\'script-ran\', \'yes\')"',
    ].join('\n'));

    const partial = await runCollector({repoDir: root, toolsRoot: MODULE_DEPLOY_DIR});
    assert.match(partial.coverage.find(row => row.tool === 'dependency-cruiser:resolucao')?.detail ?? '', /moduleSuffixes.* em build\.json/);
    assert.match(partial.coverage.find(row => row.tool === 'dependency-cruiser')?.detail ?? '', /arestas_doc_conferidas=0, arestas_doc_nao_conferidas=1/);
    assert.deepEqual(partial.findings.filter(finding => finding.tool === 'dependency-cruiser'), []);
    assert.equal(existsSync(join(root, 'script-ran')), false);

    project('build.json', false);
    const measured = await runCollector({repoDir: root, toolsRoot: MODULE_DEPLOY_DIR});
    assert.equal(measured.coverage.find(row => row.tool === 'dependency-cruiser:resolucao'), undefined);
    const [mismatch] = measured.findings.filter(finding => finding.tool === 'dependency-cruiser');
    assert.equal(mismatch?.rule, 'DOC-DEPCRUISE-DEPENDENCIA-DOCUMENTADA-INEXISTENTE');
    assert.match(mismatch.evidence, /módulos reais de api\.ts: \[billing\.ts\]/);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('seleção estática segue manifesto aninhado, references e extends JSONC dentro do snapshot', {skip: skipLocalTools}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-ts-projects-'));
  try {
    const graph = {modules: [{source: 'index.ts', dependencies: []}, {source: 'billing.ts', dependencies: []}]};
    const mermaidParseFn = await createDefaultMermaidParser();
    const collect = () => runCollector({
      repoDir: root, ...syntheticTools({kind: 1, name: 'x'}, 'flowchart LR\nA --> B', graph), mermaidParseFn,
    });
    const write = (file: string, content: string) => writeFileSync(join(root, file), content);
    const options = '{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler"}}';
    mkdirSync(join(root, 'app', 'build config'), {recursive: true});
    write('index.ts', 'export const value = 1;\n');
    write('billing.ts', 'export const billing = 1;\n');
    write('arch.mmd', 'flowchart LR\nA["index.ts"] --> B["billing.ts"]\n');
    write('base.json', options);
    write('app/package.json', JSON.stringify({scripts: {
      build: "npm exec -- tsc -b 'build config/project#local.json'",
      description: 'echo tsc -p example.json',
    }}));
    write('app/build config/project#local.json', '{ /* JSONC */ "extends": "../../base", }');
    const measured = await collect();
    assert.equal(measured.coverage.some(row => row.tool === 'dependency-cruiser:resolucao'), false);
    assert.equal(measured.findings[0]?.rule, 'DOC-DEPCRUISE-DEPENDENCIA-DOCUMENTADA-INEXISTENTE');

    write('app/build config/project#local.json', '{"extends":"../../base","references":[{"path":"./reference.json"}]}');
    write('app/build config/reference.json', '{"extends":["../../base","./suffixes"]}');
    write('app/build config/suffixes.json', '{"compilerOptions":{"moduleSuffixes":[".native",""]}}');
    const partial = await collect();
    assert.match(partial.coverage.find(row => row.tool === 'dependency-cruiser:resolucao')?.detail ?? '', /moduleSuffixes.*reference\.json/);
    assert.deepEqual(partial.findings, []);

    write('app/build config/suffixes.json', '{}');
    const boundaries = await collect();
    assert.match(boundaries.coverage.find(row => row.tool === 'dependency-cruiser:resolucao')?.detail ?? '', /limites entre projetos com references/);
    assert.deepEqual(boundaries.findings, []);

    write('app/build config/reference.json', '{"extends":"@synthetic/config"}');
    const outside = await collect();
    assert.match(outside.coverage.find(row => row.tool === 'dependency-cruiser:resolucao')?.detail ?? '', /extends não local/);
    assert.deepEqual(outside.findings, []);

    for (const build of ['tsc --project "$CONFIG"', 'MODE="$PROFILE" tsc -p build.json', 'MODE=$(printf prod) tsc -p build.json']) {
      write('app/package.json', JSON.stringify({scripts: {build}}));
      const dynamic = await collect();
      assert.match(dynamic.coverage.find(row => row.tool === 'dependency-cruiser:resolucao')?.detail ?? '', /comando TypeScript não analisado.*app\/package\.json/);
      assert.deepEqual(dynamic.findings, []);
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('AST do manifesto isola o diretório de subshells e registra executáveis calculados', {skip: skipLocalTools}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-shell-scope-'));
  try {
    mkdirSync(join(root, 'app'));
    const options = {module: 'ESNext', moduleResolution: 'bundler'};
    writeFileSync(join(root, 'build.json'), JSON.stringify({compilerOptions: options}));
    writeFileSync(join(root, 'app', 'build.json'), JSON.stringify({compilerOptions: {...options, moduleSuffixes: ['.native', '']}}));
    writeFileSync(join(root, 'index.ts'), 'export const value = 1;\n');
    writeFileSync(join(root, 'billing.ts'), 'export const billing = 1;\n');
    writeFileSync(join(root, 'arch.mmd'), 'flowchart LR\nA["index.ts"] --> B["billing.ts"]\n');
    const graph = {modules: [{source: 'index.ts', dependencies: []}, {source: 'billing.ts', dependencies: []}]};
    const mermaidParseFn = await createDefaultMermaidParser();
    const marker = join(root, 'script-ran');
    const collect = async (build: string) => {
      writeFileSync(join(root, 'package.json'), JSON.stringify({scripts: {build: `printf ran > '${marker}'\n${build}`}}));
      const result = await runCollector({
        repoDir: root, ...syntheticTools({kind: 1, name: 'fixture'}, 'flowchart LR\nA --> B', graph), mermaidParseFn,
      });
      assert.equal(existsSync(marker), false, build);
      return result;
    };

    for (const build of [
      'command cd app && tsc -p build.json', 'command -- cd app && tsc -p build.json',
      '(command cd app && tsc -p build.json)', 'cd app && (true); tsc -p build.json',
      'command cd app && tsc -p build.json &',
      'TSC=${TSC:-tsc}; exec "$TSC" -p build.json', 'command "$TSC" -p build.json', 'command -p -- "$TSC" -p build.json',
    ]) {
      const result = await collect(build);
      const resolution = result.coverage.find(row => row.tool === 'dependency-cruiser:resolucao');
      assert.equal(resolution?.status, 'skipped', build);
      assert.match(resolution.detail, /comando TypeScript não analisado.*package\.json/, build);
      assert.match(result.coverage.find(row => row.tool === 'dependency-cruiser:diagrama')?.detail ?? '', /arestas_doc_nao_conferidas=1/, build);
      assert.deepEqual(result.findings, [], build);
    }

    for (const build of [
      '(command cd app); tsc -p build.json', '(cd app; (cd ..)); command tsc -p build.json',
      'printf "%s" "$(cd app)"; exec tsc -p build.json', 'command -v "$TSC"; tsc -p build.json',
      'command cd app & tsc -p build.json', 'command cd app && true & tsc -p build.json',
      'command ./helpers/cd app; tsc -p build.json', './helpers/cd app; tsc -p build.json',
    ]) {
      const result = await collect(build);
      assert.equal(result.coverage.find(row => row.tool === 'dependency-cruiser:resolucao'), undefined, build);
      assert.deepEqual(result.findings.map(finding => finding.rule), ['DOC-DEPCRUISE-DEPENDENCIA-DOCUMENTADA-INEXISTENTE'], build);
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('Mermaid valida grafo gerado acima de 500 arestas dentro da faixa suportada e mantém segurança e teto', {skip: skipLocalTools}, async () => {
  const {parseModuleCollectorOutput, writeModuleReport} = await import('../src/verification-modules.ts');
  const tmp = mkdtempSync(join(tmpdir(), 'doc-mermaid-edges-'));
  const repoDir = join(tmp, 'repo');
  const dataDirectory = join(tmp, 'data');
  try {
    mkdirSync(join(repoDir, 'src'), {recursive: true});
    mkdirSync(dataDirectory, {mode: 0o700});
    writeFileSync(join(repoDir, 'src', 'index.ts'), '/** Modulo sintético. */\nexport const ok = 1;\n');
    const reflection = {kind: 1, name: 'sintético', children: [
      {kind: 64, name: 'ok', sources: [{fileName: 'src/index.ts', line: 1}], comment: {summary: [{text: 'Modulo sintético.'}]}},
    ]};
    const graph = {modules: [{source: 'src/index.ts', dependencies: []}]};
    const edgeDiagram = (count: number, directive = '') => [
      ...(directive ? [directive] : []),
      'flowchart LR',
      ...Array.from({length: count}, (_, i) => `  N${i}["src/n${i}.ts"] --> N${i + 1}["src/n${i + 1}.ts"]`),
    ].join('\n') + '\n';

    const mermaidParseFn = await createDefaultMermaidParser();
    const diagram520 = edgeDiagram(520);
    const okOut = await validateWithBase(await runCollector({
      repoDir,
      ...syntheticTools(reflection, diagram520, graph),
      mermaidParseFn,
    }));
    const mermaidOk = okOut.coverage.find(row => row.tool === 'mermaid');
    assert.equal(mermaidOk?.status, 'ok');
    assert.match(mermaidOk?.detail ?? '', /diagrama_codigo_valido=true; erro_diagrama_gerado=$/);
    assert.deepEqual(assembleDocumentationArtifacts(okOut.coverage)['dependencias.mmd'], {
      status: 'present', content: diagram520,
    });
    await writeModuleReport({
      dataDirectory, module: 'documentacao', projectId: '11111111-1111-4111-8111-111111111111',
      runId: '55555555-5555-4555-8555-555555555555', createdAt: new Date('2026-11-19T00:00:00Z'),
      commit: '0123456789abcdef0123456789abcdef01234567', toolCoverage: okOut.coverage, fileCoverage: [],
      achados: [], raw: okOut,
    });

    // Diretiva não relaxa maxEdges nem securityLevel; acima do teto (5000) o erro permanece.
    const overLimitDiagram = edgeDiagram(5001, '%%{init: {"maxEdges": 99999, "securityLevel": "loose"}}%%');
    const overOut = parseModuleCollectorOutput(JSON.stringify(await runCollector({
      repoDir,
      ...syntheticTools(reflection, overLimitDiagram, graph),
      mermaidParseFn,
    })), {module: 'documentacao'});
    const mermaidOver = overOut.coverage.find(row => row.tool === 'mermaid');
    assert.equal(mermaidOver?.status, 'failed');
    assert.match(mermaidOver?.detail ?? '', /diagrama_codigo_valido=false; erro_diagrama_gerado=Edge limit exceeded/);

    // Frontmatter também não relaxa o teto nem o nível de segurança.
    const frontmatterOver = edgeDiagram(5001, '---\nconfig:\n  maxEdges: 99999\n  securityLevel: loose\n---');
    const frontOut = parseModuleCollectorOutput(JSON.stringify(await runCollector({
      repoDir,
      ...syntheticTools(reflection, frontmatterOver, graph),
      mermaidParseFn,
    })), {module: 'documentacao'});
    assert.equal(frontOut.coverage.find(row => row.tool === 'mermaid')?.status, 'failed');
    assert.match(frontOut.coverage.find(row => row.tool === 'mermaid')?.detail ?? '', /Edge limit exceeded/);
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('omissões de privacidade não viram documentacao:limites e estouro real preserva a falha', async () => {
  const {isProtectedReportPath} = await import(pathToFileURL(join(MODULE_DEPLOY_DIR, 'report-privacy.mjs')).href) as {
    isProtectedReportPath: (file: string) => boolean;
  };
  assert.equal(isProtectedReportPath('src/.env.ts'), true);
  assert.equal(isProtectedReportPath('.github/workflows/ci.yml'), true);
  assert.equal(isProtectedReportPath('src/credentials.ts'), true);
  assert.equal(isProtectedReportPath('src/components/authentication/authorizations/index.ts'), false);
  assert.equal(isProtectedReportPath('src/ação.ts'), false);

  const tmp = mkdtempSync(join(tmpdir(), 'doc-privacy-vs-limits-'));
  try {
    mkdirSync(join(tmp, 'src'), {recursive: true});
    const secretPatternFile = `src/${'Z'.repeat(36)}.ts`;
    const secretClassFile = 'src/credentials.ts';
    const secondSecretClassFile = 'src/id_token.ts';
    writeFileSync(join(tmp, 'src', 'index.ts'), 'export const ok = 1;\n');
    writeFileSync(join(tmp, secretPatternFile), 'export const a = 1;\n');
    writeFileSync(join(tmp, secretClassFile), 'export const b = 1;\n');
    writeFileSync(join(tmp, secondSecretClassFile), 'export const c = 1;\n');

    const missing = {module: './ausente', couldNotResolve: true};
    const privacyOnlyGraph = {modules: [
      {source: secretPatternFile, dependencies: [missing]},
      {source: secretClassFile, dependencies: [missing]},
      {source: secondSecretClassFile, dependencies: [missing]},
      {source: 'src/index.ts', dependencies: []},
    ]};
    const reflection = {kind: 1, name: 'sintético', children: [
      {kind: 64, name: 'ok', sources: [{fileName: 'src/index.ts', line: 1}], comment: {summary: [{text: 'Ok.'}]}},
      {kind: 64, name: 'a', sources: [{fileName: secretPatternFile, line: 1}]},
      {kind: 64, name: 'b', sources: [{fileName: secretClassFile, line: 1}]},
      {kind: 64, name: 'c', sources: [{fileName: secondSecretClassFile, line: 1}]},
    ]};
    const cleanDiagram = 'flowchart LR\nA["src"] --> B["index.ts"]\n';
    const privacyOnly = await validateWithBase(await runCollector({
      repoDir: tmp, ...syntheticTools(reflection, cleanDiagram, privacyOnlyGraph),
    }));
    assert.equal(privacyOnly.coverage.find(row => row.tool === 'documentacao:limites'), undefined);
    const privacyRow = privacyOnly.coverage.find(row => row.tool === 'documentacao:privacidade');
    assert.equal(privacyRow?.status, 'skipped');
    assert.match(privacyRow?.detail ?? '', /achados_omitidos=6;/);

    // Mistura omissões de privacidade com estouro legítimo (>999 achados): apenas o estouro vai para documentacao:limites.
    const overflowGraph = {modules: [
      ...privacyOnlyGraph.modules.slice(0, 3),
      {source: 'src/index.ts', dependencies: Array.from({length: 1004}, () => missing)},
    ]};
    const overflow = await validateWithBase(await runCollector({
      repoDir: tmp, ...syntheticTools(reflection, cleanDiagram, overflowGraph),
    }));
    assert.equal(overflow.findings.length, 999);
    const overflowPrivacy = overflow.coverage.find(row => row.tool === 'documentacao:privacidade');
    assert.match(overflowPrivacy?.detail ?? '', /achados_omitidos=6;/);
    const overflowLimits = overflow.coverage.find(row => row.tool === 'documentacao:limites');
    assert.equal(overflowLimits?.status, 'failed');
    assert.equal(overflowLimits?.detail, 'linhas_cobertura_omitidas=0; achados_omitidos=5');
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('erro_diagrama_gerado omite rótulos divididos de caminho protegido e o caminho de authorizations é preservado', async () => {
  const {parseModuleCollectorOutput, writeModuleReport} = await import('../src/verification-modules.ts');
  const {hasProtectedReportText} = await import(pathToFileURL(join(MODULE_DEPLOY_DIR, 'report-privacy.mjs')).href) as {
    hasProtectedReportText: (text: string) => boolean;
  };
  const authPath = 'src/components/authentication/authorizations/index.ts';
  assert.equal(hasKnownSecret(authPath), false);
  assert.equal(hasProtectedReportText(authPath), false);

  const tmp = mkdtempSync(join(tmpdir(), 'doc-p2-fixes-'));
  const repoDir = join(tmp, 'repo');
  const dataDirectory = join(tmp, 'data');
  try {
    mkdirSync(join(repoDir, 'src', 'components', 'authentication', 'authorizations'), {recursive: true});
    mkdirSync(dataDirectory, {mode: 0o700});
    writeFileSync(join(repoDir, authPath), 'export function authorize() {}\n');
    const authReflection = {kind: 1, name: 'sintético', children: [
      {kind: 64, name: 'authorize', sources: [{fileName: authPath, line: 1}]},
    ]};
    const authGraph = {modules: [{source: authPath, dependencies: []}]};
    const authDiagram = 'flowchart LR\nA["src"] --> B["components/authentication/authorizations/index.ts"]\n';
    const authOut = await validateWithBase(await runCollector({
      repoDir, ...syntheticTools(authReflection, authDiagram, authGraph),
    }));
    assert.equal(authOut.coverage.find(row => row.tool === 'documentacao:privacidade'), undefined);
    assert.ok(authOut.findings.some(f => f.file === authPath));
    assert.ok(authOut.coverage.some(r => r.tool === 'typedoc:file' && r.detail.startsWith(`arquivo=${authPath};`)));
    assert.ok(authOut.coverage.some(r => r.tool === 'dependency-cruiser:file' && r.detail.startsWith(`arquivo=${authPath};`)));
    assert.deepEqual(assembleDocumentationArtifacts(authOut.coverage), {
      'api.json': {status: 'present', content: JSON.stringify(parseTypedocReport(authReflection, '', repoDir).symbols, null, 2)},
      'dependencias.mmd': {status: 'present', content: authDiagram},
    });

    // Agora inclui um caminho protegido dividido no diagrama gerado que falha no parser.
    const splitToken = 'Z'.repeat(36);
    const protectedPath = `src/${splitToken}.ts`;
    writeFileSync(join(repoDir, protectedPath), 'export const hidden = 1;\n');
    const splitDiagram = `flowchart LR\nA["src"] --> B["${splitToken}.ts"]\n`;
    const splitGraph = {modules: [{source: authPath, dependencies: []}, {source: protectedPath, dependencies: []}]};
    const rawSplit = await runCollector({
      repoDir,
      ...syntheticTools(authReflection, splitDiagram, splitGraph),
      mermaidParseFn: async () => {
        throw new Error(`Parse error on line 2:\nA["src"] --> B["${splitToken}.ts"]\n---^`);
      },
    });
    assert.match(rawSplit.coverage.find(row => row.tool === 'documentacao:privacidade')?.detail ?? '', /artefatos_omitidos=dependencias\.mmd/);
    const splitOut = parseModuleCollectorOutput(JSON.stringify(rawSplit), {module: 'documentacao'});
    const mermaidRow = splitOut.coverage.find(row => row.tool === 'mermaid');
    assert.equal(mermaidRow?.status, 'failed');
    assert.match(mermaidRow?.detail ?? '', /diagrama_codigo_valido=false; erro_diagrama_gerado=Detalhe omitido por proteção de conteúdo\.$/);
    assert.equal(JSON.stringify(splitOut).includes(splitToken), false);
    const report = await writeModuleReport({
      dataDirectory, module: 'documentacao', projectId: '11111111-1111-4111-8111-111111111111',
      runId: '66666666-6666-4666-8666-666666666666', createdAt: new Date('2026-11-19T00:00:00Z'),
      commit: '0123456789abcdef0123456789abcdef01234567', toolCoverage: splitOut.coverage, fileCoverage: [],
      achados: [], raw: splitOut,
    });
    assert.equal(existsSync(join(report.directory, 'dependencias.mmd')), false);
    assert.equal(readFileSync(join(report.directory, 'cobertura.md'), 'utf8').includes(splitToken), false);
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('diagnóstico multilinhas truncado antes da reticência é omitido no coletor e continua recusado se injetado na base', async () => {
  const {parseModuleCollectorOutput, writeModuleReport} = await import('../src/verification-modules.ts');
  const tmp = mkdtempSync(join(tmpdir(), 'doc-multiline-mask-'));
  const dataDirectory = join(tmp, 'data');
  mkdirSync(dataDirectory, {mode: 0o700});
  const maskedMultiline = `--password\n${'A'.repeat(2005)}…`;
  assert.equal(hasKnownSecret(maskedMultiline), false);
  assert.equal(hasKnownSecret(maskedMultiline.replace(/\s*\n\s*/g, ' ')), false);
  assert.equal(hasKnownSecret(maskedMultiline.slice(0, 2000)), false);
  assert.equal(hasKnownSecret(maskedMultiline.slice(0, 2000).replace(/\s*\n\s*/g, ' ')), true);

  try {
    const tools = syntheticTools({kind: 1, name: 'sintético'}, 'flowchart LR\nA-->B\n', {modules: [{source: 'src/billing.ts', dependencies: []}]});
    const out = parseModuleCollectorOutput(JSON.stringify(await runCollector({
      repoDir: FIXTURE_CLEAN_DIR,
      execFn: (bin, args, options) => bin.endsWith('/typedoc')
        ? {status: 1, stderr: maskedMultiline}
        : tools.execFn(bin, args, options),
      mermaidParseFn: async code => {
        if (code !== 'flowchart LR\nA-->B\n') throw new Error(maskedMultiline);
        return tools.mermaidParseFn();
      },
    })), {module: 'documentacao'});
    assert.equal(out.coverage.find(row => row.tool === 'typedoc')?.detail, 'Detalhe omitido por proteção de conteúdo.');
    assert.match(out.coverage.find(row => row.tool === 'documentacao:privacidade')?.detail ?? '', /achados_omitidos=2; detalhes_cobertura_omitidos=1;/);
    await writeModuleReport({
      dataDirectory, module: 'documentacao', projectId: '11111111-1111-4111-8111-111111111111',
      runId: '77777777-7777-4777-8777-777777777777', createdAt: new Date('2026-11-19T00:00:00Z'),
      commit: '0123456789abcdef0123456789abcdef01234567', toolCoverage: out.coverage, fileCoverage: [],
      achados: [], raw: out,
    });

    // O consumidor mantém a recusa caso o texto truncado antes da reticência chegue sem filtro.
    const injected = parseModuleCollectorOutput(JSON.stringify({
      coverage: [{tool: 'typedoc', version: '1', status: 'failed', detail: maskedMultiline.slice(0, 2000)}],
      findings: [],
    }), {module: 'documentacao'});
    await assert.rejects(writeModuleReport({
      dataDirectory, module: 'documentacao', projectId: '11111111-1111-4111-8111-111111111111',
      runId: '88888888-8888-4888-8888-888888888888', createdAt: new Date('2026-11-19T00:00:00Z'),
      commit: '0123456789abcdef0123456789abcdef01234567', toolCoverage: injected.coverage, fileCoverage: [],
      achados: [], raw: injected,
    }), {code: 'VERIFY_SECRET_IN_REPORT'});
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('falha final da CLI com caminho protegido preserva documentacao:privacidade', async () => {
  const {parseModuleCollectorOutput, writeModuleReport} = await import('../src/verification-modules.ts');
  const tmp = mkdtempSync(join(tmpdir(), 'doc-cli-catch-'));
  const dataDirectory = join(tmp, 'data');
  mkdirSync(dataDirectory, {mode: 0o700});
  const secretDir = 'W'.repeat(40);
  try {
    const cli = spawnSync(process.execPath, [join(MODULE_DEPLOY_DIR, 'collect.mjs')], {
      env: {...process.env, TMPDIR: join(tmp, secretDir, 'ausente')},
      encoding: 'utf8',
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout.includes(secretDir), false);
    const parsed = parseModuleCollectorOutput(cli.stdout, {module: 'documentacao'});
    assert.deepEqual(parsed.findings, []);
    assert.deepEqual(parsed.coverage, [
      {tool: 'documentacao', version: '1', status: 'failed', detail: 'Detalhe omitido por proteção de conteúdo.'},
      {
        tool: 'documentacao:privacidade',
        version: '1',
        status: 'skipped',
        detail: 'Proteção de conteúdo. achados_omitidos=0; detalhes_cobertura_omitidos=1; artefatos_omitidos=nenhum',
      },
    ]);
    await writeModuleReport({
      dataDirectory, module: 'documentacao', projectId: '11111111-1111-4111-8111-111111111111',
      runId: '99999999-9999-4999-8999-999999999999', createdAt: new Date('2026-11-19T00:00:00Z'),
      commit: '0123456789abcdef0123456789abcdef01234567', toolCoverage: parsed.coverage, fileCoverage: [],
      achados: [], raw: parsed,
    });
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('rotas com colchetes, parênteses e Unicode preservam achados e cobertura sem disparar documentacao:limites', async () => {
  const {writeModuleReport, readModuleReport} = await import('../src/verification-modules.ts');
  const tmp = mkdtempSync(join(tmpdir(), 'doc-route-paths-'));
  const repoDir = join(tmp, 'repo');
  const dataDirectory = join(tmp, 'data');
  const routeFiles = Array.from({length: 18}, (_, index) =>
    index % 3 === 0
      ? `src/app/(portal)/users/[id_${index}]/page.tsx`
      : index % 3 === 1
        ? `src/app/(auth)/session-[...slug-${index}]/route.ts`
        : `src/routes/ação (v${index})/[param].ts`,
  );
  try {
    mkdirSync(dataDirectory, {mode: 0o700});
    for (const rel of routeFiles) {
      mkdirSync(dirname(join(repoDir, rel)), {recursive: true});
      const dependency = rel === routeFiles[0] ? "import {handler as other} from '../../../../routes/ação (v2)/[param].js';\n" : '';
      writeFileSync(join(repoDir, rel), `${dependency}export function handler() { return 1; }\n`);
    }
    const reflection = {
      kind: 1,
      name: 'rotas',
      children: routeFiles.map((file, index) => ({
        kind: 64,
        name: `handler_${index}`,
        sources: [{fileName: file, line: 1}],
      })),
    };
    const graph = {modules: routeFiles.map(source => ({source, dependencies: []}))};
    const diagram = 'flowchart LR\nA["src"] --> B["app"]\n';
    const raw = await runCollector({repoDir, ...syntheticTools(reflection, diagram, graph)});
    assertValidCollectorContract(raw);
    const validated = await validateWithBase(raw);
    // Os símbolos sem JSDoc saem num achado por pacote, e a amostra traz cada caminho.
    assert.deepEqual(validated.findings.map(f => [f.rule, f.severity, f.file.split('/').slice(0, 2).join('/')]).sort(),
      [['DOC-TYPEDOC-SIMBOLO-SEM-DOC', 'informativa', 'src/app'], ['DOC-TYPEDOC-SIMBOLO-SEM-DOC', 'informativa', 'src/routes']]);
    for (const file of routeFiles) assert.ok(validated.findings.some(f => f.evidence.includes(`${file}:1 `)), file);
    assert.equal(validated.coverage.find(row => row.tool === 'documentacao:limites'), undefined);
    assert.equal(validated.coverage.find(row => row.tool === 'documentacao:escopo'), undefined);
    assert.equal(validated.coverage.find(row => row.tool === 'documentacao:privacidade'), undefined);
    for (const file of routeFiles) {
      assert.ok(validated.coverage.some(r => r.tool === 'typedoc:file' && r.detail.startsWith(`arquivo=${file};`)));
      assert.ok(validated.coverage.some(r => r.tool === 'dependency-cruiser:file' && r.detail.startsWith(`arquivo=${file};`)));
    }
    const artifacts = assembleDocumentationArtifacts(validated.coverage);
    assert.equal(artifacts['api.json'].status, 'present');
    assert.equal(artifacts['dependencias.mmd'].status, 'present');
    const report = await writeModuleReport({
      dataDirectory, module: 'documentacao', projectId: '11111111-1111-4111-8111-111111111111',
      runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: new Date('2026-11-19T00:00:00Z'),
      commit: '0123456789abcdef0123456789abcdef01234567', toolCoverage: validated.coverage, fileCoverage: [],
      achados: [], raw: validated,
    });
    assert.equal(existsSync(join(report.directory, 'api.json')), true);
    assert.equal(existsSync(join(report.directory, 'dependencias.mmd')), true);

    if (!skipLocalTools) {
      const realRaw = await runCollector({repoDir});
      assertValidCollectorContract(realRaw);
      const realValidated = await validateWithBase(realRaw);
      assert.equal(realValidated.findings.length, 2);
      for (const file of routeFiles) assert.ok(realValidated.findings.some(f => f.evidence.includes(`${file}:1 `)), file);
      assert.equal(realValidated.coverage.find(row => row.tool === 'documentacao:limites'), undefined);
      assert.equal(realValidated.coverage.find(row => row.tool === 'documentacao:escopo'), undefined);
      assert.match(realValidated.coverage.find(row => row.tool === 'mermaid')?.detail ?? '', /diagrama_codigo_valido=true; erro_diagrama_gerado=$/);
      const realReport = await writeModuleReport({
        dataDirectory, module: 'documentacao', projectId: '11111111-1111-4111-8111-111111111111',
        runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', createdAt: new Date('2026-11-19T00:00:00Z'),
        commit: '0123456789abcdef0123456789abcdef01234567', toolCoverage: realValidated.coverage, fileCoverage: [],
        achados: realValidated.findings.map((finding, index) => ({
          id: `ACH-${String(index + 1).padStart(3, '0')}`, title: finding.message, severity: finding.severity,
          status: 'provavel', verifier: null, reference: `${finding.tool}:${finding.rule}`,
          where: {file: finding.file, line: finding.line}, scenario: finding.message, proof: finding.evidence,
          suggestion: 'Revisar o trecho.', acceptance: REMEDIATION_ACCEPTANCE,
          sources: [finding.tool, finding.rule], secretPreview: null,
        })), raw: realValidated,
      });
      const diagramPublished = readFileSync(join(realReport.directory, 'dependencias.mmd'), 'utf8');
      const pageNode = diagramPublished.match(/^subgraph [A-Z0-9]+\["\[id_0\]"\]\n([A-Z0-9]+)\["page\.tsx"\]$/m)?.[1];
      const targetNode = diagramPublished.match(/^subgraph [A-Z0-9]+\["ação \(v2\)"\]\n([A-Z0-9]+)\["\[param\]\.ts"\]$/m)?.[1];
      assert.ok(pageNode && targetNode, diagramPublished);
      assert.ok(diagramPublished.includes(`${pageNode}-->${targetNode}`));
      for (const label of ['(portal)', '[id_0]', 'page.tsx', 'ação (v2)', '[param].ts']) {
        assert.ok(diagramPublished.includes(label), `rótulo ausente: ${label}\n${diagramPublished}`);
      }
      const published = await readModuleReport(dataDirectory, '11111111-1111-4111-8111-111111111111',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'documentacao');
      assert.equal(published.achados.length, 18);
      assert.deepEqual(new Set(published.achados.map(a => a.where.file)), new Set(routeFiles));
      assert.match(published.toolCoverage.find(row => row.tool === 'mermaid')?.detail ?? '', /diagrama_codigo_valido=true; erro_diagrama_gerado=$/);
    }
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('TypeDoc instalado coleta a única entrada em rota com grupo e parâmetro', {skip: skipLocalTools}, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'doc-single-route-'));
  const route = 'src/app/(portal)/[id]/page.tsx';
  try {
    mkdirSync(dirname(join(tmp, route)), {recursive: true});
    writeFileSync(join(tmp, route), 'export function handler() { return 1; }\n');
    const result = await validateWithBase(await runCollector({repoDir: tmp, toolsRoot: MODULE_DEPLOY_DIR}));
    const typedoc = result.coverage.find(row => row.tool === 'typedoc');
    assert.equal(typedoc?.version, JSON.parse(readFileSync(join(MODULE_DEPLOY_DIR, 'package.json'), 'utf8')).dependencies.typedoc);
    assert.equal(typedoc?.status, 'ok', typedoc?.detail);
    assert.ok(result.findings.some(f => f.tool === 'typedoc' && f.file === route));
    assert.ok(result.coverage.some(row => row.tool === 'typedoc:file' && row.detail.startsWith(`arquivo=${route};`)));
    assert.equal(result.coverage.find(row => row.tool === 'documentacao:escopo'), undefined);
    // O padrão exato não pode incluir arquivos de teste excluídos da seleção.
    writeFileSync(join(tmp, 'src/app/(portal)/[id]/page.test.ts'), 'export const excludedSentinel = 1;\n');
    const withExcluded = await validateWithBase(await runCollector({repoDir: tmp, toolsRoot: MODULE_DEPLOY_DIR}));
    assert.equal(withExcluded.coverage.find(row => row.tool === 'typedoc')?.status, 'ok');
    assert.ok(withExcluded.findings.some(f => f.file === route));
    assert.equal(JSON.stringify(withExcluded).includes('excludedSentinel'), false);
    const catalog = assembleDocumentationArtifacts(withExcluded.coverage)['api.json'];
    assert.equal(catalog.status, 'present');
    assert.equal(catalog.content.includes('page.test.ts'), false);
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('separa omissões de escopo e privacidade de truncamento real preservando limites de achados e bytes', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'doc-scope-privacy-limits-'));
  try {
    mkdirSync(join(tmp, 'src', 'app', '(portal)', '[id]'), {recursive: true});
    const routeFile = 'src/app/(portal)/[id]/page.tsx';
    const outOfScopeA = 'src/fora$escopo.ts';
    const outOfScopeB = 'src/bad?route.ts';
    const secretFile = 'src/credentials.ts';
    writeFileSync(join(tmp, routeFile), 'export const route = 1;\n');
    writeFileSync(join(tmp, outOfScopeA), 'export const outA = 1;\n');
    writeFileSync(join(tmp, outOfScopeB), 'export const outB = 1;\n');
    writeFileSync(join(tmp, secretFile), 'export const secret = 1;\n');
    const missing = {module: './ausente', couldNotResolve: true};
    const reflection = {
      kind: 1, name: 'escopo',
      children: [
        {kind: 64, name: 'route', sources: [{fileName: routeFile, line: 1}], comment: {summary: [{text: 'Ok.'}]}},
        {kind: 64, name: 'outA', sources: [{fileName: outOfScopeA, line: 1}]},
        {kind: 64, name: 'outB', sources: [{fileName: outOfScopeB, line: 1}]},
        {kind: 64, name: 'secret', sources: [{fileName: secretFile, line: 1}]},
      ],
    };
    const diagram = 'flowchart LR\nA["src"] --> B["page.tsx"]\n';
    const underLimits = await validateWithBase(await runCollector({
      repoDir: tmp,
      ...syntheticTools(reflection, diagram, {
        modules: [
          {source: routeFile, dependencies: [missing]},
          {source: outOfScopeA, dependencies: []},
          {source: outOfScopeB, dependencies: []},
          {source: secretFile, dependencies: [missing]},
        ],
      }),
    }));
    assert.deepEqual(underLimits.findings.map(f => f.file), [routeFile]);
    assert.equal(underLimits.coverage.find(row => row.tool === 'documentacao:limites'), undefined);
    const scopeRow = underLimits.coverage.find(row => row.tool === 'documentacao:escopo');
    assert.equal(scopeRow?.status, 'skipped');
    assert.match(scopeRow?.detail ?? '', /achados_omitidos=2$/);
    const privRow = underLimits.coverage.find(row => row.tool === 'documentacao:privacidade');
    assert.equal(privRow?.status, 'skipped');
    assert.match(privRow?.detail ?? '', /achados_omitidos=2;/);

    // Com estouro real acima de 999 achados publicáveis, apenas o corte real vai para documentacao:limites.
    const overLimits = await validateWithBase(await runCollector({
      repoDir: tmp,
      ...syntheticTools(reflection, diagram, {
        modules: [
          {source: routeFile, dependencies: Array.from({length: 1004}, () => missing)},
          {source: outOfScopeA, dependencies: []},
          {source: outOfScopeB, dependencies: []},
          {source: secretFile, dependencies: [missing]},
        ],
      }),
    }));
    assert.equal(overLimits.findings.length, 999);
    assert.match(overLimits.coverage.find(row => row.tool === 'documentacao:escopo')?.detail ?? '', /achados_omitidos=2$/);
    assert.match(overLimits.coverage.find(row => row.tool === 'documentacao:privacidade')?.detail ?? '', /achados_omitidos=2;/);
    const limitsRow = overLimits.coverage.find(row => row.tool === 'documentacao:limites');
    assert.equal(limitsRow?.status, 'failed');
    assert.equal(limitsRow?.detail, 'linhas_cobertura_omitidas=0; achados_omitidos=5');
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('regressão 1: grafo, erro_diagrama_gerado e api.json protegem nomes de classe secreta com controle positivo', async () => {
  const {writeModuleReport} = await import('../src/verification-modules.ts');
  const {catalogHasProtectedContent} = await import(pathToFileURL(join(MODULE_DEPLOY_DIR, 'report-privacy.mjs')).href) as {
    catalogHasProtectedContent: (value: unknown) => boolean;
  };
  assert.equal(catalogHasProtectedContent([{name: 'a', file: 'src/credentials.ts'}]), true);
  assert.equal(catalogHasProtectedContent([{name: 'b', file: 'src/id_token.ts'}]), true);
  assert.equal(catalogHasProtectedContent([{name: 'c', file: 'src/identity.ts'}]), false);

  const tmp = mkdtempSync(join(tmpdir(), 'doc-reg1-secret-graph-'));
  const posRepo = join(tmp, 'pos');
  const protRepo = join(tmp, 'prot');
  const dataPos = join(tmp, 'data-pos');
  const dataProt = join(tmp, 'data-prot');
  try {
    mkdirSync(join(posRepo, 'src'), {recursive: true});
    mkdirSync(join(protRepo, 'src'), {recursive: true});
    mkdirSync(dataPos, {mode: 0o700});
    mkdirSync(dataProt, {mode: 0o700});

    // Controle positivo: src/app.ts importa src/identity.ts (não pertence à classe de segredos).
    writeFileSync(join(posRepo, 'src/app.ts'), 'import "./identity";\nexport function run() {}\n');
    writeFileSync(join(posRepo, 'src/identity.ts'), 'export function identity() {}\n');
    const posReflection = {
      kind: 1, name: 'positivo',
      children: [
        {kind: 64, name: 'run', sources: [{fileName: 'src/app.ts', line: 2}], comment: {summary: [{text: 'Run.'}]}},
        {kind: 64, name: 'identity', sources: [{fileName: 'src/identity.ts', line: 1}], comment: {summary: [{text: 'Id.'}]}},
      ],
    };
    const posGraph = {
      modules: [
        {source: 'src/app.ts', dependencies: [{resolved: 'src/identity.ts'}]},
        {source: 'src/identity.ts', dependencies: []},
      ],
    };
    const posDiagram = 'flowchart LR\nA["src/app.ts"] --> B["src/identity.ts"]\n';
    const posOut = await validateWithBase(await runCollector({
      repoDir: posRepo,
      ...syntheticTools(posReflection, posDiagram, posGraph),
      mermaidParseFn: async code => {
        if (code === posDiagram) throw new Error('Parse error on line 2:\nA["src/app.ts"] --> B["src/identity.ts"]\n---^');
        return {diagramType: 'flowchart-v2'};
      },
    }));
    assert.equal(posOut.coverage.find(r => r.tool === 'documentacao:privacidade'), undefined);
    assert.match(posOut.coverage.find(r => r.tool === 'mermaid')?.detail ?? '', /erro_diagrama_gerado=Parse error on line 2:.*identity\.ts/);
    assert.deepEqual(assembleDocumentationArtifacts(posOut.coverage), {
      'api.json': {status: 'present', content: JSON.stringify(parseTypedocReport(posReflection, '', posRepo).symbols, null, 2)},
      'dependencias.mmd': {status: 'present', content: posDiagram},
    });

    // Controle protegido: src/app.ts importa src/credentials.ts e src/id_token.ts (achados omitidos, mas no grafo e catálogo).
    writeFileSync(join(protRepo, 'src/app.ts'), 'import "./credentials";\nimport "./id_token";\nexport function run() {}\n');
    writeFileSync(join(protRepo, 'src/credentials.ts'), 'export function loadCredentials() {}\n');
    writeFileSync(join(protRepo, 'src/id_token.ts'), 'export function parseIdToken() {}\n');
    const protReflection = {
      kind: 1, name: 'protegido',
      children: [
        {kind: 64, name: 'run', sources: [{fileName: 'src/app.ts', line: 3}], comment: {summary: [{text: 'Run.'}]}},
        {kind: 64, name: 'loadCredentials', sources: [{fileName: 'src/credentials.ts', line: 1}], comment: {summary: [{text: 'Cred.'}]}},
        {kind: 64, name: 'parseIdToken', sources: [{fileName: 'src/id_token.ts', line: 1}], comment: {summary: [{text: 'Tok.'}]}},
      ],
    };
    const protGraph = {
      modules: [
        {source: 'src/app.ts', dependencies: [{resolved: 'src/credentials.ts'}, {resolved: 'src/id_token.ts'}]},
        {source: 'src/credentials.ts', dependencies: []},
        {source: 'src/id_token.ts', dependencies: []},
      ],
    };
    const protDiagram = 'flowchart LR\nA["src/app.ts"] --> B["credentials.ts"]\nA --> C["id_token.ts"]\n';
    const protRaw = await runCollector({
      repoDir: protRepo,
      ...syntheticTools(protReflection, protDiagram, protGraph),
      mermaidParseFn: async code => {
        if (code === protDiagram) throw new Error('Parse error on line 2:\nA["src/app.ts"] --> B["credentials.ts"]\n---^');
        return {diagramType: 'flowchart-v2'};
      },
    });
    const protSerialized = JSON.stringify(protRaw);
    assert.equal(protSerialized.includes('credentials.ts'), false);
    assert.equal(protSerialized.includes('id_token.ts'), false);
    const protOut = await validateWithBase(protRaw);
    assert.match(protOut.coverage.find(r => r.tool === 'mermaid')?.detail ?? '',
      /diagrama_codigo_valido=false; erro_diagrama_gerado=Detalhe omitido por proteção de conteúdo\.$/);
    assert.match(protOut.coverage.find(r => r.tool === 'documentacao:privacidade')?.detail ?? '',
      /artefatos_omitidos=api\.json, dependencias\.mmd$/);
    assert.deepEqual(assembleDocumentationArtifacts(protOut.coverage), {
      'api.json': {status: 'absent'},
      'dependencias.mmd': {status: 'absent'},
    });
    const protReport = await writeModuleReport({
      dataDirectory: dataProt, module: 'documentacao', projectId: '11111111-1111-4111-8111-111111111111',
      runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', createdAt: new Date('2026-11-19T00:00:00Z'),
      commit: '0123456789abcdef0123456789abcdef01234567', toolCoverage: protOut.coverage, fileCoverage: [],
      achados: [], raw: protOut,
    });
    assert.equal(existsSync(join(protReport.directory, 'api.json')), false);
    assert.equal(existsSync(join(protReport.directory, 'dependencias.mmd')), false);
    assert.equal(readFileSync(join(protReport.directory, 'cobertura.md'), 'utf8').includes('credentials.ts'), false);
    assert.equal(readFileSync(join(protReport.directory, 'cobertura.md'), 'utf8').includes('id_token.ts'), false);
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('regressão 2: diretório de 40 caracteres seguido de / continua protegido enquanto authorizations permanece liberado', async () => {
  const {hasProtectedReportText, isProtectedReportPath} = await import(
    pathToFileURL(join(MODULE_DEPLOY_DIR, 'report-privacy.mjs')).href
  ) as {
    hasProtectedReportText: (text: string) => boolean;
    isProtectedReportPath: (file: string) => boolean;
  };
  const dir40 = 'W'.repeat(40);

  // Controle protegido: segmento único de 40 caracteres seguido de `/` (e ancestrais de classe secreta).
  assert.equal(hasProtectedReportText(`${dir40}/ausente`), true);
  assert.equal(hasProtectedReportText(`/tmp/prefix/${dir40}/ausente`), true);
  assert.equal(hasProtectedReportText(`src/${dir40}/ausente.ts`), true);
  assert.equal(isProtectedReportPath(`src/${dir40}/ausente.ts`), true);
  assert.equal(isProtectedReportPath('src/credentials/helper.ts'), true);
  assert.equal(isProtectedReportPath('app/(portal)/.npmrc/[id].ts'), true);

  // Controle positivo: caminho legítimo multi-segmento com 40 caracteres entre barras.
  const positiveAuth = 'src/components/authentication/authorizations/index.ts';
  const positiveRouteAuth = 'src/(portal)/components/authentication/authorizations/[id].ts';
  assert.equal(hasProtectedReportText(positiveAuth), false);
  assert.equal(isProtectedReportPath(positiveAuth), false);
  assert.equal(hasProtectedReportText(positiveRouteAuth), false);
  assert.equal(isProtectedReportPath(positiveRouteAuth), false);

  const tmp = mkdtempSync(join(tmpdir(), 'doc-reg2-dir40-'));
  try {
    mkdirSync(join(tmp, 'src', '(portal)', 'components', 'authentication', 'authorizations'), {recursive: true});
    writeFileSync(join(tmp, positiveRouteAuth), 'export function checkAuth() {}\n');
    const out = await validateWithBase(await runCollector({
      repoDir: tmp,
      ...syntheticTools(
        {kind: 1, name: 'auth', children: [{kind: 64, name: 'checkAuth', sources: [{fileName: positiveRouteAuth, line: 1}]}]},
        'flowchart LR\nA["src"] --> B["auth"]\n',
        {modules: [{source: positiveRouteAuth, dependencies: []}]},
      ),
    }));
    assert.equal(out.coverage.find(row => row.tool === 'documentacao:privacidade'), undefined);
    assert.deepEqual(out.findings.map(f => f.file), [positiveRouteAuth]);

    // Falha CLI com diretório de 40 caracteres no início do caminho (sem prefixo antes dele) também preserva privacidade.
    const cli = spawnSync(process.execPath, [join(MODULE_DEPLOY_DIR, 'collect.mjs')], {
      env: {...process.env, TMPDIR: join(tmp, dir40, 'ausente')},
      encoding: 'utf8',
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout.includes(dir40), false);
    const parsed = JSON.parse(cli.stdout) as CollectorOutput;
    assert.ok(parsed.coverage.some(row => row.tool === 'documentacao:privacidade'));
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('símbolos sem JSDoc viram um achado informativo por pacote e o arquivo gerado sai do achado', () => {
  const undocumented = (file: string, line: number) => ({tool: 'typedoc', rule: 'DOC-TYPEDOC-SIMBOLO-SEM-DOC', file, line,
    severity: 'media' as const, message: `Símbolo público exportado "fn${line}" em ${file} não possui documentação JSDoc/TSDoc.`,
    evidence: `TypeDoc reflection kind=64 name=fn${line} (${file}:${line}) sem summary/blockTags`});
  const findings: ReturnType<typeof undocumented>[] = [];
  const symbols: {file: string; hasDoc: boolean}[] = [];
  for (const [pkg, count] of [['web/src', 20], ['api/core', 18], ['lib/util', 12]] as const) {
    for (let line = 1; line <= count; line += 1) {
      const file = `${pkg}/m${line % 3}.ts`;
      findings.push(undocumented(file, line));
      symbols.push({file, hasDoc: false});
    }
    symbols.push({file: `${pkg}/m0.ts`, hasDoc: true});
  }
  for (let line = 1; line <= 30; line += 1) findings.push(undocumented('web/src/api/schema.ts', line));
  const other = {tool: 'typedoc', rule: 'DOC-TYPEDOC-LINK-QUEBRADO', file: 'web/src/m1.ts', line: 3, severity: 'media' as const,
    message: 'Link quebrado.', evidence: 'aviso'};
  const sources: Record<string, string> = {'web/src/api/schema.ts': '/**\n * This file was auto-generated by openapi-typescript.\n */\n'};
  const result = aggregateUndocumentedSymbols([...findings, other], symbols, (file: string) => sources[file] ?? 'export {};\n');
  const aggregated = result.findings.filter(f => f.rule === 'DOC-TYPEDOC-SIMBOLO-SEM-DOC');
  assert.deepEqual(aggregated.map(f => [f.file.split('/').slice(0, 2).join('/'), f.severity]),
    [['api/core', 'informativa'], ['lib/util', 'informativa'], ['web/src', 'informativa']]);
  assert.match(aggregated[2]!.message, /^20 símbolo\(s\) .* em web\/src \(3 arquivo\(s\); 1 de 21 documentados, 5%\)\.$/);
  assert.equal(aggregated[2]!.evidence.split(', ').length, 20);
  assert.ok(!aggregated.some(f => f.evidence.includes('schema.ts')));
  assert.ok(result.findings.includes(other));
  assert.deepEqual([...result.generated], [['web/src/api/schema.ts', 30]]);
});

test('o Markdown de vendor fica fora da cópia e a mesma chamada na linha diverge uma vez', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'doc-vendor-'));
  try {
    const srcDir = join(tempRoot, 'repo');
    mkdirSync(join(srcDir, 'backend', 'vendor', 'github.com', 'river'), {recursive: true});
    mkdirSync(join(srcDir, 'third_party', 'lib'), {recursive: true});
    writeFileSync(join(srcDir, 'backend', 'vendor', 'github.com', 'river', 'AGENTS.md'), '`setup(db)`\n');
    writeFileSync(join(srcDir, 'third_party', 'lib', 'README.md'), '`setup(db)`\n');
    writeFileSync(join(srcDir, 'README.md'), '# Doc\n');
    const {copiedFiles, skipped} = copyRepoSafely(srcDir, join(tempRoot, 'copy'));
    assert.deepEqual(copiedFiles, ['README.md']);
    assert.ok(skipped.includes('backend/vendor'));
    assert.ok(skipped.includes('third_party'));
  } finally {
    rmSync(tempRoot, {recursive: true, force: true});
  }
  const symbols = [{kind: 64, name: 'setup', qualifiedName: 'setup', file: 'load/k6-lab.js', line: 25, hasDoc: true,
    summaryText: '', blockTags: [], parameters: [{name: 'options', optional: false, hasDoc: false}]}];
  const findings = crossCheckMarkdownAgainstTypedoc(['README.md'], symbols, () => '`setup(db)` e de novo `setup(db)`\n`setup(db)`\n');
  assert.deepEqual(findings.map(f => [f.rule, f.line]),
    [['DOC-TYPEDOC-MARKDOWN-ASSINATURA-DESATUALIZADA', 1], ['DOC-TYPEDOC-MARKDOWN-ASSINATURA-DESATUALIZADA', 2]]);
});
