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

const {collectQaModule, summarizeNodePasses, analyzeSourceFile, loadQaSyntax, analyzeTestFile, buildTraceability, measureValidatorCases} = (await import(
  new URL('../deploy/modules/qa/collect.mjs', import.meta.url).href
)) as {
  collectQaModule: (options?: {repoDir?: string; failTool?: string}) => Promise<{
    coverage: QaCoverageRow[];
    findings: QaFinding[];
  }>;
  analyzeTestFile: (file: string, source: string, parse: unknown) => {validators: {line: number}[]};
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
  assert.equal(verified.toolCount, 5);
  assert.ok(verified.totalLockedPackages >= 100);

  const dockerfile = readFileSync(join(qaModuleDir, 'Dockerfile'), 'utf8');
  const lock = JSON.parse(readFileSync(join(qaModuleDir, 'qa-tools.lock.json'), 'utf8')) as {
    packageLockSha256: string;
    baseImage: {digest: string; tag: string};
  };
  assert.match(lock.baseImage.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(dockerfile.includes(lock.baseImage.digest), true);
  assert.equal(dockerfile.includes(lock.packageLockSha256), true);
  assert.equal(/latest/i.test(dockerfile), false);
  assert.match(dockerfile, /sha256sum -c/);
  assert.match(dockerfile, /verify-lock\.mjs/);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
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
  assert.equal(toolStatus.get('qa-requisito:REQ-01'), 'ok');
  assert.equal(toolStatus.get('qa-requisito:REQ-02'), 'ok');
  assert.equal(toolStatus.get('qa-rota:GET /api/desconto'), 'ok');
  assert.equal(toolStatus.get('qa-rota:POST /api/estorno'), 'ok');

  // Defeitos plantados observáveis pela análise estática.
  const hasFinding = (tool: string, rule: string, file: string, line?: number) =>
    output.findings.some(
      f => f.tool === tool && f.rule === rule && f.file === file && (line === undefined || f.line === line),
    );

  assert.equal(output.findings.some(f => ['node-test-v8', 'stryker-mutator'].includes(f.tool)), false);
  assert.equal(hasFinding('qa-matriz-estatica', 'QA-REQUISITO-SEM-PROVA', 'requisitos.md', 4), true);
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
    assert.ok(!report.findings.some(f => ['QA-CONTRATO-ROTA-SEM-OPENAPI', 'QA-REQUISITO-SEM-PROVA'].includes(f.rule)));
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
    assert.ok(complete.findings.some(finding => finding.rule === 'QA-REQUISITO-SEM-PROVA'));

    writeFileSync(join(repo, 'zzzz.md'), '# Elegível');
    const partial = await collectQaModule({repoDir: repo});
    assert.match(coverageFor(partial, 'qa-snapshot').detail, /^400 arquivos copiados \(cópia parcial\)/);
    assert.ok(partial.coverage.some(row => row.detail === '1 arquivos elegíveis fora do limite de arquivos'));
    for (const tool of ['node-test-v8', 'stryker-mutator']) {
      assert.match(coverageFor(partial, tool).detail, /snapshot parcial/);
    }
    assert.ok(!partial.findings.some(finding => finding.rule === 'QA-REQUISITO-SEM-PROVA'));
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

test('axe registra que baixo contraste ficou sem medição e informa a versão instalada', realTools, async () => {
  await withSyntheticRepo('qa-contraste-', async repo => {
    writeFileSync(join(repo, 'contraste.html'), '<!doctype html><html lang="pt"><head><title>Controle</title></head>' +
      '<body><main><p style="color:#aaa;background-color:#aaa">Texto sintético</p></main></body></html>');
    const report = await collectQaModule({repoDir: repo});
    const axe = coverageFor(report, 'axe-core');
    const installed = JSON.parse(readFileSync(join(qaModuleDir, 'node_modules/axe-core/package.json'), 'utf8'));
    assert.equal(axe.version, installed.version);
    assert.match(axe.detail, /regra color-contrast desativada/);
    assert.match(axe.detail, /sem scripts nem layout/);
    assert.ok(!report.findings.some(f => f.rule === 'QA-AXE-COLOR-CONTRAST'));
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
  const qaRequire = createRequire(join(qaModuleDir, 'package.json'));
  const {parse} = await import(pathToFileURL(qaRequire.resolve('@babel/parser')).href);
  return analyzeTestFile(file, content, parse);
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
  ].join('\n');
  await withSyntheticRepo('qa-status-', async repo => {
    writeFileSync(join(repo, file), source);
    writeFileSync(join(repo, 'requisitos.md'), Array.from({length: 6}, (_, index) => `REQ-0${index + 1}: sintético`).join('\n'));
    const staticReport = await collectQaModule({repoDir: repo});
    assert.ok(!staticReport.findings.some(f => f.rule === 'QA-TESTE-SEM-ASSERCAO'));
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
    assert.match(matrix.extraRows.find(row => row.tool === 'qa-requisito:REQ-01')?.detail ?? '', /passed,passed,passed.*asserção executada/);
    if (process.platform === 'linux') assert.match(matrix.findings[0]!.evidence, /skipped,skipped,skipped/);
    assert.match(matrix.findings.at(-1)!.evidence, /todo,todo,todo/);
  });
});

test('matriz exige uma asserção executada e atribuída a cada teste nas três passadas', realTools, async () => {
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
      [['unobserved'], ['executed'], ['unobserved'], ['unsupported'], ['unsupported'], ['executed']]);
    const matrix = buildTraceability({workspace: repo, sourceAnalyses: [], reqFiles: ['requisitos.md'],
      testAnalyses: [await readTestAst(file, source)], runtimeTests, incomplete: false});
    assert.deepEqual(matrix.findings.map(f => f.line), [1, 3, 4, 5]);
    assert.match(matrix.findings[0]!.evidence, /passed,passed,passed.*asserção não observada/);
    assert.match(matrix.findings[2]!.evidence, /passed,passed,passed.*cobertura limitada/);
    for (const id of ['REQ-12', 'REQ-16']) {
      assert.match(coverageFor({coverage: matrix.extraRows}, `qa-requisito:${id}`).detail, /asserção executada nas três passadas/);
    }
  });
});

test('auditoria estática do Playwright distingue skip condicional de condição falsa', realTools, async () => {
  await withSyntheticRepo('qa-playwright-estatico-', async repo => {
    writeFileSync(join(repo, 'requisitos.md'), 'REQ-01: pedidos\nREQ-02: entregas\nREQ-03: listagem\nREQ-04: exportação');
    writeFileSync(join(repo, 'pedidos.spec.ts'), [
      "import {test as scenario, expect} from '@playwright/test';",
      "scenario('REQ-01', () => { scenario['skip'](true, 'temporário'); expect(1).toBe(1); });",
      "scenario('REQ-02', () => { scenario.skip(false, 'controle'); expect(1).toBe(1); });",
      "scenario('REQ-03', ({browserName}) => { scenario.fixme(browserName === 'webkit', 'temporário'); expect(1).toBe(1); });",
      "scenario('REQ-04', () => { expect(1).toBe(1); });",
    ].join('\n'));
    const report = await collectQaModule({repoDir: repo});
    assert.deepEqual(report.findings.filter(f => f.rule === 'QA-TESTE-PULADO').map(f => f.line), [2, 4]);
    assert.deepEqual(report.findings.filter(f => f.rule === 'QA-REQUISITO-SEM-PROVA').map(f => f.line), [1, 3]);
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
