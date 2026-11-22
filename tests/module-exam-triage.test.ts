import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Refusal, type Authority} from '../src/contracts.ts';
import type {Ledger} from '../src/ledger.ts';
import {createPersonalModuleExam} from '../src/module-exam-native.ts';
import {DEFAULT_MODULE_EXAM_BATCH, examineFunctionalModule, MODULE_EXAM_REVIEW_SAMPLE, type ModuleExamInput, type ModuleExamSeat} from '../src/module-exam.ts';
import {moduleExamEconomy, moduleRunLines} from '../src/personal-module-cli.ts';
import type {VerificationModuleRunResult} from '../src/verification-modules.ts';
import {qaStaticFinding, qaStaticTool, reviewFixtureVerdict} from './fixtures/module-exam-review.ts';

const seat = (provider: string): ModuleExamSeat => ({provider, model: `${provider}-model`, accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()});
const intentId = randomUUID();
const skipped = (n: number) => `test.skip("caso ${n}", () => {})`;
const examAnswer = (task: any, findings: unknown[] = []) =>
  JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: ['qa'], routesReviewed: [], findings});

/** `files` test files with `perFile` skipped tests each, and one collector finding per skipped test. */
function suite(files: number, perFile: number) {
  const map = {files: Array.from({length: files}, (_, f) => ({file: `src/c${f}.test.ts`, reason: null,
    code: Array.from({length: perFile}, (_, line) => skipped(line) + ';').join('\n') + '\n'})), routes: []};
  const findings = map.files.flatMap(({file}) => Array.from({length: perFile}, (_, line) => qaStaticFinding(file, line + 1, skipped(line) + ';')));
  return {map, findings};
}

function harness(extra: Partial<ModuleExamInput> & Pick<ModuleExamInput, 'map' | 'findings'>) {
  const examiner = seat('claude'), reviewer = seat('codex');
  const reviews: any[] = [];
  const input: ModuleExamInput = {module: 'qa', intentId, commit: 'a'.repeat(40),
    reserve: async purpose => purpose === 'examiner' ? examiner : reviewer, release: async () => {},
    worker: {async run(call) {
      const task = JSON.parse(call.task);
      if (task.checklist) return examAnswer(task);
      reviews.push(task);
      const verdict = (item: any) => reviewFixtureVerdict(item, item.code.replace(/;$/, ''));
      return JSON.stringify(task.items ? {kind: 'confirmacao-lote', results: task.items.map(verdict)} : verdict(task));
    }}, ...extra};
  return {reviews, input};
}

test('300 achados médios de uma regra viram uma chamada com amostra por arquivos distintos', async () => {
  const {map, findings} = suite(30, 10);
  const h = harness({map, findings});
  const result = await examineFunctionalModule(h.input);
  assert.equal(h.reviews.length, 1);
  const items = h.reviews[0]!.items as any[];
  assert.equal(items.length, MODULE_EXAM_REVIEW_SAMPLE);
  assert.equal(new Set(items.map(item => item.file)).size, MODULE_EXAM_REVIEW_SAMPLE);
  const confirmed = result.findings.filter(finding => finding.status === 'confirmado');
  assert.equal(confirmed.length, MODULE_EXAM_REVIEW_SAMPLE);
  assert.ok(confirmed.every(finding => finding.verifier?.provider === 'codex' && finding.binding));
  const rest = result.findings.filter(finding => finding.status === 'provavel');
  assert.equal(rest.length, 300 - MODULE_EXAM_REVIEW_SAMPLE);
  assert.ok(rest.every(finding => finding.failure === null
    && finding.reason === `Fora da amostra revisada da regra: 3 confirmado(s) e 0 descartado(s) em 3 de 300.`));
});

test('regra medida não vai ao revisor; sem triagem cada achado tem a sua chamada', async () => {
  const {map, findings} = suite(5, 2);
  const measured = harness({map, findings, measuredRules: new Set([`${qaStaticTool}:QA-TESTE-PULADO`])});
  const result = await examineFunctionalModule(measured.input);
  assert.equal(measured.reviews.length, 0);
  assert.ok(result.findings.every(finding => finding.reason === 'Regra medida pela própria ferramenta, sem revisão por modelo.'));
  const each = harness({map, findings, reviewTriage: false, measuredRules: new Set([`${qaStaticTool}:QA-TESTE-PULADO`])});
  await examineFunctionalModule(each.input);
  assert.equal(each.reviews.length, 10);
  assert.ok(each.reviews.every(task => !task.items));
});

test('teto por módulo: os mais graves primeiro, o resto fica provável; achado alto da ferramenta sempre revisa', async () => {
  const {map} = suite(1, 21);
  const file = map.files[0]!.file;
  const findings = Array.from({length: 21}, (_, line) => ({...qaStaticFinding(file, line + 1, skipped(line) + ';'),
    rule: `QA-R${line}`, severity: line < 5 ? 'baixa' as const : line === 20 ? 'alta' as const : 'media' as const}));
  const h = harness({map, findings, reviewCap: 15});
  const result = await examineFunctionalModule(h.input);
  assert.equal(h.reviews.length, 16);
  assert.deepEqual(result.findings.map((finding, line) => finding.reason === 'Fora do teto de revisão do módulo.' ? line : -1).filter(line => line >= 0),
    [0, 1, 2, 3, 4]);
  assert.ok(result.notes.includes('Achados fora do teto de revisão do módulo (15 chamadas): 5.'));
  assert.ok(h.reviews.some(task => task.line === 21));
});

test('vagas em paralelo: cobertura, recibos e achados saem na ordem dos arquivos', async () => {
  const files = Array.from({length: 6}, (_, i) => ({file: `src/p${i}.ts`, code: `export const p${i} = ${i};\n`, reason: null}));
  const run = async (concurrency: number) => {
    let inFlight = 0, peak = 0;
    const result = await examineFunctionalModule({module: 'qa', intentId, commit: 'a'.repeat(40), map: {files, routes: []}, findings: [],
      concurrency, reviewCap: 0, reserve: async () => seat('claude'), release: async () => {},
      worker: {async run(call) {
        const task = JSON.parse(call.task);
        inFlight++; peak = Math.max(peak, inFlight);
        // Later files answer first.
        await delay(5 * (files.length - files.findIndex(f => f.file === task.file)));
        inFlight--;
        return examAnswer(task, [{line: 1, snippet: `export const`, title: task.file, hypothesis: 'Existe?', severity: 'baixa'}]);
      }}});
    return {peak, result};
  };
  const serial = await run(1), parallel = await run(3);
  assert.equal(serial.peak, 1);
  assert.equal(parallel.peak, 3);
  const shape = (r: typeof serial.result) => r.coverage.map(row => [row.file, row.status, row.checklist, row.read?.sourceDigest, row.read?.promptDigest]);
  assert.deepEqual(shape(parallel.result), shape(serial.result));
  assert.deepEqual(parallel.result.findings.map(f => f.title), files.map(f => f.file));
});

test('PROVIDER_USAGE_LIMIT numa vaga para as demais: nenhuma chamada nova começa', async () => {
  const files = Array.from({length: 9}, (_, i) => ({file: `src/q${i}.ts`, code: `export const q${i} = ${i};\n`, reason: null}));
  let calls = 0;
  const result = await examineFunctionalModule({module: 'qa', intentId, map: {files, routes: []}, findings: [], concurrency: 3,
    reserve: async () => seat('claude'), release: async () => {},
    worker: {async run(call) {
      const task = JSON.parse(call.task);
      if (calls++ === 0) { await delay(2); throw new Refusal('PROVIDER_USAGE_LIMIT'); }
      await delay(20);
      return examAnswer(task);
    }}});
  assert.equal(calls, 3);
  assert.equal(result.stopped, 'PROVIDER_USAGE_LIMIT');
  assert.deepEqual(result.coverage.map(row => row.status), ['nao_julgado', 'lido', 'lido', ...Array(6).fill('nao_julgado')]);
  assert.ok(result.coverage.filter(row => row.status === 'nao_julgado').every(row => row.reason === 'PROVIDER_USAGE_LIMIT'));
});

test('as vagas em espera de cota compartilham uma só espera e retomam juntas', async () => {
  const files = Array.from({length: 2}, (_, i) => ({file: `src/w${i}.ts`, code: `export const w${i} = ${i};\n`, reason: null}));
  let limited = 2, waits = 0;
  const result = await examineFunctionalModule({module: 'qa', intentId, map: {files, routes: []}, findings: [], concurrency: 2,
    reserve: async () => seat('claude'), release: async () => {},
    waitForClaudeQuota: async () => { waits++; await delay(20); return true; },
    worker: {async run(call) {
      const task = JSON.parse(call.task);
      if (limited > 0) { limited--; await delay(5); throw new Refusal('PROVIDER_USAGE_LIMIT'); }
      return examAnswer(task);
    }}});
  assert.equal(waits, 1);
  assert.ok(result.coverage.every(row => row.status === 'lido'));
  assert.equal(result.stopped, null);
});

test('revisão recusada por capacidade fica com o código e a CLI imprime a contagem', async () => {
  const {map, findings} = suite(2, 1);
  const h = harness({map, findings});
  const result = await examineFunctionalModule({...h.input, reserve: async purpose => {
    if (purpose === 'reviewer') throw new Refusal('CAPACITY_BUSY');
    return seat('claude');
  }});
  assert.ok(result.findings.every(finding => finding.failure === 'CAPACITY_BUSY' && finding.status === 'provavel'));
  const lines = moduleRunLines({runId: 'r', directory: '/d', unreviewed: {count: 2, codes: ['CAPACITY_BUSY']}} as VerificationModuleRunResult);
  assert.deepEqual(lines, ['r', '/d', 'Achados sem revisão: 2 (código CAPACITY_BUSY)']);
  assert.deepEqual(moduleRunLines({runId: 'r', directory: '/d', unreviewed: null} as VerificationModuleRunResult), ['r', '/d']);
});

test('reservas uma de cada vez; recusa de capacidade com vaga própria ocupada espera essa vaga em vez de parar', async () => {
  const files = Array.from({length: 4}, (_, i) => ({file: `src/r${i}.ts`, code: `export const r${i} = ${i};\n`, reason: null}));
  let reserving = 0, overlapped = false, holding = 0;
  const result = await examineFunctionalModule({module: 'qa', intentId, map: {files, routes: []}, findings: [], concurrency: 3,
    async reserve() {
      overlapped ||= reserving > 0;
      reserving++;
      await delay(1);
      reserving--;
      // A single seat: the queue refuses this intent while it already holds one.
      if (holding > 0) throw new Refusal('CAPACITY_BUSY');
      holding++;
      return seat('claude');
    },
    async release() { holding--; },
    worker: {async run(call) { await delay(5); return examAnswer(JSON.parse(call.task)); }}});
  assert.equal(overlapped, false);
  assert.ok(result.coverage.every(row => row.status === 'lido'));
  assert.equal(result.stopped, null);
});

test('instalação sem runtime de modelo: somente ferramentas sem contar como exame parado', async () => {
  const files = [{file: 'src/s.ts', code: 'export const s = 1;\n', reason: null}];
  const off = await examineFunctionalModule({module: 'qa', intentId, map: {files, routes: []}, findings: [],
    unavailable: 'MODULE_EXAM_EXAMINER_UNAVAILABLE', toolsOnly: true});
  assert.deepEqual([off.stopped, off.unjudgedByFailure, off.coverage[0]!.reason], [null, 0, 'modo somente ferramentas']);
  const missing = await examineFunctionalModule({module: 'qa', intentId, map: {files, routes: []}, findings: [],
    unavailable: 'MODULE_EXAM_EXAMINER_UNAVAILABLE'});
  assert.deepEqual([missing.stopped, missing.unjudgedByFailure], ['MODULE_EXAM_EXAMINER_UNAVAILABLE', 1]);
});

test('400 achados altos de uma regra da ferramenta viram uma chamada de amostra, fora do teto', async () => {
  const {map, findings} = suite(40, 10);
  const h = harness({map, findings: findings.map(finding => ({...finding, severity: 'alta' as const})), reviewCap: 0});
  const result = await examineFunctionalModule(h.input);
  assert.equal(h.reviews.length, 1);
  assert.equal(h.reviews[0]!.items.length, MODULE_EXAM_REVIEW_SAMPLE);
  assert.equal(result.findings.filter(finding => finding.status === 'confirmado').length, MODULE_EXAM_REVIEW_SAMPLE);
  assert.ok(result.findings.every(finding => finding.reason !== 'Fora do teto de revisão do módulo.'));
});

test('amostra sem veredito: o resto da regra fica com o código da falha, não como fora da amostra', async () => {
  const {map, findings} = suite(30, 10);
  const examiner = seat('claude');
  const h = harness({map, findings});
  // The reviewer seat repeats the examiner account, so the sample call is refused.
  const result = await examineFunctionalModule({...h.input, reserve: async () => examiner});
  assert.equal(h.reviews.length, 0);
  assert.ok(result.findings.every(finding => finding.failure === 'MODULE_EXAM_PROVIDER_NOT_DISTINCT'
    && finding.reason === 'Confirmação indisponível. Código MODULE_EXAM_PROVIDER_NOT_DISTINCT.'));
  assert.ok(!result.notes.some(note => note.startsWith('Achados fora da amostra')));
});

test('módulos 2 a 9 usam o lote do módulo quando o projeto não fixa batchFiles; scope false desliga o roteamento', () => {
  assert.deepEqual(moduleExamEconomy(undefined), {batch: DEFAULT_MODULE_EXAM_BATCH});
  assert.deepEqual(moduleExamEconomy({batchTokens: 30_000}), {batch: {tokens: 30_000, files: DEFAULT_MODULE_EXAM_BATCH.files}});
  assert.deepEqual(moduleExamEconomy({batchFiles: 5, scope: false}), {batch: {tokens: DEFAULT_MODULE_EXAM_BATCH.tokens, files: 5}, scope: false});
  assert.deepEqual(moduleExamEconomy({batch: false, scope: true}), {batch: false});
});

test('runtime vazio só é somente ferramentas quando a instalação não tem execução nativa configurada', async () => {
  const snapshot = await mkdtemp(join(tmpdir(), 'ac-triage-'));
  try {
    await writeFile(join(snapshot, 'a.ts'), 'export const a = 1;\n');
    const exam = (toolsOnly?: boolean) => createPersonalModuleExam({ledger: {} as Ledger, principal: 'dono', authority: {} as Authority,
      commit: 'a'.repeat(40), loadRuntime: async () => [], ...(toolsOnly === undefined ? {} : {toolsOnly})})({intentId, snapshot, module: 'qa', findings: []});
    const configured = await exam(true);
    assert.deepEqual([configured.stopped, configured.unjudgedByFailure], [null, 0]);
    // Every account disabled leaves the runtime empty too: that is an unavailable examiner.
    for (const disabled of [await exam(false), await exam()]) {
      assert.deepEqual([disabled.stopped, disabled.unjudgedByFailure], ['MODULE_EXAM_EXAMINER_UNAVAILABLE', 1]);
    }
  } finally {
    await rm(snapshot, {recursive: true, force: true});
  }
});
