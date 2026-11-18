import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Refusal, type Authority} from '../src/contracts.ts';
import type {Ledger} from '../src/ledger.ts';
import {createDesignNativeWorker, type DesignExamSupervisor} from '../src/design-native-launch.ts';
import type {DesignWorkerCall} from '../src/design-types.ts';

const base = 'a'.repeat(40);
const ledger = {} as Ledger;
const capturePath = '/work/.design-captures/abc.png';

function authority(): Authority {
  return {contextId: randomUUID(), instanceId: randomUUID(), epoch: 1};
}

function call(over: Partial<DesignWorkerCall> = {}): DesignWorkerCall {
  return {
    role: 'specialist',
    provider: 'grok',
    accountId: randomUUID(),
    profileId: randomUUID(),
    model: 'fixture-model',
    grantId: randomUUID(),
    intentId: randomUUID(),
    task: `Pedido de exame.\nCapturas:\n- arquivo=${capturePath} viewport=375 tema=claro estado=padrao sha256=${'ab'.repeat(32)}`,
    repo: '/tmp/repo-leitura',
    writePaths: [],
    ...over,
  };
}

function supervisor(accountId: string, hooks: {
  start: DesignExamSupervisor['start'];
  reconcile: DesignExamSupervisor['reconcile'];
  retireTerminal: DesignExamSupervisor['retireTerminal'];
  active?: boolean;
}): DesignExamSupervisor {
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

test('createDesignNativeWorker reconcilia, aposenta e não solta a concessão', async () => {
  const asked = call();
  const waits: number[] = [];
  const released: string[] = [];
  let retired = '';
  let seen: {jobId: string; writePaths: readonly string[]; task: string; role: string} | undefined;
  let reconciles = 0;
  const chosen = supervisor(asked.accountId, {
    async start(_principal, _authority, request) {
      seen = {jobId: request.jobId, writePaths: request.writePaths, task: request.task, role: request.role};
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
  const worker = createDesignNativeWorker({
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
  assert.equal(seen?.role, 'specialist');
  assert.equal(seen?.task.includes(capturePath), true);
  assert.equal(retired, seen?.jobId);
  assert.deepEqual(waits, [2000]);
  assert.deepEqual(released, []);
});

test('createDesignNativeWorker solta a concessão quando start falha', async () => {
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
  const worker = createDesignNativeWorker({
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

test('createDesignNativeWorker recusa sem supervisor ativo', async () => {
  const asked = call();
  const worker = createDesignNativeWorker({
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
  await assert.rejects(() => worker.run(asked), (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_WORKER_UNAVAILABLE');
});

test('o revisor nativo também vai sem writePaths e com a mesma captura no task', async () => {
  const asked = call({role: 'reviewer', task: `Pedido de confirmação.\nCapturas:\n- arquivo=${capturePath} viewport=768 tema=escuro estado=vazio sha256=${'cd'.repeat(32)}`});
  let seen: {writePaths: readonly string[]; role: string; task: string} | undefined;
  const chosen = supervisor(asked.accountId, {
    async start(_principal, _authority, request) {
      seen = {writePaths: request.writePaths, role: request.role, task: request.task};
      return {state: 'running'};
    },
    async reconcile() {
      return {state: 'completed', output: 'revisto'};
    },
    async retireTerminal() {
      return {state: 'removed'};
    },
  });
  const worker = createDesignNativeWorker({
    supervisors: [chosen],
    principal: 'owner',
    authority: authority(),
    ledger,
    base,
    wait: async () => {
      throw new Error('wait-called');
    },
  });
  const output = await worker.run(asked);
  assert.equal(output, 'revisto');
  assert.equal(seen?.role, 'reviewer');
  assert.deepEqual(seen?.writePaths, []);
  assert.equal(seen?.task.includes(capturePath), true);
  assert.equal(seen?.task.includes('cd'.repeat(32)), true);
});
