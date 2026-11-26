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
  // Só o nome reservado ou o seu nome de serviço -build; variantes derivadas não contam como o modelo reservado.
  for (const variant of ['grok-4.7-mini', 'grok-4.7-fast', 'grok-4.7-build-mini', 'grok-4.70']) {
    assert.equal(read({...ok, modelUsage: {[variant]: {}}}).succeeded, false, variant);
  }
  assert.equal(read({...ok, modelUsage: {'grok-4.7': {}}}).succeeded, true);
  assert.equal(readModuleExamGrokOutput('não é json', 'grok-4.7').succeeded, false);
  const error = readModuleExamGrokOutput(JSON.stringify({type: 'error', message: 'Not signed in.'}), 'grok-4.7');
  assert.equal(error.succeeded, false);
  assert.deepEqual(error.errors, ['Not signed in.']);
});

test('o veredito do Grok vem do texto, com chaves únicas, e precisa bater com a saída estruturada', () => {
  const ok = {stopReason: 'end_turn', num_turns: 1, modelUsage: {'grok-4.7-build': {}}};
  const read = (value: object) => readModuleExamGrokOutput(JSON.stringify(value), 'grok-4.7');
  // Chave duplicada no texto: a saída estruturada guardaria só o último valor, e a ambiguidade é recusada.
  assert.equal(read({...ok, text: '{"status":"descartado","status":"confirmado"}', structuredOutput: {status: 'confirmado'}}).succeeded, false);
  // Texto e saída estruturada divergentes.
  assert.equal(read({...ok, text: '{"status":"descartado"}', structuredOutput: {status: 'confirmado'}}).succeeded, false);
  // Sem texto legível não há veredito, mesmo com a saída estruturada.
  assert.equal(read({...ok, structuredOutput: {status: 'confirmado'}}).succeeded, false);
  assert.equal(read({...ok, text: 'pronto: {"status":"confirmado"}', structuredOutput: {status: 'confirmado'}}).succeeded, false);
  const same = read({...ok, text: '{"status":"confirmado","proof":{"a":1}}', structuredOutput: {status: 'confirmado', proof: {a: 1}}});
  assert.equal(same.succeeded, true);
  assert.equal(same.output, '{"status":"confirmado","proof":{"a":1}}');
  assert.equal(read({...ok, text: '{"status":"confirmado"}'}).succeeded, true);
});

test('limite e login do Grok saem só do erro estruturado do CLI; o stderr fica para o diagnóstico', () => {
  const secret = 'segredo-do-login-123456';
  assert.deepEqual(resolveModuleExamGrokResult({succeeded: true, output: `{"proof":"${secret}"}`, errors: []}, [secret]).failureCode, null);
  assert.ok(!resolveModuleExamGrokResult({succeeded: true, output: `{"proof":"${secret}"}`, errors: []}, [secret]).output.includes(secret));
  const fail = (text: string) => resolveModuleExamGrokResult({succeeded: false, output: '', errors: [text]}, []).failureCode;
  assert.equal(fail('Error: 429 Too Many Requests'), 'PROVIDER_USAGE_LIMIT');
  assert.equal(fail('You have reached your usage limit'), 'PROVIDER_USAGE_LIMIT');
  assert.equal(fail('Not signed in. To authenticate without a browser, run: grok login --device-code'), 'PROVIDER_AUTH_FAILED');
  // Palavras soltas não são cota.
  assert.equal(fail('quota project header ignored'), 'MODULE_EXAM_PROVIDER_FAILED');
  assert.equal(fail('request id 4290017 failed'), 'MODULE_EXAM_PROVIDER_FAILED');
  // Um "cancelled" com um log de stderr que fala em 429 ou quota continua falha comum, não parada por cota.
  const cancelled = readModuleExamGrokOutput(JSON.stringify({stopReason: 'cancelled', num_turns: 1, text: '', modelUsage: {'grok-4.7-build': {}}}), 'grok-4.7');
  const withLog = {...cancelled, diagnostics: [...cancelled.diagnostics, 'telemetry: 429 quota exceeded for api.mixpanel.com']};
  assert.equal(resolveModuleExamGrokResult(withLog, []).failureCode, 'MODULE_EXAM_PROVIDER_FAILED');
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

    // Assento tirado pelo exame (login vencido, falhas repetidas, cota): por provedor ou pela conta, a reserva não o oferece de novo.
    for (const skip of [[{provider: 'grok'}], [{provider: 'grok', accountId: grok}]]) {
      await assert.rejects(() => reservations.reserve('reviewer', examiner, {source: 'coletor', severity: 'media', fromExaminer: false, skip}),
        (error: unknown) => error instanceof Refusal && error.code === 'MODULE_EXAM_REVIEWER_UNAVAILABLE');
    }
    const otherAccount = await reservations.reserve('reviewer', examiner, {source: 'coletor', severity: 'media', fromExaminer: false,
      skip: [{provider: 'grok', accountId: randomUUID()}]});
    assert.equal(otherAccount.accountId, grok);
    await reservations.release(otherAccount, 'not_started');
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

      // Uma leitura só, privada: um auth.json que é link (ou aberto ao grupo) é recusado antes de qualquer contêiner.
      const {symlink, rename: move} = await import('node:fs/promises');
      const before = mutations.length;
      await move(join(grokHome, 'auth.json'), join(grokHome, 'real.json'));
      await symlink(join(grokHome, 'real.json'), join(grokHome, 'auth.json'));
      { const g = await grant(); await assert.rejects(() => supervisor.start(owner, authority, request(g))); }
      await rm(join(grokHome, 'auth.json'));
      await move(join(grokHome, 'real.json'), join(grokHome, 'auth.json'));
      await chmod(join(grokHome, 'auth.json'), 0o640);
      { const g = await grant(); await assert.rejects(() => supervisor.start(owner, authority, request(g))); }
      assert.equal(mutations.length, before);
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
    // Like the real reservation, a skipped provider is never offered again; with no other provider the lane has no seat.
    reserve: async (purpose, _avoid, target) => {
      if (purpose === 'examiner') return examiner;
      if (target?.skip?.some(entry => entry.provider === 'grok')) throw new Refusal('MODULE_EXAM_REVIEWER_UNAVAILABLE');
      reviewerSeats++; return seat('grok');
    },
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

test('o executor do Grok usa só o login conferido, HOME privado apagado depois, pasta vazia, pedido em arquivo e env mínimo', async () => {
  const {createHash} = await import('node:crypto');
  const {readFile, readdir, stat, chmod: chmodFile} = await import('node:fs/promises');
  const {runModuleExamGrok} = await import('../src/module-exam-worker.ts');
  const area = await mkdtemp(join(tmpdir(), 'ac-grok-exec-'));
  const saved = {HTTPS_PROXY: process.env.HTTPS_PROXY, SEGREDO_DO_HOST: process.env.SEGREDO_DO_HOST};
  try {
    const accountRoot = join(area, 'account'), tmpRoot = join(area, 'tmp'), record = join(area, 'record.json'), mode = join(area, 'mode');
    await mkdir(join(accountRoot, '.grok'), {recursive: true, mode: 0o700});
    await mkdir(tmpRoot, {mode: 0o700});
    const login = (expiresAt: number) => JSON.stringify({'https://auth.x.ai::id': {key: 'chave-sintetica-do-grok-0002',
      refresh_token: 'renovacao-sintetica-0002', expires_at: new Date(expiresAt).toISOString()}});
    const writeLogin = async (body: string) => { await writeFile(join(accountRoot, '.grok', 'auth.json'), body, {mode: 0o600}); return createHash('sha256').update(body).digest('hex'); };
    const fresh = login(Date.now() + 6 * 3600_000);
    const freshDigest = await writeLogin(fresh);
    const bin = join(area, 'grok');
    await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), at = flag => args[args.indexOf(flag) + 1];
const home = process.env.HOME, auth = path.join(home, '.grok', 'auth.json');
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({args, env: process.env, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()),
  prompt: fs.readFileSync(at('--prompt-file'), 'utf8'), auth: fs.readFileSync(auth, 'utf8'), authMode: fs.statSync(auth).mode & 0o777, home}));
const mode = fs.readFileSync(${JSON.stringify(mode)}, 'utf8');
if (mode === 'sleep') setTimeout(() => {}, 60000);
else if (mode === 'flood') process.stdout.write('x'.repeat(300000));
else {
  process.stdout.write(JSON.stringify({text: '{"kind":"confirmacao"}', stopReason: 'end_turn', num_turns: 1, structuredOutput: {kind: 'confirmacao'},
    modelUsage: {'grok-4.7-build': {}}}));
  process.exitCode = mode === 'exit1' ? 1 : 0;
}
`, {mode: 0o700});
    process.env.HTTPS_PROXY = 'http://127.0.0.1:19493';
    process.env.SEGREDO_DO_HOST = 'nao-deve-chegar-ao-grok';
    const paths = {bin, accountRoot, tmpRoot};
    const input = {model: 'grok-4.7', effort: 'medium' as const, task: 'PEDIDO-SINTETICO', timeoutMs: 120_000, moduleExamLoginDigest: freshDigest};
    const run = async (which: string, overrides: Partial<typeof input> = {}, signal = new AbortController().signal) => {
      await writeFile(mode, which);
      await rm(record, {force: true});
      return runModuleExamGrok({...input, ...overrides}, signal, paths);
    };

    const ok = await run('ok');
    assert.equal(ok.response.succeeded, true);
    assert.equal(ok.response.output, '{"kind":"confirmacao"}');
    assert.ok(ok.secrets.includes('chave-sintetica-do-grok-0002') && ok.secrets.includes('renovacao-sintetica-0002'));
    const seen = JSON.parse(await readFile(record, 'utf8'));
    assert.equal(seen.args[seen.args.indexOf('--tools') + 1], '');
    assert.ok(!seen.args.includes('-p') && !seen.args.includes(input.task));
    assert.equal(seen.prompt, MODULE_EXAM_GROK_PREAMBLE + 'PEDIDO-SINTETICO');
    assert.deepEqual(Object.keys(seen.env).sort(), ['HOME', 'HTTPS_PROXY', 'NO_COLOR', 'PATH']);
    assert.equal(seen.env.HTTPS_PROXY, 'http://127.0.0.1:19493');
    assert.ok(seen.home.startsWith(tmpRoot + '/') && seen.cwd.startsWith(tmpRoot + '/') && seen.cwd !== seen.home);
    assert.equal(seen.args[seen.args.indexOf('--cwd') + 1], seen.cwd);
    assert.deepEqual(seen.cwdEntries, []);
    assert.equal(seen.auth, fresh);
    assert.equal(seen.authMode, 0o600);
    // O HOME privado e a pasta vazia somem; o login montado fica intacto.
    assert.deepEqual(await readdir(tmpRoot), []);
    assert.equal(await readFile(join(accountRoot, '.grok', 'auth.json'), 'utf8'), fresh);
    assert.equal((await stat(join(accountRoot, '.grok', 'auth.json'))).mode & 0o777, 0o600);

    // Saída válida com status diferente de zero, saída acima do limite: falha.
    assert.equal((await run('exit1')).response.succeeded, false);
    const flooded = await run('flood');
    assert.equal(flooded.response.succeeded, false);
    assert.deepEqual(await readdir(tmpRoot), []);
    // Interrupção pelo sinal.
    const abort = new AbortController();
    const pending = run('sleep', {}, abort.signal);
    for (let i = 0; i < 200; i++) { try { await stat(record); break; } catch { await new Promise(resolve => setTimeout(resolve, 25)); } }
    abort.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof Refusal && error.code === 'MODULE_EXAM_INTERRUPTED');
    assert.deepEqual(await readdir(tmpRoot), []);

    // Login diferente do que o supervisor conferiu, ou sem digest no lançamento: recusa sem rodar o CLI.
    await assert.rejects(run('ok', {moduleExamLoginDigest: 'a'.repeat(64)}), (error: unknown) => error instanceof Refusal && error.code === 'EXAM_LOGIN_STALE');
    await assert.rejects(run('ok', {moduleExamLoginDigest: undefined}), (error: unknown) => error instanceof Refusal && error.code === 'EXAM_LOGIN_STALE');
    // Login que vence durante o exame.
    const staleDigest = await writeLogin(login(Date.now() + 60_000));
    await assert.rejects(run('ok', {moduleExamLoginDigest: staleDigest}), (error: unknown) => error instanceof Refusal && error.code === 'EXAM_LOGIN_STALE');
    await assert.rejects(stat(record));
    // Arquivo de login aberto para o grupo: a leitura privada recusa.
    await writeLogin(fresh);
    await chmodFile(join(accountRoot, '.grok', 'auth.json'), 0o640);
    await assert.rejects(run('ok'), /INVALID_WORKER_PRIVATE_FILE/);
    await assert.rejects(stat(record));
    assert.deepEqual(await readdir(tmpRoot), []);
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(area, {recursive: true, force: true});
  }
});

// Review (low): stops by seat. Grok and Codex are both distinct reviewers; what takes out Grok must not take out Codex.
async function standardQueue(grokFailure: (n: number) => Error | null, options: {files?: number} = {}) {
  const {examineFunctionalModule, examJobExited} = await import('../src/module-exam.ts');
  const {qaStaticFinding} = await import('./fixtures/module-exam-review.ts');
  const {reviewFixtureVerdict} = await import('./fixtures/module-exam-review.ts');
  const skipped = (n: number) => `test.skip("caso ${n}", () => {})`;
  const files = Array.from({length: options.files ?? 6}, (_, f) => ({file: `src/s${f}.test.ts`, reason: null, code: skipped(f) + ';\n'}));
  const findings = files.map(({file}, f) => qaStaticFinding(file, 1, skipped(f) + ';'));
  const seat = (provider: string, accountId = randomUUID()) => ({provider, model: provider === 'grok' ? 'grok-4.6' : provider === 'codex' ? 'gpt-6.2-sol' : 'claude-sonnet-5-5', accountId, profileId: randomUUID(), grantId: randomUUID()});
  const examiner = seat('claude');
  const grokAccount = randomUUID();
  const calls = {grok: 0, codex: 0};
  const result = await examineFunctionalModule({module: 'qa', intentId: randomUUID(), commit: 'a'.repeat(40), map: {files, routes: []}, findings,
    reviewTriage: false,
    // Grok first, as moduleExamProviders orders the distinct reviewers; Codex once Grok is skipped.
    reserve: async (purpose, _avoid, target) => {
      if (purpose === 'examiner') return examiner;
      const grokSkipped = target?.skip?.some(entry => entry.provider === 'grok' && (!entry.accountId || entry.accountId === grokAccount));
      return grokSkipped ? seat('codex') : seat('grok', grokAccount);
    },
    release: async () => {},
    worker: {async run(call) {
      const task = JSON.parse(call.task);
      if (task.checklist) return JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: ['qa'], routesReviewed: [], findings: []});
      const verdict = () => JSON.stringify(reviewFixtureVerdict(task, skipped(Number(/s(\d+)\.test/.exec(task.file)![1])) + ';'));
      if (call.provider === 'grok') { const error = grokFailure(++calls.grok); if (error) throw examJobExited(error); return verdict(); }
      calls.codex++;
      return verdict();
    }}});
  return {result, calls};
}

test('login do Grok vencido tira só o Grok da fila comum: o Codex segue revisando', async () => {
  const {result, calls} = await standardQueue(() => new Refusal('EXAM_LOGIN_STALE'));
  assert.equal(calls.grok, 1);
  assert.equal(calls.codex, 5);
  assert.equal(result.findings.filter(finding => finding.failure === 'EXAM_LOGIN_STALE').length, 1);
  assert.ok(result.findings.slice(1).every(finding => finding.failure === null), JSON.stringify(result.findings.map(f => f.failure)));
});

test('falhas repetidas MODULE_EXAM_PROVIDER_FAILED do mesmo assento tiram esse assento depois do limite', async () => {
  const {MODULE_EXAM_SEAT_FAILURE_LIMIT} = await import('../src/module-exam.ts');
  const {result, calls} = await standardQueue(() => new Refusal('MODULE_EXAM_PROVIDER_FAILED'));
  assert.equal(calls.grok, MODULE_EXAM_SEAT_FAILURE_LIMIT);
  assert.equal(calls.codex, 6 - MODULE_EXAM_SEAT_FAILURE_LIMIT);
  assert.equal(result.findings.filter(finding => finding.failure === 'MODULE_EXAM_PROVIDER_FAILED').length, MODULE_EXAM_SEAT_FAILURE_LIMIT);
});

test('falhas do Grok alternadas com sucesso não tiram o assento: o contador zera no sucesso', async () => {
  const {result, calls} = await standardQueue(n => n % 2 ? new Refusal('MODULE_EXAM_PROVIDER_FAILED') : null);
  assert.equal(calls.grok, 6);
  assert.equal(calls.codex, 0);
  assert.equal(result.findings.filter(finding => finding.failure === null).length, 3);
});

test('cota do Grok tira só o Grok: a fila comum segue no Codex e nada para o exame', async () => {
  const {result, calls} = await standardQueue(() => new Refusal('PROVIDER_USAGE_LIMIT'));
  assert.equal(calls.grok, 1);
  assert.equal(calls.codex, 5);
  assert.equal(result.findings[0]!.failure, 'PROVIDER_USAGE_LIMIT');
});

// Review (low, pre-existing): a Grok quota filled stopReview and stopped the high lane too, which reviews with Claude Opus.
test('cota do Grok na fila comum não para a revisão alta pelo Opus', async () => {
  const {examineFunctionalModule, examJobExited} = await import('../src/module-exam.ts');
  const {qaStaticFinding, reviewFixtureVerdict, skipQuestion} = await import('./fixtures/module-exam-review.ts');
  const skipped = (n: number) => `test.skip("caso ${n}", () => {})`;
  const files = [0, 1].map(f => ({file: `src/h${f}.test.ts`, reason: null, code: skipped(f) + ';\n'}));
  const account = randomUUID();
  const examiner = {provider: 'claude', model: 'claude-sonnet-5-5', accountId: account, profileId: randomUUID(), grantId: randomUUID()};
  const opus = {provider: 'claude', model: 'claude-opus-5-5', accountId: account, profileId: randomUUID(), grantId: randomUUID()};
  const grok = {provider: 'grok', model: 'grok-4.6', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()};
  const sessions = {examiner: randomUUID(), reviewer: randomUUID()};
  let grokCalls = 0;
  const result = await examineFunctionalModule({module: 'qa', intentId: randomUUID(), commit: 'a'.repeat(40), map: {files, routes: []},
    findings: [qaStaticFinding(files[0]!.file, 1, skipped(0) + ';')], reviewTriage: false,
    reserve: async (purpose, _avoid, target) => purpose === 'examiner' ? examiner : target?.fromExaminer && target.severity === 'alta' ? opus : grok,
    release: async () => {},
    attestSessions: async () => true,
    worker: {async run(call) {
      const task = JSON.parse(call.task);
      (call as {examSessionId?: string}).examSessionId = task.checklist ? sessions.examiner : sessions.reviewer;
      if (task.checklist) return JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: ['qa'], routesReviewed: [],
        findings: task.file === files[1]!.file ? [{line: 1, snippet: skipped(1), hypothesis: skipQuestion, title: 'Alto', severity: 'alta'}] : []});
      if (call.provider === 'grok') { grokCalls++; throw examJobExited(new Refusal('PROVIDER_USAGE_LIMIT')); }
      return JSON.stringify(reviewFixtureVerdict(task, skipped(1)));
    }}});
  assert.equal(grokCalls, 1);
  const high = result.findings.find(finding => finding.severity === 'alta')!;
  assert.equal(high.failure, null, JSON.stringify(result.findings.map(f => [f.severity, f.failure])));
  assert.equal(high.status, 'confirmado');
  assert.equal(high.verifier?.model, 'claude-opus-5-5');
  assert.equal(result.findings.find(finding => finding.file === files[0]!.file)!.failure, 'PROVIDER_USAGE_LIMIT');
});
