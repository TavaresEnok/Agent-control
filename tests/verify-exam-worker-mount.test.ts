import {mock, test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, randomUUID, verify} from 'node:crypto';
import {chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {AccountHomes} from '../src/account-homes.ts';
import {Authority, Refusal, canonical} from '../src/contracts.ts';
import {GitArtifacts} from '../src/git.ts';
import {NativeExecutionRequest, NativeExecutionSupervisor} from '../src/native-execution-supervisor.ts';
import {prepareClaudeExamWorkerEnv} from '../src/native-execution-worker.ts';
import {ClaudeExecutionAdapter, ClaudeExecutionFailure} from '../src/claude-execution-adapter.ts';
import {ClaudeCliRunner} from '../upstream/cezar/packages/cezar/dist/core/claude-cli-runner.js';
import {collectSecretValues} from '../upstream/cezar/packages/cezar/dist/core/secret-redaction.js';
import {readNativeSecretSnapshot} from '../src/native-execution-secret-snapshot.ts';
import {redactNativeDockerLogs} from '../src/native-execution-redaction.ts';
import {runDesignModule} from '../src/design-module.ts';
import {runDesignCreate} from '../src/design-create.ts';

type Row = Record<string, unknown>;

class MountMemory {
  tables: Record<string, Row[]> = {};
  lockTimeoutOnNextLock = false;
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
    if (/^SET LOCAL lock_timeout = /.test(text)) return selected([]);
    if (text.startsWith('SELECT * FROM ac_recovery_inventory_policy')) return selected([{singleton: true, required: false}]);
    if (text.includes('ac_native_resource_admissions')) return selected([]);
    if (text.startsWith('DELETE FROM ac_native_resource_admissions')) return wrote(0);
    if (text.includes('ac_installation_activation')) return selected([{present: 1}]);
    if (text.startsWith('SELECT command FROM ac_intents WHERE id=$1')) {
      const intent = this.tables.ac_intents?.find(row => row.id === params[0]);
      return selected(intent ? [{command: intent.command}] : []);
    }
    if (text.startsWith('SELECT 1 FROM ac_model_catalog')) return selected([{one: 1}]);
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
    if (text.startsWith("UPDATE ac_native_execution_jobs SET state='running'")) {
      const job = this.one('ac_native_execution_jobs', String(params[0]));
      job.state = 'running';
      job.launch_digest = params[1];
      return wrote(1);
    }
    if (text.startsWith("UPDATE ac_capacity_grants SET state='running'")) {
      const grant = this.one('ac_capacity_grants', String(params[0]));
      grant.state = 'running';
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
    if (text.startsWith('SELECT j.*,g.state grant_state,g.physical_receipt,i.principal_id FROM ac_native_execution_jobs j')) {
      const job = this.tables.ac_native_execution_jobs?.find(row => row.id === params[0] && row.context_id === params[1]);
      const grant = this.tables.ac_capacity_grants?.find(row => row.id === job?.grant_id);
      const intent = this.tables.ac_intents?.find(row => row.id === job?.intent_id);
      return job && grant && intent ? selected([{...job, grant_state: grant.state, physical_receipt: grant.physical_receipt ?? null, principal_id: intent.principal_id}]) : selected([]);
    }
    if (text.startsWith('SELECT j.*,g.state grant_state,g.physical_receipt FROM ac_native_execution_jobs j')) {
      const job = this.tables.ac_native_execution_jobs?.find(row => row.id === params[0] && row.context_id === params[1]);
      const grant = this.tables.ac_capacity_grants?.find(row => row.id === job?.grant_id);
      return job && grant ? selected([{...job, grant_state: grant.state, physical_receipt: grant.physical_receipt ?? null}]) : selected([]);
    }
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
    if (/^SELECT pg_advisory_xact_lock(_shared)?\(/.test(text)) {
      if (this.lockTimeoutOnNextLock) {
        this.lockTimeoutOnNextLock = false;
        throw Object.assign(new Error('canceling statement due to lock timeout'), {code: '55P03'});
      }
      return selected([{locked: true}]);
    }
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

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFilesRecursive(full));
    else out.push(full);
  }
  return out;
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

test('exame Claude não monta .credentials.json, força renovação no lugar, leva accessToken no launch assinado e libera grant em qualquer recusa', async () => {
  const {ledger, memory} = substituteLedger();
  const area = await realpath(await mkdtemp(join(tmpdir(), 'ac-exam-oauth-')));
  const repo = join(area, 'repo');
  const spool = join(area, 'spool');
  const accounts = join(area, 'accounts');
  const project = randomUUID();
  const principal = 'exam-oauth-' + randomUUID();
  const account = randomUUID();
  const profile = randomUUID();
  const context = randomUUID();
  const instance = randomUUID();
  const intent = randomUUID();
  const homes = mock.method(AccountHomes.prototype, 'inspectGranted', async () => ({accountId: account, projectId: project, ownerId: principal, uid: '1', device: '1', inode: '1'}));
  const snaps = mock.method(GitArtifacts.prototype, 'snapshot', async (_candidate: string, _base: string, destination: string) => {
    await mkdir(destination, {recursive: true, mode: 0o700});
  });
  const fakeSocketServer = await import('node:http');
  const sockPath = join(area, 'docker.sock');
  let workerContainerId = '';
  let toolsContainerId = '';
  let networkContainerId = '';
  let workerCreatedConfig: {Env?: string[]; HostConfig?: {Binds?: string[]}} | undefined;
  let toolsCreatedConfig: {Env?: string[]; HostConfig?: {Binds?: string[]}} | undefined;
  const server = fakeSocketServer.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === `/v1.44/containers/${workerContainerId}/json`) {
      res.end(JSON.stringify({
        Id: workerContainerId,
        Image: 'sha256:' + 'c'.repeat(64),
        Config: {
          User: `${process.getuid?.()}:${process.getgid?.()}`,
          Labels: {'agent-control.job': lastJobId, 'agent-control.launch': lastLaunchHash},
          Entrypoint: ['node', '/opt/agent-control/dist/src/native-execution-worker.mjs'],
          Cmd: [],
          Env: workerCreatedConfig?.Env ?? [],
          WorkingDir: '/planning',
        },
        State: {Status: 'running', Running: true},
        HostConfig: {
          NetworkMode: networkContainerId,
          PidMode: '',
          IpcMode: '',
          Privileged: false,
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          CapAdd: [],
          SecurityOpt: ['no-new-privileges:true'],
          Devices: [],
          PidsLimit: 96,
          Memory: 512 * 1024 * 1024,
          NanoCpus: 1e9,
          PortBindings: {},
        },
        Mounts: (workerCreatedConfig?.HostConfig?.Binds ?? []).map(b => {
          const [source, destination, mode] = b.split(':');
          return {Type: 'bind', Source: source, Destination: destination, RW: mode === 'rw'};
        }),
        NetworkSettings: {Networks: {
          [networkContainerId]: {NetworkID: networkContainerId, IPAddress: '172.20.0.3'},
          ['d'.repeat(64)]: {NetworkID: 'd'.repeat(64), IPAddress: '172.21.0.3'},
        }},
      }));
      return;
    }
    if (req.url === `/v1.44/containers/${toolsContainerId}/json`) {
      res.end(JSON.stringify({
        Id: toolsContainerId,
        Image: 'sha256:' + 'c'.repeat(64),
        Config: {
          User: `${process.getuid?.()}:${process.getgid?.()}`,
          Labels: {'agent-control.job': lastJobId, 'agent-control.launch': lastLaunchHash},
          Entrypoint: ['node', '/opt/agent-control/dist/src/native-tools-worker.mjs'],
          Cmd: [],
          Env: toolsCreatedConfig?.Env ?? [],
          WorkingDir: '/work',
        },
        State: {Status: 'running', Running: true},
        HostConfig: {
          NetworkMode: networkContainerId,
          PidMode: '',
          IpcMode: '',
          Privileged: false,
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          CapAdd: [],
          SecurityOpt: ['no-new-privileges:true'],
          Devices: [],
          PidsLimit: 96,
          Memory: 512 * 1024 * 1024,
          NanoCpus: 1e9,
          PortBindings: {},
        },
        Mounts: (toolsCreatedConfig?.HostConfig?.Binds ?? []).map(b => {
          const [source, destination, mode] = b.split(':');
          return {Type: 'bind', Source: source, Destination: destination, RW: mode === 'rw'};
        }),
        NetworkSettings: {Networks: {[networkContainerId]: {NetworkID: networkContainerId, IPAddress: '172.20.0.2'}}},
      }));
      return;
    }
    if (req.url === `/v1.44/networks/${networkContainerId}`) {
      res.end(JSON.stringify({
        Id: networkContainerId,
        Internal: true,
        Containers: {
          [toolsContainerId]: {IPv4Address: '172.20.0.2/16'},
          [workerContainerId]: {IPv4Address: '172.20.0.3/16'},
        },
      }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  let lastJobId = '';
  let lastLaunchHash = '';
  try {
    await new Promise<void>(resolve => server.listen(sockPath, resolve));
    for (const path of [repo, spool, accounts, join(accounts, account)]) await mkdir(path, {recursive: true, mode: 0o700});
    const credential = join(accounts, account, '.credentials.json');
    const nearExpiry = {
      claudeAiOauth: {
        accessToken: 'fixture-access-old',
        refreshToken: 'fixture-refresh-old',
        expiresAt: Date.now() + 20 * 60 * 1000,
        scopes: ['user:inference'],
      },
      mcpOAuth: {keep: true},
    };
    await writeFile(credential, JSON.stringify(nearExpiry), {mode: 0o600});
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
    const created: {name: string; env: string[]; binds: string[]}[] = [];
    let renews = 0;
    let sawExpiresZero = false;
    let sequence = 0;
    const makeDaemon = () => ({
      imagePresent: async () => true,
      inspect: async () => null,
      inspectPrivateNetwork: async () => ({
        Id: networkContainerId,
        Internal: true,
        Containers: {[toolsContainerId]: {IPv4Address: '172.20.0.2/16'}, [workerContainerId]: {IPv4Address: '172.20.0.3/16'}},
      }),
      stop: async () => {},
      remove: async () => {},
      createPrivateNetwork: async () => {
        networkContainerId = `${(++sequence).toString(16).padStart(2, '0')}${'ab'.repeat(31)}`;
        return networkContainerId;
      },
      create: async (name: string, configuration: {Env?: string[]; HostConfig?: {Binds?: string[]}}) => {
        const id = `${(++sequence).toString(16).padStart(2, '0')}${'cd'.repeat(31)}`;
        created.push({name, env: [...(configuration.Env ?? [])], binds: [...(configuration.HostConfig?.Binds ?? [])]});
        if (name.startsWith('ac-native-worker-')) {
          workerContainerId = id;
          workerCreatedConfig = configuration;
        } else {
          toolsContainerId = id;
          toolsCreatedConfig = configuration;
        }
        return id;
      },
      start: async () => {},
    });

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
      socketPath: sockPath,
      accountSubjects: [{accountId: account, subjectDigest: 'a'.repeat(64)}],
      workerEnv: ['AC_FIXTURE=1'],
      toolsEnv: [],
      examLoginRenew: async () => {
        renews += 1;
        const onDisk = JSON.parse(await readFile(credential, 'utf8')) as {claudeAiOauth: {expiresAt: number}};
        sawExpiresZero = onDisk.claudeAiOauth.expiresAt === 0;
        const next = {
          ...nearExpiry,
          claudeAiOauth: {
            ...nearExpiry.claudeAiOauth,
            expiresAt: Date.now() + 3 * 60 * 60 * 1000,
            accessToken: 'fixture-access-token-new-secret',
            refreshToken: 'fixture-refresh-token-new-secret',
          },
        };
        await writeFile(credential, JSON.stringify(next), {mode: 0o600});
        await chmod(credential, 0o644);
      },
    }, {assertAdmission: async () => {}});
    (supervisor as unknown as {identity: (client: unknown, principal: string, authority: unknown, input: {grantId: string}) => Promise<Row>}).identity = async (_client, _principal, _authority, input) => memory.one('ac_capacity_grants', input.grantId);
    Object.defineProperty(supervisor, 'doc' + 'ker', {value: makeDaemon()});

    // 1) Token perto de vencer: grava expiresAt 0, renova no lugar, NÃO monta /account, e grava oauthAccessToken no launch.json assinado.
    const grant1 = randomUUID();
    const job1 = randomUUID();
    memory.insert('ac_capacity_grants', {
      id: grant1, intent_id: intent, context_id: context, project_id: project, manager_epoch: authority.epoch,
      account_id: account, profile_id: profile, role: 'specialist', model: 'fixture-model', effort: 'medium',
      resource_kind: 'model', state: 'reserved',
    });
    const input1 = NativeExecutionRequest.parse({
      jobId: job1, intentId: intent, grantId: grant1, sessionId: randomUUID(), base: 'e'.repeat(40),
      role: 'specialist', task: 'Leia o repositório.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    lastJobId = job1;
    const {digest} = await import('../src/contracts.ts');
    lastLaunchHash = digest(input1);

    const started1 = await supervisor.start(principal, authority, input1);
    assert.deepEqual(started1, {state: 'running', jobId: job1});
    assert.equal(renews, 1);
    assert.equal(sawExpiresZero, true);
    assert.equal((await lstat(credential)).mode & 0o777, 0o600);

    const workerMeta1 = created.find(item => item.name === `ac-native-worker-${job1}`);
    assert.ok(workerMeta1);
    assert.ok(workerMeta1.env.includes('AC_VERIFY_EXAM=1'));
    assert.equal(workerMeta1.binds.some(b => b.includes(':/account')), false);
    assert.equal(workerMeta1.binds.some(b => b.includes('.credentials.json')), false);
    await assert.rejects(() => lstat(join(spool, job1, `exam-account-${account}`)), {code: 'ENOENT'});
    await assert.rejects(() => lstat(join(spool, job1, 'exam-refresh-mark')), {code: 'ENOENT'});

    const signedLaunch = JSON.parse(await readFile(join(spool, job1, 'input', 'launch.json'), 'utf8')) as {
      payload: {oauthAccessToken?: string; credentialSnapshotTag: string; provider?: string};
      signature: string;
    };
    assert.equal(
      verify(null, Buffer.from('agent-control:native-execution-launch:v1\n' + canonical(signedLaunch.payload)), keys.publicKey, Buffer.from(signedLaunch.signature, 'hex')),
      true,
    );
    assert.equal(signedLaunch.payload.oauthAccessToken, 'fixture-access-token-new-secret');
    assert.equal(JSON.stringify(signedLaunch).includes('fixture-refresh-token-new-secret'), false);

    // O snapshot de redação contém ambos os tokens e o redactNativeDockerLogs os mascara.
    const snapSecrets = await readNativeSecretSnapshot(join(spool, job1, 'redaction.enc'), job1, keys.privateKey);
    assert.equal(snapSecrets.includes('fixture-access-token-new-secret'), true);
    assert.equal(snapSecrets.includes('fixture-refresh-token-new-secret'), true);
    const frameMsg = Buffer.from('leaked fixture-access-token-new-secret\n', 'utf8');
    const hdr = Buffer.alloc(8);
    hdr[0] = 1;
    hdr.writeUInt32BE(frameMsg.length, 4);
    const redactedStream = redactNativeDockerLogs(Buffer.concat([hdr, frameMsg]), snapSecrets);
    assert.equal(redactedStream.includes(Buffer.from('fixture-access-token-new-secret')), false);
    assert.equal(redactedStream.includes(Buffer.from('[REDACTED]')), true);

    // 2) Token com 3h de validade (já renovado acima): não chama renovador e usa o accessToken atual no launch.
    const grant2 = randomUUID();
    const job2 = randomUUID();
    memory.insert('ac_capacity_grants', {
      id: grant2, intent_id: intent, context_id: context, project_id: project, manager_epoch: authority.epoch,
      account_id: account, profile_id: profile, role: 'reviewer', model: 'fixture-model', effort: 'medium',
      resource_kind: 'model', state: 'reserved',
    });
    const input2 = NativeExecutionRequest.parse({
      jobId: job2, intentId: intent, grantId: grant2, sessionId: randomUUID(), base: 'e'.repeat(40),
      role: 'reviewer', task: 'Revise o repositório.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    lastJobId = job2;
    lastLaunchHash = digest(input2);
    await supervisor.start(principal, authority, input2);
    assert.equal(renews, 1);
    const signedLaunch2 = JSON.parse(await readFile(join(spool, job2, 'input', 'launch.json'), 'utf8')) as {
      payload: {oauthAccessToken?: string};
    };
    assert.equal(signedLaunch2.payload.oauthAccessToken, 'fixture-access-token-new-secret');

    // 3) Cada recusa antes do launch libera o grant (inclusive depois de virar uncertain):
    // 3a) EXAM_LOGIN_STALE restaura expiresAt original e libera o grant.
    const staleBefore = {...nearExpiry, claudeAiOauth: {...nearExpiry.claudeAiOauth, expiresAt: Date.now() - 10_000}};
    await writeFile(credential, JSON.stringify(staleBefore), {mode: 0o600});
    const createdBeforeFailures = created.length;
    const staleSupervisor = new NativeExecutionSupervisor(ledger, {
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
      socketPath: sockPath,
      accountSubjects: [{accountId: account, subjectDigest: 'a'.repeat(64)}],
      workerEnv: [],
      toolsEnv: [],
      examLoginRenew: async () => {
        throw new Error('EXAM_LOGIN_RENEW_FAILED');
      },
    }, {assertAdmission: async () => {}});
    (staleSupervisor as unknown as {identity: (client: unknown, principal: string, authority: unknown, input: {grantId: string}) => Promise<Row>}).identity = async (_client, _principal, _authority, input) => memory.one('ac_capacity_grants', input.grantId);
    Object.defineProperty(staleSupervisor, 'doc' + 'ker', {value: makeDaemon()});

    const staleGrant = randomUUID();
    const staleJob = randomUUID();
    memory.insert('ac_capacity_grants', {
      id: staleGrant, intent_id: intent, context_id: context, project_id: project, manager_epoch: authority.epoch,
      account_id: account, profile_id: profile, role: 'specialist', model: 'fixture-model', effort: 'medium',
      resource_kind: 'model', state: 'reserved',
    });
    const staleInput = NativeExecutionRequest.parse({
      jobId: staleJob, intentId: intent, grantId: staleGrant, sessionId: randomUUID(), base: 'e'.repeat(40),
      role: 'specialist', task: 'Exame stale.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    await assert.rejects(
      () => staleSupervisor.start(principal, authority, staleInput),
      (error: unknown) => error instanceof Refusal && error.code === 'EXAM_LOGIN_STALE',
    );
    assert.equal(created.length, createdBeforeFailures);
    assert.equal(JSON.parse(await readFile(credential, 'utf8')).claudeAiOauth.expiresAt, staleBefore.claudeAiOauth.expiresAt);
    assert.equal(memory.one('ac_capacity_grants', staleGrant).state, 'released');
    assert.deepEqual(memory.one('ac_capacity_grants', staleGrant).physical_receipt, {
      executionStarted: false,
      jobId: staleJob,
      containerId: null,
      networkId: null,
      synthetic: false,
      modelInference: false,
      reason: 'exam_login_stale',
    });
    // recover() após job ter virado uncertain e sido liberado antes do launch preserva grant: 'released'.
    const rec = await staleSupervisor.recover(principal, authority, staleJob);
    assert.equal(rec.grant, 'released');
    assert.equal(rec.interval, 'network_unproven');

    // 3b) EXAM_LOGIN_BUSY libera o grant depois de o job virar uncertain.
    const busyGrant = randomUUID();
    const busyJob = randomUUID();
    memory.insert('ac_capacity_grants', {
      id: busyGrant, intent_id: intent, context_id: context, project_id: project, manager_epoch: authority.epoch,
      account_id: account, profile_id: profile, role: 'specialist', model: 'fixture-model', effort: 'medium',
      resource_kind: 'model', state: 'reserved',
    });
    const busyInput = NativeExecutionRequest.parse({
      jobId: busyJob, intentId: intent, grantId: busyGrant, sessionId: randomUUID(), base: 'e'.repeat(40),
      role: 'specialist', task: 'Exame busy.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    memory.lockTimeoutOnNextLock = true;
    await assert.rejects(
      () => staleSupervisor.start(principal, authority, busyInput),
      (error: unknown) => error instanceof Refusal && error.code === 'EXAM_LOGIN_BUSY',
    );
    assert.equal(created.length, createdBeforeFailures);
    assert.equal(memory.one('ac_capacity_grants', busyGrant).state, 'released');
    assert.deepEqual(memory.one('ac_capacity_grants', busyGrant).physical_receipt, {
      executionStarted: false,
      jobId: busyJob,
      containerId: null,
      networkId: null,
      synthetic: false,
      modelInference: false,
      reason: 'exam_login_busy',
    });

    // 3c) Falha ao ler o token (symlink ou arquivo ausente) após job virar uncertain também libera o grant.
    const targetOutside = join(area, 'outside.json');
    await writeFile(targetOutside, JSON.stringify(staleBefore), {mode: 0o600});
    await rm(credential);
    await symlink(targetOutside, credential);
    const missingTokenGrant = randomUUID();
    const missingTokenJob = randomUUID();
    memory.insert('ac_capacity_grants', {
      id: missingTokenGrant, intent_id: intent, context_id: context, project_id: project, manager_epoch: authority.epoch,
      account_id: account, profile_id: profile, role: 'specialist', model: 'fixture-model', effort: 'medium',
      resource_kind: 'model', state: 'reserved',
    });
    const missingTokenInput = NativeExecutionRequest.parse({
      jobId: missingTokenJob, intentId: intent, grantId: missingTokenGrant, sessionId: randomUUID(), base: 'e'.repeat(40),
      role: 'specialist', task: 'Exame symlink.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    await assert.rejects(
      () => staleSupervisor.start(principal, authority, missingTokenInput),
      (error: unknown) => error instanceof Refusal && error.code === 'EXAM_LOGIN_STALE',
    );
    assert.equal(created.length, createdBeforeFailures);
    assert.equal(memory.one('ac_capacity_grants', missingTokenGrant).state, 'released');
  } finally {
    server.close();
    homes.mock.restore();
    snaps.mock.restore();
    await rm(area, {recursive: true, force: true});
  }
});

test('o worker do exame não tem .credentials.json em disco, passa CLAUDE_CODE_OAUTH_TOKEN sem CLAUDE_CONFIG_DIR/ANTHROPIC_API_KEY e mascara o segredo', async () => {
  const area = await realpath(await mkdtemp(join(tmpdir(), 'ac-exam-worker-env-')));
  const tmpArea = join(area, 'tmp');
  const workDir = join(area, 'work');
  const tracePath = join(area, 'claude-trace.json');
  const fakeClaude = join(area, 'fake-claude');
  const accessToken = 'oauth-access-fixture-secret-token-987654321';
  const prevEnv = {...process.env};
  try {
    await mkdir(tmpArea, {mode: 0o700});
    await mkdir(workDir, {mode: 0o700});
    await writeFile(
      fakeClaude,
      `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(${JSON.stringify(tracePath)}, JSON.stringify({
  argv: process.argv.slice(2),
  oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
  home: process.env.HOME ?? null,
}));
const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
rl.once('line', line => {
  const parsed = JSON.parse(line);
  const textBlock = (parsed.message && parsed.message.content || []).find(c => c.type === 'text');
  const promptText = textBlock ? textBlock.text : '';
  if (promptText.includes('FORCE_AUTH_EXPIRED')) {
    console.log(JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'Failed to authenticate: OAuth session expired ' + (process.env.CLAUDE_CODE_OAUTH_TOKEN || ''),
    }));
    process.exit(0);
  }
  const reply = JSON.stringify({ok: true, leaked: process.env.CLAUDE_CODE_OAUTH_TOKEN});
  console.log(JSON.stringify({type: 'assistant', message: {role: 'assistant', content: [{type: 'text', text: reply}]}}));
  console.log(JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: reply}));
  process.exit(0);
});
`,
      {mode: 0o700},
    );
    await chmod(fakeClaude, 0o700);

    const {createHmac} = await import('node:crypto');
    const execToken = 'e'.repeat(48);
    const snapshotTag = createHmac('sha256', execToken).update(canonical([accessToken])).digest('hex');

    // Simula variáveis que não podem vazar para o CLI do exame.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-forbidden-key';
    process.env.CLAUDE_CONFIG_DIR = '/forbidden/config/dir';

    const prepared = await prepareClaudeExamWorkerEnv({
      oauthAccessToken: accessToken,
      credentialSnapshotTag: snapshotTag,
      execToken,
      tmpRoot: tmpArea,
      realClaudeBin: fakeClaude,
    });

    assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, accessToken);
    assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);

    const filesInTmp = await listFilesRecursive(tmpArea);
    assert.equal(filesInTmp.some(f => f.endsWith('.credentials.json')), false);
    assert.equal(filesInTmp.some(f => f.endsWith('.claude.json')), false);
    const settingsFiles = filesInTmp.filter(f => f.endsWith('settings.json'));
    assert.equal(settingsFiles.length, 1);

    const runner = new ClaudeCliRunner({bin: prepared.claudeBin, timeoutMs: 10_000});
    const adaptedRunner = {
      backend: 'claude' as const,
      run(spec: Parameters<ClaudeCliRunner['run']>[0], onEvent?: Parameters<ClaudeCliRunner['run']>[1]) {
        return runner.run({...spec, cwd: workDir}, onEvent);
      },
      interrupt() {
        return runner.interrupt();
      },
      startSession(spec: Parameters<ClaudeCliRunner['startSession']>[0], onEvent: Parameters<ClaudeCliRunner['startSession']>[1], opts: Parameters<ClaudeCliRunner['startSession']>[2]) {
        return runner.startSession({...spec, cwd: workDir}, onEvent, opts);
      },
    };
    const adapter = new ClaudeExecutionAdapter(adaptedRunner);
    const ran = await adapter.run(
      {
        sessionId: randomUUID(),
        model: 'claude-sonnet-5-5',
        effort: 'medium',
        role: 'reviewer',
        task: 'Examine o código.',
        writePaths: [],
        artifactCommit: 'a'.repeat(40),
        outputSchema: {type: 'object'},
        timeoutMs: 10_000,
        environment: {id: 'native_tools', url: 'ws://127.0.0.1:19492', authBearerToken: execToken, cwd: '/work'},
      },
      async () => {},
      undefined,
      [...prepared.secrets, ...collectSecretValues(process.env)],
    );

    const trace = JSON.parse(await readFile(tracePath, 'utf8')) as {
      argv: string[];
      oauthToken: string | null;
      claudeConfigDir: string | null;
      anthropicApiKey: string | null;
      home: string | null;
    };
    assert.equal(trace.oauthToken, accessToken);
    assert.equal(trace.claudeConfigDir, null);
    assert.equal(trace.anthropicApiKey, null);
    assert.equal(trace.home, prepared.examHome);
    assert.equal(trace.argv.includes(accessToken), false);
    assert.equal(ran.output.includes(accessToken), false);
    assert.equal(JSON.parse(ran.output).leaked, '[REDACTED]');

    // Se o token vencer no meio do job, falha com PROVIDER_AUTH_FAILED sem vazar o token.
    await assert.rejects(
      () => adapter.run(
        {
          sessionId: randomUUID(),
          model: 'claude-sonnet-5-5',
          effort: 'medium',
          role: 'reviewer',
          task: 'FORCE_AUTH_EXPIRED',
          writePaths: [],
          artifactCommit: 'a'.repeat(40),
          outputSchema: {type: 'object'},
          timeoutMs: 10_000,
          environment: {id: 'native_tools', url: 'ws://127.0.0.1:19492', authBearerToken: execToken, cwd: '/work'},
        },
        async () => {},
        undefined,
        [...prepared.secrets, ...collectSecretValues(process.env)],
      ),
      (error: unknown) => {
        assert.ok(error instanceof ClaudeExecutionFailure);
        assert.equal(error.code, 'PROVIDER_AUTH_FAILED');
        assert.equal(error.message.includes(accessToken), false);
        return true;
      },
    );
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in prevEnv)) delete process.env[k];
    }
    Object.assign(process.env, prevEnv);
    await rm(area, {recursive: true, force: true});
  }
});

test('validador e design (examinador, revisor e criar) usam o mesmo mecanismo sem montar .credentials.json', async () => {
  const {ledger, memory} = substituteLedger();
  const area = await realpath(await mkdtemp(join(tmpdir(), 'ac-exam-all-paths-')));
  const repo = join(area, 'repo');
  const spool = join(area, 'spool');
  const accounts = join(area, 'accounts');
  const project = randomUUID();
  const principal = 'exam-paths-' + randomUUID();
  const account = randomUUID();
  const profile = randomUUID();
  const context = randomUUID();
  const instance = randomUUID();
  const homes = mock.method(AccountHomes.prototype, 'inspectGranted', async () => ({accountId: account, projectId: project, ownerId: principal, uid: '1', device: '1', inode: '1'}));
  const snaps = mock.method(GitArtifacts.prototype, 'snapshot', async (_candidate: string, _base: string, destination: string) => {
    await mkdir(destination, {recursive: true, mode: 0o700});
  });
  try {
    for (const path of [repo, spool, accounts, join(accounts, account)]) await mkdir(path, {recursive: true, mode: 0o700});
    const accessToken = 'fixture-access-shared-paths-secret';
    await writeFile(join(accounts, account, '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken,
        refreshToken: 'fixture-refresh-shared-paths',
        expiresAt: Date.now() + 3 * 3600_000,
        scopes: ['user:inference'],
      },
    }), {mode: 0o600});
    memory.insert('ac_projects', {id: project});
    memory.insert('ac_memberships', {project_id: project, principal_id: principal, role: 'owner'});
    memory.insert('ac_project_repositories', {project_id: project, repo});
    memory.insert('ac_contexts', {id: context, project_id: project, paused: false, archived: false});
    memory.insert('ac_managers', {context_id: context, instance_id: instance, epoch: 1, lease_until: Date.now() + 60_000});
    memory.insert('ac_admission_control', {id: 1, enabled: true});
    const authority = Authority.parse({contextId: context, instanceId: instance, epoch: 1});
    const keys = generateKeyPairSync('ed25519');
    const image = 'sha256:' + 'c'.repeat(64);
    const created: {name: string; env: string[]; binds: string[]}[] = [];
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
    Object.defineProperty(supervisor, 'doc' + 'ker', {
      value: {
        imagePresent: async () => true,
        inspect: async () => null,
        inspectPrivateNetwork: async () => null,
        stop: async () => {},
        remove: async () => {},
        createPrivateNetwork: async () => `${(++sequence).toString(16).padStart(2, '0')}${'ab'.repeat(31)}`,
        create: async (name: string, configuration: {Env?: string[]; HostConfig?: {Binds?: string[]}}) => {
          created.push({name, env: [...(configuration.Env ?? [])], binds: [...(configuration.HostConfig?.Binds ?? [])]});
          return `${(++sequence).toString(16).padStart(2, '0')}${'cd'.repeat(31)}`;
        },
        start: async () => { throw new Error('STOP_AFTER_CREATE'); },
      },
    });

    const cases = [
      {label: 'validador-examinador', workflow: 'security-verify-readonly-v1', role: 'specialist' as const, task: 'Exame de segurança.', exam: true},
      {label: 'validador-revisor', workflow: 'security-verify-readonly-v1', role: 'reviewer' as const, task: 'Revisão de segurança.', exam: true},
      {label: 'design-examinador', workflow: 'design-readonly-v1', role: 'specialist' as const, task: 'Pedido de exame.', exam: true},
      {label: 'design-revisor', workflow: 'design-readonly-v1', role: 'reviewer' as const, task: 'Pedido de confirmação.', exam: true},
      {label: 'design-criar', workflow: 'design-readonly-v1', role: 'specialist' as const, task: 'Pedido de criação. Tela inicial.', exam: true},
      {label: 'programador', workflow: 'engineering-native-v1', role: 'programmer' as const, task: 'Edite src/a.ts.', exam: false},
    ];

    for (const item of cases) {
      const intentId = randomUUID();
      const grantId = randomUUID();
      const jobId = randomUUID();
      memory.insert('ac_intents', {id: intentId, context_id: context, principal_id: principal, command: {payload: {workflow: item.workflow}}});
      memory.insert('ac_capacity_grants', {
        id: grantId, intent_id: intentId, context_id: context, project_id: project, manager_epoch: authority.epoch,
        account_id: account, profile_id: profile, role: item.role, model: 'fixture-model', effort: 'medium',
        resource_kind: 'model', state: 'reserved',
      });
      const req = NativeExecutionRequest.parse({
        jobId, intentId, grantId, sessionId: randomUUID(), base: 'e'.repeat(40),
        role: item.role, task: item.task,
        writePaths: item.role === 'programmer' ? ['src/a.ts'] : [],
        ...(item.role === 'programmer' ? {} : {artifactId: randomUUID(), outputSchema: {type: 'object'}}),
      });
      await assert.rejects(() => supervisor.start(principal, authority, req), /STOP_AFTER_CREATE/);
      const w = created.find(c => c.name === `ac-native-worker-${jobId}`);
      assert.ok(w, item.label);
      assert.equal(w.env.includes('AC_VERIFY_EXAM=1'), item.exam, item.label);
      assert.equal(w.binds.some(b => b.includes(':/account')), !item.exam, item.label);
    }

    // Relatórios de design e criar nunca registram accessToken e propagam EXAM_LOGIN_STALE/EXAM_LOGIN_BUSY.
    const dataDir = join(area, 'design-data');
    await mkdir(dataDir, {mode: 0o700});
    const staleDesign = await runDesignModule({
      activation: 'personal',
      projectId: project,
      repo,
      targetUrl: 'http://127.0.0.1:4173',
      dataDirectory: dataDir,
      intentId: randomUUID(),
      runId: randomUUID(),
      createdAt: new Date(),
      commit: 'e'.repeat(40),
      files: [{path: 'index.html', text: '<html><body><h1>Oi</h1></body></html>'}],
      worker: {async run() { throw new Refusal('EXAM_LOGIN_STALE'); }},
      reserve: async () => ({provider: 'claude', model: 'claude-sonnet-5-5', accountId: account, profileId: profile, grantId: randomUUID()}),
      release: async () => {},
    });
    assert.equal(staleDesign.loginStale, true);
    const reportFiles = await listFilesRecursive(staleDesign.directory);
    for (const file of reportFiles) {
      assert.equal((await readFile(file, 'utf8')).includes(accessToken), false);
    }

    await assert.rejects(
      () => runDesignCreate({
        dataDirectory: dataDir,
        runId: randomUUID(),
        repository: repo,
        briefing: 'Uma tela.',
        screens: 1,
        rounds: 1,
        referenceNote: '',
        worker: {async run() { throw new Refusal('EXAM_LOGIN_BUSY'); }},
        reserve: async () => ({provider: 'claude', accountId: account, profileId: profile, model: 'claude-opus-5-5', grantId: randomUUID()}),
        release: async () => {},
        intentId: randomUUID(),
        examine: async () => ({screens: [], notes: []}),
      }),
      (error: unknown) => error instanceof Refusal && error.code === 'EXAM_LOGIN_BUSY',
    );
  } finally {
    homes.mock.restore();
    snaps.mock.restore();
    await rm(area, {recursive: true, force: true});
  }
});
