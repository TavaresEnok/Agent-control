import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';

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

const {collectQaModule} = (await import(
  new URL('../deploy/modules/qa/collect.mjs', import.meta.url).href
)) as {
  collectQaModule: (options?: {repoDir?: string; failTool?: string}) => Promise<{
    coverage: QaCoverageRow[];
    findings: QaFinding[];
  }>;
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
const cleanFixtureDir = fileURLToPath(new URL('./fixtures/module-qa/clean/', import.meta.url));
const entrypointPath = join(qaModuleDir, 'entrypoint.sh');
const realTools = {
  skip: ['fast-check', 'jsdom', 'axe-core', '@apidevtools/swagger-parser', '@stryker-mutator/instrumenter']
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

test('entrypoint recusa caminho com .., argumento .sock e diretorio inexistente', () => {
  const traversal = spawnSync('/bin/sh', [entrypointPath, '../escape'], {
    encoding: 'utf8',
    env: {...process.env, QA_HOST_TEST_MODE: '1', QA_REPO_DIR: fixtureDir},
  });
  assert.equal(traversal.status, 78);
  assert.match(traversal.stderr, /QA_PATH_FORBIDDEN/);

  const socketArg = spawnSync('/bin/sh', [entrypointPath, '/var/run/engine.sock'], {
    encoding: 'utf8',
    env: {...process.env, QA_HOST_TEST_MODE: '1', QA_REPO_DIR: fixtureDir},
  });
  assert.equal(socketArg.status, 78);
  assert.match(socketArg.stderr, /QA_SOCKET_FORBIDDEN/);

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
    assert.equal(finding.file.includes('..'), false);
    assert.equal(Number.isInteger(finding.line) && finding.line >= 1, true);
    assert.ok(['alta', 'media', 'baixa', 'informativa'].includes(finding.severity));
    assert.ok(finding.message.length > 0);
    assert.ok(finding.evidence.length > 0);
  }

  const toolStatus = new Map(output.coverage.map(c => [c.tool, c.status]));
  assert.equal(toolStatus.get('node-test-v8'), 'skipped');
  assert.equal(toolStatus.get('stryker-mutator'), 'skipped');
  assert.equal(toolStatus.get('qa-matriz-estatica'), 'ok');
  assert.equal(toolStatus.get('fast-check'), 'ok');
  assert.equal(toolStatus.get('playwright-test-audit'), 'ok');
  assert.equal(toolStatus.get('axe-core'), 'ok');
  assert.equal(toolStatus.get('swagger-parser'), 'ok');
  assert.equal(toolStatus.get('k6-homologacao'), 'skipped');

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

  // Defeitos plantados encontrados pelas 6 ferramentas ativas
  const hasFinding = (tool: string, rule: string, file: string, line?: number) =>
    output.findings.some(
      f => f.tool === tool && f.rule === rule && f.file === file && (line === undefined || f.line === line),
    );

  assert.equal(output.findings.some(f => ['node-test-v8', 'stryker-mutator'].includes(f.tool)), false);
  assert.equal(hasFinding('qa-matriz-estatica', 'QA-REQUISITO-SEM-PROVA', 'requisitos.md', 4), true);
  assert.equal(
    hasFinding('fast-check', 'QA-FASTCHECK-PROPRIEDADE-VIOLADA', 'src/defective-pricing.ts', 15),
    true,
  );
  assert.equal(
    hasFinding('playwright-test-audit', 'QA-TESTE-PULADO', 'tests/defective-pricing.test.ts', 17),
    true,
  );
  assert.equal(
    hasFinding('playwright-test-audit', 'QA-TESTE-SEM-ASSERCAO', 'tests/defective-pricing.test.ts', 21),
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
    'fast-check',
    'playwright-test-audit',
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
    symlinkSync('/etc/hostname', join(tempRepo, 'src', 'link.ts'));

    const result = await collectQaModule({repoDir: tempRepo});
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('nao-pode-sair'), false);
    assert.equal(serialized.includes('segredo-proibido'), false);
    assert.equal(serialized.includes('link.ts'), false);
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
  assert.match(selectNodeSuite({...options, incomplete: true}).reason, /limites de copia/);
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
