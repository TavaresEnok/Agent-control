import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {examineFunctionalModule, moduleExamReadBinding, type ModuleExamInput, type ModuleExamSeat} from '../src/module-exam.ts';

const seat = (): ModuleExamSeat => ({provider: 'claude', model: 'claude-sonnet-5-5', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()});
const intentId = randomUUID();
const names = ['a', 'b', 'c'].map(n => `src/${n}.ts`);
const body = (n: string) => `export const ${n} = 1;\nexport function f${n}() { return ${n}; }\n`;
const mapOf = (files: {file: string; code: string}[]) => ({files: files.map(f => ({...f, reason: null})), routes: []});
const small = mapOf(names.map(file => ({file, code: body(file.slice(4, 5))})));

type Seen = {task: any};
function harness(opts: {batch?: ModuleExamInput['batch']; invalid?: string; high?: string; map?: ReturnType<typeof mapOf>}) {
  const calls: Seen[] = [];
  const sessions: (string | undefined)[] = [];
  const respond = (task: any, file: string) => ({kind: 'exame', binding: task.binding, filesRead: [file], checklist: ['qa'], routesReviewed: [],
    findings: opts.high === file ? [{line: 1, snippet: body(file.slice(4, 5)).split('\n')[0], title: 'x', hypothesis: 'Existe problema?', severity: 'alta'}] : []});
  const run = async (call: any) => {
    const task = JSON.parse(call.task);
    calls.push({task});
    sessions.push(call.examSubject);
    if (task.files) {
      return JSON.stringify({kind: 'exame-lote', results: task.files.map((f: any) =>
        f.file === opts.invalid ? {kind: 'exame', binding: 'ruim'} : respond({binding: f.binding}, f.file))});
    }
    return JSON.stringify(respond(task, task.file));
  };
  const input = (): ModuleExamInput => ({module: 'qa', intentId, map: opts.map ?? small, findings: [], commit: 'a'.repeat(40),
    ...(opts.batch ? {batch: opts.batch} : {}),
    reserve: async () => seat(), release: async () => {}, worker: {run}});
  return {calls, sessions, input};
}
const inputTokens = (calls: Seen[]) => calls.reduce((n, c) => n + Math.ceil(JSON.stringify(c.task).length / 4), 0);

test('lote válido: uma chamada, recibo e cobertura por arquivo', async () => {
  const h = harness({batch: {tokens: 40_000, files: 8}});
  const result = await examineFunctionalModule(h.input());
  assert.equal(h.calls.length, 1);
  assert.deepEqual(result.coverage.map(r => r.status), ['lido', 'lido', 'lido']);
  const requestIds = new Set(result.coverage.map(r => r.read!.requestId));
  assert.equal(requestIds.size, 3);
  for (const [i, row] of result.coverage.entries()) {
    assert.equal(row.read!.binding, moduleExamReadBinding(row, {module: 'qa', intentId, commit: 'a'.repeat(40)}, names[i]!, small.files[i]!.code));
    assert.equal(row.examiner?.sessionId, undefined);
  }
});

test('lote com uma resposta inválida: só esse arquivo repete sozinho', async () => {
  const h = harness({batch: {tokens: 40_000, files: 8}, invalid: names[1]});
  const result = await examineFunctionalModule(h.input());
  assert.deepEqual(result.coverage.map(r => r.status), ['lido', 'lido', 'lido']);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1]!.task.file, names[1]);
  assert.ok(h.sessions[1], 'a nova tentativa mantém o vínculo de sessão por arquivo');
});

test('achado alto sai do lote e roda sozinho com sessão por arquivo', async () => {
  const h = harness({batch: {tokens: 40_000, files: 8}, high: names[2]});
  const result = await examineFunctionalModule(h.input());
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1]!.task.file, names[2]);
  assert.ok(h.sessions[1]);
  assert.deepEqual(result.coverage.map(r => r.status), ['lido', 'lido', 'lido']);
});

test('arquivo grande fica isolado e o limite de arquivos fecha o lote', async () => {
  const big = mapOf([{file: 'src/a.ts', code: body('a')}, {file: 'src/big.ts', code: 'x\n'.repeat(3000)}, {file: 'src/c.ts', code: body('c')}, {file: 'src/d.ts', code: body('d')}]);
  const h = harness({batch: {tokens: 1500, files: 8}, map: big});
  const result = await examineFunctionalModule(h.input());
  assert.deepEqual(h.calls.map(c => c.task.files ? c.task.files.length : 1), [1, 1, 2]);
  assert.ok(result.coverage.every(r => r.status === 'lido'));
  const h2 = harness({batch: {tokens: 40_000, files: 2}});
  await examineFunctionalModule(h2.input());
  assert.deepEqual(h2.calls.map(c => c.task.files ? c.task.files.length : 1), [2, 1]);
});

test('lote desligado: uma chamada por arquivo, como antes', async () => {
  const h = harness({});
  const result = await examineFunctionalModule(h.input());
  assert.equal(h.calls.length, 3);
  assert.ok(h.calls.every(c => !c.task.files && h.sessions.every(Boolean)));
  assert.ok(result.coverage.every(r => r.status === 'lido'));
});

test('medição: chamadas e tokens de entrada com e sem lote numa fixture de 8 arquivos', async () => {
  const files = Array.from({length: 8}, (_, i) => ({file: `src/m${i}.ts`, code: body(`m${i}`)}));
  const fx = mapOf(files);
  const off = harness({map: fx}); await examineFunctionalModule(off.input());
  const on = harness({map: fx, batch: {tokens: 40_000, files: 8}}); await examineFunctionalModule(on.input());
  const off_ = {calls: off.calls.length, tokens: inputTokens(off.calls)};
  const on_ = {calls: on.calls.length, tokens: inputTokens(on.calls)};
  console.log(`MEDICAO sem lote: ${off_.calls} chamadas, ${off_.tokens} tokens; com lote: ${on_.calls} chamadas, ${on_.tokens} tokens`);
  assert.equal(off_.calls, 8);
  assert.equal(on_.calls, 1);
  assert.ok(on_.tokens < off_.tokens);
});
