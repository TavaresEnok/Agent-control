import {pollSchedule} from './manager-discipline.ts';
import {randomUUID} from 'node:crypto';
import {Refusal, type Authority} from './contracts.ts';
import {safeFailureCode} from './exam-login.ts';
import type {Ledger} from './ledger.ts';
import {DesignWorkerCall, type DesignWorker, type DesignPurpose} from './design-types.ts';
import {NativeExecutionRequest} from './native-execution-supervisor.ts';

// The native job may run until its 15 minute timeout. Polling every 2s has to outlast that.
const EXAM_ATTEMPTS = 480;
const EXAM_DEADLINE_MS = (EXAM_ATTEMPTS - 1) * 2000;
const EXAM_WAIT_MAX_MS = 10_000;
const EXAM_WAIT_MS = 2000;

const outputSchema = {
  type: 'object',
  additionalProperties: true,
};

export type DesignExamRequest = ReturnType<typeof buildDesignExamRequest>;

/** Structural view of NativeExecutionSupervisor. The daemon class is not imported here. */
export type DesignExamSupervisor = {
  active: boolean;
  supportsAccount(accountId: string): boolean;
  start(principal: string, authority: Authority, request: DesignExamRequest): Promise<{state: string}>;
  reconcile(principal: string, authority: Authority, request: DesignExamRequest): Promise<{state: string; output?: string; failureCode?: string | null}>;
  retireTerminal(principal: string, authority: Authority, jobId: string): Promise<unknown>;
};

type ReleaseGrant = (grantId: string, reason: 'exited') => Promise<void> | void;
type Wait = (ms: number) => Promise<void>;
type Poll = {attempts: number; waitMs: (attempt: number) => number};
const LEGACY_POLL: Poll = pollSchedule({backoff: false, baseMs: EXAM_WAIT_MS, maxMs: EXAM_WAIT_MS, deadlineMs: EXAM_DEADLINE_MS});
const BACKOFF_POLL: Poll = pollSchedule({backoff: true, baseMs: EXAM_WAIT_MS, maxMs: EXAM_WAIT_MAX_MS, deadlineMs: EXAM_DEADLINE_MS});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function terminal(state: string): boolean {
  return state === 'completed' || state === 'failed';
}

/** Readonly native request. Specialist and reviewer never receive write paths. */
export function buildDesignExamRequest(input: {
  jobId: string;
  intentId: string;
  grantId: string;
  sessionId: string;
  base: string;
  role: 'specialist' | 'reviewer';
  task: string;
  artifactId: string;
  designPurpose?: DesignPurpose;
  forcedModel?: 'claude-opus-5-5';
  forcedEffort?: 'high';
}) {
  return NativeExecutionRequest.parse({
    jobId: input.jobId,
    intentId: input.intentId,
    grantId: input.grantId,
    sessionId: input.sessionId,
    base: input.base,
    role: input.role,
    task: input.task,
    ...(input.designPurpose ? {designPurpose: input.designPurpose} : {}),
    writePaths: [],
    artifactId: input.artifactId,
    outputSchema,
    ...(input.forcedModel === undefined ? {} : {model: input.forcedModel, effort: input.forcedEffort ?? 'high'}),
  });
}

async function observeExam(
  supervisor: DesignExamSupervisor,
  principal: string,
  authority: Authority,
  request: DesignExamRequest,
  wait: Wait,
  poll: Poll = LEGACY_POLL,
): Promise<{state: string; output?: string; failureCode?: string | null}> {
  await supervisor.start(principal, authority, request);
  for (let attempt = 0; attempt < poll.attempts; attempt += 1) {
    const outcome = await supervisor.reconcile(principal, authority, request);
    if (terminal(outcome.state)) return outcome;
    if (attempt === poll.attempts - 1) throw new Error('DESIGN_EXAM_TIMEOUT');
    await wait(poll.waitMs(attempt));
  }
  throw new Error('DESIGN_EXAM_TIMEOUT');
}

async function finishExam(
  supervisor: DesignExamSupervisor,
  principal: string,
  authority: Authority,
  request: DesignExamRequest,
  releaseGrant: ReleaseGrant | undefined,
  grantId: string,
  wait: Wait,
  poll: Poll = LEGACY_POLL,
): Promise<string> {
  let outcome: {state: string; output?: string; failureCode?: string | null};
  try {
    outcome = await observeExam(supervisor, principal, authority, request, wait, poll);
  } catch (error) {
    if (releaseGrant) await releaseGrant(grantId, 'exited');
    throw error;
  }
  await supervisor.retireTerminal(principal, authority, request.jobId);
  if (outcome.state === 'failed') throw new Refusal(safeFailureCode(outcome.failureCode));
  return outcome.output ?? '';
}

export function createDesignNativeWorker(input: {
  supervisors: readonly DesignExamSupervisor[];
  principal: string;
  authority: Authority;
  /** Accepted so the CLI can pass the ledger. The exam does not query it. */
  ledger: Ledger;
  base: string;
  releaseGrant?: ReleaseGrant;
  wait?: Wait;
  /** Poll with a growing wait (default). False keeps the fixed 2 s wait. The total deadline is the same. */
  pollBackoff?: boolean;
}): DesignWorker {
  const {supervisors, principal, authority, base, releaseGrant, wait = sleep} = input;
  const poll = input.pollBackoff === false ? LEGACY_POLL : BACKOFF_POLL;
  return {
    async run(call) {
      const parsed = DesignWorkerCall.parse(call);
      const supervisor = supervisors.find(item => item.active && item.supportsAccount(parsed.accountId));
      if (!supervisor) throw new Refusal('DESIGN_WORKER_UNAVAILABLE');
      const request = buildDesignExamRequest({
        jobId: randomUUID(),
        intentId: parsed.intentId,
        grantId: parsed.grantId,
        sessionId: randomUUID(),
        base,
        role: parsed.role,
        task: parsed.task,
        designPurpose: parsed.designPurpose,
        artifactId: randomUUID(),
        ...(parsed.forcedModel === undefined ? {} : {forcedModel: parsed.forcedModel, forcedEffort: parsed.forcedEffort ?? 'high'}),
      });
      return finishExam(supervisor, principal, authority, request, releaseGrant, parsed.grantId, wait, poll);
    },
  };
}
