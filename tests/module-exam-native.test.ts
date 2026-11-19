import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
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
import type {ModuleExamRuntime} from '../src/module-exam-native.ts';
import {moduleExamClaudeArgs, readModuleExamClaudeOutput} from '../src/module-exam-worker.ts';
import {moduleCliFailureText, parsePersonalModuleArgs, runPersonalModuleCli, type PersonalModuleCliDeps} from '../src/personal-module-cli.ts';
import {runPersonalQaCli} from '../src/personal-qa-cli.ts';
import {readModuleReport, type ModuleCollectorOutput, type VerificationModuleRunResult} from '../src/verification-modules.ts';
import {createModuleExamFixture, moduleExamFixtureAnswer} from './fixtures/module-exam-native.ts';
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
  {skip: !base}, async () => {
    const database = await isolatedDatabase(base!, 'moduleexam');
    const ledger = new Ledger(database.url);
    const root = await mkdtemp(join(tmpdir(), 'ac-module-native-test-'));
    let exhaust = false;
    let recheckAnswer: ((task: {code: string; binding: string}) => string) | undefined;
    let fixture: Awaited<ReturnType<typeof createModuleExamFixture>> | undefined;
    try {
      await ledger.migrate();
      const dataDirectory = join(root, 'data'), repo = join(root, 'repo');
      for (const path of [dataDirectory, repo]) await mkdir(path, {mode: 0o700});
      const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', repo, ...args], {stdio: 'pipe'});
      await writeFile(join(repo, 'index.ts'), 'return 42;\nconst password = "SEGREDO_SINTETICO_OMITIDO";\n');
      await writeFile(join(repo, 'other.ts'), 'return 7;\n');
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
      fixture = await createModuleExamFixture({root, repo, ledger, owner, project, answer(launch) {
        const task = JSON.parse(launch.task);
        if (task.commit && recheckAnswer) return {failureCode: null, output: recheckAnswer(task)};
        if (launch.provider === 'codex' && exhaust) return {output: 'diagnóstico privado descartado', failureCode: 'PROVIDER_USAGE_LIMIT'};
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
      const collectorOutput: ModuleCollectorOutput = {coverage: [{tool: 'fixture', version: '1', status: 'ok', detail: 'leitura local'}],
        findings: ['index.ts', 'other.ts'].map(file => ({tool: 'fixture', rule: 'FIXTURE-01', file, line: 1,
          severity: 'baixa', message: 'Conclusão sintética do autor', evidence: file === 'index.ts' ? 'return 42;' : 'return 7;'}))};
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
      assert.deepEqual((await ledger.pool.query('SELECT DISTINCT provenance FROM ac_verify_coverage WHERE run_id=$1', [result!.runId])).rows,
        [{provenance: 'examiner'}]);
      const reviewRunId = result!.runId;
      for (const launch of docker.logs) {
        assert.equal(launch.moduleExam, true);
        assert.equal(launch.role, 'specialist');
        assert.deepEqual(launch.writePaths, []);
        assert.doesNotMatch(launch.task, /SEGREDO_SINTETICO_OMITIDO|CONTEUDO_SINTETICO_PROTEGIDO|Conclusão sintética do autor|\/tmp\//);
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

      await writeFile(join(repo, 'index.ts'), 'return 43;\nconst password = "NOVA_CREDENCIAL_SINTETICA";\n');
      git('add', 'index.ts');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'synthetic correction');
      const verdict = ({code, binding}: {code: string; binding: string}) => JSON.stringify({kind: 'confirmacao', status: 'descartado',
        proof: code, binding, reason: 'O retorno apresenta `43` após a alteração.'});
      recheckAnswer = task => verdict({...task, code: 'prova sem vínculo com o trecho'});
      assert.deepEqual(await recheck(), ['ACH-001 pendente MODULE_RECHECK_PROOF_UNAVAILABLE']);
      assert.equal(await findingStatus(), 'confirmado');

      recheckAnswer = task => {
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'synthetic concurrent HEAD');
        return verdict(task);
      };
      await assert.rejects(recheck(), refuses('VERIFY_RUN_CONFLICT'));
      assert.equal(await findingStatus(), 'confirmado');
      const correctedHead = git('rev-parse', 'HEAD').toString().trim();

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
      assert.deepEqual(await recheck(), ['ACH-001 fechado']);
      assert.equal(await findingStatus(), 'fechado');
      const launch = docker.logs.at(-1)!;
      assert.equal(launch.provider, 'codex');
      assert.equal(launch.moduleExam, true);
      assert.deepEqual(launch.writePaths, []);
      assert.deepEqual(JSON.parse(launch.task).code, 'return 43;');
      assert.doesNotMatch(launch.task, /NOVA_CREDENCIAL_SINTETICA|Conclusão sintética do autor|\/tmp\//);
      const {rows: [closed]} = await ledger.pool.query(`SELECT detail FROM ac_audit
        WHERE kind='module.finding_rechecked' AND detail->>'status'='fechado' AND context_id=$1`, [contextId]);
      assert.equal(closed.detail.commit, correctedHead);
      assert.equal(closed.detail.proofDigest, digest('return 43;'));
      assert.deepEqual(closed.detail.examiner, {provider: 'claude', model: 'claude-module-fixture',
        accountId: [...runtime[0]!.accountIds][0], profileId: profiles[0]});
      assert.deepEqual(closed.detail.reviewer, {provider: 'codex', model: 'codex-module-fixture',
        accountId: reviewerAccount, profileId: profiles[1], grantId: closed.detail.reviewer.grantId});
      const {rows: [receipt]} = await ledger.pool.query('SELECT state, physical_receipt FROM ac_capacity_grants WHERE id=$1', [closed.detail.reviewer.grantId]);
      assert.equal(receipt.state, 'released');
      assert.ok(receipt.physical_receipt.containerId);

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
      assert.equal(await findingStatus(), 'fechado');
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
      docker.check();
    } finally {
      await fixture?.docker.close();
      await ledger.close();
      await database.close();
      await rm(root, {recursive: true, force: true});
    }
  });
