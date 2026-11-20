import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPublicKey, generateKeyPairSync, randomUUID, sign, verify} from 'node:crypto';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonical} from '../src/contracts.ts';
import {Refusal, type Authority} from '../src/contracts.ts';
import type {Ledger} from '../src/ledger.ts';
import {Ledger as LedgerClass} from '../src/ledger.ts';
import {NativeExecutionSupervisor, readonlySecurityExam} from '../src/native-execution-supervisor.ts';
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
  receiptSignedByThisExecutor?: SecurityExamSupervisor['receiptSignedByThisExecutor'];
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
    ...(hooks.receiptSignedByThisExecutor ? {receiptSignedByThisExecutor: hooks.receiptSignedByThisExecutor} : {}),
  };
}

const RECEIPT_DOMAIN = 'agent-control:native-execution-receipt:v1\n';

/** Same contract as NativeExecutionSupervisor.receiptSignedByThisExecutor, over a test key. */
function executorKey() {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = createPublicKey(keys.privateKey);
  return {
    signed: (payload: unknown) => ({
      payload,
      signature: sign(null, Buffer.from(RECEIPT_DOMAIN + canonical(payload)), keys.privateKey).toString('hex'),
    }),
    vouches: (receipt: unknown): boolean => {
      const saved = receipt as {payload?: unknown; signature?: unknown} | undefined;
      return Boolean(saved?.payload)
        && typeof saved?.signature === 'string'
        && /^[a-f0-9]{128}$/.test(saved.signature)
        && verify(null, Buffer.from(RECEIPT_DOMAIN + canonical(saved.payload)), publicKey, Buffer.from(saved.signature, 'hex'));
    },
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
  | 'forged-signature' | 'tampered-payload' | 'foreign-key' | 'mismatched-signature'
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
  const executor = executorKey();
  const foreign = executorKey();
  const chosen = supervisor(accountId, {
    receiptSignedByThisExecutor: executor.vouches,
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
      if (mode === 'failed') return {state: 'failed', output: 'x', receipt: executor.signed({...payload, exitCode: 1})};
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
      const authentic = executor.signed(payload);
      let receipt: unknown = authentic;
      // Every id, the exit code and a 128 hex digit signature are right; only the key is not the supervisor's.
      if (mode === 'forged-signature') receipt = {payload, signature};
      if (mode === 'foreign-key') receipt = foreign.signed(payload);
      if (mode === 'tampered-payload') receipt = {payload: {...payload, workerExitCode: 1}, signature: authentic.signature};
      if (mode === 'mismatched-signature') receipt = {payload, signature: executor.signed({...payload, outputDigest: 'x'}).signature};
      if (mode === 'no-signature') receipt = {payload};
      if (mode === 'bad-signature') receipt = {payload, signature: 'zz'};
      return {
        state: 'completed',
        output: 'ok',
        ...(mode === 'wrong-outcome-session' ? {sessionId: randomUUID()} : {}),
        receipt,
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
    'forged-signature', 'tampered-payload', 'foreign-key', 'mismatched-signature',
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

test('o supervisor nativo real só atesta recibo assinado com a própria chave e a conferência recusa o falso recibo com todos os ids', async () => {
  const area = await mkdtemp(join(tmpdir(), 'ac-receipt-signature-'));
  // A pool never connects until queried, so no database is needed to authenticate a receipt.
  const db = new LedgerClass('postgresql://receipt-signature.invalid/none');
  try {
    const hostRoot = join(area, 'spool');
    const accountRoot = join(area, 'accounts');
    const repository = join(area, 'repo');
    for (const path of [hostRoot, accountRoot, repository]) await mkdir(path, {mode: 0o700});
    const accountId = randomUUID();
    const profileId = randomUUID();
    const keys = generateKeyPairSync('ed25519');
    const image = `sha256:${'c'.repeat(64)}`;
    const real = new NativeExecutionSupervisor(db, {
      id: 'receipt-signature',
      workerImage: image,
      toolsImage: image,
      hostRoot,
      accountRoot,
      repository,
      protectedRepositories: [],
      signingKeyPem: keys.privateKey.export({format: 'pem', type: 'pkcs8'}).toString(),
      providerNetworkId: 'd'.repeat(64),
      socketPath: '/no-operational-docker.sock',
      accountSubjects: [{accountId, subjectDigest: 'a'.repeat(64)}],
      workerEnv: [],
      toolsEnv: [],
    });
    const signWith = (key: typeof keys.privateKey, payload: unknown) => ({
      payload,
      signature: sign(null, Buffer.from(RECEIPT_DOMAIN + canonical(payload)), key).toString('hex'),
    });
    const payload = {schemaVersion: 1, accountId, profileId, jobId: randomUUID(), exitCode: 0};

    // Direct validation.
    assert.equal(real.receiptSignedByThisExecutor(signWith(keys.privateKey, payload)), true);
    assert.equal(real.receiptSignedByThisExecutor({payload, signature: 'ab'.repeat(64)}), false);
    assert.equal(real.receiptSignedByThisExecutor({payload: {...payload, exitCode: 1}, signature: signWith(keys.privateKey, payload).signature}), false);
    assert.equal(real.receiptSignedByThisExecutor(signWith(generateKeyPairSync('ed25519').privateKey, payload)), false);
    for (const odd of [undefined, null, 'x', 7, {}, {payload}, {payload, signature: 'zz'}, {payload: 1, signature: 'ab'.repeat(64)}]) {
      assert.equal(real.receiptSignedByThisExecutor(odd), false);
    }

    // Through the worker: only the receipt signed under the supervisor's key proves the session.
    const context = authority();
    let forge = false;
    let foreignKey = false;
    const chosen: SecurityExamSupervisor = {
      active: true,
      supportsAccount: id => id === accountId,
      async start() { return {state: 'running'}; },
      async reconcile(_principal, _authority, request) {
        const bound = {
          schemaVersion: 1,
          accountId,
          profileId,
          jobId: request.jobId,
          intentId: request.intentId,
          contextId: context.contextId,
          grantId: request.grantId,
          sessionId: request.sessionId,
          exitCode: 0,
        };
        const receipt = forge
          ? {payload: bound, signature: 'ab'.repeat(64)}
          : signWith(foreignKey ? generateKeyPairSync('ed25519').privateKey : keys.privateKey, bound);
        return {state: 'completed', output: 'ok', receipt};
      },
      async retireTerminal() { return {state: 'removed'}; },
      receiptSignedByThisExecutor: receipt => real.receiptSignedByThisExecutor(receipt),
    };
    const worker = createCapacityNativeWorker({supervisors: [chosen], principal: 'owner', authority: context, ledger, base, wait: async () => {}});

    const genuine = call({accountId, profileId});
    await worker.run(genuine);
    assert.ok(readNativeExamSession(worker, genuine));

    forge = true;
    const forged = call({accountId, profileId});
    await worker.run(forged);
    assert.equal(readNativeExamSession(worker, forged), null);

    forge = false;
    foreignKey = true;
    const foreign = call({accountId, profileId});
    await worker.run(foreign);
    assert.equal(readNativeExamSession(worker, foreign), null);

    // A supervisor that cannot vouch for receipts, or whose check throws, never proves a session.
    for (const vouch of [undefined, () => { throw new Error('boom'); }] as const) {
      foreignKey = false;
      const mute = {...chosen, receiptSignedByThisExecutor: vouch} as SecurityExamSupervisor;
      const muteWorker = createCapacityNativeWorker({supervisors: [mute], principal: 'owner', authority: context, ledger, base, wait: async () => {}});
      const asked = call({accountId, profileId});
      await muteWorker.run(asked);
      assert.equal(readNativeExamSession(muteWorker, asked), null);
    }
  } finally {
    await db.close();
    await rm(area, {recursive: true, force: true});
  }
});

test('espera cresce com recuo e mantém o mesmo prazo total que a espera fixa', async () => {
  for (const [pollBackoff, expectFewer] of [[true, true], [false, false]] as const) {
    const asked = call();
    const waits: number[] = [];
    let reconciles = 0;
    const chosen = supervisor(asked.accountId, {
      async start() {
        return {state: 'running'};
      },
      async reconcile() {
        reconciles += 1;
        return {state: 'running'};
      },
      async retireTerminal() {
        return {state: 'removed'};
      },
      async stop() {
        return {state: 'stop_requested'};
      },
    });
    const worker = createCapacityNativeWorker({
      supervisors: [chosen], principal: 'owner', authority: authority(), ledger, base, pollBackoff,
      wait: async ms => {
        waits.push(ms);
      },
    });
    await assert.rejects(() => worker.run(asked), /VERIFY_EXAM_TIMEOUT/);
    assert.equal(waits[0], 2000);
    if (expectFewer) {
      assert.deepEqual(waits.slice(0, 4), [2000, 3000, 4500, 6750]);
      assert.ok(Math.max(...waits) <= 10_000);
      assert.ok(reconciles < 150, 'com recuo: ' + reconciles);
    } else {
      assert.ok(waits.every(ms => ms === 2000));
      assert.ok(reconciles >= 479, 'sem recuo: ' + reconciles);
    }
    assert.ok(waits.reduce((sum, ms) => sum + ms, 0) >= 950_000, 'prazo total preservado');
  }
});
