import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {renameSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {IncomingMessage} from 'node:http';
import {Socket} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {Capacity} from '../src/capacity.ts';
import {digest, Refusal} from '../src/contracts.ts';
import {prepareClaudeExamAccessToken} from '../src/exam-login.ts';
import {Ledger, VERIFICATION_MODULES} from '../src/ledger.ts';
import {moduleExamConnectHost, moduleExamSocket, monitorModuleExamEgress, startModuleExamEgress} from '../src/module-exam-egress.ts';
import {moduleExamCodexBody, readModuleExamCodexOutput, readModuleExamCodexResponse} from '../src/module-exam-codex.ts';
import {FUNCTION_COVERAGE_RULE} from '../src/module-recheck-regression.ts';
import type {ModuleExamRuntime} from '../src/module-exam-native.ts';
import {moduleExamClaudeArgs, readModuleExamClaudeOutput} from '../src/module-exam-worker.ts';
import {moduleCliFailureText, parsePersonalModuleArgs, runPersonalModuleCli, type PersonalModuleCliDeps} from '../src/personal-module-cli.ts';
import {runPersonalQaCli} from '../src/personal-qa-cli.ts';
import {readModuleReport, type ModuleCollectorOutput, type VerificationModuleRunResult} from '../src/verification-modules.ts';
import {createModuleExamFixture, moduleExamFixtureAnswer} from './fixtures/module-exam-native.ts';
import {qaStaticFinding, qaStaticTool, reviewFixtureVerdict, skipQuestion, type ReviewTaskFixture} from './fixtures/module-exam-review.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('provedores recebem apenas HTTPS fixo e o Claude inicia sem ferramentas nem configuração externa', () => {
  const connect = (host: string) => `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443`;
  assert.equal(moduleExamConnectHost(connect('chatgpt.com'), 'codex'), 'chatgpt.com');
  assert.equal(moduleExamConnectHost(connect('api.anthropic.com'), 'claude'), 'api.anthropic.com');
  for (const host of ['api.anthropic.com', '127.0.0.1', 'chatgpt.com.example.invalid', 'target.example.invalid']) {
    assert.equal(moduleExamConnectHost(connect(host), 'codex'), undefined);
  }
  assert.equal(moduleExamConnectHost(connect('chatgpt.com') + '\r\nTransfer-Encoding: chunked', 'codex'), undefined);
  assert.equal(moduleExamConnectHost('GET https://chatgpt.com HTTP/1.1', 'codex'), undefined);
  const args = moduleExamClaudeArgs({model: 'test-claude', effort: 'medium'});
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'user');
  assert.equal(args[args.indexOf('--disallowedTools') + 1], '*');
  assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.ok(args.includes('--strict-mcp-config') && args.includes('--no-session-persistence'));
});

test('Codex solicita somente texto e confere o modelo e os tipos de saída', () => {
  const task = 'Evidência sintética observacional';
  const request = moduleExamCodexBody('fixture', 'medium', task);
  assert.deepEqual(request.tools, []);
  assert.equal(request.tool_choice, 'none');
  assert.equal(request.parallel_tool_calls, false);
  assert.equal(request.store, false);
  assert.equal(request.input[0]?.content[0]?.text, task);

  const frame = (value: object) => 'data: ' + JSON.stringify(value) + '\r\n\r\n';
  const verdict = '{"kind":"confirmacao"}';
  const output = [{type: 'reasoning'}, {type: 'message', role: 'assistant', content: [{type: 'output_text', text: verdict}]}];
  const completed = frame({type: 'response.completed', response: {model: 'fixture', status: 'completed', output}});
  assert.equal(readModuleExamCodexOutput(completed, 'fixture'), verdict);
  assert.throws(() => readModuleExamCodexOutput(completed, 'alternate'), /MODULE_EXAM_RESPONSE_INVALID/);
  const unexpected = frame({type: 'response.output_item.added', item: {type: 'function_call'}});
  assert.throws(() => readModuleExamCodexOutput(unexpected + completed, 'fixture'), /MODULE_EXAM_RESPONSE_INVALID/);
  assert.throws(() => readModuleExamCodexOutput(frame({type: 'error', code: 'usage_limit_reached'}), 'fixture'), /PROVIDER_USAGE_LIMIT/);
});

test('Claude só entrega texto quando a sessão observada tem o modelo reservado e ferramentas vazias', () => {
  const init = {type: 'system', subtype: 'init', model: 'fixture', tools: [], mcp_servers: []};
  const verdict = {type: 'result', subtype: 'success', is_error: false, result: '{"kind":"exame"}'};
  const report = (...events: object[]) => readModuleExamClaudeOutput(events.map(event => JSON.stringify(event)).join('\n'), 'fixture');
  assert.equal(report(init, verdict).output, verdict.result);
  assert.equal(report({...init, model: 'alternate'}, verdict).succeeded, false);
  assert.equal(report({...init, tools: ['Bash']}, verdict).succeeded, false);
  assert.equal(report(init, {type: 'assistant', message: {model: 'fixture', content: [{type: 'tool_use'}]}}, verdict).succeeded, false);
  assert.deepEqual(report(init, {type: 'result', subtype: 'error_during_execution', is_error: true,
    errors: ['usage limit reached']}).diagnostics, ['', 'usage limit reached']);
});

test('credencial vencida interrompe o exame sem renovar ou alterar a conta', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-module-auth-test-'));
  const file = join(root, '.credentials.json');
  const now = 1_800_000_000_000;
  const original = JSON.stringify({claudeAiOauth: {
    accessToken: 'fixture-oauth-access', refreshToken: 'fixture-oauth-renewal', expiresAt: now - 1000,
  }});
  try {
    await writeFile(file, original, {mode: 0o600});
    let renewals = 0;
    await assert.rejects(prepareClaudeExamAccessToken({accountDir: root, now, freshOnly: true,
      async renew() { renewals++; }}), /EXAM_LOGIN_STALE/);
    assert.equal(renewals, 0);
    assert.equal(await readFile(file, 'utf8'), original);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('o fechamento do relay encerra a autorização de inferência do worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-module-relay-test-'));
  const socket = join(root, 'egress.sock');
  const close = await startModuleExamEgress(socket, 'codex');
  try {
    let lost!: () => void;
    const closed = new Promise<void>(resolve => { lost = resolve; });
    await monitorModuleExamEgress(socket, lost);
    close();
    await closed;
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

const base = process.env.AC_TEST_DATABASE_URL;
const skippedOther = 'test.todo("valida estoque", () => {});';
test('status 429 prevalece com corpo vazio, excessivo ou sem fim', async () => {
  for (const body of [null, Buffer.alloc(1024 * 1024 + 1), undefined]) {
    const response = new IncomingMessage(new Socket());
    response.statusCode = 429;
    if (body !== undefined) response.push(body);
    const verdict = readModuleExamCodexResponse(response, 'fixture');
    assert.equal(response.listenerCount('data'), 0);
    assert.equal(response.destroyed, true);
    await assert.rejects(verdict, (error: unknown) => error instanceof Refusal && error.code === 'PROVIDER_USAGE_LIMIT');
  }
});

test('as oito CLIs pessoais aceitam apenas identificadores de achado na reverificação', () => {
  const runId = randomUUID();
  for (const module of VERIFICATION_MODULES) {
    assert.deepEqual(parsePersonalModuleArgs(module, ['installation.json', 'Projeto', '--reverificar', runId, 'ACH-001', 'ACH-002']),
      {kind: 'recheck', module, installationPath: 'installation.json', projectToken: 'Projeto', runId, achadoIds: ['ACH-001', 'ACH-002']});
    for (const args of [[runId], [runId, 'ACH-1'], [runId, 'ACH-001', '--descartar'], ['invalid', 'ACH-001']]) {
      assert.throws(() => parsePersonalModuleArgs(module, ['installation.json', 'Projeto', '--reverificar', ...args]), /VERIFY_USAGE/);
    }
    assert.match(moduleCliFailureText(new Refusal('VERIFY_USAGE'), module), /--reverificar/);
  }
});

test('CLI pessoal usa reservas e recibos do supervisor e preserva pendências na cota e na indisponibilidade',
  {skip: !base}, async t => {
    const database = await isolatedDatabase(base!, 'moduleexam');
    const ledger = new Ledger(database.url);
    const root = await mkdtemp(join(tmpdir(), 'ac-module-native-test-'));
    let exhaust = false;
    let examineFunctionalFinding = false;
    let recheckAnswer: ((task: ReviewTaskFixture) => string) | undefined;
    let fixture: Awaited<ReturnType<typeof createModuleExamFixture>> | undefined;
    try {
      await ledger.migrate();
      const dataDirectory = join(root, 'data'), repo = join(root, 'repo');
      for (const path of [dataDirectory, repo]) await mkdir(path, {mode: 0o700});
      const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', repo, ...args], {stdio: 'pipe'});
      const skippedIndex = 'test.skip("valida pedidos", () => assert.equal(total(), 43))';
      const activeIndex = skippedIndex.replace('test.skip', 'test');
      const originalCode = `export function total() { return 42; } ${skippedIndex};`;
      const correctedCode = `export function total() { return 43; } ${activeIndex};`;
      const writeIndex = (code: string, password: string) => writeFile(join(repo, 'index.ts'),
        code + '\n' + "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" +
        `const password = "${password}";\n`);
      const staleTest = 'test("valida inventário", () => {})';
      await writeIndex(originalCode, 'SEGREDO_SINTETICO_OMITIDO');
      await writeFile(join(repo, 'other.ts'), skippedOther + '\n' + staleTest + ';\n');
      await writeFile(join(repo, '.env'), 'CONTEUDO_SINTETICO_PROTEGIDO\n');
      git('init'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'synthetic');

      const project = randomUUID(), owner = 'module-exam-owner', otherProject = randomUUID();
      await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Fixture']);
      await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, owner]);
      await ledger.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)', [project, repo]);
      await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [otherProject, 'Outro projeto']);
      await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [otherProject, owner]);
      await ledger.createContext(owner, otherProject, randomUUID());
      await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1)', [owner]);
      await ledger.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
      const context = await ledger.createContext(owner, project, randomUUID());
      const capacity = new Capacity(ledger);
      await capacity.configure(owner, {programmingLimit: 2, evaluationLimit: 2});
      const random = 'Math.random()';
      const wait = 'page.waitForTimeout(250)';
      fixture = await createModuleExamFixture({root, repo, ledger, owner, project, answer(launch) {
        const task = JSON.parse(launch.task);
        if (recheckAnswer && (task.originalCommit || task.criterion === 'test-skip-modifier')) {
          return {failureCode: null, output: recheckAnswer(task)};
        }
        if (launch.provider === 'codex' && exhaust) return {output: 'diagnóstico privado descartado', failureCode: 'PROVIDER_USAGE_LIMIT'};
        if (task.file === 'index.ts' && task.checklist && examineFunctionalFinding) {
          return {failureCode: null, output: JSON.stringify({kind: 'exame', filesRead: [task.file],
            checklist: ['qa'], findings: [{line: 1, snippet: skippedIndex, hypothesis: skipQuestion,
              title: 'Teste funcional pulado', severity: 'baixa'}]})};
        }
        if (task.file === 'index.ts' && task.criterion) {
          return {failureCode: null, output: JSON.stringify(reviewFixtureVerdict(task, skippedIndex))};
        }
        if (task.file === 'syntactic.ts' && task.criterion) {
          return {failureCode: null, output: JSON.stringify(reviewFixtureVerdict(task, task.line === 1 ? random : wait))};
        }
        return moduleExamFixtureAnswer(launch);
      }});
      const {docker, runtime, profiles} = fixture;
      const revision = await capacity.publish(owner, project, 0, {schemaVersion: 1, maxProgrammersPerContext: 1,
        maxEvaluatorsPerContext: 1, roles: {specialist: {regular: profiles, emergency: []}}});
      await capacity.assignPolicy(owner, context, revision);
      const installation = join(dataDirectory, 'installation.json');
      await writeFile(installation, JSON.stringify({schemaVersion: 1, mode: 'administration-only', activation: 'personal',
        databaseUrl: database.url, dataDirectory, project: {id: project, label: 'Fixture', repo, owner},
        projects: [{id: otherProject, label: 'Outro projeto', repo: join(root, 'other-repo'), owner}],
        http: {listen: '127.0.0.1', port: 8765, publicOrigin: 'http://127.0.0.1:8765'},
        happier: {upstreamOrigin: 'http://127.0.0.1:8766', webOrigin: 'http://127.0.0.1:8766', publicServerOrigin: 'http://127.0.0.1:8765'}}), {mode: 0o600});
      const collectorOutput: ModuleCollectorOutput = {coverage: [{tool: qaStaticTool, version: '1', status: 'ok', detail: 'leitura local'}],
        findings: [qaStaticFinding('index.ts', 1, skippedIndex + ';'), qaStaticFinding('other.ts', 1, skippedOther)]};
      let result: VerificationModuleRunResult | undefined;
      const run = (moduleExamRuntime: NonNullable<PersonalModuleCliDeps['moduleExamRuntime']>) =>
        runPersonalModuleCli('qa', [installation, project], {collectorOutput, moduleExamRuntime,
          onResult(value) { result = value; }});
      await runPersonalModuleCli('qa', [installation, project], {collectorOutput, onResult(value) { result = value; }});
      assert.equal(result?.achados.length, 2);
      assert.ok(result?.achados.every(f => f.status === 'provavel' && f.verifier === null));
      await runPersonalModuleCli('qa', [installation, project], {runCollector: async () => collectorOutput,
        onResult(value) { result = value; }});
      assert.equal(result?.achados.length, 2);
      assert.ok(result?.achados.every(f => f.status === 'provavel' && f.verifier === null));

      await run(async () => []);
      assert.equal(docker.logs.length, 0);
      assert.equal(result?.achados.length, 2);
      assert.ok(result?.achados.every(f => f.status === 'provavel' && f.verifier === null));
      assert.match(await readFile(join(result!.directory, 'cobertura.md'), 'utf8'), /Examinador indisponível/);

      await run(async () => runtime.slice(0, 1));
      assert.equal(docker.logs.length, 2);
      assert.equal(result?.achados.length, 2);
      assert.ok(result?.achados.every(f => f.status === 'provavel' && f.verifier === null));
      assert.match(await readFile(join(result!.directory, 'cobertura.md'), 'utf8'), /Revisor de outro provedor indisponível/);

      const reviewer = runtime[1]!;
      const reviewerSupervisor = reviewer.supervisor;
      let checkedRelease = 0;
      await run(async () => [runtime[0]!, {...reviewer, supervisor: {
        start: reviewerSupervisor.start.bind(reviewerSupervisor), stop: reviewerSupervisor.stop.bind(reviewerSupervisor),
        closeModuleExamEgress: reviewerSupervisor.closeModuleExamEgress.bind(reviewerSupervisor),
        retireTerminal: reviewerSupervisor.retireTerminal.bind(reviewerSupervisor),
        async reconcile(principal, authority, request) {
          const outcome = await reviewerSupervisor.reconcile(principal, authority, request);
          if (outcome.state === 'completed') {
            const grant = async () => (await ledger.pool.query('SELECT state, physical_receipt FROM ac_capacity_grants WHERE id=$1', [request.grantId])).rows[0];
            const saved = await grant();
            assert.equal(saved.state, 'released');
            assert.ok(saved.physical_receipt.containerId);
            const {rows: [job]} = await ledger.pool.query('SELECT receipt FROM ac_native_execution_jobs WHERE id=$1', [request.jobId]);
            assert.equal(job.receipt.payload.physicalDigest, digest(saved.physical_receipt));
            for (let retry = 0; retry < 2; retry++) {
              await capacity.transition(principal, request.grantId, authority, 'released', {processId: request.grantId, state: 'exited'});
              assert.deepEqual(await grant(), saved);
            }
            checkedRelease++;
          }
          return outcome;
        },
      }}]);
      assert.equal(docker.logs.length, 6);
      assert.equal(checkedRelease, 2);
      assert.deepEqual(result?.achados.map(f => [f.status, f.verifier?.provider]), [['confirmado', 'codex'], ['confirmado', 'codex']]);
      const todoRun = result!.runId;
      assert.deepEqual((await ledger.pool.query('SELECT DISTINCT provenance FROM ac_verify_coverage WHERE run_id=$1', [result!.runId])).rows,
        [{provenance: 'examiner'}]);
      for (const launch of docker.logs) {
        assert.equal(launch.moduleExam, true);
        assert.equal(launch.role, 'specialist');
        assert.deepEqual(launch.writePaths, []);
        assert.doesNotMatch(launch.task, /SEGREDO_SINTETICO_OMITIDO|CONTEUDO_SINTETICO_PROTEGIDO|CONCLUSAO_DO_AUTOR|\/tmp\//);
      }

      exhaust = true;
      await assert.rejects(run(async () => runtime), (error: unknown) => error instanceof Refusal && error.code === 'PROVIDER_USAGE_LIMIT');
      assert.equal(docker.logs.length, 9);
      assert.equal(result?.achados.length, 2);
      assert.ok(result?.achados.every(f => f.status === 'provavel' && f.verifier === null));
      const report = await readFile(join(result!.directory, 'cobertura.md'), 'utf8');
      assert.match(report, /PROVIDER_USAGE_LIMIT/);
      assert.doesNotMatch(report, /diagnóstico privado/);
      assert.ok((await ledger.pool.query("SELECT exhausted_until FROM ac_accounts WHERE provider='codex'")).rows[0].exhausted_until);
      exhaust = false;
      await assert.rejects(run(async () => runtime), (error: unknown) => error instanceof Refusal && error.code === 'PROVIDER_USAGE_LIMIT');
      assert.equal(docker.logs.length, 11);
      assert.ok(result?.achados.every(f => f.status === 'provavel' && f.verifier === null));
      assert.match(await readFile(join(result!.directory, 'cobertura.md'), 'utf8'), /PROVIDER_USAGE_LIMIT/);
      const grants = (await ledger.pool.query("SELECT state,physical_receipt FROM ac_capacity_grants ORDER BY created_at")).rows;
      assert.equal(grants.length, docker.logs.length);
      assert.ok(grants.every(g => g.state === 'released' && g.physical_receipt.containerId));
      for (const observed of docker.observations) {
        if (!observed.Mounts.length) { assert.equal(observed.Config.Entrypoint[1], '-e'); continue; }
        assert.equal(observed.HostConfig.NetworkMode, 'none');
        assert.ok(observed.Mounts.some(mount => mount.Destination === moduleExamSocket && !mount.RW));
        assert.deepEqual(observed.Mounts.filter(mount => mount.RW).map(mount => mount.Destination), ['/output']);
        assert.ok(observed.Mounts.every(mount => !mount.Source.startsWith(repo) && mount.Destination !== '/work'));
      }
      assert.equal(docker.containers.size, 0);
      assert.equal(docker.networks.size, 0);
      docker.check();

      const reviewerAccount = [...runtime[1]!.accountIds][0]!;
      await ledger.pool.query('UPDATE ac_accounts SET exhausted_until=NULL WHERE id=$1', [reviewerAccount]);
      await capacity.observeQuota(owner, reviewerAccount, {status: 'available', ttlSeconds: 3600, source: 'synthetic://module-exam'});
      let lostQuotaGrant: string | undefined;
      await assert.rejects(run(async () => [runtime[0]!, {...reviewer, supervisor: {
        async start(...args) {
          lostQuotaGrant = args[2].grantId;
          const reserved = (await ledger.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1', [lostQuotaGrant])).rows[0];
          assert.equal(reserved.state, 'reserved');
          await capacity.observeQuota(owner, reviewerAccount, {status: 'rate_limited', ttlSeconds: 3600, source: 'synthetic://module-exam'});
          return reviewerSupervisor.start(...args);
        },
        stop: reviewerSupervisor.stop.bind(reviewerSupervisor), reconcile: reviewerSupervisor.reconcile.bind(reviewerSupervisor),
        closeModuleExamEgress: reviewerSupervisor.closeModuleExamEgress.bind(reviewerSupervisor),
        retireTerminal: reviewerSupervisor.retireTerminal.bind(reviewerSupervisor),
      }}]), (error: unknown) => error instanceof Refusal && error.code === 'PROVIDER_USAGE_LIMIT');
      assert.ok(lostQuotaGrant);
      assert.equal(docker.logs.length, 13);
      assert.equal((await ledger.pool.query('SELECT 1 FROM ac_native_execution_jobs WHERE grant_id=$1', [lostQuotaGrant])).rowCount, 0);
      const {rows: [unusedGrant]} = await ledger.pool.query('SELECT state, physical_receipt FROM ac_capacity_grants WHERE id=$1', [lostQuotaGrant]);
      assert.deepEqual(unusedGrant, {state: 'released', physical_receipt: {processId: lostQuotaGrant, state: 'not_started'}});
      assert.ok(result?.achados.every(f => f.status === 'provavel' && f.verifier === null));
      assert.match(await readFile(join(result!.directory, 'cobertura.md'), 'utf8'), /PROVIDER_USAGE_LIMIT/);
      await capacity.observeQuota(owner, reviewerAccount, {status: 'available', ttlSeconds: 3600, source: 'synthetic://module-exam'});
      // Keep the V8-only observation separate from the examiner's verifiable defect.
      const v8Coverage = {tool: 'node-test-v8', version: '22', status: 'ok' as const, detail: 'três execuções estáveis'};
      const opaqueFinding = {tool: v8Coverage.tool, rule: 'QA-COBERTURA-FUNCAO-SEM-TESTE', file: 'index.ts', line: 1,
        severity: 'alta', message: 'Função exportada sem execução medida', evidence: 'contagem V8 da função nas passadas 1, 2 e 3: 0, 0, 0'};
      const [collectorRun] = await runPersonalQaCli([installation, project], {collectorOutput: {
        coverage: [v8Coverage, ...collectorOutput.coverage],
        findings: [opaqueFinding, qaStaticFinding('other.ts', 2, staleTest.replace('test(', 'test.skip('))],
      }});
      const collectorRecheck = (id: string) =>
        runPersonalQaCli([installation, project, '--reverificar', collectorRun!, id], {moduleExamRuntime: async () => runtime});
      const collectorStatuses = async () => (await readModuleReport(dataDirectory, project, collectorRun!, 'qa')).achados.map(f => f.status);
      assert.deepEqual(await collectorStatuses(), ['provavel', 'provavel']);

      examineFunctionalFinding = true;
      const [reviewRunId] = await runPersonalQaCli([installation, project], {
        collectorOutput: {coverage: [v8Coverage], findings: []},
        moduleExamRuntime: async () => runtime,
      });
      examineFunctionalFinding = false;
      assert.ok(reviewRunId);
      const args = [installation, project, '--reverificar', reviewRunId, 'ACH-001'];
      const recheck = (seats: ModuleExamRuntime = runtime) => runPersonalQaCli(args, {moduleExamRuntime: async () => seats});
      const findingStatus = async () => (await readModuleReport(dataDirectory, project, reviewRunId, 'qa')).achados[0]?.status;
      const refuses = (code: string) => (error: unknown) => error instanceof Refusal && error.code === code;
      const count = docker.logs.length;
      await assert.rejects(runPersonalModuleCli('arquitetura', args), refuses('VERIFY_RUN_MISSING'));
      await assert.rejects(runPersonalQaCli([installation, otherProject, ...args.slice(2)]), refuses('VERIFY_RUN_MISSING'));
      await ledger.pool.query("UPDATE ac_memberships SET role='viewer' WHERE project_id=$1 AND principal_id=$2", [project, owner]);
      await assert.rejects(recheck(), refuses('PROJECT_FORBIDDEN'));
      await ledger.pool.query("UPDATE ac_memberships SET role='owner' WHERE project_id=$1 AND principal_id=$2", [project, owner]);
      const {contextId} = await ledger.ensureExamContext(owner, project, 'qa');
      const existing = await ledger.acquire(owner, contextId, randomUUID(), 'fixture-manager', 60);
      try { await assert.rejects(recheck(), refuses('VERIFY_ALREADY_RUNNING')); }
      finally { await ledger.releaseLease(existing); }
      assert.equal(docker.logs.length, count);

      // The actual top-level command reaches the same route with no active native runtime.
      const {stdout, stderr} = await promisify(execFile)(process.execPath, ['scripts/personal-qa.mjs', ...args], {
        env: {PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8'}, timeout: 20_000,
      });
      assert.equal(stderr, '');
      assert.equal(stdout.trim(), 'ACH-001 pendente MODULE_EXAM_REVIEWER_UNAVAILABLE');
      assert.deepEqual(await recheck(runtime.slice(0, 1)), ['ACH-001 pendente MODULE_EXAM_REVIEWER_UNAVAILABLE']);
      assert.equal(await findingStatus(), 'confirmado');
      assert.equal(docker.logs.length, count);

      const commitChanges = (label: string, ...rest: string[]) =>
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', label, ...rest);
      const verdict = (task: ReviewTaskFixture) => JSON.stringify(reviewFixtureVerdict(task, activeIndex, 'descartado'));

      // A structured refutation without a committed change cannot close a stale collector finding.
      recheckAnswer = task => JSON.stringify(reviewFixtureVerdict(task, staleTest, 'descartado'));
      assert.deepEqual(await collectorRecheck('ACH-002'), ['ACH-002 pendente MODULE_RECHECK_PROOF_UNAVAILABLE']);
      commitChanges('synthetic unrelated change', '--allow-empty');
      assert.deepEqual(await collectorRecheck('ACH-002'), ['ACH-002 pendente MODULE_RECHECK_PROOF_UNAVAILABLE']);
      assert.deepEqual(await collectorStatuses(), ['provavel', 'provavel']);

      recheckAnswer = task => verdict(task);
      assert.deepEqual(await recheck(), ['ACH-001 pendente MODULE_RECHECK_PROOF_UNAVAILABLE']);
      await writeIndex(correctedCode, 'NOVA_CREDENCIAL_SINTETICA');
      git('add', 'index.ts');
      commitChanges('synthetic correction');
      assert.deepEqual(await recheck(), ['ACH-001 pendente MODULE_RECHECK_PROOF_UNAVAILABLE']);
      recheckAnswer = task => verdict({...task, code: 'prova sem vínculo com o trecho'});
      assert.deepEqual(await recheck(), ['ACH-001 pendente MODULE_RECHECK_PROOF_UNAVAILABLE']);
      assert.equal(await findingStatus(), 'confirmado');

      recheckAnswer = task => {
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'synthetic concurrent HEAD');
        return verdict(task);
      };
      await assert.rejects(recheck(), refuses('VERIFY_RUN_CONFLICT'));
      assert.equal(await findingStatus(), 'confirmado');
      recheckAnswer = task => {
        process.emit('SIGINT', 'SIGINT');
        return verdict(task);
      };
      await assert.rejects(recheck(), refuses('EXAM_INTERRUPTED'));
      assert.equal(await findingStatus(), 'confirmado');
      const {rows: [cancelled]} = await ledger.pool.query(`SELECT i.state, m.lease_until <= clock_timestamp() AS released
        FROM ac_intents i JOIN ac_managers m USING (context_id) WHERE i.command->'payload'->>'messageRef'=$1
        ORDER BY i.manager_epoch DESC LIMIT 1`, [`recheck:${reviewRunId}`]);
      assert.deepEqual(cancelled, {state: 'failed', released: true});

      recheckAnswer = verdict;
      assert.deepEqual(await recheck(), ['ACH-001 pendente MODULE_RECHECK_PROOF_UNAVAILABLE']);
      assert.equal(await findingStatus(), 'confirmado');
      const launch = docker.logs.at(-1)!;
      assert.equal(launch.provider, 'codex');
      assert.equal(launch.moduleExam, true);
      assert.deepEqual(launch.writePaths, []);
      assert.ok(JSON.parse(launch.task).code.includes(activeIndex));
      const correctedHead = git('rev-parse', 'HEAD').toString().trim();
      assert.doesNotMatch(launch.task, /NOVA_CREDENCIAL_SINTETICA|CONCLUSAO_DO_AUTOR|\/tmp\//);
      const {rows: [pending]} = await ledger.pool.query(`SELECT detail FROM ac_audit
        WHERE kind='module.finding_rechecked' AND detail->>'status'='pendente' AND context_id=$1
          AND detail->>'commit'=$2`, [contextId, correctedHead]);
      assert.equal(pending.detail.reason, 'MODULE_RECHECK_PROOF_UNAVAILABLE');
      assert.equal(pending.detail.proofDigest, null);
      assert.deepEqual(pending.detail.examiner, {provider: 'claude', model: 'claude-module-fixture',
        accountId: [...runtime[0]!.accountIds][0], profileId: profiles[0]});
      assert.deepEqual(pending.detail.reviewer, {provider: 'codex', model: 'codex-module-fixture',
        accountId: reviewerAccount, profileId: profiles[1], grantId: pending.detail.reviewer.grantId});
      const {rows: [receipt]} = await ledger.pool.query('SELECT state, physical_receipt FROM ac_capacity_grants WHERE id=$1', [pending.detail.reviewer.grantId]);
      assert.equal(receipt.state, 'released');
      assert.ok(receipt.physical_receipt.containerId);

      const activeTodo = skippedOther.replace('test.todo', 'test').slice(0, -1);
      await writeFile(join(repo, 'other.ts'), activeTodo + ';\n' + staleTest + ';\n');
      git('add', 'other.ts');
      commitChanges('synthetic modifier removal only');
      recheckAnswer = task => JSON.stringify(reviewFixtureVerdict(task, activeTodo, 'descartado'));
      assert.deepEqual(await runPersonalQaCli([installation, project, '--reverificar', todoRun, 'ACH-002'], {
        moduleExamRuntime: async () => runtime,
      }), ['ACH-002 pendente MODULE_RECHECK_FUNCTIONAL_RULE_UNSUPPORTED (A regra ainda não dispõe de prova funcional de antes e depois.)']);
      const skipTask = JSON.parse(docker.logs.at(-1)!.task);
      assert.equal(skipTask.code, activeTodo + ';');
      assert.deepEqual(skipTask.skipRemoval, {column: 1, expression: activeTodo});
      assert.equal(skipTask.originalCommit, undefined);
      assert.equal(skipTask.originalCode, undefined);
      assert.equal(skipTask.skipSnapshot, undefined);
      assert.equal((await readModuleReport(dataDirectory, project, todoRun, 'qa')).achados[1]?.status, 'confirmado');
      recheckAnswer = verdict;

      await writeFile(join(repo, 'runtime.log'), 'REGISTRO_SINTETICO_PROTEGIDO\n');
      git('add', 'runtime.log');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'synthetic log');
      const protectedFindings = [
        {tool: 'fixture', rule: 'LOG', file: 'runtime.log', line: 1, severity: 'baixa', message: 'Log', evidence: 'REGISTRO_SINTETICO_PROTEGIDO'},
        {tool: 'prontidao-audit', rule: 'PRONTIDAO-SEGREDO-ARQUIVO-ENV', file: '.env', line: 1, severity: 'baixa',
          message: 'Possível segredo em arquivo protegido.', evidence: 'Localização informada pelo coletor; conteúdo protegido.'},
      ];
      const [protectedRun] = await runPersonalModuleCli('prontidao', [installation, project], {collectorOutput: {
        coverage: ['fixture', 'prontidao-audit'].map(tool => ({tool, version: '1', status: 'ok', detail: 'leitura local'})),
        findings: protectedFindings,
      }});
      const protectedBefore = (await readModuleReport(dataDirectory, project, protectedRun!, 'prontidao')).achados;
      assert.deepEqual(await runPersonalModuleCli('prontidao', [installation, project, '--reverificar', protectedRun!, 'ACH-001', 'ACH-002'], {
        moduleExamRuntime: async () => { throw Error('protected findings must not call the runtime'); },
      }), ['ACH-001 pendente MODULE_RECHECK_PROTECTED', 'ACH-002 pendente MODULE_RECHECK_PROTECTED']);
      assert.deepEqual((await readModuleReport(dataDirectory, project, protectedRun!, 'prontidao')).achados, protectedBefore);
      assert.doesNotMatch(JSON.stringify(docker.logs.slice(count)), /REGISTRO_SINTETICO_PROTEGIDO|CONTEUDO_SINTETICO_PROTEGIDO/);

      const seat = runtime[1]!, supervisor = seat.supervisor;
      const beforeLaunch = {...seat, supervisor: {
        start: async () => { throw new Refusal('EXAM_LOGIN_STALE'); },
        stop: supervisor.stop.bind(supervisor), reconcile: supervisor.reconcile.bind(supervisor),
        retireTerminal: supervisor.retireTerminal.bind(supervisor), closeModuleExamEgress: supervisor.closeModuleExamEgress.bind(supervisor),
      }};
      assert.deepEqual(await recheck([beforeLaunch]), ['ACH-001 pendente EXAM_LOGIN_STALE']);
      const lastGrant = async () => (await ledger.pool.query('SELECT state, physical_receipt FROM ac_capacity_grants ORDER BY created_at DESC LIMIT 1')).rows[0];
      assert.equal((await lastGrant()).state, 'released');
      assert.equal((await lastGrant()).physical_receipt.state, 'not_started');

      let recoveryRequest: Parameters<typeof supervisor.start>[2] | undefined;
      const uncertain = {...beforeLaunch, supervisor: {...beforeLaunch.supervisor,
        async start(...args: Parameters<typeof supervisor.start>) {
          recoveryRequest = args[2];
          return supervisor.start(...args);
        },
        stop: async () => { throw Error('synthetic stop unavailable'); },
        reconcile: async () => { throw Error('synthetic result unavailable'); },
      }};
      assert.deepEqual(await recheck([uncertain]), ['ACH-001 pendente MODULE_RECHECK_RESULT_UNCERTAIN']);
      assert.equal((await lastGrant()).state, 'running');
      assert.equal((await lastGrant()).physical_receipt, null);
      assert.equal(await findingStatus(), 'confirmado');
      assert.ok(recoveryRequest);
      const recovery = await ledger.acquire(owner, contextId, randomUUID(), 'fixture-reconciler', 60);
      try {
        assert.equal((await supervisor.reconcile(owner, recovery, recoveryRequest)).state, 'uncertain');
        assert.equal((await supervisor.reconcile(owner, recovery, recoveryRequest)).state, 'completed');
        await supervisor.retireTerminal(owner, recovery, recoveryRequest.jobId);
      } finally {
        await ledger.releaseLease(recovery);
      }
      assert.equal((await lastGrant()).state, 'released');
      assert.ok((await lastGrant()).physical_receipt.containerId);

      await writeIndex(originalCode, 'NOVA_CREDENCIAL_SINTETICA');
      git('add', 'index.ts');
      commitChanges('synthetic recurrence');
      recheckAnswer = task => JSON.stringify(reviewFixtureVerdict(task, skippedIndex));
      await ledger.pool.query(`CREATE FUNCTION synthetic_interrupt_publication() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.kind='module.recheck_report_pending' THEN PERFORM pg_notify('synthetic_verdict_committed', '');
          ELSIF NEW.kind='module.recheck_report_published' THEN PERFORM pg_sleep(0.25);
          END IF;
          RETURN NEW;
        END $$`);
      await ledger.pool.query(`CREATE TRIGGER synthetic_interrupt_publication
        AFTER INSERT ON ac_audit FOR EACH ROW EXECUTE FUNCTION synthetic_interrupt_publication()`);
      const listener = await ledger.pool.connect();
      try {
        await listener.query('LISTEN synthetic_verdict_committed');
        listener.once('notification', () => process.emit('SIGINT', 'SIGINT'));
        const interrupted = await recheck();
        assert.equal(interrupted[0], 'ACH-001 reaberto');
        assert.match(interrupted[1]!, /Vereditos gravados.*VERIFY_RECHECK_PUBLICATION_PENDING/);
      } finally {
        await listener.query('UNLISTEN synthetic_verdict_committed');
        listener.release();
        await ledger.pool.query('DROP TRIGGER synthetic_interrupt_publication ON ac_audit');
        await ledger.pool.query('DROP FUNCTION synthetic_interrupt_publication()');
      }
      const beforeRetry = docker.logs.length;
      assert.deepEqual(await recheck([]), ['ACH-001 reaberto']);
      assert.equal(await findingStatus(), 'reaberto');
      assert.deepEqual(await recheck([]), ['ACH-001 reaberto']);
      assert.equal(docker.logs.length, beforeRetry);

      await t.test('CLI publica títulos sintáticos para observações confirmadas do coletor', async () => {
        const file = 'syntactic.ts';
        await writeFile(join(repo, file), `const Math = {random: () => 7}; ${random};\n`
          + `const page = {waitForTimeout: () => undefined}; ${wait};\n`);
        git('add', file);
        commitChanges('synthetic static calls');
        const [syntaxRun] = await runPersonalQaCli([installation, project], {moduleExamRuntime: async () => runtime,
          collectorOutput: {coverage: collectorOutput.coverage, findings: [
            {...qaStaticFinding(file, 1, random, 'nondeterminism'), message: 'A chamada retorna resultado aleatório'},
            {...qaStaticFinding(file, 2, wait, 'nondeterminism'), message: 'A chamada aguarda 250 milissegundos'},
          ]}});
        const report = await readModuleReport(dataDirectory, project, syntaxRun!, 'qa');
        assert.deepEqual(report.achados.map(({status, title}) => [status, title]), [
          ['confirmado', 'Chamada direta a Math.random no código'],
          ['confirmado', 'Chamada direta a waitForTimeout no código'],
        ]);
      });

      await t.test('CLI reverifica a mesma asserção no código original e corrigido e publica uma vez', async () => {
        // The coverage rows are synthetic. The two regression results come from
        // the CLI actually running the same Git test blob in two Node processes.
        const sourceFile = 'totals.ts';
        const testFile = 'tests/qa/ach-001.test.ts';
        await mkdir(join(repo, 'tests', 'qa'), {recursive: true});
        const source = (value: string) => `export function total() { return ${value}; }\nexport function other() { return 5; }\n`;
        const moved = 'export function other() { return 5; }\n\nexport function total() {\n  return 43;\n}\n';
        const title = "Total: pedido (R$ 43) — certo?";
        const testBody = (expected: number, name = 'total') => "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
          + `import {${name}} from '../../totals.ts';\ntest('${title}', () => assert.equal(${name}(), ${expected}));\n`;
        const commitSource = async (label: string, code: string, probe?: string) => {
          await writeFile(join(repo, sourceFile), code);
          if (probe !== undefined) await writeFile(join(repo, testFile), probe);
          git('add', '.');
          commitChanges(label);
          return git('rev-parse', 'HEAD').toString().trim();
        };
        const originalHead = await commitSource('synthetic untested total', source('42'));
        const uncovered = {...opaqueFinding, file: sourceFile, rule: FUNCTION_COVERAGE_RULE, severity: 'alta' as const,
          message: "Função exportada 'total' sem execução medida pelo V8"};
        const image = `sha256:${'b'.repeat(64)}`;
        const recordCoverage = async (findings: ModuleCollectorOutput['findings'] = [], version = v8Coverage.version,
          pin = image, partial = false) => {
          const pass = findings.length ? 'ramos 0/0, funções 1/2' : 'ramos 0/0, funções 2/2';
          const [id] = await runPersonalQaCli([installation, project], {image: pin, collectorOutput: {
            coverage: [{...v8Coverage, version, detail: 'Medição sintética da ferramenta'},
              {tool: `qa-arquivo:${sourceFile}`, status: 'ok', version,
                detail: `V8 em três passadas: ${pass}; ${pass}; ${partial ? 'arquivo sem medição' : pass}`}],
            findings,
          }});
          assert.ok(id);
          return id;
        };
        const originRun = await recordCoverage([uncovered]);
        const functionalArgs = [installation, project, '--reverificar', originRun, 'ACH-001'];
        const functionalRecheck = (seats: ModuleExamRuntime = runtime.slice(1)) =>
          runPersonalQaCli(functionalArgs, {moduleExamRuntime: async () => seats});
        const runPublicCli = () => promisify(execFile)(process.execPath, ['scripts/personal-qa.mjs', ...functionalArgs], {
          env: {PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8'}, timeout: 20_000,
        });
        const originalReport = await readModuleReport(dataDirectory, project, originRun, 'qa');
        const originDirectory = join(dataDirectory, 'verificacoes', project, originalReport.summary.directoryName);
        const originFile = join(originDirectory, 'bruto', 'achados-brutos.json');
        const rawOrigin = await readFile(originFile, 'utf8');
        const unlaunched = docker.logs.length;
        const expectPending = async (reason: string) => {
          assert.match((await functionalRecheck())[0]!, new RegExp(`^ACH-001 pendente ${reason} \\(`));
          assert.equal((await readModuleReport(dataDirectory, project, originRun, 'qa')).achados[0]?.status, 'provavel');
        };
        await expectPending('MODULE_RECHECK_SAME_COMMIT');
        await commitSource('synthetic equivalent implementation', source('6 * 7'), testBody(42));
        await recordCoverage();
        const bothGreen = await runPublicCli();
        assert.equal(bothGreen.stderr, '');
        assert.match(bothGreen.stdout, /^ACH-001 pendente MODULE_RECHECK_ORIGINAL_TEST_PASSED \(/);
        await expectPending('MODULE_RECHECK_ORIGINAL_TEST_PASSED');

        await commitSource('synthetic function replaced at old line', 'export function other() { return 43; }\n', testBody(43, 'other'));
        await recordCoverage();
        await expectPending('MODULE_RECHECK_FUNCTION_IDENTITY_UNPROVEN');
        await commitSource('synthetic wrong regression test', moved, testBody(5, 'other'));
        await recordCoverage();
        await expectPending('MODULE_RECHECK_FUNCTIONAL_TEST_UNAVAILABLE');
        await commitSource('synthetic ambiguous function', moved + 'export function total() { return 43; }\n', testBody(43));
        await recordCoverage();
        await expectPending('MODULE_RECHECK_FUNCTION_IDENTITY_UNPROVEN');
        await commitSource('synthetic Node preparation failure', moved + 'export function default() { return 5; }\n');
        await recordCoverage();
        await expectPending('MODULE_RECHECK_FUNCTIONAL_EXECUTION_UNAVAILABLE');
        await commitSource('synthetic assertion still failing', source('41'));
        await recordCoverage();
        await expectPending('MODULE_RECHECK_CORRECTED_TEST_FAILED');

        const correctedHead = await commitSource('synthetic correction with moved target', moved);
        await recordCoverage([], v8Coverage.version, `sha256:${'c'.repeat(64)}`);
        await expectPending('MODULE_RECHECK_MODULE_PROOF_MISSING');
        await recordCoverage([], v8Coverage.version, image, true);
        await expectPending('MODULE_RECHECK_MODULE_PROOF_MISSING');
        await recordCoverage([], 'other-version');
        await expectPending('MODULE_RECHECK_MODULE_PROOF_MISSING');
        await recordCoverage([{...uncovered, line: 3}]);
        await expectPending('MODULE_RECHECK_MODULE_PROOF_MISSING');
        const proofRun = await recordCoverage([{...uncovered, line: 1, message: "Função exportada 'other' sem execução medida pelo V8"}]);
        await ledger.pool.query('UPDATE ac_verify_runs SET collector_image=NULL WHERE id=$1', [originRun]);
        await expectPending('MODULE_RECHECK_MODULE_PROOF_MISSING');
        await ledger.pool.query('UPDATE ac_verify_runs SET collector_image=$2 WHERE id=$1', [originRun, image]);
        assert.equal(docker.logs.length, unlaunched);

        type FunctionalTask = {
          binding: string; code: string; rule: string; regressionAssertion: string;
          regressionProof: {observations: {original: {actual: string}; corrected: {actual: string}}};
        };
        const refute = (request: ReviewTaskFixture, changes: {rule?: string; binding?: string; reason?: string; actual?: string; omitCorrection?: boolean} = {}) => {
          const task = request as unknown as FunctionalTask;
          const {original, corrected} = task.regressionProof.observations;
          const reason = `A regra \`${task.rule}\` aponta a função sem execução. \`${task.regressionAssertion}\` chama a mesma função diretamente: obteve \`${original.actual}\` na primeira revisão e passou com o valor esperado \`${corrected.actual}\` na segunda.`;
          return JSON.stringify({kind: 'confirmacao', status: 'descartado', binding: changes.binding ?? task.binding,
            proof: task.code, reason: changes.reason ?? reason, ...(changes.omitCorrection ? {} : {correction: {
              rule: changes.rule ?? task.rule, assertion: task.regressionAssertion,
              criterion: 'direct-call-meets-expected-value', original: {...original, actual: changes.actual ?? original.actual}, corrected,
            }})});
        };
        recheckAnswer = task => refute(task, {omitCorrection: true,
          reason: 'O retorno anterior `42` passou a `43`. Veja `tests/qa/ach-001.test.ts`.'});
        await expectPending('MODULE_RECHECK_CORRECTION_UNEXPLAINED');
        recheckAnswer = task => refute(task, {rule: 'OUTRA-REGRA'});
        await expectPending('MODULE_RECHECK_CORRECTION_UNEXPLAINED');
        recheckAnswer = task => refute(task, {actual: '41'});
        await expectPending('MODULE_RECHECK_CORRECTION_UNEXPLAINED');
        recheckAnswer = task => refute(task, {binding: '0'.repeat(64)});
        assert.deepEqual(await functionalRecheck(), ['ACH-001 pendente MODULE_RECHECK_PROOF_UNAVAILABLE']);

        const findingsDir = join(originDirectory, 'achados');
        const savedFindings = join(originDirectory, 'achados-sinteticos');
        recheckAnswer = task => {
          renameSync(findingsDir, savedFindings);
          return refute(task);
        };
        const pendingPublication = await functionalRecheck();
        assert.equal(pendingPublication[0], 'ACH-001 fechado');
        assert.match(pendingPublication[1]!, /VERIFY_RECHECK_PUBLICATION_PENDING/);
        assert.equal((await ledger.pool.query('SELECT status FROM ac_verify_findings WHERE run_id=$1', [originRun])).rows[0].status, 'fechado');
        assert.equal(JSON.parse(await readFile(join(originDirectory, 'achados.json'), 'utf8')).achados[0].status, 'provavel');
        assert.deepEqual(await functionalRecheck([]), pendingPublication);
        renameSync(savedFindings, findingsDir);
        assert.deepEqual(await functionalRecheck([]), ['ACH-001 fechado']);
        const publishedCli = await runPublicCli();
        assert.equal(publishedCli.stderr, '');
        assert.equal(publishedCli.stdout.trim(), 'ACH-001 fechado');
        assert.equal((await readModuleReport(dataDirectory, project, originRun, 'qa')).achados[0]?.status, 'fechado');
        assert.equal(await readFile(originFile, 'utf8'), rawOrigin);

        const {rows: [closed]} = await ledger.pool.query(`SELECT detail FROM ac_audit
          WHERE kind='module.finding_rechecked' AND detail->>'status'='fechado' AND detail->>'runId'=$1`, [originRun]);
        const {receiptDigest, ...receipt} = closed.detail.regressionProof;
        assert.equal(closed.detail.source.commit, originalHead);
        assert.equal(closed.detail.source.evidenceDigest, digest(uncovered.evidence));
        assert.equal(closed.detail.moduleProof.runId, proofRun);
        assert.equal(closed.detail.reviewer.provider, 'codex');
        assert.match(closed.detail.reviewerBinding, /^[a-f0-9]{64}$/);
        assert.equal(receipt.scope.runId, originRun);
        assert.equal(receipt.scope.rule, FUNCTION_COVERAGE_RULE);
        assert.deepEqual(receipt.function, {name: 'total', signature: '()'});
        assert.deepEqual(receipt.observations, {
          original: {commit: originalHead, status: 'assertion-failed', actual: '42', expected: '43'},
          corrected: {commit: correctedHead, status: 'passed', actual: '43', expected: '43'},
        });
        assert.equal(receipt.original.blob, git('rev-parse', `${originalHead}:${sourceFile}`).toString().trim());
        assert.equal(receipt.corrected.blob, git('rev-parse', `${correctedHead}:${sourceFile}`).toString().trim());
        assert.equal(receipt.testBlob, git('rev-parse', `${correctedHead}:${testFile}`).toString().trim());
        assert.equal(receipt.original.line, 1);
        assert.equal(receipt.corrected.line, 3);
        assert.equal(receipt.testTitle, title);
        assert.equal(receipt.testLine, 4);
        assert.equal(receipt.testColumn, 1);
        assert.equal(receipt.assertionDigest, digest('assert.equal(total(), 43)'));
        assert.equal(receiptDigest, digest(receipt));
        const publication = await ledger.pool.query(`SELECT kind, count(*)::int AS count FROM ac_audit
          WHERE detail->>'intentId'=$1 AND (kind='module.finding_rechecked' OR kind LIKE 'module.recheck_report_%')
          GROUP BY kind ORDER BY kind`, [closed.detail.intentId]);
        assert.deepEqual(publication.rows, [
          {kind: 'module.finding_rechecked', count: 1}, {kind: 'module.recheck_report_pending', count: 1},
          {kind: 'module.recheck_report_published', count: 1},
        ]);
      });
      docker.check();
    } finally {
      await fixture?.docker.close();
      await ledger.close();
      await database.close();
      await rm(root, {recursive: true, force: true});
    }
  });
