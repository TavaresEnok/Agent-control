import assert from 'node:assert/strict';
import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {planTasksByRun} from '../src/api.ts';
import {containFailure, failureCode, logContainedFailure} from '../src/failure-log.ts';
import type {Ledger} from '../src/ledger.ts';
import {PersonalManagerChat} from '../src/personal-manager-chat.ts';
import {refreshPersonalTemplates} from '../src/personal-policies.ts';

/** Captures the JSON lines written to stderr through console.error. */
function captureErrors(t: TestContext) {
  const lines: unknown[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    const text = String(args[0]);
    try { lines.push(JSON.parse(text)); } catch { lines.push(text); }
  });
  return lines;
}
const dbError = (code: string) => Object.assign(new Error('connection lost near secret-in-message'), {code});

test('failure-log: só o código sai, nunca a mensagem', t => {
  const lines = captureErrors(t);
  assert.equal(failureCode(dbError('57P01')), '57P01');
  assert.equal(failureCode(new TypeError('x')), 'TypeError');
  assert.equal(failureCode('texto'), 'UNKNOWN');
  assert.equal(failureCode({code: 'A B;C'}), 'ABC');
  logContainedFailure('EVENTO', dbError('42P01'));
  logContainedFailure('SEM_ERRO');
  assert.equal(containFailure('OUTRO', 7)(new Error('segredo')), 7);
  assert.deepEqual(lines, [{event: 'EVENTO', code: '42P01'}, {event: 'SEM_ERRO'}, {event: 'OUTRO', code: 'Error'}]);
  assert.ok(!JSON.stringify(lines).includes('secret'), 'a mensagem do erro não vaza');
});

test('planTasksByRun: consulta que falha é registrada e não parece plano sem tarefas em silêncio', async t => {
  const lines = captureErrors(t);
  const ledger = {pool: {query: async () => { throw dbError('57P01'); }}} as unknown as Pick<Ledger, 'pool'>;
  const found = await planTasksByRun(ledger, ['0b6f3a5e-0000-4000-8000-000000000001']);
  assert.equal(found.size, 0);
  assert.deepEqual(lines, [{event: 'PANEL_PLAN_TASKS_UNAVAILABLE', code: '57P01'}]);
});

test('planTasksByRun: consulta que responde continua sem registro', async t => {
  const lines = captureErrors(t);
  const id = '0b6f3a5e-0000-4000-8000-000000000002';
  const ledger = {pool: {query: async () => ({rows: [{run_id: id, tasks: [{id: 'T1', title: 'Primeira'}]}]})}} as unknown as Pick<Ledger, 'pool'>;
  const found = await planTasksByRun(ledger, [id]);
  assert.equal(found.get(id)?.[0]?.id, 'T1');
  assert.deepEqual(lines, []);
});

test('refreshPersonalTemplates: modelo que não atualiza é contado e registrado; os outros seguem', async t => {
  const lines = captureErrors(t);
  const ctx = (n: number) => `0b6f3a5e-0000-4000-8000-00000000001${n}`;
  const ledger = {
    pool: {async query(sql: string) {
      if (sql.includes('max(revision) r FROM ac_quality_policies')) return {rows: [{r: 3}]};
      if (sql.includes('FROM ac_context_templates')) return {rows: [1, 2].map(n => ({context_id: ctx(n), revision: 1, snapshot: {qualityRevision: 2}, published_by: 'owner'}))};
      return {rows: []};
    }},
    tx: async () => { throw dbError('40001'); },
  } as unknown as Ledger;
  assert.deepEqual(await refreshPersonalTemplates(ledger, 'project'), {refreshed: 0, failed: 2});
  assert.equal(lines.length, 2);
  for (const line of lines) assert.equal((line as {event: string}).event, 'PERSONAL_TEMPLATE_REFRESH_FAILED');
});

test('gerente: limite de uso que não se grava no banco é registrado', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ac-contained-docker-'));
  try {
    const docker = join(dir, 'docker');
    await writeFile(docker, '#!/bin/sh\necho "You have hit your usage limit. Try again later." >&2\nexit 1\n');
    await chmod(docker, 0o755);
    const ledger = {pool: {async query(sql: string) {
      if (sql.includes('FROM ac_profiles')) return {rows: [{account_id: 'acc', provider: 'codex', model: 'm', effort: 'medium'}]};
      if (sql.includes('UPDATE ac_accounts SET exhausted_until')) throw dbError('53100');
      return {rows: []};
    }}} as unknown as Ledger;
    const lines = captureErrors(t);
    assert.equal(await new PersonalManagerChat(ledger, {imageId: 'i', accountRoot: '/x', docker}).decide('oi', 'CTX', {measure: false}), null);
    assert.deepEqual(lines.filter(line => (line as {event?: string}).event === 'PROVIDER_EXHAUSTION_NOT_RECORDED'), [{event: 'PROVIDER_EXHAUSTION_NOT_RECORDED', code: '53100'}]);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
