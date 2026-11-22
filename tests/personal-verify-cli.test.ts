import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {Refusal, type Authority} from '../src/contracts.ts';
import type {Ledger} from '../src/ledger.ts';
import {abortPersonalVerifyForLeaseLoss, keepPersonalVerifyLease, releasePersonalVerifyLease, runPersonalVerifySession, verifyCliFailureText} from '../src/personal-verify-cli.ts';
import {createCapacityNativeWorker, type SecurityExamSupervisor} from '../src/verify-native-launch.ts';
import type {VerifyWorkerCall} from '../src/verify-types.ts';

const heartbeatInterval = 20;

test('encerrar a locação ignora a terceira falha pendente e cancela os próximos heartbeats', async ({mock}) => {
  mock.timers.enable({apis: ['setInterval']});
  let rejectHeartbeat!: (error: Error) => void;
  const pending = new Promise<void>((_, reject) => { rejectHeartbeat = reject; });
  const heartbeat = mock.fn(() => Promise.reject<void>(new Error('lease ocupada')));
  heartbeat.mock.mockImplementationOnce(() => pending, 2);
  const onAbort = mock.fn();
  const stop = keepPersonalVerifyLease({heartbeat}, {contextId: 'contexto'}, heartbeatInterval, onAbort);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      mock.timers.tick(heartbeatInterval);
      await setImmediate();
    }
    assert.equal(heartbeat.mock.callCount(), 3);
    assert.equal(onAbort.mock.callCount(), 0);

    stop();
    rejectHeartbeat(new Error('lease ocupada'));
    await setImmediate();
    assert.equal(onAbort.mock.callCount(), 0);

    mock.timers.tick(heartbeatInterval);
    assert.equal(heartbeat.mock.callCount(), 3);
  } finally {
    stop();
  }
});

test('três falhas seguidas de renovação abortam uma vez e as falhas seguintes mantêm uma chamada', async ({mock}) => {
  mock.timers.enable({apis: ['setInterval']});
  const heartbeat = mock.fn(async () => { throw new Error('lease ocupada'); });
  const onAbort = mock.fn();
  const stop = keepPersonalVerifyLease({heartbeat}, {contextId: 'contexto'}, heartbeatInterval, onAbort);
  try {
    for (const [index, expectedAborts] of [0, 0, 1, 1, 1].entries()) {
      mock.timers.tick(heartbeatInterval);
      await setImmediate();
      assert.equal(heartbeat.mock.callCount(), index + 1);
      assert.equal(onAbort.mock.callCount(), expectedAborts);
    }
  } finally {
    stop();
  }
});

test('o heartbeat aguarda o sucesso pendente e zera a série de falhas antes de renovar de novo', async ({mock}) => {
  mock.timers.enable({apis: ['setInterval']});
  let resolveHeartbeat!: () => void;
  const pending = new Promise<void>(resolve => { resolveHeartbeat = resolve; });
  const heartbeat = mock.fn(() => Promise.reject<void>(new Error('lease ocupada')));
  heartbeat.mock.mockImplementationOnce(() => pending, 2);
  const onAbort = mock.fn();
  const stop = keepPersonalVerifyLease({heartbeat}, {contextId: 'contexto'}, heartbeatInterval, onAbort);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      mock.timers.tick(heartbeatInterval);
      await setImmediate();
    }
    assert.equal(heartbeat.mock.callCount(), 3);

    for (let tick = 0; tick < 2; tick += 1) {
      mock.timers.tick(heartbeatInterval);
      await setImmediate();
    }
    assert.equal(heartbeat.mock.callCount(), 3);
    assert.equal(onAbort.mock.callCount(), 0);

    resolveHeartbeat();
    await setImmediate();
    for (let attempt = 4; attempt <= 5; attempt += 1) {
      mock.timers.tick(heartbeatInterval);
      await setImmediate();
      assert.equal(heartbeat.mock.callCount(), attempt);
      assert.equal(onAbort.mock.callCount(), 0);
    }
  } finally {
    stop();
    resolveHeartbeat();
  }
});

test('soltar a locação zera lease_until filtrando contexto, instância e época', async () => {
  const seen: {sql: string; params: readonly unknown[] | undefined}[] = [];
  const authority = {contextId: 'contexto', instanceId: 'instancia', epoch: 4};
  await releasePersonalVerifyLease({
    pool: {
      async query(sql: string, params?: readonly unknown[]) {
        seen.push({sql, params});
      },
    },
  }, authority);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sql, 'UPDATE ac_managers SET lease_until = clock_timestamp() WHERE context_id=$1 AND instance_id=$2 AND epoch=$3');
  assert.deepEqual(seen[0].params, [authority.contextId, authority.instanceId, authority.epoch]);
  await assert.rejects(
    releasePersonalVerifyLease({
      pool: {async query() { throw new Error('db fora'); }},
    }, authority),
    /db fora/,
  );
});

test('perder a locação pede stop e rejeita com VERIFY_LEASE_LOST quando stop falha', async ({mock}) => {
  mock.timers.enable({apis: ['setInterval']});
  const accountId = randomUUID();
  const asked: VerifyWorkerCall = {
    role: 'specialist',
    provider: 'grok',
    accountId,
    profileId: randomUUID(),
    model: 'fixture-model',
    grantId: randomUUID(),
    intentId: randomUUID(),
    task: 'Pedido de exame.',
    repo: '/tmp/repo-leitura',
    writePaths: [],
  };
  const authority: Authority = {contextId: randomUUID(), instanceId: randomUUID(), epoch: 1};
  let started!: () => void;
  const startedGate = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stoppedJobs: string[] = [];
  let seenJob = '';
  const chosen: SecurityExamSupervisor = {
    active: true,
    supportsAccount(id) { return id === accountId; },
    async start(_principal, _authority, request) {
      seenJob = request.jobId;
      started();
      return {state: 'running'};
    },
    async reconcile() {
      await gate;
      return {state: 'completed', output: 'ok'};
    },
    async retireTerminal() {
      return {state: 'removed'};
    },
    async stop(_principal, _authority, request) {
      stoppedJobs.push(request.jobId);
      throw new Error('stop-broke');
    },
  };
  const worker = createCapacityNativeWorker({
    supervisors: [chosen],
    principal: 'owner',
    authority,
    ledger: {} as Ledger,
    base: 'a'.repeat(40),
    wait: async () => {},
  });
  const pending = worker.run(asked);
  await startedGate;
  const stop = worker.stop;
  if (!stop) throw new Error('stop ausente');
  let rejectAbort!: (error: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  void aborted.catch(() => undefined);
  const reject = mock.fn(rejectAbort);
  let aborting: Promise<void> | undefined;
  const heartbeat = mock.fn(async () => { throw new Error('lease ocupada'); });
  const stopLease = keepPersonalVerifyLease({heartbeat}, authority, heartbeatInterval, () => {
    aborting = abortPersonalVerifyForLeaseLoss({stopLease, stopJob: stop, rejectAbort: reject});
  });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      mock.timers.tick(heartbeatInterval);
      await setImmediate();
    }
    assert.ok(aborting);
    await aborting;
    assert.equal(reject.mock.callCount(), 1);
    await assert.rejects(aborted, (error: unknown) =>
      error instanceof Refusal && error.code === 'VERIFY_LEASE_LOST');
    mock.timers.tick(heartbeatInterval);
    assert.equal(heartbeat.mock.callCount(), 3);
    assert.deepEqual(stoppedJobs, [seenJob]);
  } finally {
    stopLease();
    release();
  }
  assert.equal(await pending, 'ok');
});

test('DESIGN_REVIEWER_UNAVAILABLE no validador orienta rodar preparar --aplicar', () => {
  const text = verifyCliFailureText(new Refusal('DESIGN_REVIEWER_UNAVAILABLE', 409));
  assert.match(text, /npm run personal:design -- preparar .*--aplicar/);
});

test('VERIFY_RECHECK_NEW_EXAM_REQUIRED orienta novo exame de segurança', () => {
  const text = verifyCliFailureText(new Refusal('VERIFY_RECHECK_NEW_EXAM_REQUIRED', 409));
  assert.match(text, /novo exame de segurança/i);
});

test('exame com arquivo sem julgamento: a CLI diz incompleta e recusa com VERIFY_EXAM_INCOMPLETE sem marcar a execução como falha', async ({mock}) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ac-verify-cli-'));
  const projectId = randomUUID();
  const authority: Authority = {contextId: randomUUID(), instanceId: randomUUID(), epoch: 1};
  const queries: string[] = [];
  const ledger = {heartbeat: async () => {}, pool: {query: async (sql: string) => { queries.push(sql); return {rows: [], rowCount: 0}; }}};
  const lines: string[] = [];
  mock.method(console, 'log', (line: string) => { lines.push(line); });
  try {
    const session = (status: string) => {
      const id = randomUUID();
      const begin = (async (input: {observe?: (job: Promise<void>) => void}) => {
        const folder = join(dataDirectory, 'verificacoes', projectId, 'andamento');
        await mkdir(folder, {recursive: true});
        await writeFile(join(folder, `${id}.json`), JSON.stringify({id, status, phase: 'done', startedAt: new Date().toISOString(), judged: 3, total: 5, pending: 2}));
        input.observe?.(Promise.resolve());
        return {id, status: 'running' as const, phase: 'ferramentas'};
      }) as never;
      const resolved = {input: {ledger, authority, worker: {run: async () => ''}, dataDirectory, projectId}, close: async () => {}} as never;
      return {id, run: runPersonalVerifySession(resolved, {begin})};
    };
    const incomplete = session('incomplete');
    await assert.rejects(incomplete.run, (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_EXAM_INCOMPLETE');
    assert.ok(lines.includes(`Verificação ${incomplete.id} incompleta: 2 de 5 arquivos sem julgamento.`));
    assert.equal(lines.some(line => line.includes('concluída')), false);
    assert.equal(queries.some(sql => sql.includes("status='failed'")), false, 'a execução e a intenção seguem como terminadas');
    assert.match(verifyCliFailureText(new Refusal('VERIFY_EXAM_INCOMPLETE')), /terminou incompleta/);
    const done = session('done');
    assert.equal(await done.run, done.id);
    assert.ok(lines.includes(`Verificação ${done.id} concluída.`));
  } finally {
    await rm(dataDirectory, {recursive: true, force: true});
  }
});
