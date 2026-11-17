import {randomUUID} from 'node:crypto';
import {Refusal, type Authority} from './contracts.ts';
import type {Ledger} from './ledger.ts';
import {buildReadonlyExamRequest} from './verify-personal-worker.ts';
import {VerifyWorkerCall, type VerifyWorker} from './verify-types.ts';

// The native job may run until its 15 minute timeout. Polling every 2s has to outlast that.
const EXAM_ATTEMPTS = 480;
const EXAM_WAIT_MS = 2000;

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
  return {
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
      return finishExam(supervisor, principal, authority, request, releaseGrant, parsed.grantId, wait);
    },
  };
}

export function createRecheckNativeWorker(input: {
  supervisors: readonly SecurityExamSupervisor[];
  principal: string;
  authority: Authority;
  base: string;
  reserveReviewer(intentId: string): Promise<{grantId: string; accountId: string}>;
  releaseGrant?: ReleaseGrant;
  wait?: Wait;
}): VerifyWorker {
  const {supervisors, principal, authority, base, reserveReviewer, releaseGrant, wait = sleep} = input;
  return {
    async run(call) {
      const parsed = VerifyWorkerCall.parse(call);
      const reserved = await reserveReviewer(parsed.intentId);
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
          role: 'reviewer',
          task: parsed.task,
          artifactId: randomUUID(),
        });
      } catch (error) {
        if (releaseGrant) await releaseGrant(reserved.grantId, 'exited');
        throw error;
      }
      return finishExam(supervisor, principal, authority, request, releaseGrant, reserved.grantId, wait);
    },
  };
}
