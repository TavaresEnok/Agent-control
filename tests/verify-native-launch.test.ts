import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Refusal, type Authority} from '../src/contracts.ts';
import type {Ledger} from '../src/ledger.ts';
import {readonlySecurityExam} from '../src/native-execution-supervisor.ts';
import {createCapacityNativeWorker, createRecheckNativeWorker, type SecurityExamSupervisor} from '../src/verify-native-launch.ts';
import type {VerifyWorkerCall} from '../src/verify-types.ts';

const base = 'a'.repeat(40);
const ledger = {} as Ledger;

function authority(): Authority {
  return {contextId: randomUUID(), instanceId: randomUUID(), epoch: 1};
}

function call(over: Partial<VerifyWorkerCall> = {}): VerifyWorkerCall {
  return {
    role: 'specialist',
    provider: 'grok',
    accountId: randomUUID(),
    profileId: randomUUID(),
    model: 'fixture-model',
    grantId: randomUUID(),
    intentId: randomUUID(),
    task: 'Pedido de exame.',
    repo: '/tmp/repo-leitura',
    writePaths: [],
    ...over,
  };
}

function supervisor(accountId: string, hooks: {
  start: SecurityExamSupervisor['start'];
  reconcile: SecurityExamSupervisor['reconcile'];
  retireTerminal: SecurityExamSupervisor['retireTerminal'];
  active?: boolean;
}): SecurityExamSupervisor {
  return {
    active: hooks.active !== false,
    supportsAccount(id) {
      return id === accountId;
    },
    start: hooks.start,
    reconcile: hooks.reconcile,
    retireTerminal: hooks.retireTerminal,
  };
}

test('readonlySecurityExam só no specialist e no reviewer desse workflow', () => {
  assert.equal(readonlySecurityExam('security-verify-readonly-v1', 'specialist'), true);
  assert.equal(readonlySecurityExam('security-verify-readonly-v1', 'reviewer'), true);
  assert.equal(readonlySecurityExam('security-verify-readonly-v1', 'programmer'), false);
  assert.equal(readonlySecurityExam('security-verify-readonly-v1', 'qa'), false);
  assert.equal(readonlySecurityExam('security-verify-readonly-v1', 'judge'), false);
  assert.equal(readonlySecurityExam('engineering-native-v1', 'specialist'), false);
  assert.equal(readonlySecurityExam('engineering-native-v1', 'reviewer'), false);
  assert.equal(readonlySecurityExam(undefined, 'specialist'), false);
  assert.equal(readonlySecurityExam('security-verify-readonly-v1', undefined), false);
});

test('createCapacityNativeWorker reconcilia, aposenta e não solta a concessão', async () => {
  const asked = call();
  const waits: number[] = [];
  const released: string[] = [];
  let retired = '';
  let seen: {jobId: string; writePaths: readonly string[]} | undefined;
  let reconciles = 0;
  const chosen = supervisor(asked.accountId, {
    async start(_principal, _authority, request) {
      seen = {jobId: request.jobId, writePaths: request.writePaths};
      return {state: 'running'};
    },
    async reconcile() {
      reconciles += 1;
      if (reconciles === 1) return {state: 'running'};
      return {state: 'completed', output: 'ok'};
    },
    async retireTerminal(_principal, _authority, jobId) {
      retired = jobId;
      return {state: 'removed'};
    },
  });
  const inactive = supervisor(asked.accountId, {
    active: false,
    async start() {
      throw new Error('inactive');
    },
    async reconcile() {
      throw new Error('inactive');
    },
    async retireTerminal() {
      throw new Error('inactive');
    },
  });
  const worker = createCapacityNativeWorker({
    supervisors: [inactive, chosen],
    principal: 'owner',
    authority: authority(),
    ledger,
    base,
    releaseGrant: async grantId => {
      released.push(grantId);
    },
    wait: async ms => {
      waits.push(ms);
    },
  });
  const output = await worker.run(asked);
  assert.equal(output, 'ok');
  assert.deepEqual(seen?.writePaths, []);
  assert.equal(retired, seen?.jobId);
  assert.deepEqual(waits, [2000]);
  assert.deepEqual(released, []);
});

test('createCapacityNativeWorker solta a concessão quando start falha', async () => {
  const asked = call();
  const released: {grantId: string; reason: string}[] = [];
  const chosen = supervisor(asked.accountId, {
    async start() {
      throw new Error('start-failed');
    },
    async reconcile() {
      throw new Error('reconcile-called');
    },
    async retireTerminal() {
      throw new Error('retire-called');
    },
  });
  const worker = createCapacityNativeWorker({
    supervisors: [chosen],
    principal: 'owner',
    authority: authority(),
    ledger,
    base,
    releaseGrant: async (grantId, reason) => {
      released.push({grantId, reason});
    },
    wait: async () => {},
  });
  await assert.rejects(() => worker.run(asked), /start-failed/);
  assert.deepEqual(released, [{grantId: asked.grantId, reason: 'exited'}]);
});

test('createCapacityNativeWorker recusa sem supervisor ativo', async () => {
  const asked = call();
  const worker = createCapacityNativeWorker({
    supervisors: [supervisor(randomUUID(), {
      async start() {
        throw new Error('start-called');
      },
      async reconcile() {
        throw new Error('reconcile-called');
      },
      async retireTerminal() {
        throw new Error('retire-called');
      },
    })],
    principal: 'owner',
    authority: authority(),
    ledger,
    base,
    wait: async () => {},
  });
  await assert.rejects(() => worker.run(asked), (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_WORKER_UNAVAILABLE');
});

test('createRecheckNativeWorker usa a reserva de reviewer e ignora a concessão fictícia', async () => {
  const reservedGrant = randomUUID();
  const accountId = randomUUID();
  const fictional = '00000000-0000-4000-8000-000000000003';
  const intentId = randomUUID();
  let reservedIntent = '';
  let seen: {grantId: string; role: string; writePaths: readonly string[]} | undefined;
  let retired = false;
  const chosen = supervisor(accountId, {
    async start(_principal, _authority, request) {
      seen = {grantId: request.grantId, role: request.role, writePaths: request.writePaths};
      return {state: 'running'};
    },
    async reconcile() {
      return {state: 'completed', output: 'revisto'};
    },
    async retireTerminal() {
      retired = true;
      return {state: 'removed'};
    },
  });
  const worker = createRecheckNativeWorker({
    supervisors: [chosen],
    principal: 'owner',
    authority: authority(),
    base: 'b'.repeat(40),
    reserveReviewer: async id => {
      reservedIntent = id;
      return {grantId: reservedGrant, accountId};
    },
    releaseGrant: async () => {
      throw new Error('release-called');
    },
    wait: async () => {
      throw new Error('wait-called');
    },
  });
  const output = await worker.run(call({
    role: 'reviewer',
    provider: 'recheck',
    accountId: '00000000-0000-4000-8000-000000000001',
    profileId: '00000000-0000-4000-8000-000000000002',
    model: 'recheck',
    grantId: fictional,
    intentId,
    task: 'Pedido de confirmação.',
    repo: 'sem-repositorio',
  }));
  assert.equal(output, 'revisto');
  assert.equal(reservedIntent, intentId);
  assert.equal(seen?.grantId, reservedGrant);
  assert.notEqual(seen?.grantId, fictional);
  assert.equal(seen?.role, 'reviewer');
  assert.deepEqual(seen?.writePaths, []);
  assert.equal(retired, true);
});
