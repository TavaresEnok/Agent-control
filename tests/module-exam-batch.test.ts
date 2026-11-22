import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Refusal} from '../src/contracts.ts';
import {DEFAULT_MODULE_EXAM_BATCH, examineFunctionalModule, examJobExited, MODULE_EXAM_BATCH_FINDINGS, moduleExamReadBinding, type ModuleExamInput, type ModuleExamSeat} from '../src/module-exam.ts';
import {UnstartedExamRetirementPending} from '../src/native-execution-shared.ts';

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

test('padrão de 20 arquivos: pequenos juntam num lote e o arquivo seguinte fica sozinho', async () => {
  assert.deepEqual(DEFAULT_MODULE_EXAM_BATCH, {tokens: 40_000, files: 20});
  // 20 arquivos de cerca de 1 kB e um de 15 kB depois deles.
  const kb = (n: string) => `export const ${n} = ${JSON.stringify('x'.repeat(980))};\n`;
  const many = [...Array.from({length: 20}, (_, i) => ({file: `src/p${i}.ts`, code: kb(`p${i}`)})),
    {file: 'src/grande.ts', code: `export const g = ${JSON.stringify('y'.repeat(15_000))};\n`}];
  const h = harness({batch: DEFAULT_MODULE_EXAM_BATCH, map: mapOf(many)});
  const result = await examineFunctionalModule(h.input());
  assert.deepEqual(h.calls.map(c => c.task.files ? c.task.files.length : 1), [20, 1]);
  assert.equal(h.calls[1]!.task.file, 'src/grande.ts');
  assert.ok(result.coverage.every(r => r.status === 'lido'));
});

test('a instrução conta uma vez por lote: o orçamento cabe mais arquivos do que a soma dos pedidos isolados', async () => {
  const files = Array.from({length: 6}, (_, i) => ({file: `src/t${i}.ts`, code: body(`t${i}`)}));
  const alone = harness({map: mapOf(files)});
  await examineFunctionalModule(alone.input());
  const single = Math.max(...alone.calls.map(c => Math.ceil(JSON.stringify(c.task).length / 4)));
  // Six isolated requests would not fit; one shared instruction plus six files does.
  const h = harness({batch: {tokens: single * 3, files: 20}, map: mapOf(files)});
  await examineFunctionalModule(h.input());
  assert.deepEqual(h.calls.map(c => c.task.files ? c.task.files.length : 1), [6]);
  assert.match(h.calls[0]!.task.instruction, new RegExp(`no máximo ${MODULE_EXAM_BATCH_FINDINGS} achados`));
});

function failing(first: (task: any) => Promise<string> | string) {
  const calls: any[] = [];
  const run = async (call: any) => {
    const task = JSON.parse(call.task);
    calls.push(task);
    if (calls.length === 1) return first(task);
    const answer = (file: string, binding: string) => ({kind: 'exame', binding, filesRead: [file], checklist: ['qa'], routesReviewed: [], findings: []});
    return JSON.stringify(task.files
      ? {kind: 'exame-lote', results: task.files.map((f: any) => answer(f.file, f.binding))}
      : answer(task.file, task.binding));
  };
  const six = mapOf(Array.from({length: 6}, (_, i) => ({file: `src/f${i}.ts`, code: body(`f${i}`)})));
  const input = (): ModuleExamInput => ({module: 'qa', intentId, map: six, findings: [], commit: 'a'.repeat(40),
    batch: {tokens: 40_000, files: 20}, reserve: async () => seat(), release: async () => {}, worker: {run}});
  return {calls, input};
}
const sizes = (calls: any[]) => calls.map(task => task.files ? task.files.length : 1);

test('lote que falha inteiro repete em duas metades antes de ir arquivo por arquivo', async () => {
  const h = failing(() => JSON.stringify({kind: 'outra-coisa'}));
  const result = await examineFunctionalModule(h.input());
  assert.deepEqual(sizes(h.calls), [6, 3, 3]);
  assert.ok(result.coverage.every(r => r.status === 'lido'));
  assert.ok(result.notes.some(note => /1 lote\(s\) repetido\(s\) em duas metades/.test(note)));
  assert.equal(result.stopped, null);
});

test('resposta de lote acima do teto de achados conta como falha do lote inteiro', async () => {
  const h = failing(task => JSON.stringify({kind: 'exame-lote', results: task.files.map((f: any, i: number) => ({kind: 'exame', binding: f.binding,
    filesRead: [f.file], checklist: ['qa'], routesReviewed: [],
    findings: Array.from({length: i < 4 ? 20 : 0}, () => ({line: 1, snippet: 'export', title: 't', hypothesis: 'Existe?', severity: 'baixa'}))}))}));
  const result = await examineFunctionalModule(h.input());
  assert.deepEqual(sizes(h.calls), [6, 3, 3]);
  assert.equal(result.findings.length, 0);
});

test('job terminado com falha devolve o lote às novas tentativas; sem prova de término o exame para', async () => {
  const exited = failing(() => { throw examJobExited(new Refusal('MODULE_EXAM_PROVIDER_FAILED')); });
  const ok = await examineFunctionalModule(exited.input());
  assert.deepEqual(sizes(exited.calls), [6, 3, 3]);
  assert.ok(ok.coverage.every(r => r.status === 'lido'));
  assert.equal(ok.stopped, null);
  assert.equal(ok.unjudgedByFailure, 0);

  const unproven = failing(() => { throw new Refusal('MODULE_EXAM_PROVIDER_FAILED'); });
  const stopped = await examineFunctionalModule(unproven.input());
  assert.deepEqual(sizes(unproven.calls), [6]);
  assert.equal(stopped.stopped, 'MODULE_EXAM_PROVIDER_FAILED');
  assert.equal(stopped.unjudgedByFailure, 6);
  assert.equal(stopped.mode, 'somente_ferramentas');
});

test('login vencido no primeiro lote para o exame e o resultado diz o código', async () => {
  const h = failing(() => { throw examJobExited(new Refusal('EXAM_LOGIN_STALE')); });
  const result = await examineFunctionalModule(h.input());
  assert.equal(h.calls.length, 1);
  assert.equal(result.stopped, 'EXAM_LOGIN_STALE');
  assert.ok(result.coverage.every(r => r.reason === 'EXAM_LOGIN_STALE'));
  assert.ok(result.notes.includes('Login da conta Claude da instalação vencido; renove e rode de novo.'));
});

test('partida pendente de acerto encerra o exame do módulo', async () => {
  const h = failing(() => { throw new UnstartedExamRetirementPending(randomUUID()); });
  await assert.rejects(examineFunctionalModule(h.input()),
    (error: unknown) => error instanceof Refusal && error.code === 'NATIVE_PRELAUNCH_SETTLEMENT_PENDING');
});
