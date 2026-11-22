import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Capacity} from '../src/capacity.ts';
import {Refusal} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import type {ModuleExamClock} from '../src/module-exam-native.ts';
import {moduleCliFailureText, runPersonalModuleCli} from '../src/personal-module-cli.ts';
import {verifyCliFailureText} from '../src/personal-verify-cli.ts';
import {readModuleReport, type ModuleCollectorOutput} from '../src/verification-modules.ts';
import {runSecurityVerification} from '../src/verify-runtime.ts';
import type {VerifyWorker} from '../src/verify-types.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {createModuleExamFixture, moduleExamFixtureAnswer} from './fixtures/module-exam-native.ts';
import {qaStaticTool} from './fixtures/module-exam-review.ts';

const base = process.env.AC_TEST_DATABASE_URL;

test('dois exames concorrentes com uma vaga só: o segundo aguarda com pausa crescente sem criar mais de uma espera ativa por reserva, reserva quando a vaga abre e limpa esperas ao terminar ou interromper',
  {skip: !base, timeout: 120_000}, async () => {
    const database = await isolatedDatabase(base!, 'exam_cap_queue');
    const ledger = new Ledger(database.url);
    const root = await mkdtemp(join(tmpdir(), 'ac-exam-cap-queue-'));
    let fixture: Awaited<ReturnType<typeof createModuleExamFixture>> | undefined;
    try {
      await ledger.migrate();
      const dataDirectory = join(root, 'data');
      const repo = join(root, 'repo');
      await mkdir(dataDirectory, {mode: 0o700});
      await mkdir(join(repo, 'src'), {recursive: true});
      await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
      await writeFile(join(repo, 'src', 'b.ts'), 'export const b = 2;\n');

      const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', repo, ...args], {stdio: 'pipe'});
      git('init');
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'concurrent queue test');

      const project = randomUUID();
      const owner = 'queue-owner';
      await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Queue Fixture']);
      await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, owner]);
      await ledger.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)', [project, repo]);
      await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1)', [owner]);
      await ledger.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");

      const mainContext = await ledger.createContext(owner, project, randomUUID());
      const capacity = new Capacity(ledger);
      // Only 1 evaluator slot globally and 1 concurrent slot on the Claude account.
      await capacity.configure(owner, {programmingLimit: 2, evaluationLimit: 1});

      fixture = await createModuleExamFixture({
        root,
        repo,
        ledger,
        owner,
        project,
        answer(launch) {
          return moduleExamFixtureAnswer(launch);
        },
      });
      const {runtime, profiles} = fixture;
      const claudeAccountId = [...runtime[0]!.accountIds][0]!;
      await ledger.pool.query('UPDATE ac_accounts SET max_concurrent=1 WHERE id=$1', [claudeAccountId]);

      const revision = await capacity.publish(owner, project, 0, {
        schemaVersion: 1,
        maxProgrammersPerContext: 1,
        maxEvaluatorsPerContext: 1,
        roles: {specialist: {regular: profiles, emergency: []}},
      });
      await capacity.assignPolicy(owner, mainContext, revision);

      const installation = join(dataDirectory, 'installation.json');
      await writeFile(installation, JSON.stringify({
        schemaVersion: 1,
        mode: 'administration-only',
        activation: 'personal',
        databaseUrl: database.url,
        dataDirectory,
        project: {
          id: project,
          label: 'Queue Fixture',
          repo,
          owner,
          economy: {map: true, measurement: true, batch: false, batchTokens: 40000, batchFiles: 8, managerDiscipline: true},
        },
        projects: [],
        http: {listen: '127.0.0.1', port: 8765, publicOrigin: 'http://127.0.0.1:8765'},
      }), {mode: 0o600});

      const collectorOutput: ModuleCollectorOutput = {
        coverage: [{tool: qaStaticTool, version: '1', status: 'ok', detail: 'leitura local'}],
        findings: [],
      };

      // Gate the first exam (qa) inside supervisor.start so it holds the only capacity grant while
      // the second exam (documentacao) attempts to reserve and enters the capacity queue.
      const baseClaude = runtime[0]!;
      const baseSupervisor = baseClaude.supervisor;
      let releaseFirstHold!: () => void;
      const firstHoldGate = new Promise<void>(resolve => { releaseFirstHold = resolve; });
      let firstHeldGrantId: string | undefined;
      let notifyFirstReserved!: () => void;
      const firstReserved = new Promise<void>(resolve => { notifyFirstReserved = resolve; });

      const gatedRuntime = [
        {
          ...baseClaude,
          supervisor: {
            ...baseSupervisor,
            async start(...args: Parameters<typeof baseSupervisor.start>) {
              const res = await baseSupervisor.start(...args);
              if (!firstHeldGrantId) {
                firstHeldGrantId = args[2].grantId;
                notifyFirstReserved();
                await firstHoldGate;
              }
              return res;
            },
            stop: baseSupervisor.stop.bind(baseSupervisor),
            reconcile: baseSupervisor.reconcile.bind(baseSupervisor),
            retireTerminal: baseSupervisor.retireTerminal.bind(baseSupervisor),
            closeModuleExamEgress: baseSupervisor.closeModuleExamEgress.bind(baseSupervisor),
          },
        },
        runtime[1]!,
      ];

      const docExamCtx = (await ledger.ensureExamContext(owner, project, 'documentacao')).contextId;
      const docDelays: number[] = [];
      const firstReservationAttemptIds = new Set<string>();
      const firstReservationSequences = new Set<string>();
      let docNowMs = Date.parse('2026-11-22T05:27:00Z');

      const docClock: ModuleExamClock = {
        now: () => docNowMs,
        async sleep(ms, signal) {
          if (signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
          docDelays.push(ms);
          docNowMs += ms;
          const activeWaits = (await ledger.pool.query<{attempt_id: string; sequence: string; reason: string}>(
            'SELECT attempt_id::text, sequence::text, reason FROM ac_capacity_waits WHERE context_id=$1',
            [docExamCtx],
          )).rows;
          assert.equal(activeWaits.length, 1, 'o segundo exame nunca pode criar mais de uma espera ativa por reserva');
          if (docDelays.length <= 3) {
            firstReservationAttemptIds.add(activeWaits[0]!.attempt_id);
            firstReservationSequences.add(activeWaits[0]!.sequence);
            assert.equal(activeWaits[0]!.reason, 'CAPACITY_BUSY');
          }
          // After 3 growing backoff sleeps (2000, 3000, 4500), release the first exam so the slot opens.
          if (docDelays.length === 3) {
            releaseFirstHold();
          }
        },
      };

      const exam1Promise = runPersonalModuleCli('qa', [installation, project], {
        collectorOutput,
        moduleExamRuntime: async () => gatedRuntime,
      });
      await firstReserved;

      const exam2Promise = runPersonalModuleCli('documentacao', [installation, project, '--esperar-cota'], {
        collectorOutput,
        moduleExamRuntime: async () => runtime,
        clock: docClock,
      });

      const [[qaRunId], [docRunId]] = await Promise.all([exam1Promise, exam2Promise]);
      assert.ok(qaRunId);
      assert.ok(docRunId);
      assert.deepEqual(docDelays.slice(0, 3), [2000, 3000, 4500], 'a espera deve usar pausa crescente (pollBackoff)');
      assert.equal(firstReservationAttemptIds.size, 1, 'a mesma tentativa (attempt_id) deve ser reaproveitada em todas as retentativas da reserva');
      assert.equal(firstReservationSequences.size, 1, 'a posição na fila (sequence) deve ser preservada');

      const qaReport = await readModuleReport(dataDirectory, project, qaRunId, 'qa');
      const docReport = await readModuleReport(dataDirectory, project, docRunId, 'documentacao');
      assert.match(qaReport.coverageMarkdown, /src\/a\.ts \| lido/);
      assert.match(qaReport.coverageMarkdown, /src\/b\.ts \| lido/);
      assert.match(docReport.coverageMarkdown, /src\/a\.ts \| lido/);
      assert.match(docReport.coverageMarkdown, /src\/b\.ts \| lido/);

      const waitsAfterFinish = (await ledger.pool.query('SELECT count(*)::int AS n FROM ac_capacity_waits')).rows[0].n;
      assert.equal(waitsAfterFinish, 0, 'nenhuma espera deve restar após o término dos exames');

      // Interruption while waiting in the queue removes the context's wait row before exiting.
      const blockerAuth = await ledger.acquire(owner, mainContext, randomUUID(), 'blocker', 60);
      const blockerIntent = (await ledger.accept(owner, {
        schemaVersion: 1,
        intentId: randomUUID(),
        deliveryAttemptId: randomUUID(),
        contextId: mainContext,
        policyRevision: revision,
        action: 'plan.start',
        payload: {workflow: 'baseline-synthetic-v1', messageRef: 'block'},
      }, blockerAuth, 'api')).id;
      const blockerGrant = await capacity.reserve(owner, {
        attemptId: randomUUID(),
        intentId: blockerIntent,
        contextId: mainContext,
        role: 'specialist',
      }, blockerAuth);

      let interruptedWaitsDuringSleep = 0;
      const interruptClock: ModuleExamClock = {
        now: () => docNowMs,
        async sleep(_ms, signal) {
          interruptedWaitsDuringSleep = (await ledger.pool.query(
            'SELECT count(*)::int AS n FROM ac_capacity_waits WHERE context_id=$1',
            [docExamCtx],
          )).rows[0].n;
          process.emit('SIGINT', 'SIGINT');
          await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) { reject(new Refusal('EXAM_INTERRUPTED')); return; }
            signal?.addEventListener('abort', () => reject(new Refusal('EXAM_INTERRUPTED')), {once: true});
          });
        },
      };

      await assert.rejects(
        runPersonalModuleCli('documentacao', [installation, project], {
          collectorOutput,
          moduleExamRuntime: async () => runtime,
          clock: interruptClock,
        }),
        (err: unknown) => err instanceof Refusal && err.code === 'EXAM_INTERRUPTED',
      );
      assert.equal(interruptedWaitsDuringSleep, 1);
      assert.equal(
        (await ledger.pool.query('SELECT count(*)::int AS n FROM ac_capacity_waits WHERE context_id=$1', [docExamCtx])).rows[0].n,
        0,
        'a espera do contexto interrompido deve ser removida imediatamente',
      );
      await capacity.transition(owner, blockerGrant.id, blockerAuth, 'released', {processId: 'blocker', state: 'not_started'});
      await ledger.releaseLease(blockerAuth);
    } finally {
      await fixture?.docker.close();
      await ledger.close();
      await database.close();
      await rm(root, {recursive: true, force: true});
    }
  });

test('módulo 1 (personal:verify) com vaga ocupada ou fila à frente aguarda com pausa crescente e segue, e traduz CAPACITY_QUEUED se atingir o teto',
  {skip: !base, timeout: 120_000}, async () => {
    const database = await isolatedDatabase(base!, 'verify_cap_queue');
    const db = new Ledger(database.url);
    const capacity = new Capacity(db);
    const repo = await mkdtemp(join(tmpdir(), 'ac-verify-queue-repo-'));
    const dataDirectory = await mkdtemp(join(tmpdir(), 'ac-verify-queue-data-'));
    try {
      await db.migrate();
      const principal = 'verify-queue-owner';
      const project = randomUUID();
      await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Verificação Fila']);
      await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
      await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
      await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
      await capacity.configure(principal, {programmingLimit: 4, evaluationLimit: 1});
      await capacity.registerModel(principal, {
        provider: 'claude',
        model: 'claude-sonnet-5-5',
        efforts: ['medium', 'high'],
        roles: ['specialist'],
        source: 'synthetic://verify-queue',
      });

      const accountA = randomUUID();
      const accountB = randomUUID();
      const profileA = randomUUID();
      const profileB = randomUUID();
      await capacity.addAccount(principal, project, {
        id: accountA, provider: 'claude', label: 'claude-a', resourceIdentity: `claude:${accountA}`,
        mode: 'synthetic', eligibility: 'documented_supported', eligibilitySource: 'synthetic://verify-queue', maxConcurrent: 1,
      });
      await capacity.addAccount(principal, project, {
        id: accountB, provider: 'claude', label: 'claude-b', resourceIdentity: `claude:${accountB}`,
        mode: 'synthetic', eligibility: 'documented_supported', eligibilitySource: 'synthetic://verify-queue', maxConcurrent: 1,
      });
      await capacity.addProfile(principal, project, {id: profileA, accountId: accountA, model: 'claude-sonnet-5-5', effort: 'high', role: 'specialist'});
      await capacity.addProfile(principal, project, {id: profileB, accountId: accountB, model: 'claude-sonnet-5-5', effort: 'medium', role: 'specialist'});
      await capacity.observeQuota(principal, accountA, {status: 'available', source: 'synthetic://verify-queue', ttlSeconds: 3600});
      await capacity.observeQuota(principal, accountB, {status: 'available', source: 'synthetic://verify-queue', ttlSeconds: 3600});

      const revision = await capacity.publish(principal, project, 0, {
        schemaVersion: 1,
        maxProgrammersPerContext: 1,
        maxEvaluatorsPerContext: 1,
        roles: {specialist: {regular: [profileA], emergency: [profileB]}},
      });
      const verifyCtx = await db.createContext(principal, project, randomUUID());
      const otherCtx = await db.createContext(principal, project, randomUUID());
      await capacity.assignPolicy(principal, verifyCtx, revision);
      await capacity.assignPolicy(principal, otherCtx, revision);

      await mkdir(join(repo, 'src'), {recursive: true});
      await writeFile(join(repo, 'src', 'app.ts'), "export function register(app: {get(path: string, handler: () => string): void}) {\n  app.get('/admin', () => 'painel');\n}\n");
      const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', repo, ...args], {encoding: 'utf8', stdio: 'pipe'}).trim();
      git('init');
      git('add', 'src/app.ts');
      git('-c', 'user.email=verify@example.com', '-c', 'user.name=verify', 'commit', '-m', 'init');
      const commit = git('rev-parse', 'HEAD');

      const verifyAuth = await db.acquire(principal, verifyCtx, randomUUID(), 'verify-run', 60);
      const otherAuth = await db.acquire(principal, otherCtx, randomUUID(), 'other-exam', 60);
      const otherIntent = (await db.accept(principal, {
        schemaVersion: 1,
        intentId: randomUUID(),
        deliveryAttemptId: randomUUID(),
        contextId: otherCtx,
        policyRevision: revision,
        action: 'plan.start',
        payload: {workflow: 'baseline-synthetic-v1', messageRef: 'other-exam'},
      }, otherAuth, 'api')).id;

      // Occupy the single evaluation slot before module 1 starts, and occupy it again after the map call
      // (with an older wait ahead in ac_capacity_waits so module 1 experiences both CAPACITY_BUSY and CAPACITY_QUEUED mid-round).
      let heldGrant = await capacity.reserve(principal, {
        attemptId: randomUUID(),
        intentId: otherIntent,
        contextId: otherCtx,
        role: 'specialist',
      }, otherAuth);
      let olderWaitAttemptId: string | undefined;

      const worker: VerifyWorker = {
        async run(call) {
          if (call.task.startsWith('Pedido de mapa.')) {
            return JSON.stringify({
              kind: 'mapa',
              routes: [{method: 'GET', path: '/admin', file: 'src/app.ts', line: 2}],
              surfaces: ['http'],
            });
          }
          if (call.task.startsWith('Pedido de exame.')) {
            const items = (call.task.match(/^Itens: (.*)$/m)?.[1] ?? '').split(',').map(s => s.trim()).filter(Boolean);
            return JSON.stringify({
              kind: 'exame',
              filesRead: ['src/app.ts'],
              checklist: items.length ? items : ['ASVS-5-V1'],
              findings: [{
                title: 'Rota sem checagem',
                severity: 'alta',
                file: 'src/app.ts',
                line: 2,
                scenario: 'Acesso direto',
                suggestion: 'Checar sessão',
                cwe: 'CWE-862',
                reference: 'ASVS-5.0-V4',
                snippet: "app.get('/admin', () => 'painel')",
              }],
            });
          }
          return JSON.stringify({
            kind: 'confirmacao',
            status: 'confirmado',
            reason: 'Sem autenticação.',
            proof: 'src/app.ts expõe /admin.',
          });
        },
      };

      const verifyWaitDelays: number[] = [];
      const seenReasons: string[] = [];
      let midRoundBlocked = false;

      const result = await runSecurityVerification({
        ledger: db,
        principal,
        authority: verifyAuth,
        projectId: project,
        repoPath: repo,
        dataDirectory,
        commit,
        policyRevision: revision,
        worker,
        pollBackoff: true,
        async onPhase(phase) {
          if (phase === 'exame' && !midRoundBlocked) {
            midRoundBlocked = true;
            // Right after 'mapa' released its grant, insert an older wait from otherCtx at the head of the queue
            // so module 1 hits CAPACITY_QUEUED in the middle of the round!
            olderWaitAttemptId = randomUUID();
            await db.pool.query(
              `INSERT INTO ac_capacity_waits(attempt_id,context_id,intent_id,role,request_digest,manager_epoch,desired_profile,reason,priority,created_at)
               VALUES($1,$2,$3,'specialist','older-digest',$4,$5,'CAPACITY_BUSY',50,clock_timestamp() - interval '10 seconds')`,
              [olderWaitAttemptId, otherCtx, otherIntent, otherAuth.epoch, profileA],
            );
          }
        },
        async wait(ms) {
          verifyWaitDelays.push(ms);
          const waits = (await db.pool.query<{attempt_id: string; reason: string}>(
            'SELECT attempt_id::text, reason FROM ac_capacity_waits WHERE context_id=$1',
            [verifyCtx],
          )).rows;
          assert.equal(waits.length, 1, 'módulo 1 deve manter no máximo 1 espera ativa durante a fila');
          seenReasons.push(waits[0]!.reason);
          if (verifyWaitDelays.length === 2 && heldGrant) {
            await capacity.transition(principal, heldGrant.id, otherAuth, 'released', {processId: 'other', state: 'not_started'});
          }
          if (olderWaitAttemptId && waits[0]!.reason === 'CAPACITY_QUEUED') {
            await capacity.cancelWait(principal, olderWaitAttemptId, otherAuth);
            olderWaitAttemptId = undefined;
          }
        },
      });

      assert.equal(result.achados.length, 1);
      assert.equal(result.achados[0]?.status, 'confirmado');
      assert.ok(verifyWaitDelays.length >= 3);
      assert.equal(verifyWaitDelays[0], 2000);
      assert.equal(verifyWaitDelays[1], 3000);
      assert.ok(seenReasons.includes('CAPACITY_BUSY'), 'deve ter aguardado em CAPACITY_BUSY');
      assert.ok(seenReasons.includes('CAPACITY_QUEUED'), 'deve ter aguardado em CAPACITY_QUEUED no meio da rodada');
      assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM ac_capacity_waits')).rows[0].n, 0);

      // Ceiling test: when capacity remains queued past timeLimitMs, module 1 fails with translated message and cleans up its wait.
      const blockingWaitId = randomUUID();
      await db.pool.query(
        `INSERT INTO ac_capacity_waits(attempt_id,context_id,intent_id,role,request_digest,manager_epoch,desired_profile,reason,priority,created_at)
         VALUES($1,$2,$3,'specialist','Permanent-queue',$4,$5,'CAPACITY_BUSY',50,clock_timestamp() - interval '10 seconds')`,
        [blockingWaitId, otherCtx, otherIntent, otherAuth.epoch, profileA],
      );
      await assert.rejects(
        runSecurityVerification({
          ledger: db,
          principal,
          authority: verifyAuth,
          projectId: project,
          repoPath: repo,
          dataDirectory,
          commit,
          policyRevision: revision,
          worker,
          timeLimitMs: 3500,
          wait: async () => {},
        }),
        (err: unknown) => {
          assert.ok(err instanceof Refusal && err.code === 'CAPACITY_QUEUED');
          const text = verifyCliFailureText(err);
          assert.notEqual(text, 'CAPACITY_QUEUED');
          assert.match(text, /fila de capacidade/i);
          return true;
        },
      );
      assert.equal(
        (await db.pool.query('SELECT count(*)::int AS n FROM ac_capacity_waits WHERE context_id=$1', [verifyCtx])).rows[0].n,
        0,
        'a espera do módulo 1 deve ser limpa ao falhar pelo teto da rodada',
      );
      assert.match(verifyCliFailureText(new Refusal('CAPACITY_BUSY')), /vagas de execução/i);
      assert.match(moduleCliFailureText(new Refusal('CAPACITY_QUEUED'), 'documentacao'), /fila de capacidade/i);
    } finally {
      await db.close();
      await database.close();
      await rm(repo, {recursive: true, force: true});
      await rm(dataDirectory, {recursive: true, force: true});
    }
  });
