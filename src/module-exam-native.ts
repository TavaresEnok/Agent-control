import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {Capacity} from './capacity.ts';
import {Refusal, type Authority} from './contracts.ts';
import {loadSpecialistExamPlan, moduleExaminerRequirement, reserveSpecialistExamSeat} from './exam-provider.ts';
import type {Ledger, VerificationModule} from './ledger.ts';
import {safeFailureCode} from './exam-login.ts';
import {readPrivateFile, type Installation} from './installation.ts';
import {type ModuleExamProvider, moduleExamProviders} from './module-exam-egress.ts';
import type {ModuleExamCollectorContext} from './module-exam-collector-proof.ts';
import {
  examineFunctionalModule,
  CLAUDE_QUOTA_RETRY_INTERVAL_MS,
  type ModuleExamInput,
  type ModuleExamResult,
  type ModuleExamReviewTarget,
  type ModuleExamSeat,
  type ModuleExamWorker,
} from './module-exam.ts';
import {mapModuleSnapshot} from './module-exam-map.ts';
import {attestDistinctExamSessions} from './module-exam-sessions.ts';
import {NativeExecutionRequest, NativeExecutionSupervisor} from './native-execution-supervisor.ts';
import {renewPersonalQuota} from './personal-runtime.ts';
import type {ModuleRecheckReview, VerificationModuleRunInput} from './verification-modules.ts';

/** Uses the dedicated exam context and Capacity's project, profile and quota policy.
 * A reviewer is never silently downgraded to the examiner's provider. */
type ReservationInput = {
  ledger: Ledger; principal: string; authority: Authority; intentId: string;
  module?: VerificationModule;
  supportedSeats: ReadonlyMap<ModuleExamProvider, ReadonlySet<string>>;
};

export type ModuleExamClock = {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const defaultExamClock: ModuleExamClock = {
  now: () => Date.now(),
  async sleep(ms, signal) {
    try {
      await delay(ms, undefined, {signal});
    } catch (error) {
      if (signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
      throw error;
    }
  },
};

export function createModuleExamReservations(input: ReservationInput): Pick<Required<ModuleExamInput>, 'reserve'|'release'> & {
  reserveReviewer: (
    avoid: {provider: string; profileId: string | null; accountId: string | null} | null,
    target?: ModuleExamReviewTarget,
  ) => Promise<ModuleExamSeat>;
  lastAttemptProvider: () => string | undefined;
} {
  const capacity = new Capacity(input.ledger);
  let lastProvider: string | undefined;
  const release = async (seat: ModuleExamSeat, state: 'not_started'|'exited') => {
    await capacity.transition(input.principal, seat.grantId, input.authority, 'released', {processId: seat.grantId, state});
  };
  const releaseNotStarted = async (grantId: string) => {
    await capacity.transition(input.principal, grantId, input.authority, 'released', {processId: grantId, state: 'not_started'});
  };
  const reserveReviewer = async (
    avoid: {provider: string; profileId: string | null; accountId: string | null} | null,
    target?: ModuleExamReviewTarget,
  ) => {
    if (target?.fromExaminer && target.severity === 'alta') {
      lastProvider = 'claude';
      const accounts = input.supportedSeats.get('claude');
      if (!accounts?.size) throw new Refusal('MODULE_EXAM_HIGH_REVIEWER_UNAVAILABLE');
      const seat = await reserveSpecialistExamSeat({
        capacity,
        ledger: input.ledger,
        principal: input.principal,
        authority: input.authority,
        intentId: input.intentId,
        purpose: 'reviewer',
        allowedAccounts: [...accounts],
        ...(avoid?.profileId ? {avoidProfileId: avoid.profileId} : {}),
        requiredModel: 'claude-opus-5-5',
        requiredEffort: 'medium',
        firstAccountOnly: true,
        allowSameAccount: true,
        preferEmergencyFirst: true,
        unavailableCode: 'MODULE_EXAM_HIGH_REVIEWER_UNAVAILABLE',
        releaseGrant: releaseNotStarted,
      });
      if (!accounts.has(seat.accountId) || seat.provider !== 'claude' || seat.model !== 'claude-opus-5-5'
        || (avoid?.profileId && seat.profileId === avoid.profileId)) {
        await release(seat, 'not_started');
        throw new Refusal('MODULE_EXAM_HIGH_REVIEWER_UNAVAILABLE');
      }
      return seat;
    }
    for (const [provider, accounts] of input.supportedSeats) {
      if (provider === avoid?.provider || !accounts.size) continue;
      lastProvider = provider;
      try {
        const seat = await capacity.reserveWithSeat(input.principal, {attemptId: randomUUID(), intentId: input.intentId,
          contextId: input.authority.contextId, role: 'specialist', provider, allowedAccounts: [...accounts],
          ...(avoid?.profileId ? {avoidProfiles: [avoid.profileId]} : {}),
          ...(avoid?.accountId ? {avoidAccounts: [avoid.accountId]} : {})}, input.authority);
        const result = {provider: seat.provider, model: seat.model, accountId: seat.grant.account_id, profileId: seat.grant.profile_id, grantId: seat.grant.id};
        if (result.provider === avoid?.provider || result.profileId === avoid?.profileId || result.accountId === avoid?.accountId) {
          await release(result, 'not_started');
          throw new Refusal('MODULE_EXAM_PROVIDER_NOT_DISTINCT');
        }
        if (!accounts.has(result.accountId)) {
          await release(result, 'not_started');
          continue;
        }
        return result;
      } catch (error) {
        if (error instanceof Refusal && (error.code === 'NO_ELIGIBLE_CAPACITY' || error.code === 'ROLE_NOT_CONFIGURED')) continue;
        throw error;
      }
    }
    throw new Refusal('MODULE_EXAM_REVIEWER_UNAVAILABLE');
  };
  return {
    release,
    reserveReviewer,
    lastAttemptProvider: () => lastProvider,
    async reserve(purpose, avoid, target) {
      if (purpose === 'reviewer') {
        if (!avoid) throw new Refusal('MODULE_EXAM_EXAMINER_REQUIRED');
        return reserveReviewer(avoid, target);
      }
      if (!input.module) throw new Refusal('MODULE_EXAM_EXAMINER_UNAVAILABLE');
      lastProvider = 'claude';
      const accounts = input.supportedSeats.get('claude');
      if (!accounts?.size) throw new Refusal('MODULE_EXAM_EXAMINER_UNAVAILABLE');
      const requirement = moduleExaminerRequirement(input.module);
      const seat = await reserveSpecialistExamSeat({
        capacity,
        ledger: input.ledger,
        principal: input.principal,
        authority: input.authority,
        intentId: input.intentId,
        purpose: 'examiner',
        allowedAccounts: [...accounts],
        requiredModel: requirement.model,
        requiredEffort: requirement.effort,
        firstAccountOnly: true,
        unavailableCode: 'MODULE_EXAM_EXAMINER_UNAVAILABLE',
        releaseGrant: releaseNotStarted,
      });
      if (!accounts.has(seat.accountId) || seat.provider !== 'claude' || seat.model !== requirement.model) {
        await release(seat, 'not_started');
        throw new Refusal('MODULE_EXAM_EXAMINER_UNAVAILABLE');
      }
      return seat;
    },
  };
}

export function createPersonalModuleRecheck(input: Pick<WorkerInput, 'ledger' | 'principal' | 'authority'> & {
  loadRuntime: () => Promise<ModuleExamRuntime>;
}): ModuleRecheckReview {
  let runtimePromise: Promise<ModuleExamRuntime> | undefined;
  let blocked: string | undefined;
  return async ({intentId, commit, task, examiner, severity, fromExaminer, signal}) => {
    signal?.throwIfAborted();
    if (blocked) return {reason: blocked};
    runtimePromise ??= input.loadRuntime();
    const runtime = await runtimePromise.catch(() => null);
    signal?.throwIfAborted();
    if (!runtime) return {reason: 'MODULE_EXAM_RUNTIME_UNAVAILABLE'};
    const reservations = createModuleExamReservations({...input, intentId,
      supportedSeats: new Map(runtime.map(seat => [seat.provider, seat.accountIds]))});
    const highExaminer = Boolean(fromExaminer && severity === 'alta');
    let reviewer: ModuleExamSeat;
    try {
      reviewer = await reservations.reserveReviewer(
        examiner,
        severity ? {severity, source: fromExaminer ? 'examinador' : 'coletor', fromExaminer: Boolean(fromExaminer)} : undefined,
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Refusal && [
        'MODULE_EXAM_REVIEWER_UNAVAILABLE', 'MODULE_EXAM_HIGH_REVIEWER_UNAVAILABLE',
        'CAPACITY_NOT_CONFIGURED', 'CAPACITY_POLICY_REQUIRED',
      ].includes(error.code)) {
        return {reason: highExaminer ? 'MODULE_EXAM_HIGH_REVIEWER_UNAVAILABLE' : 'MODULE_EXAM_REVIEWER_UNAVAILABLE'};
      }
      if (error instanceof Refusal && error.code === 'PROVIDER_USAGE_LIMIT') {
        blocked = error.code;
        return {reason: blocked};
      }
      throw error;
    }
    try {
      const worker = createModuleExamNativeWorker({...input, intentId, commit, signal, runtime});
      const call = {...reviewer, role: 'specialist' as const, task, intentId, writePaths: [] as []};
      const output = await worker.run(call);
      const sessionId = (call as {examSessionId?: string}).examSessionId;
      return {output, reviewer: {...reviewer, ...(highExaminer && sessionId ? {sessionId} : {})}};
    } catch (error) {
      signal?.throwIfAborted();
      const grant = await input.ledger.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1', [reviewer.grantId]);
      if (grant.rows[0]?.state !== 'released') {
        blocked = 'MODULE_RECHECK_RESULT_UNCERTAIN';
        return {reason: blocked, reviewer};
      }
      const code = error instanceof Refusal ? error.code : '';
      if (code === 'PROVIDER_USAGE_LIMIT') blocked = code;
      const reason = code === 'PROVIDER_USAGE_LIMIT' || code === 'EXAM_LOGIN_STALE' || code === 'MODULE_EXAM_PROVIDER_UNAVAILABLE'
        ? code : 'MODULE_EXAM_PROVIDER_FAILED';
      return {reason, reviewer};
    }
  };
}

type NativeRequest = ReturnType<typeof NativeExecutionRequest.parse>;
export type ModuleExamSupervisor = Pick<NativeExecutionSupervisor,
  'start' | 'stop' | 'retireTerminal' | 'closeModuleExamEgress'> & {
    reconcile(...args: Parameters<NativeExecutionSupervisor['reconcile']>): Promise<
      {state: 'running' | 'uncertain'} | {state: 'completed' | 'failed'; output: string; failureCode: string | null}>;
  };
type RuntimeSeat = {provider: ModuleExamProvider; accountIds: ReadonlySet<string>; supervisor: ModuleExamSupervisor};
export type ModuleExamRuntime = readonly RuntimeSeat[];

export async function composePersonalModuleExamRuntime(config: Installation, ledger: Ledger): Promise<ModuleExamRuntime> {
  const boot = config.nativeBootstrap;
  if (boot?.state !== 'active') return [];
  const accounts = (await ledger.pool.query<{id: string; provider: string}>(`SELECT id,provider FROM ac_accounts
    WHERE id=ANY($1::uuid[]) AND enabled AND mode='subscription_cli'`, [boot.accounts.map(account => account.accountId)])).rows;
  if (!accounts.some(account => moduleExamProviders.some(provider => provider === account.provider))) return [];
  const signingKeyPem = (await readPrivateFile(boot.execution.signingKeyFile)).toString('utf8');
  await renewPersonalQuota(ledger);
  return moduleExamProviders.flatMap(provider => {
    const accountSubjects = boot.accounts.filter(account => accounts.some(row => row.id === account.accountId && row.provider === provider));
    if (!accountSubjects.length) return [];
    const supervisor = new NativeExecutionSupervisor(ledger, {
      id: boot.execution.id + '-' + provider, workerImage: boot.execution.workerImage, toolsImage: boot.execution.toolsImage,
      hostRoot: boot.execution.hostRoot, accountRoot: boot.execution.accountRoot, providerNetworkId: boot.execution.providerNetworkId,
      protectedRepositories: [config.project, ...config.projects].map(project => project.repo),
      provider, signingKeyPem, accountSubjects, workerEnv: [], toolsEnv: [],
    });
    return [{provider, supervisor, accountIds: new Set(accountSubjects.map(account => account.accountId))}];
  });
}

const timeoutMs = 120_000;
const confirmationWait = 2000;

type WorkerInput = {
  ledger: Ledger; principal: string; authority: Authority; commit: string; runtime: ModuleExamRuntime;
  intentId: string; signal?: AbortSignal;
};

/** The supervisor is solely responsible for a started grant; stop never implies exit. */
function createModuleExamNativeWorker(input: WorkerInput): ModuleExamWorker {
  const {ledger, principal, authority, signal} = input;
  async function stopAndReconcile(supervisor: ModuleExamSupervisor, request: NativeRequest) {
    try {
      await supervisor.stop(principal, authority, request);
      for (let attempt = 0; attempt < 4; attempt++) {
        const status = await supervisor.reconcile(principal, authority, request);
        if (status.state === 'completed' || status.state === 'failed') {
          await supervisor.retireTerminal(principal, authority, request.jobId);
          return;
        }
        if (attempt < 3) await delay(confirmationWait);
      }
    } catch { /* The journal retains uncertain jobs and grants. */ }
  }
  return {
    async run(call) {
      if (call.intentId !== input.intentId) throw new Refusal('MODULE_EXAM_SCOPE_MISMATCH');
      const seat = input.runtime.find(candidate => candidate.provider === call.provider && candidate.accountIds.has(call.accountId));
      const jobId = randomUUID();
      const supervisor = seat?.supervisor;
      const closeEgress = () => supervisor?.closeModuleExamEgress(jobId);
      signal?.addEventListener('abort', closeEgress, {once: true});
      try {
        if (signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
        if (!supervisor) throw new Refusal('MODULE_EXAM_PROVIDER_UNAVAILABLE');
        const sessionId = randomUUID();
        const request = NativeExecutionRequest.parse({
          jobId, intentId: call.intentId, grantId: call.grantId, sessionId, base: input.commit,
          role: 'specialist', task: call.task, writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
          moduleExam: {accountId: call.accountId, profileId: call.profileId, model: call.model}, timeoutMs,
        });
        (call as {examSessionId?: string}).examSessionId = sessionId;
        let outcome;
        try {
          await supervisor.start(principal, authority, request, signal);
          for (let attempt = 0; attempt < (timeoutMs + 30_000) / confirmationWait; attempt++) {
            if (signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
            const observed = await supervisor.reconcile(principal, authority, request);
            if (observed.state === 'completed' || observed.state === 'failed') { outcome = observed; break; }
            await delay(confirmationWait, undefined, {signal});
          }
          if (!outcome) throw new Refusal('MODULE_EXAM_TIMEOUT');
        } catch (error) {
          closeEgress();
          await stopAndReconcile(supervisor, request);
          if (signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
          throw error;
        }
        // A signed terminal outcome already sealed the physical receipt and released the grant.
        // Retirement can be resumed from the journal if housekeeping fails.
        await supervisor.retireTerminal(principal, authority, jobId).catch(() => undefined);
        if (outcome.state === 'failed') throw new Refusal(safeFailureCode(outcome.failureCode, 'MODULE_EXAM_PROVIDER_FAILED'));
        return outcome.output;
      } catch (error) {
        // Before there is an execution journal the broker cannot have created a worker. A release
        // still requires the grant to be reserved. Never use the design fallback to claim exit.
        const journal = await ledger.pool.query('SELECT 1 FROM ac_native_execution_jobs WHERE grant_id=$1', [call.grantId]);
        if (!journal.rowCount) {
          await new Capacity(ledger).transition(principal, call.grantId, authority, 'released',
            {processId: call.grantId, state: 'not_started'}).catch(() => undefined);
        }
        if (signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
        throw error;
      } finally {
        signal?.removeEventListener('abort', closeEgress);
        closeEgress();
      }
    },
  };
}

export type ModuleExamCallback = (request: Parameters<NonNullable<VerificationModuleRunInput['examinar']>>[0]
  & {collector?: ModuleExamCollectorContext}) => Promise<ModuleExamResult>;

const RECOVERABLE_QUOTA_STATUSES = new Set(['exhausted', 'rate_limited']);

/** Refreshes expired personal/quota-limit observations only for the target Claude account and model,
 * preserving active provider exhaustion deadlines, model-scoped isolation, and all other accounts/providers. */
async function refreshClaudeExamQuotaForRetry(
  ledger: Ledger,
  principal: string,
  accountId: string,
  model: string,
): Promise<void> {
  await ledger.tx(async c => {
    // Capacity writers take this lock before recording account and model observations.
    // Read the observations in a new statement after any concurrent writer has committed.
    const account = await c.query('SELECT id FROM ac_accounts WHERE id=$1 AND owner_id=$2 FOR UPDATE', [accountId, principal]);
    if (!account.rowCount) return;
    const row = (await c.query<{
      id: string;
      provider: string;
      mode: string;
      enabled: boolean;
      quota_scope_mode: 'account' | 'model';
      account_exhausted: boolean;
      account_quota_status: string | null;
      account_quota_fresh: boolean | null;
      account_quota_plenty: boolean | null;
      model_quota_status: string | null;
      model_quota_fresh: boolean | null;
      model_quota_plenty: boolean | null;
    }>(
      `SELECT a.id, a.provider, a.mode, a.enabled, a.quota_scope_mode,
              (a.exhausted_until IS NOT NULL AND a.exhausted_until > clock_timestamp()) AS account_exhausted,
              q.status AS account_quota_status,
              (q.expires_at IS NOT NULL AND q.expires_at > clock_timestamp()) AS account_quota_fresh,
              (q.expires_at IS NOT NULL AND q.expires_at > clock_timestamp() + interval '15 minutes') AS account_quota_plenty,
              mq.status AS model_quota_status,
              (mq.expires_at IS NOT NULL AND mq.expires_at > clock_timestamp()) AS model_quota_fresh,
              (mq.expires_at IS NOT NULL AND mq.expires_at > clock_timestamp() + interval '15 minutes') AS model_quota_plenty
       FROM ac_accounts a
       LEFT JOIN ac_quota_observations q ON q.account_id = a.id
       LEFT JOIN ac_model_quota_observations mq ON mq.account_id = a.id AND mq.model = $2
       WHERE a.id = $1`,
      [accountId, model],
    )).rows[0];

    if (!row || !row.enabled || row.provider !== 'claude' || row.mode !== 'subscription_cli') return;
    if (row.account_exhausted) return;

    const accountQuotaActiveNonAvailable =
      row.account_quota_status !== null && row.account_quota_status !== 'available' && row.account_quota_fresh === true;
    if (accountQuotaActiveNonAvailable) return;

    const accountQuotaCanRefresh =
      row.account_quota_status === null
      || row.account_quota_status === 'available'
      || (RECOVERABLE_QUOTA_STATUSES.has(row.account_quota_status) && row.account_quota_fresh !== true);
    if (!accountQuotaCanRefresh) return;

    const capacity = new Capacity(ledger, c);
    if (row.quota_scope_mode === 'account') {
      if (row.account_quota_status !== 'available' || row.account_quota_plenty !== true) {
        await capacity.observeQuota(principal, accountId, {
          status: 'available',
          source: 'personal://refresh',
          ttlSeconds: 3600,
        });
      }
      return;
    }

    // In model scope, never call observeQuota (which invalidates all other model observations).
    if (row.account_quota_status !== 'available' || row.account_quota_plenty !== true) {
      await c.query(
        `INSERT INTO ac_quota_observations(account_id, status, source, observed_at, expires_at)
         VALUES ($1, 'available', 'personal://refresh', clock_timestamp(), clock_timestamp() + interval '1 hour')
         ON CONFLICT(account_id) DO UPDATE
           SET status = excluded.status,
               source = excluded.source,
               observed_at = excluded.observed_at,
               expires_at = excluded.expires_at`,
        [accountId],
      );
    }

    if (row.model_quota_status === null) return;
    const modelQuotaNeedsRefresh =
      (row.model_quota_status === 'available' && row.model_quota_plenty !== true)
      || (RECOVERABLE_QUOTA_STATUSES.has(row.model_quota_status) && row.model_quota_fresh !== true);
    if (modelQuotaNeedsRefresh) {
      await capacity.observeModelQuota(principal, accountId, model, {
        status: 'available',
        source: 'personal://refresh',
        ttlSeconds: 3600,
      });
    }
  });
}

export function createPersonalModuleExam(input: Omit<WorkerInput, 'intentId' | 'runtime' | 'signal'> & {
  loadRuntime: () => Promise<ModuleExamRuntime>;
  waitForClaudeQuota?: boolean;
  clock?: ModuleExamClock;
  onQuotaWait?: (info: {purpose: 'examiner' | 'reviewer'; file: string; delayMs: number}) => void;
}): ModuleExamCallback {
  return async ({intentId, snapshot, module, findings, collector, signal}): Promise<ModuleExamResult> => {
    const map = await mapModuleSnapshot(snapshot, signal, {aggregateOmissions: module === 'arquitetura'});
    let runtime: ModuleExamRuntime;
    try { runtime = await input.loadRuntime(); }
    catch { return examineFunctionalModule({intentId, module, map, findings, signal, unavailable: 'MODULE_EXAM_RUNTIME_UNAVAILABLE'}); }
    if (!runtime.some(seat => seat.provider === 'claude')) {
      return examineFunctionalModule({intentId, module, map, findings, signal, unavailable: 'MODULE_EXAM_EXAMINER_UNAVAILABLE'});
    }
    const supportedSeats = new Map(runtime.map(seat => [seat.provider, seat.accountIds]));
    const reservations = createModuleExamReservations({...input, intentId, module, supportedSeats});
    const clock = input.clock ?? defaultExamClock;
    const waitForClaudeQuota = input.waitForClaudeQuota
      ? async ({purpose, provider, accountId, file, signal: waitSignal}: Parameters<NonNullable<ModuleExamInput['waitForClaudeQuota']>>[0]) => {
          const activeSignal = waitSignal ?? signal;
          if (activeSignal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
          const effectiveProvider = provider !== 'unknown' ? provider : (reservations.lastAttemptProvider() ?? 'unknown');
          if (effectiveProvider !== 'claude') return false;
          const claudeAccounts = supportedSeats.get('claude');
          if (!claudeAccounts?.size) return false;
          let targetAccountId = accountId;
          if (!targetAccountId) {
            const plan = await loadSpecialistExamPlan(input.ledger.pool, input.authority.contextId);
            targetAccountId = plan.primaryClaudeAccountId;
          }
          if (!targetAccountId || !claudeAccounts.has(targetAccountId)) return false;
          const targetModel = purpose === 'examiner'
            ? moduleExaminerRequirement(module).model
            : 'claude-opus-5-5';
          input.onQuotaWait?.({purpose, file, delayMs: CLAUDE_QUOTA_RETRY_INTERVAL_MS});
          try {
            await clock.sleep(CLAUDE_QUOTA_RETRY_INTERVAL_MS, activeSignal);
          } catch (error) {
            if (activeSignal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
            throw error;
          }
          if (activeSignal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
          await refreshClaudeExamQuotaForRetry(input.ledger, input.principal, targetAccountId, targetModel);
          if (activeSignal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
          return true;
        }
      : undefined;
    return examineFunctionalModule({intentId, module, map, findings, commit: input.commit, signal,
      ...(collector ? {collectorReview: {collector, intentId, snapshot}} : {}),
      worker: createModuleExamNativeWorker({...input, intentId, runtime, signal}),
      reserve: reservations.reserve,
      release: reservations.release,
      ...(waitForClaudeQuota ? {waitForClaudeQuota} : {}),
      attestSessions: ({examiner, reviewer}) => attestDistinctExamSessions(input.ledger.pool, {
        contextId: input.authority.contextId, examiner, examinerIntentId: intentId, reviewer, reviewerIntentId: intentId,
      }),
    });
  };
}
