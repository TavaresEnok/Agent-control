import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Capacity} from '../src/capacity.ts';
import {Refusal} from '../src/contracts.ts';
import {Ledger, VERIFICATION_MODULES} from '../src/ledger.ts';
import {CLAUDE_QUOTA_RETRY_INTERVAL_MS, examineFunctionalModule, moduleExamReadBinding, type ModuleExamSeat} from '../src/module-exam.ts';
import type {ModuleExamClock} from '../src/module-exam-native.ts';
import {moduleCliFailureText, parsePersonalModuleArgs, runPersonalModuleCli} from '../src/personal-module-cli.ts';
import {runPersonalQaCli} from '../src/personal-qa-cli.ts';
import {readModuleReport, type ModuleCollectorOutput, type VerificationModuleRunResult} from '../src/verification-modules.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {createModuleExamFixture, moduleExamFixtureAnswer} from './fixtures/module-exam-native.ts';
import {qaStaticFinding, qaStaticTool, reviewFixtureVerdict} from './fixtures/module-exam-review.ts';

function fakeClock(initialIso = '2026-11-20T04:00:00Z') {
  let nowMs = Date.parse(initialIso);
  const waits: number[] = [];
  const clock: ModuleExamClock = {
    now: () => nowMs,
    async sleep(ms, signal) {
      if (signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
      waits.push(ms);
      nowMs += ms;
    },
  };
  return {clock, waits, now: () => nowMs};
}

test('opção --esperar-cota é explícita na CLI dos módulos 2 a 9 e não altera modos auxiliares', () => {
  const runId = randomUUID();
  for (const module of VERIFICATION_MODULES) {
    assert.deepEqual(parsePersonalModuleArgs(module, ['installation.json', 'Projeto']),
      {kind: 'run', module, installationPath: 'installation.json', projectToken: 'Projeto'});
    assert.deepEqual(parsePersonalModuleArgs(module, ['installation.json', 'Projeto', '--esperar-cota']),
      {kind: 'run', module, installationPath: 'installation.json', projectToken: 'Projeto', waitForQuota: true});
    assert.match(moduleCliFailureText(new Refusal('VERIFY_USAGE'), module), /--esperar-cota/);
    for (const invalid of [
      ['--esperar-cota', '--esperar-cota'],
      ['--esperar-cota=true'],
      ['--descartar', runId, '--esperar-cota'],
      ['--medir-correcao', runId, '--esperar-cota'],
      ['--corrigir', runId, 'ACH-001', '--esperar-cota'],
      ['--reverificar', runId, 'ACH-001', '--esperar-cota'],
      ['--esperar-cota', '--descartar', runId],
    ]) {
      assert.throws(() => parsePersonalModuleArgs(module, ['installation.json', 'Projeto', ...invalid]), /VERIFY_USAGE/);
    }
  }
  assert.deepEqual(
    parsePersonalModuleArgs('prontidao', ['installation.json', 'Projeto', '--origem', 'https://app.example.com', '--esperar-cota']),
    {kind: 'run', module: 'prontidao', installationPath: 'installation.json', projectToken: 'Projeto', origin: 'https://app.example.com', waitForQuota: true},
  );
  assert.deepEqual(
    parsePersonalModuleArgs('prontidao', ['installation.json', 'Projeto', '--esperar-cota', '--origem=https://app.example.com']),
    {kind: 'run', module: 'prontidao', installationPath: 'installation.json', projectToken: 'Projeto', origin: 'https://app.example.com', waitForQuota: true},
  );
});

test('examineFunctionalModule retoma no mesmo arquivo não julgado preservando contadores, vinculação e isolamento de provedores', async () => {
  const claudeSeat = (accountId: string): ModuleExamSeat => ({
    provider: 'claude', model: 'claude-sonnet', accountId, profileId: randomUUID(), grantId: randomUUID(),
  });
  const codexSeat: ModuleExamSeat = {
    provider: 'codex', model: 'codex-model', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID(),
  };
  const intentId = randomUUID();
  const commit = 'a'.repeat(40);
  const claudeAccount = randomUUID();
  const expressApp = "import express from 'express'; const app = express(); ";
  const skipped = 'test.skip("valida pedido", () => {})';
  const routes = Array.from({length: 22}, (_, index) => ({file: 'b-limited.ts', line: index + 1, method: 'GET', path: `/r-${index}`}));
  const betaBody = expressApp + routes.map(r => `app.get("${r.path}", handler);`).join('\n')
    + `\n${skipped};\n` + '//' + 'x'.repeat(16000);
  const map = {
    files: [
      {file: 'a-first.ts', code: 'export const alpha = 1;\n', reason: null},
      {file: 'b-limited.ts', code: betaBody, reason: null},
      {file: 'c-last.ts', code: 'export const gamma = 3;\n', reason: null},
    ],
    routes: routes.map((r, index) => ({...r, column: index === 0 ? expressApp.length + 1 : 1})),
  };
  const finding = qaStaticFinding('b-limited.ts', 23, skipped + ';');

  const examCalls: string[] = [];
  const waits: string[] = [];
  const releases: string[] = [];
  let betaAttempts = 0;

  const resumed = await examineFunctionalModule({
    module: 'qa',
    intentId,
    commit,
    map,
    findings: [finding],
    async reserve(purpose) {
      return purpose === 'examiner' ? claudeSeat(claudeAccount) : codexSeat;
    },
    async release(_seat, state) {
      releases.push(state);
    },
    async waitForClaudeQuota(context) {
      waits.push(`${context.purpose}:${context.provider}:${context.file}`);
      return true;
    },
    worker: {
      async run(call) {
        const task = JSON.parse(call.task);
        if (task.checklist) {
          examCalls.push(task.file);
          if (task.file === 'b-limited.ts') {
            betaAttempts += 1;
            if (betaAttempts <= 2) throw new Refusal('PROVIDER_USAGE_LIMIT');
          }
          return JSON.stringify({
            kind: 'exame',
            binding: task.binding,
            filesRead: [task.file],
            checklist: ['qa'],
            routesReviewed: task.routes.slice(0, 2),
            findings: [],
          });
        }
        return JSON.stringify(reviewFixtureVerdict(task, skipped));
      },
    },
  });

  assert.deepEqual(examCalls, ['a-first.ts', 'b-limited.ts', 'b-limited.ts', 'b-limited.ts', 'c-last.ts']);
  assert.deepEqual(waits, ['examiner:claude:b-limited.ts', 'examiner:claude:b-limited.ts']);
  assert.deepEqual(resumed.coverage.map(row => [row.file, row.status]), [
    ['a-first.ts', 'lido'],
    ['b-limited.ts', 'lido'],
    ['c-last.ts', 'lido'],
  ]);
  assert.ok(moduleExamReadBinding(resumed.coverage[1], {module: 'qa', intentId, commit}, 'b-limited.ts', betaBody));
  assert.equal(resumed.findings[0]?.status, 'confirmado');
  assert.equal(resumed.findings[0]?.verifier?.provider, 'codex');
  assert.ok(resumed.notes.includes('Rotas fora dos limites de envio ao examinador: 2.'));
  assert.ok(resumed.notes.includes('Arquivos com envio limitado a linhas completas: 1.'));
  assert.equal(resumed.notes.some(note => note.includes('PROVIDER_USAGE_LIMIT')), false);
  assert.equal(releases.length, 4);

  // Non-Claude reviewer hitting PROVIDER_USAGE_LIMIT must never wait even when waitForClaudeQuota is supplied.
  const codexWaits: string[] = [];
  const codexStop = await examineFunctionalModule({
    module: 'arquitetura',
    intentId,
    commit,
    map: {files: [{file: 'a-first.ts', code: `${skipped};\n`, reason: null}], routes: []},
    findings: [qaStaticFinding('a-first.ts', 1, skipped + ';')],
    async reserve(purpose) {
      return purpose === 'examiner' ? claudeSeat(claudeAccount) : codexSeat;
    },
    async release() {},
    async waitForClaudeQuota(context) {
      codexWaits.push(`${context.purpose}:${context.provider}`);
      return true;
    },
    worker: {
      async run(call) {
        const task = JSON.parse(call.task);
        if (task.checklist) {
          return JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: ['arquitetura'], findings: []});
        }
        throw new Refusal('PROVIDER_USAGE_LIMIT');
      },
    },
  });
  assert.deepEqual(codexWaits, []);
  assert.equal(codexStop.findings[0]?.status, 'provavel');
  assert.equal(codexStop.findings[0]?.failure, 'PROVIDER_USAGE_LIMIT');
});

const base = process.env.AC_TEST_DATABASE_URL;

test('CLI integrada espera renovação da mesma conta Claude em 15 min com relógio injetado, mantém lease/cancelamento e não estende ao Codex',
  {skip: !base}, async t => {
    const database = await isolatedDatabase(base!, 'quotawait');
    const ledger = new Ledger(database.url);
    const root = await mkdtemp(join(tmpdir(), 'ac-module-quota-wait-'));
    let mode: 'examiner-limit-twice' | 'codex-limit' | 'ok' = 'examiner-limit-twice';
    let claudeFailuresLeft = 0;
    let onQuotaCallCount = 0;
    let activeSleepHook: (() => Promise<void>) | undefined;
    let fixture: Awaited<ReturnType<typeof createModuleExamFixture>> | undefined;
    try {
      await ledger.migrate();
      const dataDirectory = join(root, 'data');
      const repo = join(root, 'repo');
      await mkdir(dataDirectory, {mode: 0o700});
      await mkdir(join(repo, 'src'), {recursive: true});

      const expressApp = "import express from 'express'; const app = express(); ";
      const routeLines = Array.from({length: 21}, (_, idx) => `app.get("/item-${idx}", handler);`).join('\n');
      const betaExport = 'export function converte(valor: number) { return valor * 10; };';
      const betaCode = `${betaExport}\n${expressApp}${routeLines}\n`;
      await writeFile(join(repo, 'src', 'alpha.ts'), 'export const alpha = 1;\n');
      await writeFile(join(repo, 'src', 'beta.ts'), betaCode);
      await writeFile(join(repo, 'src', 'gamma.ts'), 'export const gamma = 3;\n');

      const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', repo, ...args], {stdio: 'pipe'});
      git('init');
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'synthetic quota wait');

      const project = randomUUID();
      const owner = 'quota-wait-owner';
      await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Quota Wait Fixture']);
      await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, owner]);
      await ledger.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)', [project, repo]);
      await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1)', [owner]);
      await ledger.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
      const mainContext = await ledger.createContext(owner, project, randomUUID());
      const capacity = new Capacity(ledger);
      await capacity.configure(owner, {programmingLimit: 2, evaluationLimit: 2});

      fixture = await createModuleExamFixture({
        root,
        repo,
        ledger,
        owner,
        project,
        answer(launch) {
          const task = JSON.parse(launch.task);
          if (launch.provider === 'claude' && task.file === 'src/beta.ts') {
            if (mode === 'examiner-limit-twice' && claudeFailuresLeft > 0) {
              claudeFailuresLeft -= 1;
              return {output: '', failureCode: 'PROVIDER_USAGE_LIMIT'};
            }
          }
          if (launch.provider === 'codex' && mode === 'codex-limit') {
            return {output: '', failureCode: 'PROVIDER_USAGE_LIMIT'};
          }
          if (task.file === 'src/beta.ts' && !task.checklist && task.criterion === 'knip-unreached-export') {
            return {
              failureCode: null,
              output: JSON.stringify({
                kind: 'confirmacao',
                status: 'confirmado',
                binding: task.binding,
                proof: task.code,
                decision: 'sustenta',
                reason: 'O arquivo declara a função exportada converte. O Knip o classificou como não alcançado a partir das entradas analisadas neste exame.',
                observation: {
                  criterion: 'knip-unreached-export',
                  file: task.file,
                  line: task.line,
                  tool: task.tool,
                  rule: task.rule,
                  ...(task.commit ? {commit: task.commit} : {}),
                  column: 1,
                  expression: 'export function converte(valor: number)',
                  facts: ['converte', 'nao_alcancado'],
                },
              }),
            };
          }
          return moduleExamFixtureAnswer(launch);
        },
      });
      const {runtime, profiles, docker} = fixture;
      const claudeAccountId = [...runtime[0]!.accountIds][0]!;
      const codexAccountId = [...runtime[1]!.accountIds][0]!;
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
        project: {id: project, label: 'Quota Wait Fixture', repo, owner},
        projects: [],
        http: {listen: '127.0.0.1', port: 8765, publicOrigin: 'http://127.0.0.1:8765'},
        happier: {upstreamOrigin: 'http://127.0.0.1:8766', webOrigin: 'http://127.0.0.1:8766', publicServerOrigin: 'http://127.0.0.1:8765'},
      }), {mode: 0o600});

      const collectorOutput: ModuleCollectorOutput = {
        coverage: [
          {tool: 'knip', version: '1', status: 'ok', detail: 'leitura local'},
          {tool: 'knip:file', version: '1', status: 'ok', detail: 'arquivo=src/beta.ts; papel=nao_alcancado; problemas=1'},
        ],
        findings: [{
          tool: 'knip',
          rule: 'KNIP-UNUSED-FILE',
          file: 'src/beta.ts',
          line: 1,
          severity: 'media',
          message: 'Arquivo nao alcancado',
          evidence: 'knip files: src/beta.ts',
        }],
      };
      const qaCollectorOutput: ModuleCollectorOutput = {
        coverage: [{tool: qaStaticTool, version: '1', status: 'ok', detail: 'leitura local'}],
        findings: [],
      };

      const makeClock = () => {
        const baseClock = fakeClock();
        const wrappedClock: ModuleExamClock = {
          now: baseClock.now,
          async sleep(ms, signal) {
            onQuotaCallCount += 1;
            const openGrants = await ledger.pool.query("SELECT count(*)::int AS open FROM ac_capacity_grants WHERE state<>'released'");
            assert.equal(openGrants.rows[0].open, 0, 'todos os grants devem estar liberados antes da espera');
            await baseClock.clock.sleep(ms, signal);
            if (activeSleepHook) await activeSleepHook();
          },
        };
        return {clock: wrappedClock, waits: baseClock.waits};
      };

      await t.test('execução padrão sem --esperar-cota mantém parada imediata em PROVIDER_USAGE_LIMIT', async () => {
        mode = 'examiner-limit-twice';
        claudeFailuresLeft = 2;
        const {clock, waits} = makeClock();
        let captured: VerificationModuleRunResult | undefined;
        await assert.rejects(
          runPersonalModuleCli('arquitetura', [installation, project], {
            collectorOutput,
            moduleExamRuntime: async () => runtime,
            clock,
            onResult(res) { captured = res; },
          }),
          (error: unknown) => error instanceof Refusal && error.code === 'PROVIDER_USAGE_LIMIT',
        );
        assert.deepEqual(waits, []);
        assert.ok(captured);
        const report = await readModuleReport(dataDirectory, project, captured.runId, 'arquitetura');
        assert.match(report.coverageMarkdown, /src\/alpha\.ts \| lido/);
        assert.match(report.coverageMarkdown, /src\/beta\.ts \| nao_julgado \| PROVIDER_USAGE_LIMIT/);
        assert.match(report.coverageMarkdown, /src\/gamma\.ts \| nao_julgado \| PROVIDER_USAGE_LIMIT/);
        assert.equal(report.achados[0]?.status, 'provavel');
      });

      await t.test('personal:arquitetura --esperar-cota espera 15 min, retoma em src/beta.ts sem repetir src/alpha.ts e preserva contadores e vinculação', async () => {
        await ledger.pool.query('UPDATE ac_accounts SET exhausted_until=NULL WHERE id=$1', [claudeAccountId]);
        await capacity.observeQuota(owner, claudeAccountId, {status: 'available', ttlSeconds: 3600, source: 'synthetic://quota-wait'});
        mode = 'examiner-limit-twice';
        claudeFailuresLeft = 2;
        const {clock, waits} = makeClock();
        const logsBefore = docker.logs.length;
        const waitEvents: string[] = [];
        let captured: VerificationModuleRunResult | undefined;

        const out = await runPersonalModuleCli('arquitetura', [installation, project, '--esperar-cota'], {
          collectorOutput,
          moduleExamRuntime: async () => runtime,
          clock,
          onQuotaWait(info) { waitEvents.push(`${info.purpose}:${info.file}:${info.delayMs}`); },
          onResult(res) { captured = res; },
        });

        assert.equal(out[0], captured?.runId);
        assert.deepEqual(waits, [CLAUDE_QUOTA_RETRY_INTERVAL_MS, CLAUDE_QUOTA_RETRY_INTERVAL_MS]);
        assert.deepEqual(waitEvents, [
          `examiner:src/beta.ts:${CLAUDE_QUOTA_RETRY_INTERVAL_MS}`,
          `examiner:src/beta.ts:${CLAUDE_QUOTA_RETRY_INTERVAL_MS}`,
        ]);
        const newLogs = docker.logs.slice(logsBefore);
        const claudeFiles = newLogs
          .filter(log => log.provider === 'claude')
          .map(log => ({file: JSON.parse(log.task).file, accountId: JSON.parse(log.task).module ? undefined : undefined, grantId: log.jobId}));
        assert.deepEqual(claudeFiles.map(item => item.file), [
          'src/alpha.ts',
          'src/beta.ts',
          'src/beta.ts',
          'src/beta.ts',
          'src/gamma.ts',
        ]);
        const claudeGrants = (await ledger.pool.query<{account_id: string}>(
          `SELECT account_id::text FROM ac_capacity_grants WHERE account_id=$1`,
          [claudeAccountId],
        )).rows;
        assert.ok(claudeGrants.length >= 5);
        assert.equal((await ledger.pool.query("SELECT count(*)::int AS open FROM ac_capacity_grants WHERE state<>'released'")).rows[0].open, 0);

        const report = await readModuleReport(dataDirectory, project, captured!.runId, 'arquitetura');
        assert.match(report.coverageMarkdown, /src\/alpha\.ts \| lido/);
        assert.match(report.coverageMarkdown, /src\/beta\.ts \| lido/);
        assert.match(report.coverageMarkdown, /src\/gamma\.ts \| lido/);
        assert.match(report.coverageMarkdown, /Rotas fora dos limites de envio ao examinador: 1\./);
        assert.doesNotMatch(report.coverageMarkdown, /PROVIDER_USAGE_LIMIT/);
        assert.equal(report.achados[0]?.status, 'confirmado');
        assert.equal(report.achados[0]?.verifier?.provider, 'codex');
      });

      await t.test('outro módulo passivo (qa) com --esperar-cota retoma da fila quando conta Claude já estava em pausa', async () => {
        await ledger.pool.query("UPDATE ac_accounts SET exhausted_until=clock_timestamp()+interval '1 hour' WHERE id=$1", [claudeAccountId]);
        mode = 'ok';
        const {clock, waits} = makeClock();
        const logsBefore = docker.logs.length;
        const [runId] = await runPersonalQaCli([installation, project, '--esperar-cota'], {
          collectorOutput: qaCollectorOutput,
          moduleExamRuntime: async () => runtime,
          clock,
        });
        assert.ok(runId);
        assert.deepEqual(waits, [CLAUDE_QUOTA_RETRY_INTERVAL_MS]);
        const claudeFiles = docker.logs.slice(logsBefore).filter(log => log.provider === 'claude').map(log => JSON.parse(log.task).file);
        assert.deepEqual(claudeFiles, ['src/alpha.ts', 'src/beta.ts', 'src/gamma.ts']);
        const report = await readModuleReport(dataDirectory, project, runId, 'qa');
        assert.match(report.coverageMarkdown, /src\/alpha\.ts \| lido/);
        assert.match(report.coverageMarkdown, /src\/beta\.ts \| lido/);
        assert.match(report.coverageMarkdown, /src\/gamma\.ts \| lido/);
      });

      await t.test('PROVIDER_USAGE_LIMIT no provedor Codex não espera mesmo com --esperar-cota', async () => {
        mode = 'codex-limit';
        const {clock, waits} = makeClock();
        let captured: VerificationModuleRunResult | undefined;
        await assert.rejects(
          runPersonalModuleCli('arquitetura', [installation, project, '--esperar-cota'], {
            collectorOutput,
            moduleExamRuntime: async () => runtime,
            clock,
            onResult(res) { captured = res; },
          }),
          (error: unknown) => error instanceof Refusal && error.code === 'PROVIDER_USAGE_LIMIT',
        );
        assert.deepEqual(waits, []);
        const report = await readModuleReport(dataDirectory, project, captured!.runId, 'arquitetura');
        assert.match(report.coverageMarkdown, /src\/alpha\.ts \| lido/);
        assert.match(report.coverageMarkdown, /src\/beta\.ts \| lido/);
        assert.match(report.coverageMarkdown, /src\/gamma\.ts \| lido/);
        assert.equal(report.achados[0]?.status, 'provavel');
        await ledger.pool.query('UPDATE ac_accounts SET exhausted_until=NULL WHERE id=$1', [codexAccountId]);
        await capacity.observeQuota(owner, codexAccountId, {status: 'available', ttlSeconds: 3600, source: 'synthetic://quota-wait'});
      });

      await t.test('cancelamento SIGINT durante a espera de 15 min interrompe sem retentar e limpa estado/lease/grants', async () => {
        mode = 'examiner-limit-twice';
        claudeFailuresLeft = 1;
        const waits: number[] = [];
        const logsBefore = docker.logs.length;
        const clock: ModuleExamClock = {
          now: () => Date.parse('2026-11-20T05:00:00Z'),
          async sleep(ms, signal) {
            waits.push(ms);
            process.emit('SIGINT', 'SIGINT');
            await new Promise<void>((_resolve, reject) => {
              if (signal?.aborted) reject(new Refusal('EXAM_INTERRUPTED'));
              signal?.addEventListener('abort', () => reject(new Refusal('EXAM_INTERRUPTED')), {once: true});
            });
          },
        };
        await assert.rejects(
          runPersonalModuleCli('arquitetura', [installation, project, '--esperar-cota'], {
            collectorOutput,
            moduleExamRuntime: async () => runtime,
            clock,
          }),
          (error: unknown) => error instanceof Refusal && error.code === 'EXAM_INTERRUPTED',
        );
        assert.deepEqual(waits, [CLAUDE_QUOTA_RETRY_INTERVAL_MS]);
        assert.equal(docker.logs.slice(logsBefore).filter(log => log.provider === 'claude').length, 2);
        const {contextId} = await ledger.ensureExamContext(owner, project, 'arquitetura');
        const manager = (await ledger.pool.query('SELECT lease_until <= clock_timestamp() AS released FROM ac_managers WHERE context_id=$1', [contextId])).rows[0];
        assert.equal(manager.released, true);
        const latestRun = (await ledger.pool.query('SELECT status FROM ac_verify_runs WHERE context_id=$1 ORDER BY created_at DESC LIMIT 1', [contextId])).rows[0];
        assert.equal(latestRun.status, 'failed');
        assert.equal((await ledger.pool.query("SELECT count(*)::int AS open FROM ac_capacity_grants WHERE state<>'released'")).rows[0].open, 0);
      });

      await t.test('perda de lease durante a espera aborta com VERIFY_LEASE_LOST e libera grants', async () => {
        await ledger.pool.query('UPDATE ac_accounts SET exhausted_until=NULL WHERE id=$1', [claudeAccountId]);
        await capacity.observeQuota(owner, claudeAccountId, {status: 'available', ttlSeconds: 3600, source: 'synthetic://quota-wait'});
        mode = 'examiner-limit-twice';
        claudeFailuresLeft = 1;
        const {contextId} = await ledger.ensureExamContext(owner, project, 'arquitetura');
        const waits: number[] = [];
        const logsBefore = docker.logs.length;
        const clock: ModuleExamClock = {
          now: () => Date.parse('2026-11-20T06:00:00Z'),
          async sleep(ms, signal) {
            waits.push(ms);
            await ledger.pool.query('UPDATE ac_managers SET epoch=epoch+1 WHERE context_id=$1', [contextId]);
            await new Promise<void>((_resolve, reject) => {
              if (signal?.aborted) { reject(new Refusal('EXAM_INTERRUPTED')); return; }
              signal?.addEventListener('abort', () => reject(new Refusal('EXAM_INTERRUPTED')), {once: true});
            });
          },
        };
        await assert.rejects(
          runPersonalModuleCli('arquitetura', [installation, project, '--esperar-cota'], {
            collectorOutput,
            moduleExamRuntime: async () => runtime,
            clock,
            leaseHeartbeatMs: 20,
          }),
          (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_LEASE_LOST',
        );
        assert.deepEqual(waits, [CLAUDE_QUOTA_RETRY_INTERVAL_MS]);
        assert.equal(docker.logs.slice(logsBefore).filter(log => log.provider === 'claude').length, 2);
        assert.equal((await ledger.pool.query("SELECT count(*)::int AS open FROM ac_capacity_grants WHERE state<>'released'")).rows[0].open, 0);
        // Subsequent run recovers the abandoned running row under the new epoch.
        await ledger.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1", [contextId]);
        await ledger.pool.query('UPDATE ac_accounts SET exhausted_until=NULL WHERE id=$1', [claudeAccountId]);
        await capacity.observeQuota(owner, claudeAccountId, {status: 'available', ttlSeconds: 3600, source: 'synthetic://quota-wait'});
        mode = 'ok';
        const [recoveredRunId] = await runPersonalModuleCli('arquitetura', [installation, project], {
          collectorOutput,
          moduleExamRuntime: async () => runtime,
        });
        assert.ok(recoveredRunId);
        const oldRuns = (await ledger.pool.query("SELECT status FROM ac_verify_runs WHERE context_id=$1 AND id<>$2", [contextId, recoveredRunId])).rows;
        assert.ok(oldRuns.every(r => r.status === 'failed' || r.status === 'done'));
      });

      assert.ok(onQuotaCallCount >= 2);
      docker.check();
    } finally {
      await fixture?.docker.close();
      await ledger.close();
      await database.close();
      await rm(root, {recursive: true, force: true});
    }
  });
