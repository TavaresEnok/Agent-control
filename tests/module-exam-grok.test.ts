import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, randomUUID} from 'node:crypto';
import {chmod, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {AccountHomes} from '../src/account-homes.ts';
import {Refusal, digest, type Command} from '../src/contracts.ts';
import {examLoginNeedsRefresh, grokAccessExpiresAt} from '../src/exam-login.ts';
import {moduleExamConnectHost, moduleExamProviders} from '../src/module-exam-egress.ts';
import {createModuleExamReservations} from '../src/module-exam-native.ts';
import {MODULE_EXAM_GROK_PREAMBLE, moduleExamGrokArgs, readModuleExamGrokOutput, resolveModuleExamGrokResult} from '../src/module-exam-worker.ts';
import {NativeExecutionRequest, NativeExecutionSupervisor} from '../src/native-execution-supervisor.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

// Cabeçalho real do Grok 1.0.70 ao abrir o túnel pelo proxy.
const grokConnect = (host: string) => `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nuser-agent: grok-shell/1.0.70 (linux; x86_64)`;

test('o revisor Grok só alcança o host de conversa do provedor', () => {
  assert.ok(moduleExamProviders.includes('grok'));
  assert.equal(moduleExamConnectHost(grokConnect('cli-chat-proxy.grok.com'), 'grok'), 'cli-chat-proxy.grok.com');
  // Login (renovação), telemetria e demais hosts ficam fechados; os hosts dos outros provedores também.
  for (const host of ['api.x.ai', 'accounts.x.ai', 'auth.x.ai', 'grok.com', 'api.mixpanel.com', 'api.anthropic.com', 'chatgpt.com']) {
    assert.equal(moduleExamConnectHost(grokConnect(host), 'grok'), undefined, host);
  }
  assert.equal(moduleExamConnectHost(grokConnect('cli-chat-proxy.grok.com'), 'claude'), undefined);
  assert.equal(moduleExamConnectHost(grokConnect('cli-chat-proxy.grok.com'), 'codex'), undefined);
  assert.equal(moduleExamConnectHost(grokConnect('cli-chat-proxy.grok.com') + '\r\nProxy-Authorization: x', 'grok'), undefined);
});

test('o Grok roda sem ferramentas, sem web, sem subagentes, em modo plan e num turno só', () => {
  const args = moduleExamGrokArgs({model: 'grok-4.7', effort: 'xhigh'}, '/tmp/h/pedido.txt', '/tmp/vazio');
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(value('--model'), 'grok-4.7');
  assert.equal(value('--reasoning-effort'), 'high');
  assert.equal(value('--tools'), '');
  assert.equal(value('--permission-mode'), 'plan');
  assert.equal(value('--max-turns'), '1');
  assert.equal(value('--output-format'), 'json');
  assert.equal(value('--json-schema'), '{"type":"object"}');
  assert.equal(value('--prompt-file'), '/tmp/h/pedido.txt');
  assert.equal(value('--cwd'), '/tmp/vazio');
  assert.ok(args.includes('--disable-web-search') && args.includes('--no-subagents'));
  for (const forbidden of ['--always-approve', '--no-plan', '-p', '--add-dir', '--agents', '--allow']) assert.ok(!args.includes(forbidden), forbidden);
  assert.match(MODULE_EXAM_GROK_PREAMBLE, /só pelo código/);
});

test('a saída do Grok vale só num turno encerrado do modelo reservado', () => {
  const verdict = {kind: 'confirmacao', status: 'confirmado'};
  const ok = {text: JSON.stringify(verdict), stopReason: 'end_turn', num_turns: 1, structuredOutput: verdict,
    usage: {input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 0, reasoning_tokens: 15},
    modelUsage: {'grok-4.7-build': {inputTokens: 100}}};
  const read = (value: object, model = 'grok-4.7') => readModuleExamGrokOutput(JSON.stringify(value), model);
  const good = read(ok);
  assert.equal(good.succeeded, true);
  assert.deepEqual(JSON.parse(good.output), verdict);
  assert.deepEqual(good.counters, {input: 100, output: 20, cache: 30, reasoning: 15});
  // Um segundo turno é uma volta de ferramenta; cancelled é a parada do modo plan ao tentar a rede.
  assert.equal(read({...ok, num_turns: 2}).succeeded, false);
  assert.equal(read({...ok, stopReason: 'cancelled'}).succeeded, false);
  assert.equal(read({...ok, stopReason: 'cancelled'}).output, '');
  assert.equal(read(ok, 'grok-5').succeeded, false);
  assert.equal(read({...ok, modelUsage: {}}).succeeded, false);
  assert.equal(readModuleExamGrokOutput('não é json', 'grok-4.7').succeeded, false);
  const error = readModuleExamGrokOutput(JSON.stringify({type: 'error', message: 'Not signed in.'}), 'grok-4.7');
  assert.equal(error.succeeded, false);
  assert.deepEqual(error.diagnostics, ['Not signed in.']);
});

test('limite, login e segredo da resposta do Grok', () => {
  const secret = 'segredo-do-login-123456';
  assert.deepEqual(resolveModuleExamGrokResult({succeeded: true, output: `{"proof":"${secret}"}`, diagnostics: []}, [secret]).failureCode, null);
  assert.ok(!resolveModuleExamGrokResult({succeeded: true, output: `{"proof":"${secret}"}`, diagnostics: []}, [secret]).output.includes(secret));
  const fail = (text: string) => resolveModuleExamGrokResult({succeeded: false, output: '', diagnostics: [text]}, []).failureCode;
  assert.equal(fail('Error: 429 Too Many Requests'), 'PROVIDER_USAGE_LIMIT');
  assert.equal(fail('You have reached your usage limit'), 'PROVIDER_USAGE_LIMIT');
  assert.equal(fail('Not signed in. To authenticate without a browser, run: grok login --device-code'), 'PROVIDER_AUTH_FAILED');
  assert.equal(fail('cancelled'), 'MODULE_EXAM_PROVIDER_FAILED');
});

test('validade do login do Grok é a do item que vence primeiro', () => {
  const now = Date.parse('2026-11-24T22:00:00Z');
  const entry = (at: string) => ({key: 'k', refresh_token: 'r', expires_at: at});
  assert.equal(grokAccessExpiresAt({a: entry('2026-11-25T03:00:00Z'), b: entry('2026-11-25T01:00:00Z')}), Date.parse('2026-11-25T01:00:00Z'));
  assert.equal(grokAccessExpiresAt({a: {key: 'k'}}), null);
  assert.equal(grokAccessExpiresAt({}), null);
  assert.equal(grokAccessExpiresAt([]), null);
  assert.equal(examLoginNeedsRefresh(grokAccessExpiresAt({a: entry('2026-11-25T03:00:00Z')}), now, 120_000), false);
  assert.equal(examLoginNeedsRefresh(grokAccessExpiresAt({a: entry('2026-11-24T22:05:00Z')}), now, 120_000), true);
});

const base = process.env.AC_TEST_DATABASE_URL;

test('com examinador Claude, o revisor de outro provedor dos módulos 2 a 9 pode ser um perfil Grok', {skip: !base}, async () => {
  const fixture = await isolatedDatabase(base!, 'modexamgrok');
  const ledger = new Ledger(fixture.url);
  try {
    await ledger.migrate();
    const capacity = new Capacity(ledger);
    const owner = 'grok-owner', project = randomUUID();
    await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Grok reviewer']);
    await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, owner]);
    await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1)', [owner]);
    await capacity.configure(owner, {programmingLimit: 4, evaluationLimit: 4});
    const roles = ['manager', 'programmer', 'reviewer', 'qa', 'specialist', 'judge'] as const;
    // Mesmo registro que o account-add grava para o Grok na instalação.
    await capacity.registerModel(owner, {provider: 'grok', model: 'grok-4.7', efforts: ['low', 'medium', 'high'], roles: [...roles], source: 'personal://account-add'});
    await capacity.registerModel(owner, {provider: 'claude', model: 'claude-opus-5-5', efforts: ['medium', 'high'], roles: [...roles], source: 'synthetic://allow'});
    await capacity.registerModel(owner, {provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['medium', 'high'], roles: ['specialist'], source: 'synthetic://module-exam'});
    const claude = randomUUID(), grok = randomUUID();
    for (const [id, provider] of [[claude, 'claude'], [grok, 'grok']] as const) {
      await capacity.addAccount(owner, project, {id, provider, label: provider, resourceIdentity: `${provider}:${id}`, mode: 'synthetic',
        eligibility: 'documented_supported', eligibilitySource: 'synthetic://allow', maxConcurrent: 2});
      await capacity.observeQuota(owner, id, {status: 'available', ttlSeconds: 3600, source: 'synthetic://allow'});
    }
    const profile = async (accountId: string, model: string, effort: 'medium' | 'high') => {
      const id = randomUUID();
      await capacity.addProfile(owner, project, {id, accountId, model, effort, role: 'specialist'});
      return id;
    };
    const sonnet = await profile(claude, 'claude-sonnet-5-5', 'medium');
    const opus = await profile(claude, 'claude-opus-5-5', 'medium');
    const grokProfile = await profile(grok, 'grok-4.7', 'medium');
    const rev = await capacity.publish(owner, project, 0, {schemaVersion: 1, maxProgrammersPerContext: 2, maxEvaluatorsPerContext: 4,
      roles: {specialist: {regular: [sonnet, grokProfile], emergency: [opus]}}});
    const context = await ledger.createContext(owner, project, randomUUID());
    await capacity.assignPolicy(owner, context, rev);
    const authority = await ledger.acquire(owner, context, randomUUID(), 'grok-test', 60);
    const command: Command = {schemaVersion: 1, intentId: randomUUID(), deliveryAttemptId: randomUUID(), contextId: context,
      policyRevision: rev, action: 'plan.start', payload: {workflow: 'baseline-synthetic-v1', messageRef: 'grok'}};
    const intentId = (await ledger.accept(owner, command, authority, 'api')).id;
    const supportedSeats = new Map<'claude' | 'grok', ReadonlySet<string>>([['claude', new Set([claude])], ['grok', new Set([grok])]]);
    const reservations = createModuleExamReservations({module: 'qa', ledger, principal: owner, authority, intentId, supportedSeats});

    // O examinador continua Claude, mesmo com o Grok na frente da política.
    const examiner = await reservations.reserve('examiner');
    assert.equal(examiner.provider, 'claude');
    assert.equal(examiner.profileId, sonnet);

    // Achado do coletor ou achado médio do examinador: revisor de outro provedor, aqui o Grok.
    for (const target of [{source: 'coletor', severity: 'alta', fromExaminer: false}, {source: 'examinador', severity: 'media', fromExaminer: true}] as const) {
      const reviewer = await reservations.reserve('reviewer', examiner, target);
      assert.equal(reviewer.provider, 'grok');
      assert.equal(reviewer.accountId, grok);
      assert.equal(reviewer.profileId, grokProfile);
      assert.equal(reviewer.model, 'grok-4.7');
      await reservations.release(reviewer, 'not_started');
    }
    // Achado alto do examinador continua com o Opus.
    const high = await reservations.reserve('reviewer', examiner, {source: 'examinador', severity: 'alta', fromExaminer: true});
    assert.equal(high.provider, 'claude');
    assert.equal(high.profileId, opus);
    await reservations.release(high, 'not_started');

    // Sem Grok no projeto, não há outro provedor: o revisor fica indisponível, nunca vira Claude.
    const onlyClaude = createModuleExamReservations({module: 'qa', ledger, principal: owner, authority, intentId, supportedSeats,
      allowedAccountIds: [claude]});
    await assert.rejects(() => onlyClaude.reserve('reviewer', examiner, {source: 'coletor', severity: 'media', fromExaminer: false}),
      (error: unknown) => error instanceof Refusal && error.code === 'MODULE_EXAM_REVIEWER_UNAVAILABLE');
    await reservations.release(examiner, 'not_started');
  } finally {
    await ledger.pool.end();
    await fixture.close();
  }
});

test('o supervisor monta só o login do Grok, só leitura, sem rede, e recusa login perto do fim antes de qualquer contêiner', {skip: !base}, async () => {
  const fixture = await isolatedDatabase(base!, 'modexamgrokpre');
  const db = new Ledger(fixture.url), area = await mkdtemp(join(tmpdir(), 'ac-modexam-grok-'));
  const errors = mock.method(console, 'error', () => undefined);
  try {
    await db.migrate();
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    const project = randomUUID(), owner = 'app-' + randomUUID(), account = randomUUID(), profile = randomUUID(), commit = 'f'.repeat(40);
    const repo = join(area, 'repo'), spool = join(area, 'exec-host'), accounts = join(area, 'accounts'), grokHome = join(accounts, account, '.grok');
    for (const dir of [repo, spool, accounts, join(accounts, account), grokHome]) { await mkdir(dir, {recursive: true, mode: 0o700}); await chmod(dir, 0o700); }
    const writeLogin = (expiresAt: Date) => writeFile(join(grokHome, 'auth.json'), JSON.stringify({'https://auth.x.ai::id': {
      key: 'chave-sintetica-do-grok-0001', refresh_token: 'renovacao-sintetica-0001', expires_at: expiresAt.toISOString()}}), {mode: 0o600});
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Grok module exam fixture']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, owner]);
    await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)', [project, repo]);
    const subject = digest({provider: 'grok', subject: 'module-exam-grok'});
    const capacity = new Capacity(db);
    await capacity.addAccount(owner, project, {id: account, provider: 'grok', label: 'grok fixture', resourceIdentity: 'grok:' + subject, mode: 'subscription_cli',
      eligibility: 'documented_supported', eligibilitySource: 'https://example.invalid/fixture', maxConcurrent: 2});
    await capacity.observeQuota(owner, account, {status: 'available', source: 'https://example.invalid/fixture', ttlSeconds: 3600});
    await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'grok-4.7','medium','specialist',true)", [profile, account]);
    await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)", [project, 'b'.repeat(64), owner]);
    const contextId = await db.createContext(owner, project, randomUUID());
    await db.pool.query("INSERT INTO ac_exam_contexts(project_id,module,context_id) VALUES($1,'qa',$2)", [project, contextId]);
    const authority = await db.acquire(owner, contextId, randomUUID(), 'module-exam', 60);
    const intentId = randomUUID();
    const command = {schemaVersion: 1 as const, intentId, deliveryAttemptId: randomUUID(), contextId, policyRevision: 1, action: 'plan.start' as const,
      payload: {workflow: 'security-verify-readonly-v1', messageRef: `qa:${project}:${commit}`, projectId: project, commit}};
    await db.pool.query(`INSERT INTO ac_intents (id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision)
      SELECT $1,id,$3,$4,$5::jsonb,$6,$7,$8,plan_revision FROM ac_contexts WHERE id=$2`,
    [intentId, contextId, owner, digest(command), JSON.stringify(command), randomUUID(), randomUUID(), authority.epoch]);
    await db.pool.query(`INSERT INTO ac_verify_runs (id,project_id,context_id,intent_id,principal_id,commit_id,status,report_dir,module) VALUES ($1,$2,$3,$4,$5,$6,'running','pending','qa')`,
      [randomUUID(), project, contextId, intentId, owner, commit]);
    const grant = async () => {
      const grantId = randomUUID();
      await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,'specialist',$8,1,1,$9,false,'reserved')`, [grantId, randomUUID(), intentId, contextId, authority.epoch, account, profile, project, digest({grant: grantId})]);
      return grantId;
    };
    const keys = generateKeyPairSync('ed25519'), image = 'sha256:' + '0'.repeat(64);
    const supervisor = new NativeExecutionSupervisor(db, {id: 'grok-native-execution', provider: 'grok', workerImage: image, toolsImage: image, hostRoot: spool, accountRoot: accounts,
      repository: repo, protectedRepositories: [], signingKeyPem: keys.privateKey.export({format: 'pem', type: 'pkcs8'}).toString(), providerNetworkId: 'd'.repeat(64),
      socketPath: join(area, 'docker.sock'), accountSubjects: [{accountId: account, subjectDigest: subject}], workerEnv: [], toolsEnv: []}, {assertAdmission: async () => {}});
    const created: {name: string; spec: {HostConfig: {NetworkMode: string; Mounts?: {Source: string; Target: string; ReadOnly: boolean}[]; Binds?: string[]}}}[] = [];
    const mutations: string[] = [];
    Object.defineProperty(supervisor, 'doc' + 'ker', {value: {
      imagePresent: async () => true, inspect: async () => null, inspectNamedPrivateNetwork: async () => null, inspectPrivateNetwork: async () => null,
      stop: async () => { mutations.push('stop'); }, remove: async () => { mutations.push('remove'); }, start: async () => { mutations.push('start'); throw new Error('FIXTURE_STOP'); },
      createPrivateNetwork: async () => { mutations.push('network'); return 'a'.repeat(64); },
      create: async (name: string, spec: never) => { mutations.push('create'); created.push({name, spec}); return 'c'.repeat(64); },
    }});
    const homes = mock.method(AccountHomes.prototype, 'inspectGranted', async () => ({accountId: account, projectId: project, ownerId: owner, uid: '1', device: '1', inode: '1'}));
    const jobs: string[] = [];
    const request = (grantId: string) => NativeExecutionRequest.parse({jobId: (jobs.push(randomUUID()), jobs.at(-1)), intentId, grantId, sessionId: randomUUID(), base: commit, role: 'specialist',
      task: 'Revise o achado.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
      moduleExam: {accountId: account, profileId: profile, model: 'grok-4.7'}, timeoutMs: 120000});
    try {
      // Login que vence durante o exame: recusa antes de qualquer contêiner, sem tentar renovar.
      await writeLogin(new Date(Date.now() + 60_000));
      const staleGrant = await grant();
      await assert.rejects(() => supervisor.start(owner, authority, request(staleGrant)), (error: unknown) => error instanceof Refusal && error.code === 'EXAM_LOGIN_STALE');
      assert.deepEqual(mutations, []);
      assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1', [staleGrant])).rows[0].state, 'released');

      // Login válido: o worker não tem rede, não tem /work nem a pasta da conta, só o auth.json do Grok em leitura.
      await writeLogin(new Date(Date.now() + 6 * 3600_000));
      await supervisor.start(owner, authority, request(await grant())).catch(() => undefined /* the fake Docker stops at start */);
      // The core admitted a Grok module exam (native-execution-core: moduleExamProviders): the job is journaled.
      const journaled = (await db.pool.query('SELECT role,account_id FROM ac_native_execution_jobs WHERE id=$1', [jobs.at(-1)])).rows[0];
      assert.deepEqual(journaled, {role: 'specialist', account_id: account});
      const worker = created.find(item => item.name.startsWith('ac-native-worker-'));
      assert.ok(worker, JSON.stringify(mutations));
      assert.equal(worker.spec.HostConfig.NetworkMode, 'none');
      const mounts = JSON.stringify(worker.spec.HostConfig);
      assert.ok(mounts.includes(join(grokHome, 'auth.json')));
      assert.ok(!mounts.includes(':/work') && !mounts.includes('"/work"'));
      assert.ok(!mounts.includes(join(accounts, account) + ':/account') && !mounts.includes('"Target":"/account"'));
      const bind = (worker.spec.HostConfig.Binds ?? []).find(entry => entry.includes('/account/.grok/auth.json'));
      const mount = (worker.spec.HostConfig.Mounts ?? []).find(entry => entry.Target === '/account/.grok/auth.json');
      assert.ok(bind?.endsWith(':ro') || mount?.ReadOnly === true, mounts);
    } finally { homes.mock.restore(); for (const job of jobs) supervisor.closeModuleExamEgress(job); }
  } finally {
    errors.mock.restore();
    await db.pool.end(); await fixture.close(); await rm(area, {recursive: true, force: true});
  }
});

test('login do revisor Grok vencido para a fila comum na primeira recusa e a nota nomeia o Grok', async () => {
  const {examineFunctionalModule, examJobExited} = await import('../src/module-exam.ts');
  const {qaStaticFinding} = await import('./fixtures/module-exam-review.ts');
  const skipped = (n: number) => `test.skip("caso ${n}", () => {})`;
  const files = Array.from({length: 6}, (_, f) => ({file: `src/g${f}.test.ts`, reason: null, code: skipped(f) + ';\n'}));
  const findings = files.map(({file}, f) => qaStaticFinding(file, 1, skipped(f) + ';'));
  const seat = (provider: string) => ({provider, model: provider === 'grok' ? 'grok-4.7' : 'claude-sonnet-5-5', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()});
  const examiner = seat('claude');
  let reviewerSeats = 0, reviewerCalls = 0;
  const result = await examineFunctionalModule({module: 'qa', intentId: randomUUID(), commit: 'a'.repeat(40), map: {files, routes: []}, findings,
    reviewTriage: false,
    reserve: async purpose => { if (purpose === 'examiner') return examiner; reviewerSeats++; return seat('grok'); },
    release: async () => {},
    worker: {async run(call) {
      const task = JSON.parse(call.task);
      if (task.checklist) return JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: ['qa'], routesReviewed: [], findings: []});
      reviewerCalls++;
      // The supervisor refused before launch, and the native worker reconciled the job as terminal.
      throw examJobExited(new Refusal('EXAM_LOGIN_STALE'));
    }}});
  assert.equal(reviewerSeats, 1);
  assert.equal(reviewerCalls, 1);
  assert.equal(result.findings.length, 6);
  assert.ok(result.findings.every(finding => finding.failure === 'EXAM_LOGIN_STALE' && finding.status === 'provavel'));
  assert.ok(result.notes.includes('Login da conta Grok da instalação vencido; renove e rode de novo.'), JSON.stringify(result.notes));
  assert.ok(!result.notes.some(note => note.includes('conta Claude')));
});

test('o runtime do exame cria um assento Grok para a conta Grok ativa da instalação', {skip: !base}, async () => {
  const {composePersonalModuleExamRuntime} = await import('../src/module-exam-native.ts');
  const fixture = await isolatedDatabase(base!, 'modexamgrokrt');
  const ledger = new Ledger(fixture.url), area = await mkdtemp(join(tmpdir(), 'ac-modexam-grok-rt-'));
  try {
    await ledger.migrate();
    await ledger.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    const owner = 'grok-runtime-owner', project = randomUUID();
    await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Grok runtime']);
    await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, owner]);
    const capacity = new Capacity(ledger);
    const claude = randomUUID(), grok = randomUUID();
    for (const [id, provider] of [[claude, 'claude'], [grok, 'grok']] as const) {
      await capacity.addAccount(owner, project, {id, provider, label: provider, resourceIdentity: `${provider}:${digest({id})}`, mode: 'subscription_cli',
        eligibility: 'documented_supported', eligibilitySource: 'https://example.invalid/fixture', maxConcurrent: 1});
    }
    const enabled = (await ledger.pool.query('SELECT provider FROM ac_accounts WHERE enabled ORDER BY provider')).rows.map(row => row.provider);
    assert.deepEqual(enabled, ['claude', 'grok']);
    const keyFile = join(area, 'execution.pem');
    await writeFile(keyFile, generateKeyPairSync('ed25519').privateKey.export({format: 'pem', type: 'pkcs8'}).toString(), {mode: 0o600});
    const image = 'sha256:' + '0'.repeat(64);
    const config = {project: {repo: join(area, 'repo')}, projects: [], nativeBootstrap: {state: 'active',
      accounts: [{accountId: claude, subjectDigest: digest({id: claude})}, {accountId: grok, subjectDigest: digest({id: grok})}],
      execution: {id: 'native-exec', workerImage: image, toolsImage: image, signingKeyFile: keyFile, hostRoot: join(area, 'host'),
        accountRoot: join(area, 'accounts'), providerNetworkId: 'd'.repeat(64)}}};
    const runtime = await composePersonalModuleExamRuntime(config as never, ledger);
    assert.deepEqual(runtime.map(seat => [seat.provider, [...seat.accountIds]]), [['claude', [claude]], ['grok', [grok]]]);
    // Restricted to the Grok account alone, the runtime still offers its seat.
    const onlyGrok = await composePersonalModuleExamRuntime(config as never, ledger, [grok]);
    assert.deepEqual(onlyGrok.map(seat => seat.provider), ['grok']);
  } finally {
    await ledger.pool.end(); await fixture.close(); await rm(area, {recursive: true, force: true});
  }
});
