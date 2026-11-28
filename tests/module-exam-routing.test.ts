// The host disk is not what this file proves: a fixed reading keeps a server disk near 95% from refusing these flows.
import {useFixedDisk} from './fixtures/fixed-disk.ts';
useFixedDisk();
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
import {loadSpecialistExamPlan, moduleExaminerRequirement} from '../src/exam-provider.ts';
import {Ledger, VERIFICATION_MODULES, type VerificationModule} from '../src/ledger.ts';
import {mapModuleSnapshot} from '../src/module-exam-map.ts';
import {createPersonalModuleExam, createPersonalModuleRecheck, type ModuleExamRuntime} from '../src/module-exam-native.ts';
import {examineFunctionalModule, type ModuleExamSeat} from '../src/module-exam.ts';
import {examFindingIdentity} from '../src/module-exam-sessions.ts';
import {NativeExecutionSupervisor} from '../src/native-execution-supervisor.ts';
import {moduleCliFailureText, runPersonalModuleCli} from '../src/personal-module-cli.ts';
import {readModuleReport, recheckModuleFindings, runVerificationModule} from '../src/verification-modules.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {qaStaticFinding, qaStaticTool, reviewFixtureVerdict, skipQuestion} from './fixtures/module-exam-review.ts';

const base = process.env.AC_TEST_DATABASE_URL;

type RecordedLaunch = {
  jobId: string;
  provider: string;
  model: string;
  effort: string;
  accountId: string;
  profileId: string;
  sessionId: string;
  grantId: string;
  task: string;
  moduleExam: boolean;
  role: string;
  writePaths: string[];
  labels?: Record<string, string>;
};

async function startLaunchDocker(
  socket: string,
  answer: (launch: RecordedLaunch) => {output: string; failureCode: string | null},
): Promise<{launches: RecordedLaunch[]; createdNetworks: {Name: string; Labels: Record<string, string>}[]; close: () => Promise<void>}> {
  type ContainerState = {
    Id: string;
    Image: string;
    Config: {Image: string; Labels: Record<string, string>; Cmd: string[]; Env: string[]; Entrypoint: string[]; User: string; WorkingDir: string};
    HostConfig: {NetworkMode: string; Binds: string[]; PidMode: string; IpcMode: string; CapAdd: string[]; Devices: unknown[]; PortBindings: null};
    Mounts: {Type: 'bind'; Source: string; Destination: string; RW: boolean}[];
    NetworkSettings: {Networks: Record<string, {NetworkID: string; IPAddress: string}>};
    State: {Status: string; Running: boolean; FinishedAt: string; ExitCode: number};
  };
  const containers = new Map<string, ContainerState>();
  const networks = new Map<string, {Name: string; Labels: Record<string, string>}>();
  const launches: RecordedLaunch[] = [];
  const createdNetworks: {Name: string; Labels: Record<string, string>}[] = [];
  const id = () => digest(randomUUID());
  const readJson = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const server = createServer((req, res) => {
    const send = (status: number, data?: object) => {
      res.writeHead(status);
      res.end(data ? JSON.stringify(data) : '');
    };
    void (async () => {
      const url = new URL(req.url!, 'http://docker.invalid');
      const [kind, key, action] = url.pathname.split('/').slice(2);
      if (kind === 'images') { send(200); return; }
      if (kind === 'networks') {
        if (key === 'create') {
          const body = await readJson(req);
          const netId = id();
          networks.set(netId, {Name: body.Name, Labels: body.Labels});
          createdNetworks.push({Name: body.Name, Labels: body.Labels});
          send(201, {Id: netId});
          return;
        }
        if (req.method === 'DELETE') { networks.delete(key!); send(204); return; }
        const net = networks.get(key!);
        if (!net) { send(404); return; }
        const peers = [...containers.values()].filter(c => c.HostConfig.NetworkMode === key);
        send(200, {...net, Id: key, Internal: true, Containers: Object.fromEntries(peers.map(c => [c.Id, {IPv4Address: '172.20.0.3/16'}]))});
        return;
      }
      if (kind !== 'containers') { send(404); return; }
      if (key === 'create') {
        const name = url.searchParams.get('name')!;
        const config = await readJson(req);
        const cid = id();
        const mounts = (config.HostConfig.Binds as string[]).map(bind => {
          const [Source, Destination, mode] = bind.split(':');
          return {Type: 'bind' as const, Source: Source!, Destination: Destination!, RW: mode === 'rw'};
        });
        const attached: ContainerState['NetworkSettings']['Networks'] = config.HostConfig.NetworkMode === 'none'
          ? {none: {NetworkID: '', IPAddress: ''}}
          : {job: {NetworkID: String(config.HostConfig.NetworkMode), IPAddress: '172.20.0.3'}};
        containers.set(name, {
          Id: cid,
          Image: config.Image,
          Config: config,
          HostConfig: {...config.HostConfig, PidMode: '', IpcMode: 'private', CapAdd: [], Devices: [], PortBindings: null},
          Mounts: mounts,
          NetworkSettings: {Networks: attached},
          State: {Status: 'created', Running: false, FinishedAt: '0001-01-01T00:00:00Z', ExitCode: 0},
        });
        send(201, {Id: cid});
        return;
      }
      const entry = [...containers.entries()].find(([name, c]) => name === key || c.Id === key);
      if (!entry) { send(404); return; }
      const [name, c] = entry;
      if (req.method === 'DELETE') { containers.delete(name); send(204); return; }
      if (action === 'start') { c.State = {...c.State, Status: 'running', Running: true}; send(204); return; }
      if (action === 'stop') {
        if (c.State.Running) c.State = {Status: 'exited', Running: false, FinishedAt: new Date().toISOString(), ExitCode: 137};
        send(204);
        return;
      }
      if (action === 'logs') { send(200); return; }
      if (action !== 'json') { send(404); return; }
      const input = c.Mounts.find(m => m.Destination === '/input')?.Source;
      const output = c.Mounts.find(m => m.Destination === '/output')?.Source;
      if (input && output && c.State.Running && name === key && existsSync(join(input, 'launch.json'))) {
        const launch = JSON.parse(await readFile(join(input, 'launch.json'), 'utf8')).payload as RecordedLaunch;
        const result = answer(launch);
        launches.push({...launch, labels: c.Config.Labels});
        const exitCode = result.failureCode ? 1 : 0;
        await writeFile(join(output, 'execution-result.json'), JSON.stringify({
          schemaVersion: 1,
          jobId: launch.jobId,
          ...result,
          normalizedTokensUsed: null,
          usageWindows: null,
          nativeSessionId: null,
          exitCode,
        }), {mode: 0o600});
        c.State = {Status: 'exited', Running: false, FinishedAt: new Date().toISOString(), ExitCode: exitCode};
      }
      send(200, c);
    })().catch(() => send(500));
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  return {
    launches,
    createdNetworks,
    close: () => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())),
  };
}

test('mapeia modelo Sonnet 5.5 e esforço correto para cada módulo de 2 a 9', () => {
  const expected: Record<VerificationModule, 'medium' | 'high'> = {
    qa: 'medium',
    arquitetura: 'medium',
    dependencias: 'medium',
    prontidao: 'medium',
    desempenho: 'medium',
    documentacao: 'medium',
    banco: 'high',
    conformidade: 'high',
  };
  for (const mod of VERIFICATION_MODULES) {
    assert.deepEqual(moduleExaminerRequirement(mod), {
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      effort: expected[mod],
    });
  }
});

test('conta Claude prioritária segue a ordem bruta da política, aceita outro provedor antes e recusa entrada não resolvida', async () => {
  const ids = {codex: randomUUID(), maxOpus: randomUUID(), maxSonnet: randomUUID(), proSonnet: randomUUID(), unknown: randomUUID()};
  const accounts = {codex: randomUUID(), max: randomUUID(), pro: randomUUID()};
  const rows = [
    {id: ids.codex, model: 'gpt-6.2-sol', effort: 'medium', provider: 'codex', account_id: accounts.codex},
    {id: ids.maxOpus, model: 'claude-opus-5-5', effort: 'medium', provider: 'claude', account_id: accounts.max},
    {id: ids.maxSonnet, model: 'claude-sonnet-5-5', effort: 'medium', provider: 'claude', account_id: accounts.max},
    {id: ids.proSonnet, model: 'claude-sonnet-5-5', effort: 'medium', provider: 'claude', account_id: accounts.pro},
  ];
  const planFor = (regular: string[], emergency: string[] = []) => loadSpecialistExamPlan({
    async query(text: string, values?: unknown[]) {
      if (text.includes('ac_policy_revisions')) return {rows: [{snapshot: {roles: {specialist: {regular, emergency}}}}]};
      const wanted = new Set(values?.[0] as string[]);
      return {rows: rows.filter(row => wanted.has(row.id))};
    },
  }, randomUUID());
  assert.equal((await planFor([ids.codex, ids.maxOpus, ids.maxSonnet, ids.proSonnet])).primaryClaudeAccountId, accounts.max);
  assert.equal((await planFor([ids.codex], [ids.maxSonnet, ids.proSonnet])).primaryClaudeAccountId, accounts.max);
  assert.equal((await planFor([ids.proSonnet, ids.maxSonnet])).primaryClaudeAccountId, accounts.pro);
  // An unresolved entry before the first Claude profile must not promote a later Claude account.
  assert.equal((await planFor([ids.codex, ids.unknown, ids.proSonnet, ids.maxSonnet])).primaryClaudeAccountId, undefined);
  assert.equal((await planFor([ids.codex])).primaryClaudeAccountId, undefined);
});

test('seleção por módulo exige Sonnet 5.5 medium/high na primeira conta da cadeia, sem troca silenciosa nem rotação por cota, e encaminha achado alto do examinador para Opus 5.5 medium', {
  skip: !base, timeout: 120_000,
}, async () => {
  const database = await isolatedDatabase(base!, 'modrouting');
  const ledger = new Ledger(database.url);
  const root = await mkdtemp(join(tmpdir(), 'ac-mod-routing-'));
  let docker: Awaited<ReturnType<typeof startLaunchDocker>> | undefined;
  try {
    await ledger.migrate();
    const dataDirectory = join(root, 'data');
    const repo = join(root, 'repo');
    const hostRoot = join(root, 'spool');
    const accountRoot = join(root, 'accounts');
    for (const dir of [dataDirectory, repo, hostRoot, accountRoot]) await mkdir(dir, {mode: 0o700});

    const skippedLine = 'test.skip("valida pedido", () => {})';
    const secondSkipped = 'test.skip("valida entrega", () => {})';
    await writeFile(join(repo, 'app.test.ts'), `${skippedLine};\n${secondSkipped};\n`);
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', repo, ...args], {encoding: 'utf8', stdio: 'pipe'}).trim();
    git('init');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'initial');
    const commit = git('rev-parse', 'HEAD');

    const owner = 'routing-owner';
    const project = randomUUID();
    await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Roteamento']);
    await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, owner]);
    await ledger.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)', [project, repo]);
    await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1)', [owner]);
    await ledger.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");

    const capacity = new Capacity(ledger);
    await capacity.configure(owner, {programmingLimit: 2, evaluationLimit: 2});
    await capacity.registerModel(owner, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['medium', 'high'], roles: ['specialist'], source: 'synthetic://routing',
    });
    await capacity.registerModel(owner, {
      provider: 'claude', model: 'claude-opus-5-5', efforts: ['medium'], roles: ['specialist'], source: 'synthetic://routing',
    });
    await capacity.registerModel(owner, {
      provider: 'codex', model: 'gpt-6.2-sol', efforts: ['medium'], roles: ['specialist'], source: 'synthetic://routing',
    });

    const maxAccount = randomUUID();
    const proAccount = randomUUID();
    const codexAccount = randomUUID();
    const image = 'sha256:' + 'd'.repeat(64);
    const signingKeyPem = generateKeyPairSync('ed25519').privateKey.export({format: 'pem', type: 'pkcs8'}).toString();
    const socket = join(root, 'docker.sock');

    const accountSubjects = new Map<string, string>();
    for (const [accountId, provider, label] of [
      [maxAccount, 'claude', 'Max'],
      [proAccount, 'claude', 'Pro'],
      [codexAccount, 'codex', 'Codex'],
    ] as const) {
      const subject = `subject-${label.toLowerCase()}`;
      const subjectDigest = digest({provider, subject});
      accountSubjects.set(accountId, subjectDigest);
      await capacity.addAccount(owner, project, {
        id: accountId, provider, label, resourceIdentity: `${provider}:${subjectDigest}`,
        mode: 'subscription_cli', eligibility: 'documented_supported', eligibilitySource: 'synthetic://routing', maxConcurrent: 2,
      });
      await capacity.observeQuota(owner, accountId, {status: 'available', ttlSeconds: 3600, source: 'synthetic://routing'});
      await new AccountHomes(ledger, accountRoot, [repo]).initialize(owner, project, accountId);
      const dir = join(accountRoot, accountId);
      if (provider === 'claude') {
        await writeFile(join(dir, '.credentials.json'), JSON.stringify({
          claudeAiOauth: {accessToken: `tok-${label}`, refreshToken: `ref-${label}`, expiresAt: Date.now() + 3600_000},
        }), {mode: 0o600});
      } else {
        await mkdir(join(dir, '.codex'), {mode: 0o700});
        await writeFile(join(dir, '.codex', 'auth.json'), JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: {account_id: subject, access_token: 'tok-codex', refresh_token: 'ref-codex'},
        }), {mode: 0o600});
      }
    }

    const pOpusMax = randomUUID();
    const pSonnetMedMax = randomUUID();
    const pSonnetHighMax = randomUUID();
    const pSonnetMedPro = randomUUID();
    const pSonnetHighPro = randomUUID();
    const pCodexMed = randomUUID();
    await capacity.addProfile(owner, project, {id: pOpusMax, accountId: maxAccount, model: 'claude-opus-5-5', effort: 'medium', role: 'specialist'});
    await capacity.addProfile(owner, project, {id: pSonnetMedMax, accountId: maxAccount, model: 'claude-sonnet-5-5', effort: 'medium', role: 'specialist'});
    await capacity.addProfile(owner, project, {id: pSonnetHighMax, accountId: maxAccount, model: 'claude-sonnet-5-5', effort: 'high', role: 'specialist'});
    await capacity.addProfile(owner, project, {id: pSonnetMedPro, accountId: proAccount, model: 'claude-sonnet-5-5', effort: 'medium', role: 'specialist'});
    await capacity.addProfile(owner, project, {id: pSonnetHighPro, accountId: proAccount, model: 'claude-sonnet-5-5', effort: 'high', role: 'specialist'});
    await capacity.addProfile(owner, project, {id: pCodexMed, accountId: codexAccount, model: 'gpt-6.2-sol', effort: 'medium', role: 'specialist'});

    // Policy puts Max first in regular, followed by Pro and Codex.
    const rev1 = await capacity.publish(owner, project, 0, {
      schemaVersion: 1,
      maxProgrammersPerContext: 1,
      maxEvaluatorsPerContext: 2,
      roles: {
        specialist: {
          regular: [pOpusMax, pSonnetMedMax, pSonnetHighMax, pSonnetMedPro, pSonnetHighPro, pCodexMed],
          emergency: [],
        },
      },
    });
    const mainContext = await ledger.createContext(owner, project, randomUUID());
    await capacity.assignPolicy(owner, mainContext, rev1);

    const installation = join(dataDirectory, 'installation.json');
    await writeFile(installation, JSON.stringify({
      schemaVersion: 1, mode: 'administration-only', activation: 'personal',
      databaseUrl: database.url, dataDirectory,
      project: {id: project, label: 'Roteamento', repo, owner},
      projects: [],
      http: {listen: '127.0.0.1', port: 8765, publicOrigin: 'http://127.0.0.1:8765'},
    }), {mode: 0o600});

    let examinerFindingsMode: 'high-and-med' | 'none' = 'high-and-med';
    docker = await startLaunchDocker(socket, launch => {
      const task = JSON.parse(launch.task);
      if (task.checklist) {
        const findings = examinerFindingsMode === 'high-and-med' ? [
          {line: 1, snippet: skippedLine, hypothesis: skipQuestion, title: 'Exame alto', severity: 'alta'},
          {line: 2, snippet: secondSkipped, hypothesis: skipQuestion, title: 'Exame medio', severity: 'media'},
        ] : [];
        return {failureCode: null, output: JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: [task.module], findings})};
      }
      const snippet = task.line === 1 ? skippedLine : secondSkipped;
      return {failureCode: null, output: JSON.stringify(reviewFixtureVerdict(task, snippet))};
    });

    const makeSupervisor = (provider: 'claude' | 'codex', accountIds: string[]) => new NativeExecutionSupervisor(ledger, {
      id: `routing-${provider}`, provider, workerImage: image, toolsImage: image, hostRoot, accountRoot,
      protectedRepositories: [repo], signingKeyPem, providerNetworkId: 'e'.repeat(64), socketPath: socket,
      accountSubjects: accountIds.map(accountId => ({accountId, subjectDigest: accountSubjects.get(accountId)!})),
      workerEnv: [], toolsEnv: [], dataDirectory,
    });

    const fullRuntime: ModuleExamRuntime = [
      {provider: 'claude', accountIds: new Set([maxAccount, proAccount]), supervisor: makeSupervisor('claude', [maxAccount, proAccount])},
      {provider: 'codex', accountIds: new Set([codexAccount]), supervisor: makeSupervisor('codex', [codexAccount])},
    ];

    // 1) QA (medium) + examiner high finding -> examiner uses Sonnet 5.5 medium on Max;
    //    examiner high finding -> Opus 5.5 medium on Max (distinct profile & session);
    //    examiner medium finding & collector high finding -> Codex (other provider).
    const collectorFindings = [qaStaticFinding('app.test.ts', 1, `${skippedLine};`)];
    collectorFindings[0]!.severity = 'alta';
    const collectorOutput = {
      coverage: [{tool: qaStaticTool, version: '1', status: 'ok' as const, detail: 'leitura local'}],
      findings: collectorFindings,
    };
    const [qaRunId] = await runPersonalModuleCli('qa', [installation, project], {
      collectorOutput,
      moduleExamRuntime: async () => fullRuntime,
    });
    assert.ok(qaRunId);
    assert.equal(docker.launches.length, 4);
    const [qaExam, qaColHigh, qaExamHigh, qaExamMed] = docker.launches;
    assert.equal(qaExam!.provider, 'claude');
    assert.equal(qaExam!.model, 'claude-sonnet-5-5');
    assert.equal(qaExam!.effort, 'medium');
    assert.equal(qaExam!.accountId, maxAccount);
    assert.equal(qaExam!.profileId, pSonnetMedMax);
    // The worker container carries the installation and project ownership labels beside its identity labels.
    assert.equal(qaExam!.labels?.['com.agent-control.installation'], 'data');
    assert.equal(qaExam!.labels?.['com.agent-control.project'], project);
    assert.equal(qaExam!.labels?.['com.agent-control.kind'], 'native-specialist');
    assert.equal(qaExam!.labels?.['agent-control.contract'], 'native-execution-v1');
    // The job's private network is created with the same ownership labels.
    const qaNetwork = docker!.createdNetworks.find(network => network.Name === `ac-native-exec-${qaExam!.jobId}`);
    assert.ok(qaNetwork, 'a rede privada do exame foi criada');
    assert.equal(qaNetwork.Labels['com.agent-control.installation'], 'data');
    assert.equal(qaNetwork.Labels['com.agent-control.project'], project);
    assert.equal(qaNetwork.Labels['com.agent-control.kind'], 'native-specialist');

    assert.equal(qaColHigh!.provider, 'codex');
    assert.equal(qaColHigh!.accountId, codexAccount);

    assert.equal(qaExamHigh!.provider, 'claude');
    assert.equal(qaExamHigh!.model, 'claude-opus-5-5');
    assert.equal(qaExamHigh!.effort, 'medium');
    assert.equal(qaExamHigh!.accountId, maxAccount);
    assert.equal(qaExamHigh!.profileId, pOpusMax);
    assert.notEqual(qaExamHigh!.profileId, qaExam!.profileId);
    assert.notEqual(qaExamHigh!.sessionId, qaExam!.sessionId);
    assert.notEqual(qaExamHigh!.grantId, qaExam!.grantId);

    assert.equal(qaExamMed!.provider, 'codex');
    assert.equal(qaExamMed!.accountId, codexAccount);

    const qaReport = await readModuleReport(dataDirectory, project, qaRunId, 'qa');
    assert.equal(qaReport.achados.length, 3);
    assert.deepEqual(qaReport.achados.map(a => [a.severity, a.status, a.verifier?.provider, a.verifier?.model]), [
      ['alta', 'confirmado', 'codex', 'gpt-6.2-sol'],
      ['alta', 'confirmado', 'claude', 'claude-opus-5-5'],
      ['media', 'confirmado', 'codex', 'gpt-6.2-sol'],
    ]);
    assert.doesNotMatch(qaReport.coverageMarkdown, /Revisor de outro provedor/);

    // 2) Banco & Conformidade require Sonnet 5.5 HIGH on Max.
    examinerFindingsMode = 'none';
    // The test file is outside these modules' routing: a schema and a source file give each one a file to examine.
    await writeFile(join(repo, 'schema.sql'), 'CREATE TABLE pessoa (cpf text);\n');
    await writeFile(join(repo, 'rota.ts'), 'export const rota = 1;\n');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'escopo');
    for (const mod of ['banco', 'conformidade'] as const) {
      const before = docker.launches.length;
      await runPersonalModuleCli(mod, [installation, project], {
        collectorOutput: {coverage: [{tool: qaStaticTool, version: '1', status: 'ok', detail: 'ok'}], findings: []},
        moduleExamRuntime: async () => fullRuntime,
      });
      const launch: RecordedLaunch = docker.launches[before]!;
      assert.equal(launch.model, 'claude-sonnet-5-5');
      assert.equal(launch.effort, 'high');
      assert.equal(launch.accountId, maxAccount);
      assert.equal(launch.profileId, pSonnetHighMax);
    }

    // 2b) Arquitetura (medium) through the CLI uses Sonnet 5.5 medium on Max.
    {
      const before = docker.launches.length;
      await runPersonalModuleCli('arquitetura', [installation, project], {
        collectorOutput: {coverage: [{tool: qaStaticTool, version: '1', status: 'ok', detail: 'ok'}], findings: []},
        moduleExamRuntime: async () => fullRuntime,
      });
      assert.ok(docker.launches.length > before);
      for (const launch of docker.launches.slice(before)) {
        assert.equal(launch.provider, 'claude');
        assert.equal(launch.model, 'claude-sonnet-5-5');
        assert.equal(launch.effort, 'medium');
        assert.equal(launch.accountId, maxAccount);
        assert.equal(launch.profileId, pSonnetMedMax);
      }
    }

    git('rm', '-q', 'rota.ts');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'sem escopo extra');

    // 3) Check loadSpecialistExamPlan reflects DB chain priority without hardcoding UUIDs.
    const qaCtx = (await ledger.ensureExamContext(owner, project, 'qa')).contextId;
    const plan = await loadSpecialistExamPlan(ledger.pool, qaCtx);
    assert.equal(plan.primaryClaudeAccountId, maxAccount);

    // 4) When Max is exhausted, it MUST NOT rotate to Pro (which is available!). Surfaces PROVIDER_USAGE_LIMIT.
    const beforeExhaust = docker.launches.length;
    await capacity.observeQuota(owner, maxAccount, {status: 'exhausted', ttlSeconds: 3600, source: 'synthetic://routing'});
    let limitedReportDir = '';
    await assert.rejects(
      () => runPersonalModuleCli('qa', [installation, project], {
        collectorOutput: {coverage: [{tool: qaStaticTool, version: '1', status: 'ok', detail: 'ok'}], findings: []},
        moduleExamRuntime: async () => fullRuntime,
        onResult(res) { limitedReportDir = res.directory; },
      }),
      (err: unknown) => err instanceof Refusal && err.code === 'PROVIDER_USAGE_LIMIT',
    );
    assert.equal(docker.launches.length, beforeExhaust);
    assert.match(await readFile(join(limitedReportDir, 'cobertura.md'), 'utf8'), /PROVIDER_USAGE_LIMIT/);
    await capacity.observeQuota(owner, maxAccount, {status: 'available', ttlSeconds: 3600, source: 'synthetic://routing'});

    // 5) When runtime only loads Pro (Max absent from runtime), examiner MUST NOT rotate to Pro.
    const proOnlyRuntime: ModuleExamRuntime = [
      {provider: 'claude', accountIds: new Set([proAccount]), supervisor: makeSupervisor('claude', [proAccount])},
      {provider: 'codex', accountIds: new Set([codexAccount]), supervisor: makeSupervisor('codex', [codexAccount])},
    ];
    let proBlockedDir = '';
    // No examiner means no file judged: the run fails with its partial report.
    await assert.rejects(runPersonalModuleCli('qa', [installation, project], {
      collectorOutput: {coverage: [{tool: qaStaticTool, version: '1', status: 'ok', detail: 'ok'}], findings: []},
      moduleExamRuntime: async () => proOnlyRuntime,
      onResult(res) { proBlockedDir = res.directory; },
    }), (err: unknown) => err instanceof Refusal && err.code === 'MODULE_EXAM_INCOMPLETE'
      && moduleCliFailureText(err) === `O modelo não examinou 1 de 1 arquivos (código MODULE_EXAM_EXAMINER_UNAVAILABLE). Relatório parcial em ${proBlockedDir}.`);
    const blockedRun = await ledger.pool.query("SELECT status FROM ac_verify_runs WHERE report_dir=$1", [proBlockedDir]);
    assert.equal(blockedRun.rows[0]?.status, 'failed');
    assert.equal(docker.launches.length, beforeExhaust);
    assert.match(await readFile(join(proBlockedDir, 'cobertura.md'), 'utf8'), /Examinador indisponível/);

    // 6) When Opus 5.5 is disabled (unavailable) for high examiner findings,
    //    report MUST NOT claim "Revisor de outro provedor indisponível", and Codex still verifies non-high findings!
    examinerFindingsMode = 'high-and-med';
    const opusRev = Number((await ledger.pool.query('SELECT revision FROM ac_profiles WHERE id=$1', [pOpusMax])).rows[0].revision);
    await capacity.setEnabled(owner, project, 'profile', {id: pOpusMax, enabled: false, expectedRevision: opusRev});
    const beforeOpusOff = docker.launches.length;
    const [opusOffRunId] = await runPersonalModuleCli('qa', [installation, project], {
      collectorOutput: {coverage: [{tool: qaStaticTool, version: '1', status: 'ok', detail: 'ok'}], findings: []},
      moduleExamRuntime: async () => fullRuntime,
    });
    assert.equal(docker.launches.length, beforeOpusOff + 2); // 1 examiner + 1 codex for medium finding; Opus blocked
    const opusOffReport = await readModuleReport(dataDirectory, project, opusOffRunId!, 'qa');
    assert.deepEqual(opusOffReport.achados.map(a => [a.severity, a.status, a.verifier?.provider]), [
      ['alta', 'provavel', undefined],
      ['media', 'confirmado', 'codex'],
    ]);
    assert.doesNotMatch(opusOffReport.coverageMarkdown, /Revisor de outro provedor/);
    assert.match(opusOffReport.coverageMarkdown, /Revisor de achado alto \(claude-opus-5-5\) indisponível/);

    // Re-enable Opus 5.5 for recheck test!
    await capacity.setEnabled(owner, project, 'profile', {id: pOpusMax, enabled: true, expectedRevision: opusRev + 1});

    // 7) When Banco has no high-effort Sonnet profile on Max, MUST NOT silently fall back to medium or Opus.
    const revNoBancoHigh = await capacity.publish(owner, project, rev1, {
      schemaVersion: 1,
      maxProgrammersPerContext: 1,
      maxEvaluatorsPerContext: 2,
      roles: {
        specialist: {
          regular: [pOpusMax, pSonnetMedMax, pSonnetHighPro, pCodexMed],
          emergency: [],
        },
      },
    });
    await capacity.assignPolicy(owner, mainContext, revNoBancoHigh);
    const beforeNoHigh = docker.launches.length;
    let bancoMissingDir = '';
    await assert.rejects(runPersonalModuleCli('banco', [installation, project], {
      collectorOutput: {coverage: [{tool: qaStaticTool, version: '1', status: 'ok', detail: 'ok'}], findings: []},
      moduleExamRuntime: async () => fullRuntime,
      onResult(res) { bancoMissingDir = res.directory; },
    }), (err: unknown) => err instanceof Refusal && err.code === 'MODULE_EXAM_INCOMPLETE');
    assert.equal(docker.launches.length, beforeNoHigh);
    assert.match(await readFile(join(bancoMissingDir, 'cobertura.md'), 'utf8'), /Examinador indisponível/);

    // Restore rev1 for recheck test
    const revRestore = await capacity.publish(owner, project, revNoBancoHigh, {
      schemaVersion: 1,
      maxProgrammersPerContext: 1,
      maxEvaluatorsPerContext: 2,
      roles: {
        specialist: {
          regular: [pOpusMax, pSonnetMedMax, pSonnetHighMax, pSonnetMedPro, pSonnetHighPro, pCodexMed],
          emergency: [],
        },
      },
    });
    await capacity.assignPolicy(owner, mainContext, revRestore);
    await capacity.assignPolicy(owner, qaCtx, revRestore);

    // 8) Recheck of examiner high finding (ACH-002 from qaRunId) routes to Opus 5.5 medium on Max,
    //    while examiner medium finding (ACH-003) routes to Codex!
    const beforeRecheck = docker.launches.length;
    const recheckOut = await runPersonalModuleCli('qa', [installation, project, '--reverificar', qaRunId, 'ACH-002', 'ACH-003'], {
      moduleExamRuntime: async () => fullRuntime,
    });
    assert.deepEqual(recheckOut, ['ACH-002 reaberto', 'ACH-003 reaberto']);
    assert.equal(docker.launches.length, beforeRecheck + 2);
    const [recheckHigh, recheckMed] = docker.launches.slice(-2);
    assert.equal(recheckHigh!.provider, 'claude');
    assert.equal(recheckHigh!.model, 'claude-opus-5-5');
    assert.equal(recheckHigh!.effort, 'medium');
    assert.equal(recheckHigh!.accountId, maxAccount);
    assert.equal(recheckHigh!.profileId, pOpusMax);
    assert.equal(recheckMed!.provider, 'codex');
    assert.equal(recheckMed!.accountId, codexAccount);

    // 9) The priority Claude account comes from the raw policy order. Other providers may
    //    come first, but the first Claude account is the only one used, never a later one.
    const publishSpecialist = async (expected: number, regular: string[], emergency: string[] = []) => {
      const revision = await capacity.publish(owner, project, expected, {
        schemaVersion: 1, maxProgrammersPerContext: 1, maxEvaluatorsPerContext: 2,
        roles: {specialist: {regular, emergency}},
      });
      await capacity.assignPolicy(owner, mainContext, revision);
      await capacity.assignPolicy(owner, qaCtx, revision);
      return revision;
    };
    const examOnce = async (mod: VerificationModule, incomplete = false) => {
      const before = docker!.launches.length;
      let directory = '';
      const running = runPersonalModuleCli(mod, [installation, project], {
        collectorOutput: {coverage: [{tool: qaStaticTool, version: '1', status: 'ok', detail: 'ok'}], findings: []},
        moduleExamRuntime: async () => fullRuntime,
        onResult(res) { directory = res.directory; },
      });
      // Without an examiner the run fails, and the partial report says why.
      if (incomplete) await assert.rejects(running, (err: unknown) => err instanceof Refusal && err.code === 'MODULE_EXAM_INCOMPLETE');
      else await running;
      return {launches: docker!.launches.slice(before), directory};
    };
    examinerFindingsMode = 'none';
    const codexFirst = await publishSpecialist(revRestore,
      [pCodexMed, pOpusMax, pSonnetMedMax, pSonnetHighMax, pSonnetMedPro, pSonnetHighPro]);
    assert.equal((await loadSpecialistExamPlan(ledger.pool, qaCtx)).primaryClaudeAccountId, maxAccount);
    const codexFirstRun = await examOnce('qa');
    assert.deepEqual(codexFirstRun.launches.map(l => [l.accountId, l.profileId]), [[maxAccount, pSonnetMedMax]]);

    // Max listed first but without the module's profile: Pro (listed after) is not a fallback.
    await publishSpecialist(codexFirst, [pCodexMed, pOpusMax, pSonnetHighMax, pSonnetMedPro]);
    assert.equal((await loadSpecialistExamPlan(ledger.pool, qaCtx)).primaryClaudeAccountId, maxAccount);
    const noMediumRun = await examOnce('qa', true);
    assert.equal(noMediumRun.launches.length, 0);
    assert.match(await readFile(join(noMediumRun.directory, 'cobertura.md'), 'utf8'), /Examinador indisponível/);

  } finally {
    await docker?.close();
    await ledger.close();
    await database.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('achado alto do examinador exige sessões distintas atestadas no livro-razão no exame, na publicação e na rechecagem', {
  skip: !base, timeout: 90_000,
}, async () => {
  const database = await isolatedDatabase(base!, 'hostcheck');
  const ledger = new Ledger(database.url);
  const root = await mkdtemp(join(tmpdir(), 'ac-host-check-'));
  try {
    await ledger.migrate();
    const dataDirectory = join(root, 'data');
    const repo = join(root, 'repo');
    await mkdir(dataDirectory, {mode: 0o700});
    await mkdir(repo, {mode: 0o700});
    const skipped = 'test.skip("valida pedido", () => {})';
    await writeFile(join(repo, 'app.test.ts'), `${skipped};\n`);
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', repo, ...args], {encoding: 'utf8', stdio: 'pipe'}).trim();
    git('init');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'initial');
    const commit = git('rev-parse', 'HEAD');

    const principal = 'host-owner';
    const projectId = randomUUID();
    await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [projectId, 'Host Check']);
    await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [projectId, principal]);
    await ledger.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)', [projectId, repo]);
    await ledger.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await ledger.createContext(principal, projectId, randomUUID());
    const {contextId} = await ledger.ensureExamContext(principal, projectId, 'qa');
    const authority = await ledger.acquire(principal, contextId, randomUUID(), 'host-check', 60);

    const maxAccount = randomUUID();
    const examinerSeat: ModuleExamSeat = {
      provider: 'claude', model: 'claude-sonnet-5-5', accountId: maxAccount, profileId: randomUUID(), grantId: randomUUID(),
    };
    const opusSeat: ModuleExamSeat = {
      provider: 'claude', model: 'claude-opus-5-5', accountId: maxAccount, profileId: randomUUID(), grantId: randomUUID(),
    };
    const examinerSession = randomUUID();
    const reviewerSession = randomUUID();
    const map = {files: [{file: 'app.test.ts', code: `${skipped}\n`, reason: null}], routes: []};
    const highFinding = [{line: 1, snippet: skipped, hypothesis: skipQuestion, title: 'Alto', severity: 'alta'}];
    // The worker reports sessions the way the native worker does; `reviewerSessionFor` lets a case omit or reuse one.
    const fakeWorker = (reviewerSessionFor: () => string | undefined) => ({
      async run(call: {task: string}) {
        const task = JSON.parse(call.task);
        const session = task.checklist ? examinerSession : reviewerSessionFor();
        if (session) (call as {examSessionId?: string}).examSessionId = session;
        if (task.checklist) {
          return JSON.stringify({kind: 'exame', binding: task.binding, filesRead: ['app.test.ts'], checklist: ['qa'], findings: highFinding});
        }
        return JSON.stringify(reviewFixtureVerdict(task, skipped));
      },
    });
    const exam = async (options: {
      reviewer?: ModuleExamSeat; reviewerSession?: () => string | undefined;
      attest?: Parameters<typeof examineFunctionalModule>[0]['attestSessions'];
    }) => {
      const reserved: string[] = [];
      const result = await examineFunctionalModule({
        module: 'qa', intentId: randomUUID(), map, findings: [], commit,
        reserve: async purpose => { reserved.push(purpose); return purpose === 'examiner' ? examinerSeat : options.reviewer ?? opusSeat; },
        release: async () => {},
        worker: fakeWorker(options.reviewerSession ?? (() => reviewerSession)),
        ...(options.attest ? {attestSessions: options.attest} : {}),
      });
      return {finding: result.findings[0]!, reserved, coverage: result.coverage};
    };

    // 1) Exam: without a ledger attestation the reviewer seat is not even reserved.
    const noAttest = await exam({});
    assert.equal(noAttest.finding.status, 'provavel');
    assert.equal(noAttest.finding.failure, 'MODULE_EXAM_HIGH_SESSION_UNPROVEN');
    assert.deepEqual(noAttest.reserved, ['examiner']);
    assert.equal(noAttest.coverage[0]?.examiner?.sessionId, examinerSession);
    assert.equal(noAttest.coverage[0]?.examiner?.grantId, examinerSeat.grantId);

    // 2) Exam: wrong reviewer model is still refused before launch.
    const badModel = await exam({reviewer: {...opusSeat, model: 'claude-sonnet-5-5'}, attest: async () => true});
    assert.equal(badModel.finding.failure, 'MODULE_EXAM_HIGH_REVIEWER_UNAVAILABLE');
    assert.equal(badModel.finding.verifier, null);

    // 3) Exam: on the same account, an omitted or reused reviewer session is refused even if attestation would pass.
    const attestCalls: unknown[] = [];
    const permissive = async (pair: unknown) => { attestCalls.push(pair); return true; };
    for (const reviewerSessionFor of [() => undefined, () => examinerSession]) {
      const res = await exam({reviewerSession: reviewerSessionFor, attest: permissive});
      assert.equal(res.finding.status, 'provavel');
      assert.equal(res.finding.failure, 'MODULE_EXAM_HIGH_SESSION_UNPROVEN');
      assert.equal(res.finding.verifier, null);
    }
    assert.equal(attestCalls.length, 0);

    // 4) Exam: distinct sessions that the ledger does not bind stay probable.
    const refused = await exam({attest: async () => false});
    assert.equal(refused.finding.failure, 'MODULE_EXAM_HIGH_SESSION_UNPROVEN');
    assert.equal(refused.finding.verifier, null);

    // 5) Exam: distinct, attested sessions confirm and keep both identities.
    const attested = await exam({attest: permissive});
    assert.equal(attested.finding.status, 'confirmado');
    assert.equal(attested.finding.verifier?.sessionId, reviewerSession);
    assert.equal(attested.finding.verifier?.grantId, opusSeat.grantId);
    assert.deepEqual(attestCalls.at(-1), {
      examiner: {...examinerSeat, sessionId: examinerSession},
      reviewer: {...opusSeat, sessionId: reviewerSession},
      file: 'app.test.ts', line: 1,
      finding: examFindingIdentity({id: 'ACH-001', source: 'examinador', file: 'app.test.ts', line: 1, severity: 'alta',
        evidence: skipped, hypothesis: skipQuestion}),
    });

    // 5b) Exam: a reviewer that ran out of quota keeps PROVIDER_USAGE_LIMIT, not a session code.
    const limited = await examineFunctionalModule({
      module: 'qa', intentId: randomUUID(), map, findings: [], commit,
      reserve: async purpose => purpose === 'examiner' ? examinerSeat : opusSeat,
      release: async () => {},
      attestSessions: async () => false,
      worker: {
        async run(call) {
          const task = JSON.parse(call.task);
          (call as {examSessionId?: string}).examSessionId = task.checklist ? examinerSession : reviewerSession;
          if (task.checklist) {
            return JSON.stringify({kind: 'exame', binding: task.binding, filesRead: ['app.test.ts'], checklist: ['qa'], findings: highFinding});
          }
          return 'Claude usage limit reached';
        },
      },
    });
    assert.equal(limited.findings[0]?.failure, 'PROVIDER_USAGE_LIMIT');

    // 6) Publication: the exam result's grants and sessions are claims. Without a native
    //    execution in the ledger, distinct grants (with or without sessions) never confirm.
    const runWithTamper = (tamper: (res: Awaited<ReturnType<typeof examineFunctionalModule>>) => void) =>
      runVerificationModule({
        module: 'qa', ledger, principal, authority, projectId, repoPath: repo, dataDirectory, commit,
        collectorOutput: {coverage: [{tool: qaStaticTool, version: '1', status: 'ok', detail: 'ok'}], findings: []},
        async examinar(req) {
          const snapshotMap = await mapModuleSnapshot(req.snapshot);
          const res = await examineFunctionalModule({
            ...req, map: snapshotMap, commit,
            reserve: async purpose => purpose === 'examiner' ? examinerSeat : opusSeat,
            release: async () => {},
            worker: fakeWorker(() => reviewerSession),
            attestSessions: async () => true,
          });
          tamper(res);
          return res;
        },
      });

    const unbound = await runWithTamper(() => {});
    assert.equal(unbound.achados[0]?.status, 'provavel');
    assert.equal(unbound.achados[0]?.verifier, null);

    const grantsOnly = await runWithTamper(res => {
      delete res.coverage[0]!.examiner!.sessionId;
      delete res.findings[0]!.verifier!.sessionId;
    });
    assert.equal(grantsOnly.achados[0]?.status, 'provavel');
    assert.equal(grantsOnly.achados[0]?.verifier, null);

    const sameSession = await runWithTamper(res => {
      res.findings[0]!.verifier!.sessionId = res.coverage[0]!.examiner!.sessionId;
    });
    assert.equal(sameSession.achados[0]?.verifier, null);

    const otherAccount = await runWithTamper(res => {
      res.findings[0]!.verifier!.accountId = randomUUID();
      delete res.coverage[0]!.examiner!.sessionId;
      delete res.findings[0]!.verifier!.sessionId;
    });
    assert.equal(otherAccount.achados[0]?.verifier, null);

    const coverageRow = async (runId: string) => (await ledger.pool.query(
      'SELECT examiner_grant_id::text AS grant_id, examiner_session_id::text AS session_id FROM ac_verify_coverage WHERE run_id=$1 AND file=$2',
      [runId, 'app.test.ts'])).rows[0];
    assert.deepEqual(await coverageRow(unbound.runId), {grant_id: examinerSeat.grantId, session_id: examinerSession});
    assert.deepEqual(await coverageRow(grantsOnly.runId), {grant_id: null, session_id: null});

    // 7) Recheck: the coverage keeps the original grant and session, but the ledger has no
    //    native execution for them (and no account for the profile). The original cannot be
    //    attested, so no reviewer seat is spent, whatever the reviewer would report.
    const findingStatus = async (runId: string) => (await ledger.pool.query(
      "SELECT status FROM ac_verify_findings WHERE run_id=$1 AND achado_id='ACH-001'", [runId])).rows[0]?.status;
    const reviewerFor = (sessionId?: string) => ({
      provider: 'claude', model: 'claude-opus-5-5', accountId: maxAccount, profileId: opusSeat.profileId, grantId: randomUUID(),
      ...(sessionId ? {sessionId} : {}),
    });
    for (const sessionId of [undefined, examinerSession, randomUUID()]) {
      const seen: unknown[] = [];
      const outcome = await recheckModuleFindings(ledger, principal, authority, {
        module: 'qa', runId: unbound.runId, achadoIds: ['ACH-001'], dataDirectory, projectId,
        async review(req) {
          seen.push(req.examiner);
          return {reviewer: reviewerFor(sessionId), output: JSON.stringify(reviewFixtureVerdict(JSON.parse(req.task), skipped))};
        },
      });
      assert.deepEqual(outcome.results, [{id: 'ACH-001', status: 'pendente', reason: 'MODULE_RECHECK_EXAMINER_SESSION_UNPROVEN'}]);
      assert.deepEqual(seen, []);
      assert.equal(await findingStatus(unbound.runId), 'provavel');
    }

    // 8) Recheck: history without the examiner session fails closed and spends no reviewer seat.
    let historyReviews = 0;
    const history = await recheckModuleFindings(ledger, principal, authority, {
      module: 'qa', runId: grantsOnly.runId, achadoIds: ['ACH-001'], dataDirectory, projectId,
      async review() { historyReviews += 1; return {reason: 'UNEXPECTED'}; },
    });
    assert.deepEqual(history.results, [{id: 'ACH-001', status: 'pendente', reason: 'MODULE_RECHECK_EXAMINER_SESSION_UNPROVEN'}]);
    assert.equal(historyReviews, 0);

    // 9) A reviewer of the wrong model is not even asked when the original is unattested.
    let wrongModelReviews = 0;
    const wrongModel = await recheckModuleFindings(ledger, principal, authority, {
      module: 'qa', runId: unbound.runId, achadoIds: ['ACH-001'], dataDirectory, projectId,
      async review(req) {
        wrongModelReviews += 1;
        return {
          reviewer: {provider: 'codex', model: 'gpt-6.2-sol', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()},
          output: JSON.stringify(reviewFixtureVerdict(JSON.parse(req.task), skipped)),
        };
      },
    });
    assert.deepEqual(wrongModel.results, [{id: 'ACH-001', status: 'pendente', reason: 'MODULE_RECHECK_EXAMINER_SESSION_UNPROVEN'}]);
    assert.equal(wrongModelReviews, 0);
  } finally {
    await ledger.close();
    await database.close();
    await rm(root, {recursive: true, force: true});
  }
});
