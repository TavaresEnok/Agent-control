import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {mapModuleSnapshot} from '../src/module-exam-map.ts';
import {withModuleRecoveryFixture} from './fixtures/module-recovery.ts';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import type {CollectorCriterion, ModuleExamCollectorContext} from '../src/module-exam-collector-proof.ts';
import {hasModuleReviewProof, moduleReviewProofReason, moduleReviewTask, readModuleReviewVerdict, type ModuleReviewObservation} from '../src/module-exam-proof.ts';
import {examineFunctionalModule, moduleCollectorCandidate, moduleExamReviewEvidence, type ModuleExamSeat} from '../src/module-exam.ts';
import {requestModuleCorrection, runVerificationModule, validateModuleCollectorObject, type ModuleRawFinding, type ModuleToolCoverage} from '../src/verification-modules.ts';

const commit = 'a'.repeat(40);
const intentId = randomUUID();
const snapshot = '/snapshot-sintetico/atual';
const coverage = (tool: string, detail: string, files?: string[]): ModuleToolCoverage =>
  ({tool, detail, status: 'ok', version: '1.0', ...(files ? {files} : {})});

type Example = {
  module: ModuleExamCollectorContext['module']; criterion: CollectorCriterion;
  raw: ModuleRawFinding; source: string; expression: string; facts: string[]; coverage: ModuleToolCoverage[];
  contradicted: string;
};

function example(module: Example['module'], criterion: CollectorCriterion, raw: Omit<ModuleRawFinding, 'severity' | 'message'>,
  source: string, expression: string, facts: string[], rows: ModuleToolCoverage[], contradicted: string,
  message = 'MARCADOR_DO_AUTOR', summary = 'Execução do coletor finalizada.'): Example {
  return {module, criterion, raw: {...raw, message, severity: 'media'}, source, expression, facts,
    coverage: [coverage(raw.tool, summary), ...rows], contradicted};
}

const mutantPatch = 'src/precos.ts:2 EqualityOperator → valor > 100';
const mutantResult = 'node:test aprovou após o patch com os mesmos resultados da referência (3 testes aprovados)';
const cpuDetails = 'arquivo=server.mjs:2; função=calcular; tempo próprio amostral=109.0ms; amostras próprias=10/20; limiar=80ms';
const k6RouteLine = '    {"path": "/relatorio", "file": "server.mjs"}';
const expressCall = "app.del('/items/:id', (req: Request, res: Response) => {\n    res.end();\n  })";
const k6Summary = '1 rota(s) testada(s) com limites (p95<120ms, falhas<1.0%); 1 achado(s)';
const examples = [
  example('qa', 'qa-mutant-survived', {file: 'src/precos.ts', tool: 'stryker-mutator', line: 2,
    rule: 'QA-STRYKER-MUTANTE-SOBREVIVENTE', evidence: `${mutantPatch}: ${mutantResult}`},
  'export function calcula(valor: number) {\n  if (valor >= 100) return 1;\n  return 0;\n}', 'valor >= 100', ['valor > 100', '3'],
  [coverage('qa-mutante:1', `sobrevivente | ${mutantPatch} | ${mutantResult}`)], 'valor >= 101'),
  example('qa', 'qa-v8-unexecuted-function', {file: 'src/precos.ts', tool: 'node-test-v8', line: 2,
    rule: 'QA-COBERTURA-FUNCAO-SEM-TESTE', evidence: 'contagem V8 da função nas passadas 1, 2 e 3: 0, 0, 0'},
  'export function preparar() {}\nexport function estornar(id: string): string {\n  return id;\n}', 'export function estornar(id: string)', ['estornar', '0', '0', '0'],
  [coverage('qa-arquivo:src/precos.ts', 'V8 em três passadas: ramos 1/2, funções 1/2; ramos 1/2, funções 1/2; ramos 1/2, funções 1/2')],
  'export function reenviar(id: string)', "Função exportada 'estornar' sem execução medida pelo V8"),
  example('arquitetura', 'knip-unreached-export', {file: 'src/legado.ts', tool: 'knip', line: 1,
    rule: 'KNIP-UNUSED-FILE', evidence: 'knip files: src/legado.ts'},
  'export function converte(valor: number): number {\n  return valor * 10;\n}', 'export function converte(valor: number)', ['converte', 'nao_alcancado'],
  [coverage('knip:file', 'arquivo=src/legado.ts; papel=nao_alcancado; problemas=1')], '/* export function converte(valor: number) */'),
  example('dependencias', 'ast-grep-express-del', {file: 'src/rotas.ts', tool: 'ast-grep', line: 2,
    rule: 'ASTGREP-EXPRESS5-APP-DEL', evidence: `Revisão necessária: ${expressCall}`},
  `export function registrar(app: any) {\n  ${expressCall};\n}`, "app.del('/items/:id', (req: Request, res: Response) => {", ['app', 'del'],
  [coverage('ast-grep', 'arquivo=src/rotas.ts; achados=1')], "app.delete('/items/:id', (req: Request, res: Response) => {"),
  example('banco', 'sql-drop-column', {file: 'db/migrations/002.sql', tool: 'squawk', line: 2,
    rule: 'SQUAWK-BAN-DROP-COLUMN', evidence: 'Regra ban-drop-column; coluna 1; migração analisada em modo transacional.'},
  '-- Revisão\nALTER TABLE public.items DROP COLUMN nota_antiga;', 'ALTER TABLE public.items DROP COLUMN nota_antiga;', ['public.items', 'nota_antiga'],
  [coverage('squawk', 'squawk:file:db/migrations/002.sql: 1 alertas', ['db/migrations/002.sql'])],
  '-- ALTER TABLE public.items DROP COLUMN nota_antiga;'),
  example('banco', 'sql-historical-invariant', {file: 'banco/assert.sql', tool: 'pg_restore', line: 1,
    rule: 'BANCO-INVARIANTE-HISTORICO', evidence: 'O SELECT de verificação não retornou true (após atualização).'},
  'SELECT count(*) = 10\nFROM public.items;', 'SELECT count(*) = 10', ['restored', 'após atualização', 'falhou'],
  [coverage('pg_restore', 'pg_restore:restored:banco/assert.sql: após atualização, invariante falhou')],
  'VALUES (false); -- verificação', 'O invariante dos dados antigos falhou em restored.'),
  example('banco', 'sql-query-mean-exceeded', {file: 'banco/queries/latency.sql', tool: 'pg_stat_statements', line: 2,
    rule: 'BANCO-CONSULTA-LENTA', evidence: 'queryid=-42; amostras=3; média=141.006 ms; blocos hit/read=0/0'},
  '-- Consulta de relatório\nSELECT total FROM public.items;', 'SELECT total FROM public.items;', ['-42', '3', '141.006', '100'],
  [coverage('pg_stat_statements', 'pg_stat_statements:query:banco/queries/latency.sql: linha 2; queryid=-42; amostras=3; média=141.006 ms; blocos hit/read=0/0',
    ['banco/queries/latency.sql'])],
  '/* SELECT total FROM public.items; */', 'A consulta atingiu a média de 100 ms na carga ensaiada.'),
  example('banco', 'sql-hypothetical-index-savings', {file: 'banco/queries/by-code.sql', tool: 'dexter', line: 2,
    rule: 'BANCO-INDICE-CANDIDATO', evidence: 'redução estimada de 1880.00 para 8.06 unidades de custo; candidatos: public.items / item_code'},
  '-- Busca seletiva\nSELECT payload FROM public.items WHERE item_code = 31001;',
  'SELECT payload FROM public.items WHERE item_code = 31001;', ['public.items', 'item_code', '1880.00', '8.06'],
  [coverage('dexter', 'dexter:query:banco/queries/by-code.sql: linha 2; planos hipotéticos comparados', ['banco/queries/by-code.sql'])],
  'SELECT payload FROM public.items WHERE item_other = 31001;'),
  example('prontidao', 'tls-certificate-option-false', {file: 'src/client.ts', tool: 'prontidao-audit', line: 3,
    rule: 'PRONTIDAO-TLS-VERIFICACAO-DESABILITADA', evidence: 'Diretiva de validação de certificado TLS desabilitada.'},
  'export function opcoes() {\n  return {\n    rejectUnauthorized: false,\n    timeoutMs: 5000,\n  };\n}',
  'rejectUnauthorized: false', ['rejectUnauthorized', 'false'],
  [coverage('prontidao:arquivo', 'src/client.ts: verificações [tls-verify], 1 achado(s).')], 'rejectUnauthorized: true,'),
  example('desempenho', 'cpu-own-time-exceeded', {file: 'server.mjs', tool: 'node-cpu-prof', line: 2,
    rule: 'CPU-PROF-HOTSPOT', evidence: cpuDetails},
  'const base = 4;\nfunction calcular() {\n  return base * 5;\n}', 'function calcular()', ['calcular', '109.0', '10', '20', '80'],
  [coverage('node-cpu-prof:arquivo', cpuDetails + '; recorte: uma chamada isolada sem argumentos', ['server.mjs'])], 'function outra()'),
  example('desempenho', 'k6-route-p95-exceeded', {file: 'desempenho.config.json', tool: 'k6', line: 3,
    rule: 'K6-THRESHOLD-LATENCY-P95', evidence: 'declaração da rota em desempenho.config.json:3; arquivo associado=server.mjs; métrica da resposta HTTP; rota=/relatorio p95=190.0ms avg=150.3ms max=200.0ms exit=99'},
  `{\n  "routes": [\n${k6RouteLine}\n  ]\n}`, '"path": "/relatorio"', ['/relatorio', 'server.mjs', '190.0', '120', '3'],
  [coverage('k6:rota:/relatorio', 'arquivo=server.mjs; rota=/relatorio; requisições=3; p95=190.0ms; falhas=0.00%', ['server.mjs'])],
  '"path": "/outra"', 'MARCADOR_DO_AUTOR', k6Summary),
  example('documentacao', 'typedoc-undocumented-export', {file: 'src/billing.ts', tool: 'typedoc', line: 2,
    rule: 'DOC-TYPEDOC-SIMBOLO-SEM-DOC', evidence: 'TypeDoc reflection kind=Function name=cobrar (src/billing.ts:2) sem summary/blockTags'},
  '\nexport function cobrar(centavos: number) {\n  return centavos;\n}', 'export function cobrar(centavos: number)', ['cobrar', 'sem JSDoc'],
  [coverage('typedoc:file', 'arquivo=src/billing.ts; simbolos=1; documentados=0; exports=cobrar')],
  '// export function cobrar(centavos: number) {}', 'Símbolo público exportado "cobrar" em src/billing.ts não possui documentação JSDoc/TSDoc.'),
  example('conformidade', 'ort-declared-strong-copyleft', {file: 'package-lock.json', tool: 'ort', line: 3,
    rule: 'ORT_STRONG_COPYLEFT_DECLARED', evidence: 'ORT processou a declaração em packages como GPL-3.0-only.'},
  '{\n  "packages": {\n    "node_modules/fixture": {\n      "version": "1.0.0",\n      "license": "GPL-3.0-only"\n    }\n  }\n}',
  '"node_modules/fixture"', ['node_modules/fixture', 'GPL-3.0-only'],
  [coverage('ort:file', 'package-lock.json | 1/1 declarações SPDX processadas no ORT.')], '"not_a_dependency"'),
];

function context(row: Example, partial?: Partial<ModuleExamCollectorContext>): ModuleExamCollectorContext {
  return {module: row.module, intentId, snapshot, commit, exitCode: 0, findings: [row.raw], coverage: row.coverage, ...partial};
}

const candidate = (row: Example) => ({...moduleCollectorCandidate(row.raw), reviewCommit: commit});
function review(row: Example, collector?: ModuleExamCollectorContext, source = row.source) {
  return moduleExamReviewEvidence(row.module, candidate(row), source, row.raw, collector && {collector, intentId, snapshot});
}

type Task = Pick<ModuleReviewObservation, 'criterion' | 'file' | 'line' | 'tool' | 'rule' | 'commit'> & {
  code: string; binding: string; expectedExpression?: string; factOrder?: string[];
  collector?: {commit: string; intentId: string; records: ModuleToolCoverage[];
    sourceContext: {firstLine: number; excerpt: string}; relatedSources?: {file: string; line: number; code: string}[]};
};

function response(task: Task, example: Example) {
  const {binding, code, criterion, file, line, tool, rule, commit} = task;
  return {kind: 'confirmacao' as const, status: 'confirmado' as const, binding, proof: code, reason: 'observação localizada',
    observation: {criterion, file, line, tool, rule, commit, expression: example.expression,
      column: code.indexOf(example.expression) + 1, facts: example.facts}};
}

for (const row of examples) {
  test(`${row.criterion} exige âncora, fatos específicos e cobertura canônica`, () => {
    const canonical = context(row);
    const evidence = review(row, canonical);
    assert.ok(evidence?.collectorCase);
    const serialized = moduleReviewTask(evidence);
    const task: Task = JSON.parse(serialized);
    assert.equal(task.criterion, row.criterion);
    assert.equal(task.collector?.commit, commit);
    assert.equal(task.collector?.intentId, intentId);
    assert.ok(task.collector?.records.length);
    assert.ok(task.collector.sourceContext.excerpt.includes(row.expression));
    assert.equal(task.factOrder?.length, row.facts.length);
    assert.ok(task.expectedExpression);
    assert.doesNotMatch(serialized, /MARCADOR_DO_AUTOR|snapshot-sintetico/);

    const verdict = response(task, row);
    assert.ok(readModuleReviewVerdict(verdict));
    const reason = moduleReviewProofReason(evidence, verdict);
    assert.ok(reason);
    assert.ok(hasModuleReviewProof(evidence, {...verdict, reason}));
    assert.equal(hasModuleReviewProof(evidence, {...verdict, kind: undefined}), false);
    assert.equal(moduleReviewProofReason(evidence, {...verdict, status: 'descartado'}), null);
    assert.equal(moduleReviewProofReason(evidence, {...verdict, observation: undefined}), null);
    assert.equal(moduleReviewProofReason(evidence, {...verdict, observation: {...verdict.observation, facts: ['texto genérico']}}), null);
    assert.equal(moduleReviewProofReason(evidence, {...verdict, observation: {...verdict.observation, expression: row.raw.file}}), null);
    assert.equal(moduleReviewProofReason(evidence, {...verdict, observation: {...verdict.observation, column: verdict.observation.column + 1}}), null);

    const staleSource = row.source.replace(row.expression, row.contradicted);
    assert.notEqual(staleSource, row.source);
    assert.equal(review(row, canonical, staleSource)?.collectorCase, undefined);
    assert.equal(review(row, context(row, {coverage: row.coverage.slice(0, 1)}))?.collectorCase, undefined);
    assert.equal(review(row, context(row, {coverage: row.coverage.map((entry, index) => index ? {...entry, status: 'failed'} : entry)}))?.collectorCase, undefined);
    assert.equal(review(row, context(row, {coverage: [...row.coverage, {...row.coverage.at(-1)!, status: 'skipped'}]}))?.collectorCase, undefined);
    const validated = validateModuleCollectorObject({coverage: row.coverage, findings: [row.raw]}, row.module);
    const parsedRow = {...row, raw: validated.findings[0]!, coverage: validated.coverage};
    assert.ok(review(parsedRow, context(parsedRow))?.collectorCase, 'o formato validado pelo coletor segue verificável');
  });
}

test('rejeita troca de critério, de origem, de arquivo e de prova entre exames', () => {
  const first = examples[0]!;
  const second = examples.find(row => row.criterion === 'cpu-own-time-exceeded')!;
  const firstEvidence = review(first, context(first))!;
  const secondEvidence = review(second, context(second))!;
  const firstTask: Task = JSON.parse(moduleReviewTask(firstEvidence));
  const secondTask: Task = JSON.parse(moduleReviewTask(secondEvidence));
  const measured = response(secondTask, second);
  const swapped = response(firstTask, first);
  assert.equal(moduleReviewProofReason(secondEvidence, {...measured, observation: swapped.observation}), null);
  assert.equal(moduleReviewProofReason(secondEvidence, {...measured, binding: swapped.binding}), null);
  assert.equal(moduleReviewProofReason(secondEvidence, {...measured, observation: {...measured.observation, file: first.raw.file}}), null);
  assert.equal(moduleReviewProofReason(secondEvidence, {...measured, observation: {...measured.observation, commit: 'b'.repeat(40)}}), null);

  for (const mismatch of [{intentId: randomUUID()}, {snapshot: snapshot + '/outro'}, {commit: 'b'.repeat(40)},
    {module: 'qa' as const}, {exitCode: 1}, {findings: [first.raw]}, {findings: [second.raw, second.raw]}]) {
    assert.equal(review(second, context(second, mismatch))?.collectorCase, undefined);
  }
  assert.equal(review(second)?.collectorCase, undefined);
  const otherIntent = randomUUID();
  const otherEvidence = moduleExamReviewEvidence(second.module, candidate(second), second.source, second.raw,
    {intentId: otherIntent, snapshot, collector: context(second, {intentId: otherIntent})})!;
  assert.ok(otherEvidence.collectorCase);
  assert.equal(moduleReviewProofReason(otherEvidence, measured), null);
  assert.equal(review(second, context(second), second.source + '\n' + ' '.repeat(16000)), null);
  assert.equal(review(second, context(second), second.source + '\n// …')?.collectorCase, undefined);

  const updated = context(second, {coverage: second.coverage.map(row => ({...row, version: '2.0'}))});
  const updatedEvidence = review(second, updated)!;
  assert.ok(updatedEvidence.collectorCase);
  assert.equal(moduleReviewProofReason(updatedEvidence, measured), null);
});

test('localização e semântica básica excluem alternativas contraditórias', () => {
  const tls = examples.find(row => row.criterion === 'tls-certificate-option-false')!;
  assert.equal(review(tls, context(tls), tls.source.replace('timeoutMs: 5000', 'rejectUnauthorized: true'))?.collectorCase, undefined);
  assert.equal(review(tls, context(tls), tls.source.replace('timeoutMs: 5000', '...settings'))?.collectorCase, undefined);
  const doc = examples.find(row => row.criterion === 'typedoc-undocumented-export')!;
  assert.equal(review(doc, context(doc), '/** Fatura em centavos. */' + doc.source)?.collectorCase, undefined);
  const ort = examples.find(row => row.criterion === 'ort-declared-strong-copyleft')!;
  assert.equal(review(ort, context(ort), ort.source.replace('GPL-3.0-only', 'MIT'))?.collectorCase, undefined);
  assert.equal(review(ort, context(ort), ort.source.replace('"license":', '"license": "MIT", "license":'))?.collectorCase, undefined);
  const k6 = examples.find(row => row.criterion === 'k6-route-p95-exceeded')!;
  assert.equal(review(k6, context(k6), k6.source.replace('server.mjs', 'outro.mjs'))?.collectorCase, undefined);
  assert.equal(review(k6, context(k6, {coverage: [coverage('k6', k6Summary.replace('120ms', '190ms')), k6.coverage[1]!]}))?.collectorCase, undefined);
});

test('um ciclo exige o import de retorno e resolução única no mesmo snapshot', () => {
  const alpha = 'src/alpha.ts';
  const beta = 'src/beta.ts';
  const alphaSource = "import {seguir} from './beta.js';\nexport function iniciar() { return seguir(); }";
  const betaSource = "import {iniciar} from './alpha.js';\nexport function seguir() { return iniciar(); }";
  const row = example('arquitetura', 'relative-import-cycle', {file: alpha, tool: 'dependency-cruiser', line: 1,
    rule: 'DEPCRUISE-NO-CIRCULAR', evidence: `ciclo: ${alpha} -> ${beta} -> ${alpha}`},
  alphaSource, "import {seguir} from './beta.js'", ['./beta.js', './alpha.js'],
  [alpha, beta].map(file => coverage('dependency-cruiser:file',
    `arquivo=${file}; deps=1; dependentes=1; instabilidade=0.50; ciclo=sim; violacao_camada=nao`)), '// sem import');
  const canonical = context(row);
  const read = (sources: ReadonlyMap<string, string | null>, collector = canonical) =>
    moduleExamReviewEvidence(row.module, candidate(row), row.source, row.raw, {collector, snapshot, intentId, relatedSources: sources});
  const files = new Map([[alpha, alphaSource], [beta, betaSource]]);
  const evidence = read(files)!;
  assert.ok(evidence.collectorCase);
  const task: Task = JSON.parse(moduleReviewTask(evidence));
  const verdict = response(task, row);
  assert.deepEqual(task.collector?.relatedSources?.map(({file, line, code}) => ({file, line, code})),
    [{file: beta, line: 1, code: "import {iniciar} from './alpha.js'"}]);
  assert.ok(moduleReviewProofReason(evidence, verdict));
  assert.equal(read(new Map([[alpha, alphaSource]]))?.collectorCase, undefined);
  assert.equal(read(new Map([[alpha, alphaSource], [beta, betaSource.replace('./alpha.js', './outro.js')]]))?.collectorCase, undefined);
  assert.equal(read(new Map<string, string | null>([...files, ['src/beta.js', null]]))?.collectorCase, undefined);
  assert.equal(read(files, context(row, {coverage: row.coverage.slice(0, -1)}))?.collectorCase, undefined);
  const modifiedRelated = read(new Map([[alpha, alphaSource], [beta, betaSource + '\nexport const limite = 3;']]))!;
  assert.ok(modifiedRelated.collectorCase);
  assert.equal(moduleReviewProofReason(modifiedRelated, verdict), null);
  const normalized = validateModuleCollectorObject({coverage: row.coverage, findings: [row.raw]}, row.module);
  const normalizedRow = {...row, raw: normalized.findings[0]!, coverage: normalized.coverage};
  assert.ok(moduleExamReviewEvidence(row.module, candidate(normalizedRow), row.source, normalizedRow.raw,
    {collector: context(normalizedRow), snapshot, intentId, relatedSources: files})?.collectorCase);
});

function seat(provider: string): ModuleExamSeat {
  return {provider, model: 'modelo-sintetico', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()};
}

test('o exame envia e revalida o recorte do coletor sem modificar o retorno cru', async () => {
  const row = examples.find(row => row.criterion === 'cpu-own-time-exceeded')!;
  const examiner = seat('primeiro'), reviewer = seat('segundo');
  const canonical = context(row);
  const original = structuredClone(canonical);
  let reviewCall: Task | undefined;
  const base = {
    module: row.module, intentId, commit, findings: canonical.findings,
    collectorReview: {collector: canonical, intentId, snapshot},
    map: {files: [{file: row.raw.file, code: row.source, reason: null}], routes: []},
    release: async () => {},
    worker: {run: async (call: {task: string; writePaths: string[]}) => {
      assert.deepEqual(call.writePaths, []);
      const task = JSON.parse(call.task);
      if (task.checklist) return JSON.stringify({kind: 'exame', filesRead: [row.raw.file], checklist: [row.module], findings: []});
      reviewCall = task;
      return JSON.stringify(response(task, row));
    }},
  };

  const result = await examineFunctionalModule({...base, reserve: async purpose => purpose === 'examiner' ? examiner : reviewer});
  assert.ok(reviewCall?.collector?.records.length);
  assert.equal(result.findings[0]?.status, 'confirmado');
  assert.equal(result.findings[0]?.verifier?.provider, reviewer.provider);
  assert.ok(hasModuleReviewProof(review(row, canonical)!, result.findings[0]!));
  assert.deepEqual(canonical, original);

  const pending = await examineFunctionalModule({...base, reserve: async purpose => {
    if (purpose === 'reviewer') throw new Refusal('MODULE_EXAM_REVIEWER_UNAVAILABLE');
    return examiner;
  }});
  assert.equal(pending.findings[0]?.status, 'provavel');
  assert.equal(pending.findings[0]?.verifier, null);
  assert.equal(pending.findings[0]?.failure, 'MODULE_EXAM_REVIEWER_UNAVAILABLE');

  const uncovered = await examineFunctionalModule({...base,
    worker: {run: async () => JSON.stringify({kind: 'exame', filesRead: ['outro.mjs'], checklist: [row.module], findings: []})},
    reserve: async purpose => { assert.equal(purpose, 'examiner'); return examiner; }});
  assert.equal(uncovered.findings[0]?.status, 'provavel');
});

test('a publicação confirma uma medição funcional de cada módulo usando o snapshot e o histórico do host', {
  skip: !process.env.AC_TEST_DATABASE_URL, timeout: 120_000,
}, async () => {
  await withModuleRecoveryFixture(process.env.AC_TEST_DATABASE_URL!, async input => {
    const tested = new Set<Example['module']>();
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', input.repoPath, ...args], {encoding: 'utf8'}).trim();
    for (const row of examples) {
      if (tested.has(row.module)) continue;
      const file = join(input.repoPath, row.raw.file);
      await mkdir(dirname(file), {recursive: true});
      await writeFile(file, row.source);
      git('add', '--', row.raw.file);
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Medição ' + row.module);
      const commitId = git('rev-parse', 'HEAD');
      const {contextId} = await input.ledger.ensureExamContext(input.principal, input.projectId, row.module);
      const authority = row.module === 'qa' ? input.authority :
        await input.ledger.acquire(input.principal, contextId, randomUUID(), 'fixture-exame', 60);
      const examiner = seat('primeiro'), reviewer = seat('segundo');
      const run = await runVerificationModule({...input, authority, module: row.module, commit: commitId,
        collectorOutput: {coverage: row.coverage, findings: [row.raw]}, async examinar(req) {
          assert.equal(req.collector?.commit, commitId);
          const map = await mapModuleSnapshot(req.snapshot);
          return examineFunctionalModule({...req, map, commit: commitId,
            collectorReview: {collector: req.collector!, intentId: req.intentId, snapshot: req.snapshot},
            reserve: async purpose => purpose === 'examiner' ? examiner : reviewer, release: async () => {},
            worker: {run: async call => {
              const task = JSON.parse(call.task);
              return task.checklist ? JSON.stringify({kind: 'exame', filesRead: [task.file], checklist: [row.module], findings: []})
                : JSON.stringify(response(task, row));
            }},
          });
        },
      });
      assert.equal(run.achados[0]?.status, 'confirmado', row.module);
      assert.equal(run.achados[0]?.verifier?.provider, 'segundo', row.module);
      const saved = await input.ledger.pool.query('SELECT status FROM ac_verify_findings WHERE run_id=$1', [run.runId]);
      assert.equal(saved.rows[0]?.status, 'confirmado', row.module);
      const correction = await requestModuleCorrection(input.ledger, input.principal, authority, {
        module: row.module, runId: run.runId, achadoIds: [run.achados[0]!.id], dataDirectory: input.dataDirectory,
        projectId: input.projectId, repoPath: input.repoPath,
      });
      assert.ok(correction.writePaths.includes(row.raw.file), row.module);
      const regressionFile = 'tests/' + row.module + '/' + run.achados[0]!.id.toLowerCase() + '.test.ts';
      assert.ok(correction.writePaths.includes(regressionFile), row.module);
      assert.ok(correction.regressionTest.includes(regressionFile), row.module);
      tested.add(row.module);
    }
    assert.equal(tested.size, 8);
  });
});
