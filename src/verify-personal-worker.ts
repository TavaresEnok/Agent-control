import {NativeExecutionRequest} from './native-execution-supervisor.ts';
import {Refusal} from './contracts.ts';
import {VerifyWorkerCall, type VerifyWorker} from './verify-types.ts';

const outputSchema = {
  type: 'object',
  additionalProperties: true,
};

/** Readonly native request. Specialist and reviewer never receive write paths. */
export function buildReadonlyExamRequest(input: {
  jobId: string;
  intentId: string;
  grantId: string;
  sessionId: string;
  base: string;
  role: 'specialist' | 'reviewer';
  task: string;
  artifactId: string;
}) {
  return NativeExecutionRequest.parse({
    jobId: input.jobId,
    intentId: input.intentId,
    grantId: input.grantId,
    sessionId: input.sessionId,
    base: input.base,
    role: input.role,
    task: input.task,
    writePaths: [],
    artifactId: input.artifactId,
    outputSchema,
  });
}

export function createPersonalVerifyWorker(input: {
  launch: (request: {
    role: 'specialist' | 'reviewer';
    task: string;
    writePaths: readonly [];
    intentId: string;
    grantId: string;
  }) => Promise<string>;
  identity: {
    provider: string;
    accountId: string;
    profileId: string;
    model: string;
    grantId: string;
    intentId: string;
    repo: string;
  };
}): VerifyWorker {
  const {launch, identity} = input;
  return {
    async run(call) {
      const parsed = VerifyWorkerCall.parse(call);
      if (parsed.provider !== identity.provider || parsed.accountId !== identity.accountId || parsed.profileId !== identity.profileId || parsed.model !== identity.model || parsed.repo !== identity.repo) {
        throw new Refusal('VERIFY_WORKER_IDENTITY_MISMATCH');
      }
      return launch({
        role: parsed.role,
        task: parsed.task,
        writePaths: [] as const,
        intentId: parsed.intentId || identity.intentId,
        grantId: parsed.grantId || identity.grantId,
      });
    },
  };
}
