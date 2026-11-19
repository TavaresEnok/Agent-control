import assert from 'node:assert/strict';
import {ChildProcess, fork} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {Refusal} from '../src/contracts.ts';
import {COLLECTOR_CAPTURE_DIR, COLLECTOR_HEADER_BYTES, COLLECTOR_WRAPPER_PATH} from '../src/module-collector-output.ts';
import {MODULE_CONTAINER_LABEL, moduleContainerName, type CollectorProcess} from '../src/module-container-cleanup.ts';
import type {Ledger} from '../src/ledger.ts';
import {MAX_COLLECTOR_STDOUT_BYTES, listModuleReports, runBoundedCollectorProcess, runModuleCollectorContainer, runVerificationModule} from '../src/verification-modules.ts';
import {withModuleRecoveryFixture} from './fixtures/module-recovery.ts';
import type {ModuleRecoveryRequest, ModuleRecoveryResult} from './fixtures/module-recovery-process.ts';

const databaseUrl = process.env.AC_TEST_DATABASE_URL;
const image = `sha256:${'b'.repeat(64)}`;
const containerId = 'a'.repeat(64);
const pending = (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_CONTAINER_CLEANUP_PENDING';
const output = {coverage: [{tool: 'fixture', version: '1', status: 'ok', detail: 'synthetic'}], findings: []};
const reply = (code: number, stdout = '') => ({code, stdout: Buffer.from(stdout), stderr: ''});
const collectorLogs = JSON.stringify(output);
const imageCommand = (script = '', args: string[] = []) => reply(0, JSON.stringify([[process.execPath, '-e', script, '--'], args]));

function framedOutput(token: string, code: number, payload: string) {
  const hash = createHash('sha256').update(payload).digest('hex');
  return reply(code, `ac-collector-v1 ${token} ${code} ${Buffer.byteLength(payload)} ${hash}\n${payload}`);
}

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}

async function waitForBlockedQuery(ledger: Ledger, sql: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const {rowCount} = await ledger.pool.query(`SELECT 1 FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid() AND strpos(query, $1)>0
        AND cardinality(pg_blocking_pids(pid))>0`, [sql]);
    if (rowCount) return;
    await delay(10);
  }
  assert.fail(`A consulta não aguardou a reserva: ${sql}`);
}

test('a partida exige journal antes de criar snapshot ou chamar o daemon', async () => {
  await assert.rejects(runModuleCollectorContainer({
    image, repoPath: '/fixture-inexistente', commit: 'a'.repeat(40),
    journal: undefined as unknown as Parameters<typeof runModuleCollectorContainer>[0]['journal'],
    executeProcess: async () => assert.fail('O daemon não deveria ser chamado.'),
  }), (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_CONTAINER_JOURNAL_REQUIRED');
});

test('o prazo do cliente expira mesmo sem o evento close', {timeout: 3_000}, async t => {
  const closed = barrier();
  const script = 'setInterval(() => {}, 1000); // synthetic-close';
  const emit = ChildProcess.prototype.emit;
  t.mock.method(ChildProcess.prototype, 'emit', function (this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    if (event === 'close' && this.spawnargs.includes(script)) {
      closed.resolve();
      return false;
    }
    return Reflect.apply(emit, this, [event, ...args]);
  });
  const timedOut = runBoundedCollectorProcess([process.execPath, '-e', script], {timeoutMs: 80, maxStdoutBytes: 1024});
  await assert.rejects(timedOut, {code: 'VERIFY_TOOLS_FAILED'});
  const reaping = new AbortController();
  try {
    await Promise.race([closed.promise, delay(1000, undefined, {signal: reaping.signal})
      .then(() => assert.fail('O cliente sintético não foi encerrado.'))]);
  } finally {
    reaping.abort();
  }
});

function runRecoveryProcess(request: ModuleRecoveryRequest): Promise<ModuleRecoveryResult> {
  const child = fork(fileURLToPath(new URL('./fixtures/module-recovery-process.ts', import.meta.url)), {
    execArgv: ['--import', 'tsx'],
  });
  return new Promise((resolve, reject) => {
    let result: ModuleRecoveryResult | undefined;
    child.once('message', message => { result = message as ModuleRecoveryResult; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0 && result) resolve(result);
      else reject(new Error(`Processo sintético de recuperação terminou com código ${code}`));
    });
    child.send(request);
  });
}

test('a recuperação em outro processo neutraliza a partida tardia antes de transferir a autoridade', {
  skip: !databaseUrl, timeout: 15_000,
}, async () => {
  await withModuleRecoveryFixture(databaseUrl!, async ({ledger, ...input}) => {
    const {authority, dataDirectory, projectId} = input;
    const runId = randomUUID();
    const queued = barrier();
    let token = '';
    let state: 'created' | 'queued' | 'running' | 'removed' = 'created';
    let reachable = true;
    let foreign = false;
    let removalAttempts = 0;
    let daemonError: unknown;
    const daemon = createServer((req, res) => {
      const respond = async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const argv = JSON.parse(Buffer.concat(chunks).toString()) as string[];
        const send = (code: number, stdout = '') => res.end(JSON.stringify({code, stdout, stderr: ''}));
        if (argv[1] === 'image') {
          send(0, imageCommand().stdout.toString());
        } else if (argv[1] === 'create') {
          token = argv[argv.indexOf('--label') + 1]!.split('=')[1]!;
          send(0, containerId);
        } else if (argv[1] === 'start') {
          assert.deepEqual(argv.slice(1), ['start', '--attach', containerId]);
          state = 'queued';
          reachable = false;
          queued.resolve();
          // The client times out independently. The daemon retains the request.
        } else if (argv[2] === 'inspect') {
          send(0, `${containerId} created`);
        } else if (argv[2] === 'ls') {
          assert.ok(argv.includes(`id=${containerId}`));
          if (!reachable) send(1);
          else send(0, state === 'removed' ? '' : `${containerId} ${moduleContainerName(token)} ${foreign ? randomUUID() : token}`);
        } else {
          assert.deepEqual(argv.slice(1), ['container', 'rm', '--force', containerId]);
          removalAttempts++;
          if (state === 'running') state = 'removed';
          // While start is in flight the simulated daemon is busy. After
          // removal it loses the ACK, requiring a successful absence check.
          send(1);
        }
      };
      void respond().catch(error => { daemonError = error; res.destroy(); });
    });
    await new Promise<void>((resolve, reject) => {
      daemon.once('error', reject);
      daemon.listen(0, '127.0.0.1', resolve);
    });
    const address = daemon.address();
    assert.ok(address && typeof address !== 'string');
    const request = {databaseUrl: ledger.pool.options.connectionString!, daemonUrl: `http://127.0.0.1:${address.port}`, input};
    const journal = async () => (await ledger.pool.query(
      'SELECT status, collector_container_token, collector_container_id, collector_start_pending FROM ac_verify_runs WHERE id=$1', [runId],
    )).rows[0];
    const epoch = async () => Number((await ledger.pool.query('SELECT epoch FROM ac_managers WHERE context_id=$1', [authority.contextId])).rows[0].epoch);
    const launcher = runRecoveryProcess({...request, start: {runId, image}});
    try {
      await Promise.race([queued.promise, launcher.then(result => assert.fail(JSON.stringify(result)))]);
      assert.deepEqual(await journal(), {status: 'running', collector_container_token: token,
        collector_container_id: containerId, collector_start_pending: true});
      const timedOut = await launcher;
      assert.equal(timedOut.error, 'VERIFY_CONTAINER_CLEANUP_PENDING');
      assert.equal(state, 'queued');
      assert.deepEqual(await listModuleReports(dataDirectory, projectId), []);
      await ledger.releaseLease(authority);
      await assert.rejects(ledger.pool.query('UPDATE ac_managers SET epoch=epoch+1 WHERE context_id=$1', [authority.contextId]),
        {message: 'VERIFY_CONTAINER_CLEANUP_PENDING'});
      reachable = true;
      foreign = true;
      assert.equal((await runRecoveryProcess(request)).error, 'VERIFY_CONTAINER_CLEANUP_PENDING');
      assert.equal(removalAttempts, 0);
      foreign = false;
      const blocked = await runRecoveryProcess(request);
      assert.equal(blocked.error, 'VERIFY_CONTAINER_CLEANUP_PENDING');
      assert.equal(removalAttempts, 1);
      assert.equal(await epoch(), authority.epoch);
      assert.deepEqual(await journal(), {status: 'failed', collector_container_token: token,
        collector_container_id: containerId, collector_start_pending: true});

      state = 'running';
      const recovered = await runRecoveryProcess(request);
      assert.equal(recovered.error, undefined);
      assert.ok(recovered.authority);
      assert.equal(recovered.authority.epoch, authority.epoch + 1);
      assert.notEqual(recovered.pid, timedOut.pid);
      assert.notEqual(recovered.pid, process.pid);
      assert.equal(state, 'removed');
      assert.equal(removalAttempts, 2);
      assert.deepEqual(await journal(), {status: 'failed', collector_container_token: null,
        collector_container_id: null, collector_start_pending: false});
      assert.equal(daemonError, undefined);
      const report = await runVerificationModule({...input, ledger, authority: recovered.authority, collectorOutput: output,
        executeCollectorProcess: async () => assert.fail('O journal já foi limpo.')});
      assert.equal(report.hasToolFailure, false);
    } finally {
      daemon.closeAllConnections();
      await new Promise<void>(resolve => daemon.close(() => resolve()));
      await launcher.catch(() => undefined);
    }
  });
});

test('lease perdido mantém limpeza pendente e retry só remove o contêiner identificado', {skip: !databaseUrl}, async () => {
  await withModuleRecoveryFixture(databaseUrl!, async base => {
    const {ledger, principal, authority, projectId, dataDirectory} = base;
    const runId = randomUUID();
    const controller = new AbortController();
    const launched = barrier();
    const collecting = barrier();
    let owner = '';
    let running = false;
    let removed = false;
    let removalAttempts = 0;
    let daemon: 'ok' | 'offline' | 'foreign' | 'rm-fails' | 'recheck-fails' = 'ok';
    const execute: CollectorProcess = async (argv, options) => {
      if (argv[1] === 'image') return imageCommand();
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
        launched.resolve();
        return new Promise((_, reject) => options.signal!.addEventListener('abort',
          () => reject(new Refusal('VERIFY_TOOLS_FAILED', 503)), {once: true}));
      }
      if (argv[2] === 'inspect') {
        await launched.promise;
        collecting.resolve();
        return reply(0, `${containerId} running`);
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
      await Promise.race([collecting.promise, task]);
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

test('a aquisição aguarda a resposta de partida e prossegue durante a coleta', {skip: !databaseUrl, timeout: 15_000}, async () => {
  await withModuleRecoveryFixture(databaseUrl!, async base => {
    const {ledger, principal, authority} = base;
    const runId = randomUUID();
    const started = barrier();
    const ack = barrier();
    const collecting = barrier();
    const controller = new AbortController();
    let token = '', removed = false;
    const execute: CollectorProcess = async (argv, options) => {
      if (argv[1] === 'image') return imageCommand();
      if (argv[1] === 'create') {
        token = argv[argv.indexOf('--label') + 1]!.split('=')[1]!;
        return reply(0, containerId);
      }
      if (argv[1] === 'start') {
        assert.deepEqual(argv.slice(1), ['start', '--attach', containerId]);
        started.resolve();
        return new Promise((_, reject) => options.signal!.addEventListener('abort',
          () => reject(new Refusal('VERIFY_TOOLS_FAILED', 503)), {once: true}));
      }
      if (argv[2] === 'inspect') {
        assert.equal(argv.at(-1), containerId);
        await ack.promise;
        collecting.resolve();
        return reply(0, `${containerId} running`);
      }
      if (argv[2] === 'ls') return reply(0, removed ? '' : `${containerId} ${moduleContainerName(token)} ${token}`);
      assert.deepEqual(argv.slice(1), ['container', 'rm', '--force', containerId]);
      removed = true;
      return reply(0);
    };
    const task = runVerificationModule({...base, runId, image, signal: controller.signal, executeCollectorProcess: execute});
    void task.catch(() => undefined);
    let release: Promise<void> | undefined;
    let successor: ReturnType<Ledger['acquire']> | undefined;
    try {
      await Promise.race([started.promise, task]);
      release = ledger.releaseLease(authority);
      await waitForBlockedQuery(ledger, 'UPDATE ac_managers SET lease_until');
      successor = ledger.acquire(principal, authority.contextId, randomUUID(), 'next-during-start', 60);
      void successor.catch(() => undefined);
      await waitForBlockedQuery(ledger, 'FROM ac_contexts x JOIN ac_memberships m');
      ack.resolve();
      await release;
      await Promise.race([collecting.promise, task]);
      const next = await successor;
      assert.equal(next.epoch, authority.epoch + 1);
      assert.equal(removed, false);
      controller.abort();
      await assert.rejects(task, {code: 'VERIFY_TOOLS_FAILED'});
      assert.equal(removed, true);
      await runVerificationModule({...base, authority: next, collectorOutput: output, executeCollectorProcess: execute});
      assert.deepEqual((await ledger.pool.query(
        'SELECT status, collector_container_token, collector_container_id FROM ac_verify_runs WHERE id=$1', [runId],
      )).rows[0], {status: 'failed', collector_container_token: null, collector_container_id: null});
    } finally {
      ack.resolve();
      controller.abort();
      await Promise.allSettled([task, release, successor]);
    }
  });
});

test('o sucessor que adquire antes da partida impede a execução antiga de lançar o contêiner', {skip: !databaseUrl, timeout: 15_000}, async () => {
  await withModuleRecoveryFixture(databaseUrl!, async base => {
    const {ledger, principal, authority} = base;
    const checkingOwner = barrier();
    const ownerReply = barrier();
    let token = '', firstList = true, removed = false;
    const starts: string[] = [];
    const execute: CollectorProcess = async argv => {
      if (argv[1] === 'image') return imageCommand();
      if (argv[1] === 'create') {
        token = argv[argv.indexOf('--label') + 1]!.split('=')[1]!;
        return reply(0, containerId);
      }
      if (argv[1] === 'start') {
        starts.push(argv.at(-1)!);
        return reply(1);
      }
      if (argv[2] === 'ls') {
        if (firstList) {
          firstList = false;
          checkingOwner.resolve();
          await ownerReply.promise;
        }
        return reply(0, removed ? '' : `${containerId} ${moduleContainerName(token)} ${token}`);
      }
      assert.deepEqual(argv.slice(1), ['container', 'rm', '--force', containerId]);
      removed = true;
      return reply(0);
    };
    const task = runVerificationModule({...base, image, executeCollectorProcess: execute});
    void task.catch(() => undefined);
    try {
      await Promise.race([checkingOwner.promise, task]);
      await ledger.releaseLease(authority);
      const next = await ledger.acquire(principal, authority.contextId, randomUUID(), 'next-before-start', 60);
      ownerReply.resolve();
      await assert.rejects(task, {code: 'STALE_MANAGER'});
      assert.deepEqual(starts, []);
      assert.equal(removed, true);
      const result = await runVerificationModule({...base, authority: next, collectorOutput: output, executeCollectorProcess: execute});
      assert.deepEqual((await listModuleReports(base.dataDirectory, base.projectId)).map(item => item.id), [result.runId]);
    } finally {
      ownerReply.resolve();
      await task.catch(() => undefined);
    }
  });
});

test('stdout completo preserva o código do coletor e aguarda confirmação independente antes de publicar', {skip: !databaseUrl, timeout: 15_000}, async () => {
  await withModuleRecoveryFixture(databaseUrl!, async base => {
    const waiting = barrier();
    const exit = barrier();
    let token = '', removed = false;
    const execute: CollectorProcess = async argv => {
      if (argv[1] === 'image') return imageCommand();
      if (argv[1] === 'create') {
        token = argv[argv.indexOf('--label') + 1]!.split('=')[1]!;
        return reply(0, containerId);
      }
      if (argv[1] === 'start') return framedOutput(token, 7, collectorLogs);
      if (argv[2] === 'inspect') return reply(0, `${containerId} exited`);
      if (argv[1] === 'inspect') {
        assert.deepEqual(argv.slice(1, 5), ['inspect', '--type', 'container', '--format']);
        assert.equal(argv.at(-1), containerId);
        waiting.resolve();
        await exit.promise;
        return reply(0, containerId + ' exited 7 ok');
      }
      if (argv[2] === 'ls') return reply(0, removed ? '' : `${containerId} ${moduleContainerName(token)} ${token}`);
      assert.deepEqual(argv.slice(1), ['container', 'rm', '--force', containerId]);
      removed = true;
      return reply(0);
    };
    const task = runVerificationModule({...base, image, executeCollectorProcess: execute});
    void task.catch(() => undefined);
    try {
      await Promise.race([waiting.promise, task]);
      assert.equal(removed, false);
      assert.deepEqual(await listModuleReports(base.dataDirectory, base.projectId), []);
      await delay(15);
      exit.resolve();
      const result = await task;
      assert.equal(removed, true);
      assert.equal(result.hasToolFailure, true);
      assert.equal(result.toolCoverage.find(row => row.tool === 'coletor')?.detail, 'Processo terminou com código 7.');
    } finally {
      exit.resolve();
      await task.catch(() => undefined);
    }
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
      if (argv[1] === 'image') return imageCommand();
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

test('a migração preserva o journal anterior e protege os IDs que já estavam persistidos', {skip: !databaseUrl}, async () => {
  await withModuleRecoveryFixture(databaseUrl!, async base => {
    const withId = await runVerificationModule({...base, collectorOutput: output});
    const withoutId = await runVerificationModule({...base, collectorOutput: output});
    const withIdToken = randomUUID();
    const withoutIdToken = randomUUID();
    await base.ledger.tx(async client => {
      // Reconstruct just the R7 schema in this isolated database, retaining
      // the migration records and digests for all published migrations.
      await client.query(`DROP TRIGGER ac_collector_start_identity_sync ON ac_verify_runs;
        DROP FUNCTION ac_sync_collector_start_identity();
        DROP TRIGGER ac_collector_start_transfer_guard ON ac_managers;
        DROP FUNCTION ac_guard_collector_start_transfer();
        ALTER TABLE ac_verify_runs DROP COLUMN collector_start_pending;
        DELETE FROM ac_schema_migrations WHERE version IN (113, 114)`);
      await client.query('UPDATE ac_verify_runs SET collector_container_token=$2, collector_container_id=$3 WHERE id=$1',
        [withId.runId, withIdToken, containerId]);
      await client.query('UPDATE ac_verify_runs SET collector_container_token=$2 WHERE id=$1', [withoutId.runId, withoutIdToken]);
    });
    await base.ledger.migrate();
    const {rows} = await base.ledger.pool.query(
      'SELECT id, collector_container_token, collector_container_id, collector_start_pending FROM ac_verify_runs',
    );
    assert.deepEqual(rows.find(row => row.id === withId.runId), {id: withId.runId, collector_container_token: withIdToken,
      collector_container_id: containerId, collector_start_pending: true});
    assert.deepEqual(rows.find(row => row.id === withoutId.runId), {id: withoutId.runId, collector_container_token: withoutIdToken,
      collector_container_id: null, collector_start_pending: false});
  });
});

test('um cliente R7 grava e limpa IDs durante a adoção das migrações 113 e 114', {skip: !databaseUrl}, async () => {
  await withModuleRecoveryFixture(databaseUrl!, async base => {
    const {ledger, authority} = base;
    const {runId} = await runVerificationModule({...base, collectorOutput: output});
    const token = randomUUID();
    const old = await ledger.pool.connect();
    try {
      await old.query(`DROP TRIGGER ac_collector_start_identity_sync ON ac_verify_runs;
        DROP FUNCTION ac_sync_collector_start_identity();
        DELETE FROM ac_schema_migrations WHERE version=114`);
      const state = async () => (await ledger.pool.query(
        'SELECT collector_container_token, collector_container_id, collector_start_pending FROM ac_verify_runs WHERE id=$1', [runId],
      )).rows[0];
      const oldRememberId = async () => {
        await old.query('UPDATE ac_verify_runs SET collector_container_token=$2 WHERE id=$1', [runId, token]);
        await old.query(`UPDATE ac_verify_runs SET collector_container_id=$3 WHERE id=$1 AND collector_container_token=$2
          AND (collector_container_id IS NULL OR collector_container_id=$3)`, [runId, token, containerId]);
      };
      const oldClear = () => old.query(
        'UPDATE ac_verify_runs SET collector_container_token=NULL, collector_container_id=NULL WHERE id=$1 AND collector_container_token=$2',
        [runId, token],
      );
      const transfer = () => ledger.pool.query('UPDATE ac_managers SET epoch=epoch+1 WHERE context_id=$1', [authority.contextId]);
      const journal = {collector_container_token: token, collector_container_id: containerId};
      await oldRememberId();
      assert.deepEqual(await state(), {...journal, collector_start_pending: false});
      await ledger.migrate();
      assert.deepEqual(await state(), {...journal, collector_start_pending: true});
      await assert.rejects(transfer(), {message: 'VERIFY_CONTAINER_CLEANUP_PENDING'});
      assert.equal((await oldClear()).rowCount, 1);

      await oldRememberId();
      assert.deepEqual(await state(), {...journal, collector_start_pending: true});
      const successor = await ledger.pool.connect();
      try {
        // R7 starts the container inside this fenced transaction; the new
        // manager uses another PostgreSQL session during its start window.
        await old.query('BEGIN');
        await ledger.fence(old, authority);
        await old.query('SELECT id FROM ac_verify_runs WHERE id=$1 FOR UPDATE', [runId]);
        await successor.query('BEGIN');
        await successor.query("SET LOCAL lock_timeout = '200ms'");
        await assert.rejects(successor.query('UPDATE ac_managers SET epoch=epoch+1 WHERE context_id=$1',
          [authority.contextId]), {code: '55P03'});
        await successor.query('ROLLBACK');
        await old.query('COMMIT');
        await assert.rejects(transfer(), {message: 'VERIFY_CONTAINER_CLEANUP_PENDING'});
      } finally {
        await old.query('ROLLBACK');
        await successor.query('ROLLBACK');
        successor.release();
      }
      assert.equal((await oldClear()).rowCount, 1);
      assert.deepEqual(await state(), {collector_container_token: null, collector_container_id: null, collector_start_pending: false});
      assert.equal((await transfer()).rowCount, 1);
    } finally {
      old.release();
    }
  });
});

for (const scenario of ['stderr', 'prefix', 'hash', 'wait', 'timeout', 'stdout'] as const) {
  test({
    stderr: 'stdout no limite e stderr longo preservam o JSON e os argumentos da imagem',
    prefix: 'perda do prefixo recusa um sufixo que ainda é JSON válido',
    hash: 'checksum recusa JSON alterado com o mesmo tamanho',
    wait: 'falha no transporte final recusa stdout completo após acompanhamento normal',
    timeout: 'timeout confirma remoção antes de publicar a falha',
    stdout: 'excesso de stdout interrompe um coletor contínuo antes do prazo',
  }[scenario], {skip: !databaseUrl, timeout: 15_000}, async () => {
    await withModuleRecoveryFixture(databaseUrl!, async base => {
      let owner = '';
      let wrapper = '';
      let removed = false;
      let observedStart = false;
      let completedCapture = false;
      let finalTransport = false;
      const maxStdoutBytes = scenario === 'stderr' ? MAX_COLLECTOR_STDOUT_BYTES : 1024;
      const imageArgs = ["um argumento com espaço, 'aspas', $ e \\", ''];
      const script = {
        stderr: `if (JSON.stringify(process.argv.slice(1)) !== ${JSON.stringify(JSON.stringify(imageArgs))}) process.exit(19);
          process.stderr.write(Buffer.alloc(12 * 1024 * 1024, 10));
          process.stdout.write(Buffer.alloc(${MAX_COLLECTOR_STDOUT_BYTES - Buffer.byteLength(collectorLogs)}, 10));
          process.stdout.write(${JSON.stringify(collectorLogs)});`,
        prefix: `process.stdout.write('  ' + ${JSON.stringify(collectorLogs)})`,
        hash: `process.stdout.write(${JSON.stringify(collectorLogs)})`,
        wait: `process.stdout.write(${JSON.stringify(collectorLogs)})`,
        timeout: '',
        stdout: `process.stdout.on('error', error => { if (error.code === 'EPIPE') process.exit(0); throw error; });
          setInterval(() => process.stdout.write(Buffer.alloc(4096, 32)), 10);`,
      }[scenario];
      const execute: CollectorProcess = async (argv, options) => {
        if (argv[1] === 'image') {
          assert.equal(argv.at(-1), image);
          return imageCommand(script, imageArgs);
        }
        if (argv[1] === 'create') {
          owner = argv[argv.indexOf('--label') + 1]!.slice(MODULE_CONTAINER_LABEL.length + 1);
          assert.deepEqual(argv.slice(-2), [image, COLLECTOR_WRAPPER_PATH]);
          assert.equal(argv[argv.indexOf('--pull') + 1], 'never');
          assert.equal(argv[argv.indexOf('--log-driver') + 1], 'none');
          assert.equal(argv[argv.indexOf('--entrypoint') + 1], '/bin/sh');
          assert.ok(argv.includes(`${COLLECTOR_CAPTURE_DIR}:rw,noexec,nosuid,nodev,uid=65532,gid=65532,mode=0700,size=${maxStdoutBytes + 4096}`));
          const mount = argv.find(arg => arg.endsWith(`,dst=${COLLECTOR_WRAPPER_PATH},readonly`));
          assert.ok(mount);
          wrapper = mount.split(',')[1]!.slice('src='.length);
          assert.equal((await stat(wrapper)).mode & 0o777, 0o555);
          return reply(0, containerId);
        }
        if (argv[1] === 'start') {
          assert.deepEqual(argv.slice(1), ['start', '--attach', containerId]);
          assert.equal(options.maxStdoutBytes, maxStdoutBytes + COLLECTOR_HEADER_BYTES);
          if (scenario === 'timeout') {
            return runBoundedCollectorProcess([process.execPath, '-e', 'setInterval(() => {}, 1000)'], options);
          }
          const result = await runBoundedCollectorProcess(['/bin/sh', wrapper], options);
          if (scenario === 'stderr') assert.equal(result.stderr, '');
          if (scenario === 'prefix') {
            const headerEnd = result.stdout.indexOf(0x0a) + 1;
            const suffix = result.stdout.subarray(headerEnd + 2);
            assert.deepEqual(JSON.parse(suffix.toString()), output);
            result.stdout = Buffer.concat([result.stdout.subarray(0, headerEnd), suffix]);
          }
          if (scenario === 'hash') {
            const marker = result.stdout.indexOf('synthetic');
            assert.ok(marker > 0);
            result.stdout[marker] = 'S'.charCodeAt(0);
          }
          if (scenario === 'wait') {
            assert.equal(result.code, 0);
            assert.deepEqual(result.stdout, framedOutput(owner, 0, collectorLogs).stdout);
          }
          if (scenario === 'stdout') assert.equal(result.code, 125);
          completedCapture = true;
          return result;
        }
        if (argv[2] === 'inspect') {
          assert.equal(argv.at(-1), containerId);
          observedStart = true;
          return reply(0, `${containerId} running`);
        }
        if (argv[1] === 'inspect') {
          assert.deepEqual(argv.slice(1, 5), ['inspect', '--type', 'container', '--format']);
          assert.equal(argv.at(-1), containerId);
          assert.ok(observedStart && completedCapture);
          finalTransport = true;
          if (scenario === 'wait') return reply(0, containerId + ' exited 0 invalid');
          return reply(0, containerId + (scenario === 'stdout' ? ' exited 125 ok' : ' exited 0 ok'));
        }
        if (argv[2] === 'ls') return reply(0, removed ? '' : `${containerId} ${moduleContainerName(owner)} ${owner}`);
        assert.deepEqual(argv.slice(1), ['container', 'rm', '--force', containerId]);
        removed = true;
        return reply(0);
      };
      const report = await runVerificationModule({...base, image, executeCollectorProcess: execute, maxStdoutBytes,
        timeoutMs: scenario === 'timeout' ? 150 : 5000});
      assert.equal(removed, true);
      await assert.rejects(stat(wrapper), {code: 'ENOENT'});
      assert.equal(finalTransport, scenario !== 'timeout');
      assert.equal(report.hasToolFailure, scenario !== 'stderr');
      if (scenario === 'stderr') {
        assert.deepEqual(report.toolCoverage, output.coverage);
      } else {
        assert.equal(report.toolCoverage.length, 1);
        assert.equal(report.toolCoverage[0]!.tool, 'coletor');
        assert.match(report.toolCoverage[0]!.detail, {
          prefix: /VERIFY_STDOUT_INCOMPLETE/,
          hash: /VERIFY_STDOUT_INCOMPLETE/,
          wait: /VERIFY_TOOLS_FAILED/,
          timeout: /VERIFY_TOOLS_FAILED/,
          stdout: /VERIFY_STDOUT_LIMIT/,
        }[scenario]);
      }
      assert.deepEqual((await listModuleReports(base.dataDirectory, base.projectId)).map(item => item.id), [report.runId]);
      assert.deepEqual((await base.ledger.pool.query(
        'SELECT status, collector_container_token, collector_container_id, collector_start_pending FROM ac_verify_runs WHERE id=$1', [report.runId],
      )).rows[0], {status: scenario === 'stderr' ? 'done' : 'failed', collector_container_token: null,
        collector_container_id: null, collector_start_pending: false});
    });
  });
}

test('rejeição de imagem ausente registra falha sem deixar uma reserva de contêiner', {skip: !databaseUrl}, async () => {
  await withModuleRecoveryFixture(databaseUrl!, async base => {
    const execute: CollectorProcess = async argv => {
      if (argv[1] === 'image') return imageCommand();
      if (argv[1] === 'create') return {...reply(1), stderr: 'Error response from daemon: No such image: fixture'};
      assert.equal(argv[2], 'ls');
      return reply(0);
    };
    const result = await runVerificationModule({...base, image, executeCollectorProcess: execute});
    assert.equal(result.hasToolFailure, true);
    assert.match(result.toolCoverage[0]!.detail, /VERIFY_MODULE_IMAGE_MISSING/);
    const {rows: [row]} = await base.ledger.pool.query('SELECT collector_container_token FROM ac_verify_runs WHERE id=$1', [result.runId]);
    assert.equal(row.collector_container_token, null);
    assert.equal((await runVerificationModule({...base, collectorOutput: output})).hasToolFailure, false);
  });
});

test('recuperação conserva o token de criação incerta sem impedir o sucessor e remove entrega tardia', {skip: !databaseUrl}, async () => {
  await withModuleRecoveryFixture(databaseUrl!, async base => {
    const runId = randomUUID();
    let token = '';
    let exists = false;
    const execute: CollectorProcess = async argv => {
      if (argv[1] === 'image') return imageCommand();
      if (argv[1] === 'create') {
        token = argv[argv.indexOf('--label') + 1]!.split('=')[1]!;
        return reply(1);
      }
      if (argv[2] === 'ls') return reply(0, exists ? `${containerId} ${moduleContainerName(token)} ${token}` : '');
      assert.deepEqual(argv.slice(1), ['container', 'rm', '--force', containerId]);
      exists = false;
      return reply(0);
    };
    await assert.rejects(runVerificationModule({...base, runId, image, executeCollectorProcess: execute}), pending);
    const retry = () => runVerificationModule({...base, collectorOutput: output, executeCollectorProcess: execute});
    await retry();
    const journal = async () => (await base.ledger.pool.query('SELECT collector_container_token FROM ac_verify_runs WHERE id=$1', [runId])).rows[0].collector_container_token;
    assert.equal(await journal(), token);
    exists = true;
    await retry();
    assert.equal(exists, false);
    assert.equal(await journal(), null);
  });
});

test('um ID ainda não persistido sobrevive à indisponibilidade do banco até a recuperação', {skip: !databaseUrl}, async () => {
  await withModuleRecoveryFixture(databaseUrl!, async base => {
    await base.ledger.pool.query(`CREATE FUNCTION refuse_id() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$;
      CREATE TRIGGER refuse_id BEFORE UPDATE OF collector_container_id ON ac_verify_runs
      FOR EACH ROW WHEN (NEW.collector_container_id IS NOT NULL) EXECUTE FUNCTION refuse_id()`);
    let token = '', exists = true;
    const execute: CollectorProcess = async argv => {
      if (argv[1] === 'image') return imageCommand();
      if (argv[1] === 'create') {token = argv[argv.indexOf('--label') + 1]!.split('=')[1]!; return reply(0, containerId);}
      if (argv[2] === 'ls') return reply(0, exists ? `${containerId} ${moduleContainerName(token)} ${token}` : '');
      assert.deepEqual(argv.slice(1), ['container', 'rm', '--force', containerId]);
      exists = false;
      return reply(0);
    };
    await assert.rejects(runVerificationModule({...base, image, executeCollectorProcess: execute}), pending);
    assert.equal(exists, true);
    await base.ledger.pool.query('DROP TRIGGER refuse_id ON ac_verify_runs');
    await runVerificationModule({...base, collectorOutput: output, executeCollectorProcess: execute});
    assert.equal(exists, false);
  });
});
