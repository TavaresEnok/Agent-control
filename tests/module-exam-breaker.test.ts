import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Refusal} from '../src/contracts.ts';
import {examineFunctionalModule, examJobExited, type ModuleExamInput, type ModuleExamSeat} from '../src/module-exam.ts';
import {ExamDependencyDown} from '../src/exam-preflight.ts';

const seat = (): ModuleExamSeat => ({provider: 'claude', model: 'claude-sonnet-5-5', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()});
const body = (n: number) => `export const v${n} = ${n};\nexport function f${n}() { return v${n}; }\n`;
const mapOf = (count: number) => ({files: Array.from({length: count}, (_, n) => ({file: `src/m${n}.ts`, code: body(n), reason: null})), routes: []});

function harness(options: {count: number; fail?: string; refuse?: string; batch?: boolean; maxModelCalls?: number; preflight?: () => Promise<void>}) {
  let calls = 0;
  let reservations = 0;
  const progress: Parameters<NonNullable<ModuleExamInput['onProgress']>>[0][] = [];
  const run = async (call: {task: string}) => {
    calls++;
    // The native supervisor proved the job ended: only the breaker stops the exam, not the launched-and-lost rule.
    if (options.fail) throw examJobExited(new Refusal(options.fail));
    const task = JSON.parse(call.task);
    const one = (file: string, binding: string) => ({kind: 'exame', binding, filesRead: [file], checklist: ['qa'], routesReviewed: [], findings: []});
    if (task.files) return JSON.stringify({kind: 'exame-lote', results: task.files.map((f: {file: string; binding: string}) => one(f.file, f.binding))});
    return JSON.stringify(one(task.file, task.binding));
  };
  const input: ModuleExamInput = {module: 'qa', intentId: randomUUID(), map: mapOf(options.count), findings: [], commit: 'a'.repeat(40),
    ...(options.batch === false ? {} : {batch: {tokens: 40_000, files: 20}}),
    ...(options.maxModelCalls !== undefined ? {maxModelCalls: options.maxModelCalls} : {}),
    ...(options.preflight ? {preflight: options.preflight} : {}),
    scope: false,
    onProgress: item => progress.push(item),
    reserve: async () => { reservations++; if (options.refuse) throw new Refusal(options.refuse); return seat(); },
    release: async () => {}, worker: {run: run as never}};
  return {input, progress, get calls() { return calls; }, get reservations() { return reservations; }};
}

test('lote de 20 com falha de infraestrutura: no máximo 3 chamadas e exame parado', async () => {
  const h = harness({count: 20, fail: 'EXECUTION_TIMEOUT', batch: false});
  const result = await examineFunctionalModule(h.input);
  assert.equal(h.calls, 3);
  assert.equal(result.stopped, 'EXECUTION_TIMEOUT');
  assert.ok(result.notes.some(note => note.includes('3 falhas seguidas')));
  assert.equal(result.coverage.filter(row => row.status === 'lido').length, 0);
  const last = h.progress.at(-1)!;
  assert.equal(last.lastFailureCode, 'EXECUTION_TIMEOUT');
  assert.equal(last.failureStreak, 3);
  assert.equal(last.total, 20);
});

test('lote inteiro que falha por infraestrutura não vira metades nem chamadas sozinhas', async () => {
  const h = harness({count: 20, fail: 'WORKER_EXITED_WITHOUT_RESULT'});
  const result = await examineFunctionalModule(h.input);
  assert.ok(h.calls <= 3, `chamadas: ${h.calls}`);
  assert.equal(h.calls, 1);
  assert.ok(result.coverage.every(row => row.reason === 'WORKER_EXITED_WITHOUT_RESULT'));
});

test('recusa de disco na reserva: uma reserva só e o exame para', async () => {
  for (const code of ['PERSONAL_DISK_FULL', 'PERSONAL_DISK_UNAVAILABLE', 'STORAGE_LOW_SPACE']) {
    const h = harness({count: 20, refuse: code});
    const result = await examineFunctionalModule(h.input);
    assert.equal(h.reservations, 1, code);
    assert.equal(h.calls, 0);
    assert.equal(result.stopped, code);
  }
});

test('teto de chamadas: economy.maxModelCalls para o exame com relatório parcial', async () => {
  const h = harness({count: 6, batch: false, maxModelCalls: 4});
  const result = await examineFunctionalModule(h.input);
  assert.equal(h.calls, 4);
  assert.equal(result.stopped, 'EXAM_MODEL_CALL_LIMIT');
  assert.equal(result.coverage.filter(row => row.status === 'lido').length, 4);
  assert.ok(result.notes.some(note => note.includes('economy.maxModelCalls')));
});

test('pré-voo com o proxy de saída parado recusa antes de reservar', async () => {
  const h = harness({count: 5, preflight: async () => { throw new ExamDependencyDown('proxy de saída', 'ac-provider-egress parado'); }});
  const result = await examineFunctionalModule(h.input);
  assert.equal(h.reservations, 0);
  assert.equal(h.calls, 0);
  assert.equal(result.stopped, 'EXAM_DEPENDENCY_DOWN');
});

test('sem falha o exame segue inteiro, sem parada', async () => {
  const h = harness({count: 5, batch: false});
  const result = await examineFunctionalModule(h.input);
  assert.equal(h.calls, 5);
  assert.equal(result.stopped, null);
  assert.equal(h.progress.at(-1)!.judged, 5);
});
