import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync, randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer, type IncomingMessage} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {AccountHomes} from '../src/account-homes.ts';
import {Capacity} from '../src/capacity.ts';
import {digest, Refusal} from '../src/contracts.ts';
import {prepareClaudeExamAccessToken} from '../src/exam-login.ts';
import {Ledger} from '../src/ledger.ts';
import {moduleExamConnectHost, moduleExamSocket, monitorModuleExamEgress, startModuleExamEgress, type ModuleExamProvider} from '../src/module-exam-egress.ts';
import {moduleExamCodexBody, readModuleExamCodexOutput} from '../src/module-exam-codex.ts';
import type {ModuleExamRuntime} from '../src/module-exam-native.ts';
import {moduleExamClaudeArgs, readModuleExamClaudeOutput} from '../src/module-exam-worker.ts';
import {NativeExecutionSupervisor} from '../src/native-execution-supervisor.ts';
import {runPersonalModuleCli, type PersonalModuleCliDeps} from '../src/personal-module-cli.ts';
import type {VerificationModuleRunResult} from '../src/verification-modules.ts';
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

type Mount = {Type: 'bind'; Source: string; Destination: string; RW: boolean};
type Config = {Image: string; Labels: Record<string, string>; Cmd: string[]; Env: string[]; Entrypoint: string[];
  User: string; WorkingDir: string; HostConfig: {NetworkMode: string; Binds: string[]}};
type Container = {Id: string; Image: string; Config: Config; HostConfig: Config['HostConfig'] & {PidMode: string; IpcMode: string; CapAdd: string[]; Devices: unknown[]; PortBindings: null}; Mounts: Mount[];
  NetworkSettings: {Networks: Record<string, {NetworkID: string; IPAddress: string}>};
  State: {Status: string; Running: boolean; FinishedAt: string; ExitCode: number}};
type Launch = {jobId: string; provider: ModuleExamProvider; task: string; moduleExam: boolean; role: string; writePaths: string[]};

async function fakeDocker(socket: string, answer: (launch: Launch) => {output: string; failureCode: string | null}) {
  const containers = new Map<string, Container>();
  const networks = new Map<string, {Name: string; Labels: Record<string, string>}>();
  const id = () => digest(randomUUID());
  const logs: Launch[] = [];
  const observations: Container[] = [];
  let releaseFailure: unknown;
  const end = (container: Container, exitCode: number) => {
    container.State = {Status: 'exited', Running: false, FinishedAt: new Date().toISOString(), ExitCode: exitCode};
  };
  async function body(req: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const server = createServer((request, response) => {
    const send = (status: number, data?: object) => {
      response.writeHead(status);
      response.end(data ? JSON.stringify(data) : '');
    };
    void (async () => {
      const url = new URL(request.url!, 'http://docker.invalid');
      const [kind, key, action] = url.pathname.split('/').slice(2);
      const method = request.method;
      if (kind === 'images') { send(200); return; }
      if (kind === 'networks') {
        if (key === 'create') {
          const value = await body(request), net = id();
          networks.set(net, {Name: value.Name, Labels: value.Labels});
          send(201, {Id: net}); return;
        }
        if (method === 'DELETE') { networks.delete(key!); send(204); return; }
        const network = networks.get(key!);
        if (!network) { send(404); return; }
        const peers = [...containers.values()].filter(c => c.HostConfig.NetworkMode === key);
        send(200, {...network, Id: key, Internal: true, Containers: Object.fromEntries(peers.map(c =>
          [c.Id, {IPv4Address: '172.20.0.3/16'}]))}); return;
      }
      if (kind !== 'containers') throw Error('unexpected fixture route');
      if (key === 'create') {
        const name = url.searchParams.get('name')!, config: Config = await body(request);
        const cid = id(), host = config.HostConfig;
        const mounts = host.Binds.map((bind): Mount => {
          const [Source, Destination, mode] = bind.split(':');
          return {Type: 'bind', Source: Source!, Destination: Destination!, RW: mode === 'rw'};
        });
        const attached: Container['NetworkSettings']['Networks'] = host.NetworkMode === 'none' ? {none: {NetworkID: '', IPAddress: ''}} : {job: {NetworkID: host.NetworkMode, IPAddress: '172.20.0.3'}};
        const container: Container = {Id: cid, Image: config.Image, Config: config,
          HostConfig: {...host, PidMode: '', IpcMode: 'private', CapAdd: [], Devices: [], PortBindings: null},
          Mounts: mounts, NetworkSettings: {Networks: attached},
          State: {Status: 'created', Running: false, FinishedAt: '0001-01-01T00:00:00Z', ExitCode: 0}};
        containers.set(name, container);
        observations.push(container);
        send(201, {Id: cid}); return;
      }
      const entry = [...containers.entries()].find(([name, c]) => name === key || c.Id === key);
      if (!entry) { send(404); return; }
      const [name, c] = entry;
      if (method === 'DELETE') { containers.delete(name); send(204); return; }
      if (action === 'start') { c.State = {...c.State, Status: 'running', Running: true}; send(204); return; }
      if (action === 'stop') { if (c.State.Running) end(c, 137); send(204); return; }
      if (action === 'logs') { send(200); return; }
      if (action !== 'json') throw Error('unexpected container operation');
      const input = c.Mounts.find(m => m.Destination === '/input')?.Source;
      const output = c.Mounts.find(m => m.Destination === '/output')?.Source;
      if (input && output && c.State.Running && name === key && existsSync(join(input, 'launch.json'))) {
        const launch: Launch = JSON.parse(await readFile(join(input, 'launch.json'), 'utf8')).payload;
        const result = answer(launch);
        logs.push(launch);
        const exitCode = result.failureCode ? 1 : 0;
        await writeFile(join(output, 'execution-result.json'), JSON.stringify({schemaVersion: 1, jobId: launch.jobId,
          ...result, normalizedTokensUsed: null, usageWindows: null, nativeSessionId: null, exitCode}), {mode: 0o600});
        end(c, exitCode);
      }
      send(200, c);
    })().catch(error => { releaseFailure = error; send(500); });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  return {logs, observations, containers, networks, check() { assert.equal(releaseFailure, undefined); },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))};
}

const base = process.env.AC_TEST_DATABASE_URL;
test('CLI pessoal usa reservas e recibos do supervisor e preserva pendências na cota e na indisponibilidade',
  {skip: !base}, async () => {
    const database = await isolatedDatabase(base!, 'moduleexam');
    const ledger = new Ledger(database.url);
    const root = await mkdtemp(join(tmpdir(), 'ac-module-native-test-'));
    const socket = join(root, 'docker.sock');
    let exhaust = false;
    const docker = await fakeDocker(socket, launch => {
      const task = JSON.parse(launch.task);
      if (launch.provider === 'claude') return {failureCode: null,
        output: JSON.stringify({kind: 'exame', filesRead: [task.file], checklist: ['qa'], findings: []})};
      if (exhaust) return {output: 'diagnóstico privado descartado', failureCode: 'PROVIDER_USAGE_LIMIT'};
      return {failureCode: null, output: JSON.stringify({kind: 'confirmacao', status: 'confirmado',
        proof: 'return 42;', reason: 'Linha observada.'})};
    });
    try {
      await ledger.migrate();
      const dataDirectory = join(root, 'data'), repo = join(root, 'repo'), hostRoot = join(root, 'spool'), accountRoot = join(root, 'accounts');
      for (const path of [dataDirectory, repo, hostRoot, accountRoot]) await mkdir(path, {mode: 0o700});
      const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', repo, ...args], {stdio: 'pipe'});
      await writeFile(join(repo, 'index.ts'), 'return 42;\nconst password = "SEGREDO_SINTETICO_OMITIDO";\n');
      await writeFile(join(repo, 'other.ts'), 'return 7;\n');
      await writeFile(join(repo, '.env'), 'CONTEUDO_SINTETICO_PROTEGIDO\n');
      git('init'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'synthetic');

      const project = randomUUID(), owner = 'module-exam-owner';
      await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Fixture']);
      await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, owner]);
      await ledger.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)', [project, repo]);
      await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1)', [owner]);
      await ledger.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
      const context = await ledger.createContext(owner, project, randomUUID());
      const capacity = new Capacity(ledger);
      await capacity.configure(owner, {programmingLimit: 2, evaluationLimit: 2});
      const image = 'sha256:' + 'd'.repeat(64);
      const signingKeyPem = generateKeyPairSync('ed25519').privateKey.export({format: 'pem', type: 'pkcs8'}).toString();
      const runtime: ModuleExamRuntime[number][] = [];
      const profiles = [];
      for (const provider of ['claude', 'codex'] as const) {
        const accountId = randomUUID(), profileId = randomUUID(), model = provider + '-module-fixture';
        const subject = 'account-synthetic-module-' + provider;
        const subjectDigest = digest({provider, subject});
        await capacity.registerModel(owner, {provider, model, efforts: ['medium'], roles: ['specialist'], source: 'synthetic://module-exam'});
        await capacity.addAccount(owner, project, {id: accountId, provider, label: provider, resourceIdentity: provider + ':' + subjectDigest,
          mode: 'subscription_cli', eligibility: 'documented_supported', eligibilitySource: 'synthetic://module-exam', maxConcurrent: 2});
        await capacity.addProfile(owner, project, {id: profileId, accountId, model, role: 'specialist', effort: 'medium'});
        await capacity.observeQuota(owner, accountId, {status: 'available', ttlSeconds: 3600, source: 'synthetic://module-exam'});

        await new AccountHomes(ledger, accountRoot, [repo]).initialize(owner, project, accountId);
        const account = join(accountRoot, accountId);
        if (provider === 'claude') {
          await writeFile(join(account, '.credentials.json'), JSON.stringify({claudeAiOauth: {
            accessToken: 'synthetic-claude-access-only-fixture', refreshToken: 'synthetic-claude-refresh-only-fixture',
            expiresAt: Date.now() + 3600_000}}), {mode: 0o600});
        } else {
          await mkdir(join(account, '.codex'), {mode: 0o700});
          await writeFile(join(account, '.codex', 'auth.json'), JSON.stringify({auth_mode: 'chatgpt',
            tokens: {account_id: subject, access_token: 'synthetic-codex-access-only-fixture', refresh_token: 'synthetic-codex-refresh-only-fixture'}}), {mode: 0o600});
        }
        runtime.push({provider, accountIds: new Set([accountId]), supervisor: new NativeExecutionSupervisor(ledger, {
          id: 'fixture-' + provider, provider, workerImage: image, toolsImage: image, hostRoot, accountRoot,
          protectedRepositories: [repo], signingKeyPem, providerNetworkId: 'e'.repeat(64), socketPath: socket,
          accountSubjects: [{accountId, subjectDigest}], workerEnv: [], toolsEnv: [],
        })});
        profiles.push(profileId);
      }
      const revision = await capacity.publish(owner, project, 0, {schemaVersion: 1, maxProgrammersPerContext: 1,
        maxEvaluatorsPerContext: 1, roles: {specialist: {regular: profiles, emergency: []}}});
      await capacity.assignPolicy(owner, context, revision);
      const installation = join(dataDirectory, 'installation.json');
      await writeFile(installation, JSON.stringify({schemaVersion: 1, mode: 'administration-only', activation: 'personal',
        databaseUrl: database.url, dataDirectory, project: {id: project, label: 'Fixture', repo, owner}, projects: [],
        http: {listen: '127.0.0.1', port: 8765, publicOrigin: 'http://127.0.0.1:8765'},
        happier: {upstreamOrigin: 'http://127.0.0.1:8766', webOrigin: 'http://127.0.0.1:8766', publicServerOrigin: 'http://127.0.0.1:8765'}}), {mode: 0o600});
      const collectorOutput = {coverage: [{tool: 'fixture', version: '1', status: 'ok', detail: 'leitura local'}],
        findings: ['index.ts', 'other.ts'].map(file => ({tool: 'fixture', rule: 'FIXTURE-01', file, line: 1,
          severity: 'baixa', message: 'Conclusão sintética do autor', evidence: file === 'index.ts' ? 'return 42;' : 'return 7;'}))};
      let result: VerificationModuleRunResult | undefined;
      const run = (moduleExamRuntime: NonNullable<PersonalModuleCliDeps['moduleExamRuntime']>) =>
        runPersonalModuleCli('qa', [installation, project], {collectorOutput, moduleExamRuntime,
          onResult(value) { result = value; }});
      await runPersonalModuleCli('qa', [installation, project], {collectorOutput, onResult(value) { result = value; }});
      assert.ok(result?.achados.every(f => f.status === 'confirmado' && f.verifier?.model === 'medição determinística'));
      assert.match(await readFile(join(result!.directory, 'cobertura.md'), 'utf8'), /medições do coletor isolado/);

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

      await run(async () => runtime);
      assert.equal(docker.logs.length, 6);
      assert.deepEqual(result?.achados.map(f => [f.status, f.verifier?.provider]), [['confirmado', 'codex'], ['confirmado', 'codex']]);
      assert.deepEqual((await ledger.pool.query('SELECT DISTINCT provenance FROM ac_verify_coverage WHERE run_id=$1', [result!.runId])).rows,
        [{provenance: 'examiner'}]);
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
    } finally {
      await docker.close();
      await ledger.close();
      await database.close();
      await rm(root, {recursive: true, force: true});
    }
  });
