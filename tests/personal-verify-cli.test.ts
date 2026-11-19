import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Refusal, type Authority} from '../src/contracts.ts';
import type {Ledger} from '../src/ledger.ts';
import {abortPersonalVerifyForLeaseLoss, keepPersonalVerifyLease, releasePersonalVerifyLease, verifyCliFailureText} from '../src/personal-verify-cli.ts';
import {createCapacityNativeWorker, type SecurityExamSupervisor} from '../src/verify-native-launch.ts';
import type {VerifyWorkerCall} from '../src/verify-types.ts';

async function until(done: () => boolean) {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > 1000) throw new Error('a renovação não aconteceu a tempo');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('a locação do comando é renovada enquanto o exame corre e um erro de renovação não derruba o processo', async () => {
  let beats = 0;
  let markSecondHeartbeat!: () => void;
  const secondHeartbeat = new Promise<void>(resolve => { markSecondHeartbeat = resolve; });
  const stop = keepPersonalVerifyLease({
    async heartbeat() {
      beats += 1;
      if (beats === 1) throw new Error('lease ocupada');
      if (beats === 2) markSecondHeartbeat();
    },
  }, {contextId: 'contexto'}, 20);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      secondHeartbeat,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('a segunda renovação não aconteceu a tempo')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
    stop();
  }
  const settled = beats;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(settled >= 2);
  assert.equal(beats, settled);
});

test('três falhas seguidas de renovação abortam uma vez e a quarta não aborta de novo', async () => {
  let beats = 0;
  let aborts = 0;
  let abortsAtBeat3 = -1;
  let abortsAtBeat4 = -1;
  let stop = () => {};
  try {
    stop = keepPersonalVerifyLease({
      async heartbeat() {
        beats += 1;
        if (beats === 3) abortsAtBeat3 = aborts;
        if (beats === 4) abortsAtBeat4 = aborts;
        if (beats >= 4) stop();
        throw new Error('lease ocupada');
      },
    }, {contextId: 'contexto'}, 20, () => { aborts += 1; });
    await until(() => beats >= 4);
    assert.equal(abortsAtBeat3, 0);
    assert.equal(abortsAtBeat4, 1);
    assert.equal(aborts, 1);
    assert.ok(beats >= 4);
  } finally {
    stop();
  }
});

test('falha, falha, sucesso, falha e falha não abortam a locação', async () => {
  const steps = ['fail', 'fail', 'ok', 'fail', 'fail'];
  const seen: string[] = [];
  let aborts = 0;
  let stop = () => {};
  try {
    stop = keepPersonalVerifyLease({
      async heartbeat() {
        const step = steps[seen.length] ?? 'ok';
        seen.push(step);
        if (seen.length >= steps.length) stop();
        if (step === 'fail') throw new Error('lease ocupada');
      },
    }, {contextId: 'contexto'}, 20, () => { aborts += 1; });
    await until(() => seen.length >= steps.length);
    assert.deepEqual(seen.slice(0, steps.length), steps);
    assert.equal(aborts, 0);
  } finally {
    stop();
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

test('perder a locação pede stop e mantém VERIFY_LEASE_LOST quando stop falha', async () => {
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
  let stops = 0;
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
      stops += 1;
      assert.equal(request.jobId, seenJob);
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
  let rejected: unknown;
  const stop = worker.stop;
  if (!stop) throw new Error('stop ausente');
  await abortPersonalVerifyForLeaseLoss({
    stopLease() {},
    stopJob: () => stop(),
    rejectAbort(error) { rejected = error; },
  });
  assert.equal(stops, 1);
  assert.ok(rejected instanceof Refusal && rejected.code === 'VERIFY_LEASE_LOST');
  release();
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
