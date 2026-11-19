import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {
  MODULE_CONTAINER_LABEL, MODULE_RUNTIME_BIN, createdContainerId, moduleContainerName, removeOwnedModuleContainer, type CollectorProcess,
} from '../src/module-container-cleanup.ts';
import {keepPersonalVerifyLease} from '../src/personal-verify-cli.ts';
import {assertPinnedModuleImage, listModuleReports, runBoundedCollectorProcess, runVerificationModule} from '../src/verification-modules.ts';
import {withModuleRecoveryFixture} from './fixtures/module-recovery.ts';

const enabled = process.env.AC_MODULE_CLEANUP_LAB === '1';
const fixtureOutput = {coverage: [{tool: 'fixture', version: '1', status: 'ok', detail: 'synthetic'}], findings: []};
const docker = (args: string[]) => runBoundedCollectorProcess([MODULE_RUNTIME_BIN, ...args],
  {timeoutMs: 3_000, maxStdoutBytes: 4096});

for (const scenario of ['lease', 'timeout', 'stdout', 'stderr', 'child-error'] as const) {
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
        : scenario === 'child-error'
          ? 'sleep 1; printf %s ' + "'" + JSON.stringify(fixtureOutput) + "'; exit 1"
        : scenario === 'stderr'
          ? 'sleep 1; dd if=/dev/zero bs=1048576 count=12 >&2 && printf "%s" ' + "'" + JSON.stringify(fixtureOutput) + "'"
          : 'exec sleep 60';
      const execute: CollectorProcess = async (args, options) => {
        if (args[1] === 'image' && args[2] === 'inspect') {
          // Only the workload is synthetic. Keep the production capture entrypoint and all daemon operations.
          const inspected = await runBoundedCollectorProcess(args, options);
          if (inspected.code !== 0) return inspected;
          assert.equal(args.at(-1), image);
          const command = scenario === 'stderr' ? [[''], ['/bin/sh', '-c', script]] : [['/bin/sh', '-c'], [script]];
          return {...inspected, stdout: Buffer.from(JSON.stringify(command))};
        }
        if (args[1] === 'create') {
          assert.equal(args[args.indexOf('--pull') + 1], 'never');
          owner = args[args.indexOf('--label') + 1]!.slice(MODULE_CONTAINER_LABEL.length + 1);
          const created = await runBoundedCollectorProcess(args, options);
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
          if (scenario === 'stderr') {
            assert.equal(result.hasToolFailure, false);
            assert.deepEqual(result.toolCoverage, fixtureOutput.coverage);
          } else if (scenario === 'child-error') {
            assert.equal(result.hasToolFailure, true);
            assert.ok(result.toolCoverage.some(row => row.tool === 'coletor' && row.detail === 'Processo terminou com código 1.'));
            assert.ok(result.toolCoverage.some(row => row.tool === 'fixture' && row.status === 'ok'));
          } else {
            assert.equal(result.hasToolFailure, true);
            assert.match(result.toolCoverage[0]!.detail, scenario === 'stdout' ? /VERIFY_STDOUT_LIMIT/ : /VERIFY_TOOLS_FAILED/);
          }
          assert.deepEqual((await listModuleReports(dataDirectory, projectId)).map(summary => summary.id), [runId]);
        }
        const absent = await docker(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `id=${containerId}`]);
        assert.equal(absent.code, 0);
        assert.equal(absent.stdout.toString().trim(), '');
        const state = await ledger.pool.query('SELECT status, collector_container_token FROM ac_verify_runs WHERE id=$1', [runId]);
        assert.deepEqual(state.rows[0], {status: scenario === 'stderr' ? 'done' : 'failed', collector_container_token: null});
      } finally {
        controller.abort();
        await task.catch(() => undefined);
        if (owner) await removeOwnedModuleContainer(runBoundedCollectorProcess, {token: owner, id: containerId}, async () => {});
      }
    });
  });
}


test('a CLI de Docker identifica a ausência de um digest antes de criar o contêiner', {
  skip: !process.env.AC_TEST_DATABASE_URL || process.env.AC_MODULE_LAB !== '1',
}, async () => {
  await withModuleRecoveryFixture(process.env.AC_TEST_DATABASE_URL!, async input => {
    const image = 'sha256:' + randomUUID().replaceAll('-', '').repeat(2);
    const operations: string[] = [];
    const result = await runVerificationModule({...input, image, executeCollectorProcess: async (args, options) => {
      operations.push(args.slice(1, 3).join(' '));
      return runBoundedCollectorProcess(args, options);
    }});
    assert.deepEqual(operations, ['image inspect']);
    assert.equal(result.hasToolFailure, true);
    assert.equal(result.toolCoverage[0]!.detail, 'Imagem fixada do módulo ausente no Docker local (VERIFY_MODULE_IMAGE_MISSING).');
    const {rows: [row]} = await input.ledger.pool.query(
      'SELECT collector_container_token FROM ac_verify_runs WHERE id=$1', [result.runId],
    );
    assert.equal(row.collector_container_token, null);
  });
});

test('o cleanup R7 remove o ID físico antes de liberar a autoridade sob a migração 114',
  {skip: !enabled, timeout: 45_000}, async () => {
    const databaseUrl = process.env.AC_TEST_DATABASE_URL;
    const image = process.env.AC_MODULE_CLEANUP_LAB_IMAGE;
    assert.ok(databaseUrl && image);
    assertPinnedModuleImage(image);
    // Exercise the shipped client verbatim, including its historical SQL, alongside the current schema.
    const root = fileURLToPath(new URL('../', import.meta.url));
    const legacy = execFileSync('git', ['show', 'e372b57ae4103c8d49be27e1534b69d24c43f33d:src/module-container-cleanup.ts'], {cwd: root});
    const folder = await mkdtemp(join(tmpdir(), 'ac-cleanup-r7-'));
    try {
      await writeFile(join(folder, 'r7.mts'), legacy);
      await symlink(join(root, 'src', 'contracts.ts'), join(folder, 'contracts.ts'));
      const {moduleContainerJournal} = await import(pathToFileURL(join(folder, 'r7.mts')).href) as typeof import('../src/module-container-cleanup.ts');
      await withModuleRecoveryFixture(databaseUrl, async base => {
        const {ledger, authority, principal} = base;
        const {runId} = await runVerificationModule({...base, collectorOutput: fixtureOutput});
        const token = randomUUID();
        const created = await docker(['create', '--pull', 'never', '--network', 'none', '--name', moduleContainerName(token),
          '--label', MODULE_CONTAINER_LABEL + '=' + token, '--entrypoint', '/bin/sh', image, '-c', 'exit 0']);
        assert.equal(created.code, 0);
        const id = createdContainerId(created.stdout);
        const transfer = () => ledger.pool.query('UPDATE ac_managers SET epoch=epoch+1 WHERE context_id=$1', [authority.contextId]);
        const pending = async () => (await ledger.pool.query(
          'SELECT collector_start_pending FROM ac_verify_runs WHERE id=$1 AND collector_container_token=$2 AND collector_container_id=$3',
          [runId, token, id])).rows[0]?.collector_start_pending;
        let physicallyRemoved = false;
        const observedDocker: CollectorProcess = async (args, options) => {
          const result = await runBoundedCollectorProcess(args, options);
          if (args[1] === 'container' && args[2] === 'rm') {
            assert.equal(args.at(-1), id);
            assert.equal(result.code, 0);
            const listing = await docker(['container', 'ls', '-aq', '--no-trunc', '--filter', 'id=' + id]);
            assert.equal(listing.code, 0);
            assert.equal(listing.stdout.toString().trim(), '');
            assert.equal(await pending(), true);
            await assert.rejects(transfer(), {message: 'VERIFY_CONTAINER_CLEANUP_PENDING'});
            physicallyRemoved = true;
          }
          return result;
        };
        try {
          // The historical writer has no knowledge of collector_start_pending.
          await ledger.pool.query('UPDATE ac_verify_runs SET collector_container_token=$2, collector_container_id=$3 WHERE id=$1',
            [runId, token, id]);
          assert.equal(await pending(), true);
          await assert.rejects(transfer(), {message: 'VERIFY_CONTAINER_CLEANUP_PENDING'});
          await moduleContainerJournal(ledger, principal, authority, runId, observedDocker).cleanup(token, id);
          assert.equal(physicallyRemoved, true);
          const {rows} = await ledger.pool.query(
            'SELECT collector_container_token, collector_container_id, collector_start_pending FROM ac_verify_runs WHERE id=$1', [runId]);
          assert.deepEqual(rows[0], {collector_container_token: null, collector_container_id: null, collector_start_pending: false});
          assert.equal((await transfer()).rowCount, 1);
        } finally {
          await removeOwnedModuleContainer(runBoundedCollectorProcess, {token, id}, async () => {});
        }
      });
    } finally {
      await rm(folder, {recursive: true, force: true});
    }
  });
