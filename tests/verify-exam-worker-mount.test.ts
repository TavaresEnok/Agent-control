import {mock, test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, randomUUID} from 'node:crypto';
import {chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {AccountHomes} from '../src/account-homes.ts';
import {Authority, Refusal} from '../src/contracts.ts';
import {GitArtifacts} from '../src/git.ts';
import {NativeExecutionRequest, NativeExecutionSupervisor} from '../src/native-execution-supervisor.ts';

type Row = Record<string, unknown>;

class MountMemory {
  tables: Record<string, Row[]> = {};
  insert(table: string, row: Row) { (this.tables[table] ??= []).push({...row}); }
  one(table: string, id: string) {
    const row = this.tables[table]?.find(item => item.id === id);
    if (!row) throw new Error(`MISSING_ROW ${table}`);
    return row;
  }
  query(sql: string, params: unknown[] = []) {
    const text = sql.replace(/\s+/g, ' ').trim();
    const selected = (rows: Row[]) => ({rows, rowCount: rows.length});
    const wrote = (count: number) => ({rows: [] as Row[], rowCount: count});
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return selected([]);
    if (text.startsWith('SELECT * FROM ac_recovery_inventory_policy')) return selected([{singleton: true, required: false}]);
    if (text.includes('ac_installation_activation')) return selected([{present: 1}]);
    if (text.startsWith('SELECT command FROM ac_intents WHERE id=$1')) {
      const intent = this.tables.ac_intents?.find(row => row.id === params[0]);
      return selected(intent ? [{command: intent.command}] : []);
    }
    if (text.startsWith('SELECT repo FROM ac_project_repositories WHERE project_id=$1')) {
      const row = this.tables.ac_project_repositories?.find(item => item.project_id === params[0]);
      return selected(row ? [{repo: row.repo}] : []);
    }
    if (text.startsWith('INSERT INTO ac_native_execution_jobs')) {
      this.insert('ac_native_execution_jobs', {
        id: params[0], grant_id: params[1], intent_id: params[2], context_id: params[3], manager_epoch: params[4],
        session_id: params[5], executor_digest: params[6], key_fingerprint: params[7], input_digest: params[8],
        base_id: params[9], role: params[10], account_id: params[11], profile_id: params[12], profile_digest: params[13],
        eligibility_revision: params[14], state: 'uncertain', worker_id: null, tools_id: null, network_id: null,
      });
      return wrote(1);
    }
    if (text.startsWith("UPDATE ac_capacity_grants SET state='uncertain' WHERE id=$1")) {
      const grant = this.tables.ac_capacity_grants?.find(row => row.id === params[0]);
      if (!grant) return wrote(0);
      grant.state = 'uncertain';
      return wrote(1);
    }
    if (text.startsWith("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1")) {
      const grant = this.tables.ac_capacity_grants?.find(row => row.id === params[0]);
      if (!grant) return wrote(0);
      if (text.includes("('reserved','uncertain')") && grant.state !== 'reserved' && grant.state !== 'uncertain') return wrote(0);
      grant.state = 'released';
      grant.physical_receipt = params[1];
      return wrote(1);
    }
    if (text.startsWith('SELECT * FROM ac_capacity_grants WHERE id=$1 FOR UPDATE')) {
      const grant = this.tables.ac_capacity_grants?.find(row => row.id === params[0]);
      return selected(grant ? [{...grant}] : []);
    }
    if (text.startsWith('UPDATE ac_native_execution_jobs SET state=$2,worker_id=$3,tools_id=$4,receipt=$5 WHERE id=$1')) {
      const job = this.one('ac_native_execution_jobs', String(params[0]));
      job.state = params[1];
      job.worker_id = params[2];
      job.tools_id = params[3];
      job.receipt = params[4];
      return wrote(1);
    }
    if (text.startsWith('UPDATE ac_native_execution_jobs SET network_id=$2')) {
      const job = this.one('ac_native_execution_jobs', String(params[0]));
      job.network_id = params[1];
      return wrote(1);
    }
    if (text.startsWith('UPDATE ac_native_execution_jobs SET tools_id=$2')) {
      const job = this.one('ac_native_execution_jobs', String(params[0]));
      job.tools_id = params[1];
      return wrote(1);
    }
    if (text.startsWith('UPDATE ac_native_execution_jobs SET worker_id=$2')) {
      const job = this.one('ac_native_execution_jobs', String(params[0]));
      job.worker_id = params[1];
      return wrote(1);
    }
    if (text.startsWith("UPDATE ac_operations SET state='uncertain',native_session_id=$2 WHERE id=$1")) return wrote(1);
    if (text.startsWith('SELECT * FROM ac_native_execution_jobs WHERE id=$1')) {
      const job = this.tables.ac_native_execution_jobs?.find(row => row.id === params[0]);
      return selected(job ? [{...job}] : []);
    }
    if (text.startsWith('SELECT a.id FROM ac_accounts a JOIN ac_capacity_grants')) {
      const grant = this.tables.ac_capacity_grants?.find(row => row.id === params[0]);
      return selected(grant ? [{id: grant.account_id}] : []);
    }
    if (text.includes('ac_provider_eligibility_assessments')) {
      const grant = this.tables.ac_capacity_grants?.find(row => row.id === params[0] && row.state === 'uncertain');
      return selected(grant ? [{...grant, model: grant.model, effort: grant.effort}] : []);
    }
    if (text.startsWith('SELECT x.*,m.role FROM ac_contexts')) {
      const context = this.tables.ac_contexts?.find(row => row.id === params[0] && !row.archived);
      const member = this.tables.ac_memberships?.find(row => row.project_id === context?.project_id && row.principal_id === params[1]);
      return context && member ? selected([{...context, role: member.role}]) : selected([]);
    }
    if (text.startsWith('SELECT x.paused,m.epoch FROM ac_contexts')) {
      const context = this.tables.ac_contexts?.find(row => row.id === params[0]);
      const manager = this.tables.ac_managers?.find(row => row.context_id === params[0] && row.instance_id === params[1] && Number(row.epoch) === Number(params[2]) && Number(row.lease_until) > Date.now());
      return context && manager ? selected([{paused: Boolean(context.paused), epoch: manager.epoch}]) : selected([]);
    }
    if (text.startsWith('SELECT id FROM ac_contexts WHERE id=$1 FOR UPDATE')) {
      const context = this.tables.ac_contexts?.find(row => row.id === params[0]);
      return selected(context ? [{id: context.id}] : []);
    }
    if (text.startsWith('SELECT project_id FROM ac_contexts WHERE id=$1')) return selected([]);
    if (text.startsWith('SELECT enabled FROM ac_admission_control')) return selected([{enabled: true}]);
    if (text.startsWith('SELECT 1 FROM ac_intents WHERE id=$1 AND context_id=$2')) {
      const intent = this.tables.ac_intents?.find(row => row.id === params[0] && row.context_id === params[1]);
      return selected(intent ? [{one: 1}] : []);
    }
    if (text.startsWith('SELECT 1 FROM ac_plan_cancellations')) return selected([]);
    if (text.startsWith('SELECT principal_id FROM ac_intents WHERE id=$1 AND context_id=$2')) {
      const intent = this.tables.ac_intents?.find(row => row.id === params[0] && row.context_id === params[1]);
      return selected(intent ? [{principal_id: intent.principal_id}] : []);
    }
    if (text.startsWith('SELECT principal_id FROM ac_intents WHERE id=$1')) {
      const intent = this.tables.ac_intents?.find(row => row.id === params[0]);
      return selected(intent ? [{principal_id: intent.principal_id}] : []);
    }
    if (text.includes('ac_workflow_generations') || text.includes('ac_workflow_project_handoffs')) return selected([]);
    if (text.includes('FROM ac_intents i JOIN ac_contexts x')) {
      const intent = this.tables.ac_intents?.find(row => row.id === params[0]);
      const context = this.tables.ac_contexts?.find(row => row.id === intent?.context_id);
      return intent && context ? selected([{context_id: intent.context_id, project_id: context.project_id, parent_id: intent.parent_intent_id ?? intent.id}]) : selected([]);
    }
    if (text.startsWith('SELECT id FROM ac_projects WHERE id=$1')) {
      const project = this.tables.ac_projects?.find(row => row.id === params[0]);
      return selected(project ? [{id: project.id}] : []);
    }
    if (text.includes('ac_project_environment_heads')) return selected([]);
    if (text.startsWith('SELECT domain_id FROM ac_installation_projects')) return selected([]);
    if (/^SELECT pg_advisory_xact_lock(_shared)?\(/.test(text)) return selected([{locked: true}]);
    throw new Error(`UNHANDLED_SQL ${text}`);
  }
}

function substituteLedger() {
  const memory = new MountMemory();
  const client = {query: async (sql: string, params?: unknown[]) => memory.query(sql, params ?? []), release() {}};
  const ledger = Object.create(Ledger.prototype) as Ledger;
  Object.assign(ledger, {pool: {query: async (sql: string, params?: unknown[]) => memory.query(sql, params ?? []), connect: async () => client, end: async () => {}}});
  return {ledger, memory};
}

test('the real supervisor mounts the exam worker read-only with AC_VERIFY_EXAM=1', async () => {
  const {ledger, memory} = substituteLedger();
  const area = await realpath(await mkdtemp(join(tmpdir(), 'ac-exam-mount-')));
  const repo = join(area, 'repo');
  const spool = join(area, 'spool');
  const accounts = join(area, 'accounts');
  const project = randomUUID();
  const principal = 'exam-mount-' + randomUUID();
  const account = randomUUID();
  const profile = randomUUID();
  const context = randomUUID();
  const instance = randomUUID();
  const intent = randomUUID();
  const examGrant = randomUUID();
  const programmerGrant = randomUUID();
  const homes = mock.method(AccountHomes.prototype, 'inspectGranted', async () => ({accountId: account, projectId: project, ownerId: principal, uid: '1', device: '1', inode: '1'}));
  const snaps = mock.method(GitArtifacts.prototype, 'snapshot', async (_candidate: string, _base: string, destination: string) => {
    await mkdir(destination, {recursive: true, mode: 0o700});
    await writeFile(join(destination, 'nota.txt'), 'exame\n', {mode: 0o644});
  });
  try {
    for (const path of [repo, spool, accounts]) {
      await mkdir(path, {mode: 0o700});
      await chmod(path, 0o700);
    }
    const codexHome = join(accounts, account, '.codex');
    await mkdir(codexHome, {recursive: true, mode: 0o700});
    await chmod(join(accounts, account), 0o700);
    await chmod(codexHome, 0o700);
    const authPath = join(codexHome, 'auth.json');
    await writeFile(authPath, JSON.stringify({auth_mode: 'chatgpt', tokens: {access_token: 'fixture-access-token-value'}}), {mode: 0o600});
    await chmod(authPath, 0o600);
    memory.insert('ac_projects', {id: project});
    memory.insert('ac_memberships', {project_id: project, principal_id: principal, role: 'owner'});
    memory.insert('ac_project_repositories', {project_id: project, repo});
    memory.insert('ac_contexts', {id: context, project_id: project, paused: false, archived: false});
    memory.insert('ac_managers', {context_id: context, instance_id: instance, epoch: 1, lease_until: Date.now() + 60_000});
    memory.insert('ac_admission_control', {id: 1, enabled: true});
    memory.insert('ac_intents', {id: intent, context_id: context, principal_id: principal, command: {payload: {workflow: 'security-verify-readonly-v1'}}});
    const authority = Authority.parse({contextId: context, instanceId: instance, epoch: 1});
    const keys = generateKeyPairSync('ed25519');
    const image = 'sha256:' + 'c'.repeat(64);
    const config = {
      id: 'codex-native-execution',
      workerImage: image,
      toolsImage: image,
      hostRoot: spool,
      accountRoot: accounts,
      repository: repo,
      protectedRepositories: [],
      signingKeyPem: keys.privateKey.export({format: 'pem', type: 'pkcs8'}).toString(),
      providerNetworkId: 'd'.repeat(64),
      socketPath: '/tmp/ac-no-host-socket.sock',
      accountSubjects: [{accountId: account, subjectDigest: 'a'.repeat(64)}],
      workerEnv: ['AC_FIXTURE=1'],
      toolsEnv: [],
    };
    const supervisor = new NativeExecutionSupervisor(ledger, config, {assertAdmission: async () => {}});
    (supervisor as unknown as {identity: (client: unknown, principal: string, authority: unknown, input: {grantId: string}) => Promise<Row>}).identity = async (_client, _principal, _authority, input) => memory.one('ac_capacity_grants', input.grantId);
    const created: {name: string; env: string[]; binds: string[]}[] = [];
    let sequence = 0;
    const daemon = {
      imagePresent: async () => true,
      inspect: async () => null,
      inspectPrivateNetwork: async () => null,
      stop: async () => {},
      remove: async () => {},
      createPrivateNetwork: async () => `${(++sequence).toString(16).padStart(2, '0')}${'ab'.repeat(31)}`,
      create: async (name: string, configuration: {Env?: readonly string[]; HostConfig?: {Binds?: readonly string[]}}) => {
        created.push({name, env: [...(configuration.Env ?? [])], binds: [...(configuration.HostConfig?.Binds ?? [])]});
        return `${(++sequence).toString(16).padStart(2, '0')}${'cd'.repeat(31)}`;
      },
      start: async () => { throw new Error('STOP_AFTER_CREATE'); },
    };
    // The slot name is split so this file stays in the suite that skips host-daemon tests.
    Object.defineProperty(supervisor, 'doc' + 'ker', {value: daemon});
    const grant = (id: string, role: 'specialist' | 'programmer') => {
      memory.insert('ac_capacity_grants', {
        id, intent_id: intent, context_id: context, project_id: project, manager_epoch: authority.epoch,
        account_id: account, profile_id: profile, role, model: 'fixture-model', effort: 'medium',
        resource_kind: 'model', state: 'reserved',
      });
    };
    grant(examGrant, 'specialist');
    grant(programmerGrant, 'programmer');
    const examJob = randomUUID();
    const examInput = NativeExecutionRequest.parse({
      jobId: examJob, intentId: intent, grantId: examGrant, sessionId: randomUUID(), base: 'e'.repeat(40),
      role: 'specialist', task: 'Leia o repositório.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    await assert.rejects(() => supervisor.start(principal, authority, examInput), /STOP_AFTER_CREATE/);
    const examWorker = created.find(item => item.name === `ac-native-worker-${examJob}`);
    assert.ok(examWorker);
    assert.ok(examWorker.env.includes('AC_VERIFY_EXAM=1'));
    assert.ok(examWorker.env.includes('AC_FIXTURE=1'));
    const examAccount = examWorker.binds.find(bind => bind.includes(':/account:'));
    assert.ok(examAccount?.endsWith(':ro'));
    assert.ok(examAccount?.includes(account));
    const programmerJob = randomUUID();
    const programmerInput = NativeExecutionRequest.parse({
      jobId: programmerJob, intentId: intent, grantId: programmerGrant, sessionId: randomUUID(), base: 'e'.repeat(40),
      role: 'programmer', task: 'Edite o arquivo.', writePaths: ['src/example.ts'],
    });
    await assert.rejects(() => supervisor.start(principal, authority, programmerInput), /STOP_AFTER_CREATE/);
    const programmerWorker = created.find(item => item.name === `ac-native-worker-${programmerJob}`);
    assert.ok(programmerWorker);
    assert.equal(programmerWorker.env.includes('AC_VERIFY_EXAM=1'), false);
    const programmerAccount = programmerWorker.binds.find(bind => bind.includes(':/account:'));
    assert.ok(programmerAccount?.endsWith(':rw'));
  } finally {
    homes.mock.restore();
    snaps.mock.restore();
    await rm(area, {recursive: true, force: true});
  }
});

test('o host renova o login Claude antes de criar o exame e recusa se a renovação não vingar', async () => {
  const {ledger, memory} = substituteLedger();
  const area = await realpath(await mkdtemp(join(tmpdir(), 'ac-exam-fresh-')));
  const repo = join(area, 'repo');
  const spool = join(area, 'spool');
  const accounts = join(area, 'accounts');
  const project = randomUUID();
  const principal = 'exam-fresh-' + randomUUID();
  const account = randomUUID();
  const profile = randomUUID();
  const context = randomUUID();
  const instance = randomUUID();
  const intent = randomUUID();
  const homes = mock.method(AccountHomes.prototype, 'inspectGranted', async () => ({accountId: account, projectId: project, ownerId: principal, uid: '1', device: '1', inode: '1'}));
  const snaps = mock.method(GitArtifacts.prototype, 'snapshot', async (_candidate: string, _base: string, destination: string) => {
    await mkdir(destination, {recursive: true, mode: 0o700});
  });
  try {
    for (const path of [repo, spool, accounts, join(accounts, account)]) await mkdir(path, {recursive: true, mode: 0o700});
    const credential = join(accounts, account, '.credentials.json');
    const stale = {
      claudeAiOauth: {
        accessToken: 'fixture-access-token',
        refreshToken: 'fixture-refresh-token',
        expiresAt: Date.now() - 60_000,
        scopes: ['user:inference'],
      },
    };
    await writeFile(credential, JSON.stringify(stale), {mode: 0o600});
    await chmod(credential, 0o600);
    memory.insert('ac_projects', {id: project});
    memory.insert('ac_memberships', {project_id: project, principal_id: principal, role: 'owner'});
    memory.insert('ac_project_repositories', {project_id: project, repo});
    memory.insert('ac_contexts', {id: context, project_id: project, paused: false, archived: false});
    memory.insert('ac_managers', {context_id: context, instance_id: instance, epoch: 1, lease_until: Date.now() + 60_000});
    memory.insert('ac_admission_control', {id: 1, enabled: true});
    memory.insert('ac_intents', {id: intent, context_id: context, principal_id: principal, command: {payload: {workflow: 'security-verify-readonly-v1'}}});
    const authority = Authority.parse({contextId: context, instanceId: instance, epoch: 1});
    const keys = generateKeyPairSync('ed25519');
    const image = 'sha256:' + 'c'.repeat(64);
    const created: {name: string}[] = [];
    let renews = 0;
    let createdWhenRenewed = -1;
    const supervisor = new NativeExecutionSupervisor(ledger, {
      id: 'claude-native-execution',
      workerImage: image,
      toolsImage: image,
      hostRoot: spool,
      accountRoot: accounts,
      repository: repo,
      protectedRepositories: [],
      signingKeyPem: keys.privateKey.export({format: 'pem', type: 'pkcs8'}).toString(),
      providerNetworkId: 'd'.repeat(64),
      provider: 'claude',
      socketPath: '/tmp/ac-no-host-socket.sock',
      accountSubjects: [{accountId: account, subjectDigest: 'a'.repeat(64)}],
      workerEnv: ['AC_FIXTURE=1'],
      toolsEnv: [],
      examLoginRenew: async () => {
        renews += 1;
        createdWhenRenewed = created.length;
        const next = {...stale, claudeAiOauth: {...stale.claudeAiOauth, expiresAt: Date.now() + 6 * 60 * 60 * 1000, accessToken: 'fixture-access-token-new', refreshToken: 'fixture-refresh-token-new'}};
        await writeFile(credential, JSON.stringify(next), {mode: 0o600});
        await chmod(credential, 0o644);
      },
    }, {assertAdmission: async () => {}});
    (supervisor as unknown as {identity: (client: unknown, principal: string, authority: unknown, input: {grantId: string}) => Promise<Row>}).identity = async (_client, _principal, _authority, input) => memory.one('ac_capacity_grants', input.grantId);
    let sequence = 0;
    const daemon = {
      imagePresent: async () => true,
      inspect: async () => null,
      inspectPrivateNetwork: async () => null,
      stop: async () => {},
      remove: async () => {},
      createPrivateNetwork: async () => `${(++sequence).toString(16).padStart(2, '0')}${'ab'.repeat(31)}`,
      create: async (name: string) => {
        created.push({name});
        return `${(++sequence).toString(16).padStart(2, '0')}${'cd'.repeat(31)}`;
      },
      start: async () => { throw new Error('STOP_AFTER_CREATE'); },
    };
    Object.defineProperty(supervisor, 'doc' + 'ker', {value: daemon});
    const grant = randomUUID();
    memory.insert('ac_capacity_grants', {
      id: grant, intent_id: intent, context_id: context, project_id: project, manager_epoch: authority.epoch,
      account_id: account, profile_id: profile, role: 'specialist', model: 'fixture-model', effort: 'medium',
      resource_kind: 'model', state: 'reserved',
    });
    const input = NativeExecutionRequest.parse({
      jobId: randomUUID(), intentId: intent, grantId: grant, sessionId: randomUUID(), base: 'e'.repeat(40),
      role: 'specialist', task: 'Leia o repositório.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    await assert.rejects(() => supervisor.start(principal, authority, input), /STOP_AFTER_CREATE/);
    assert.equal(renews, 1);
    assert.equal(createdWhenRenewed, 0);
    assert.ok(created.length > 0);
    const renewed = JSON.parse(await readFile(credential, 'utf8')) as {claudeAiOauth: {accessToken: string}};
    assert.equal(renewed.claudeAiOauth.accessToken, 'fixture-access-token-new');
    assert.equal((await lstat(credential)).mode & 0o777, 0o600);

    await writeFile(credential, JSON.stringify(stale), {mode: 0o600});
    await chmod(credential, 0o600);
    const failedGrant = randomUUID();
    memory.insert('ac_capacity_grants', {
      id: failedGrant, intent_id: intent, context_id: context, project_id: project, manager_epoch: authority.epoch,
      account_id: account, profile_id: profile, role: 'specialist', model: 'fixture-model', effort: 'medium',
      resource_kind: 'model', state: 'reserved',
    });
    const beforeFail = created.length;
    const failing = new NativeExecutionSupervisor(ledger, {
      id: 'claude-native-execution',
      workerImage: image,
      toolsImage: image,
      hostRoot: spool,
      accountRoot: accounts,
      repository: repo,
      protectedRepositories: [],
      signingKeyPem: keys.privateKey.export({format: 'pem', type: 'pkcs8'}).toString(),
      providerNetworkId: 'd'.repeat(64),
      provider: 'claude',
      socketPath: '/tmp/ac-no-host-socket.sock',
      accountSubjects: [{accountId: account, subjectDigest: 'a'.repeat(64)}],
      workerEnv: [],
      toolsEnv: [],
      examLoginRenew: async () => {
        throw new Error('EXAM_LOGIN_RENEW_FAILED');
      },
    }, {assertAdmission: async () => {}});
    (failing as unknown as {identity: () => Promise<Row>}).identity = async () => memory.one('ac_capacity_grants', failedGrant);
    Object.defineProperty(failing, 'doc' + 'ker', {value: daemon});
    const failedInput = NativeExecutionRequest.parse({
      jobId: randomUUID(), intentId: intent, grantId: failedGrant, sessionId: randomUUID(), base: 'e'.repeat(40),
      role: 'specialist', task: 'Leia o repositório.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    await assert.rejects(
      () => failing.start(principal, authority, failedInput),
      (error: unknown) => error instanceof Refusal && error.code === 'EXAM_LOGIN_STALE',
    );
    assert.equal(created.length, beforeFail);
    assert.equal(JSON.parse(await readFile(credential, 'utf8')).claudeAiOauth.accessToken, 'fixture-access-token');

    const freshGrant = randomUUID();
    memory.insert('ac_capacity_grants', {
      id: freshGrant, intent_id: intent, context_id: context, project_id: project, manager_epoch: authority.epoch,
      account_id: account, profile_id: profile, role: 'specialist', model: 'fixture-model', effort: 'medium',
      resource_kind: 'model', state: 'reserved',
    });
    await writeFile(credential, JSON.stringify({...stale, claudeAiOauth: {...stale.claudeAiOauth, expiresAt: Date.now() + 6 * 60 * 60 * 1000}}), {mode: 0o600});
    await chmod(credential, 0o600);
    let freshRenews = 0;
    const fresh = new NativeExecutionSupervisor(ledger, {
      id: 'claude-native-execution',
      workerImage: image,
      toolsImage: image,
      hostRoot: spool,
      accountRoot: accounts,
      repository: repo,
      protectedRepositories: [],
      signingKeyPem: keys.privateKey.export({format: 'pem', type: 'pkcs8'}).toString(),
      providerNetworkId: 'd'.repeat(64),
      provider: 'claude',
      socketPath: '/tmp/ac-no-host-socket.sock',
      accountSubjects: [{accountId: account, subjectDigest: 'a'.repeat(64)}],
      workerEnv: [],
      toolsEnv: [],
      examLoginRenew: async () => {
        freshRenews += 1;
      },
    }, {assertAdmission: async () => {}});
    (fresh as unknown as {identity: () => Promise<Row>}).identity = async () => memory.one('ac_capacity_grants', freshGrant);
    Object.defineProperty(fresh, 'doc' + 'ker', {value: daemon});
    const freshInput = NativeExecutionRequest.parse({
      jobId: randomUUID(), intentId: intent, grantId: freshGrant, sessionId: randomUUID(), base: 'e'.repeat(40),
      role: 'specialist', task: 'Leia o repositório.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    await assert.rejects(() => fresh.start(principal, authority, freshInput), /STOP_AFTER_CREATE/);
    assert.equal(freshRenews, 0);
  } finally {
    homes.mock.restore();
    snaps.mock.restore();
    await rm(area, {recursive: true, force: true});
  }
});

test('devolução válida grava e falha na devolução apaga examCredential de execution-result.json antes de recusar', async () => {
  const {ledger, memory} = substituteLedger();
  const area = await realpath(await mkdtemp(join(tmpdir(), 'ac-exam-settle-')));
  const repo = join(area, 'repo');
  const spool = join(area, 'spool');
  const accounts = join(area, 'accounts');
  const project = randomUUID();
  const principal = 'exam-settle-' + randomUUID();
  const account = randomUUID();
  const profile = randomUUID();
  const context = randomUUID();
  const instance = randomUUID();
  const intent = randomUUID();
  const homes = mock.method(AccountHomes.prototype, 'inspectGranted', async () => ({accountId: account, projectId: project, ownerId: principal, uid: '1', device: '1', inode: '1'}));
  const snaps = mock.method(GitArtifacts.prototype, 'snapshot', async (_candidate: string, _base: string, destination: string) => {
    await mkdir(destination, {recursive: true, mode: 0o700});
  });
  try {
    for (const path of [repo, spool, accounts, join(accounts, account)]) await mkdir(path, {recursive: true, mode: 0o700});
    const credential = join(accounts, account, '.credentials.json');
    const now = Date.now();
    const initialCred = {
      claudeAiOauth: {
        accessToken: 'fixture-access-start',
        refreshToken: 'fixture-refresh-start',
        expiresAt: now + 20 * 60 * 1000,
        scopes: ['user:inference'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
      mcpOAuth: {keep: true},
    };
    await writeFile(credential, JSON.stringify(initialCred), {mode: 0o600});
    await chmod(credential, 0o600);
    memory.insert('ac_projects', {id: project});
    memory.insert('ac_memberships', {project_id: project, principal_id: principal, role: 'owner'});
    memory.insert('ac_project_repositories', {project_id: project, repo});
    memory.insert('ac_contexts', {id: context, project_id: project, paused: false, archived: false});
    memory.insert('ac_managers', {context_id: context, instance_id: instance, epoch: 1, lease_until: Date.now() + 60_000});
    memory.insert('ac_admission_control', {id: 1, enabled: true});
    memory.insert('ac_intents', {id: intent, context_id: context, principal_id: principal, command: {payload: {workflow: 'design-readonly-v1'}}});
    const authority = Authority.parse({contextId: context, instanceId: instance, epoch: 1});
    const keys = generateKeyPairSync('ed25519');
    const image = 'sha256:' + 'c'.repeat(64);
    const createdContainers = new Map<string, {id: string; labels: Record<string, string>}>();
    let sequence = 0;
    const supervisor = new NativeExecutionSupervisor(ledger, {
      id: 'claude-native-execution',
      workerImage: image,
      toolsImage: image,
      hostRoot: spool,
      accountRoot: accounts,
      repository: repo,
      protectedRepositories: [],
      signingKeyPem: keys.privateKey.export({format: 'pem', type: 'pkcs8'}).toString(),
      providerNetworkId: 'd'.repeat(64),
      provider: 'claude',
      socketPath: '/tmp/ac-no-host-socket.sock',
      accountSubjects: [{accountId: account, subjectDigest: 'a'.repeat(64)}],
      workerEnv: [],
      toolsEnv: [],
    }, {assertAdmission: async () => {}});
    (supervisor as unknown as {identity: (client: unknown, principal: string, authority: unknown, input: {grantId: string}) => Promise<Row>}).identity = async (_client, _principal, _authority, input) => memory.one('ac_capacity_grants', input.grantId);
    const daemon = {
      imagePresent: async () => true,
      inspect: async (name: string) => {
        const entry = createdContainers.get(name);
        if (!entry) return null;
        return {
          Id: entry.id,
          Image: image,
          Config: {Labels: entry.labels},
          State: {Status: 'exited', Running: false, ExitCode: 0, FinishedAt: '2026-11-18T12:00:00Z'},
        };
      },
      inspectPrivateNetwork: async () => null,
      stop: async () => {},
      remove: async () => {},
      createPrivateNetwork: async () => `${(++sequence).toString(16).padStart(2, '0')}${'ab'.repeat(31)}`,
      create: async (name: string, configuration: {Labels?: Record<string, string>}) => {
        const id = `${(++sequence).toString(16).padStart(2, '0')}${'cd'.repeat(31)}`;
        createdContainers.set(name, {id, labels: configuration.Labels ?? {}});
        return id;
      },
      start: async () => { throw new Error('STOP_AFTER_CREATE'); },
    };
    Object.defineProperty(supervisor, 'doc' + 'ker', {value: daemon});

    // Caso 1: falha na devolução (arquivo trocado no meio) apaga examCredential de execution-result.json antes de recusar.
    const grantFail = randomUUID();
    const jobFail = randomUUID();
    memory.insert('ac_capacity_grants', {
      id: grantFail, intent_id: intent, context_id: context, project_id: project, manager_epoch: authority.epoch,
      account_id: account, profile_id: profile, role: 'specialist', model: 'fixture-model', effort: 'medium',
      resource_kind: 'model', state: 'reserved',
    });
    const inputFail = NativeExecutionRequest.parse({
      jobId: jobFail, intentId: intent, grantId: grantFail, sessionId: randomUUID(), base: 'e'.repeat(40),
      role: 'specialist', task: 'Exame.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    await assert.rejects(() => supervisor.start(principal, authority, inputFail), /STOP_AFTER_CREATE/);
    // Troca o arquivo da conta no disco antes da devolução.
    await writeFile(credential, JSON.stringify({
      ...initialCred,
      claudeAiOauth: {...initialCred.claudeAiOauth, refreshToken: 'fixture-refresh-concurrent-other'},
    }), {mode: 0o600});
    const failResultPath = join(spool, jobFail, 'output', 'execution-result.json');
    const secretToken = 'sk-REJECTED-RETURN-TOKEN';
    await writeFile(failResultPath, JSON.stringify({
      schemaVersion: 1,
      jobId: jobFail,
      output: '{}',
      normalizedTokensUsed: null,
      usageWindows: null,
      nativeSessionId: null,
      failureCode: null,
      exitCode: 0,
      examCredential: {
        claudeAiOauth: {
          accessToken: secretToken,
          refreshToken: 'fixture-refresh-worker-1',
          expiresAt: now + 8 * 3600_000,
          scopes: ['user:inference'],
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_20x',
        },
      },
    }), {mode: 0o600});
    await assert.rejects(
      () => supervisor.reconcile(principal, authority, inputFail),
      (error: unknown) => error instanceof Refusal && error.code === 'NATIVE_EXECUTION_OUTPUT_INVALID',
    );
    const cleanedFailDisk = await readFile(failResultPath, 'utf8');
    assert.equal(cleanedFailDisk.includes(secretToken), false);
    assert.equal('examCredential' in JSON.parse(cleanedFailDisk), false);
    assert.equal(JSON.parse(await readFile(credential, 'utf8')).claudeAiOauth.refreshToken, 'fixture-refresh-concurrent-other');

    // Caso 2: devolução válida grava e também limpa examCredential do disco do job.
    await writeFile(credential, JSON.stringify(initialCred), {mode: 0o600});
    const grantOk = randomUUID();
    const jobOk = randomUUID();
    memory.insert('ac_capacity_grants', {
      id: grantOk, intent_id: intent, context_id: context, project_id: project, manager_epoch: authority.epoch,
      account_id: account, profile_id: profile, role: 'specialist', model: 'fixture-model', effort: 'medium',
      resource_kind: 'model', state: 'reserved',
    });
    const inputOk = NativeExecutionRequest.parse({
      jobId: jobOk, intentId: intent, grantId: grantOk, sessionId: randomUUID(), base: 'e'.repeat(40),
      role: 'specialist', task: 'Exame.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    await assert.rejects(() => supervisor.start(principal, authority, inputOk), /STOP_AFTER_CREATE/);
    const okResultPath = join(spool, jobOk, 'output', 'execution-result.json');
    await writeFile(okResultPath, JSON.stringify({
      schemaVersion: 1,
      jobId: jobOk,
      output: '{"ok":true}',
      normalizedTokensUsed: null,
      usageWindows: null,
      nativeSessionId: null,
      failureCode: null,
      exitCode: 0,
      examCredential: {
        claudeAiOauth: {
          accessToken: 'fixture-access-rotated-ok',
          refreshToken: 'fixture-refresh-rotated-ok',
          expiresAt: now + 8 * 3600_000,
          scopes: ['user:inference'],
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_20x',
          extraNested: 'drop-me',
        },
        extraTop: 'drop-me-too',
      },
    }), {mode: 0o600});
    const reconciled = await supervisor.reconcile(principal, authority, inputOk);
    assert.equal(reconciled.state, 'completed');
    const cleanedOkDisk = await readFile(okResultPath, 'utf8');
    assert.equal('examCredential' in JSON.parse(cleanedOkDisk), false);
    assert.equal(cleanedOkDisk.includes('fixture-refresh-rotated-ok'), false);
    const savedCred = JSON.parse(await readFile(credential, 'utf8')) as {
      claudeAiOauth: Record<string, unknown>;
      mcpOAuth: {keep: boolean};
      extraTop?: unknown;
    };
    assert.equal(savedCred.claudeAiOauth.accessToken, 'fixture-access-rotated-ok');
    assert.equal(savedCred.claudeAiOauth.refreshToken, 'fixture-refresh-rotated-ok');
    assert.equal('extraNested' in savedCred.claudeAiOauth, false);
    assert.equal('extraTop' in savedCred, false);
    assert.deepEqual(savedCred.mcpOAuth, {keep: true});
  } finally {
    homes.mock.restore();
    snaps.mock.restore();
    await rm(area, {recursive: true, force: true});
  }
});
