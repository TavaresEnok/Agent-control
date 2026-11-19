import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {Capacity} from './capacity.ts';
import {Refusal, type Authority} from './contracts.ts';
import {reserveSpecialistExamSeat} from './exam-provider.ts';
import type {Ledger} from './ledger.ts';
import {safeFailureCode} from './exam-login.ts';
import {readPrivateFile, type Installation} from './installation.ts';
import {type ModuleExamProvider, moduleExamProviders} from './module-exam-egress.ts';
import {examineFunctionalModule, type ModuleExamInput, type ModuleExamResult, type ModuleExamSeat, type ModuleExamWorker} from './module-exam.ts';
import {mapModuleSnapshot} from './module-exam-map.ts';
import {NativeExecutionRequest, NativeExecutionSupervisor} from './native-execution-supervisor.ts';
import {renewPersonalQuota} from './personal-runtime.ts';
import type {VerificationModuleRunInput} from './verification-modules.ts';

/** Uses the dedicated exam context and Capacity's project, profile and quota policy.
 * A reviewer is never silently downgraded to the examiner's provider. */
export function createModuleExamReservations(input: {
  ledger: Ledger; principal: string; authority: Authority; intentId: string;
  supportedSeats: ReadonlyMap<ModuleExamProvider, ReadonlySet<string>>;
}): Pick<Required<ModuleExamInput>, 'reserve'|'release'> {
  const capacity = new Capacity(input.ledger);
  const release = async (seat: ModuleExamSeat, state: 'not_started'|'exited') => {
    await capacity.transition(input.principal, seat.grantId, input.authority, 'released', {processId: seat.grantId, state});
  };
  return {
    release,
    async reserve(purpose, avoid) {
      if (purpose === 'examiner') {
        const accounts = input.supportedSeats.get('claude');
        if (!accounts?.size) throw new Refusal('MODULE_EXAM_EXAMINER_UNAVAILABLE');
        const seat = await reserveSpecialistExamSeat({capacity, ledger: input.ledger, principal: input.principal,
          authority: input.authority, intentId: input.intentId, purpose: 'examiner', allowedAccounts: [...accounts],
          releaseGrant: async grantId => { await capacity.transition(input.principal, grantId, input.authority, 'released', {processId: grantId, state: 'not_started'}); }});
        if (!accounts.has(seat.accountId)) {
          await release(seat, 'not_started');
          throw new Refusal('MODULE_EXAM_EXAMINER_UNAVAILABLE');
        }
        return seat;
      }
      if (!avoid) throw new Refusal('MODULE_EXAM_EXAMINER_REQUIRED');
      for (const [provider, accounts] of input.supportedSeats) {
        if (provider === avoid.provider || !accounts.size) continue;
        try {
          const seat = await capacity.reserveWithSeat(input.principal, {attemptId: randomUUID(), intentId: input.intentId,
            contextId: input.authority.contextId, role: 'specialist', provider, allowedAccounts: [...accounts], avoidProfiles: [avoid.profileId]}, input.authority);
          const result = {provider: seat.provider, model: seat.model, accountId: seat.grant.account_id, profileId: seat.grant.profile_id, grantId: seat.grant.id};
          if (result.provider === avoid.provider || result.profileId === avoid.profileId) {
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
    },
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
        const request = NativeExecutionRequest.parse({
          jobId, intentId: call.intentId, grantId: call.grantId, sessionId: randomUUID(), base: input.commit,
          role: 'specialist', task: call.task, writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
          moduleExam: {accountId: call.accountId, profileId: call.profileId, model: call.model}, timeoutMs,
        });
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

export type ModuleExamCallback = NonNullable<VerificationModuleRunInput['examinar']>;

export function createPersonalModuleExam(input: Omit<WorkerInput, 'intentId' | 'runtime' | 'signal'> & {
  loadRuntime: () => Promise<ModuleExamRuntime>;
  isolatedMeasurements?: boolean;
}): ModuleExamCallback {
  return async ({intentId, snapshot, module, findings, signal}): Promise<ModuleExamResult> => {
    const map = await mapModuleSnapshot(snapshot, signal);
    if (input.isolatedMeasurements) return examineFunctionalModule({intentId, module, map, findings, signal, isolatedMeasurements: true});
    let runtime: ModuleExamRuntime;
    try { runtime = await input.loadRuntime(); }
    catch { return examineFunctionalModule({intentId, module, map, findings, signal, unavailable: 'MODULE_EXAM_RUNTIME_UNAVAILABLE'}); }
    if (!runtime.some(seat => seat.provider === 'claude')) {
      return examineFunctionalModule({intentId, module, map, findings, signal, unavailable: 'MODULE_EXAM_EXAMINER_UNAVAILABLE'});
    }
    return examineFunctionalModule({intentId, module, map, findings, signal,
      worker: createModuleExamNativeWorker({...input, intentId, runtime, signal}),
      ...createModuleExamReservations({...input, intentId, supportedSeats: new Map(runtime.map(seat => [seat.provider, seat.accountIds]))}),
    });
  };
}
