import {pollSchedule} from './manager-discipline.ts';
import {randomUUID} from 'node:crypto';
import {Capacity} from './capacity.ts';
import {Id, Refusal, type Authority} from './contracts.ts';
import {reserveSpecialistExamSeat} from './exam-provider.ts';
import type {Ledger} from './ledger.ts';
import {buildReadonlyExamRequest} from './verify-personal-worker.ts';
import {VerifyWorkerCall, type VerifyWorker} from './verify-types.ts';

// The native job may run until its 15 minute timeout. Polling every 2s has to outlast that.
const EXAM_ATTEMPTS = 480;
const EXAM_DEADLINE_MS = (EXAM_ATTEMPTS - 1) * 2000;
const EXAM_WAIT_MAX_MS = 10_000;
const EXAM_WAIT_MS = 2000;
const STOP_CONFIRM_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

export type SecurityExamRequest = ReturnType<typeof buildReadonlyExamRequest>;

export type NativeCompletedSession = {
  sessionId: string;
  grantId: string;
  accountId: string;
  profileId: string;
  intentId: string;
  contextId: string;
};

export type NativeWorkerCapacityPoll = {
  wait: Wait;
  pollBackoff: boolean;
  signal: AbortSignal;
};

const nativeWorkerCompletedSessions = new WeakMap<VerifyWorker, WeakMap<object, NativeCompletedSession>>();
const nativeWorkerCapacityPolls = new WeakMap<VerifyWorker, NativeWorkerCapacityPoll>();

export function isCapacityNativeWorker(worker: VerifyWorker): boolean {
  return nativeWorkerCompletedSessions.has(worker);
}

export function readNativeExamSession(worker: VerifyWorker, call: object): NativeCompletedSession | null {
  return nativeWorkerCompletedSessions.get(worker)?.get(call) ?? null;
}

export function readNativeWorkerCapacityPoll(worker: VerifyWorker): NativeWorkerCapacityPoll | null {
  return nativeWorkerCapacityPolls.get(worker) ?? null;
}

export function inheritNativeWorkerCapacityPoll(source: VerifyWorker, target: VerifyWorker): void {
  const poll = nativeWorkerCapacityPolls.get(source);
  if (poll) nativeWorkerCapacityPolls.set(target, poll);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural view of NativeExecutionSupervisor. The daemon is not imported here. */
export type SecurityExamSupervisor = {
  active: boolean;
  supportsAccount(accountId: string): boolean;
  start(principal: string, authority: Authority, request: SecurityExamRequest): Promise<{state: string}>;
  reconcile(principal: string, authority: Authority, request: SecurityExamRequest): Promise<{
    state: string;
    output?: string;
    sessionId?: unknown;
    receipt?: unknown;
  }>;
  retireTerminal(principal: string, authority: Authority, jobId: string): Promise<unknown>;
  /** Authenticates a receipt under this supervisor's own key. A supervisor that cannot vouch for a receipt proves nothing. */
  receiptSignedByThisExecutor?(receipt: unknown): boolean;
  stop?(principal: string, authority: Authority, request: SecurityExamRequest): Promise<{state: string}>;
};

type ReleaseGrant = (grantId: string, reason: 'exited') => Promise<void> | void;
type Wait = (ms: number) => Promise<void>;
type Poll = {attempts: number; waitMs: (attempt: number) => number};
const LEGACY_POLL: Poll = pollSchedule({backoff: false, baseMs: EXAM_WAIT_MS, maxMs: EXAM_WAIT_MS, deadlineMs: EXAM_DEADLINE_MS});
const BACKOFF_POLL: Poll = pollSchedule({backoff: true, baseMs: EXAM_WAIT_MS, maxMs: EXAM_WAIT_MAX_MS, deadlineMs: EXAM_DEADLINE_MS});

function terminal(state: string): boolean {
  return state === 'completed' || state === 'failed';
}

async function observeExam(
  supervisor: SecurityExamSupervisor,
  principal: string,
  authority: Authority,
  request: SecurityExamRequest,
  wait: Wait,
  poll: Poll = LEGACY_POLL,
): Promise<{state: string; output?: string; sessionId?: unknown; receipt?: unknown}> {
  await supervisor.start(principal, authority, request);
  for (let attempt = 0; attempt < poll.attempts; attempt += 1) {
    const outcome = await supervisor.reconcile(principal, authority, request);
    if (terminal(outcome.state)) return outcome;
    if (attempt === poll.attempts - 1) throw new Error('VERIFY_EXAM_TIMEOUT');
    await wait(poll.waitMs(attempt));
  }
  throw new Error('VERIFY_EXAM_TIMEOUT');
}

function examTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'VERIFY_EXAM_TIMEOUT';
}

const SIGNATURE_HEX = /^[a-f0-9]{128}$/;

function authenticReceipt(supervisor: SecurityExamSupervisor, receipt: unknown): boolean {
  try {
    return supervisor.receiptSignedByThisExecutor?.(receipt) === true;
  } catch {
    return false;
  }
}

/** Positive proof from the signed native execution contract: a completed terminal receipt, signed by the supervisor that ran it, that binds this very request. */
function matchesSupervisorReceipt(
  supervisor: SecurityExamSupervisor,
  receipt: unknown,
  request: SecurityExamRequest,
  authority: Authority,
  accountId: string,
  profileId: string,
): boolean {
  if (!isRecord(receipt) || typeof receipt.signature !== 'string' || !SIGNATURE_HEX.test(receipt.signature)) return false;
  const payload = receipt.payload;
  if (!isRecord(payload)) return false;
  if (!authenticReceipt(supervisor, receipt)) return false;
  if (payload.schemaVersion !== 1) return false;
  if ('executionStarted' in payload && payload.executionStarted !== true) return false;
  return payload.sessionId === request.sessionId
    && payload.jobId === request.jobId
    && payload.intentId === request.intentId
    && payload.grantId === request.grantId
    && payload.contextId === authority.contextId
    && payload.accountId === accountId
    && payload.profileId === profileId
    && payload.exitCode === 0;
}

function verifiedCompletedSession(
  supervisor: SecurityExamSupervisor,
  outcome: {state: string; output?: string; sessionId?: unknown; receipt?: unknown},
  retired: unknown,
  request: SecurityExamRequest,
  authority: Authority,
  accountId: string,
  profileId: string,
): string | null {
  if (outcome.state !== 'completed') return null;
  if ('sessionId' in outcome && outcome.sessionId !== undefined && outcome.sessionId !== request.sessionId) return null;
  if (!matchesSupervisorReceipt(supervisor, outcome.receipt, request, authority, accountId, profileId)) return null;
  if (!isRecord(retired) || retired.state !== 'removed') return null;
  return request.sessionId;
}

async function confirmExamExit(
  supervisor: SecurityExamSupervisor,
  principal: string,
  authority: Authority,
  request: SecurityExamRequest,
  wait: Wait,
): Promise<boolean> {
  const stop = supervisor.stop?.bind(supervisor);
  if (!stop) return false;
  try {
    await stop(principal, authority, request);
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < STOP_CONFIRM_ATTEMPTS; attempt += 1) {
    let outcome: {state: string; output?: string};
    try {
      outcome = await supervisor.reconcile(principal, authority, request);
    } catch {
      return false;
    }
    if (terminal(outcome.state) && typeof outcome.output === 'string') return true;
    if (attempt === STOP_CONFIRM_ATTEMPTS - 1) return false;
    await wait(EXAM_WAIT_MS);
  }
  return false;
}

async function finishExam(
  supervisor: SecurityExamSupervisor,
  principal: string,
  authority: Authority,
  request: SecurityExamRequest,
  releaseGrant: ReleaseGrant | undefined,
  grantId: string,
  wait: Wait,
  identity?: {accountId: string; profileId: string},
  poll: Poll = LEGACY_POLL,
): Promise<{output: string; verifiedSessionId: string | null}> {
  let outcome: {state: string; output?: string; sessionId?: unknown; receipt?: unknown};
  try {
    outcome = await observeExam(supervisor, principal, authority, request, wait, poll);
  } catch (error) {
    if (examTimeout(error)) {
      // The grant stays reserved unless stop and a terminal output both confirm the job is gone.
      let confirmed = false;
      try {
        confirmed = await confirmExamExit(supervisor, principal, authority, request, wait);
      } catch {
        confirmed = false;
      }
      if (confirmed && releaseGrant) await releaseGrant(grantId, 'exited');
      throw error;
    }
    if (releaseGrant) await releaseGrant(grantId, 'exited');
    throw error;
  }
  const retired = await supervisor.retireTerminal(principal, authority, request.jobId);
  return {
    output: outcome.output ?? '',
    verifiedSessionId: identity
      ? verifiedCompletedSession(supervisor, outcome, retired, request, authority, identity.accountId, identity.profileId)
      : null,
  };
}

export function createCapacityNativeWorker(input: {
  supervisors: readonly SecurityExamSupervisor[];
  principal: string;
  authority: Authority;
  /** Accepted so server-main can pass the ledger. The exam does not query it. */
  ledger: Ledger;
  base: string;
  releaseGrant?: ReleaseGrant;
  wait?: Wait;
  /** Poll with a growing wait (default). False keeps the fixed 2 s wait. The total deadline is the same. */
  pollBackoff?: boolean;
}): VerifyWorker {
  const {supervisors, principal, authority, base, releaseGrant, wait = sleep} = input;
  const poll = input.pollBackoff === false ? LEGACY_POLL : BACKOFF_POLL;
  const completedByCall = new WeakMap<object, NativeCompletedSession>();
  const stopController = new AbortController();
  let active: {supervisor: SecurityExamSupervisor; request: SecurityExamRequest} | null = null;
  const worker: VerifyWorker = {
    async stop() {
      stopController.abort();
      const current = active;
      const stop = current?.supervisor.stop?.bind(current.supervisor);
      if (!current || !stop) return;
      await stop(principal, authority, current.request);
    },
    async run(call) {
      completedByCall.delete(call);
      const parsed = VerifyWorkerCall.parse(call);
      const supervisor = supervisors.find(item => item.active && item.supportsAccount(parsed.accountId));
      if (!supervisor) throw new Refusal('VERIFY_WORKER_UNAVAILABLE');
      const request = buildReadonlyExamRequest({
        jobId: randomUUID(),
        intentId: parsed.intentId,
        grantId: parsed.grantId,
        sessionId: randomUUID(),
        base,
        role: parsed.role,
        task: parsed.task,
        artifactId: randomUUID(),
      });
      active = {supervisor, request};
      try {
        const completed = await finishExam(
          supervisor, principal, authority, request, releaseGrant, parsed.grantId, wait,
          {accountId: parsed.accountId, profileId: parsed.profileId}, poll,
        );
        if (completed.verifiedSessionId) {
          completedByCall.set(call, {
            sessionId: completed.verifiedSessionId,
            grantId: parsed.grantId,
            accountId: parsed.accountId,
            profileId: parsed.profileId,
            intentId: parsed.intentId,
            contextId: authority.contextId,
          });
        }
        return completed.output;
      } finally {
        if (active?.request === request) active = null;
      }
    },
  };
  nativeWorkerCompletedSessions.set(worker, completedByCall);
  nativeWorkerCapacityPolls.set(worker, {
    wait,
    pollBackoff: input.pollBackoff !== false,
    signal: stopController.signal,
  });
  return worker;
}

export type RecheckReserveExclusion = {
  avoidProfiles?: readonly string[];
  avoidAccounts?: readonly string[];
  avoidExaminerAccounts?: readonly string[];
};

/** Reserves a Claude `specialist` seat for recheck while strictly excluding the finding's original examiner profile. */
export async function reservePersonalRecheckReviewer(input: {
  ledger: Ledger;
  principal: string;
  authority: Authority;
  intentId: string;
  allowedAccounts?: readonly string[];
  avoidProviders?: readonly string[];
  exclusion?: RecheckReserveExclusion;
  releaseGrant: (grantId: string, how: 'not_started' | 'exited') => Promise<void>;
  wait?: Wait;
  pollBackoff?: boolean;
  deadlineMs?: number;
  signal?: AbortSignal;
}): Promise<{grantId: string; accountId: string; provider: string; role: 'specialist'}> {
  const avoidReviewerAccountIds = [
    ...(input.exclusion?.avoidAccounts ?? []),
    ...(input.avoidProviders ?? []).filter(id => Id.safeParse(id).success),
  ];
  const hasWaitConfig = input.wait !== undefined
    || input.pollBackoff !== undefined
    || input.deadlineMs !== undefined
    || input.signal !== undefined;
  const seat = await reserveSpecialistExamSeat({
    capacity: new Capacity(input.ledger),
    ledger: input.ledger,
    principal: input.principal,
    authority: input.authority,
    intentId: input.intentId,
    purpose: 'reviewer',
    ...(input.allowedAccounts ? {allowedAccounts: input.allowedAccounts} : {}),
    avoidProfileIds: input.exclusion?.avoidProfiles,
    avoidAccountIds: input.exclusion?.avoidExaminerAccounts,
    avoidReviewerAccountIds,
    ...(hasWaitConfig
      ? {
          capacityWait: {
            enabled: true,
            pollBackoff: input.pollBackoff !== false,
            deadlineMs: input.deadlineMs ?? EXAM_DEADLINE_MS,
            ...(input.wait ? {sleep: (ms: number) => Promise.resolve(input.wait!(ms))} : {}),
            ...(input.signal ? {signal: input.signal} : {}),
          },
        }
      : {}),
    releaseGrant: grantId => input.releaseGrant(grantId, 'not_started'),
  });
  return {grantId: seat.grantId, accountId: seat.accountId, provider: seat.provider, role: 'specialist'};
}

export function createRecheckNativeWorker(input: {
  supervisors: readonly SecurityExamSupervisor[];
  principal: string;
  authority: Authority;
  base: string;
  reserveReviewer(
    intentId: string,
    avoidProviders?: readonly string[],
    exclusion?: RecheckReserveExclusion,
  ): Promise<{grantId: string; accountId: string; provider: string; role?: 'specialist' | 'reviewer'}>;
  releaseGrant?: ReleaseGrant;
  wait?: Wait;
  pollBackoff?: boolean;
}): VerifyWorker {
  const {supervisors, principal, authority, base, reserveReviewer, releaseGrant, wait = sleep} = input;
  const poll = input.pollBackoff === false ? LEGACY_POLL : BACKOFF_POLL;
  return {
    async run(call) {
      const parsed = VerifyWorkerCall.parse(call);
      const exclusion = parsed.avoidProfiles?.length || parsed.avoidAccounts?.length || parsed.avoidExaminerAccounts?.length
        ? {
            ...(parsed.avoidProfiles?.length ? {avoidProfiles: parsed.avoidProfiles} : {}),
            ...(parsed.avoidAccounts?.length ? {avoidAccounts: parsed.avoidAccounts} : {}),
            ...(parsed.avoidExaminerAccounts?.length ? {avoidExaminerAccounts: parsed.avoidExaminerAccounts} : {}),
          }
        : undefined;
      let reserved: Awaited<ReturnType<typeof reserveReviewer>> | undefined;
      for (let attempt = 0; attempt < poll.attempts; attempt += 1) {
        try {
          reserved = await reserveReviewer(parsed.intentId, parsed.avoidProviders, exclusion);
          break;
        } catch (error) {
          const isCapacityWait = error instanceof Refusal
            && (error.code === 'CAPACITY_BUSY' || error.code === 'CAPACITY_QUEUED');
          if (!isCapacityWait || attempt === poll.attempts - 1) throw error;
          await wait(poll.waitMs(attempt));
        }
      }
      if (!reserved) throw new Refusal('CAPACITY_QUEUED');
      const marked = call as {reviewerProvider?: string; reviewerAccountId?: string; reviewerSessionId?: string};
      marked.reviewerProvider = typeof reserved.provider === 'string' ? reserved.provider : '';
      marked.reviewerAccountId = typeof reserved.accountId === 'string' ? reserved.accountId : '';
      const supervisor = supervisors.find(item => item.active && item.supportsAccount(reserved.accountId));
      if (!supervisor) {
        if (releaseGrant) await releaseGrant(reserved.grantId, 'exited');
        throw new Refusal('VERIFY_WORKER_UNAVAILABLE');
      }
      let request: SecurityExamRequest;
      try {
        request = buildReadonlyExamRequest({
          jobId: randomUUID(),
          intentId: parsed.intentId,
          grantId: reserved.grantId,
          sessionId: randomUUID(),
          base,
          role: reserved.role ?? 'reviewer',
          task: parsed.task,
          artifactId: randomUUID(),
        });
        marked.reviewerSessionId = request.sessionId;
      } catch (error) {
        if (releaseGrant) await releaseGrant(reserved.grantId, 'exited');
        throw error;
      }
      return (await finishExam(supervisor, principal, authority, request, releaseGrant, reserved.grantId, wait, undefined, poll)).output;
    },
  };
}
