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
import {RECHECK_PROOF_VERSION} from '../src/module-recheck-measurement.ts';
import {FUNCTION_COVERAGE_RULE} from '../src/module-recheck-regression.ts';
import type {ModuleExamRuntime} from '../src/module-exam-native.ts';
import {moduleExamClaudeArgs, parseModuleExamJsonObject, readModuleExamClaudeOutput, resolveModuleExamClaudeResult} from '../src/module-exam-worker.ts';
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

test('extrator de JSON do worker aceita objeto puro ou cerca Markdown em linhas próprias e rejeita chaves duplicadas ou lixo', () => {
  assert.deepEqual(parseModuleExamJsonObject('\uFEFF {"kind":"exame"} '), {text: '{"kind":"exame"}', value: {kind: 'exame'}});
  assert.deepEqual(parseModuleExamJsonObject('```json\n{"kind":"exame","note":"```"}\n```'), {
    text: '{"kind":"exame","note":"```"}', value: {kind: 'exame', note: '```'},
  });
  assert.deepEqual(parseModuleExamJsonObject('```json  \t\r\n{"kind":"exame"}\r\n  ```'), {
    text: '{"kind":"exame"}', value: {kind: 'exame'},
  });
  assert.deepEqual(parseModuleExamJsonObject('```\n{"kind":"exame"}\n```'), {
    text: '{"kind":"exame"}', value: {kind: 'exame'},
  });
  const nestedValid = '{"kind":"exame","note":"{\\"a\\":1,\\"a\\":2}","items":[{"a":1},{"a":2}],"nested":{"kind":"interno"}}';
  assert.deepEqual(parseModuleExamJsonObject(nestedValid), {
    text: nestedValid,
    value: {kind: 'exame', note: '{"a":1,"a":2}', items: [{a: 1}, {a: 2}], nested: {kind: 'interno'}},
  });
  for (const invalid of [
    'texto antes {"kind":"exame"}',
    '{"kind":"exame"} texto depois',
    'texto antes\n```json\n{"kind":"exame"}\n```',
    '```json\n{"kind":"exame"}\n```\ntexto depois',
    '```json{"kind":"exame"}\n```',
    '```{"kind":"exame"}\n```',
    '```json {"kind":"exame"}\n```',
    '```json\n{"kind":"exame"}```',
    '```\n{"kind":"exame"} ```',
    '```json{"kind":"exame"}```',
    '```json extra\n{"kind":"exame"}\n```',
    '```json\n{"kind":"exame"}\n``` extra',
    '```json\n{"kind":"exame"}\n```\n```json\n{"other":1}\n```',
    '{"kind":"exame"}{"other":1}',
    '```ts\n{"kind":"exame"}\n```',
    '```json\n[1,2,3]\n```',
    '```json\n{"kind":"exame"}',
    '```json\n```',
    '{"binding":"a","binding":"b"}',
    '{"binding":"a","\\u0062inding":"b"}',
    '{"filesRead":["a.ts"],"\\u0066ilesRead":["b.ts"]}',
    '{"checklist":["qa"],"\\u0063hecklist":["arquitetura"]}',
    '{"a\\/b":1,"a/b":2}',
    '{"\\uD83D\\uDE00":1,"😀":2}',
    '{"":1,"":2}',
    '{"findings":[{"line":1,"line":2}]}',
    '{"findings":[{"line":1,"\\u006cine":2}]}',
    '{"nested":{"deep":[{"k":1,"\\u006b":2}]}}',
    '```json\n{"binding":"a","\\u0062inding":"b"}\n```',
  ]) {
    assert.equal(parseModuleExamJsonObject(invalid), null, invalid);
  }
  assert.deepEqual(
    resolveModuleExamClaudeResult({succeeded: true, output: ' {"kind":"exame"} ', diagnostics: []}, ['segredo-sintetico']),
    {output: '{"kind":"exame"}', failureCode: null, usageWindows: null},
  );
  assert.deepEqual(
    resolveModuleExamClaudeResult({succeeded: true, output: '```json\n{"kind":"exame"}\n```', diagnostics: []}, ['segredo-sintetico']),
    {output: '{"kind":"exame"}', failureCode: null, usageWindows: null},
  );
  const externalText = 'texto antes\n```json\n{"kind":"exame"}\n```';
  assert.deepEqual(
    resolveModuleExamClaudeResult({succeeded: true, output: externalText, diagnostics: []}, ['segredo-sintetico']),
    {output: externalText, failureCode: null, usageWindows: null},
  );
  for (const [output, expected] of [
    ['Failed to authenticate: token expired', 'PROVIDER_AUTH_FAILED'],
    ['You’ve hit your usage limit. Try again at 14:30 UTC.', 'PROVIDER_USAGE_LIMIT'],
  ]) {
    assert.equal(resolveModuleExamClaudeResult({succeeded: true, output: output!, diagnostics: []}, []).failureCode, expected);
  }
  const invalidNotice = '{"binding":"You hit your usage limit","binding":"outro"}';
  assert.equal(resolveModuleExamClaudeResult({succeeded: true, output: invalidNotice, diagnostics: []}, []).failureCode, null);
  const duplicateText = '{"binding":"a","\\u0062inding":"b"}';
  assert.deepEqual(
    resolveModuleExamClaudeResult({succeeded: true, output: duplicateText, diagnostics: []}, ['segredo-sintetico']),
    {output: duplicateText, failureCode: null, usageWindows: null},
  );
  assert.equal(
    resolveModuleExamClaudeResult({succeeded: true, output: 'You hit your usage limit', diagnostics: []}, ['segredo-sintetico']).failureCode,
    'PROVIDER_USAGE_LIMIT',
  );
  assert.equal(
    resolveModuleExamClaudeResult({succeeded: false, output: '', diagnostics: ['usage limit reached']}, ['segredo-sintetico']).failureCode,
    'PROVIDER_USAGE_LIMIT',
  );
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
          return {failureCode: null, output: JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file],
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

      await t.test('CLI decide pelo V8 no mesmo alvo, recupera publicação e reabre com prova nova', async () => {
        const sourceFile = 'totals.ts';
        const testFile = 'tests/qa/ach-001.test.ts';
        const baseTest = 'tests/qa/base.test.ts';
        await mkdir(join(repo, 'tests', 'qa'), {recursive: true});
        const source = (value: string) => `export function total() { return ${value}; }\nexport function other() { return 5; }\n`;
        const usualSource = source('42');
        const moved = 'export function other() { return 5; }\n\nexport function total() {\n  return 42;\n}\n';
        const title = 'Total… pedido (R$ 42) — certo?';
        const testBody = (expected: number, name = 'total') => "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
          + `import {${name}} from '../../totals.ts';\ntest('${title}', () => assert.equal(${name}(), ${expected}));\n`;
        const commitSource = async (label: string, code: string, probe?: string) => {
          await writeFile(join(repo, sourceFile), code);
          if (probe !== undefined) await writeFile(join(repo, testFile), probe);
          git('add', '.');
          commitChanges(label);
          return git('rev-parse', 'HEAD').toString().trim();
        };
        await writeFile(join(repo, baseTest), testBody(5, 'other'));
        const originalHead = await commitSource('synthetic untested total', usualSource);
        const uncovered = {...opaqueFinding, file: sourceFile, rule: FUNCTION_COVERAGE_RULE, severity: 'alta' as const,
          message: "Função exportada 'total' sem execução medida pelo V8"};
        const image = `sha256:${'b'.repeat(64)}`;
        const recordCoverage = async (findings: ModuleCollectorOutput['findings'] = [], version = v8Coverage.version,
          pin = image, passDetails?: string[]) => {
          const pass = findings.length ? 'ramos 0/0, funções 1/2' : 'ramos 0/0, funções 2/2';
          const [id] = await runPersonalQaCli([installation, project], {image: pin, collectorOutput: {
            coverage: [{...v8Coverage, version, detail: 'Medição sintética da ferramenta'},
              {tool: `qa-arquivo:${sourceFile}`, status: 'ok', version,
                detail: 'V8 em três passadas: ' + (passDetails ?? [pass, pass, pass]).join('; ')}],
            findings,
          }});
          assert.ok(id);
          return id;
        };
        const recordMeasuredCoverage = async (...testFiles: string[]) => {
          type V8File = {path: string; coveredBranchCount: number; totalBranchCount: number;
            coveredFunctionCount: number; totalFunctionCount: number; functions: {name: string; line: number; count: number}[]};
          const staged = await mkdtemp(join(root, 'synthetic-v8-'));
          const driver = join(staged, 'driver.cjs');
          try {
            await mkdir(join(staged, 'tests', 'qa'), {recursive: true});
            await writeFile(join(staged, 'package.json'), '{"type":"module"}');
            for (const file of [sourceFile, ...testFiles]) {
              await writeFile(join(staged, file), git('show', `HEAD:${file}`));
            }
            await writeFile(driver, `
              const {run} = require('node:test');
              (async () => {
                for await (const {type, data} of run({files: process.argv.slice(2), coverage: true, execArgv: []})) {
                  if (type === 'test:fail') process.exitCode = 1;
                  if (type === 'test:coverage' && data.nesting === 0) console.log(JSON.stringify(data.summary.files));
                }
              })();`);
            const passes: V8File[] = [];
            for (let i = 0; i < 3; i++) {
              const {stdout} = await promisify(execFile)(process.execPath, [driver, ...testFiles.map(file => join(staged, file))],
                {cwd: staged, env: {LANG: 'C.UTF-8'}, timeout: 5_000});
              const files = JSON.parse(stdout) as V8File[];
              const measured = files.find(row => row.path === join(staged, sourceFile));
              assert.ok(measured);
              passes.push(measured);
            }
            const findings = passes[0]!.functions.flatMap(fn => passes.every(pass =>
              pass.functions.some(hit => hit.name === fn.name && hit.line === fn.line && hit.count === 0))
              ? [{...uncovered, line: fn.line, message: `Função exportada '${fn.name}' sem execução medida pelo V8`}] : []);
            return await recordCoverage(findings, v8Coverage.version, image, passes.map(row =>
              `ramos ${row.coveredBranchCount}/${row.totalBranchCount}, funções ${row.coveredFunctionCount}/${row.totalFunctionCount}`));
          } finally {
            await rm(staged, {recursive: true, force: true});
          }
        };
        const originRun = await recordMeasuredCoverage(baseTest);
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
        const expectPending = async (reason: string, status = 'provavel', seats = runtime.slice(1)) => {
          assert.match((await functionalRecheck(seats))[0]!, new RegExp(`^ACH-001 pendente ${reason}(?: \\(.*\\))?$`));
          assert.equal((await readModuleReport(dataDirectory, project, originRun, 'qa')).achados[0]?.status, status);
        };
        await expectPending('MODULE_RECHECK_SAME_COMMIT');
        await commitSource('synthetic function replaced at old line', 'export function other() { return 43; }\n', testBody(43, 'other'));
        await recordCoverage();
        await expectPending('MODULE_RECHECK_FUNCTION_IDENTITY_UNPROVEN');
        await commitSource('synthetic wrong regression test', moved, testBody(5, 'other'));
        await recordCoverage();
        await expectPending('MODULE_RECHECK_FUNCTIONAL_TEST_UNAVAILABLE');
        await commitSource('synthetic ambiguous function', moved + 'export function total() { return 43; }\n', testBody(42));
        await recordCoverage();
        await expectPending('MODULE_RECHECK_FUNCTION_IDENTITY_UNPROVEN');
        await commitSource('synthetic Node preparation failure', moved + 'export function default() { return 5; }\n');
        await recordCoverage([], v8Coverage.version, image, Array(3).fill('ramos 0/0, funções 3/3'));
        await expectPending('MODULE_RECHECK_FUNCTIONAL_EXECUTION_UNAVAILABLE');
        await commitSource('synthetic assertion still failing', source('41'));
        await recordCoverage();
        await expectPending('MODULE_RECHECK_CORRECTED_TEST_FAILED');

        await commitSource('synthetic correction with moved target', moved);
        await recordCoverage([], v8Coverage.version, `sha256:${'c'.repeat(64)}`);
        await expectPending('MODULE_RECHECK_MODULE_PROOF_MISSING');
        await recordCoverage([], v8Coverage.version, image, ['ramos 0/0, funções 2/2', 'ramos 0/0, funções 2/2', 'arquivo sem medição']);
        await expectPending('MODULE_RECHECK_MODULE_PROOF_MISSING');
        await recordCoverage([], 'other-version');
        await expectPending('MODULE_RECHECK_MODULE_PROOF_MISSING');
        await recordCoverage([uncovered]); // Same function, stale location, another function on this line.
        await expectPending('MODULE_RECHECK_MODULE_PROOF_MISSING');
        await recordCoverage([], v8Coverage.version, image, Array(3).fill('ramos 0/0, funções 1/2'));
        await expectPending('MODULE_RECHECK_MODULE_PROOF_MISSING');
        await recordCoverage([uncovered], v8Coverage.version, image, Array(3).fill('ramos 0/0, funções 2/2'));
        await expectPending('MODULE_RECHECK_MODULE_PROOF_MISSING');
        await recordMeasuredCoverage(testFile); // Other, now on the old line, is the only uncovered function.
        await expectPending('MODULE_EXAM_REVIEWER_UNAVAILABLE', 'provavel', []);
        const correctedHead = await commitSource('synthetic coverage-only correction', usualSource, testBody(42));
        const proofRun = await recordMeasuredCoverage(baseTest, testFile);
        await ledger.pool.query('UPDATE ac_verify_runs SET collector_image=NULL WHERE id=$1', [originRun]);
        await expectPending('MODULE_RECHECK_MODULE_PROOF_MISSING');
        await ledger.pool.query('UPDATE ac_verify_runs SET collector_image=$2 WHERE id=$1', [originRun, image]);
        assert.equal(docker.logs.length, unlaunched);

        type FunctionalTask = {
          binding: string; code: string; rule: string; regressionAssertion: string;
          regressionProof: {criterion: string; function: {name: string};
            observations: {original: CoverageObservation; corrected: CoverageObservation}};
        };
        type CoverageObservation = {passes: {total: number; covered: number}[]; targetFinding: string | null};
        const decide = (request: ReviewTaskFixture, changes: {rule?: string; binding?: string; reason?: string;
          gaps?: number[]; omitCorrection?: boolean; status?: string} = {}) => {
          const task = request as unknown as FunctionalTask;
          const {criterion, function: fn, observations: {original, corrected}} = task.regressionProof;
          const closes = corrected.targetFinding === null;
          const gaps = (side: CoverageObservation) => side.passes.map(pass => pass.total - pass.covered);
          const relation = closes ? 'os outros achados explicam todas as lacunas, portanto a função foi executada nas três passadas.'
            : 'a mesma função voltou a registrar zero execuções nas três passadas.';
          const reason = `A função \`${fn.name}\` teve zero execuções nas três passadas da origem. Na medição atual, ${relation}`;
          return JSON.stringify({kind: 'confirmacao', status: changes.status ?? (closes ? 'descartado' : 'confirmado'),
            binding: changes.binding ?? task.binding,
            proof: task.code, reason: changes.reason ?? reason, ...(changes.omitCorrection ? {} : {correction: {
              rule: changes.rule ?? task.rule, criterion, function: fn.name, originalGaps: gaps(original),
              currentGaps: changes.gaps ?? gaps(corrected), conclusion: closes ? 'coverage-added' : 'coverage-regressed',
            }})});
        };
        recheckAnswer = task => decide(task, {omitCorrection: true,
          reason: 'O retorno anterior `42` passou a `43`. Veja `tests/qa/ach-001.test.ts`.'});
        await expectPending('MODULE_RECHECK_CORRECTION_UNEXPLAINED');
        recheckAnswer = task => decide(task, {reason: '`QA-COBERTURA-FUNCAO-SEM-TESTE`, `assert.equal(total(), 42)`, `0`, `42`.'});
        await expectPending('MODULE_RECHECK_CORRECTION_UNEXPLAINED');
        recheckAnswer = task => decide(task, {rule: 'OUTRA-REGRA'});
        await expectPending('MODULE_RECHECK_CORRECTION_UNEXPLAINED');
        recheckAnswer = task => decide(task, {gaps: [0, 1, 0]});
        await expectPending('MODULE_RECHECK_CORRECTION_UNEXPLAINED');
        recheckAnswer = task => decide(task, {binding: '0'.repeat(64)});
        assert.deepEqual(await functionalRecheck(), ['ACH-001 pendente MODULE_RECHECK_PROOF_UNAVAILABLE']);

        const findingsDir = join(originDirectory, 'achados');
        const savedFindings = join(originDirectory, 'achados-sinteticos');
        recheckAnswer = task => {
          renameSync(findingsDir, savedFindings);
          return decide(task);
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
        assert.equal(receipt.proofVersion, RECHECK_PROOF_VERSION);
        assert.deepEqual(receipt.function, {name: 'total', signature: '()'});
        assert.deepEqual(receipt.observations, {
          original: {commit: originalHead, passes: Array(3).fill({covered: 1, total: 2}),
            targetFinding: 'ACH-001', uncovered: [{id: 'ACH-001', name: 'total', line: 1}]},
          corrected: {commit: correctedHead, passes: Array(3).fill({covered: 2, total: 2}),
            targetFinding: null, uncovered: []},
        });
        assert.equal(receipt.original.blob, git('rev-parse', `${originalHead}:${sourceFile}`).toString().trim());
        assert.equal(receipt.corrected.blob, git('rev-parse', `${correctedHead}:${sourceFile}`).toString().trim());
        assert.equal(receipt.original.blob, receipt.corrected.blob);
        assert.equal(receipt.testBlob, git('rev-parse', `${correctedHead}:${testFile}`).toString().trim());
        assert.equal(receipt.original.line, 1);
        assert.equal(receipt.corrected.line, 1);
        assert.equal(receipt.testTitle, title);
        assert.equal(receipt.testLine, 4);
        assert.equal(receipt.testColumn, 1);
        assert.equal(receipt.assertionDigest, digest('assert.equal(total(), 42)'));
        assert.equal(receiptDigest, digest(receipt));
        const publication = await ledger.pool.query(`SELECT kind, count(*)::int AS count FROM ac_audit
          WHERE detail->>'intentId'=$1 AND (kind='module.finding_rechecked' OR kind LIKE 'module.recheck_report_%')
          GROUP BY kind ORDER BY kind`, [closed.detail.intentId]);
        assert.deepEqual(publication.rows, [
          {kind: 'module.finding_rechecked', count: 1}, {kind: 'module.recheck_report_pending', count: 1},
          {kind: 'module.recheck_report_published', count: 1},
        ]);

        const {rows: [journal]} = await ledger.pool.query(`SELECT id, detail FROM ac_audit
          WHERE kind='module.recheck_report_pending' AND detail->>'intentId'=$1`, [closed.detail.intentId]);
        const editJournal = (detail: unknown) => ledger.pool.query('UPDATE ac_audit SET detail=$2 WHERE id=$1', [journal.id, detail]);
        const {proofVersion, receiptDigests, proofRunId, ...legacy} = journal.detail;
        assert.equal(proofVersion, RECHECK_PROOF_VERSION);
        assert.deepEqual(receiptDigests, {'ACH-001': receiptDigest});
        assert.equal(proofRunId, proofRun);
        await editJournal(legacy);
        await expectPending('MODULE_EXAM_REVIEWER_UNAVAILABLE', 'fechado', []);
        await editJournal({...journal.detail, proofVersion: RECHECK_PROOF_VERSION - 1});
        await expectPending('MODULE_EXAM_REVIEWER_UNAVAILABLE', 'fechado', []);
        await editJournal({...journal.detail, receiptDigests: {'ACH-001': '0'.repeat(64)}});
        await expectPending('MODULE_EXAM_REVIEWER_UNAVAILABLE', 'fechado', []);
        await editJournal(journal.detail);

        await recordCoverage([{...uncovered, line: 3}]); // New contradictory record on the same commit.
        await expectPending('MODULE_RECHECK_MODULE_PROOF_MISSING', 'fechado', []);
        await ledger.pool.query(`DELETE FROM ac_audit WHERE kind='module.recheck_report_published' AND detail->>'intentId'=$1`,
          [closed.detail.intentId]);
        await expectPending('MODULE_RECHECK_MODULE_PROOF_MISSING', 'fechado', []);
        const recovered = await ledger.pool.query(`SELECT 1 FROM ac_audit
          WHERE kind='module.recheck_report_published' AND detail->>'intentId'=$1`, [closed.detail.intentId]);
        assert.equal(recovered.rowCount, 1);

        git('rm', testFile);
        const regressedHead = await commitSource('synthetic reoccurrence with moved target', moved);
        const regressedRun = await recordMeasuredCoverage(baseTest);
        const originVerifier = {provider: 'codex', model: 'fixture-original'};
        await ledger.pool.query("UPDATE ac_verify_findings SET payload=jsonb_set(payload, '{verifier}', $2::jsonb) WHERE run_id=$1",
          [originRun, originVerifier]);
        recheckAnswer = task => decide(task);
        await expectPending('MODULE_EXAM_REVIEWER_UNAVAILABLE', 'fechado');
        recheckAnswer = task => decide(task, {status: 'descartado'});
        assert.deepEqual(await functionalRecheck(runtime.slice(0, 1)), ['ACH-001 pendente MODULE_RECHECK_PROOF_UNAVAILABLE']);
        recheckAnswer = task => decide(task);
        assert.deepEqual(await functionalRecheck(runtime.slice(0, 1)), ['ACH-001 reaberto']);
        assert.deepEqual(await functionalRecheck([]), ['ACH-001 reaberto']);
        assert.equal((await readModuleReport(dataDirectory, project, originRun, 'qa')).achados[0]?.status, 'reaberto');
        const {rows: [reopened]} = await ledger.pool.query(`SELECT detail FROM ac_audit WHERE kind='module.finding_rechecked'
          AND detail->>'status'='reaberto' AND detail->>'runId'=$1`, [originRun]);
        assert.equal(reopened.detail.reviewer.provider, 'claude');
        assert.equal(reopened.detail.moduleProof.runId, regressedRun);
        assert.deepEqual(reopened.detail.regressionProof.observations.corrected, {
          commit: regressedHead, targetFinding: 'ACH-001', uncovered: [{id: 'ACH-001', name: 'total', line: 3}],
          passes: Array(3).fill({covered: 1, total: 2}),
        });
      });
      docker.check();
    } finally {
      await fixture?.docker.close();
      await ledger.close();
      await database.close();
      await rm(root, {recursive: true, force: true});
    }
  });
