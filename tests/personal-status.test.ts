import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseStatusArgs, processStartedAt, runPersonalStatus} from '../src/personal-status-cli.ts';
import {readVerificationProgress, writeExamProgress, type ExamProgressState} from '../src/verify-command.ts';

const projectId = '00000000-0000-4000-8000-0000000000a1';
const runA = 'aaaaaaaa-0000-4000-8000-000000000001';
const runB = 'bbbbbbbb-0000-4000-8000-000000000002';
const DEAD_PID = 2 ** 22 + 7;

async function setup(t: {after: (fn: () => Promise<void>) => void}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ac-status-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  return {root, load: async () => ({dataDirectory: root, projects: [{id: projectId, label: 'chatisp'}]}), startedAt: () => null};
}

const running = (id: string, extra: Partial<ExamProgressState> = {}): ExamProgressState => ({
  id, status: 'running', phase: 'exame', startedAt: new Date(Date.parse('2026-11-28T10:00:00Z')).toISOString(),
  module: 'design', pid: process.pid, argv: ['node', 'src/personal-design-cli.ts'], judged: 4, total: 10, modelCalls: 6,
  lastFailureCode: 'EXECUTION_TIMEOUT', failureStreak: 2, ...extra,
});
const now = () => Date.parse('2026-11-28T10:08:00Z');

test('estado: fase, julgados, chamadas, último código, média e previsão de fim', async t => {
  const {root, load, startedAt} = await setup(t);
  await writeExamProgress(root, projectId, running(runA));
  const outcome = await runPersonalStatus(['inst.json', '--json'], {load, now, startedAt});
  assert.equal(outcome.code, 0);
  const row = outcome.rows[0]!;
  assert.equal(row.state, 'em-andamento');
  assert.equal(row.module, 'design');
  assert.equal(row.judged, 4);
  assert.equal(row.modelCalls, 6);
  assert.equal(row.lastFailureCode, 'EXECUTION_TIMEOUT');
  assert.equal(row.failureStreak, 2);
  assert.equal(row.msPerJob, 120_000);
  assert.equal(row.etaAt, '2026-11-28T10:20:00.000Z');
  assert.equal(row.pid, process.pid);
  assert.match(outcome.lines[0]!, /julgados 4\/10, chamadas 6, último código EXECUTION_TIMEOUT \(2x seguidas\)/);
  assert.deepEqual(JSON.parse(outcome.json!).exames[0].runId, runA);
});

test('PID morto sem resultado aparece como abandonado', async t => {
  const {root, load, startedAt} = await setup(t);
  await writeExamProgress(root, projectId, running(runA, {pid: DEAD_PID}));
  const outcome = await runPersonalStatus(['inst.json'], {load, now, startedAt});
  assert.equal(outcome.rows[0]!.state, 'abandonado');
  assert.match(outcome.lines[0]!, /abandonado/);
  // --esperar não espera um abandonado: sai 2 na hora
  const waited = await runPersonalStatus(['inst.json', runA, '--esperar'], {load, now, startedAt, sleep: async () => assert.fail('não devia esperar')});
  assert.equal(waited.code, 2);
});

test('--esperar com tempo esgotado sai 3, com espera crescente e sem pgrep', async t => {
  const {root, load, startedAt} = await setup(t);
  await writeExamProgress(root, projectId, running(runA));
  let clock = now();
  const waits: number[] = [];
  const outcome = await runPersonalStatus(['inst.json', '--esperar', '--ate', '1'], {load, startedAt, now: () => clock,
    sleep: async ms => { waits.push(ms); clock += ms; }});
  assert.equal(outcome.code, 3);
  assert.ok(waits.length >= 2);
  assert.ok(waits[1]! > waits[0]!, `espera crescente: ${waits.join(',')}`);
  assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 60_000);
  assert.match(outcome.lines.at(-1)!, /Tempo de espera esgotado/);
});

test('--esperar termina quando o exame termina: 0 concluído, 2 parado', async t => {
  const {root, load, startedAt} = await setup(t);
  await writeExamProgress(root, projectId, running(runA));
  await writeExamProgress(root, projectId, running(runB));
  let step = 0;
  const finish = (status: 'done' | 'stopped') => async () => {
    step++;
    if (step === 2) await writeExamProgress(root, projectId, {...running(runA), status, phase: status});
  };
  const done = await runPersonalStatus(['inst.json', runA, '--esperar'], {load, now, startedAt, sleep: finish('done')});
  assert.equal(done.code, 0);
  assert.equal(done.rows[0]!.state, 'concluido');
  step = 0;
  await writeExamProgress(root, projectId, running(runA));
  const stopped = await runPersonalStatus(['inst.json', runA, '--esperar'], {load, now, startedAt, sleep: finish('stopped')});
  assert.equal(stopped.code, 2);
  assert.equal(stopped.rows[0]!.state, 'parado');
});

test('o andamento do design não aparece como andamento da segurança', async t => {
  const {root} = await setup(t);
  await writeExamProgress(root, projectId, running(runA));
  assert.deepEqual(await readVerificationProgress(root, projectId), []);
  assert.equal((await readVerificationProgress(root, projectId, {all: true}))[0]!.module, 'design');
});

test('argumentos: --ate só com --esperar e projeto ou execução desconhecidos recusam', async t => {
  assert.throws(() => parseStatusArgs(['inst.json', '--ate', '5']), /STATUS_USAGE/);
  assert.throws(() => parseStatusArgs([]), /STATUS_USAGE/);
  assert.equal(parseStatusArgs(['inst.json', 'x', '--esperar', '--ate', '5']).untilMinutes, 5);
  const {load, startedAt} = await setup(t);
  await assert.rejects(runPersonalStatus(['inst.json', 'nenhum'], {load, now, startedAt}), /NOT_FOUND/);
  await assert.rejects(runPersonalStatus(['inst.json', 'cccccccc-0000-4000-8000-000000000003'], {load, now, startedAt}), /NOT_FOUND/);
});

test('PID vivo que começou depois do exame é outro processo: abandonado, e --esperar sai 2', async t => {
  const {root, load} = await setup(t);
  await writeExamProgress(root, projectId, running(runA));
  const later = () => Date.parse('2026-11-28T11:00:00Z');
  const outcome = await runPersonalStatus(['inst.json', runA, '--esperar'], {load, now, startedAt: later, sleep: async () => assert.fail('não devia esperar')});
  assert.equal(outcome.rows[0]!.state, 'abandonado');
  assert.equal(outcome.code, 2);
  // The real reading of this process: it started before now and after the machine booted.
  const own = processStartedAt(process.pid);
  if (own !== null) assert.ok(own <= Date.now() + 1_000 && own >= Date.now() - process.uptime() * 1000 - 5_000, `início lido: ${own}`);
});

test('--esperar antes do arquivo existir não sai 0: espera o exame aparecer e segue até o fim', async t => {
  const {root, load, startedAt} = await setup(t);
  // A past run of the project is not what is waited for.
  await writeExamProgress(root, projectId, {...running(runB), status: 'done', phase: 'done'});
  let step = 0;
  const sleep = async () => {
    step++;
    if (step === 2) await writeExamProgress(root, projectId, running(runA));
    if (step === 4) await writeExamProgress(root, projectId, {...running(runA), status: 'stopped', phase: 'stopped'});
  };
  const outcome = await runPersonalStatus(['inst.json', 'chatisp', '--esperar'], {load, now, startedAt, sleep});
  assert.equal(outcome.code, 2);
  assert.deepEqual(outcome.rows.map(row => [row.runId, row.state]), [[runA, 'parado']]);
  // The run named before its file exists is waited for too, not refused.
  step = 0;
  const named = 'dddddddd-0000-4000-8000-000000000004';
  const byRun = await runPersonalStatus(['inst.json', named, '--esperar'], {load, now, startedAt, sleep: async () => {
    step++;
    if (step === 2) await writeExamProgress(root, projectId, {...running(named), status: 'done', phase: 'done'});
  }});
  assert.equal(byRun.code, 0);
  assert.equal(byRun.rows[0]!.runId, named);
});

test('--esperar sem nenhum exame no prazo sai 3, nunca 0', async t => {
  const {load, startedAt} = await setup(t);
  let clock = now();
  const outcome = await runPersonalStatus(['inst.json', '--esperar', '--ate', '1'], {load, startedAt, now: () => clock, sleep: async ms => { clock += ms; }});
  assert.equal(outcome.code, 3);
  assert.match(outcome.lines[0]!, /Nenhum exame apareceu/);
});
