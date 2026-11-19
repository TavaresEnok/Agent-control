import assert from 'node:assert/strict';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

type Row = {tool: string; version: string; status: 'ok' | 'skipped' | 'failed'; detail: string; files?: string[]};
type Finding = {rule: string; tool: string; file: string; line: number; evidence: string};
type Kind = 'openapi' | 'pact';
type Report = {coverageRow: Row; extraRows?: Row[]; findings?: Finding[]};

const {functionalContractTools, runFunctionalContract} = (await import(
  new URL('../deploy/modules/qa/contratos/index.mjs', import.meta.url).href
)) as {
  functionalContractTools: Record<Kind, string>;
  runFunctionalContract: (kind: Kind, input: Record<string, unknown>) => Promise<Report>;
};
const {collectQaModule} = (await import(new URL('../deploy/modules/qa/collect.mjs', import.meta.url).href)) as {
  collectQaModule: (input: {repoDir: string}) => Promise<{coverage: Row[]; findings: Finding[]}>;
};

const fixture = fileURLToPath(new URL('./fixtures/module-qa-contratos/', import.meta.url));
const openapi = 'openapi.json';
const pact = 'pacts/catalogo.pact.json';

async function withFixture(check: (input: {
  workspace: string;
  run: (kind: Kind, enabled?: boolean) => Promise<Report>;
}) => Promise<void>) {
  const workRoot = mkdtempSync(join(tmpdir(), 'qa-contract-unit-'));
  const workspace = join(workRoot, 'repo');
  try {
    mkdirSync(workspace);
    cpSync(fixture, workspace, {recursive: true});
    const run = (kind: Kind, enabled = true) => {
      const copiedFiles = readdirSync(workspace, {recursive: true, withFileTypes: true})
        .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(workspace.length + 1));
      const openapiFiles = copiedFiles.includes(openapi) ? [openapi] : [];
      const validatedOpenApi = new Map(openapiFiles.map(file => [file, JSON.parse(readFileSync(join(workspace, file), 'utf8'))]));
      return runFunctionalContract(kind, {
        workspace, workRoot, copiedFiles, openapiFiles, validatedOpenApi, enabled,
        row: (tool: string, version: string, status: string, detail: string) => ({tool, version, status, detail}),
        key: (tool: string, file: string, suffix = '') => `${tool}:${file}${suffix}`,
        pathLabel: (file: string) => file,
      });
    };
    await check({workspace, run});
    assert.deepEqual(readdirSync(workRoot), ['repo'], 'remoção do socket e da cópia de trabalho');
  } finally {
    rmSync(workRoot, {recursive: true, force: true});
  }
}

function editText(workspace: string, file: string, change: (source: string) => string) {
  const path = join(workspace, file);
  const before = readFileSync(path, 'utf8');
  const after = change(before);
  assert.notEqual(after, before);
  writeFileSync(path, after);
}

function documentRow(report: Report, kind: Kind, file: string): Row {
  const found = report.extraRows?.find(row => row.tool === `${functionalContractTools[kind]}:${file}`);
  assert.ok(found);
  return found;
}

test('mede exemplos OpenAPI e interações Pact no socket local e reconhece o 404 declarado', async () => {
  await withFixture(async ({run}) => {
    const oas = await run('openapi');
    const consumer = await run('pact');
    assert.equal(oas.coverageRow.status, 'ok');
    assert.equal(consumer.coverageRow.status, 'ok');
    assert.deepEqual(oas.coverageRow.files, [openapi]);
    assert.deepEqual(consumer.coverageRow.files, [pact]);
    assert.match(oas.coverageRow.detail, /4\/4 exemplos ou interações medidos, 0 divergentes/);
    assert.match(consumer.coverageRow.detail, /2\/2 exemplos ou interações medidos, 0 divergentes/);
    assert.match(documentRow(oas, 'openapi', openapi).version, /OpenAPI 3\.0\.3$/);
    assert.match(documentRow(consumer, 'pact', pact).version, /Pact 3\.0\.0$/);
    assert.ok(oas.extraRows?.some(row => /esperado 404, recebido 404.*conforme/.test(row.detail)));
    assert.deepEqual(oas.findings, []);
    assert.deepEqual(consumer.findings, []);
    assert.doesNotMatch(JSON.stringify([oas, consumer]),
      /MARCA-SINTETICA|Consumidor Sintético|Provedor Sintético|leitura nominal de catálogo|lapis|papel|produto-ausente|\/soma/);
  });
});

test('detecta divergência de status, estrutura e valor Pact com evidência sem conteúdo', async () => {
  await withFixture(async ({workspace, run}) => {
    editText(workspace, 'provider.mjs', source => source
      .replace("404, {erro: 'produto-ausente'}", "500, {erro: 'ERRO-SINTETICO-INTERNO'}")
      .replace("codigo: 'lapis', preco: 2", "codigo: 'lapis', preco: 'TIPO-SINTETICO'")
      .replace('total: a + b', 'total: a - b'));
    const oas = await run('openapi');
    const consumer = await run('pact');
    assert.equal(oas.coverageRow.status, 'ok');
    assert.match(oas.coverageRow.detail, /4\/4.*2 divergentes/);
    assert.match(consumer.coverageRow.detail, /2\/2.*2 divergentes/);
    assert.ok(oas.findings?.some(finding => finding.rule === 'QA-OPENAPI-EXEMPLO-DIVERGENTE' &&
      finding.file === openapi && finding.line === 1 && /esperado 404, recebido 500/.test(finding.evidence)));
    assert.ok(oas.findings?.some(finding => /operação 1.*estrutura JSON diferente/.test(finding.evidence)));
    assert.ok(consumer.findings?.some(finding => finding.rule === 'QA-PACT-RESPOSTA-DIVERGENTE' &&
      finding.file === pact && /interação 2.*esperado 200, recebido 200.*não corresponde/.test(finding.evidence)));
    assert.doesNotMatch(JSON.stringify([oas, consumer]), /ERRO-SINTETICO|TIPO-SINTETICO|MARCA-SINTETICA|produto-ausente/);
  });
});

test('mede só documentos e casos elegíveis e explicita componente ou exemplos ausentes', async () => {
  await withFixture(async ({workspace, run}) => {
    const disabled = await run('openapi', false);
    assert.match(documentRow(disabled, 'openapi', openapi).detail, /0\/4 medidos.*contêiner isolado/);
    rmSync(join(workspace, 'provider.mjs'));
    const withoutComponent = await run('pact');
    assert.equal(withoutComponent.coverageRow.status, 'skipped');
    assert.match(documentRow(withoutComponent, 'pact', pact).detail, /0\/2 medidos.*adaptador .mjs ausente/);

    writeFileSync(join(workspace, openapi), JSON.stringify({
      openapi: '3.0.3', paths: {'/catalogo': {get: {responses: {'200': {description: 'sem exemplo'}}}}},
    }));
    const withoutExamples = await run('openapi');
    assert.match(documentRow(withoutExamples, 'openapi', openapi).detail, /1 sem exemplo de resposta.*0\/0 medidos/);

    writeFileSync(join(workspace, pact), JSON.stringify({provider: {name: 'Provedor Sintético'}, interactions: []}));
    const withoutConsumer = await run('pact');
    assert.match(documentRow(withoutConsumer, 'pact', pact).detail, /sem consumidor e provedor distintos/);
  });
});

test('não presume pareamento OpenAPI, exemplo externo, autenticação ou estado Pact', async () => {
  await withFixture(async ({workspace, run}) => {
    editText(workspace, openapi, source => {
      const spec = JSON.parse(source);
      const get = spec.paths['/catalogo'].get;
      const json = get.responses['200'].content['application/json'];
      json.examples = {um: {value: json.example}, dois: {value: json.example}};
      delete json.example;
      spec.paths['/catalogo/{codigo}'].get.security = [{chave: []}];
      spec.paths['/soma'].post.responses['200'].content['application/json'] = {
        examples: {externo: {externalValue: './exemplo-declarado.json'}},
      };
      return JSON.stringify(spec);
    });
    const oas = await run('openapi');
    assert.equal(oas.coverageRow.status, 'skipped');
    assert.match(oas.coverageRow.detail, /0\/5 exemplos/);
    assert.ok(oas.extraRows?.some(row => /mesma requisição/.test(row.detail)));
    assert.ok(oas.extraRows?.some(row => /exige autenticação/.test(row.detail)));
    assert.ok(oas.extraRows?.some(row => /sem exemplo JSON embutido/.test(row.detail)));

    editText(workspace, pact, source => {
      const spec = JSON.parse(source);
      spec.metadata.pactSpecification.version = '2.0.0';
      spec.interactions[0].request.query = 'categoria=papel';
      spec.interactions[1].providerState = 'ESTADO-SINTETICO';
      return JSON.stringify(spec);
    });
    const mapped = 'contrato-consumidor.json';
    renameSync(join(workspace, pact), join(workspace, mapped));
    editText(workspace, 'qa-contracts.json', source => source.replace(pact, mapped));
    const consumer = await run('pact');
    assert.match(consumer.coverageRow.detail, /1\/2 exemplos ou interações medidos, 0 divergentes/);
    assert.match(documentRow(consumer, 'pact', mapped).version, /Pact 2\.0\.0/);
    assert.ok(consumer.extraRows?.some(row => row.status === 'skipped' && /estado de provedor/.test(row.detail)));
    assert.doesNotMatch(JSON.stringify(consumer), /ESTADO-SINTETICO/);
  });
});

test('limita o replay e distingue falha operacional de divergência observada', async () => {
  await withFixture(async ({workspace, run}) => {
    editText(workspace, pact, source => {
      const spec = JSON.parse(source);
      spec.interactions = Array.from({length: 65}, () => spec.interactions[0]);
      return JSON.stringify(spec);
    });
    const limited = await run('pact');
    assert.match(limited.coverageRow.detail, /16\/65.*limites/);
    assert.match(documentRow(limited, 'pact', pact).detail, /1 fora do limite de enumeração/);
    assert.ok(limited.extraRows?.some(row => row.status === 'skipped' && /fora do limite de trocas/.test(row.detail)));

    writeFileSync(join(workspace, 'provider.mjs'), "throw new Error('DIAGNOSTICO-SINTETICO-NAO-PUBLICAR');");
    const failed = await run('openapi');
    assert.equal(failed.coverageRow.status, 'failed');
    assert.ok(failed.extraRows?.some(row => row.status === 'failed' && /adaptador local não iniciou/.test(row.detail)));
    assert.deepEqual(failed.findings, []);
    assert.doesNotMatch(JSON.stringify(failed), /DIAGNOSTICO-SINTETICO/);
  });
});

test('aplica estrutura JSON, charset Pact e o limite de corpo nas respostas locais', async () => {
  await withFixture(async ({workspace, run}) => {
    editText(workspace, pact, source => {
      const spec = JSON.parse(source);
      spec.interactions[0].response.body = {};
      spec.interactions[1].response.headers = {'Content-Type': 'application/json; charset=UTF-8'};
      return JSON.stringify(spec);
    });
    editText(workspace, 'provider.mjs', source => source.replace('application/json; charset=utf-8', 'application/json'));
    const consumer = await run('pact');
    assert.equal(consumer.findings?.length, 2);
    assert.ok(consumer.findings.some(finding => /interação 1.*JSON não corresponde/.test(finding.evidence)));
    assert.ok(consumer.findings.some(finding => /interação 2.*charset UTF-8/.test(finding.evidence)));

    editText(workspace, 'provider.mjs', source => source.replace("marca: 'MARCA-SINTETICA-NAO-PUBLICAR'", "marca: 'a'.repeat(65536)"));
    const limited = await run('openapi');
    assert.match(limited.coverageRow.detail, /3\/4 exemplos ou interações medidos, 0 divergentes/);
    assert.ok(limited.extraRows?.some(row => row.status === 'failed' && /acima do limite de 64 KiB/.test(row.detail)));
  });
});

test('coletor mantém OpenAPI estático e restringe o adaptador ao contêiner', async context => {
  const parser = '@apidevtools/swagger-parser/package.json';
  const local = fileURLToPath(new URL('../deploy/modules/qa/node_modules/', import.meta.url));
  const configured = process.env.QA_TOOLS_NODE_MODULES;
  if (![local, configured].some(root => root && existsSync(join(root, parser)))) {
    context.skip('swagger-parser fixado indisponível');
    return;
  }
  const report = await collectQaModule({repoDir: fixture});
  assert.ok(report.coverage.some(row => row.tool === 'swagger-parser' && row.status === 'ok'));
  assert.ok(report.coverage.some(row => row.tool === 'qa-openapi:openapi.json' && row.status === 'ok'));
  for (const [kind, doc] of [['openapi', openapi], ['pact', pact]] as const) {
    const row = report.coverage.find(item => item.tool === `${functionalContractTools[kind]}:${doc}`);
    assert.equal(row?.status, 'skipped');
    assert.match(row.detail, /contêiner isolado/);
  }
  await withFixture(async ({workspace}) => {
    editText(workspace, openapi, source => source.replace('"3.0.3"', '"3.1.0"'));
    const report31 = await collectQaModule({repoDir: workspace});
    const row = report31.coverage.find(item => item.tool === `${functionalContractTools.openapi}:${openapi}`);
    assert.match(row?.version ?? '', /OpenAPI 3\.1\.0$/);
    assert.match(row?.detail ?? '', /0\/4 medidos.*contêiner isolado/);
  });
});
