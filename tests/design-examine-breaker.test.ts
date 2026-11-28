import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {designBenchWorker} from '../src/design-bench.ts';
import {loadDesignChecklist} from '../src/design-checklist.ts';
import {examineDesignScreens, type DesignSeat} from '../src/design-examine.ts';

import {Refusal} from '../src/contracts.ts';
import {ExamDependencyDown} from '../src/exam-preflight.ts';
import {designRawFinding, type DesignWorker} from '../src/design-types.ts';

const base = {repo: '/tmp/repo-design', checklist: loadDesignChecklist(), rawFindings: []};

function screens(count: number, captured = true) {
  return Array.from({length: count}, (_, index) => ({
    file: `src/Tela${index}.tsx`,
    route: `/t${index}`,
    code: `export function Tela${index}() {\n  return <button type="button">Salvar ${index}</button>;\n}\n`,
    captureNote: 'sem captura',
    ...(captured ? {captures: [{path: `/tmp/cap-${index}.png`, viewport: 375, theme: 'claro' as const, state: 'padrao', sha256: String(index).repeat(64).slice(0, 64)}]} : {}),
  }));
}

function kit(refuse?: string) {
  const reserved: string[] = [];
  const reserve = async (role: 'specialist' | 'reviewer', _avoid?: string, options?: {purpose?: string}): Promise<DesignSeat> => {
    reserved.push(`${role}:${options?.purpose ?? 'exame'}`);
    if (refuse) throw new Refusal(refuse);
    return {provider: 'claude', model: 'claude-opus-5-5', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()};
  };
  return {reserved, reserve, release: async () => undefined};
}

function failing(code: string, calls: string[]): DesignWorker {
  return {async run(call) { calls.push(call.designPurpose ?? 'sem-proposito'); throw new Refusal(code); }};
}

test('disjuntor: EXECUTION_TIMEOUT em toda chamada para o exame em 3 chamadas, sem crítica visual, com relatório parcial', async () => {
  const k = kit();
  const calls: string[] = [];
  const result = await examineDesignScreens({...base, intentId: randomUUID(), screens: screens(6), scoreVisual: true,
    worker: failing('EXECUTION_TIMEOUT', calls), reserve: k.reserve, release: k.release});
  assert.equal(calls.length, 3);
  assert.deepEqual(calls, ['examiner', 'examiner', 'examiner']);
  assert.equal(result.stopped, 'EXECUTION_TIMEOUT');
  assert.ok(result.notes.some(note => note.includes('3 falhas seguidas') && note.includes('EXECUTION_TIMEOUT')));
  assert.equal(result.coverage.length, 2);
  assert.equal(result.modelCoverage.examiner.failure, 'EXECUTION_TIMEOUT');
  assert.ok(!k.reserved.some(item => item.endsWith(':visual')));
});

test('disjuntor: lote que falha por infraestrutura não é repetido tela a tela', async () => {
  const k = kit();
  const calls: string[] = [];
  const result = await examineDesignScreens({...base, intentId: randomUUID(), screens: screens(8, false), batch: {tokens: 40_000, files: 8},
    worker: failing('WORKER_EXITED_WITHOUT_RESULT', calls), reserve: k.reserve, release: k.release});
  assert.equal(calls.length, 1);
  assert.equal(result.stopped, null);
  assert.equal(result.coverage.length, 8);
  assert.ok(result.notes.some(note => note.includes('sem nova tentativa')));
});

test('disjuntor: falha de conteúdo não conta e o exame segue até o fim', async () => {
  const k = kit();
  let count = 0;
  const worker: DesignWorker = {async run() { count++; return 'isso não é JSON'; }};
  const result = await examineDesignScreens({...base, intentId: randomUUID(), screens: screens(5, false), worker, reserve: k.reserve, release: k.release});
  assert.equal(count, 5);
  assert.equal(result.stopped, null);
});

test('crítica visual do revisor pulada quando a do examinador não trouxe notas', async () => {
  const k = kit();
  const bench = designBenchWorker();
  const worker: DesignWorker = {async run(call) {
    if (call.designPurpose === 'visual') return JSON.stringify({kind: 'visual', scores: []});
    return bench.run(call);
  }};
  const result = await examineDesignScreens({...base, intentId: randomUUID(), screens: screens(1), scoreVisual: true, worker, reserve: k.reserve, release: k.release});
  assert.equal(k.reserved.filter(item => item === 'specialist:visual').length, 1);
  assert.equal(k.reserved.filter(item => item === 'reviewer:visual').length, 0);
  assert.ok(result.notes.some(note => note.includes('a crítica do revisor não foi pedida')));
});

test('recusa de disco na reserva vira parada com relatório parcial, com uma reserva só', async () => {
  const k = kit('PERSONAL_DISK_FULL');
  const calls: string[] = [];
  const result = await examineDesignScreens({...base, intentId: randomUUID(), screens: screens(4), scoreVisual: true,
    worker: failing('EXECUTION_TIMEOUT', calls), reserve: k.reserve, release: k.release});
  assert.equal(k.reserved.length, 1);
  assert.equal(calls.length, 0);
  assert.equal(result.stopped, 'PERSONAL_DISK_FULL');
  assert.ok(result.notes.some(note => note.includes('espaço em disco')));
});

test('teto de chamadas: economy.maxModelCalls para o exame com relatório parcial', async () => {
  const k = kit();
  let count = 0;
  const bench = designBenchWorker();
  const worker: DesignWorker = {async run(call) { count++; return bench.run(call); }};
  const result = await examineDesignScreens({...base, intentId: randomUUID(), screens: screens(5, false), maxModelCalls: 2,
    worker, reserve: k.reserve, release: k.release});
  assert.equal(count, 2);
  assert.equal(result.stopped, 'EXAM_MODEL_CALL_LIMIT');
  assert.ok(result.notes.some(note => note.includes('economy.maxModelCalls')));
});

test('pré-voo: dependência caída antes de uma chamada para o exame e diz qual', async () => {
  const k = kit();
  let count = 0;
  let checks = 0;
  const bench = designBenchWorker();
  const worker: DesignWorker = {async run(call) { count++; return bench.run(call); }};
  const result = await examineDesignScreens({...base, intentId: randomUUID(), screens: screens(3, false), worker, reserve: k.reserve, release: k.release,
    preflight: async () => { if (++checks > 1) throw new ExamDependencyDown('proxy de saída', 'ac-provider-egress parado'); }});
  assert.equal(count, 1);
  assert.equal(result.stopped, 'EXAM_DEPENDENCY_DOWN');
  assert.ok(result.notes.some(note => note.includes('proxy de saída')));
});

test('andamento: cada tela informa julgados, total, chamadas e o último código', async () => {
  const k = kit();
  const calls: string[] = [];
  const seen: {judged: number; total: number; modelCalls: number; lastFailureCode: string | null; failureStreak: number}[] = [];
  await examineDesignScreens({...base, intentId: randomUUID(), screens: screens(4, false), worker: failing('EXECUTION_TIMEOUT', calls),
    reserve: k.reserve, release: k.release, onProgress: progress => seen.push(progress)});
  assert.ok(seen.length >= 3);
  const last = seen.at(-1)!;
  assert.equal(last.total, 4);
  assert.equal(last.modelCalls, 3);
  assert.equal(last.lastFailureCode, 'EXECUTION_TIMEOUT');
  assert.equal(last.failureStreak, 3);
});

test('ponto alto sem confirmação por falha de infraestrutura: exame parado com relatório, sem exceção', async () => {
  const k = kit();
  const bench = designBenchWorker();
  let reviewerCalls = 0;
  const [one] = screens(1, false);
  const worker: DesignWorker = {async run(call) {
    if (call.designPurpose === 'reviewer') { reviewerCalls++; throw new Refusal('EXECUTION_TIMEOUT'); }
    // The examiner marks the first of three points as high: it is confirmed alone, the other two go in one batch.
    const exam = JSON.parse(await bench.run(call)) as {findings: {severity: string; line: number | null; title: string}[]};
    const first = exam.findings[0];
    if (!first) return JSON.stringify(exam);
    exam.findings = [{...first, severity: 'alta'}, {...first, line: 2, title: 'Segundo ponto'}, {...first, line: 3, title: 'Terceiro ponto'}];
    return JSON.stringify(exam);
  }};
  const rawFindings = [designRawFinding({tool: 'html', rule: 'PONTO-1', file: one!.file, line: 2, severity: 'media', snippet: 'ponto 2'})];
  const result = await examineDesignScreens({...base, intentId: randomUUID(), screens: [one!], batch: {tokens: 40_000, files: 8},
    rawFindings, worker, reserve: k.reserve, release: k.release});
  assert.equal(result.stopped, 'EXECUTION_TIMEOUT');
  assert.ok(reviewerCalls >= 1 && reviewerCalls <= 3, `chamadas do revisor: ${reviewerCalls}`);
  assert.ok(result.notes.some(note => note.includes('O relatório é parcial')));
  assert.equal(result.modelCoverage.reviewer.failure, 'EXECUTION_TIMEOUT');
});
