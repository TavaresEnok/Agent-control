import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {Refusal} from '../src/contracts.ts';
import {MODULE_CONTAINER_LABEL, moduleContainerName, type CollectorProcess} from '../src/module-container-cleanup.ts';
import type {Ledger} from '../src/ledger.ts';
import {listModuleReports, runBoundedCollectorProcess, runModuleCollectorContainer, runVerificationModule} from '../src/verification-modules.ts';
import {withModuleRecoveryFixture} from './fixtures/module-recovery.ts';

const databaseUrl = process.env.AC_TEST_DATABASE_URL;
const image = `sha256:${'b'.repeat(64)}`;
const containerId = 'a'.repeat(64);
const pending = (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_CONTAINER_CLEANUP_PENDING';
const output = {coverage: [{tool: 'fixture', version: '1', status: 'ok', detail: 'synthetic'}], findings: []};
const reply = (code: number, stdout = '') => ({code, stdout: Buffer.from(stdout), stderr: ''});
const collectorLogs = JSON.stringify(output);

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

test('lease perdido mantém limpeza pendente e retry só remove o contêiner identificado', {skip: !databaseUrl}, async () => {
  await withModuleRecoveryFixture(databaseUrl!, async base => {
    const {ledger, principal, authority, projectId, dataDirectory} = base;
    const runId = randomUUID();
    const controller = new AbortController();
    const collecting = barrier();
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
        assert.deepEqual(argv.slice(1), ['start', containerId]);
        assert.equal((await ledger.pool.query('SELECT collector_container_id FROM ac_verify_runs WHERE id=$1', [runId])).rows[0].collector_container_id, containerId);
        running = true;
        return reply(0, containerId);
      }
      if (argv[1] === 'logs') {
        assert.deepEqual(argv.slice(1), ['logs', '--follow', containerId]);
        collecting.resolve();
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
      if (argv[1] === 'create') {
        token = argv[argv.indexOf('--label') + 1]!.split('=')[1]!;
        return reply(0, containerId);
      }
      if (argv[1] === 'start') {
        assert.deepEqual(argv.slice(1), ['start', containerId]);
        assert.deepEqual(options, {timeoutMs: 10_000, maxStdoutBytes: 4096});
        started.resolve();
        await ack.promise;
        return reply(0, containerId);
      }
      if (argv[1] === 'logs') {
        collecting.resolve();
        return new Promise((_, reject) => options.signal!.addEventListener('abort',
          () => reject(new Refusal('VERIFY_TOOLS_FAILED', 503)), {once: true}));
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
      if (argv[1] === 'create') {
        token = argv[argv.indexOf('--label') + 1]!.split('=')[1]!;
        return reply(0, containerId);
      }
      if (argv[1] === 'start') {
        starts.push(argv[2]!);
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

test('término observado com código do contêiner decide o resultado depois dos logs', {skip: !databaseUrl, timeout: 15_000}, async () => {
  await withModuleRecoveryFixture(databaseUrl!, async base => {
    const waiting = barrier();
    const exit = barrier();
    let token = '', removed = false;
    let logsTimeout = 0;
    const execute: CollectorProcess = async (argv, options) => {
      if (argv[1] === 'create') {
        token = argv[argv.indexOf('--label') + 1]!.split('=')[1]!;
        return reply(0, containerId);
      }
      if (argv[1] === 'start') return reply(0, containerId);
      if (argv[1] === 'logs') {
        logsTimeout = options.timeoutMs;
        await delay(15);
        return reply(0, collectorLogs);
      }
      if (argv[1] === 'wait') {
        assert.deepEqual(argv.slice(1), ['wait', containerId]);
        assert.ok(options.timeoutMs < logsTimeout);
        waiting.resolve();
        await exit.promise;
        return reply(0, '7\n');
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

test('timeout da partida deixa ID durável para recuperar uma partida sem ACK', {skip: !databaseUrl}, async () => {
  await withModuleRecoveryFixture(databaseUrl!, async base => {
    const {ledger, principal, authority} = base;
    const runId = randomUUID();
    let token = '', reachable = true, running = false, removed = false;
    const execute: CollectorProcess = async (argv, options) => {
      if (argv[1] === 'create') {
        token = argv[argv.indexOf('--label') + 1]!.split('=')[1]!;
        return reply(0, containerId);
      }
      if (argv[1] === 'start') {
        assert.equal(options.timeoutMs, 150);
        running = true;
        try {
          return await runBoundedCollectorProcess([process.execPath, '-e', 'setInterval(() => {}, 1000)'], options);
        } finally {
          reachable = false;
        }
      }
      if (argv[2] === 'ls') {
        assert.ok(argv.includes(`id=${containerId}`));
        return reachable ? reply(0, removed ? '' : `${containerId} ${moduleContainerName(token)} ${token}`) : reply(1);
      }
      assert.deepEqual(argv.slice(1), ['container', 'rm', '--force', containerId]);
      removed = true;
      running = false;
      return reply(0);
    };
    const state = async () => (await ledger.pool.query(
      'SELECT status, collector_container_token, collector_container_id FROM ac_verify_runs WHERE id=$1', [runId],
    )).rows[0];
    await assert.rejects(runVerificationModule({...base, runId, image, executeCollectorProcess: execute, timeoutMs: 150}), pending);
    assert.equal(running, true);
    assert.deepEqual(await state(), {status: 'failed', collector_container_token: token, collector_container_id: containerId});
    assert.deepEqual(await listModuleReports(base.dataDirectory, base.projectId), []);
    await ledger.releaseLease(authority);
    const next = await ledger.acquire(principal, authority.contextId, randomUUID(), 'next-after-start-timeout', 60);
    reachable = true;
    await runVerificationModule({...base, authority: next, collectorOutput: output, executeCollectorProcess: execute});
    assert.equal(running, false);
    assert.deepEqual(await state(), {status: 'failed', collector_container_token: null, collector_container_id: null});
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
        if (argv[1] === 'start') return reply(0, containerId);
        if (argv[1] === 'logs') {
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

test('rejeição de imagem ausente registra falha sem deixar uma reserva de contêiner', {skip: !databaseUrl}, async () => {
  await withModuleRecoveryFixture(databaseUrl!, async base => {
    const execute: CollectorProcess = async argv => {
      if (argv[1] === 'create') return {...reply(1), stderr: 'Error response from daemon: No such image: fixture'};
      assert.equal(argv[2], 'ls');
      return reply(0);
    };
    const result = await runVerificationModule({...base, image, executeCollectorProcess: execute});
    assert.equal(result.hasToolFailure, true);
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
