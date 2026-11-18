import {randomUUID} from 'node:crypto';
import {Refusal, type Authority} from './contracts.ts';
import type {Ledger} from './ledger.ts';
import {buildReadonlyExamRequest} from './verify-personal-worker.ts';
import {VerifyWorkerCall, type VerifyWorker} from './verify-types.ts';

// The native job may run until its 15 minute timeout. Polling every 2s has to outlast that.
const EXAM_ATTEMPTS = 480;
const EXAM_WAIT_MS = 2000;
const STOP_CONFIRM_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

export type SecurityExamRequest = ReturnType<typeof buildReadonlyExamRequest>;

/** Structural view of NativeExecutionSupervisor. The daemon is not imported here. */
export type SecurityExamSupervisor = {
  active: boolean;
  supportsAccount(accountId: string): boolean;
  start(principal: string, authority: Authority, request: SecurityExamRequest): Promise<{state: string}>;
  reconcile(principal: string, authority: Authority, request: SecurityExamRequest): Promise<{state: string; output?: string}>;
  retireTerminal(principal: string, authority: Authority, jobId: string): Promise<unknown>;
  stop?(principal: string, authority: Authority, request: SecurityExamRequest): Promise<{state: string}>;
};

type ReleaseGrant = (grantId: string, reason: 'exited') => Promise<void> | void;
type Wait = (ms: number) => Promise<void>;

function terminal(state: string): boolean {
  return state === 'completed' || state === 'failed';
}

async function observeExam(
  supervisor: SecurityExamSupervisor,
  principal: string,
  authority: Authority,
  request: SecurityExamRequest,
  wait: Wait,
): Promise<{state: string; output?: string}> {
  await supervisor.start(principal, authority, request);
  for (let attempt = 0; attempt < EXAM_ATTEMPTS; attempt += 1) {
    const outcome = await supervisor.reconcile(principal, authority, request);
    if (terminal(outcome.state)) return outcome;
    if (attempt === EXAM_ATTEMPTS - 1) throw new Error('VERIFY_EXAM_TIMEOUT');
    await wait(EXAM_WAIT_MS);
  }
  throw new Error('VERIFY_EXAM_TIMEOUT');
}

function examTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'VERIFY_EXAM_TIMEOUT';
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
): Promise<string> {
  let outcome: {state: string; output?: string};
  try {
    outcome = await observeExam(supervisor, principal, authority, request, wait);
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
  await supervisor.retireTerminal(principal, authority, request.jobId);
  return outcome.output ?? '';
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
}): VerifyWorker {
  const {supervisors, principal, authority, base, releaseGrant, wait = sleep} = input;
  let active: {supervisor: SecurityExamSupervisor; request: SecurityExamRequest} | null = null;
  return {
    async stop() {
      const current = active;
      const stop = current?.supervisor.stop?.bind(current.supervisor);
      if (!current || !stop) return;
      await stop(principal, authority, current.request);
    },
    async run(call) {
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
        return await finishExam(supervisor, principal, authority, request, releaseGrant, parsed.grantId, wait);
      } finally {
        if (active?.request === request) active = null;
      }
    },
  };
}

export function createRecheckNativeWorker(input: {
  supervisors: readonly SecurityExamSupervisor[];
  principal: string;
  authority: Authority;
  base: string;
  reserveReviewer(intentId: string, avoidProviders?: readonly string[]): Promise<{grantId: string; accountId: string; provider: string; role?: 'specialist' | 'reviewer'}>;
  releaseGrant?: ReleaseGrant;
  wait?: Wait;
}): VerifyWorker {
  const {supervisors, principal, authority, base, reserveReviewer, releaseGrant, wait = sleep} = input;
  return {
    async run(call) {
      const parsed = VerifyWorkerCall.parse(call);
      const reserved = await reserveReviewer(parsed.intentId, parsed.avoidProviders);
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
      return finishExam(supervisor, principal, authority, request, releaseGrant, reserved.grantId, wait);
    },
  };
}
