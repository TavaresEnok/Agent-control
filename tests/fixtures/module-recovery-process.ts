// Child of verification-modules-cleanup.test.ts: the host disk is not what it proves, so it reads the same fixed figure.
import {useFixedDisk} from './fixed-disk.ts';
useFixedDisk();
import {randomUUID} from 'node:crypto';
import {Refusal, type Authority} from '../../src/contracts.ts';
import {Ledger} from '../../src/ledger.ts';
import {runBoundedCollectorProcess, runVerificationModule, type VerificationModuleRunInput} from '../../src/verification-modules.ts';
import type {CollectorProcess} from '../../src/module-container-cleanup.ts';

export type ModuleRecoveryRequest = {
  databaseUrl: string;
  daemonUrl: string;
  input: Pick<VerificationModuleRunInput, 'principal' | 'authority' | 'projectId' | 'module' | 'repoPath' | 'dataDirectory' | 'commit'>;
  start?: {runId: string; image: string};
};

export type ModuleRecoveryResult = {pid: number; authority?: Authority; error?: string};

process.once('message', async (request: ModuleRecoveryRequest) => {
  const ledger = new Ledger(request.databaseUrl);
  const execute: CollectorProcess = async (args, options) => {
    const body = JSON.stringify(args);
    if (args[1] === 'start') {
      const requestStart = 'fetch(process.argv[1], {method: "POST", body: process.argv[2]}).catch(() => {process.exitCode = 1;})';
      return runBoundedCollectorProcess([process.execPath, '-e', requestStart, request.daemonUrl, body], options);
    }
    const response = await fetch(request.daemonUrl, {method: 'POST', body, signal: AbortSignal.timeout(options.timeoutMs)});
    const result = await response.json() as {code: number; stdout: string; stderr: string};
    return {...result, stdout: Buffer.from(result.stdout)};
  };
  const result: ModuleRecoveryResult = {pid: process.pid};
  try {
    if (request.start) {
      await runVerificationModule({...request.input, ...request.start, ledger, timeoutMs: 900, executeCollectorProcess: execute});
    } else {
      const {principal, authority} = request.input;
      result.authority = await ledger.acquire(principal, authority.contextId, randomUUID(), 'synthetic-successor', 60, execute);
    }
  } catch (error) {
    result.error = error instanceof Refusal ? error.code : String(error);
  } finally {
    await ledger.close();
  }
  process.send!(result, () => process.disconnect!());
});
