import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {writeSecurityReport} from '../src/verify-report.ts';

type QaCoverageRow = {
  tool: string;
  version: string;
  status: 'ok' | 'failed' | 'skipped';
  detail: string;
};

type QaFinding = {
  tool: string;
  rule: string;
  file: string;
  line: number;
  severity: 'alta' | 'media' | 'baixa' | 'informativa';
  message: string;
  evidence: string;
};

type QaTestAnalysis = {
  validators: {line: number}[];
  activeTests: {title: string; features: string[]; limitedFeatures: string[]}[];
};

const {collectQaModule, summarizeNodePasses, analyzeSourceFile, loadQaSyntax, analyzeTestFile, buildTraceability, measureValidatorCases} = (await import(
  new URL('../deploy/modules/qa/collect.mjs', import.meta.url).href
)) as {
  collectQaModule: (options?: {repoDir?: string; failTool?: string}) => Promise<{
    coverage: QaCoverageRow[];
    findings: QaFinding[];
  }>;
  analyzeTestFile: (file: string, source: string, syntax: unknown) => QaTestAnalysis;
  analyzeSourceFile: (file: string, source: string, syntax: unknown) => unknown;
  loadQaSyntax: () => Promise<unknown>;
  buildTraceability: (options: Record<string, unknown>) => {extraRows: QaCoverageRow[]; findings: QaFinding[]};
  measureValidatorCases: (options: Record<string, unknown>) => {coverageRow: QaCoverageRow; findings: QaFinding[]};
  summarizeNodePasses: (passes: {summary: boolean; tests: {file: string; line: number; column: number; name: string; status: string}[]; coverage: never[]}[], sources: never[], version: string) => {extraRows: QaCoverageRow[]};
};

const {verifyQaLockfiles} = (await import(
  new URL('../deploy/modules/qa/verify-lock.mjs', import.meta.url).href
)) as {
  verifyQaLockfiles: (baseDir?: string) => {
    ok: boolean;
    packageLockSha256: string;
    toolCount: number;
    totalLockedPackages: number;
  };
};

const qaModuleDir = fileURLToPath(new URL('../deploy/modules/qa/', import.meta.url));
const fixtureDir = fileURLToPath(new URL('./fixtures/module-qa/', import.meta.url));
const cleanFixtureDir = fileURLToPath(new URL('./fixtures/module-qa-clean/', import.meta.url));
const entrypointPath = join(qaModuleDir, 'entrypoint.sh');
const realTools = {
  skip: ['@babel/parser', '@babel/traverse', 'jsdom', 'axe-core', '@apidevtools/swagger-parser', '@stryker-mutator/instrumenter']
    .every(name => existsSync(join(qaModuleDir, 'node_modules', name, 'package.json')))
    ? false : 'instale as ferramentas com npm ci --prefix deploy/modules/qa --ignore-scripts',
};
const {classifyMutant, comparePasses, decodeNodeReport, planMutations, runBoundedNode, selectNodeSuite} = await import(
  new URL('../deploy/modules/qa/execute-tests.mjs', import.meta.url).href
);

test('lockfiles e arquivo de imagem fixam versoes, integridade SHA-512/SHA-256 e usuario 65532', () => {
  const verified = verifyQaLockfiles(qaModuleDir);
  assert.equal(verified.ok, true);
  assert.equal(verified.toolCount, 8);
  assert.ok(verified.totalLockedPackages >= 100);

  const dockerfile = readFileSync(join(qaModuleDir, 'Dockerfile'), 'utf8');
  const lock = JSON.parse(readFileSync(join(qaModuleDir, 'qa-tools.lock.json'), 'utf8')) as {
    packageLockSha256: string;
    baseImage: {digest: string; tag: string};
    dependencies: {'playwright-core': {version: string}};
    languageRuntimes: {
      python: {version: string; image: string};
      go: {version: string; image: string};
      coverage: {version: string; url: string; sha256: string};
    };
  };
  assert.match(lock.baseImage.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(dockerfile.includes(lock.baseImage.digest), true);
  assert.ok(dockerfile.includes(`:${lock.baseImage.tag}@${lock.baseImage.digest}`));
  assert.ok(lock.baseImage.tag.startsWith(`v${lock.dependencies['playwright-core'].version}-`));
  assert.equal(dockerfile.includes(lock.packageLockSha256), true);
  assert.equal(/latest/i.test(dockerfile), false);
  assert.match(dockerfile, /sha256sum -c/);
  assert.match(dockerfile, /verify-lock\.mjs/);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  const {python, go, coverage} = lock.languageRuntimes;
  assert.ok(dockerfile.includes(`FROM ${python.image} AS qa-python`));
  assert.ok(dockerfile.includes(`FROM ${go.image} AS qa-go`));
  assert.ok(dockerfile.includes(`ADD --checksum=sha256:${coverage.sha256} ${coverage.url} `));
  assert.ok(dockerfile.includes(`sys.version_info[:3] == (${python.version.split('.').join(', ')})`));
  assert.ok(dockerfile.includes(`"go${go.version}"`));
  assert.ok(dockerfile.includes(`coverage.__version__ == "${coverage.version}"`));
  assert.match(dockerfile, /USER 65532:65532/);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/qa-entrypoint\.sh"\]/);
});

test('entrypoint recusa segmento .. e diretório inexistente', () => {
  const traversal = spawnSync('/bin/sh', [entrypointPath, '../escape'], {
    encoding: 'utf8',
    env: {...process.env, QA_HOST_TEST_MODE: '1', QA_REPO_DIR: fixtureDir},
  });
  assert.equal(traversal.status, 78);
  assert.match(traversal.stderr, /QA_PATH_FORBIDDEN/);

  const badRepoEnv = spawnSync('/bin/sh', [entrypointPath], {
    encoding: 'utf8',
    env: {...process.env, QA_HOST_TEST_MODE: '1', QA_REPO_DIR: '/tmp/../invalido'},
  });
  assert.equal(badRepoEnv.status, 78);
  assert.match(badRepoEnv.stderr, /QA_PATH_FORBIDDEN/);
});

test('coletor encontra defeitos estáticos na fixture e preserva o controle limpo interno', realTools, async () => {
  const execResult = spawnSync('/bin/sh', [entrypointPath], {
    encoding: 'utf8',
    env: {...process.env, QA_HOST_TEST_MODE: '1', QA_REPO_DIR: fixtureDir},
  });
  assert.equal(execResult.status, 0, execResult.stderr);

  const lines = execResult.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'stdout deve conter exatamente um unico JSON em uma linha');
  const output = JSON.parse(lines[0]!) as {
    coverage: {tool: string; version: string; status: string; detail: string}[];
    findings: {
      tool: string;
      rule: string;
      file: string;
      line: number;
      severity: string;
      message: string;
      evidence: string;
    }[];
  };

  assert.ok(Array.isArray(output.coverage));
  assert.ok(Array.isArray(output.findings));

  for (const row of output.coverage) {
    assert.ok(row.tool.length > 0);
    assert.ok(row.version.length > 0);
    assert.ok(['ok', 'failed', 'skipped'].includes(row.status), `status invalido: ${row.status}`);
    assert.ok(row.detail.length > 0);
    assert.equal(row.detail.includes('\n'), false);
    assert.equal(row.detail.includes('|'), false);
  }

  for (const finding of output.findings) {
    assert.ok(finding.tool.length > 0);
    assert.ok(finding.rule.length > 0);
    assert.ok(finding.file.length > 0);
    assert.equal(finding.file.startsWith('/'), false);
    assert.equal(finding.file.split('/').includes('..'), false);
    assert.equal(Number.isInteger(finding.line) && finding.line >= 1, true);
    assert.ok(['alta', 'media', 'baixa', 'informativa'].includes(finding.severity));
    assert.ok(finding.message.length > 0);
    assert.ok(finding.evidence.length > 0);
  }

  const toolStatus = new Map(output.coverage.map(c => [c.tool, c.status]));
  assert.equal(toolStatus.get('node-test-v8'), 'skipped');
  assert.equal(toolStatus.get('stryker-mutator'), 'skipped');
  assert.equal(toolStatus.get('qa-matriz-estatica'), 'ok');
  assert.equal(toolStatus.get('qa-propriedades-funcionais'), 'skipped');
  assert.equal(toolStatus.get('qa-fuzz'), 'skipped');
  assert.equal(toolStatus.get('qa-auditoria-estatica-testes'), 'ok');
  assert.equal(toolStatus.get('axe-core'), 'ok');
  assert.equal(toolStatus.get('swagger-parser'), 'ok');
  assert.equal(toolStatus.get('qa-carga'), 'skipped');

  // Linhas adicionais de cobertura por arquivo, requisito e rota
  assert.equal(toolStatus.get('qa-arquivo:src/defective-pricing.ts'), undefined);
  assert.equal(toolStatus.get('qa-mutante:1'), undefined);
  const requirement = output.coverage.find(c => c.tool === 'qa-requisito:REQ-01');
  assert.match(requirement?.detail ?? '', /vínculo estático.*calcularDescontoFidelidade.*tests\/clean-pricing\.test\.ts:5/);
  const untested = output.coverage.find(c => c.tool === 'qa-requisito:REQ-02');
  assert.match(untested?.detail ?? '', /estornarCobrancaDuplicada.*sem teste vinculado/);
  assert.equal(toolStatus.get('qa-requisito:REQ-01'), 'skipped');
  assert.equal(toolStatus.get('qa-requisito:REQ-02'), 'skipped');
  assert.equal(toolStatus.get('qa-rota:GET /api/desconto'), 'ok');
  assert.equal(toolStatus.get('qa-rota:POST /api/estorno'), 'ok');

  // Defeitos plantados observáveis pela análise estática.
  const hasFinding = (tool: string, rule: string, file: string, line?: number) =>
    output.findings.some(
      f => f.tool === tool && f.rule === rule && f.file === file && (line === undefined || f.line === line),
    );

  assert.equal(output.findings.some(f => ['node-test-v8', 'stryker-mutator'].includes(f.tool)), false);
  assert.equal(hasFinding('qa-matriz-estatica', 'QA-REQUISITO-SEM-CANDIDATO', 'requisitos.md', 4), true);
  assert.ok(output.coverage.every(row => !/fast-check|playwright|k6/.test(row.tool)));
  assert.match(output.coverage.find(row => row.tool === 'qa-propriedades-funcionais')?.detail ?? '',
    /0 de 4 casos/);
  assert.equal(output.coverage.find(row => row.tool === 'qa-carga')?.version, 'não aferida');
  assert.equal(
    hasFinding('qa-auditoria-estatica-testes', 'QA-TESTE-PULADO', 'tests/defective-pricing.test.ts', 17),
    true,
  );
  assert.equal(
    hasFinding('qa-auditoria-estatica-testes', 'QA-TESTE-SEM-ASSERCAO', 'tests/defective-pricing.test.ts', 21),
    true,
  );
  assert.equal(
    hasFinding('axe-core', 'QA-AXE-IMAGE-ALT', 'public/defective-checkout.html', 10),
    true,
  );
  assert.equal(
    hasFinding('axe-core', 'QA-AXE-BUTTON-NAME', 'public/defective-checkout.html', 11),
    true,
  );
  assert.equal(
    hasFinding('swagger-parser', 'QA-CONTRATO-ROTA-SEM-OPENAPI', 'src/routes.ts', 6),
    true,
  );

  // Controle limpo dentro da mesma fixture não é acusado por nenhuma ferramenta
  const cleanFileFindings = output.findings.filter(
    f =>
      f.file === 'src/clean-pricing.ts' ||
      f.file === 'tests/clean-pricing.test.ts' ||
      f.file === 'public/clean-checkout.html',
  );
  assert.deepEqual(cleanFileFindings, []);
});

test('controle limpo isolado produz zero achados com todas as ferramentas ativas ok', realTools, async () => {
  const result = await collectQaModule({repoDir: cleanFixtureDir});
  assert.deepEqual(result.findings, []);
  const activeTools = [
    'qa-matriz-estatica',
    'qa-auditoria-estatica-testes',
    'axe-core',
    'swagger-parser',
  ];
  for (const tool of activeTools) {
    const row = result.coverage.find((c: {tool: string}) => c.tool === tool);
    assert.ok(row, `cobertura ausente para ${tool}`);
    assert.equal(row.status, 'ok');
  }
});

test('falha de uma ferramenta fica registrada na cobertura como failed sem abortar o JSON das demais', async () => {
  const result = await collectQaModule({
    repoDir: cleanFixtureDir,
    failTool: 'stryker-mutator',
  });
  const strykerRow = result.coverage.find((c: {tool: string}) => c.tool === 'stryker-mutator');
  assert.ok(strykerRow);
  assert.equal(strykerRow.status, 'failed');
  assert.match(strykerRow.detail, /QA_STRYKER_FORCED_FAILURE/);

  const node = result.coverage.find(c => c.tool === 'node-test-v8');
  assert.equal(node?.status, 'skipped');
  const matrix = result.coverage.find(c => c.tool === 'qa-matriz-estatica');
  assert.equal(matrix?.status, 'ok');
});

test('ignora symlinks, arquivos de credenciais e scripts em HTML sem executar codigo nao confiavel', realTools, async () => {
  const tempRepo = mkdtempSync(join(tmpdir(), 'qa-untrusted-test-'));
  try {
    mkdirSync(join(tempRepo, 'src'), {recursive: true});
    mkdirSync(join(tempRepo, 'public'), {recursive: true});
    writeFileSync(join(tempRepo, '.env'), 'SECRET_KEY=nao-pode-sair\n');
    writeFileSync(join(tempRepo, '.credentials.json'), '{"accessToken":"segredo-proibido"}\n');
    writeFileSync(
      join(tempRepo, 'public', 'page.html'),
      '<!doctype html><html lang="pt-BR"><head><title>T</title></head><body><script>throw new Error("NAO_EXECUTAR_SCRIPT_HTML")</script><main><p>Oi</p></main></body></html>',
    );
    writeFileSync(join(tempRepo, 'ignorado.txt'), 'conteúdo sintético fora do escopo');
    symlinkSync('../ignorado.txt', join(tempRepo, 'src', 'link.ts'));

    const result = await collectQaModule({repoDir: tempRepo});
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('nao-pode-sair'), false);
    assert.equal(serialized.includes('segredo-proibido'), false);
    assert.equal(serialized.includes('link.ts'), false);
    const exclusions = result.coverage.filter(row => row.tool === 'qa-snapshot-exclusao');
    assert.ok(exclusions.some(row => row.detail === '2 nomes reservados a credenciais'));
    assert.ok(exclusions.some(row => row.detail === '1 links simbólicos ou arquivos especiais'));
    assert.ok(exclusions.some(row => row.detail === '1 arquivos de extensões fora da coleta'));
    const axeRow = result.coverage.find((c: {tool: string}) => c.tool === 'axe-core');
    assert.equal(axeRow?.status, 'ok');
  } finally {
    rmSync(tempRepo, {recursive: true, force: true});
  }
});


test('seleção reconhece node:test offline e recusa scripts, dependências e cópia incompleta', () => {
  const options = {testFiles: ['tests/order.test.ts', 'tests/helper.ts'], readTest: () => "import {test} from 'node:test'"};
  assert.deepEqual(selectNodeSuite(options), {files: ['tests/order.test.ts']});
  assert.match(selectNodeSuite({...options, manifest: {scripts: {test: 'npm run arbitrary'}}}).reason, /incompatível/);
  assert.match(selectNodeSuite({...options, manifest: {dependencies: {widget: '1'}}}).reason, /dependências externas/);
  assert.match(selectNodeSuite({...options, incomplete: true}).reason, /limites de cópia/);
  assert.match(selectNodeSuite({...options, nestedManifest: true}).reason, /subprojeto/);
  assert.deepEqual(selectNodeSuite({...options, testFiles: ['tests/pedido .. revisão.test.ts']}),
    {files: ['tests/pedido .. revisão.test.ts']});
});

test('compara as três passadas e separa falha do teste de erro do executor', () => {
  const file = 'tests/order.test.ts';
  const result = {file, line: 4, column: 1, name: 'entrega o pedido', status: 'passed'};
  const baseline = {summary: true, tests: [result]};
  const failure = {summary: false, tests: [{...result, status: 'failed', error: 'ERR_ASSERTION'}]};
  const decode = (report: object, code: number, measure = false) =>
    decodeNodeReport({code, output: JSON.stringify(report)}, [file], measure);
  assert.deepEqual(comparePasses([baseline, failure, baseline])[0].statuses, ['passed', 'failed', 'passed']);
  assert.equal(classifyMutant(baseline, decode(failure, 1)).status, 'morto');
  assert.equal(classifyMutant(baseline, decode(baseline, 0)).status, 'sobrevivente');
  assert.throws(() => classifyMutant(baseline, {...baseline, tests: []}), /QA_MUTANT_TEST_SET_CHANGED/);
  assert.throws(() => decode(failure, 0), /QA_NODE_TEST_EXECUTION_FAILED/);
  assert.throws(() => decode({...failure, tests: [{...result, status: 'error'}]}, 1), /QA_NODE_TEST_EXECUTION_FAILED/);
  assert.throws(() => decode(baseline, 0, true), /QA_V8_COVERAGE_INVALID/);
});

test('as três execuções têm identificador de ferramenta e número próprio, sem ocultar falhas', async () => {
  const item = {file: 'tests/sintetico.test.ts', line: 1, column: 1, name: 'prova', status: 'passed'};
  const pass = {summary: true, tests: [item], coverage: [] as never[]};
  const failure = {summary: false, tests: [{...item, status: 'failed'}], coverage: [] as never[]};
  const rows = summarizeNodePasses([pass, failure, pass], [], '1').extraRows;
  assert.deepEqual(rows.map(row => [row.tool, row.status, row.detail]), [
    ['node-test-v8-execucao', 'ok', 'execução 1: node:test resultado aprovado; 1 aprovados, 0 reprovados, 0 pulados, 0 todo'],
    ['node-test-v8-execucao', 'ok', 'execução 2: node:test resultado reprovado; 0 aprovados, 1 reprovados, 0 pulados, 0 todo'],
    ['node-test-v8-execucao', 'ok', 'execução 3: node:test resultado aprovado; 1 aprovados, 0 reprovados, 0 pulados, 0 todo'],
  ]);
  const data = mkdtempSync(join(tmpdir(), 'qa-rows-report-'));
  try {
    await writeSecurityReport({dataDirectory: data, projectId: '11111111-1111-4111-8111-111111111111',
      runId: '33333333-3333-4333-8333-333333333333', createdAt: new Date('2026-11-19T00:00:00Z'),
      commit: '0123456789abcdef0123456789abcdef01234567', mapMarkdown: '# Mapa', coverage: [], achados: [], note: '', raw: {coverage: rows, findings: []}});
  } finally {
    rmSync(data, {recursive: true, force: true});
  }
});

test('saída sintética real passa pelo parser e pela proteção do relatório', {
  skip: !process.env.QA_SYNTHETIC_PROOF || !process.env.QA_MODULE_RUNTIME
    ? 'defina QA_SYNTHETIC_PROOF e QA_MODULE_RUNTIME para a prova privada e a base comum' : false,
}, async () => {
  const raw = JSON.parse(readFileSync(process.env.QA_SYNTHETIC_PROOF!, 'utf8')) as {coverage: QaCoverageRow[]; findings: QaFinding[]};
  const original = structuredClone(raw);
  const item = {file: 'tests/sintetico.test.ts', line: 1, column: 1, name: 'prova', status: 'passed'};
  const pass = {summary: true, tests: [item, item, item, item, {...item, status: 'skipped'}], coverage: [] as never[]};
  const rows = summarizeNodePasses([pass, pass, pass], [], raw.coverage[8]!.version).extraRows;
  for (let i = 0; i < 3; i++) {
    assert.equal(original.coverage[8 + i]!.tool, `qa-passada:${i + 1}`);
    assert.equal(original.coverage[8 + i]!.detail, 'node:test passou: 4 aprovados, 0 reprovados, 1 pulados, 0 todo');
    raw.coverage[8 + i] = rows[i]!;
  }
  const {parseModuleCollectorOutput, writeModuleReport} = await import(pathToFileURL(process.env.QA_MODULE_RUNTIME!).href);
  const parsed = parseModuleCollectorOutput(JSON.stringify(raw));
  const parsedOriginal = parseModuleCollectorOutput(JSON.stringify(original));
  assert.deepEqual(parsed.coverage.slice(8, 11), rows);
  const failed = summarizeNodePasses([pass, {...pass, summary: false, tests: [{...item, status: 'failed'}]}, pass], [], raw.coverage[8]!.version).extraRows;
  assert.deepEqual(parseModuleCollectorOutput(JSON.stringify({coverage: failed, findings: []})).coverage, failed);
  assert.deepEqual(parsed.coverage.slice(0, 8), parsedOriginal.coverage.slice(0, 8));
  assert.deepEqual(parsed.coverage.slice(11), parsedOriginal.coverage.slice(11));
  assert.deepEqual(parsed.findings, parsedOriginal.findings);
  const data = mkdtempSync(join(tmpdir(), 'qa-report-test-'));
  const common = {dataDirectory: data, projectId: '11111111-1111-4111-8111-111111111111',
    runId: '33333333-3333-4333-8333-333333333333', createdAt: new Date('2026-11-19T00:00:00Z'),
    commit: '0123456789abcdef0123456789abcdef01234567'};
  try {
    await assert.rejects(writeModuleReport({...common, module: 'qa', toolCoverage: parsedOriginal.coverage, fileCoverage: [], achados: [], raw: parsedOriginal}), /VERIFY_SECRET_IN_REPORT/);
    const written = await writeModuleReport({...common, module: 'qa', toolCoverage: parsed.coverage, fileCoverage: [], achados: [], raw: parsed});
    assert.deepEqual(JSON.parse(readFileSync(join(written.directory, 'bruto', 'achados-brutos.json'), 'utf8')), parsed);
    await assert.rejects(writeSecurityReport({...common, mapMarkdown: '# Mapa', coverage: [], achados: [], note: '', raw: parsedOriginal}), /VERIFY_SECRET_IN_REPORT/);
    await writeSecurityReport({...common, mapMarkdown: '# Mapa', coverage: [], achados: [], note: '', raw: parsed});
    const leaked = structuredClone(parsed);
    leaked.coverage[8].detail += ' password=syntheticSecretValue123';
    await assert.rejects(writeModuleReport({...common, module: 'qa', toolCoverage: leaked.coverage, fileCoverage: [], achados: [], raw: leaked}), /VERIFY_SECRET_IN_REPORT/);
    const current = parseModuleCollectorOutput(JSON.stringify(await collectQaModule({repoDir: fixtureDir})));
    assert.equal(current.coverage.find((row: QaCoverageRow) => row.tool === 'qa-fuzz')?.status, 'skipped');
    assert.ok(current.findings.some((finding: QaFinding) => finding.rule === 'QA-CONTRATO-ROTA-SEM-OPENAPI'));
    const currentWritten = await writeModuleReport({...common, runId: '44444444-4444-4444-8444-444444444444',
      module: 'qa', toolCoverage: current.coverage, fileCoverage: [], achados: [], raw: current});
    assert.deepEqual(JSON.parse(readFileSync(join(currentWritten.directory, 'bruto', 'achados-brutos.json'), 'utf8')), current);
  } finally {
    rmSync(data, {recursive: true, force: true});
  }
});

test('StrykerJS fornece a localização e a substituição aplicadas ao código original', realTools, async () => {
  const qaRequire = createRequire(join(qaModuleDir, 'package.json'));
  const {Instrumenter} = await import(pathToFileURL(qaRequire.resolve('@stryker-mutator/instrumenter')).href);
  const source = 'export function desconto(valor: number) {\n  return valor >= 100;\n}';
  const {selected, total} = await planMutations(Instrumenter, ['desconto.ts'], () => source);
  assert.equal(total, 2);
  assert.ok(selected.some((mutant: {file: string; line: number; content: string}) =>
    mutant.file === 'desconto.ts' && mutant.line === 2 &&
    mutant.content === 'export function desconto(valor: number) {\n  return (valor > 100);\n}'));
});

test('subprocesso limita duração e saída das ferramentas', async () => {
  await assert.rejects(runBoundedNode(['-e', 'setInterval(() => {}, 100)'], qaModuleDir, {timeoutMs: 100}), /QA_TEST_TIMEOUT/);
  await assert.rejects(runBoundedNode(['-e', 'process.stderr.write("x".repeat(8192))'], qaModuleDir, {maxBytes: 1024}), /QA_TEST_OUTPUT_LIMIT/);
});

const coverageFor = (report: {coverage: QaCoverageRow[]}, tool: string) => {
  const row = report.coverage.find(item => item.tool === tool);
  assert.ok(row, tool);
  return row;
};

async function withSyntheticRepo(prefix: string, callback: (directory: string) => Promise<void>) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  try {
    await callback(repo);
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
}

test('nomes válidos com dois pontos e subárvore clean têm análise e JSON', realTools, async () => {
  await withSyntheticRepo('qa..arquivo-', async repo => {
    mkdirSync(join(repo, 'docs'));
    mkdirSync(join(repo, 'src'));
    cpSync(cleanFixtureDir, join(repo, 'clean'), {recursive: true});
    const requirements = join(repo, 'clean', 'requisitos.md');
    writeFileSync(requirements, readFileSync(requirements, 'utf8').replace('src/clean-pricing.ts', 'clean/src/clean-pricing.ts'));
    writeFileSync(join(repo, 'docs', 'versao..md'), '# versão');
    writeFileSync(join(repo, 'docs', 'revisão com espaço.md'), '# revisão');
    writeFileSync(join(repo, 'clean', 'tests', 'segundo..test.ts'), "test('sintético sem asserção', () => {});");
    const child = spawnSync('/bin/sh', [entrypointPath, 'docs/versao..md'], {
      encoding: 'utf8',
      env: {...process.env, QA_HOST_TEST_MODE: '1', QA_REPO_DIR: repo},
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim().split('\n').length, 1);
    const report = JSON.parse(child.stdout) as {coverage: QaCoverageRow[]; findings: QaFinding[]};
    assert.equal(report.coverage.some(row => row.tool === 'qa-snapshot-exclusao'), false);
    assert.match(coverageFor(report, 'qa-snapshot').detail, /^10 arquivos copiados/);
    assert.match(coverageFor(report, 'node-test-v8').detail, /subprojeto/);
    assert.match(coverageFor(report, 'qa-requisito:REQ-01').detail, /clean\/tests\/clean-pricing/);
    assert.ok(report.findings.some(row => row.rule === 'QA-TESTE-SEM-ASSERCAO' &&
      row.file === 'clean/tests/segundo..test.ts'));
  });
});

test('limites de cópia tornam as análises parciais e impedem acusar contrato ou prova ausentes', realTools, async () => {
  await withSyntheticRepo('qa-limites-', async repo => {
    writeFileSync(join(repo, 'a-routes.ts'), "app.get('/pedidos/:id', handler);");
    mkdirSync(join(repo, 'b-docs'));
    writeFileSync(join(repo, 'b-docs', 'requisitos.md'), 'REQ-17: entrega do pedido');
    mkdirSync(join(repo, 'c-tests'));
    writeFileSync(join(repo, 'c-tests', 'a.test.ts'), "test('exemplo sem asserção', () => {});");
    writeFileSync(join(repo, 'd-openapi.json'), '');
    truncateSync(join(repo, 'd-openapi.json'), 1024 * 1024 + 1);
    mkdirSync(join(repo, 'e-depth', ...Array<string>(10).fill('d')), {recursive: true});
    mkdirSync(join(repo, 'f-files'));
    for (let index = 0; index < 400; index++) {
      writeFileSync(join(repo, 'f-files', `doc-${index}.md`), '# sintético');
    }
    mkdirSync(join(repo, 'z-contract'));
    cpSync(join(fixtureDir, 'openapi.json'), join(repo, 'z-contract', 'openapi.json'));
    const report = await collectQaModule({repoDir: repo});
    const exclusions = report.coverage.filter(row => row.tool === 'qa-snapshot-exclusao').map(row => row.detail);
    for (const reason of [/limite de arquivos/, /limite individual de bytes/, /limite de profundidade/]) {
      assert.ok(exclusions.some(detail => reason.test(detail)), String(reason));
    }
    for (const tool of ['qa-matriz-estatica', 'qa-auditoria-estatica-testes', 'qa-contrato-openapi', 'axe-core']) {
      assert.match(coverageFor(report, tool).detail, /escopo parcial/);
    }
    assert.match(coverageFor(report, 'node-test-v8').detail, /snapshot parcial/);
    assert.match(coverageFor(report, 'stryker-mutator').detail, /snapshot parcial/);
    assert.match(coverageFor(report, 'qa-rota:GET /pedidos/:id').detail, /contrato não confirmado/);
    assert.ok(!report.findings.some(f => ['QA-CONTRATO-ROTA-SEM-OPENAPI', 'QA-REQUISITO-SEM-CANDIDATO'].includes(f.rule)));
    assert.ok(report.findings.some(f => f.rule === 'QA-TESTE-SEM-ASSERCAO'));
  });
});

test('o limite de 400 contabiliza somente arquivos elegíveis', realTools, async () => {
  await withSyntheticRepo('qa-limite-exato-', async repo => {
    writeFileSync(join(repo, 'requisitos.md'), 'REQ-01: cálculo sintético');
    writeFileSync(join(repo, 'outro.test.mjs'), "import {test} from 'node:test'; test('outro', () => {});");
    for (let index = 0; index < 398; index++) {
      writeFileSync(join(repo, `doc-${index}.md`), '# Controle');
    }
    writeFileSync(join(repo, 'zzz.txt'), '');
    mkdirSync(join(repo, 'zzz-apoio'));
    writeFileSync(join(repo, 'zzz-apoio', 'nota.txt'), '');

    const complete = await collectQaModule({repoDir: repo});
    assert.match(coverageFor(complete, 'qa-snapshot').detail, /^400 arquivos copiados \(dentro do escopo\)/);
    assert.equal(coverageFor(complete, 'qa-snapshot-exclusao').detail, '2 arquivos de extensões fora da coleta');
    for (const tool of ['node-test-v8', 'stryker-mutator']) {
      assert.match(coverageFor(complete, tool).detail, /reservada ao contêiner isolado/);
    }
    assert.ok(complete.findings.some(finding => finding.rule === 'QA-REQUISITO-SEM-CANDIDATO'));

    writeFileSync(join(repo, 'zzzz.md'), '# Elegível');
    const partial = await collectQaModule({repoDir: repo});
    assert.match(coverageFor(partial, 'qa-snapshot').detail, /^400 arquivos copiados \(cópia parcial\)/);
    assert.ok(partial.coverage.some(row => row.detail === '1 arquivos elegíveis fora do limite de arquivos'));
    for (const tool of ['node-test-v8', 'stryker-mutator']) {
      assert.match(coverageFor(partial, tool).detail, /snapshot parcial/);
    }
    assert.ok(!partial.findings.some(finding => finding.rule === 'QA-REQUISITO-SEM-CANDIDATO'));
  });
});

test('limite total de bytes é registrado mesmo abaixo do limite de arquivos', async () => {
  await withSyntheticRepo('qa-bytes-', async repo => {
    for (let index = 0; index < 65; index++) {
      const file = join(repo, `doc-${index}.md`);
      writeFileSync(file, '');
      truncateSync(file, 1024 * 1024);
    }
    const report = await collectQaModule({repoDir: repo});
    assert.match(coverageFor(report, 'qa-snapshot').detail, /^64 arquivos copiados \(cópia parcial\)/);
    assert.equal(coverageFor(report, 'qa-snapshot-exclusao').detail, '1 arquivos fora do limite total de bytes');
    assert.match(coverageFor(report, 'qa-contrato-openapi').detail, /escopo parcial/);
  });
});

test('contrato normaliza parâmetros simples e conserva método, prefixo e sufixo', realTools, async () => {
  await withSyntheticRepo('qa-rotas-', async repo => {
    writeFileSync(join(repo, 'routes.ts'), [
      "app.get('/pedidos/:id', handler);",
      "app.get('/export/:id.json', handler);",
      "app.post('/pedidos/:id', handler);",
      "app.get('/pedido/:id', handler);",
      "app.get('/export/:id.csv', handler);",
      "app.get('/opcional/:id?', handler);",
    ].join('\n'));
    const operation = {
      parameters: [{name: 'pedido', in: 'path', required: true, schema: {type: 'string'}}],
      responses: {'200': {description: 'ok'}},
    };
    writeFileSync(join(repo, 'openapi.json'), JSON.stringify({
      openapi: '3.0.3',
      info: {title: 'Controle de pedidos', version: '1'},
      paths: {'/pedidos/{pedido}': {get: operation}, '/export/{pedido}.json': {get: operation}},
    }));
    const report = await collectQaModule({repoDir: repo});
    assert.match(coverageFor(report, 'qa-rota:GET /pedidos/:id').detail, /documentada e validada/);
    assert.match(coverageFor(report, 'qa-rota:GET /export/:id.json').detail, /documentada e validada/);
    assert.equal(coverageFor(report, 'qa-rota:GET /opcional/:id?').status, 'skipped');
    assert.deepEqual(report.findings.filter(f => f.rule === 'QA-CONTRATO-ROTA-SEM-OPENAPI').map(f => f.line), [3, 4, 5]);
  });
});

test('rotas com constantes lexicais entram no contrato e caminhos variáveis têm exclusão explícita', realTools, async () => {
  await withSyntheticRepo('qa-rotas-constantes-', async repo => {
    writeFileSync(join(repo, 'routes.ts'), [
      "const caminho = '/pedidos/:id' as const;",
      'app.get(caminho, handler);',
      'function register(router) {',
      "  const caminho = `/entregas`;",
      '  router.post(caminho, handler);',
      '}',
      "let variável = '/outro';",
      "variável = '/revisao';",
      'app.get(variável, handler);',
      "app.get(getPath('/montado'), handler);",
      "// app.get('/comentario', handler);",
      "const [segmento] = '/desestruturado';",
      'app.get(segmento, handler);',
      "const opcional = '/opcional';",
      'app?.get(opcional, handler);',
      "app?.get?.('/" + 'x'.repeat(400) + "a', handler);",
      "app.get('/" + 'x'.repeat(400) + "b', handler);",
    ].join('\n'));
    writeFileSync(join(repo, 'openapi.json'), JSON.stringify({
      openapi: '3.0.3',
      info: {title: 'Pedidos', version: '1'},
      paths: {'/pedidos/{id}': {get: {
        parameters: [{name: 'id', in: 'path', required: true, schema: {type: 'string'}}],
        responses: {'200': {description: 'ok'}},
      }}},
    }));
    const report = await collectQaModule({repoDir: repo});
    assert.match(coverageFor(report, 'qa-rota:GET /pedidos/:id').detail, /documentada e validada/);
    assert.match(coverageFor(report, 'qa-rota:POST /entregas').detail, /ausente no contrato/);
    assert.equal(coverageFor(report, 'qa-rota:GET variável (routes.ts:9)').status, 'skipped');
    assert.match(coverageFor(report, "qa-rota:GET getPath('/montado') (routes.ts:10)").detail, /sintaxe.*fora/);
    assert.equal(coverageFor(report, 'qa-rota:GET segmento (routes.ts:13)').status, 'skipped');
    assert.equal(coverageFor(report, 'qa-rota:GET /opcional').status, 'ok');
    const longKeys = report.coverage.filter(row => row.tool.startsWith('qa-rota:GET /xxxx')).map(row => row.tool);
    assert.equal(new Set(longKeys).size, 2);
    assert.equal(report.coverage.filter(row => row.tool.startsWith('qa-rota:')).length, 8);
    assert.deepEqual(report.findings.filter(f => f.rule === 'QA-CONTRATO-ROTA-SEM-OPENAPI').map(f => f.line), [5, 15, 16, 17]);
  });
});

test('contrato preserva especificação válida e rotas quando outra especificação falha', realTools, async () => {
  await withSyntheticRepo('qa-openapi-parcial-', async repo => {
    writeFileSync(join(repo, 'openapi.json'), '{');
    writeFileSync(join(repo, 'swagger.json'), JSON.stringify({
      swagger: '2.0',
      info: {title: 'Pedidos', version: '1'},
      paths: {'/pedidos': {get: {responses: {'200': {description: 'ok'}}}}},
    }));
    writeFileSync(join(repo, 'routes.mjs'), "app.get('/pedidos', handler);\napp.get('/entregas', handler);");
    const partial = await collectQaModule({repoDir: repo});
    assert.equal(coverageFor(partial, 'swagger-parser').status, 'failed');
    assert.match(coverageFor(partial, 'swagger-parser').detail, /1 especificações validadas, 1 inválidas/);
    assert.equal(coverageFor(partial, 'qa-openapi:openapi.json').status, 'failed');
    assert.equal(coverageFor(partial, 'qa-openapi:swagger.json').status, 'ok');
    assert.match(coverageFor(partial, 'qa-rota:GET /pedidos').detail, /documentada e validada/);
    assert.equal(coverageFor(partial, 'qa-rota:GET /entregas').status, 'skipped');
    assert.match(coverageFor(partial, 'qa-rota:GET /entregas').detail, /contrato não confirmado.*inválida/);
    assert.deepEqual(partial.findings, []);

    rmSync(join(repo, 'openapi.json'));
    const complete = await collectQaModule({repoDir: repo});
    assert.equal(coverageFor(complete, 'swagger-parser').status, 'ok');
    assert.match(coverageFor(complete, 'qa-rota:GET /entregas').detail, /ausente no contrato/);
    assert.deepEqual(complete.findings.map(f => f.rule), ['QA-CONTRATO-ROTA-SEM-OPENAPI']);
  });
});

test('axe estático mantém a versão instalada e declara o escopo sem layout', realTools, async () => {
  await withSyntheticRepo('qa-contraste-', async repo => {
    writeFileSync(join(repo, 'contraste.html'), '<!doctype html><html lang="pt"><head><title>Controle</title></head>' +
      '<body><main><p style="color:#aaa;background-color:#aaa">Texto sintético</p></main></body></html>');
    const report = await collectQaModule({repoDir: repo});
    const axe = coverageFor(report, 'axe-core');
    const installed = JSON.parse(readFileSync(join(qaModuleDir, 'node_modules/axe-core/package.json'), 'utf8'));
    assert.equal(axe.version, installed.version);
    assert.match(axe.detail, /regra color-contrast desativada/);
    assert.match(axe.detail, /sem scripts nem layout/);
    const contrast = coverageFor(report, 'qa-contraste:contraste.html');
    if (contrast.status === 'skipped') assert.ok(!report.findings.some(f => f.rule === 'QA-AXE-COLOR-CONTRAST'));
  });
});

test('axe mede HTML e HTM em caixa alta e exclui extensões não HTML', realTools, async () => {
  await withSyntheticRepo('qa-html-caixa-', async repo => {
    const html = '<!doctype html><html lang="pt"><head><title>Pedidos</title></head>' +
      '<body><main><img src="pedido.png"></main></body></html>';
    writeFileSync(join(repo, 'index.HTML'), html);
    writeFileSync(join(repo, 'outro.HTM'), html);
    writeFileSync(join(repo, 'ignorado.HTML.txt'), html);
    const report = await collectQaModule({repoDir: repo});
    assert.equal(coverageFor(report, 'axe-core').status, 'ok');
    assert.match(coverageFor(report, 'axe-core').detail, /2 arquivos em regras/);
    assert.deepEqual(report.findings.filter(f => f.rule === 'QA-AXE-IMAGE-ALT').map(f => f.file), ['index.HTML', 'outro.HTM']);
    assert.equal(coverageFor(report, 'qa-snapshot-exclusao').detail, '1 arquivos de extensões fora da coleta');
  });
});

test('entrypoint aceita diretório com .socket e bloqueia socket sintético pelo tipo', async () => {
  await withSyntheticRepo('qa-tipo-caminho-', async repo => {
    const directory = join(repo, 'checkout.socket');
    mkdirSync(directory);
    writeFileSync(join(directory, 'controle.md'), '# Controle');
    const env = {...process.env, QA_HOST_TEST_MODE: '1', QA_REPO_DIR: directory};
    const accepted = spawnSync('/bin/sh', [entrypointPath, directory], {encoding: 'utf8', env});
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.stdout.trim().split('\n').length, 1);
    assert.match(coverageFor(JSON.parse(accepted.stdout), 'qa-snapshot').detail, /^1 arquivos copiados/);

    const socket = join(repo, 'controle-ipc');
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    try {
      for (const [args, repoDir] of [[[socket], directory], [[], socket]] as const) {
        const rejected = spawnSync('/bin/sh', [entrypointPath, ...args], {encoding: 'utf8', env: {...env, QA_REPO_DIR: repoDir}});
        assert.equal(rejected.status, 78);
        assert.match(rejected.stderr, /QA_SOCKET_FORBIDDEN/);
        assert.equal(rejected.stdout, '');
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});

test('identificadores da matriz preservam caminhos com barra, pipe e percentuais literais', realTools, async () => {
  await withSyntheticRepo('qa-caminhos-matriz-', async repo => {
    mkdirSync(join(repo, 'a'));
    const longNames = ['a', 'b'].map(suffix => `${'x'.repeat(240)}-${suffix}.ts`);
    for (const file of ['a/b.ts', 'a|b.ts', 'a%7Cb.ts', ...longNames]) {
      writeFileSync(join(repo, file), 'export function f() { return 1; }');
    }
    const report = await collectQaModule({repoDir: repo});
    const rows = report.coverage.filter(row => row.tool.startsWith('qa-funcionalidade:'));
    assert.equal(rows.length, 5);
    assert.equal(new Set(rows.map(row => row.tool)).size, 5);
    assert.equal(new Set(rows.map(row => row.detail)).size, 5);
    assert.ok(rows.every(row => row.tool.length <= 120));
    for (const path of ['a/b.ts', 'a%7Cb.ts', 'a%257Cb.ts']) {
      assert.ok(coverageFor(report, `qa-funcionalidade:${path}:f`).detail.includes(`${path}:1 f`));
    }
  });
});

const runnerUrl = pathToFileURL(join(qaModuleDir, 'node-test-runner.mjs')).href;
// Invoca somente o núcleo do runner em fixtures sintéticas criadas por estes testes.
async function runSyntheticPass(repo: string, files: string[]) {
  const driver = join(repo, '.qa-synthetic-driver.mjs');
  writeFileSync(driver, `
    import {runNodeTests} from ${JSON.stringify(runnerUrl)};
    const report = await runNodeTests(process.cwd(), ${JSON.stringify(files)});
    process.stdout.write(JSON.stringify(report));
    process.exitCode = Number(!report.summary);
  `);
  const child = await runBoundedNode([driver], repo);
  return decodeNodeReport(child, files, true);
}

async function readTestAst(file: string, content: string) {
  return analyzeTestFile(file, content, await loadQaSyntax());
}

test('matriz lê o callback após opções, exige execução aprovada e reconhece skip e todo', realTools, async () => {
  const file = 'options.test.mjs';
  const source = [
    "import {describe, test} from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('REQ-01 opção timeout', {timeout: 1000, skip: false}, () => { assert.equal(42, 42); });",
    "test('REQ-02 skip em execução', {timeout: 1000}, context => { if (process.platform === 'linux') { context.skip(); return; } assert.equal(42, 42); });",
    "test('REQ-03 skip nas opções', {timeout: 1000, skip: 'pendente'}, () => assert.equal(42, 42));",
    "describe.skip('grupo inativo', () => { test('REQ-04 teste do grupo', () => assert.equal(42, 42)); });",
    "test('REQ-05 todo', {timeout: 1000, todo: true}, () => assert.equal(42, 42));",
    "test('REQ-06 status todo em execução', {timeout: 1000}, context => { context.todo(); assert.equal(42, 42); });",
    "test('REQ-07 parâmetro sombreado', context => { { const context = {skip() {}, todo() {}}; context.skip(); context.todo(); } assert.equal(2 + 2, 4); });",
  ].join('\n');
  await withSyntheticRepo('qa-status-', async repo => {
    writeFileSync(join(repo, file), source);
    writeFileSync(join(repo, 'requisitos.md'), Array.from({length: 7}, (_, index) => `REQ-0${index + 1}: sintético`).join('\n'));
    const staticReport = await collectQaModule({repoDir: repo});
    assert.ok(!staticReport.findings.some(f => f.rule === 'QA-TESTE-SEM-ASSERCAO'));
    assert.ok(!staticReport.findings.some(f => f.rule === 'QA-TESTE-PULADO' && f.line === 9));
    assert.doesNotMatch(coverageFor(staticReport, 'qa-requisito:REQ-07').detail, /skip\/todo possível/);
    const passes = [];
    for (let index = 0; index < 3; index++) {
      const scratch = join(repo, `run-${index}`);
      mkdirSync(scratch);
      writeFileSync(join(scratch, file), source);
      passes.push(await runSyntheticPass(scratch, [file]));
    }
    const runtimeTests = comparePasses(passes);
    const matrix = buildTraceability({workspace: repo, sourceAnalyses: [], reqFiles: ['requisitos.md'],
      testAnalyses: [await readTestAst(file, source)], runtimeTests, incomplete: false});
    assert.deepEqual(matrix.findings.map(f => f.line), process.platform === 'linux' ? [2, 3, 4, 5, 6] : [3, 4, 5, 6]);
    assert.match(matrix.extraRows.find(row => row.tool === 'qa-requisito:REQ-01')?.detail ?? '', /passed,passed,passed.*asserção concluída/);
    if (process.platform === 'linux') assert.match(matrix.findings[0]!.evidence, /skipped,skipped,skipped/);
    assert.match(matrix.findings.at(-1)!.evidence, /todo,todo,todo/);
    assert.match(coverageFor({coverage: matrix.extraRows}, 'qa-requisito:REQ-07').detail, /vínculo comprovado/);
  });
});

test('matriz exige uma asserção concluída e atribuída a cada teste nas três passadas', realTools, async () => {
  const file = 'assertions.test.mjs';
  const source = [
    "import {before, test as scenario} from 'node:test';",
    "import assert, {strictEqual as same} from 'node:assert/strict';",
    'before(() => assert.equal(3, 3));',
    "scenario('REQ-11 ramo morto', () => { if (false) assert.equal(1, 2); }); scenario('REQ-12 chamada direta', () => assert.equal(1, 1));",
    "scenario('REQ-13 argumento interrompido', () => { try { assert.equal((() => { throw 1; })(), 2); } catch {} });",
    "scenario('REQ-14 callback indireto', () => [1].forEach(value => assert.equal(value, 1)));",
    "scenario('REQ-15 objeto local', () => { const assert = {equal() {}}; assert.equal(1, 2); });",
    "scenario('REQ-16 asserção importada por alias', async () => { await Promise.resolve(); same(5, 5); });",
  ].join('\n');
  await withSyntheticRepo('qa-assercoes-', async repo => {
    writeFileSync(join(repo, 'requisitos.md'), Array.from({length: 6}, (_, index) => `REQ-${11 + index}: sintético`).join('\n'));
    const passes = [];
    for (let index = 0; index < 3; index++) {
      const scratch = join(repo, `run-${index}`);
      mkdirSync(scratch);
      writeFileSync(join(scratch, file), source);
      passes.push(await runSyntheticPass(scratch, [file]));
    }
    const runtimeTests = comparePasses(passes);
    assert.ok(runtimeTests.every((test: {statuses: string[]}) => test.statuses.every(status => status === 'passed')));
    assert.deepEqual(runtimeTests.map((test: {assertionStatuses: string[]}) => [...new Set(test.assertionStatuses)]),
      [['unobserved'], ['completed'], ['unobserved'], ['unsupported'], ['unsupported'], ['completed']]);
    const matrix = buildTraceability({workspace: repo, sourceAnalyses: [], reqFiles: ['requisitos.md'],
      testAnalyses: [await readTestAst(file, source)], runtimeTests, incomplete: false});
    assert.deepEqual(matrix.findings.map(f => f.line), [1, 3]);
    assert.match(matrix.findings[0]!.evidence, /passed,passed,passed.*conclusão da asserção não observada/);
    for (const id of ['REQ-14', 'REQ-15']) {
      const coverage = coverageFor({coverage: matrix.extraRows}, `qa-requisito:${id}`);
      assert.equal(coverage.status, 'skipped');
      assert.match(coverage.detail, /passed,passed,passed.*cobertura limitada/);
    }
    for (const id of ['REQ-12', 'REQ-16']) {
      assert.match(coverageFor({coverage: matrix.extraRows}, `qa-requisito:${id}`).detail, /asserção concluída nas três passadas/);
    }
  });
});

async function measureSyntheticRequirements(repo: string, requirements: string[], sources: Record<string, string>, tests: string[]) {
  const file = 'trace.test.mjs';
  writeFileSync(join(repo, 'requisitos.md'), requirements.join('\n'));
  const syntax = await loadQaSyntax();
  const testSource = tests.join('\n');
  const testAnalysis = analyzeTestFile(file, testSource, syntax);
  const options = {workspace: repo, reqFiles: ['requisitos.md'], incomplete: false, testAnalyses: [testAnalysis],
    sourceAnalyses: Object.entries(sources).map(([path, source]) => analyzeSourceFile(path, source, syntax))};
  const passes = [];
  for (let index = 0; index < 3; index++) {
    const scratch = join(repo, `run-${index}`);
    mkdirSync(scratch);
    for (const [path, source] of Object.entries({...sources, [file]: testSource})) writeFileSync(join(scratch, path), source);
    passes.push(await runSyntheticPass(scratch, [file]));
  }
  assert.ok(passes.every(pass => pass.summary));
  const runtimeTests = comparePasses(passes);
  const matrix = buildTraceability({...options, runtimeTests});
  const staticMatrix = buildTraceability(options);
  return {runtimeTests, testAnalysis, findings: matrix.findings, staticFindings: staticMatrix.findings,
    row: (id: number) => coverageFor({coverage: matrix.extraRows}, `qa-requisito:REQ-${id}`),
    staticRow: (id: number) => coverageFor({coverage: staticMatrix.extraRows}, `qa-requisito:REQ-${id}`)};
}

test('matriz preserva o caminho de cada referência, aliases exportados e valores esperados como contexto', realTools, async () => {
  await withSyntheticRepo('qa-referencias-', async repo => {
    const result = await measureSyntheticRequirements(repo, [
      'REQ-61: `primeira` de `./a.mjs` e `segunda` de `b.mjs`',
      'REQ-62: `primeira` de `b.mjs` e `segunda` de `a.mjs`',
      'REQ-63: `primeira` de `ausente.mjs`',
      'REQ-64: `primeira` de `a.mjs` retorna `OK`',
      'REQ-65: `cálculo$` de `aliases.mjs`',
      'REQ-66: `interna` de `aliases.mjs`',
      'REQ-67: `primeira`',
      'REQ-68: retorna `OK`',
      '- REQ-69: operação antiga (`listada` de `aliases.mjs`)',
      'REQ-70: `primeira` de `a.mjs` e `2inválido`',
      'REQ-84: a soma deve devolver o valor esperado (`OK`).',
      'REQ-85: calcular o total (`primeira` de `ausente.mjs`).',
      'REQ-86: cálculo histórico (`listada`).',
      'REQ-87: calcular (`primeira` de `ausente.mjs`) em duas operações.',
      'REQ-88: cálculo (`primeira` de `ausente.mjs` e `listada`).',
    ], {
      'a.mjs': "export function primeira() { return 'OK'; }\nexport function segunda() {}\nexport function OK() { return 2 + 2; }",
      'b.mjs': 'export function segunda() { return 2; }\nexport function primeira() {}',
      'aliases.mjs': 'export {interna as cálculo$, listada};\nconst interna = () => 3;\nfunction listada() { return 4; }',
    }, [
      "import {test} from 'node:test'; import assert from 'node:assert/strict';",
      "import {primeira, OK} from './a.mjs'; import {segunda} from './b.mjs';",
      "import {cálculo$ as alias, listada} from './aliases.mjs';",
      "test('REQ-63 REQ-85 REQ-87 caminho divergente', () => assert.equal(primeira(), 'OK'));",
      "test('segunda no caminho correto', () => assert.equal(segunda(), 2));",
      "test('alias exportado', () => assert.equal(alias(), 3));",
      "test('função exportada por lista', () => assert.equal(listada(), 4));",
      "test('REQ-68 por título', () => assert.equal('OK', 'OK'));",
      "test('função homônima ao valor esperado', () => assert.equal(OK(), 4));",
      "test('REQ-86 título insuficiente para referência ambígua', () => assert.equal(listada(), 4));",
    ]);
    for (const id of [61, 64, 65, 68, 69]) {
      assert.equal(result.row(id).status, 'ok', String(id));
      assert.match(result.row(id).detail, /vínculo comprovado nas três passadas/);
      assert.equal(result.staticRow(id).status, 'skipped', String(id));
      assert.match(result.staticRow(id).detail, /prova não medida: somente análise estática/);
    }
    assert.match(result.row(61).detail, /primeira \(a\.mjs:1\), segunda \(b\.mjs:1\)/);
    assert.match(result.row(62).detail, /primeira \(b\.mjs:2\), segunda \(a\.mjs:2\)/);
    assert.match(result.row(64).detail, /contexto: .*retorna `OK`/);
    assert.doesNotMatch(result.row(64).detail, /OK \(a\.mjs:/);
    assert.match(result.row(65).detail, /cálculo\$ \(aliases\.mjs:2\)/);
    for (const id of [63, 66, 70]) {
      assert.equal(result.row(id).status, 'skipped', String(id));
      assert.match(result.row(id).detail, /referência não resolvida/);
    }
    assert.match(result.row(63).detail, /primeira \(ausente\.mjs\) sem resolução/);
    assert.doesNotMatch(result.row(63).detail, /primeira \(a\.mjs:/);
    assert.deepEqual(result.findings.map(finding => finding.line), [2]);
    assert.equal(result.row(62).status, 'ok');
    assert.match(result.row(62).detail, /vínculo sem prova nas três passadas/);
    assert.equal(result.row(67).status, 'skipped');
    assert.match(result.row(67).detail, /referência ambígua.*informe/);
    for (const id of [84, 86, 87, 88]) {
      assert.equal(result.row(id).status, 'skipped');
      assert.match(result.row(id).detail, /referência ambígua.*informe/);
    }
    assert.doesNotMatch(result.row(84).detail, /OK \(a\.mjs:/);
    assert.equal(result.row(85).status, 'skipped');
    assert.match(result.row(85).detail, /primeira \(ausente\.mjs\) sem resolução/);
    assert.doesNotMatch(result.row(85).detail, /primeira \(a\.mjs:/);
    assert.match(result.row(88).detail, /primeira \(ausente\.mjs\) sem resolução/);
  });
});

test('matriz e V8 concordam sobre operandos, spreads, chamadas opcionais e sombreamento', realTools, async () => {
  await withSyntheticRepo('qa-operandos-', async repo => {
    const result = await measureSyntheticRequirements(repo, [
      'REQ-71: `texto` e `padrão`',
      'REQ-72: `outroTexto` e `outroPadrão`',
      'REQ-73: `mensagem`',
      'REQ-74: `depoisDoSpread`',
      'REQ-75: `antesDaMensagem`',
      'REQ-76: `opcional`',
      'REQ-77: `emAssertOpcional`',
      'REQ-78: `sombreada`',
      'REQ-79: `emAssertSombreado`',
      'REQ-80: `somenteFora`',
      'REQ-81: `emRegistroOpcional`',
      'REQ-82: `trocaDeMetodo`',
      'REQ-83: `dentroDoSpread`',
    ], {
      'features.mjs': [
        "export function texto() { return 'sim'; }", 'export function padrão() { return /sim/; }',
        "export function outroTexto() { return 'sim'; }", 'export function outroPadrão() { return /não/; }',
        "export function mensagem() { return 'mensagem'; }", "export function depoisDoSpread() { return 'mensagem'; }",
        ...['antesDaMensagem', 'opcional', 'emAssertOpcional', 'sombreada', 'emAssertSombreado', 'somenteFora',
          'emRegistroOpcional', 'trocaDeMetodo', 'dentroDoSpread'].map(name => `export function ${name}() { return 1; }`),
      ].join('\n'),
    }, [
      "import {test} from 'node:test'; import assert, {doesNotMatch as diferente} from 'node:assert/strict';",
      "import * as features from './features.mjs'; import {sombreada} from './features.mjs';",
      "test('REQ-71 ambos em match', () => assert['match'](features.texto(), features.padrão()));",
      "test('REQ-72 ambos em doesNotMatch', () => diferente(features.outroTexto(), features['outroPadrão']()));",
      "test('REQ-73 terceiro argumento em match', () => assert.match('sim', /sim/, features.mensagem()));",
      "test('REQ-74 mensagem após spread', () => { const args = [1, 1]; assert.equal(...args, features.depoisDoSpread()); });",
      "test('REQ-75 spread após os operandos', () => assert.equal(features.antesDaMensagem(), 1, ...['mensagem']));",
      "test('REQ-76 função opcional', () => assert.equal(features?.opcional(), 1));",
      "test('REQ-77 asserção opcional', () => assert.equal?.(features.emAssertOpcional(), 1));",
      "test('REQ-78 função sombreada', () => { const sombreada = () => 1; assert.equal(sombreada(), 1); });",
      "test('REQ-79 assert sombreado', () => { const assert = {equal() {}}; assert.equal(features.emAssertSombreado(), 1); });",
      "test('REQ-80 chamada fora da asserção', () => { features.somenteFora(); assert.equal(1, 1); });",
      "test?.('REQ-81 registro opcional', () => assert.equal(features.emRegistroOpcional(), 1));",
      "test('REQ-82 método trocado', () => { const equal = assert.equal; assert.equal = assert.ok; try { assert.equal(1, features.trocaDeMetodo()); } finally { assert.equal = equal; } });",
      "test('função em spread', () => { const args = [features.dentroDoSpread(), 1]; assert.equal(...args); });",
    ]);
    const names = [
      ['texto', 'padrão'], ['outroTexto', 'outroPadrão'], [], [], ['antesDaMensagem'], [], [], [], [], [], [], ['trocaDeMetodo'], [],
    ];
    const identities = (names: string[]) => names.map(name => JSON.stringify(['features.mjs', name]));
    assert.deepEqual(result.testAnalysis.activeTests.map(test => test.features), names.map(identities));
    assert.deepEqual(result.testAnalysis.activeTests.flatMap(test => test.limitedFeatures),
      identities(['depoisDoSpread', 'opcional', 'emAssertOpcional', 'emRegistroOpcional', 'dentroDoSpread']));
    assert.deepEqual(result.runtimeTests.map((test: {featurePasses: string[][]}) => test.featurePasses),
      names.map(names => Array.from({length: 3}, () => identities(names.filter(name => name !== 'trocaDeMetodo')))));
    for (const id of [71, 72, 75]) assert.equal(result.row(id).status, 'ok', String(id));
    for (const id of [74, 76, 77, 81, 83]) {
      assert.equal(result.row(id).status, 'skipped', String(id));
      assert.match(result.row(id).detail, /prova não medida: cobertura limitada/);
    }
    for (const id of [73, 78, 79, 80, 82]) {
      assert.equal(result.row(id).status, 'ok', String(id));
      assert.match(result.row(id).detail, /vínculo sem prova nas três passadas/);
    }
    assert.deepEqual(result.findings.map(finding => finding.line), [3, 8, 9, 10, 12]);
    assert.ok(result.staticFindings.some(finding => finding.line === 3 && /execução não medida/.test(finding.message)));
    assert.equal(result.staticRow(73).status, 'skipped');
  });
});

test('matriz associa a conclusão da asserção à invocação na mesma avaliação', realTools, async () => {
  await withSyntheticRepo('qa-conclusao-', async repo => {
    const result = await measureSyntheticRequirements(repo, [
      'REQ-91: soma sintética',
      'REQ-92: `capturada`',
      'REQ-93: `bloqueada`',
      'REQ-94: `intercalada`',
      'REQ-95: `falha`',
      'REQ-96: `controle`',
      'REQ-97: `espalhada`',
      'REQ-98: `inativa` e `opcional`',
      'REQ-99: `substituida`',
    ], {
      'aritmetica.mjs': [
        'export function capturada() { return 1 + 1; }',
        'export function bloqueada() { throw new RangeError(); }',
        'let chamadas = 0;',
        'export function intercalada(x) { chamadas++; return x + 1; }',
        'export function contagem() { return chamadas; }',
        'export function falha(x) { if (x < 0) throw new RangeError(); }',
        'export function controle(a, b) { if (this.controle !== controle || a + b !== 3) throw new RangeError(); }',
        'export function espalhada() { throw new RangeError(); }',
        'export function inativa() { return 1; }',
        'export function opcional() { return 1; }',
        'export function substituida() { return 0; }',
        'export function substituir() { substituida = () => 1; }',
      ].join('\n'),
    }, [
      "import {test} from 'node:test'; import assert, {throws as deveLancar} from 'node:assert/strict';",
      "import * as arit from './aritmetica.mjs';",
      'function entrada(valor) { if (valor < 0) throw new RangeError(); return valor; }',
      "test('REQ-91 comparação capturada', () => { try { assert.equal(arit.capturada(), 3); } catch {} });",
      "test('mesmo operando com outra asserção concluída', () => { try { assert.equal(arit.capturada(), 3); } catch {} assert.equal(1 + 1, 2); });",
      "test('exceção durante a avaliação do argumento', () => assert.throws(() => arit.bloqueada(entrada(-1)), RangeError));",
      "test('mesmo ponto com resultados intercalados', () => {",
      '  for (const x of [1, -1]) {',
      '    try { assert.throws(() => arit.intercalada(entrada(x)), RangeError); } catch {}',
      '  }',
      '  assert.equal(arit.contagem(), 1);',
      '});',
      "test('callback com matcher', () => deveLancar(() => { return arit.falha(-1); }, RangeError));",
      "test('callback com mensagem preserva ordem, receptor e quantidade de avaliações', () => {",
      '  const ordem = [];',
      "  assert.doesNotThrow(() => arit.controle(...[ordem.push(1), ordem.push(2)]), 'soma de 1 e 2');",
      '  assert.deepEqual(ordem, [1, 2]);',
      '});',
      "test('callback em spread com título genérico', () => { const args = [() => arit.espalhada(), RangeError]; assert.throws(...args); });",
      "test('prova direta em ramo inativo', () => { if (false) assert.equal(arit.inativa(), 1); assert.equal(2 + 2, 4); });",
      "test('prova de alcance limitado', () => assert.equal(arit.opcional?.(), 1));",
      "test('vínculo importado foi substituído', () => { arit.substituir(); assert.equal(arit.substituida(), 1); });",
    ]);
    const measuredFeatures = result.runtimeTests.map((test: {
      assertionStatuses: string[]; featurePasses: string[][]; failedFeaturePasses: string[][];
    }) => {
      const [completed] = test.featurePasses;
      const [failed] = test.failedFeaturePasses;
      assert.ok(test.featurePasses.every(pass => JSON.stringify(pass) === JSON.stringify(completed)));
      assert.ok(test.failedFeaturePasses.every(pass => JSON.stringify(pass) === JSON.stringify(failed)));
      return {completed, failed, statuses: test.assertionStatuses};
    });
    const identity = (name: string) => JSON.stringify(['aritmetica.mjs', name]);
    assert.deepEqual(measuredFeatures[0], {completed: [], failed: [identity('capturada')], statuses: Array(3).fill('failed')});
    assert.deepEqual(measuredFeatures[1]?.completed, []);
    assert.deepEqual(measuredFeatures[2]?.completed, []);
    assert.deepEqual(measuredFeatures[3]?.completed, [identity('contagem')]);
    assert.deepEqual(measuredFeatures[3]?.failed, [identity('intercalada')]);
    assert.deepEqual(measuredFeatures[4]?.completed, [identity('falha')]);
    assert.deepEqual(measuredFeatures[5]?.completed, [identity('controle')]);
    assert.deepEqual(measuredFeatures[6]?.completed, []);
    assert.deepEqual(result.findings.map(finding => finding.line), [1, 2, 3, 4, 8]);
    assert.ok(result.findings.every(finding => finding.rule === 'QA-REQUISITO-SEM-PROVA'));
    assert.match(result.row(91).detail, /passed,passed,passed.*asserção reprovada/);
    for (const id of [91, 92, 93, 94]) {
      assert.equal(result.row(id).status, 'ok');
      assert.match(result.row(id).detail, /vínculo sem prova nas três passadas/);
    }
    for (const id of [95, 96]) assert.match(result.row(id).detail, /vínculo comprovado nas três passadas/);
    for (const id of [97, 98, 99]) {
      assert.equal(result.row(id).status, 'skipped');
      assert.match(result.row(id).detail, /cobertura limitada/);
    }
    assert.match(result.row(98).detail, /lacuna medida/);
    assert.match(result.findings.at(-1)!.message, /para inativa \(aritmetica\.mjs:9\)$/);
  });
});

test('matriz distingue inventário vazio, execução indisponível e alcance parcial', realTools, async () => {
  await withSyntheticRepo('qa-inventario-vazio-', async repo => {
    const file = 'requisitos.md';
    const source = 'export const somar = (x, y) => x + y;\n';
    writeFileSync(join(repo, file), 'REQ-101: `somar` de `aritmetica.mjs`\nREQ-102: calcular uma soma\n');
    writeFileSync(join(repo, 'aritmetica.mjs'), source);
    const syntax = await loadQaSyntax();
    const options = {workspace: repo, reqFiles: [file], incomplete: false, testAnalyses: [],
      sourceAnalyses: [analyzeSourceFile('aritmetica.mjs', source, syntax)]};
    const empty = buildTraceability({...options, runtimeTests: []});
    assert.ok(empty.extraRows.filter(row => row.tool.startsWith('qa-requisito:')).every(row =>
      row.status === 'ok' && /inventário completo: nenhum teste encontrado/.test(row.detail)));
    assert.deepEqual(empty.findings.map(finding => finding.rule), Array(2).fill('QA-REQUISITO-SEM-PROVA'));
    const unavailable = buildTraceability(options);
    assert.deepEqual(unavailable.findings.map(finding => finding.rule), Array(2).fill('QA-REQUISITO-SEM-CANDIDATO'));
    for (const partial of [{incomplete: true}, {executionPartial: true}]) {
      const report = buildTraceability({...options, runtimeTests: [], ...partial});
      assert.equal(coverageFor({coverage: report.extraRows}, 'qa-requisito:REQ-101').status, 'skipped');
      assert.deepEqual(report.findings, []);
    }
    const report = await collectQaModule({repoDir: repo});
    assert.equal(coverageFor(report, 'node-test-v8').status, 'skipped');
    assert.equal(coverageFor(report, 'qa-matriz-estatica').status, 'ok');
    assert.equal(coverageFor(report, 'qa-requisito:REQ-101').status, 'ok');
    assert.deepEqual(report.findings.map(finding => finding.rule), Array(2).fill('QA-REQUISITO-SEM-PROVA'));
    const failedTool = await collectQaModule({repoDir: repo, failTool: 'node-test-v8'});
    assert.equal(coverageFor(failedTool, 'node-test-v8').status, 'failed');
    assert.equal(coverageFor(failedTool, 'qa-requisito:REQ-101').status, 'skipped');
    assert.ok(failedTool.findings.every(finding => finding.rule !== 'QA-REQUISITO-SEM-PROVA'));

    const testFile = 'aritmetica.test.mjs';
    const testSource = "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {somar} from './aritmetica.mjs'; test('REQ-102 soma', () => assert.equal(somar(1, 2), 3));";
    const withCandidate = {...options, testAnalyses: [analyzeTestFile(testFile, testSource, syntax)]};
    const staticCandidate = buildTraceability(withCandidate);
    assert.deepEqual(staticCandidate.findings, []);
    for (const matrix of [unavailable, staticCandidate]) {
      const row = coverageFor({coverage: matrix.extraRows}, 'qa-requisito:REQ-101');
      assert.equal(row.status, 'skipped');
      assert.match(row.detail, /somente análise estática/);
    }
    const missingEvents = buildTraceability({...withCandidate, runtimeTests: []});
    assert.equal(coverageFor({coverage: missingEvents.extraRows}, 'qa-requisito:REQ-101').status, 'skipped');
    assert.deepEqual(missingEvents.findings, []);

    const manifest = join(repo, 'package.json');
    writeFileSync(manifest, JSON.stringify({scripts: {test: 'npm run outro-teste'}}));
    const unsupportedRunner = await collectQaModule({repoDir: repo});
    assert.match(coverageFor(unsupportedRunner, 'node-test-v8').detail, /incompatível/);
    assert.equal(coverageFor(unsupportedRunner, 'qa-requisito:REQ-102').status, 'skipped');
    assert.ok(unsupportedRunner.findings.every(finding => finding.rule !== 'QA-REQUISITO-SEM-PROVA'));
    rmSync(manifest);

    writeFileSync(join(repo, 'test_aritmetica.py'), 'def test_soma():\n    assert 1 + 2 == 3\n');
    const otherLanguage = await collectQaModule({repoDir: repo});
    assert.equal(coverageFor(otherLanguage, 'qa-requisito:REQ-102').status, 'skipped');
    assert.deepEqual(otherLanguage.findings, []);
  });
});

test('auditoria estática do Playwright distingue skip condicional de condição falsa', realTools, async () => {
  await withSyntheticRepo('qa-playwright-estatico-', async repo => {
    writeFileSync(join(repo, 'requisitos.md'), 'REQ-01: pedidos\nREQ-02: entregas\nREQ-03: listagem\nREQ-04: exportação\nREQ-05: cancelamento');
    writeFileSync(join(repo, 'pedidos.spec.ts'), [
      "import {test as scenario, expect} from '@playwright/test';",
      "scenario('REQ-01', () => { scenario['skip'](true, 'temporário'); expect(1).toBe(1); });",
      "scenario('REQ-02', () => { scenario.skip(false, 'controle'); expect(1).toBe(1); });",
      "scenario('REQ-03', ({browserName}) => { scenario.fixme(browserName === 'webkit', 'temporário'); expect(1).toBe(1); });",
      "scenario('REQ-04', () => { expect(1).toBe(1); });",
      "scenario['skip']?.('REQ-05', () => expect(1).toBe(1));",
    ].join('\n'));
    const report = await collectQaModule({repoDir: repo});
    assert.deepEqual(report.findings.filter(f => f.rule === 'QA-TESTE-PULADO').map(f => f.line), [2, 4, 6]);
    assert.deepEqual(report.findings.filter(f => f.rule === 'QA-REQUISITO-SEM-CANDIDATO').map(f => f.line), [1, 3, 5]);
    assert.match(coverageFor(report, 'qa-requisito:REQ-01').detail, /skip\/todo possível/);
    assert.doesNotMatch(coverageFor(report, 'qa-requisito:REQ-02').detail, /skip\/todo possível/);
  });
});

test('propriedades declaradas medem o validador real com casos sintéticos determinísticos', realTools, async () => {
  await withSyntheticRepo('qa-validadores-', async repo => {
    const file = 'tests/clean-pricing.test.ts';
    const sourceFile = 'src/clean-pricing.ts';
    const source = readFileSync(join(cleanFixtureDir, sourceFile), 'utf8');
    const testSource = readFileSync(join(cleanFixtureDir, file), 'utf8');
    const ast = await readTestAst(file, testSource);
    assert.equal(ast.validators.length, 4);
    const options = {
      testAnalyses: [ast],
    };
    const syntax = await loadQaSyntax();
    const sourceAnalyses = (code: string) => [analyzeSourceFile(sourceFile, code, syntax)];
    const defective = source.replace("throw 'QUANTIDADE_INVALIDA';", 'return quantidade;');
    assert.notEqual(defective, source);
    assert.equal(measureValidatorCases({...options, sourceAnalyses: sourceAnalyses(source)}).coverageRow.status, 'skipped');
    for (const [tag, code] of [['limpo', source], ['defeito', defective]] as const) {
      const passes = [];
      for (let index = 0; index < 3; index++) {
        const scratch = join(repo, `${tag}-${index}`);
        cpSync(cleanFixtureDir, scratch, {recursive: true});
        writeFileSync(join(scratch, sourceFile), code);
        passes.push(await runSyntheticPass(scratch, [file]));
      }
      const runtimeTests = comparePasses(passes);
      const scenario = {...options, sourceAnalyses: sourceAnalyses(code)};
      const result = measureValidatorCases({...scenario, runtimeTests});
      assert.equal(result.coverageRow.status, 'ok');
      assert.match(result.coverageRow.detail, /4 de 4 casos/);
      assert.deepEqual(result.findings.map(finding => finding.line),
        tag === 'limpo' ? [] : ast.validators.slice(2).map(candidate => candidate.line));
      const noProof = runtimeTests.map((row: {statuses: string[]}) => ({...row, statuses: ['skipped', 'skipped', 'skipped']}));
      assert.equal(measureValidatorCases({...scenario, runtimeTests: noProof}).coverageRow.status, 'skipped');
    }
  });
});

test('propriedades excluem estado externo e resultados não primitivos mesmo com três aprovações', realTools, async () => {
  const file = 'validators.test.mjs';
  const sourceFile = 'validators.mjs';
  const source = [
    'let contador = 0;',
    'const externo = 5;',
    'export function puro(valor) { const resultado = valor + 1; return resultado; }',
    'export function comEstado(valor) { return valor + ++contador; }',
    'export function captura(valor) { return valor + externo; }',
    "export function objeto(valor) { if (valor === 0) throw 'zero'; return {valor}; }",
    'export function substituida(valor) { return valor; }',
    'substituida = valor => valor + contador;',
    'export function chamada(valor) { return Number.isInteger(valor); }',
  ].join('\n');
  const testSource = [
    "import {test} from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import {puro, comEstado, captura, objeto, substituida, chamada} from './validators.mjs';",
    "test('QA-VALIDADOR: primitivo com constante local', () => assert.equal(puro(0), 1));",
    "test('QA-VALIDADOR: contador externo', () => assert.equal(comEstado(0), 1));",
    "test('QA-VALIDADOR: referência externa', () => assert.equal(captura(0), 5));",
    "test('QA-VALIDADOR: resultado composto', () => assert.throws(() => objeto(0)));",
    "test('QA-VALIDADOR: exportação substituída', () => assert.equal(substituida(0), 1));",
    "test('QA-VALIDADOR: chamada externa', () => assert.equal(chamada(0), true));",
    "test('estado varia dentro do processo', () => assert.equal(comEstado(0), 2));",
  ].join('\n');
  await withSyntheticRepo('qa-pureza-', async repo => {
    const passes = [];
    for (let index = 0; index < 3; index++) {
      const scratch = join(repo, `run-${index}`);
      mkdirSync(scratch);
      writeFileSync(join(scratch, file), testSource);
      writeFileSync(join(scratch, sourceFile), source);
      passes.push(await runSyntheticPass(scratch, [file]));
    }
    const runtimeTests = comparePasses(passes);
    assert.ok(runtimeTests.every((test: {statuses: string[]}) => test.statuses.every(status => status === 'passed')));
    const result = measureValidatorCases({
      sourceAnalyses: [analyzeSourceFile(sourceFile, source, await loadQaSyntax())],
      testAnalyses: [await readTestAst(file, testSource)], runtimeTests,
    });
    assert.equal(result.coverageRow.status, 'ok');
    assert.match(result.coverageRow.detail, /1 de 6 casos.*0 com reprovação.*5 sem forma elegível ou pureza demonstrável/);
    assert.deepEqual(result.findings, []);
  });
});

test('referência e mutantes executam com o mesmo preload e permissões V8', realTools, async () => {
  await withSyntheticRepo('qa-mutacao-config-', async repo => {
    const file = 'limiar.test.mjs';
    const src = 'limiar.mjs';
    const source = 'export function incluido(valor) { return valor >= 100; }';
    const tests = [
      "import {test} from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import {existsSync} from 'node:fs';",
      "import {incluido} from './limiar.mjs';",
      "test('configuração de execução', () => {",
      "  assert.ok(existsSync('.qa-v8-probe.mjs'));",
      "  assert.ok(existsSync('.qa-coverage'));",
      "});",
      "test('fronteira do desconto', () => assert.equal(incluido(100), true));",
    ].join('\n');
    const run = async (name: string, code: string) => {
      const scratch = join(repo, name);
      mkdirSync(scratch);
      writeFileSync(join(scratch, file), tests);
      writeFileSync(join(scratch, src), code);
      return runSyntheticPass(scratch, [file]);
    };
    const baseline = await run('referencia', source);
    assert.ok(baseline.summary);
    assert.ok(baseline.coverage.some((file: {file: string}) => file.file === src));
    const inocuous = await run('equivalente', source.replace('>= 100', '> 99'));
    assert.equal(classifyMutant(baseline, inocuous).status, 'sobrevivente');
    const changed = await run('fronteira', source.replace('>= 100', '> 100'));
    const result = classifyMutant(baseline, changed);
    assert.equal(result.status, 'morto');
    assert.equal(result.killedBy.name, 'fronteira do desconto');
    assert.throws(() => classifyMutant(changed, inocuous), /QA_MUTANT_BASELINE_INELIGIBLE/);
  });
});

const {decodePythonPass, decodeGoPass, decodeGoProfile, measureLanguageSuite, selectLanguageSuite} = await import(
  new URL('../deploy/modules/qa/language-tests.mjs', import.meta.url).href
);
const languageFixtureDir = fileURLToPath(new URL('./fixtures/module-qa-languages/', import.meta.url));
const pythonFiles = ['arithmetic.py', 'test_arithmetic.py'];
const goFiles = ['go/go.mod', 'go/arithmetic.go', 'go/arithmetic_test.go'];
const pythonSelection = selectLanguageSuite('python', pythonFiles, false);
const goSelection = selectLanguageSuite('go', goFiles, false);
const goModule = 'example.invalid/qa/arithmetic';
const goProfile = `mode: set\n${goModule}/arithmetic.go:3.10,4.15 2 1\n${goModule}/arithmetic.go:4.15,5.15 1 0\n`;
const pythonReport = {
  tests: [
    {file: 'test_arithmetic.py', name: 'ArithmeticTest.test_control', status: 'passed'},
    {file: 'test_arithmetic.py', name: 'ArithmeticTest.test_defect', status: 'failed'},
  ],
  errors: 0, unavailable: 0, fixtureSkips: 0, coverage: {files: 1, statements: [3, 4], branches: [1, 2]},
};

test('entrypoint descobre Python e Go no snapshot sintético e reserva a execução à imagem', async () => {
  const result = spawnSync('/bin/sh', [entrypointPath], {
    encoding: 'utf8',
    env: {PATH: process.env.PATH, QA_HOST_TEST_MODE: '1', QA_REPO_DIR: languageFixtureDir},
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const report = JSON.parse(result.stdout) as Awaited<ReturnType<typeof collectQaModule>>;
  assert.match(coverageFor(report, 'qa-snapshot').detail, /^5 arquivos copiados/);
  for (const tool of ['python-unittest-coverage', 'go-test-cover']) {
    assert.equal(coverageFor(report, tool).status, 'skipped');
    assert.match(coverageFor(report, tool).detail, /contêiner isolado/);
    assert.ok(report.coverage.every(row => row.tool !== `${tool}-execucao`));
    assert.ok(report.findings.every(finding => finding.tool !== tool));
  }
  const withoutLanguages = await collectQaModule({repoDir: cleanFixtureDir});
  for (const tool of ['python-unittest-coverage', 'go-test-cover']) {
    assert.match(coverageFor(withoutLanguages, tool).detail, /nenhum arquivo candidato/);
  }
  assert.match(coverageFor(withoutLanguages, 'qa-requisito:REQ-01').detail, /vínculo estático/);
});

test('seleção offline distingue snapshot parcial, nome Python inválido e módulos Go fora de escopo', () => {
  assert.deepEqual(pythonSelection, {files: ['test_arithmetic.py'], sourceFiles: ['arithmetic.py'], omitted: 0});
  assert.deepEqual(goSelection, {
    files: ['go/arithmetic_test.go'], sourceFiles: ['go/arithmetic.go'], moduleFile: 'go/go.mod', moduleDir: 'go', omitted: 0,
  });
  assert.match(selectLanguageSuite('python', pythonFiles, true).reason, /escopo parcial/);
  assert.match(selectLanguageSuite('python', ['test-arithmetic.py'], false).reason, /sem nome importável/);
  assert.match(selectLanguageSuite('go', ['arithmetic_test.go'], false).reason, /módulo Go indisponível/);
  assert.match(selectLanguageSuite('go', [...goFiles, 'second/go.mod'], false).reason, /vários módulos/);
  assert.match(selectLanguageSuite('go', ['vendor/pkg/arithmetic_test.go'], false).reason, /nenhum arquivo candidato/);
  const root = selectLanguageSuite('go', ['go.mod', 'arithmetic_test.go', ...goFiles, 'vendor/tool_test.go'], false);
  assert.deepEqual(root.files, ['arithmetic_test.go']);
  assert.equal(root.omitted, 1);
});

test('três passadas Python com controle, reprovação da fixture e cobertura de ramos', async () => {
  let executed = 0;
  const result = await measureLanguageSuite('python', pythonSelection, async () => {
    executed++;
    return decodePythonPass({code: 0, output: JSON.stringify(pythonReport)}, pythonSelection);
  });
  assert.equal(executed, 3);
  assert.equal(result.coverageRow.status, 'ok');
  for (let index = 0; index < 3; index++) {
    assert.match(result.extraRows[index].detail, new RegExp(`execução ${index + 1}: reprovado; 1 aprovados, 1 reprovados`));
  }
  assert.equal(result.extraRows[3].status, 'ok');
  assert.match(result.extraRows[3].detail, /abaixo de 100%.*statements 3\/4, ramos 1\/2/);
  assert.deepEqual(result.findings.map(({file, rule, message}: QaFinding) => [file, rule, message]), [
    ['test_arithmetic.py', 'QA-TESTE-FALHOU', "Teste 'ArithmeticTest.test_defect' falhou"],
  ]);
  assert.throws(() => decodePythonPass({code: 0, output: '{"limited":true}'}, pythonSelection), /QA_LANGUAGE_TEST_LIMIT/);
  assert.throws(() => decodePythonPass({code: 1, output: JSON.stringify(pythonReport)}, pythonSelection), /QA_PYTHON_EXECUTION_FAILED/);
});

test('ausência, dependência indisponível e interrupção Python geram estados próprios sem inventar cobertura', async () => {
  const execute = (report: Partial<typeof pythonReport>) => async () =>
    decodePythonPass({code: 0, output: JSON.stringify({...pythonReport, tests: [], coverage: null, ...report})}, pythonSelection);
  const empty = await measureLanguageSuite('python', pythonSelection, execute({}));
  assert.equal(empty.coverageRow.status, 'skipped');
  assert.match(empty.extraRows[0].detail, /nenhum teste executável/);
  assert.match(empty.extraRows[3].detail, /sem medição/);
  const missing = await measureLanguageSuite('python', pythonSelection, execute({unavailable: 1}));
  assert.equal(missing.coverageRow.status, 'skipped');
  assert.match(missing.coverageRow.detail, /dependência indisponível/);
  const skipped = await measureLanguageSuite('python', pythonSelection, execute({fixtureSkips: 1}));
  assert.match(skipped.extraRows[0].detail, /todos os casos pulados/);
  const interrupted = await measureLanguageSuite('python', pythonSelection, async () => { throw new Error('QA_TEST_TIMEOUT'); });
  assert.equal(interrupted.coverageRow.status, 'failed');
  assert.match(interrupted.extraRows[2].detail, /QA_TEST_TIMEOUT/);
  assert.deepEqual(interrupted.findings, []);
});

function goEvents(events: object[]): string {
  return events.map(event => JSON.stringify(event)).join('\n');
}

test('Go conserva a reprovação e o controle por passada e pondera statements sem declarar ramos', async () => {
  const output = goEvents([
    {Action: 'pass', Package: goModule, Test: 'TestControl'},
    {Action: 'fail', Package: goModule, Test: 'TestDefect'},
    {Action: 'output', Package: goModule, Test: 'TestDefect', Output: 'mensagem sintética não publicada'},
    {Action: 'fail', Package: goModule},
  ]);
  const result = await measureLanguageSuite('go', goSelection, async () =>
    decodeGoPass({code: 1, output, diagnostics: ''}, goProfile, goSelection, goModule));
  assert.equal(result.coverageRow.status, 'ok');
  for (let index = 0; index < 3; index++) assert.match(result.extraRows[index].detail, /1 aprovados, 1 reprovados/);
  assert.match(result.extraRows[3].detail, /statements 2\/3/);
  assert.doesNotMatch(result.extraRows[3].detail, /ramos/);
  assert.equal(result.findings[0].file, 'go/arithmetic_test.go');
  assert.match(result.findings[0].message, /TestDefect/);
  assert.doesNotMatch(JSON.stringify(result), /mensagem sintética/);
  assert.deepEqual(decodeGoProfile(goProfile + `${goModule}/arithmetic.go:3.10,4.15 2 0\n`,
    new Set([`${goModule}/arithmetic.go`])), {files: 1, statements: [2, 3]});
});

test('Go distingue ausência de casos, erro de compilação, dependência offline e cobertura parcial', async () => {
  const run = (code: number, events: object[], profile: string | null = null, selection = goSelection) =>
    measureLanguageSuite('go', selection, async () =>
      decodeGoPass({code, output: goEvents(events), diagnostics: ''}, profile, selection, goModule));
  const absent = await run(0, [{Action: 'skip', Package: goModule}], goProfile);
  assert.equal(absent.coverageRow.status, 'skipped');
  assert.match(absent.extraRows[0].detail, /nenhum teste executável/);
  assert.match(absent.extraRows[3].detail, /sem medição/);
  const failure = await run(1, [{Action: 'build-fail', ImportPath: goModule},
    {Action: 'fail', Package: goModule, FailedBuild: goModule}]);
  assert.equal(failure.coverageRow.status, 'failed');
  assert.deepEqual(failure.findings, []);
  const missing = await run(1, [
    {Action: 'build-output', ImportPath: goModule, Output: 'module lookup disabled by GOPROXY=off'},
    {Action: 'build-fail', ImportPath: goModule},
    {Action: 'fail', Package: goModule, FailedBuild: goModule},
  ]);
  assert.equal(missing.coverageRow.status, 'skipped');
  assert.match(missing.coverageRow.detail, /dependência indisponível/);
  const mixed = await run(1, [
    {Action: 'build-output', ImportPath: goModule, Output: 'no required module provides package'},
    {Action: 'fail', Package: goModule, FailedBuild: goModule},
    {Action: 'build-fail', ImportPath: `${goModule}/other`},
    {Action: 'fail', Package: `${goModule}/other`, FailedBuild: `${goModule}/other`},
  ]);
  assert.equal(mixed.coverageRow.status, 'failed');
  const interrupted = await run(1, [
    {Action: 'fail', Package: goModule, Test: 'TestDefect'},
    {Action: 'run', Package: goModule, Test: 'TestInterrupted'},
    {Action: 'fail', Package: goModule},
  ]);
  assert.equal(interrupted.coverageRow.status, 'failed');
  assert.equal(interrupted.findings.length, 1);
  assert.match(interrupted.findings[0].message, /TestDefect/);
  const passed = [{Action: 'pass', Package: goModule, Test: 'TestControl'}, {Action: 'pass', Package: goModule}];
  const partial = await run(0, passed, goProfile,
    selectLanguageSuite('go', [...goFiles, 'go/unmeasured.go'], false));
  assert.equal(partial.coverageRow.status, 'ok');
  assert.equal(partial.extraRows[3].status, 'skipped');
  assert.match(partial.extraRows[3].detail, /escopo parcial.*statements 2\/3/);
  const malformed = await run(0, passed, 'malformed');
  assert.equal(malformed.coverageRow.status, 'ok');
  assert.match(malformed.extraRows[3].detail, /sem medição/);
});
