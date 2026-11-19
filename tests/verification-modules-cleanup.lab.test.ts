import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {
  MODULE_CONTAINER_LABEL, MODULE_RUNTIME_BIN, createdContainerId, removeOwnedModuleContainer, type CollectorProcess,
} from '../src/module-container-cleanup.ts';
import {keepPersonalVerifyLease} from '../src/personal-verify-cli.ts';
import {assertPinnedModuleImage, listModuleReports, runBoundedCollectorProcess, runVerificationModule} from '../src/verification-modules.ts';
import {withModuleRecoveryFixture} from './fixtures/module-recovery.ts';

const enabled = process.env.AC_MODULE_CLEANUP_LAB === '1';
const fixtureOutput = {coverage: [{tool: 'fixture', version: '1', status: 'ok', detail: 'synthetic'}], findings: []};
const docker = (args: string[]) => runBoundedCollectorProcess([MODULE_RUNTIME_BIN, ...args],
  {timeoutMs: 3_000, maxStdoutBytes: 4096});

for (const scenario of ['lease', 'timeout', 'stdout'] as const) {
  test(`laboratório de limpeza física do coletor (${scenario})`, {skip: !enabled, timeout: 45_000}, async () => {
    const databaseUrl = process.env.AC_TEST_DATABASE_URL;
    const image = process.env.AC_MODULE_CLEANUP_LAB_IMAGE;
    assert.ok(databaseUrl && image, 'Informe a base sintética isolada e o digest da imagem de fixture local.');
    assertPinnedModuleImage(image);
    await withModuleRecoveryFixture(databaseUrl, async base => {
      const {ledger, authority, principal, projectId, dataDirectory} = base;
      const runId = randomUUID();
      const controller = new AbortController();
      let owner: string | undefined;
      let containerId: string | null = null;
      let enteredStart!: () => void;
      const starting = new Promise<void>(resolve => {enteredStart = resolve;});
      const script = scenario === 'stdout'
        ? 'sleep 3; while :; do printf "%01024d\\n" 0; done'
        : 'exec sleep 60';
      const execute: CollectorProcess = async (args, options) => {
        if (args[1] === 'create') {
          assert.equal(args[args.indexOf('--pull') + 1], 'never');
          owner = args[args.indexOf('--label') + 1]!.slice(MODULE_CONTAINER_LABEL.length + 1);
          const created = await runBoundedCollectorProcess(
            [...args.slice(0, -1), '--entrypoint', '/bin/sh', image, '-c', script], options,
          );
          if (created.code === 0) containerId = createdContainerId(created.stdout);
          return created;
        }
        if (args[1] === 'start') enteredStart();
        return runBoundedCollectorProcess(args, options);
      };
      const task = runVerificationModule({
        ...base, runId, image, signal: controller.signal, executeCollectorProcess: execute,
        timeoutMs: 8_000, maxStdoutBytes: 4096,
      });
      void task.catch(() => undefined);
      try {
        await Promise.race([starting, task.then(() => {throw Error('Coleta terminou antes do start.');})]);
        assert.ok(containerId);
        let running = false;
        for (let attempt = 0; attempt < 30 && !running; attempt++) {
          const inspected = await docker(['container', 'inspect', '--format', '{{.State.Running}}', containerId]);
          running = inspected.code === 0 && inspected.stdout.toString().trim() === 'true';
          if (!running) await delay(75);
        }
        assert.ok(running, 'O processo da fixture deve estar em execução no daemon.');
        if (scenario === 'lease') {
          await ledger.releaseLease(authority);
          const stopHeartbeat = keepPersonalVerifyLease(ledger, authority, 100, () => controller.abort());
          try {
            await assert.rejects(task, (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_TOOLS_FAILED');
            assert.ok(controller.signal.aborted);
          } finally {
            stopHeartbeat();
          }
          const next = await ledger.acquire(principal, authority.contextId, randomUUID(), 'lab-recovery', 60);
          const result = await runVerificationModule({...base, authority: next, collectorOutput: fixtureOutput});
          assert.deepEqual((await listModuleReports(dataDirectory, projectId)).map(summary => summary.id), [result.runId]);
        } else {
          const result = await task;
          assert.equal(result.hasToolFailure, true);
          assert.match(result.toolCoverage[0]!.detail, scenario === 'stdout' ? /VERIFY_STDOUT_LIMIT/ : /VERIFY_TOOLS_FAILED/);
          assert.deepEqual((await listModuleReports(dataDirectory, projectId)).map(summary => summary.id), [runId]);
        }
        const absent = await docker(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `id=${containerId}`]);
        assert.equal(absent.code, 0);
        assert.equal(absent.stdout.toString().trim(), '');
        const state = await ledger.pool.query('SELECT status, collector_container_token FROM ac_verify_runs WHERE id=$1', [runId]);
        assert.deepEqual(state.rows[0], {status: 'failed', collector_container_token: null});
      } finally {
        controller.abort();
        await task.catch(() => undefined);
        if (owner) await removeOwnedModuleContainer(runBoundedCollectorProcess, {token: owner, id: containerId}, async () => {});
      }
    });
  });
}
