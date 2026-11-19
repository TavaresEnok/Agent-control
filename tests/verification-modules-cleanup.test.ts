import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {MODULE_CONTAINER_LABEL, moduleContainerName, type CollectorProcess} from '../src/module-container-cleanup.ts';
import {listModuleReports, runBoundedCollectorProcess, runVerificationModule} from '../src/verification-modules.ts';
import {withModuleRecoveryFixture} from './fixtures/module-recovery.ts';

const databaseUrl = process.env.AC_TEST_DATABASE_URL;
const image = `sha256:${'b'.repeat(64)}`;
const containerId = 'a'.repeat(64);
const pending = (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_CONTAINER_CLEANUP_PENDING';
const output = {coverage: [{tool: 'fixture', version: '1', status: 'ok', detail: 'synthetic'}], findings: []};
const reply = (code: number, stdout = '') => ({code, stdout: Buffer.from(stdout), stderr: ''});

test('lease perdido mantém limpeza pendente e retry só remove o contêiner identificado', {skip: !databaseUrl}, async () => {
  await withModuleRecoveryFixture(databaseUrl!, async base => {
    const {ledger, principal, authority, projectId, dataDirectory} = base;
    const runId = randomUUID();
    const controller = new AbortController();
    let started!: () => void;
    const enteredStart = new Promise<void>(resolve => {started = resolve;});
    let owner = '';
    let running = false;
    let removed = false;
    let removalAttempts = 0;
    let daemon: 'ok' | 'offline' | 'foreign' | 'rm-fails' | 'recheck-fails' = 'ok';
    const execute: CollectorProcess = async (argv, options) => {
      if (argv[1] === 'create') {
        owner = argv[argv.indexOf('--label') + 1]!.slice(MODULE_CONTAINER_LABEL.length + 1);
        assert.equal(argv[argv.indexOf('--name') + 1], moduleContainerName(owner));
        assert.equal(argv[argv.indexOf('--pull') + 1], 'never');
        assert.equal((await ledger.pool.query('SELECT collector_container_token FROM ac_verify_runs WHERE id=$1', [runId])).rows[0].collector_container_token, owner);
        return reply(0, containerId);
      }
      if (argv[1] === 'start') {
        assert.deepEqual(argv.slice(1), ['start', '--attach', containerId]);
        assert.equal((await ledger.pool.query('SELECT collector_container_id FROM ac_verify_runs WHERE id=$1', [runId])).rows[0].collector_container_id, containerId);
        running = true;
        started();
        return new Promise((_, reject) => options.signal!.addEventListener('abort',
          () => reject(new Refusal('VERIFY_TOOLS_FAILED', 503)), {once: true}));
      }
      if (argv[2] === 'ls') {
        assert.ok(argv.includes(`id=${containerId}`));
        if (daemon === 'offline' || (daemon === 'recheck-fails' && removed)) return reply(1);
        if (daemon === 'foreign') return reply(0, `${containerId} foreign ${randomUUID()}`);
        return reply(0, removed ? '' : `${containerId} ${moduleContainerName(owner)} ${owner}`);
      }
      assert.deepEqual(argv.slice(1), ['container', 'rm', '--force', containerId]);
      removalAttempts++;
      if (daemon === 'rm-fails') return reply(1);
      running = false;
      removed = true;
      return reply(0, containerId);
    };
    const task = runVerificationModule({...base, runId, image, signal: controller.signal, executeCollectorProcess: execute});
    const taskRejected = assert.rejects(task, pending);
    void taskRejected.catch(() => undefined);
    try {
      await Promise.race([enteredStart, task]);
      daemon = 'offline';
      await ledger.releaseLease(authority);
    } finally {
      controller.abort();
    }
    await taskRejected;
    assert.equal(running, true);
    assert.deepEqual(await listModuleReports(dataDirectory, projectId), []);
    const next = await ledger.acquire(principal, authority.contextId, randomUUID(), 'next-recovery', 60);
    const retry = () => runVerificationModule({...base, authority: next, collectorOutput: output, executeCollectorProcess: execute});
    daemon = 'foreign';
    await assert.rejects(retry(), pending);
    assert.equal(removalAttempts, 0);
    daemon = 'rm-fails';
    await assert.rejects(retry(), pending);
    assert.equal(running, true);
    daemon = 'recheck-fails';
    await assert.rejects(retry(), pending);
    assert.equal(running, false);
    const state = async () => (await ledger.pool.query(
      'SELECT status, collector_container_token, collector_container_id FROM ac_verify_runs WHERE id=$1', [runId],
    )).rows[0];
    assert.deepEqual(await state(), {status: 'failed', collector_container_token: owner, collector_container_id: containerId});
    daemon = 'ok';
    const report = await retry();
    assert.equal(removalAttempts, 2);
    assert.deepEqual(await state(), {status: 'failed', collector_container_token: null, collector_container_id: null});
    assert.deepEqual((await listModuleReports(dataDirectory, projectId)).map(item => item.id), [report.runId]);
  });
});

test('create sem ACK redescobre o ID pelo token antes de remover', {skip: !databaseUrl}, async () => {
  await withModuleRecoveryFixture(databaseUrl!, async base => {
    const {ledger} = base;
    const runId = randomUUID();
    let owner = '';
    let failList = true;
    let removed = false;
    const execute: CollectorProcess = async argv => {
      if (argv[1] === 'create') {
        owner = argv[argv.indexOf('--label') + 1]!.slice(MODULE_CONTAINER_LABEL.length + 1);
        return reply(1);
      }
      if (argv[2] === 'ls') {
        if (failList) return reply(1);
        assert.ok(argv.includes(removed ? `id=${containerId}` : `label=${MODULE_CONTAINER_LABEL}=${owner}`));
        return reply(0, removed ? '' : `${containerId} ${moduleContainerName(owner)} ${owner}`);
      }
      assert.deepEqual(argv.slice(1), ['container', 'rm', '--force', containerId]);
      assert.equal((await ledger.pool.query('SELECT collector_container_id FROM ac_verify_runs WHERE id=$1', [runId])).rows[0].collector_container_id, containerId);
      removed = true;
      return reply(0, containerId);
    };
    await assert.rejects(runVerificationModule({...base, runId, image, executeCollectorProcess: execute}), pending);
    assert.equal((await ledger.pool.query('SELECT collector_container_id FROM ac_verify_runs WHERE id=$1', [runId])).rows[0].collector_container_id, null);
    failList = false;
    await runVerificationModule({...base, collectorOutput: output, executeCollectorProcess: execute});
    assert.equal(removed, true);
    assert.equal((await ledger.pool.query('SELECT collector_container_token FROM ac_verify_runs WHERE id=$1', [runId])).rows[0].collector_container_token, null);
  });
});

for (const scenario of ['timeout', 'stdout'] as const) {
  test(`${scenario} publica a falha após confirmar a remoção no daemon simulado`, {skip: !databaseUrl}, async () => {
    await withModuleRecoveryFixture(databaseUrl!, async base => {
      let owner = '';
      let removed = false;
      const execute: CollectorProcess = async (argv, options) => {
        if (argv[1] === 'create') {
          owner = argv[argv.indexOf('--label') + 1]!.slice(MODULE_CONTAINER_LABEL.length + 1);
          return reply(0, containerId);
        }
        if (argv[1] === 'start') {
          const script = scenario === 'timeout' ? 'setInterval(() => {}, 1000)' : 'process.stdout.write(Buffer.alloc(8192))';
          return runBoundedCollectorProcess([process.execPath, '-e', script], options);
        }
        if (argv[2] === 'ls') {
          return reply(0, removed ? '' : `${containerId} ${moduleContainerName(owner)} ${owner}`);
        }
        assert.deepEqual(argv.slice(1), ['container', 'rm', '--force', containerId]);
        removed = true;
        return reply(0, containerId);
      };
      const report = await runVerificationModule({...base, image, executeCollectorProcess: execute, maxStdoutBytes: 1024,
        timeoutMs: scenario === 'timeout' ? 150 : 3000});
      assert.equal(removed, true);
      assert.equal(report.hasToolFailure, true);
      assert.match(report.toolCoverage[0]!.detail, scenario === 'timeout' ? /VERIFY_TOOLS_FAILED/ : /VERIFY_STDOUT_LIMIT/);
      assert.deepEqual((await listModuleReports(base.dataDirectory, base.projectId)).map(item => item.id), [report.runId]);
      assert.deepEqual((await base.ledger.pool.query(
        'SELECT status, collector_container_token FROM ac_verify_runs WHERE id=$1', [report.runId],
      )).rows[0], {status: 'failed', collector_container_token: null});
    });
  });
}
