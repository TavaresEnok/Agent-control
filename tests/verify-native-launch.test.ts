import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Refusal, type Authority} from '../src/contracts.ts';
import type {Ledger} from '../src/ledger.ts';
import {readonlySecurityExam} from '../src/native-execution-supervisor.ts';
import {
  createCapacityNativeWorker,
  createRecheckNativeWorker,
  readNativeExamSession,
  type SecurityExamSupervisor,
} from '../src/verify-native-launch.ts';
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
  stop?: SecurityExamSupervisor['stop'];
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
    ...(hooks.stop ? {stop: hooks.stop} : {}),
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
      return {grantId: reservedGrant, accountId, provider: 'bancada'};
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

test('timeout só solta a concessão depois de parar e confirmar a saída', async () => {
  const asked = call();
  const events: string[] = [];
  let stopped = false;
  const chosen = supervisor(asked.accountId, {
    async start() {
      events.push('start');
      return {state: 'running'};
    },
    async reconcile() {
      events.push('reconcile');
      if (!stopped) throw new Error('VERIFY_EXAM_TIMEOUT');
      return {state: 'failed', output: ''};
    },
    async retireTerminal() {
      events.push('retire');
      return {state: 'removed'};
    },
    async stop() {
      events.push('stop');
      stopped = true;
      return {state: 'stop_requested'};
    },
  });
  const worker = createCapacityNativeWorker({
    supervisors: [chosen],
    principal: 'owner',
    authority: authority(),
    ledger,
    base,
    releaseGrant: async () => {
      events.push('release');
    },
    wait: async () => {
      events.push('wait');
    },
  });
  await assert.rejects(() => worker.run(asked), /VERIFY_EXAM_TIMEOUT/);
  assert.deepEqual(events, ['start', 'reconcile', 'stop', 'reconcile', 'release']);
});

test('timeout sem parada confirmada deixa a concessão presa', async () => {
  const asked = call();
  const released: string[] = [];
  const missingStop = supervisor(asked.accountId, {
    async start() {
      return {state: 'running'};
    },
    async reconcile() {
      throw new Error('VERIFY_EXAM_TIMEOUT');
    },
    async retireTerminal() {
      throw new Error('retire-called');
    },
  });
  let armed = false;
  const stuck = supervisor(asked.accountId, {
    async start() {
      return {state: 'running'};
    },
    async reconcile() {
      if (!armed) throw new Error('VERIFY_EXAM_TIMEOUT');
      return {state: 'running'};
    },
    async retireTerminal() {
      throw new Error('retire-called');
    },
    async stop() {
      armed = true;
      return {state: 'stop_requested'};
    },
  });
  const failingStop = supervisor(asked.accountId, {
    async start() {
      return {state: 'running'};
    },
    async reconcile() {
      throw new Error('VERIFY_EXAM_TIMEOUT');
    },
    async retireTerminal() {
      throw new Error('retire-called');
    },
    async stop() {
      throw new Error('stop-failed');
    },
  });
  const noStop = createCapacityNativeWorker({
    supervisors: [missingStop],
    principal: 'owner',
    authority: authority(),
    ledger,
    base,
    releaseGrant: async grantId => {
      released.push(grantId);
    },
    wait: async () => {},
  });
  await assert.rejects(() => noStop.run(asked), /VERIFY_EXAM_TIMEOUT/);
  const uncertain = createCapacityNativeWorker({
    supervisors: [stuck],
    principal: 'owner',
    authority: authority(),
    ledger,
    base,
    releaseGrant: async grantId => {
      released.push(grantId);
    },
    wait: async () => {},
  });
  await assert.rejects(() => uncertain.run(call({accountId: asked.accountId, grantId: asked.grantId})), /VERIFY_EXAM_TIMEOUT/);
  const refused = createCapacityNativeWorker({
    supervisors: [failingStop],
    principal: 'owner',
    authority: authority(),
    ledger,
    base,
    releaseGrant: async grantId => {
      released.push(grantId);
    },
    wait: async () => {},
  });
  await assert.rejects(() => refused.run(call({accountId: asked.accountId, grantId: asked.grantId})), /VERIFY_EXAM_TIMEOUT/);
  assert.deepEqual(released, []);
});

test('createRecheckNativeWorker repassa avoidProviders e devolve o provedor da reserva', async () => {
  const reservedGrant = randomUUID();
  const accountId = randomUUID();
  const intentId = randomUUID();
  let avoided: readonly string[] | undefined;
  const chosen = supervisor(accountId, {
    async start() {
      return {state: 'running'};
    },
    async reconcile() {
      return {state: 'completed', output: 'revisto'};
    },
    async retireTerminal() {
      return {state: 'removed'};
    },
  });
  const worker = createRecheckNativeWorker({
    supervisors: [chosen],
    principal: 'owner',
    authority: authority(),
    base,
    reserveReviewer: async (_id, avoid) => {
      avoided = avoid;
      return {grantId: reservedGrant, accountId, provider: 'claude'};
    },
    wait: async () => {
      throw new Error('wait-called');
    },
  });
  const asked = call({
    role: 'reviewer',
    provider: 'recheck',
    accountId: '00000000-0000-4000-8000-000000000001',
    profileId: '00000000-0000-4000-8000-000000000002',
    model: 'recheck',
    grantId: '00000000-0000-4000-8000-000000000003',
    intentId,
    task: 'Pedido de confirmação.',
    repo: 'sem-repositorio',
    avoidProviders: ['grok'],
  });
  const output = await worker.run(asked);
  assert.equal(output, 'revisto');
  assert.deepEqual(avoided, ['grok']);
  assert.equal((asked as {reviewerProvider?: string}).reviewerProvider, 'claude');
  assert.equal((asked as {reviewerAccountId?: string}).reviewerAccountId, accountId);
  assert.match((asked as {reviewerSessionId?: string}).reviewerSessionId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

type CompletedFixture = 'ok' | 'no-receipt' | 'session-only-receipt' | 'unstarted' | 'wrong-session' | 'wrong-job' | 'wrong-intent'
  | 'wrong-grant' | 'wrong-context' | 'wrong-account' | 'wrong-profile' | 'bad-exit' | 'bad-signature' | 'no-signature'
  | 'wrong-outcome-session' | 'failed' | 'retire-undefined' | 'retire-not-removed' | 'retire-throws';

test('createCapacityNativeWorker aceita entrada congelada sem mutar e só comprova a sessão com o recibo assinado do supervisor concluído', async () => {
  const context = authority();
  const accountId = randomUUID();
  const profileId = randomUUID();
  const frozen = () => Object.freeze(call({accountId, profileId}));
  const askedFirst = frozen();
  const askedSecond = frozen();
  const startedSessions: string[] = [];
  const modeByJob = new Map<string, CompletedFixture>();
  let nextMode: CompletedFixture = 'ok';
  const chosen = supervisor(accountId, {
    async start(_principal, _authority, request) {
      startedSessions.push(request.sessionId);
      modeByJob.set(request.jobId, nextMode);
      return {state: 'running'};
    },
    async reconcile(_principal, _authority, request) {
      const mode = modeByJob.get(request.jobId)!;
      const payload: Record<string, unknown> = {
        schemaVersion: 1,
        accountId,
        profileId,
        jobId: request.jobId,
        intentId: request.intentId,
        contextId: context.contextId,
        grantId: request.grantId,
        sessionId: request.sessionId,
        exitCode: 0,
        workerExitCode: 0,
      };
      const signature = 'ab'.repeat(64);
      if (mode === 'failed') return {state: 'failed', output: 'x', receipt: {payload: {...payload, exitCode: 1}, signature}};
      if (mode === 'no-receipt') return {state: 'completed', output: 'ok'};
      if (mode === 'session-only-receipt') return {state: 'completed', output: 'ok', receipt: {payload: {sessionId: request.sessionId}}};
      if (mode === 'unstarted') payload.executionStarted = false;
      if (mode === 'wrong-session') payload.sessionId = randomUUID();
      if (mode === 'wrong-job') payload.jobId = randomUUID();
      if (mode === 'wrong-intent') payload.intentId = randomUUID();
      if (mode === 'wrong-grant') payload.grantId = randomUUID();
      if (mode === 'wrong-context') payload.contextId = randomUUID();
      if (mode === 'wrong-account') payload.accountId = randomUUID();
      if (mode === 'wrong-profile') payload.profileId = randomUUID();
      if (mode === 'bad-exit') payload.exitCode = 1;
      return {
        state: 'completed',
        output: 'ok',
        ...(mode === 'wrong-outcome-session' ? {sessionId: randomUUID()} : {}),
        receipt: mode === 'no-signature'
          ? {payload}
          : {payload, signature: mode === 'bad-signature' ? 'zz' : signature},
      };
    },
    async retireTerminal(_principal, _authority, jobId) {
      const mode = modeByJob.get(jobId);
      if (mode === 'retire-throws') throw new Error('retire-failed');
      if (mode === 'retire-undefined') return undefined;
      if (mode === 'retire-not-removed') return {state: 'retained'};
      return {state: 'removed'};
    },
  });
  const worker = createCapacityNativeWorker({
    supervisors: [chosen],
    principal: 'owner',
    authority: context,
    ledger,
    base,
    wait: async () => {},
  });

  await worker.run(askedFirst);
  await worker.run(askedSecond);
  assert.equal('examSessionId' in askedFirst, false);
  assert.equal('examSessionId' in askedSecond, false);
  assert.equal(Object.isFrozen(askedFirst), true);
  assert.equal(Object.isFrozen(askedSecond), true);

  const firstSession = readNativeExamSession(worker, askedFirst);
  const secondSession = readNativeExamSession(worker, askedSecond);
  assert.equal(startedSessions.length, 2);
  assert.equal(firstSession?.sessionId, startedSessions[0]);
  assert.equal(secondSession?.sessionId, startedSessions[1]);
  assert.notEqual(firstSession?.sessionId, secondSession?.sessionId);
  assert.equal(firstSession?.contextId, context.contextId);
  assert.equal(firstSession?.accountId, accountId);
  assert.equal(firstSession?.profileId, profileId);

  const unproven: CompletedFixture[] = [
    'no-receipt', 'session-only-receipt', 'unstarted', 'wrong-session', 'wrong-job', 'wrong-intent', 'wrong-grant',
    'wrong-context', 'wrong-account', 'wrong-profile', 'bad-exit', 'bad-signature', 'no-signature', 'wrong-outcome-session',
    'failed', 'retire-undefined', 'retire-not-removed',
  ];
  for (const mode of unproven) {
    nextMode = mode;
    const asked = frozen();
    await worker.run(asked);
    assert.equal(readNativeExamSession(worker, asked), null, mode);
  }

  nextMode = 'retire-throws';
  const askedNotRetired = frozen();
  await assert.rejects(() => worker.run(askedNotRetired), /retire-failed/);
  assert.equal(readNativeExamSession(worker, askedNotRetired), null);
});
