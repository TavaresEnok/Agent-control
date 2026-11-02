import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { Ledger, type Intent } from '../src/ledger.ts';
import { Command, Refusal, Projection } from '../src/contracts.ts';
import { CezarRuntime } from '../src/cezar.ts';
import { createApi } from '../src/api.ts';
import { provisionCapacity } from './fixtures/provision-capacity.ts';

test('C03/C05/C07/C08: process takeover, actual Cezar DAG, Git, retries and ingress denial', { timeout: 60000 }, async () => {
  const url = process.env.AC_TEST_DATABASE_URL;
  if (!url?.includes('/ac_implementation_test')) throw Error('TEST_DATABASE_REQUIRED');
  const db = new Ledger(url); await db.migrate();
  const project = randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Runtime fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,'owner','owner')", [project]);
  const context = await db.createContext('owner', project, 'happier-' + randomUUID());
  const capacity = await provisionCapacity(db, 'owner', project);
  await capacity.service.assignPolicy('owner', context, capacity.revision);
  await mkdir('.state/projects', { recursive: true });
  const repo = await mkdtemp(resolve('.state/projects/ac-impl-test-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'synthetic@example.invalid'); git('config', 'user.name', 'Synthetic fixture');
  await writeFile(join(repo, 'README.md'), 'Synthetic isolated project\n'); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  await mkdir(join(repo, '.ai/cezar'), { recursive: true });
  await writeFile(join(repo, '.ai/cezar/config.json'), JSON.stringify({ baseBranch: 'main', skillsRepos: [], worktreeRetention: 0 }));
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/manager-lease.ts', context, randomUUID()],
    { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const old = await new Promise<import('../src/contracts.ts').Authority>((resolve, reject) => {
    let output = ''; child.stdout.on('data', b => { output += String(b); if (output.includes('\n')) resolve(JSON.parse(output.trim())); });
    child.once('error', reject); child.once('exit', code => { if (code) reject(Error('MANAGER_FIXTURE_FAILED')); });
  });
  child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve));
  await new Promise(resolve => setTimeout(resolve, 1100));
  const authority = await db.acquire('owner', context, randomUUID(), 'same-profile');
  assert.equal(authority.epoch, old.epoch + 1);
  const runtime = new CezarRuntime(db, repo, project); await runtime.start();
  try {
    const body: Command = { schemaVersion: 1, intentId: randomUUID(), deliveryAttemptId: randomUUID(), contextId: context,
      policyRevision: 1, action: 'plan.start', payload: { workflow: 'baseline-synthetic-v1', messageRef: 'encrypted:fixture' } };
    const intent = await db.accept('owner', body, authority, 'happier');
    const receipt = { operationId: intent.operation_id, base: 'a'.repeat(40), commit: 'b'.repeat(40), tree: 'c'.repeat(40), exitCode: 0, synthetic: true };
    await assert.rejects(runtime.recordReceipt(intent, old, receipt), /STALE_MANAGER/);
    await assert.rejects(runtime.recordReceipt(intent, authority, { ...receipt, operationId: randomUUID() }), /INVALID_SYNTHETIC_RECEIPT/);
    await assert.rejects(runtime.recordReceipt(intent, authority, receipt), /OPERATION_RECEIPT_STALE/);
    assert.equal((await db.pool.query('SELECT state FROM ac_operations WHERE id=$1', [intent.operation_id])).rows[0].state, 'registered');
    await assert.rejects(runtime.dispatch({ ...intent, run_id: randomUUID() }, authority), /INTENT_IDENTITY_MISMATCH/);
    await assert.rejects(runtime.dispatch(intent, old), (e: unknown) => e instanceof Refusal && e.code === 'STALE_MANAGER');
    await runtime.dispatch(intent, authority); await runtime.dispatch(intent, authority);
    let complete = false;
    for (let i = 0; i < 300; i++) {
      const r = runtime.store.getRun(intent.run_id);
      if (r?.status === 'failed') throw Error('CEZAR_RUN_FAILED ' + JSON.stringify(r));
      if (r && ['review', 'done'].includes(r.status)) { complete = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(complete, JSON.stringify(runtime.store.getRun(intent.run_id)));
    assert.equal(runtime.store.listRuns().length, 1);
    const operation = (await db.pool.query('SELECT * FROM ac_operations WHERE id=$1', [intent.operation_id])).rows[0];
    assert.equal(operation.state, 'completed');
    assert.notEqual(operation.receipt.commit, base);
    assert.equal(git('rev-parse', 'main'), base, 'no integration or change to project base');
    const api = createApi(db, runtime, async req => req.headers.get('authorization') === 'Bearer fixture' ? 'owner'
      : req.headers.get('authorization') === 'Bearer outsider' ? 'outsider' : null,
      id => id === context ? authority : undefined);
    const headers = { host: '127.0.0.1', authorization: 'Bearer fixture', 'content-type': 'application/json' };
    for (const path of ['/api/v1/runs', `/api/v1/runs/${intent.run_id}/messages`, '/api/v1/p/project/runs', '/api/v1/mcp', '/api/v1/terminal', '/api/runs']) {
      const response = await api.request(path, { method: 'POST', headers, body: '{}' }); assert.equal(response.status, 403, path);
    }
    assert.equal((await api.request('/api/v1/ac/health')).status, 401);
    const terminalAsset = (await readdir('upstream/cezar/packages/cezar/web/dist/assets')).find(name => /^terminal-.*\.js$/.test(name));
    assert(terminalAsset);
    assert.equal((await api.request('/assets/' + terminalAsset, { headers })).status, 200, 'static terminal component is not a terminal execution endpoint');
    assert.equal((await api.request('/api/v1/ws', { headers: { ...headers, upgrade: 'websocket' } })).status, 403);
    assert.equal((await api.request(`/api/v1/runs/${intent.run_id}`, { headers })).status, 200);
    const event = { schemaVersion: 1 as const, eventId: randomUUID(), contextId: context, runId: intent.run_id,
      planRevision: intent.plan_revision, seq: 1, status: 'done' };
    await assert.rejects(db.event('owner', event, old), (e: unknown) => e instanceof Refusal && e.code === 'STALE_MANAGER');
    await db.event('owner', event, authority);
    const projection = await api.request(`/api/v1/ac/contexts/${context}/events`, { headers });
    assert.equal(projection.status, 200);
    const projected = await projection.json();
    assert.equal(projected.events.length, 1); assert(Projection.safeParse(projected.events[0]).success);
    assert.equal((await api.request(`/api/v1/p/${project}/runs/${intent.run_id}`, { headers })).status, 200);
    assert.equal((await api.request(`/api/v1/p/${randomUUID()}/runs/${intent.run_id}`, { headers })).status, 403);
    assert.equal((await api.request('/api/v1/health', { headers: { ...headers, authorization: 'Bearer outsider' } })).status, 403);
    assert.equal((await api.request('/api/v1/ac/commands', { method: 'POST', headers, body: JSON.stringify({ ...body, principalId: 'forged' }) })).status, 400);
    const retry = await api.request('/api/v1/ac/commands', { method: 'POST', headers,
      body: JSON.stringify({ ...body, deliveryAttemptId: randomUUID() }) });
    assert.equal(retry.status, 202);
    assert.equal((await retry.json()).runId, intent.run_id);
    await db.pause('owner', context, true);
    await assert.rejects(runtime.dispatch(intent, authority), (e: unknown) => e instanceof Refusal && e.code === 'HUMAN_PAUSED');
    await db.pool.query("UPDATE ac_operations SET state='uncertain' WHERE id=$1", [intent.operation_id]);
    // An existing stable run is recognized, never rerun, even if the SQL receipt is uncertain.
    await db.pause('owner', context, false); await runtime.dispatch(intent, authority);
    assert.equal(runtime.store.listRuns().length, 1);
    const unresolved = await db.accept('owner', { ...body, intentId: randomUUID(), deliveryAttemptId: randomUUID() }, authority, 'api');
    await db.pool.query("UPDATE ac_operations SET state='uncertain' WHERE id=$1", [unresolved.operation_id]);
    await assert.rejects(runtime.dispatch(unresolved, authority), (e: unknown) => e instanceof Refusal && e.code === 'OPERATION_UNCERTAIN');
    assert.equal(runtime.store.listRuns().length, 1);
    await assert.rejects(db.pool.query("UPDATE ac_frozen_plans SET snapshot='{}' WHERE intent_id=$1", [intent.id]), /FROZEN_PLAN_IMMUTABLE/);
    const foreignProject = randomUUID();
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [foreignProject, 'Foreign fixture']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,'owner','owner')", [foreignProject]);
    const foreignContext = await db.createContext('owner', foreignProject, randomUUID());
    const foreignAuthority = await db.acquire('owner', foreignContext, randomUUID(), 'manager');
    const foreignIntent = await db.accept('owner', { ...body, contextId: foreignContext, intentId: randomUUID(), deliveryAttemptId: randomUUID() }, foreignAuthority, 'api');
    await assert.rejects(runtime.dispatch(foreignIntent, foreignAuthority), (e: unknown) => e instanceof Refusal && e.code === 'PROJECT_RUNTIME_MISMATCH');
    await writeFile('docs/validation/evidence/runtime-result.json', JSON.stringify({ result: 'passed', project, context,
      intentId: intent.id, runId: intent.run_id, operationId: intent.operation_id, epoch: authority.epoch,
      oldEpoch: old.epoch, base, receipt: operation.receipt, synthetic: true }, null, 2));
  } finally { child.kill('SIGKILL'); await runtime.close(); await db.close(); }
});
