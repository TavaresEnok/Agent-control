import {mock, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, createHmac, generateKeyPairSync, randomUUID, verify} from 'node:crypto';
import {chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {ProviderCollectors} from '../src/providers.ts';
import {createSyntheticProviderAdapter} from '../src/synthetic-provider-adapter.ts';
import {AccountHomes} from '../src/account-homes.ts';
import {Authority, Refusal, canonical, digest} from '../src/contracts.ts';
import {GitArtifacts} from '../src/git.ts';
import {NativeExecutionRequest, NativeExecutionSupervisor, UnstartedExamRetirementPending} from '../src/native-execution-supervisor.ts';
import {createClaudeWorkerRunner, isClaudeExamWorker, prepareClaudeExamWorkerEnv} from '../src/native-execution-worker.ts';
import {EXAM_CLAUDE_WRAPPER_BIN, examClaudeWrapperSource, installExamClaudeWrapper} from '../src/verify-exam-isolation.ts';
import {ClaudeExecutionAdapter, ClaudeExecutionFailure} from '../src/claude-execution-adapter.ts';
import {ClaudeCliRunner} from '../upstream/cezar/packages/cezar/dist/core/claude-cli-runner.js';
import {collectSecretValues} from '../upstream/cezar/packages/cezar/dist/core/secret-redaction.js';
import {readNativeSecretSnapshot} from '../src/native-execution-secret-snapshot.ts';
import {redactNativeDockerLogs} from '../src/native-execution-redaction.ts';
import {ProviderEligibility} from '../src/provider-eligibility.ts';
import {authorizeNativeSyntheticFixture} from '../src/native-synthetic-fixture.ts';
import {EXAM_LOGIN_MARGIN_MS} from '../src/exam-login.ts';
import {runDesignModule} from '../src/design-module.ts';
import {runDesignCreate} from '../src/design-create.ts';
import {runSecurityVerification} from '../src/verify-runtime.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

type Row = Record<string, unknown>;

class MountMemory {
  tables: Record<string, Row[]> = {};
  // Os contratos sem banco usam uma transação por vez.
  private beforeTransaction?: Record<string, Row[]>;
  lockTimeoutOnNextLock = false;
  lockErrorOnNextLock: Error | null = null;
  insert(table: string, row: Row) { (this.tables[table] ??= []).push({...row}); }
  one(table: string, id: string) {
    const row = this.tables[table]?.find(item => item.id === id);
    if (!row) throw new Error(`MISSING_ROW ${table}`);
    return row;
  }
  private unstartedExamRows(jobId: unknown, contextId: unknown): Row[] {
    const job = this.tables.ac_native_execution_jobs?.find(row => row.id === jobId && row.context_id === contextId);
    if (!job) return [];
    const grant = this.tables.ac_capacity_grants?.find(row => row.id === job.grant_id);
    const intent = this.tables.ac_intents?.find(row => row.id === job.intent_id && row.context_id === job.context_id);
    const account = this.tables.ac_accounts?.find(row => row.id === job.account_id);
    const profile = this.tables.ac_profiles?.find(row => row.id === job.profile_id && row.account_id === account?.id);
    if (!grant || !intent || !account || !profile) return [];

    const dedicatedContexts = new Set(this.tables.ac_exam_contexts?.map(row => row.context_id));
    const mainContext = this.tables.ac_contexts
      ?.filter(row => row.project_id === grant.project_id && !row.archived && !dedicatedContexts.has(row.id))
      .sort((a, b) => Number(a.created_at ?? 0) - Number(b.created_at ?? 0) || String(a.id).localeCompare(String(b.id)))[0];
    const otherExecutionJobs = this.tables.ac_native_execution_jobs.filter(row => row.intent_id === intent.id && row.id !== job.id);
    const qaJobs = (this.tables.ac_native_qa_jobs ?? []).filter(row => row.intent_id === intent.id);
    const planningCalls = new Set(this.tables.ac_semantic_planning_calls?.filter(row => row.intent_id === intent.id).map(row => row.id));
    const planningJobs = (this.tables.ac_native_planning_jobs ?? []).filter(row => planningCalls.has(row.id));
    const operationExists = (table: string) => (this.tables[table] ?? []).some(row => row.id === job.id || row.intent_id === intent.id);
    return [{
      ...job,
      grant_state: grant.state, grant_resource_kind: grant.resource_kind, grant_project_id: grant.project_id,
      grant_context_id: grant.context_id, grant_intent_id: grant.intent_id, grant_epoch: grant.manager_epoch,
      grant_account_id: grant.account_id, grant_profile_id: grant.profile_id, grant_role: grant.role,
      physical_receipt: grant.physical_receipt ?? null,
      principal_id: intent.principal_id, parent_intent_id: intent.parent_intent_id ?? null,
      intent_state: intent.state, intent_command: intent.command, intent_digest: intent.digest, intent_epoch: intent.manager_epoch,
      account_provider: account.provider, account_mode: account.mode, account_resource_identity: account.resource_identity,
      profile_model: profile.model, profile_effort: profile.effort, profile_role: profile.role,
      personal: this.personalActivation(), dedicated_context: dedicatedContexts.has(contextId), main_context_id: mainContext?.id ?? null,
      cancellation_requested: (this.tables.ac_plan_cancellations ?? []).some(row => row.intent_id === intent.id),
      has_operation: operationExists('ac_operations'), has_stage_operation: operationExists('ac_stage_operations'),
      has_active_admission: (this.tables.ac_native_resource_admissions ?? []).some(row =>
        (row.job_id === job.id || row.grant_id === grant.id) && row.state !== 'canceled'),
      has_other_job: otherExecutionJobs.length > 0 || qaJobs.length > 0 || planningJobs.length > 0,
      has_child_intent: this.tables.ac_intents.some(row => row.parent_intent_id === intent.id),
      has_unresolved_job: [...otherExecutionJobs, ...qaJobs].some(row => row.state === 'uncertain' || row.state === 'running')
        || planningJobs.some(row => row.state === 'prepared' || row.state === 'uncertain' || row.state === 'running'),
      has_open_grant: this.tables.ac_capacity_grants.some(row => row.intent_id === intent.id && row.id !== grant.id && row.state !== 'released'),
    }];
  }
  private personalActivation() {
    return (this.tables.ac_installation_activation ?? []).some(row => row.id === 1 && row.mode === 'personal');
  }
  query(sql: string, params: unknown[] = []) {
    const text = sql.replace(/\s+/g, ' ').trim();
    const selected = (rows: Row[]) => ({rows, rowCount: rows.length});
    const wrote = (count: number) => ({rows: [] as Row[], rowCount: count});
    if (text === 'BEGIN') {
      assert.equal(this.beforeTransaction, undefined);
      this.beforeTransaction = structuredClone(this.tables);
      return selected([]);
    }
    if (text === 'COMMIT' || text === 'ROLLBACK') {
      assert.ok(this.beforeTransaction);
      if (text === 'ROLLBACK') this.tables = this.beforeTransaction;
      this.beforeTransaction = undefined;
      return selected([]);
    }
    if (/^SET LOCAL lock_timeout = /.test(text)) return selected([]);
    if (text.startsWith('SELECT * FROM ac_recovery_inventory_policy')) return selected([{singleton: true, required: false}]);
    if (text.startsWith('SELECT j.*, g.state grant_state,g.resource_kind grant_resource_kind,')) {
      return selected(this.unstartedExamRows(params[0], params[1]));
    }
    if (text === "SELECT 1 FROM ac_installation_activation WHERE id=1 AND mode='personal'") {
      return selected(this.personalActivation() ? [{present: 1}] : []);
    }
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
        launch_digest: null, receipt: null,
      });
      return wrote(1);
    }
    if (text === "UPDATE ac_native_execution_jobs SET state='failed',receipt=$2 WHERE id=$1") {
      const job = this.one('ac_native_execution_jobs', String(params[0]));
      job.state = 'failed';
      job.receipt = params[1];
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
    if (text.startsWith('SELECT * FROM ac_capacity_grants WHERE id=$1')) {
      const grant = this.tables.ac_capacity_grants?.find(row => row.id === params[0]);
      return selected(grant ? [{...grant}] : []);
    }
    if (text.startsWith('SELECT exhausted_until FROM ac_accounts WHERE id=$1')) {
      const account = this.tables.ac_accounts?.find(row => row.id === params[0]);
      return selected(account ? [{exhausted_until: account.exhausted_until ?? null}] : []);
    }
    if (text.startsWith('UPDATE ac_accounts SET exhausted_until=$2 WHERE id=$1')) {
      let account = this.tables.ac_accounts?.find(row => row.id === params[0]);
      if (!account) {
        account = {id: params[0], exhausted_until: params[1]};
        this.insert('ac_accounts', account);
      } else {
        account.exhausted_until = params[1];
      }
      return wrote(1);
    }
    if (text.startsWith('SELECT j.*,g.state grant_state,g.physical_receipt,g.manager_epoch grant_epoch')) {
      const job = this.tables.ac_native_execution_jobs?.find(row => row.id === params[0] && row.context_id === params[1]);
      const grant = this.tables.ac_capacity_grants?.find(row => row.id === job?.grant_id);
      const intent = this.tables.ac_intents?.find(row => row.id === job?.intent_id);
      return job && grant && intent ? selected([{
        ...job,
        grant_state: grant.state,
        physical_receipt: grant.physical_receipt ?? null,
        grant_epoch: grant.manager_epoch,
        grant_intent: grant.intent_id,
        grant_context: grant.context_id,
        grant_account: grant.account_id,
        grant_profile: grant.profile_id,
        grant_role: grant.role,
        resource_kind: grant.resource_kind,
        parent_intent_id: intent.parent_intent_id ?? null,
      }]) : selected([]);
    }
    if (text.startsWith('SELECT * FROM ac_native_terminal_retirements WHERE job_id=$1')) {
      const row = this.tables.ac_native_terminal_retirements?.find(item => item.job_id === params[0]);
      return selected(row ? [{...row}] : []);
    }
    if (text.startsWith('INSERT INTO ac_native_terminal_retirements')) {
      this.insert('ac_native_terminal_retirements', {job_id: params[0], binding: params[1], state: 'prepared', proof: null});
      return wrote(1);
    }
    if (text.startsWith("UPDATE ac_native_terminal_retirements SET state='removed',proof=$2 WHERE job_id=$1")) {
      const row = this.tables.ac_native_terminal_retirements?.find(item => item.job_id === params[0] && item.state === 'prepared');
      if (!row) return wrote(0);
      row.state = 'removed';
      row.proof = params[1];
      return wrote(1);
    }
    if (text.startsWith('INSERT INTO ac_audit')) return wrote(1);
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
    if (text.startsWith('SELECT intent_id FROM ac_native_execution_jobs WHERE id=$1 AND context_id=$2')) {
      const job = this.tables.ac_native_execution_jobs?.find(row => row.id === params[0] && row.context_id === params[1]);
      return selected(job ? [{intent_id: job.intent_id}] : []);
    }
    if (text.startsWith('SELECT * FROM ac_native_execution_jobs WHERE id=$1')) {
      const job = this.tables.ac_native_execution_jobs?.find(row => row.id === params[0]);
      return selected(job ? [{...job}] : []);
    }
    if (text.startsWith('SELECT a.id FROM ac_accounts a JOIN ac_capacity_grants')) {
      const grant = this.tables.ac_capacity_grants?.find(row => row.id === params[0]);
      return selected(grant ? [{id: grant.account_id}] : []);
    }
    if (text.startsWith('SELECT g.*,a.provider,a.mode,a.enabled account_enabled,')) {
      const grant = this.tables.ac_capacity_grants?.find(row => row.id === params[0]);
      const account = this.tables.ac_accounts?.find(row => row.id === grant?.account_id);
      const profile = this.tables.ac_profiles?.find(row => row.id === grant?.profile_id && row.account_id === account?.id);
      const access = this.tables.ac_account_access?.find(row => row.account_id === account?.id && row.project_id === grant?.project_id);
      const quota = this.tables.ac_quota_observations?.find(row => row.account_id === account?.id);
      if (!grant || !account || !profile || !access || !quota) return selected([]);
      return selected([{
        ...grant, provider: account.provider, mode: account.mode, eligibility: account.eligibility,
        resource_identity: account.resource_identity, account_enabled: account.enabled, profile_enabled: profile.enabled,
        model: profile.model, effort: profile.effort, profile_role: profile.role, quota_status: quota.status,
      }]);
    }
    if (text.includes('ac_provider_eligibility_assessments')) {
      const grant = this.tables.ac_capacity_grants?.find(row => row.id === params[0] && row.state === 'uncertain');
      return selected(grant ? [{...grant, model: grant.model, effort: grant.effort, quota_status: 'available', quota_exhausted: false}] : []);
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
    if (text === "UPDATE ac_intents SET state=$3 WHERE id=$1 AND context_id=$2 AND state='accepted'") {
      const intent = this.tables.ac_intents?.find(row => row.id === params[0] && row.context_id === params[1] && row.state === 'accepted');
      if (!intent) return wrote(0);
      intent.state = params[2];
      return wrote(1);
    }
    if (text === "SELECT id FROM ac_intents WHERE context_id=$1 AND parent_intent_id IS NULL AND state NOT IN ('done','review','failed','canceled') ORDER BY created_at,id") {
      const pending = (this.tables.ac_intents ?? []).filter(row => row.context_id === params[0] && row.parent_intent_id == null
        && !['done', 'review', 'failed', 'canceled'].includes(String(row.state)));
      return selected(pending.sort((a, b) => Number(a.created_at ?? 0) - Number(b.created_at ?? 0) || String(a.id).localeCompare(String(b.id)))
        .map(row => ({id: row.id})));
    }
    if (text === "UPDATE ac_checkpoints SET snapshot=jsonb_set(snapshot,'{pendingIntentIds}',$2::jsonb),updated_at=now() WHERE context_id=$1") {
      const checkpoint = this.tables.ac_checkpoints?.find(row => row.context_id === params[0]);
      if (!checkpoint) return wrote(0);
      checkpoint.snapshot = {...(checkpoint.snapshot as Row), pendingIntentIds: JSON.parse(String(params[1]))};
      return wrote(1);
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
      if (this.lockErrorOnNextLock) {
        const error = this.lockErrorOnNextLock;
        this.lockErrorOnNextLock = null;
        throw error;
      }
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
  memory.insert('ac_installation_activation', {id: 1, mode: 'personal'});
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
  const coOwner = 'exam-co-owner-' + randomUUID();
  const account = randomUUID();
  const profile = randomUUID();
  const context = randomUUID();
  const instance = randomUUID();
  const base = 'e'.repeat(40);
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
    memory.insert('ac_memberships', {project_id: project, principal_id: coOwner, role: 'owner'});
    memory.insert('ac_project_repositories', {project_id: project, repo});
    memory.insert('ac_contexts', {id: context, project_id: project, paused: false, archived: false});
    memory.insert('ac_managers', {context_id: context, instance_id: instance, epoch: 1, lease_until: Date.now() + 60_000});
    memory.insert('ac_admission_control', {id: 1, enabled: true});
    memory.insert('ac_accounts', {
      id: account, provider: 'claude', mode: 'subscription_cli', resource_identity: 'claude:' + 'a'.repeat(64),
      enabled: true, eligibility: 'documented_supported',
    });
    memory.insert('ac_account_access', {account_id: account, project_id: project});
    memory.insert('ac_quota_observations', {account_id: account, status: 'available'});
    memory.insert('ac_profiles', {id: profile, account_id: account, role: 'specialist', model: 'fixture-model', effort: 'medium', enabled: true});
    const reviewerProfile = randomUUID();
    memory.insert('ac_profiles', {id: reviewerProfile, account_id: account, role: 'reviewer', model: 'fixture-model', effort: 'medium', enabled: true});
    const authority = Authority.parse({contextId: context, instanceId: instance, epoch: 1});
    function reserveAttempt(role: 'specialist' | 'reviewer', task: string, intentId = randomUUID()) {
      const grantId = randomUUID();
      const command = {
        schemaVersion: 1, intentId, deliveryAttemptId: randomUUID(), contextId: context, policyRevision: 1, action: 'plan.start',
        payload: {workflow: 'security-verify-readonly-v1', messageRef: `verify:${project}:${base}`, projectId: project, commit: base},
      };
      memory.insert('ac_intents', {
        id: intentId, context_id: context, principal_id: principal, manager_epoch: authority.epoch,
        command, digest: digest(command), state: 'accepted', parent_intent_id: null,
        created_at: Date.UTC(2026, 0, 1) + 1000 * (memory.tables.ac_intents?.length ?? 0),
      });
      memory.insert('ac_capacity_grants', {
        id: grantId, intent_id: intentId, context_id: context, project_id: project, manager_epoch: authority.epoch,
        account_id: account, profile_id: role === 'specialist' ? profile : reviewerProfile, role, model: 'fixture-model', effort: 'medium',
        resource_kind: 'model', state: 'reserved',
      });
      return NativeExecutionRequest.parse({
        jobId: randomUUID(), intentId, grantId, sessionId: randomUUID(), base, role, task,
        writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
      });
    }
    const keys = generateKeyPairSync('ed25519');
    const image = 'sha256:' + 'c'.repeat(64);
    const created: {name: string; env: string[]; binds: string[]}[] = [];
    let renews = 0;
    let sawExpiresZero = false;
    let sequence = 0;
    let networkInspectionUncertain = false;
    const makeDaemon = () => ({
      imagePresent: async () => true,
      inspect: async () => null,
      inspectNamedPrivateNetwork: async () => {
        if (networkInspectionUncertain) throw new Refusal('DOCKER_NETWORK_UNCERTAIN');
        return null;
      },
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
    Object.defineProperty(supervisor, 'doc' + 'ker', {value: makeDaemon()});

    // 1) Token perto de vencer: grava expiresAt 0, renova no lugar, NÃO monta /account, e grava oauthAccessToken no launch.json assinado.
    const input1 = reserveAttempt('specialist', 'Leia o repositório.', 'f0000000-0000-4000-8000-000000000001');
    const job1 = input1.jobId;
    lastJobId = job1;
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
    const input2 = reserveAttempt('reviewer', 'Revise o repositório.', '10000000-0000-4000-8000-000000000002');
    const job2 = input2.jobId;
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
    const sequenceBeforeFailures = sequence;
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
    Object.defineProperty(staleSupervisor, 'doc' + 'ker', {value: makeDaemon()});

    const staleInput = reserveAttempt('specialist', 'Exame stale.');
    const {jobId: staleJob, grantId: staleGrant} = staleInput;
    const pendingIntents = [input1.intentId, input2.intentId];
    const checkpoint = {context_id: context, snapshot: {pendingIntentIds: [...pendingIntents, staleInput.intentId]}};
    memory.insert('ac_checkpoints', checkpoint);
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
    assert.equal(memory.one('ac_native_execution_jobs', staleJob).state, 'failed');
    assert.equal(memory.one('ac_intents', staleInput.intentId).state, 'failed');
    assert.deepEqual(memory.tables.ac_checkpoints[0]?.snapshot, {pendingIntentIds: pendingIntents});
    await assert.rejects(() => lstat(join(spool, staleJob)), {code: 'ENOENT'});
    await assert.rejects(
      () => staleSupervisor.recoverUnstartedExam(coOwner, authority, staleJob),
      (error: unknown) => error instanceof Refusal && error.code === 'NATIVE_EXECUTION_SCOPE_MISMATCH',
    );
    assert.deepEqual(await staleSupervisor.recoverUnstartedExam(principal, authority, staleJob), {
      state: 'failed', retirement: 'removed', intentState: 'failed', receipt: memory.one('ac_native_execution_jobs', staleJob).receipt,
    });
    // A recuperação genérica mantém a liberação mesmo sem request.json para reproduzir o resultado.
    const rec = await staleSupervisor.recover(principal, authority, staleJob);
    assert.equal(rec.grant, 'released');
    assert.equal(rec.interval, 'terminal_evidence_missing');

    // 3b) EXAM_LOGIN_BUSY libera o grant depois de o job virar uncertain.
    const busyInput = reserveAttempt('specialist', 'Exame busy.');
    const {jobId: busyJob, grantId: busyGrant} = busyInput;
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
    const missingTokenInput = reserveAttempt('specialist', 'Exame symlink.');
    await assert.rejects(
      () => staleSupervisor.start(principal, authority, missingTokenInput),
      (error: unknown) => error instanceof Refusal && error.code === 'EXAM_LOGIN_STALE',
    );
    assert.equal(created.length, createdBeforeFailures);
    assert.equal(memory.one('ac_capacity_grants', missingTokenInput.grantId).state, 'released');

    // 3d) Inspeção inconclusiva preserva a liberação e deixa a liquidação disponível para recuperação.
    await rm(credential);
    await writeFile(credential, JSON.stringify(staleBefore), {mode: 0o600});
    const pendingInput = reserveAttempt('specialist', 'Exame com inspeção de rede indisponível.');
    const pendingSnapshot = {pendingIntentIds: [...pendingIntents, pendingInput.intentId]};
    memory.tables.ac_checkpoints[0]!.snapshot = structuredClone(pendingSnapshot);
    const pendingPhysical = {
      executionStarted: false, jobId: pendingInput.jobId, containerId: null, networkId: null,
      synthetic: false, modelInference: false, reason: 'exam_login_stale',
    };
    networkInspectionUncertain = true;
    await assert.rejects(
      () => staleSupervisor.start(principal, authority, pendingInput),
      (error: unknown) => error instanceof UnstartedExamRetirementPending && error.jobId === pendingInput.jobId,
    );
    const pendingGrant = memory.one('ac_capacity_grants', pendingInput.grantId);
    assert.equal(pendingGrant.state, 'released');
    assert.deepEqual(pendingGrant.physical_receipt, pendingPhysical);
    const pendingJob = memory.one('ac_native_execution_jobs', pendingInput.jobId);
    assert.equal(pendingJob.state, 'uncertain');
    assert.equal(pendingJob.receipt, null);
    assert.equal(memory.one('ac_intents', pendingInput.intentId).state, 'accepted');
    assert.deepEqual(memory.tables.ac_checkpoints[0]?.snapshot, pendingSnapshot);
    const pendingRecovery = await staleSupervisor.recover(principal, authority, pendingInput.jobId);
    assert.equal(pendingRecovery.grant, 'released');
    assert.equal(pendingRecovery.interval, 'network_unproven');
    networkInspectionUncertain = false;
    const settled = await staleSupervisor.recoverUnstartedExam(principal, authority, pendingInput.jobId);
    const {state, receipt} = memory.one('ac_native_execution_jobs', pendingInput.jobId);
    assert.equal(state, 'failed');
    assert.ok(receipt && typeof receipt === 'object' && 'payload' in receipt && 'signature' in receipt);
    assert.equal(verify(null, Buffer.from('agent-control:native-execution-receipt:v1\n' + canonical(receipt.payload)),
      keys.publicKey, Buffer.from(String(receipt.signature), 'hex')), true);
    assert.deepEqual(settled, {state: 'failed', retirement: 'removed', intentState: 'failed', receipt});
    assert.equal(memory.one('ac_intents', pendingInput.intentId).state, 'failed');
    assert.equal(memory.tables.ac_native_terminal_retirements.find(row => row.job_id === pendingInput.jobId)?.state, 'removed');
    assert.deepEqual(memory.tables.ac_checkpoints[0]?.snapshot, {pendingIntentIds: pendingIntents});
    await assert.rejects(() => lstat(join(spool, pendingInput.jobId)), {code: 'ENOENT'});
    assert.equal(created.length, createdBeforeFailures);
    assert.equal(sequence, sequenceBeforeFailures);
  } finally {
    server.close();
    homes.mock.restore();
    snaps.mock.restore();
    await rm(area, {recursive: true, force: true});
  }
});

test('liquidação Claude no PostgreSQL reverte falha no checkpoint e pode ser retomada', {skip: !process.env.AC_TEST_DATABASE_URL}, async () => {
  const fixture = await isolatedDatabase(process.env.AC_TEST_DATABASE_URL!, 'examsettle');
  const db = new Ledger(fixture.url);
  const area = await realpath(await mkdtemp(join(tmpdir(), 'ac-exam-settle-')));
  const repo = join(area, 'repo');
  const spool = join(area, 'spool');
  const accounts = join(area, 'accounts');
  const socketPath = join(area, 'docker.sock');
  const image = 'sha256:' + 'c'.repeat(64);
  const dockerRequests: string[] = [];
  const server = createServer((req, res) => {
    dockerRequests.push(`${req.method} ${req.url}`);
    res.statusCode = req.method === 'GET' && req.url === `/v1.44/images/${image}/json` ? 200 : 404;
    res.end('{}');
  });
  try {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
    for (const path of [repo, spool, accounts]) await mkdir(path, {mode: 0o700});
    await db.migrate();
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    const project = randomUUID(), account = randomUUID(), profile = randomUUID();
    const principal = 'exam-owner', coOwner = 'exam-co-owner';
    const subject = 'a'.repeat(64), base = 'e'.repeat(40), model = 'claude-sonnet-5-5';
    await db.pool.query('INSERT INTO ac_projects(id,label) VALUES($1,$2)', [project, 'Synthetic exam']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner'),($1,$3,'owner')", [project, principal, coOwner]);
    await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)', [project, repo]);
    await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",
      [project, digest({}), principal]);
    const capacity = new Capacity(db);
    await capacity.addAccount(principal, project, {
      id: account, provider: 'claude', label: 'Synthetic exam', resourceIdentity: 'claude:' + subject,
      mode: 'subscription_cli', eligibility: 'documented_supported', eligibilitySource: 'https://example.invalid/fixture', maxConcurrent: 1,
    });
    await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role) VALUES($1,$2,$3,'medium','specialist')", [profile, account, model]);
    await capacity.observeQuota(principal, account, {status: 'available', source: 'https://example.invalid/fixture', ttlSeconds: 3600});
    await new AccountHomes(db, accounts, [repo]).initialize(principal, project, account);
    const credential = join(accounts, account, '.credentials.json');
    await writeFile(credential, JSON.stringify({
      claudeAiOauth: {accessToken: 'fixture-access-only', refreshToken: 'fixture-refresh-only', expiresAt: Date.now() - 10_000},
    }), {mode: 0o600});
    const context = await db.createContext(principal, project, randomUUID());
    const authority = await db.acquire(principal, context, randomUUID(), 'exam-fixture', 60);
    const keys = generateKeyPairSync('ed25519');
    const supervisor = new NativeExecutionSupervisor(db, {
      id: 'claude-native-execution', provider: 'claude', repository: repo, protectedRepositories: [],
      workerImage: image, toolsImage: image, hostRoot: spool, accountRoot: accounts, socketPath,
      signingKeyPem: keys.privateKey.export({format: 'pem', type: 'pkcs8'}).toString(),
      providerNetworkId: 'd'.repeat(64), accountSubjects: [{accountId: account, subjectDigest: subject}],
      workerEnv: [], toolsEnv: [],
      examLoginRenew: async () => { throw new Error('EXAM_LOGIN_RENEW_FAILED'); },
    }, {assertAdmission: async () => {}});

    async function insertIntent(intentId: string, createdAt: string) {
      const command = {
        schemaVersion: 1, intentId, deliveryAttemptId: randomUUID(), contextId: context, policyRevision: 1, action: 'plan.start',
        payload: {workflow: 'security-verify-readonly-v1', messageRef: `verify:${project}:${base}`, projectId: project, commit: base},
      };
      await db.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9)`,
      [intentId, context, principal, digest(command), command, randomUUID(), randomUUID(), authority.epoch, createdAt]);
    }
    const earlyLowerId = '90000000-0000-4000-8000-000000000001';
    const earlyHigherId = 'f0000000-0000-4000-8000-000000000002';
    const lateLowerId = '10000000-0000-4000-8000-000000000003';
    const intentId = randomUUID(), grantId = randomUUID(), jobId = randomUUID();
    await insertIntent(lateLowerId, '2026-01-02T00:00:00Z');
    await insertIntent(earlyHigherId, '2026-01-01T00:00:00Z');
    await insertIntent(earlyLowerId, '2026-01-01T00:00:00Z');
    await insertIntent(intentId, '2026-01-03T00:00:00Z');
    const remaining = [earlyLowerId, earlyHigherId, lateLowerId];
    // The ledger contains a pending intent absent from this out-of-order checkpoint.
    const snapshot = {planRevision: 0, pendingIntentIds: [earlyHigherId, intentId, earlyLowerId]};
    await db.pool.query('INSERT INTO ac_checkpoints(context_id,epoch,snapshot) VALUES($1,$2,$3)', [context, authority.epoch, snapshot]);
    const input = NativeExecutionRequest.parse({
      jobId, intentId, grantId, sessionId: randomUUID(), base, role: 'specialist', task: 'Exame sintético',
      writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    const insertGrant = (request: typeof input, grantedIntentId: string) =>
      db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,'specialist',$8,1,1,$9,false,'reserved')`,
      [request.grantId, randomUUID(), grantedIntentId, context, authority.epoch, account, profile, project, digest(request)]);
    await insertGrant(input, intentId);
    const readGrant = async (id: string = grantId) => (await db.pool.query(
      'SELECT state,physical_receipt,intent_id,request_digest FROM ac_capacity_grants WHERE id=$1', [id])).rows[0];
    const readJob = async () => (await db.pool.query(
      'SELECT state,receipt,grant_id,intent_id FROM ac_native_execution_jobs WHERE id=$1', [jobId])).rows[0];
    const readIntent = async () => (await db.pool.query('SELECT state FROM ac_intents WHERE id=$1', [intentId])).rows[0].state;
    const readCheckpoint = async () => (await db.pool.query('SELECT * FROM ac_checkpoints WHERE context_id=$1', [context])).rows[0];
    const readRetirement = async () => (await db.pool.query('SELECT state,proof FROM ac_native_terminal_retirements WHERE job_id=$1', [jobId])).rows[0];
    const refuses = (code: string) => (error: unknown) => error instanceof Refusal && error.code === code;

    await assert.rejects(() => supervisor.start(coOwner, authority, input), refuses('NATIVE_EXECUTION_SCOPE_MISMATCH'));
    await assert.rejects(() => supervisor.start(principal, {...authority, instanceId: randomUUID()}, input), refuses('STALE_MANAGER'));
    const mismatchedInput = NativeExecutionRequest.parse({...input, grantId: randomUUID(), intentId: earlyLowerId});
    // Match the request digest at insertion, keeping the grant bound to a different accepted intent.
    await insertGrant(mismatchedInput, earlyHigherId);
    const mismatchedGrant = {
      state: 'reserved', physical_receipt: null, intent_id: earlyHigherId, request_digest: digest(mismatchedInput),
    };
    assert.deepEqual(await readGrant(mismatchedInput.grantId), mismatchedGrant);
    const savedCheckpoint = await readCheckpoint();
    assert.deepEqual(savedCheckpoint.snapshot, snapshot);
    await assert.rejects(() => supervisor.start(principal, authority, mismatchedInput), refuses('NATIVE_EXECUTION_NOT_ELIGIBLE'));
    assert.deepEqual(await readCheckpoint(), savedCheckpoint);
    assert.deepEqual(await readGrant(mismatchedInput.grantId), mismatchedGrant);
    assert.equal(await readJob(), undefined);
    const grantBinding = {intent_id: intentId, request_digest: digest(input)};
    assert.deepEqual(await readGrant(), {...grantBinding, state: 'reserved', physical_receipt: null});
    assert.equal(dockerRequests.length, 0);

    // The checkpoint is written after the job receipt, retirement and intent state.
    await db.pool.query(`CREATE FUNCTION fixture_fail_exam_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture checkpoint write failed'; END $$;
      CREATE TRIGGER fixture_fail_exam_checkpoint AFTER UPDATE ON ac_checkpoints
      FOR EACH ROW EXECUTE FUNCTION fixture_fail_exam_checkpoint()`);
    await assert.rejects(() => supervisor.start(principal, authority, input),
      (error: unknown) => error instanceof UnstartedExamRetirementPending && error.jobId === jobId);
    const physical = {
      executionStarted: false, jobId, containerId: null, networkId: null,
      synthetic: false, modelInference: false, reason: 'exam_login_stale',
    };
    const releasedGrant = {...grantBinding, state: 'released', physical_receipt: physical};
    const jobBinding = {grant_id: grantId, intent_id: intentId};
    const assertUnsettled = async () => {
      assert.deepEqual(await readGrant(), releasedGrant);
      assert.deepEqual(await readJob(), {...jobBinding, state: 'uncertain', receipt: null});
      assert.equal(await readIntent(), 'accepted');
      assert.equal(await readRetirement(), undefined);
      assert.deepEqual(await readCheckpoint(), savedCheckpoint);
    };
    await assertUnsettled();
    await assert.rejects(() => supervisor.recoverUnstartedExam(principal, authority, jobId), /fixture checkpoint write failed/);
    await assertUnsettled();
    await db.pool.query('DROP TRIGGER fixture_fail_exam_checkpoint ON ac_checkpoints');

    // An admission can precede its own job row and still block recovery through the grant.
    const admissionJobId = randomUUID();
    assert.notEqual(admissionJobId, jobId);
    await db.pool.query(`INSERT INTO ac_native_resource_admissions(job_id,grant_id,context_id,manager_epoch,authority_id,names,admission_id,state_root,state,reason)
      VALUES($1,$2,$3,$4,'fixture',$5,$6,$7,'admitted','admitted')`,
    [admissionJobId, grantId, context, authority.epoch,
      JSON.stringify([`ac-native-tools-${admissionJobId}`, `ac-native-worker-${admissionJobId}`]), randomUUID(), area]);
    const readAdmission = async () => (await db.pool.query(
      'SELECT * FROM ac_native_resource_admissions WHERE grant_id=$1', [grantId])).rows[0];
    const savedAdmission = await readAdmission();
    assert.equal(savedAdmission?.job_id, admissionJobId);
    assert.equal(savedAdmission.state, 'admitted');
    assert.equal(savedAdmission.reason, 'admitted');
    await assert.rejects(() => supervisor.recoverUnstartedExam(principal, authority, jobId), refuses('NATIVE_RETIREMENT_UNCONFIRMED'));
    assert.deepEqual(await readAdmission(), savedAdmission);
    await assertUnsettled();
    assert.deepEqual((await db.pool.query('DELETE FROM ac_native_resource_admissions WHERE job_id=$1 RETURNING job_id',
      [admissionJobId])).rows, [{job_id: admissionJobId}]);
    assert.equal(await readAdmission(), undefined);

    const settled = await supervisor.recoverUnstartedExam(principal, authority, jobId);
    const {state, receipt, grant_id, intent_id} = await readJob();
    assert.equal(state, 'failed');
    assert.deepEqual({grant_id, intent_id}, jobBinding);
    assert.equal(receipt.payload.executionStarted, false);
    assert.equal(receipt.payload.physicalDigest, digest(physical));
    assert.equal(verify(null, Buffer.from('agent-control:native-execution-receipt:v1\n' + canonical(receipt.payload)),
      keys.publicKey, Buffer.from(receipt.signature, 'hex')), true);
    assert.deepEqual(settled, {state: 'failed', retirement: 'removed', intentState: 'failed', receipt});
    assert.equal(await readIntent(), 'failed');
    assert.equal((await readRetirement()).state, 'removed');
    assert.deepEqual((await readCheckpoint()).snapshot, {...snapshot, pendingIntentIds: remaining});
    assert.deepEqual(await readGrant(), releasedGrant);
    await assert.rejects(() => lstat(join(spool, jobId)), {code: 'ENOENT'});
    assert.deepEqual(dockerRequests.filter(request => !request.startsWith('GET ')), []);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
    await fixture.close();
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
      anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
      anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
      claudeCodeUseBedrock: process.env.CLAUDE_CODE_USE_BEDROCK ?? null,
      claudeCodeUseVertex: process.env.CLAUDE_CODE_USE_VERTEX ?? null,
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
    process.env.ANTHROPIC_AUTH_TOKEN = 'forbidden-auth-token';
    process.env.ANTHROPIC_BASE_URL = 'https://forbidden.proxy.invalid';
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    process.env.CLAUDE_CONFIG_DIR = '/forbidden/config/dir';

    const prepared = await prepareClaudeExamWorkerEnv({
      oauthAccessToken: accessToken,
      credentialSnapshotTag: snapshotTag,
      execToken,
      tmpRoot: tmpArea,
    });
    assert.equal(prepared.claudeBin, EXAM_CLAUDE_WRAPPER_BIN);
    assert.equal((createClaudeWorkerRunner(prepared.claudeBin, 10_000) as unknown as {bin: string}).bin, EXAM_CLAUDE_WRAPPER_BIN);

    assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, accessToken);
    assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(process.env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(process.env.CLAUDE_CODE_USE_BEDROCK, undefined);
    assert.equal(process.env.CLAUDE_CODE_USE_VERTEX, undefined);

    const filesInTmp = await listFilesRecursive(tmpArea);
    assert.equal(filesInTmp.some(f => f.endsWith('.credentials.json')), false);
    assert.equal(filesInTmp.some(f => f.endsWith('.claude.json')), false);
    assert.equal(filesInTmp.some(f => f.endsWith('.cjs')), false);
    const settingsFiles = filesInTmp.filter(f => f.endsWith('settings.json'));
    assert.equal(settingsFiles.length, 1);

    const hostWrapperBin = await installExamClaudeWrapper(area, fakeClaude);
    const runner = new ClaudeCliRunner({bin: hostWrapperBin, timeoutMs: 10_000});
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
      anthropicAuthToken: string | null;
      anthropicBaseUrl: string | null;
      claudeCodeUseBedrock: string | null;
      claudeCodeUseVertex: string | null;
      home: string | null;
    };
    assert.equal(trace.oauthToken, accessToken);
    assert.equal(trace.claudeConfigDir, null);
    assert.equal(trace.anthropicApiKey, null);
    assert.equal(trace.anthropicAuthToken, null);
    assert.equal(trace.anthropicBaseUrl, null);
    assert.equal(trace.claudeCodeUseBedrock, null);
    assert.equal(trace.claudeCodeUseVertex, null);
    assert.equal(trace.home, prepared.examHome);
    assert.equal(trace.argv.includes(accessToken), false);
    assert.equal(ran.output.includes(accessToken), false);
    assert.equal(JSON.parse(ran.output).leaked, '[REDACTED]');

    const execResultPath = join(area, 'execution-result.json');
    await writeFile(execResultPath, JSON.stringify({
      schemaVersion: 1,
      jobId: randomUUID(),
      output: ran.output,
      normalizedTokensUsed: ran.tokensUsed,
      usageWindows: ran.usageWindows,
      nativeSessionId: ran.nativeSessionId,
      failureCode: null,
      exitCode: 0,
    }), {mode: 0o600});
    assert.equal((await readFile(execResultPath, 'utf8')).includes(accessToken), false);

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

test('launch.json é apagado ao terminar, retirar, falhar antes do launch e no reconcile após reinício, e falha em stageDesignCapturesForJob libera grant', async () => {
  const {ledger, memory} = substituteLedger();
  const area = await realpath(await mkdtemp(join(tmpdir(), 'ac-exam-lifecycle-')));
  const repo = join(area, 'repo');
  const spool = join(area, 'spool');
  const accounts = join(area, 'accounts');
  const capturesRoot = join(area, 'captures');
  const project = randomUUID();
  const principal = 'exam-life-' + randomUUID();
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
  let lastJobId = '';
  let lastLaunchHash = '';
  let workerCreatedConfig: {Env?: string[]; HostConfig?: {Binds?: string[]}} | undefined;
  let toolsCreatedConfig: {Env?: string[]; HostConfig?: {Binds?: string[]}} | undefined;
  const createdConfigs: Array<{name: string; configuration: unknown}> = [];
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

  const prevCaptureDir = process.env.AC_DESIGN_CAPTURE_DIR;
  const prevCaptureRun = process.env.AC_DESIGN_CAPTURE_RUN;
  const accessSecret = 'fixture-access-lifecycle-secret-9988';
  const refreshSecret = 'fixture-refresh-lifecycle-secret-9988';
  try {
    await new Promise<void>(resolve => server.listen(sockPath, resolve));
    for (const path of [repo, spool, accounts, join(accounts, account), capturesRoot]) {
      await mkdir(path, {recursive: true, mode: 0o700});
    }
    await writeFile(join(accounts, account, '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: accessSecret,
        refreshToken: refreshSecret,
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
    memory.insert('ac_intents', {id: intent, context_id: context, principal_id: principal, command: {payload: {workflow: 'design-readonly-v1'}}});
    const authority = Authority.parse({contextId: context, instanceId: instance, epoch: 1});
    const keys = generateKeyPairSync('ed25519');
    const image = 'sha256:' + 'c'.repeat(64);
    const containers = new Map<string, Row>();
    const networks = new Set<string>();
    let sequence = 0;
    const makeDaemon = () => ({
      imagePresent: async () => true,
      inspect: async (idOrName: string) => containers.get(idOrName) ?? null,
      inspectPrivateNetwork: async (id: string) => networks.has(id) ? ({
        Id: id,
        Name: `ac-native-exec-${lastJobId}`,
        Internal: true,
        Labels: {'agent-control.contract': 'native-execution-v1', 'agent-control.job': lastJobId, 'agent-control.launch': lastLaunchHash},
        Containers: Object.keys(containers.size ? {[toolsContainerId]: 1} : {}).length === 0 ? {} : (containers.has(toolsContainerId) || containers.has(workerContainerId) ? {[toolsContainerId]: {IPv4Address: '172.20.0.2/16'}, [workerContainerId]: {IPv4Address: '172.20.0.3/16'}} : {}),
      }) : null,
      stop: async () => {},
      remove: async (id: string) => {
        for (const [key, item] of [...containers]) {
          if (key === id || item.Id === id) containers.delete(key);
        }
      },
      removePrivateNetwork: async (id: string) => { networks.delete(id); },
      logs: async () => {
        const frame = Buffer.from(`worker log leaked ${accessSecret}\n`, 'utf8');
        const header = Buffer.alloc(8);
        header[0] = 1;
        header.writeUInt32BE(frame.length, 4);
        return Buffer.concat([header, frame]);
      },
      createPrivateNetwork: async () => {
        networkContainerId = `${(++sequence).toString(16).padStart(2, '0')}${'ab'.repeat(31)}`;
        networks.add(networkContainerId);
        return networkContainerId;
      },
      create: async (name: string, configuration: {Image?: string; Labels?: Record<string, string>; Env?: string[]; HostConfig?: {Binds?: string[]}}) => {
        const id = `${(++sequence).toString(16).padStart(2, '0')}${'cd'.repeat(31)}`;
        createdConfigs.push({name, configuration});
        const record: Row = {
          Id: id,
          Image: configuration.Image,
          Config: {Labels: configuration.Labels ?? {}},
          State: {Status: 'running', Running: true, ExitCode: 0, FinishedAt: '0001-01-01T00:00:00Z'},
        };
        containers.set(name, record);
        containers.set(id, record);
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

    const supervisorConfig = {
      id: 'claude-native-execution',
      workerImage: image,
      toolsImage: image,
      hostRoot: spool,
      accountRoot: accounts,
      repository: repo,
      protectedRepositories: [] as string[],
      signingKeyPem: keys.privateKey.export({format: 'pem', type: 'pkcs8'}).toString(),
      providerNetworkId: 'd'.repeat(64),
      provider: 'claude' as const,
      socketPath: sockPath,
      accountSubjects: [{accountId: account, subjectDigest: 'a'.repeat(64)}],
      workerEnv: ['AC_FIXTURE=1'],
      toolsEnv: [] as string[],
    };
    const supervisor = new NativeExecutionSupervisor(ledger, supervisorConfig, {assertAdmission: async () => {}});
    (supervisor as unknown as {identity: (client: unknown, principal: string, authority: unknown, input: {grantId: string}) => Promise<Row>}).identity = async (_client, _principal, _authority, input) => memory.one('ac_capacity_grants', input.grantId);
    Object.defineProperty(supervisor, 'doc' + 'ker', {value: makeDaemon()});

    // 1) Execução completa -> reconcile apaga launch.json e docker create nunca recebe o token; retireTerminal redaciona o log do supervisor.
    const grant1 = randomUUID();
    const job1 = randomUUID();
    memory.insert('ac_capacity_grants', {
      id: grant1, intent_id: intent, context_id: context, project_id: project, manager_epoch: authority.epoch,
      account_id: account, profile_id: profile, role: 'specialist', model: 'fixture-model', effort: 'medium',
      resource_kind: 'model', state: 'reserved',
    });
    const input1 = NativeExecutionRequest.parse({
      jobId: job1, intentId: intent, grantId: grant1, sessionId: randomUUID(), base: 'e'.repeat(40),
      role: 'specialist', task: 'Pedido de exame.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    lastJobId = job1;
    lastLaunchHash = digest(input1);
    await supervisor.start(principal, authority, input1);

    for (const item of createdConfigs) {
      assert.equal(JSON.stringify(item.configuration).includes(accessSecret), false);
      assert.equal(JSON.stringify(item.configuration).includes(refreshSecret), false);
    }
    const launchPath1 = join(spool, job1, 'input', 'launch.json');
    assert.equal((await lstat(launchPath1)).isFile(), true);

    const finishedAt = new Date().toISOString();
    (containers.get(workerContainerId)!).State = {Status: 'exited', Running: false, ExitCode: 0, FinishedAt: finishedAt};
    (containers.get(toolsContainerId)!).State = {Status: 'exited', Running: false, ExitCode: 0, FinishedAt: finishedAt};
    await writeFile(join(spool, job1, 'output', 'execution-result.json'), JSON.stringify({
      schemaVersion: 1, jobId: job1, output: '{"kind":"exame"}', normalizedTokensUsed: 10, usageWindows: null, nativeSessionId: null, failureCode: null, exitCode: 0,
    }), {mode: 0o600});

    const outcome1 = await supervisor.reconcile(principal, authority, input1);
    assert.equal(outcome1.state, 'completed');
    await assert.rejects(() => lstat(launchPath1), {code: 'ENOENT'});

    // Reinício do supervisor: se launch.json reaparecer de execução antiga já finalizada, reconcile também o apaga.
    await writeFile(launchPath1, '{"stale":true}\n', {mode: 0o600});
    const restarted = new NativeExecutionSupervisor(ledger, supervisorConfig, {assertAdmission: async () => {}});
    Object.defineProperty(restarted, 'doc' + 'ker', {value: makeDaemon()});
    const replayed = await restarted.reconcile(principal, authority, input1);
    assert.equal(replayed.state, 'completed');
    await assert.rejects(() => lstat(launchPath1), {code: 'ENOENT'});

    const retired = await restarted.retireTerminal(principal, authority, job1);
    assert.equal(retired.state, 'removed');
    await assert.rejects(() => lstat(launchPath1), {code: 'ENOENT'});
    assert.equal((await readFile(join(spool, job1, 'worker-terminal.log'), 'utf8')).includes(accessSecret), false);
    assert.equal((await readFile(join(spool, job1, 'tools-terminal.log'), 'utf8')).includes(accessSecret), false);

    // 2) Falha injetada em stageDesignCapturesForJob antes do launch -> libera o grant e apaga diretório do job.
    const badRun = randomUUID();
    const badRunDir = join(capturesRoot, badRun);
    await mkdir(badRunDir, {mode: 0o700});
    const oversizedBytes = Buffer.alloc(2_000_100, 0x61);
    const oversizedSha = createHash('sha256').update(oversizedBytes).digest('hex');
    await writeFile(join(badRunDir, `${oversizedSha}.png`), oversizedBytes, {mode: 0o600});
    await mkdir(join(badRunDir, 'stage-notes.txt'), {mode: 0o700});
    process.env.AC_DESIGN_CAPTURE_DIR = capturesRoot;
    process.env.AC_DESIGN_CAPTURE_RUN = badRun;

    const failGrant = randomUUID();
    const failJob = randomUUID();
    memory.insert('ac_capacity_grants', {
      id: failGrant, intent_id: intent, context_id: context, project_id: project, manager_epoch: authority.epoch,
      account_id: account, profile_id: profile, role: 'specialist', model: 'fixture-model', effort: 'medium',
      resource_kind: 'model', state: 'reserved',
    });
    const failInput = NativeExecutionRequest.parse({
      jobId: failJob, intentId: intent, grantId: failGrant, sessionId: randomUUID(), base: 'e'.repeat(40),
      role: 'specialist', task: 'Pedido de exame.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    await assert.rejects(() => supervisor.start(principal, authority, failInput), /EISDIR/);
    assert.equal(memory.one('ac_capacity_grants', failGrant).state, 'released');
    assert.equal((memory.one('ac_capacity_grants', failGrant).physical_receipt as {reason: string}).reason, 'pre_launch_failed');
    await assert.rejects(() => lstat(join(spool, failJob)), {code: 'ENOENT'});
    await assert.rejects(() => lstat(join(spool, failJob, 'input', 'launch.json')), {code: 'ENOENT'});

    // 3) Recuperação sem início (released_unstarted) também remove launch.pending/launch.json residuais.
    const unstartedGrant = randomUUID();
    const unstartedJob = randomUUID();
    const unstartedSession = randomUUID();
    const unstartedInput = NativeExecutionRequest.parse({
      jobId: unstartedJob, intentId: intent, grantId: unstartedGrant, sessionId: unstartedSession, base: 'e'.repeat(40),
      role: 'specialist', task: 'Pedido de exame.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    const unstartedHash = digest(unstartedInput);
    const createdState = {Status: 'created', Running: false, ExitCode: 0, FinishedAt: '0001-01-01T00:00:00Z', StartedAt: '0001-01-01T00:00:00Z', Pid: 0};
    const wUnstarted = '81'.repeat(32);
    const tUnstarted = '82'.repeat(32);
    const nUnstarted = '83'.repeat(32);
    const uLabels = {'agent-control.job': unstartedJob, 'agent-control.launch': unstartedHash, 'agent-control.contract': 'native-execution-v1'};
    containers.set(`ac-native-worker-${unstartedJob}`, {Id: wUnstarted, Image: image, Config: {Labels: uLabels}, State: createdState});
    containers.set(`ac-native-tools-${unstartedJob}`, {Id: tUnstarted, Image: image, Config: {Labels: uLabels}, State: createdState});
    memory.insert('ac_capacity_grants', {
      id: unstartedGrant, intent_id: intent, context_id: context, project_id: project, manager_epoch: authority.epoch,
      account_id: account, profile_id: profile, role: 'specialist', model: 'fixture-model', effort: 'medium',
      resource_kind: 'model', state: 'uncertain',
    });
    memory.insert('ac_native_execution_jobs', {
      id: unstartedJob, grant_id: unstartedGrant, intent_id: intent, context_id: context, manager_epoch: authority.epoch,
      session_id: unstartedSession, executor_digest: supervisor.executorDigest, key_fingerprint: supervisor.keyFingerprint,
      input_digest: unstartedHash, base_id: unstartedInput.base, role: 'specialist', account_id: account, profile_id: profile,
      profile_digest: digest({fixture: true}), eligibility_revision: 1, state: 'uncertain',
      worker_id: wUnstarted, tools_id: tUnstarted, network_id: nUnstarted,
    });
    await mkdir(join(spool, unstartedJob, 'input'), {recursive: true, mode: 0o700});
    await writeFile(join(spool, unstartedJob, 'input', 'launch.pending'), '{"pending":true}\n', {mode: 0o600});
    const recUnstarted = await supervisor.recover(principal, authority, unstartedJob);
    assert.equal(recUnstarted.state, 'released_unstarted');
    await assert.rejects(() => lstat(join(spool, unstartedJob, 'input', 'launch.pending')), {code: 'ENOENT'});
    await assert.rejects(() => lstat(join(spool, unstartedJob, 'input', 'launch.json')), {code: 'ENOENT'});
  } finally {
    if (prevCaptureDir === undefined) delete process.env.AC_DESIGN_CAPTURE_DIR;
    else process.env.AC_DESIGN_CAPTURE_DIR = prevCaptureDir;
    if (prevCaptureRun === undefined) delete process.env.AC_DESIGN_CAPTURE_RUN;
    else process.env.AC_DESIGN_CAPTURE_RUN = prevCaptureRun;
    server.close();
    homes.mock.restore();
    snaps.mock.restore();
    await rm(area, {recursive: true, force: true});
  }
});

test('resumeExecutionContainers no exame Claude re-prepara token sem reutilizar antigo e falha job com código da recusa', async () => {
  const {ledger, memory} = substituteLedger();
  const area = await realpath(await mkdtemp(join(tmpdir(), 'ac-exam-resume-')));
  const repo = join(area, 'repo');
  const spool = join(area, 'spool');
  const accounts = join(area, 'accounts');
  const project = randomUUID();
  const principal = 'exam-resume-' + randomUUID();
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
  let lastJobId = '';
  let lastLaunchHash = '';
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
          PidMode: '', IpcMode: '', Privileged: false, ReadonlyRootfs: true,
          CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges:true'], Devices: [],
          PidsLimit: 96, Memory: 512 * 1024 * 1024, NanoCpus: 1e9, PortBindings: {},
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
          PidMode: '', IpcMode: '', Privileged: false, ReadonlyRootfs: true,
          CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges:true'], Devices: [],
          PidsLimit: 96, Memory: 512 * 1024 * 1024, NanoCpus: 1e9, PortBindings: {},
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

  try {
    await new Promise<void>(resolve => server.listen(sockPath, resolve));
    for (const path of [repo, spool, accounts, join(accounts, account)]) {
      await mkdir(path, {recursive: true, mode: 0o700});
    }
    const credential = join(accounts, account, '.credentials.json');
    await writeFile(credential, JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-initial-resume',
        refreshToken: 'fixture-refresh-initial-resume',
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
    memory.insert('ac_intents', {id: intent, context_id: context, principal_id: principal, command: {payload: {workflow: 'security-verify-readonly-v1'}}});
    const authority = Authority.parse({contextId: context, instanceId: instance, epoch: 1});
    const keys = generateKeyPairSync('ed25519');
    const image = 'sha256:' + 'c'.repeat(64);
    const containers = new Map<string, Row>();
    const networks = new Set<string>();
    let sequence = 0;
    let startCalls = 0;
    let renewMode: 'ok' | 'fail' = 'ok';
    let renewCalls = 0;
    const daemon = {
      imagePresent: async () => true,
      inspect: async (idOrName: string) => containers.get(idOrName) ?? null,
      inspectPrivateNetwork: async (id: string) => networks.has(id) ? ({
        Id: id,
        Name: `ac-native-exec-${lastJobId}`,
        Internal: true,
        Labels: {'agent-control.contract': 'native-execution-v1', 'agent-control.job': lastJobId, 'agent-control.launch': lastLaunchHash},
        Containers: containers.has(toolsContainerId) || containers.has(workerContainerId) ? {[toolsContainerId]: {IPv4Address: '172.20.0.2/16'}, [workerContainerId]: {IPv4Address: '172.20.0.3/16'}} : {},
      }) : null,
      stop: async () => {},
      remove: async (id: string) => {
        for (const [k, item] of [...containers]) if (k === id || item.Id === id) containers.delete(k);
      },
      removePrivateNetwork: async (id: string) => { networks.delete(id); },
      logs: async () => Buffer.alloc(0),
      createPrivateNetwork: async () => {
        networkContainerId = `${(++sequence).toString(16).padStart(2, '0')}${'ab'.repeat(31)}`;
        networks.add(networkContainerId);
        return networkContainerId;
      },
      create: async (name: string, configuration: {Image?: string; Labels?: Record<string, string>; Env?: string[]; HostConfig?: {Binds?: string[]}}) => {
        const id = `${(++sequence).toString(16).padStart(2, '0')}${'cd'.repeat(31)}`;
        const record: Row = {
          Id: id,
          Image: configuration.Image,
          Config: {Labels: configuration.Labels ?? {}},
          State: {Status: 'running', Running: true, ExitCode: 0, FinishedAt: '0001-01-01T00:00:00Z'},
        };
        containers.set(name, record);
        containers.set(id, record);
        if (name.startsWith('ac-native-worker-')) {
          workerContainerId = id;
          workerCreatedConfig = configuration;
        } else {
          toolsContainerId = id;
          toolsCreatedConfig = configuration;
        }
        return id;
      },
      start: async () => { startCalls += 1; },
    };

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
      workerEnv: [],
      toolsEnv: [],
      examLoginRenew: async () => {
        renewCalls += 1;
        if (renewMode === 'fail') throw new Error('RENEW_FAILED');
        await writeFile(credential, JSON.stringify({
          claudeAiOauth: {
            accessToken: 'fixture-access-resumed-new',
            refreshToken: 'fixture-refresh-resumed-new',
            expiresAt: Date.now() + 3 * 3600_000,
            scopes: ['user:inference'],
          },
        }), {mode: 0o600});
      },
    }, {assertAdmission: async () => {}});
    (supervisor as unknown as {identity: (client: unknown, principal: string, authority: unknown, input: {grantId: string}) => Promise<Row>}).identity = async (_client, _principal, _authority, input) => memory.one('ac_capacity_grants', input.grantId);
    Object.defineProperty(supervisor, 'doc' + 'ker', {value: daemon});

    const grantId = randomUUID();
    const jobId = randomUUID();
    memory.insert('ac_capacity_grants', {
      id: grantId, intent_id: intent, context_id: context, project_id: project, manager_epoch: authority.epoch,
      account_id: account, profile_id: profile, role: 'specialist', model: 'fixture-model', effort: 'medium',
      resource_kind: 'model', state: 'reserved',
    });
    const req = NativeExecutionRequest.parse({
      jobId, intentId: intent, grantId, sessionId: randomUUID(), base: 'e'.repeat(40),
      role: 'specialist', task: 'Exame retomada.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    lastJobId = jobId;
    lastLaunchHash = digest(req);
    await supervisor.start(principal, authority, req);
    const startCallsAtLaunch = startCalls;

    // 1) Worker sai por limite do provedor; depois do reset, retoma renovando o token no lugar e re-assinando launch.json.
    const pastLimitAt = new Date(Date.now() - 60_000).toISOString();
    (containers.get(workerContainerId)!).State = {Status: 'exited', Running: false, ExitCode: 1, FinishedAt: pastLimitAt};
    (containers.get(toolsContainerId)!).State = {Status: 'exited', Running: false, ExitCode: 0, FinishedAt: pastLimitAt};
    memory.insert('ac_accounts', {id: account, exhausted_until: new Date(Date.now() - 5_000).toISOString()});
    await writeFile(join(spool, jobId, 'output', 'execution-result.json'), JSON.stringify({
      schemaVersion: 1, jobId, output: '', normalizedTokensUsed: null, usageWindows: null, nativeSessionId: null, failureCode: 'PROVIDER_USAGE_LIMIT', exitCode: 1,
    }), {mode: 0o600});

    // Deixa o token atual prestes a vencer para obrigar a retomada a renovar.
    await writeFile(credential, JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-initial-resume',
        refreshToken: 'fixture-refresh-initial-resume',
        expiresAt: Date.now() + EXAM_LOGIN_MARGIN_MS,
        scopes: ['user:inference'],
      },
    }), {mode: 0o600});

    const resumedOutcome = await supervisor.reconcile(principal, authority, req);
    assert.equal(resumedOutcome.state, 'running');
    assert.equal(renewCalls, 1);
    assert.equal(startCalls, startCallsAtLaunch + 2);
    const resumedLaunch = JSON.parse(await readFile(join(spool, jobId, 'input', 'launch.json'), 'utf8')) as {
      payload: {oauthAccessToken?: string; credentialSnapshotTag: string};
      signature: string;
    };
    assert.equal(
      verify(null, Buffer.from('agent-control:native-execution-launch:v1\n' + canonical(resumedLaunch.payload)), keys.publicKey, Buffer.from(resumedLaunch.signature, 'hex')),
      true,
    );
    assert.equal(resumedLaunch.payload.oauthAccessToken, 'fixture-access-resumed-new');
    const execToken = (await readFile(join(spool, jobId, 'worker-token'), 'utf8')).trim();
    assert.equal(
      resumedLaunch.payload.credentialSnapshotTag,
      createHmac('sha256', execToken).update(canonical(['fixture-access-resumed-new'])).digest('hex'),
    );
    const updatedSnap = await readNativeSecretSnapshot(join(spool, jobId, 'redaction.enc'), jobId, keys.privateKey);
    assert.equal(updatedSnap.includes('fixture-access-resumed-new'), true);

    // 2) Se a preparação recusar na retomada (EXAM_LOGIN_STALE), não reinicia os contêineres, falha o job com o código e apaga launch.json.
    renewMode = 'fail';
    const secondLimitAt = new Date(Date.now() - 30_000).toISOString();
    (containers.get(workerContainerId)!).State = {Status: 'exited', Running: false, ExitCode: 1, FinishedAt: secondLimitAt};
    (containers.get(toolsContainerId)!).State = {Status: 'exited', Running: false, ExitCode: 0, FinishedAt: secondLimitAt};
    memory.tables.ac_accounts![0]!.exhausted_until = new Date(Date.now() - 1_000).toISOString();
    await writeFile(join(spool, jobId, 'output', 'execution-result.json'), JSON.stringify({
      schemaVersion: 1, jobId, output: '', normalizedTokensUsed: null, usageWindows: null, nativeSessionId: null, failureCode: 'PROVIDER_USAGE_LIMIT', exitCode: 1,
    }), {mode: 0o600});
    await writeFile(credential, JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-resumed-new',
        refreshToken: 'fixture-refresh-resumed-new',
        expiresAt: Date.now() - 5_000,
        scopes: ['user:inference'],
      },
    }), {mode: 0o600});

    const failedOutcome = await supervisor.reconcile(principal, authority, req);
    assert.equal(failedOutcome.state, 'failed');
    assert.equal(failedOutcome.failureCode, 'EXAM_LOGIN_STALE');
    assert.equal(startCalls, startCallsAtLaunch + 2);
    assert.equal(memory.one('ac_capacity_grants', grantId).state, 'released');
    await assert.rejects(() => lstat(join(spool, jobId, 'input', 'launch.json')), {code: 'ENOENT'});

    // Replay e retireTerminal confirmam o mesmo failureCode.
    const replayedFailure = await supervisor.reconcile(principal, authority, req);
    assert.equal(replayedFailure.state, 'failed');
    assert.equal(replayedFailure.failureCode, 'EXAM_LOGIN_STALE');
    const retired = await supervisor.retireTerminal(principal, authority, jobId);
    assert.equal(retired.state, 'removed');
  } finally {
    server.close();
    homes.mock.restore();
    snaps.mock.restore();
    await rm(area, {recursive: true, force: true});
  }
});

test('syntheticFixture faz supervisor e worker concordarem que claudeExam é falso', async () => {
  const {ledger, memory} = substituteLedger();
  const area = await realpath(await mkdtemp(join(tmpdir(), 'ac-synthetic-coherent-')));
  const binDir = join(area, 'bin');
  const repo = join(area, 'repo');
  const spool = join(area, 'spool');
  const accounts = join(area, 'accounts');
  const project = randomUUID();
  const principal = 'synth-' + randomUUID();
  const account = randomUUID();
  const profile = randomUUID();
  const context = randomUUID();
  const instance = randomUUID();
  const intent = randomUUID();
  const image = 'sha256:' + 'c'.repeat(64);
  const providerNet = 'd'.repeat(64);
  const label = 'ac-r3-flow-coherent';
  const prevPath = process.env.PATH ?? '';
  const homes = mock.method(AccountHomes.prototype, 'inspectGranted', async () => ({accountId: account, projectId: project, ownerId: principal, uid: '1', device: '1', inode: '1'}));
  const snaps = mock.method(GitArtifacts.prototype, 'snapshot', async (_candidate: string, _base: string, destination: string) => {
    await mkdir(destination, {recursive: true, mode: 0o700});
  });
  const viewed = mock.method(ProviderEligibility.prototype, 'view', async () => ({
    accountId: account,
    latest: {
      fresh: true,
      effectiveStatus: 'documented_supported',
      authenticationMode: 'synthetic',
      executionMode: 'synthetic',
      adapterId: 'synthetic-claude-supervisor',
      adapterVersion: supervisor.executorDigest,
      revision: 1,
    },
    history: [],
  }));
  const fakeSocketServer = await import('node:http');
  const sockPath = join(area, 'docker.sock');
  let workerContainerId = '';
  let toolsContainerId = '';
  let networkContainerId = '';
  let lastJobId = '';
  let lastLaunchHash = '';
  let workerCreatedConfig: {Env?: string[]; HostConfig?: {Binds?: string[]}} | undefined;
  let toolsCreatedConfig: {Env?: string[]; HostConfig?: {Binds?: string[]}} | undefined;
  const server = fakeSocketServer.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === `/v1.44/containers/${workerContainerId}/json`) {
      res.end(JSON.stringify({
        Id: workerContainerId, Image: image,
        Config: {User: `${process.getuid?.()}:${process.getgid?.()}`, Labels: {'agent-control.job': lastJobId, 'agent-control.launch': lastLaunchHash}, Entrypoint: ['node', '/opt/agent-control/dist/src/native-execution-worker.mjs'], Cmd: [], Env: workerCreatedConfig?.Env ?? [], WorkingDir: '/planning'},
        State: {Status: 'running', Running: true},
        HostConfig: {NetworkMode: networkContainerId, PidMode: '', IpcMode: '', Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges:true'], Devices: [], PidsLimit: 96, Memory: 512 * 1024 * 1024, NanoCpus: 1e9, PortBindings: {}},
        Mounts: (workerCreatedConfig?.HostConfig?.Binds ?? []).map(b => { const [source, destination, mode] = b.split(':'); return {Type: 'bind', Source: source, Destination: destination, RW: mode === 'rw'}; }),
        NetworkSettings: {Networks: {[networkContainerId]: {NetworkID: networkContainerId, IPAddress: '172.20.0.3'}, [providerNet]: {NetworkID: providerNet, IPAddress: '172.21.0.3'}}},
      }));
      return;
    }
    if (req.url === `/v1.44/containers/${toolsContainerId}/json`) {
      res.end(JSON.stringify({
        Id: toolsContainerId, Image: image,
        Config: {User: `${process.getuid?.()}:${process.getgid?.()}`, Labels: {'agent-control.job': lastJobId, 'agent-control.launch': lastLaunchHash}, Entrypoint: ['node', '/opt/agent-control/dist/src/native-tools-worker.mjs'], Cmd: [], Env: toolsCreatedConfig?.Env ?? [], WorkingDir: '/work'},
        State: {Status: 'running', Running: true},
        HostConfig: {NetworkMode: networkContainerId, PidMode: '', IpcMode: '', Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges:true'], Devices: [], PidsLimit: 96, Memory: 512 * 1024 * 1024, NanoCpus: 1e9, PortBindings: {}},
        Mounts: (toolsCreatedConfig?.HostConfig?.Binds ?? []).map(b => { const [source, destination, mode] = b.split(':'); return {Type: 'bind', Source: source, Destination: destination, RW: mode === 'rw'}; }),
        NetworkSettings: {Networks: {[networkContainerId]: {NetworkID: networkContainerId, IPAddress: '172.20.0.2'}}},
      }));
      return;
    }
    if (req.url === `/v1.44/networks/${networkContainerId}`) {
      res.end(JSON.stringify({Id: networkContainerId, Internal: true, Containers: {[toolsContainerId]: {IPv4Address: '172.20.0.2/16'}, [workerContainerId]: {IPv4Address: '172.20.0.3/16'}}}));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });

  let supervisor!: NativeExecutionSupervisor;
  try {
    await new Promise<void>(resolve => server.listen(sockPath, resolve));
    for (const path of [binDir, repo, spool, accounts, join(accounts, account)]) {
      await mkdir(path, {recursive: true, mode: 0o700});
    }
    const fakeDocker = join(binDir, 'docker');
    await writeFile(fakeDocker, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'image' && args[1] === 'inspect') {
  console.log(JSON.stringify([{Id: ${JSON.stringify(image)}, Config: {Labels: {'agent-control.synthetic-fixture': ${JSON.stringify(label)}}}}]));
  process.exit(0);
}
if (args[0] === 'network' && args[1] === 'inspect') {
  console.log(JSON.stringify([{Id: ${JSON.stringify(providerNet)}, Internal: true, Labels: {'agent-control.synthetic-fixture': ${JSON.stringify(label)}}}]));
  process.exit(0);
}
process.exit(1);
`, {mode: 0o700});
    await chmod(fakeDocker, 0o700);
    process.env.PATH = `${binDir}:${prevPath}`;

    const fixture = await authorizeNativeSyntheticFixture({
      contract: 'native-synthetic-fixture-v1',
      projectId: project,
      contextId: context,
      provider: 'synthetic-engineering',
      label,
      workerImage: image,
      toolsImage: image,
      providerNetworkId: providerNet,
    });
    const keys = generateKeyPairSync('ed25519');
    supervisor = new NativeExecutionSupervisor(ledger, {
      id: 'synthetic-claude-supervisor',
      workerImage: image,
      toolsImage: image,
      hostRoot: spool,
      accountRoot: accounts,
      repository: repo,
      protectedRepositories: [],
      signingKeyPem: keys.privateKey.export({format: 'pem', type: 'pkcs8'}).toString(),
      providerNetworkId: providerNet,
      provider: 'claude',
      socketPath: sockPath,
      accountSubjects: [{accountId: account, subjectDigest: 'a'.repeat(64)}],
      workerEnv: ['AC_VERIFY_EXAM=1', 'AC_FIXTURE=1'],
      toolsEnv: [],
      syntheticFixture: fixture,
    }, {assertAdmission: async () => {}});
    let sequence = 0;
    const created: Array<{name: string; env: string[]; binds: string[]}> = [];
    Object.defineProperty(supervisor, 'doc' + 'ker', {
      value: {
        imagePresent: async () => true,
        inspect: async () => null,
        inspectPrivateNetwork: async () => ({Id: networkContainerId, Internal: true, Containers: {[toolsContainerId]: {IPv4Address: '172.20.0.2/16'}, [workerContainerId]: {IPv4Address: '172.20.0.3/16'}}}),
        stop: async () => {},
        remove: async () => {},
        createPrivateNetwork: async () => { networkContainerId = `${(++sequence).toString(16).padStart(2, '0')}${'ab'.repeat(31)}`; return networkContainerId; },
        create: async (name: string, configuration: {Env?: string[]; HostConfig?: {Binds?: string[]}}) => {
          const id = `${(++sequence).toString(16).padStart(2, '0')}${'cd'.repeat(31)}`;
          created.push({name, env: [...(configuration.Env ?? [])], binds: [...(configuration.HostConfig?.Binds ?? [])]});
          if (name.startsWith('ac-native-worker-')) { workerContainerId = id; workerCreatedConfig = configuration; }
          else { toolsContainerId = id; toolsCreatedConfig = configuration; }
          return id;
        },
        start: async () => {},
      },
    });
    (supervisor as unknown as {identity: (client: unknown, principal: string, authority: unknown, input: {grantId: string}) => Promise<Row>}).identity = async (_client, _principal, _authority, input) => memory.one('ac_capacity_grants', input.grantId);

    memory.insert('ac_projects', {id: project});
    memory.insert('ac_memberships', {project_id: project, principal_id: principal, role: 'owner'});
    memory.insert('ac_project_repositories', {project_id: project, repo});
    memory.insert('ac_contexts', {id: context, project_id: project, paused: false, archived: false});
    memory.insert('ac_managers', {context_id: context, instance_id: instance, epoch: 1, lease_until: Date.now() + 60_000});
    memory.insert('ac_admission_control', {id: 1, enabled: true});
    memory.insert('ac_intents', {id: intent, context_id: context, principal_id: principal, command: {payload: {workflow: 'design-readonly-v1'}}});
    const authority = Authority.parse({contextId: context, instanceId: instance, epoch: 1});
    const grantId = randomUUID();
    const jobId = randomUUID();
    memory.insert('ac_capacity_grants', {
      id: grantId, intent_id: intent, context_id: context, project_id: project, manager_epoch: authority.epoch,
      account_id: account, profile_id: profile, role: 'specialist', model: 'fixture-model', effort: 'medium',
      resource_kind: 'model', state: 'reserved',
    });
    const req = NativeExecutionRequest.parse({
      jobId, intentId: intent, grantId, sessionId: randomUUID(), base: 'e'.repeat(40),
      role: 'specialist', task: 'Exame sintético.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    lastJobId = jobId;
    lastLaunchHash = digest(req);
    await supervisor.start(principal, authority, req);

    const workerMeta = created.find(c => c.name === `ac-native-worker-${jobId}`);
    assert.ok(workerMeta);
    assert.equal(workerMeta.env.includes('AC_VERIFY_EXAM=1'), false);
    assert.equal(workerMeta.binds.some(b => b.includes(':/account:')), true);

    const launch = JSON.parse(await readFile(join(spool, jobId, 'input', 'launch.json'), 'utf8')) as {
      payload: {provider?: string; synthetic?: boolean; oauthAccessToken?: string};
    };
    assert.equal(launch.payload.synthetic, true);
    assert.equal(launch.payload.oauthAccessToken, undefined);
    assert.equal(isClaudeExamWorker({verifyExam: workerMeta.env.includes('AC_VERIFY_EXAM=1'), provider: launch.payload.provider, synthetic: launch.payload.synthetic}), false);
    assert.equal(isClaudeExamWorker({verifyExam: true, provider: launch.payload.provider, synthetic: launch.payload.synthetic}), false);
  } finally {
    process.env.PATH = prevPath;
    server.close();
    homes.mock.restore();
    snaps.mock.restore();
    viewed.mock.restore();
    await rm(area, {recursive: true, force: true});
  }
});

test('accessToken falso não aparece nos relatórios de design e validador mesmo quando o CLI falso tenta vazar', {skip: !process.env.AC_TEST_DATABASE_URL}, async () => {
  const baseUrl = process.env.AC_TEST_DATABASE_URL!;
  const fixture = await isolatedDatabase(baseUrl, 'examsecreport');
  const db = new Ledger(fixture.url);
  const area = await realpath(await mkdtemp(join(tmpdir(), 'ac-exam-report-secret-')));
  const tmpArea = join(area, 'tmp');
  const repo = join(area, 'repo');
  const accounts = join(area, 'accounts');
  const designData = join(area, 'design-data');
  const verifyData = join(area, 'verify-data');
  const fakeClaude = join(area, 'fake-claude');
  const fakeAccessToken = 'oauth-access-report-leak-secret-424242';
  const prevEnv = {...process.env};
  try {
    for (const dir of [tmpArea, repo, join(repo, 'src'), accounts, designData, verifyData]) {
      await mkdir(dir, {recursive: true, mode: 0o700});
    }
    await writeFile(join(repo, 'src', 'app.ts'), 'export const hello = "world";\n', {mode: 0o644});
    await writeFile(join(repo, 'index.html'), '<html><body><h1>Oi</h1></body></html>\n', {mode: 0o644});
    await writeFile(
      fakeClaude,
      `#!${process.execPath}
const readline = require('node:readline');
const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
rl.once('line', line => {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
  const parsed = JSON.parse(line);
  const textBlock = (parsed.message && parsed.message.content || []).find(c => c.type === 'text');
  const promptText = textBlock ? textBlock.text : '';
  let replyObj;
  if (promptText.includes('Pedido de mapa.')) {
    replyObj = {kind: 'mapa', routes: [{method: 'GET', path: '/', file: 'src/app.ts', line: 1}], surfaces: ['web ' + token]};
  } else if (promptText.includes('Pedido de confirmação.')) {
    replyObj = {kind: 'confirmacao', status: 'confirmado', reason: 'Confirmado ' + token, proof: 'Prova ' + token};
  } else {
    replyObj = {
      kind: 'exame',
      filesRead: ['src/app.ts', 'index.html'],
      checklist: ['ASVS-5-V1'],
      findings: [{
        title: 'Achado ' + token,
        severity: 'baixa',
        file: promptText.includes('index.html') ? 'index.html' : 'src/app.ts',
        line: 1,
        scenario: 'Cenário ' + token,
        suggestion: 'Troque cor #111 ' + token,
        cwe: null,
        reference: 'REF-1',
        snippet: 'snippet ' + token,
      }],
    };
  }
  const reply = JSON.stringify(replyObj);
  console.log(JSON.stringify({type: 'assistant', message: {role: 'assistant', content: [{type: 'text', text: reply}]}}));
  console.log(JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: reply}));
  process.exit(0);
});
`,
      {mode: 0o700},
    );
    await chmod(fakeClaude, 0o700);

    const execToken = 'e'.repeat(48);
    const snapshotTag = createHmac('sha256', execToken).update(canonical([fakeAccessToken])).digest('hex');
    const prepared = await prepareClaudeExamWorkerEnv({
      oauthAccessToken: fakeAccessToken,
      credentialSnapshotTag: snapshotTag,
      execToken,
      tmpRoot: tmpArea,
    });
    assert.equal(prepared.claudeBin, EXAM_CLAUDE_WRAPPER_BIN);

    const hostWrapperBin = await installExamClaudeWrapper(area, fakeClaude);
    const runner = new ClaudeCliRunner({bin: hostWrapperBin, timeoutMs: 10_000});
    const adaptedRunner = {
      backend: 'claude' as const,
      run(spec: Parameters<ClaudeCliRunner['run']>[0], onEvent?: Parameters<ClaudeCliRunner['run']>[1]) {
        return runner.run({...spec, cwd: repo}, onEvent);
      },
      interrupt() { return runner.interrupt(); },
      startSession(spec: Parameters<ClaudeCliRunner['startSession']>[0], onEvent: Parameters<ClaudeCliRunner['startSession']>[1], opts: Parameters<ClaudeCliRunner['startSession']>[2]) {
        return runner.startSession({...spec, cwd: repo}, onEvent, opts);
      },
    };
    const adapter = new ClaudeExecutionAdapter(adaptedRunner);
    const runThroughAdapter = (call: {role: 'specialist' | 'reviewer'; task: string}) =>
      adapter.run(
        {
          sessionId: randomUUID(),
          model: 'claude-sonnet-5-5',
          effort: 'medium',
          role: call.role,
          task: call.task,
          writePaths: [],
          artifactCommit: 'a'.repeat(40),
          outputSchema: {type: 'object'},
          timeoutMs: 10_000,
          environment: {id: 'native_tools', url: 'ws://127.0.0.1:19492', authBearerToken: execToken, cwd: '/work'},
        },
        async () => {},
        undefined,
        [...prepared.secrets, ...collectSecretValues(process.env)],
      ).then(res => res.output);

    await db.migrate();
    const project = randomUUID();
    const principal = 'report-secret-' + randomUUID();
    const account = randomUUID();
    const specProfile = randomUUID();
    const specRevProfile = randomUUID();
    const revProfile = randomUUID();
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'secret report test']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    const capacity = new Capacity(db);
    await capacity.configure(principal, {programmingLimit: 10, evaluationLimit: 2});
    await capacity.registerModel(principal, {provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['medium'], roles: ['specialist', 'reviewer'], source: 'synthetic://exam-report'});
    const adapterSpec = createSyntheticProviderAdapter({
      id: 'fixture-claude-report',
      provider: 'claude',
      version: 'verify-v1',
      runner: async input => ({protocol: 'ac-synthetic-quota-v1', provider: 'claude', accountId: input.accountId, status: 'available', remainingPercent: 80, resetAt: null}),
    });
    const collectors = new ProviderCollectors(db, [adapterSpec]);
    await capacity.addAccount(principal, project, {
      id: account, provider: 'claude', label: 'claude-exam', resourceIdentity: 'claude:' + 'f'.repeat(64),
      mode: 'synthetic', eligibility: 'documented_supported', eligibilitySource: 'synthetic://exam-report', maxConcurrent: 2,
    });
    await capacity.addProfile(principal, project, {id: specProfile, accountId: account, model: 'claude-sonnet-5-5', effort: 'medium', role: 'specialist'});
    await capacity.addProfile(principal, project, {id: specRevProfile, accountId: account, model: 'claude-sonnet-5-5', effort: 'medium', role: 'specialist'});
    await capacity.addProfile(principal, project, {id: revProfile, accountId: account, model: 'claude-sonnet-5-5', effort: 'medium', role: 'reviewer'});
    await collectors.bind(principal, project, {accountId: account, adapterId: adapterSpec.manifest.id, expectedRevision: 0, minimumIntervalSeconds: 1});
    const revision = await capacity.publish(principal, project, 0, {
      schemaVersion: 1,
      maxProgrammersPerContext: 1,
      maxEvaluatorsPerContext: 1,
      roles: {specialist: {regular: [specProfile], emergency: [specRevProfile]}, reviewer: {regular: [revProfile], emergency: []}},
    });
    await mkdir(join(accounts, account), {recursive: true, mode: 0o700});
    await writeFile(join(accounts, account, '.credentials.json'), JSON.stringify({
      claudeAiOauth: {accessToken: fakeAccessToken, refreshToken: 'fixture-refresh-report', expiresAt: Date.now() + 3 * 3600_000},
    }), {mode: 0o600});
    const context = await db.createContext(principal, project, randomUUID());
    await capacity.assignPolicy(principal, context, revision);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await db.pool.query("UPDATE ac_provider_bindings SET last_started_at=clock_timestamp()-interval '2 seconds'");
    await collectors.collect(principal, project, account, randomUUID());
    const authority = await db.acquire(principal, context, randomUUID(), 'fixture-manager', 60);

    const designRes = await runDesignModule({
      activation: 'personal',
      projectId: project,
      repo,
      targetUrl: 'http://127.0.0.1:4173',
      dataDirectory: designData,
      intentId: randomUUID(),
      runId: randomUUID(),
      createdAt: new Date(),
      commit: 'e'.repeat(40),
      files: [{path: 'index.html', text: '<html><body><h1>Oi</h1></body></html>'}],
      worker: {run: call => runThroughAdapter({role: call.role, task: call.task})},
      reserve: async role => ({provider: 'claude', model: 'claude-sonnet-5-5', accountId: account, profileId: role === 'specialist' ? specProfile : revProfile, grantId: randomUUID()}),
      release: async () => {},
    });
    for (const file of await listFilesRecursive(designRes.directory)) {
      assert.equal((await readFile(file, 'utf8')).includes(fakeAccessToken), false, file);
    }

    const verifyRes = await runSecurityVerification({
      ledger: db,
      principal,
      authority,
      projectId: project,
      repoPath: repo,
      dataDirectory: verifyData,
      commit: 'e'.repeat(40),
      policyRevision: 1,
      accountRoot: accounts,
      accountSecrets: [fakeAccessToken],
      worker: {run: call => runThroughAdapter({role: call.role, task: call.task})},
    });
    for (const file of await listFilesRecursive(verifyRes.directory)) {
      assert.equal((await readFile(file, 'utf8')).includes(fakeAccessToken), false, file);
    }
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in prevEnv)) delete process.env[k];
    }
    Object.assign(process.env, prevEnv);
    await db.close();
    await fixture.close();
    await rm(area, {recursive: true, force: true});
  }
});

test('falha em diskGuard.assertAdmission antes do try libera o grant, e failBeforeLaunch registra o código sem segredo e repropaga falha de liberação', async () => {
  const {ledger, memory} = substituteLedger();
  const area = await realpath(await mkdtemp(join(tmpdir(), 'ac-prelaunch-grant-')));
  const repo = join(area, 'repo');
  const spool = join(area, 'spool');
  const accounts = join(area, 'accounts');
  const project = randomUUID();
  const principal = 'prelaunch-grant-' + randomUUID();
  const account = randomUUID();
  const profile = randomUUID();
  const context = randomUUID();
  const instance = randomUUID();
  const intent = randomUUID();
  let inspectMode: 'ok' | 'fail' = 'ok';
  const homes = mock.method(AccountHomes.prototype, 'inspectGranted', async () => {
    if (inspectMode === 'fail') throw new Refusal('ACCOUNT_HOME_GRANT_FORBIDDEN');
    return {accountId: account, projectId: project, ownerId: principal, uid: '1', device: '1', inode: '1'};
  });
  const snaps = mock.method(GitArtifacts.prototype, 'snapshot', async (_candidate: string, _base: string, destination: string) => {
    await mkdir(destination, {recursive: true, mode: 0o700});
  });
  const logged: string[] = [];
  const consoleErr = mock.method(console, 'error', (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  try {
    for (const path of [repo, spool, accounts, join(accounts, account)]) {
      await mkdir(path, {recursive: true, mode: 0o700});
    }
    await writeFile(join(accounts, account, '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-prelaunch',
        refreshToken: 'fixture-refresh-prelaunch',
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
    memory.insert('ac_intents', {id: intent, context_id: context, principal_id: principal, command: {payload: {workflow: 'design-readonly-v1'}}});
    const authority = Authority.parse({contextId: context, instanceId: instance, epoch: 1});
    const keys = generateKeyPairSync('ed25519');
    const image = 'sha256:' + 'c'.repeat(64);
    let failDisk = true;
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
    }, {
      async assertAdmission() {
        if (failDisk) throw new Refusal('STORAGE_LOW_SPACE');
      },
    });
    (supervisor as unknown as {identity: (client: unknown, principal: string, authority: unknown, input: {grantId: string}) => Promise<Row>}).identity = async (_client, _principal, _authority, input) => memory.one('ac_capacity_grants', input.grantId);
    Object.defineProperty(supervisor, 'doc' + 'ker', {
      value: {
        imagePresent: async () => true,
        inspect: async () => null,
        inspectPrivateNetwork: async () => null,
        stop: async () => {},
        remove: async () => {},
      },
    });

    // 1) Falha injetada em diskGuard.assertAdmission -> libera o grant e repropaga o erro original.
    const diskGrant = randomUUID();
    const diskJob = randomUUID();
    memory.insert('ac_capacity_grants', {
      id: diskGrant, intent_id: intent, context_id: context, project_id: project, manager_epoch: authority.epoch,
      account_id: account, profile_id: profile, role: 'specialist', model: 'fixture-model', effort: 'medium',
      resource_kind: 'model', state: 'reserved',
    });
    const diskInput = NativeExecutionRequest.parse({
      jobId: diskJob, intentId: intent, grantId: diskGrant, sessionId: randomUUID(), base: 'e'.repeat(40),
      role: 'specialist', task: 'Pedido de exame.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    await assert.rejects(
      () => supervisor.start(principal, authority, diskInput),
      (error: unknown) => error instanceof Refusal && error.code === 'STORAGE_LOW_SPACE',
    );
    assert.equal(memory.one('ac_capacity_grants', diskGrant).state, 'released');
    assert.equal((memory.one('ac_capacity_grants', diskGrant).physical_receipt as {reason: string}).reason, 'pre_launch_failed');

    // 2) Falha injetada em inspectGranted -> libera o grant e repropaga o erro original.
    failDisk = false;
    inspectMode = 'fail';
    const inspectGrant = randomUUID();
    const inspectJob = randomUUID();
    memory.insert('ac_capacity_grants', {
      id: inspectGrant, intent_id: intent, context_id: context, project_id: project, manager_epoch: authority.epoch,
      account_id: account, profile_id: profile, role: 'specialist', model: 'fixture-model', effort: 'medium',
      resource_kind: 'model', state: 'reserved',
    });
    const inspectInput = NativeExecutionRequest.parse({
      jobId: inspectJob, intentId: intent, grantId: inspectGrant, sessionId: randomUUID(), base: 'e'.repeat(40),
      role: 'specialist', task: 'Pedido de exame.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    await assert.rejects(
      () => supervisor.start(principal, authority, inspectInput),
      (error: unknown) => error instanceof Refusal && error.code === 'ACCOUNT_HOME_GRANT_FORBIDDEN',
    );
    assert.equal(memory.one('ac_capacity_grants', inspectGrant).state, 'released');

    // 3) Se releaseBeforeLaunch falhar dentro de failBeforeLaunch, registra o código (sem segredo) e repropaga.
    inspectMode = 'ok';
    failDisk = true;
    const releaseFailGrant = randomUUID();
    const releaseFailJob = randomUUID();
    memory.insert('ac_capacity_grants', {
      id: releaseFailGrant, intent_id: intent, context_id: context, project_id: project, manager_epoch: authority.epoch,
      account_id: account, profile_id: profile, role: 'specialist', model: 'fixture-model', effort: 'medium',
      resource_kind: 'model', state: 'reserved',
    });
    const releaseFailInput = NativeExecutionRequest.parse({
      jobId: releaseFailJob, intentId: intent, grantId: releaseFailGrant, sessionId: randomUUID(), base: 'e'.repeat(40),
      role: 'specialist', task: 'Pedido de exame.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    let identityCalls = 0;
    const secretInReleaseErr = 'secret-release-err-never-logged-123';
    (supervisor as unknown as {identity: (client: unknown, principal: string, authority: unknown, input: {grantId: string}) => Promise<Row>}).identity = async (_client, _principal, _authority, input) => {
      identityCalls += 1;
      if (identityCalls >= 2) throw new Error('release failed ' + secretInReleaseErr);
      return memory.one('ac_capacity_grants', input.grantId);
    };
    await assert.rejects(
      () => supervisor.start(principal, authority, releaseFailInput),
      (error: unknown) => error instanceof Error && error.message.includes('release failed'),
    );
    assert.equal(logged.length, 1);
    assert.equal(logged[0]!.includes('NATIVE_RELEASE_BEFORE_LAUNCH_FAILED'), true);
    assert.equal(logged[0]!.includes(secretInReleaseErr), false);
    assert.equal(memory.one('ac_capacity_grants', releaseFailGrant).state, 'reserved');
  } finally {
    consoleErr.mock.restore();
    homes.mock.restore();
    snaps.mock.restore();
    await rm(area, {recursive: true, force: true});
  }
});

test('resumeExecutionContainers apaga launch.json/launch.pending antes da preparação, falha com código em erro comum e grava execution-result.json pelo supervisor sem accessToken', async () => {
  const {ledger, memory} = substituteLedger();
  const area = await realpath(await mkdtemp(join(tmpdir(), 'ac-resume-real-result-')));
  const repo = join(area, 'repo');
  const spool = join(area, 'spool');
  const accounts = join(area, 'accounts');
  const tmpArea = join(area, 'tmp');
  const fakeClaude = join(area, 'fake-claude');
  const project = randomUUID();
  const principal = 'resume-real-' + randomUUID();
  const account = randomUUID();
  const profile = randomUUID();
  const context = randomUUID();
  const instance = randomUUID();
  const intent = randomUUID();
  const accessSecret = 'oauth-access-supervisor-result-secret-778899';
  const refreshSecret = 'oauth-refresh-supervisor-result-secret-778899';
  const prevEnv = {...process.env};
  const homes = mock.method(AccountHomes.prototype, 'inspectGranted', async () => ({accountId: account, projectId: project, ownerId: principal, uid: '1', device: '1', inode: '1'}));
  const snaps = mock.method(GitArtifacts.prototype, 'snapshot', async (_candidate: string, _base: string, destination: string) => {
    await mkdir(destination, {recursive: true, mode: 0o700});
  });
  const fakeSocketServer = await import('node:http');
  const sockPath = join(area, 'docker.sock');
  let workerContainerId = '';
  let toolsContainerId = '';
  let networkContainerId = '';
  let lastJobId = '';
  let lastLaunchHash = '';
  let workerCreatedConfig: {Env?: string[]; HostConfig?: {Binds?: string[]}} | undefined;
  let toolsCreatedConfig: {Env?: string[]; HostConfig?: {Binds?: string[]}} | undefined;
  const server = fakeSocketServer.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === `/v1.44/containers/${workerContainerId}/json`) {
      res.end(JSON.stringify({
        Id: workerContainerId, Image: 'sha256:' + 'c'.repeat(64),
        Config: {
          User: `${process.getuid?.()}:${process.getgid?.()}`,
          Labels: {'agent-control.job': lastJobId, 'agent-control.launch': lastLaunchHash},
          Entrypoint: ['node', '/opt/agent-control/dist/src/native-execution-worker.mjs'],
          Cmd: [], Env: workerCreatedConfig?.Env ?? [], WorkingDir: '/planning',
        },
        State: {Status: 'running', Running: true},
        HostConfig: {
          NetworkMode: networkContainerId, PidMode: '', IpcMode: '', Privileged: false, ReadonlyRootfs: true,
          CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges:true'], Devices: [],
          PidsLimit: 96, Memory: 512 * 1024 * 1024, NanoCpus: 1e9, PortBindings: {},
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
        Id: toolsContainerId, Image: 'sha256:' + 'c'.repeat(64),
        Config: {
          User: `${process.getuid?.()}:${process.getgid?.()}`,
          Labels: {'agent-control.job': lastJobId, 'agent-control.launch': lastLaunchHash},
          Entrypoint: ['node', '/opt/agent-control/dist/src/native-tools-worker.mjs'],
          Cmd: [], Env: toolsCreatedConfig?.Env ?? [], WorkingDir: '/work',
        },
        State: {Status: 'running', Running: true},
        HostConfig: {
          NetworkMode: networkContainerId, PidMode: '', IpcMode: '', Privileged: false, ReadonlyRootfs: true,
          CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges:true'], Devices: [],
          PidsLimit: 96, Memory: 512 * 1024 * 1024, NanoCpus: 1e9, PortBindings: {},
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
        Id: networkContainerId, Internal: true,
        Containers: {[toolsContainerId]: {IPv4Address: '172.20.0.2/16'}, [workerContainerId]: {IPv4Address: '172.20.0.3/16'}},
      }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });

  try {
    await new Promise<void>(resolve => server.listen(sockPath, resolve));
    for (const path of [repo, spool, accounts, join(accounts, account), tmpArea]) {
      await mkdir(path, {recursive: true, mode: 0o700});
    }
    await writeFile(
      fakeClaude,
      `#!${process.execPath}
const readline = require('node:readline');
const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
rl.once('line', () => {
  const reply = JSON.stringify({ok: false, leaked: process.env.CLAUDE_CODE_OAUTH_TOKEN || ''});
  console.log(JSON.stringify({type: 'assistant', message: {role: 'assistant', content: [{type: 'text', text: reply}]}}));
  console.log(JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: reply}));
  process.exit(0);
});
`,
      {mode: 0o700},
    );
    await chmod(fakeClaude, 0o700);
    const credential = join(accounts, account, '.credentials.json');
    await writeFile(credential, JSON.stringify({
      claudeAiOauth: {
        accessToken: accessSecret,
        refreshToken: refreshSecret,
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
    memory.insert('ac_intents', {id: intent, context_id: context, principal_id: principal, command: {payload: {workflow: 'design-readonly-v1'}}});
    const authority = Authority.parse({contextId: context, instanceId: instance, epoch: 1});
    const keys = generateKeyPairSync('ed25519');
    const image = 'sha256:' + 'c'.repeat(64);
    const containers = new Map<string, Row>();
    const networks = new Set<string>();
    let sequence = 0;
    let startCalls = 0;
    const daemon = {
      imagePresent: async () => true,
      inspect: async (idOrName: string) => containers.get(idOrName) ?? null,
      inspectPrivateNetwork: async (id: string) => networks.has(id) ? ({
        Id: id, Name: `ac-native-exec-${lastJobId}`, Internal: true,
        Labels: {'agent-control.contract': 'native-execution-v1', 'agent-control.job': lastJobId, 'agent-control.launch': lastLaunchHash},
        Containers: containers.has(toolsContainerId) || containers.has(workerContainerId) ? {[toolsContainerId]: {IPv4Address: '172.20.0.2/16'}, [workerContainerId]: {IPv4Address: '172.20.0.3/16'}} : {},
      }) : null,
      stop: async () => {},
      remove: async (id: string) => {
        for (const [k, item] of [...containers]) if (k === id || item.Id === id) containers.delete(k);
      },
      removePrivateNetwork: async (id: string) => { networks.delete(id); },
      logs: async () => Buffer.alloc(0),
      createPrivateNetwork: async () => {
        networkContainerId = `${(++sequence).toString(16).padStart(2, '0')}${'ab'.repeat(31)}`;
        networks.add(networkContainerId);
        return networkContainerId;
      },
      create: async (name: string, configuration: {Image?: string; Labels?: Record<string, string>; Env?: string[]; HostConfig?: {Binds?: string[]}}) => {
        const id = `${(++sequence).toString(16).padStart(2, '0')}${'cd'.repeat(31)}`;
        const record: Row = {
          Id: id, Image: configuration.Image, Config: {Labels: configuration.Labels ?? {}},
          State: {Status: 'running', Running: true, ExitCode: 0, FinishedAt: '0001-01-01T00:00:00Z'},
        };
        containers.set(name, record);
        containers.set(id, record);
        if (name.startsWith('ac-native-worker-')) {
          workerContainerId = id;
          workerCreatedConfig = configuration;
        } else {
          toolsContainerId = id;
          toolsCreatedConfig = configuration;
        }
        return id;
      },
      start: async () => { startCalls += 1; },
    };

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
      workerEnv: [],
      toolsEnv: [],
    }, {assertAdmission: async () => {}});
    (supervisor as unknown as {identity: (client: unknown, principal: string, authority: unknown, input: {grantId: string}) => Promise<Row>}).identity = async (_client, _principal, _authority, input) => memory.one('ac_capacity_grants', input.grantId);
    Object.defineProperty(supervisor, 'doc' + 'ker', {value: daemon});

    const grantId = randomUUID();
    const jobId = randomUUID();
    memory.insert('ac_capacity_grants', {
      id: grantId, intent_id: intent, context_id: context, project_id: project, manager_epoch: authority.epoch,
      account_id: account, profile_id: profile, role: 'specialist', model: 'fixture-model', effort: 'medium',
      resource_kind: 'model', state: 'reserved',
    });
    const req = NativeExecutionRequest.parse({
      jobId, intentId: intent, grantId, sessionId: randomUUID(), base: 'e'.repeat(40),
      role: 'specialist', task: 'Exame erro comum e gravação pelo supervisor.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    lastJobId = jobId;
    lastLaunchHash = digest(req);
    await supervisor.start(principal, authority, req);
    const startCallsAtLaunch = startCalls;

    // Executa o caminho do adapter com fakeClaude tentando vazar CLAUDE_CODE_OAUTH_TOKEN.
    const execToken = (await readFile(join(spool, jobId, 'worker-token'), 'utf8')).trim();
    const snapshotTag = createHmac('sha256', execToken).update(canonical([accessSecret])).digest('hex');
    const preparedWorker = await prepareClaudeExamWorkerEnv({
      oauthAccessToken: accessSecret,
      credentialSnapshotTag: snapshotTag,
      execToken,
      tmpRoot: tmpArea,
    });
    assert.equal(preparedWorker.claudeBin, EXAM_CLAUDE_WRAPPER_BIN);
    const hostWrapperBin = await installExamClaudeWrapper(area, fakeClaude);
    const runner = new ClaudeCliRunner({bin: hostWrapperBin, timeoutMs: 10_000});
    const adaptedRunner = {
      backend: 'claude' as const,
      run(spec: Parameters<ClaudeCliRunner['run']>[0], onEvent?: Parameters<ClaudeCliRunner['run']>[1]) {
        return runner.run({...spec, cwd: repo}, onEvent);
      },
      interrupt() { return runner.interrupt(); },
      startSession(spec: Parameters<ClaudeCliRunner['startSession']>[0], onEvent: Parameters<ClaudeCliRunner['startSession']>[1], opts: Parameters<ClaudeCliRunner['startSession']>[2]) {
        return runner.startSession({...spec, cwd: repo}, onEvent, opts);
      },
    };
    const adapter = new ClaudeExecutionAdapter(adaptedRunner);
    const ran = await adapter.run(
      {
        sessionId: randomUUID(), model: 'claude-sonnet-5-5', effort: 'medium', role: 'specialist',
        task: 'Exame erro comum.', writePaths: [], artifactCommit: 'a'.repeat(40), outputSchema: {type: 'object'},
        timeoutMs: 10_000, environment: {id: 'native_tools', url: 'ws://127.0.0.1:19492', authBearerToken: execToken, cwd: '/work'},
      },
      async () => {},
      undefined,
      [...preparedWorker.secrets, ...collectSecretValues(process.env)],
    );

    const pastLimitAt = new Date(Date.now() - 60_000).toISOString();
    (containers.get(workerContainerId)!).State = {Status: 'exited', Running: false, ExitCode: 1, FinishedAt: pastLimitAt};
    (containers.get(toolsContainerId)!).State = {Status: 'exited', Running: false, ExitCode: 0, FinishedAt: pastLimitAt};
    memory.insert('ac_accounts', {id: account, exhausted_until: new Date(Date.now() - 5_000).toISOString()});

    const execResultPath = join(spool, jobId, 'output', 'execution-result.json');
    await writeFile(execResultPath, JSON.stringify({
      schemaVersion: 1, jobId, output: ran.output, normalizedTokensUsed: null, usageWindows: null, nativeSessionId: null, failureCode: 'PROVIDER_USAGE_LIMIT', exitCode: 1,
    }), {mode: 0o600});
    // Deixa launch.pending residual e injeta erro comum (não Refusal) com o token na mensagem durante a preparação da retomada.
    await writeFile(join(spool, jobId, 'input', 'launch.pending'), '{"stale":true}\n', {mode: 0o600});
    await writeFile(join(spool, jobId, 'input', 'launch.pending.stale'), '{"stale":true}\n', {mode: 0o600});
    memory.lockErrorOnNextLock = new Error('LOCK_PREP_ORDINARY_ERROR token=' + accessSecret);

    const outcome = await supervisor.reconcile(principal, authority, req);
    assert.equal(outcome.state, 'failed');
    assert.equal(outcome.failureCode, 'EXAM_LOGIN_TOKEN_FAILED');
    assert.equal(startCalls, startCallsAtLaunch);
    assert.equal(memory.one('ac_capacity_grants', grantId).state, 'released');

    // Nenhum arquivo de launch fica no disco.
    await assert.rejects(() => lstat(join(spool, jobId, 'input', 'launch.json')), {code: 'ENOENT'});
    await assert.rejects(() => lstat(join(spool, jobId, 'input', 'launch.pending')), {code: 'ENOENT'});
    await assert.rejects(() => lstat(join(spool, jobId, 'input', 'launch.pending.stale')), {code: 'ENOENT'});

    // Confirma que execution-result.json foi sobrescrito pelo próprio supervisor e não contém o accessToken falso.
    const supervisorWrittenRaw = await readFile(execResultPath, 'utf8');
    const supervisorWritten = JSON.parse(supervisorWrittenRaw) as {failureCode: string | null; output: string};
    assert.equal(supervisorWritten.failureCode, 'EXAM_LOGIN_TOKEN_FAILED');
    assert.equal(supervisorWrittenRaw.includes(accessSecret), false);
    assert.equal(supervisorWrittenRaw.includes(refreshSecret), false);
    assert.equal(JSON.parse(supervisorWritten.output).leaked, '[REDACTED]');

    // Também testa falha na escrita do launch novo (worker-token ausente após preparação): job falha e launch.json continua ausente.
    const grant2 = randomUUID();
    const job2 = randomUUID();
    memory.insert('ac_capacity_grants', {
      id: grant2, intent_id: intent, context_id: context, project_id: project, manager_epoch: authority.epoch,
      account_id: account, profile_id: profile, role: 'specialist', model: 'fixture-model', effort: 'medium',
      resource_kind: 'model', state: 'reserved',
    });
    const req2 = NativeExecutionRequest.parse({
      jobId: job2, intentId: intent, grantId: grant2, sessionId: randomUUID(), base: 'e'.repeat(40),
      role: 'specialist', task: 'Exame falha escrita launch.', writePaths: [], artifactId: randomUUID(), outputSchema: {type: 'object'},
    });
    lastJobId = job2;
    lastLaunchHash = digest(req2);
    await supervisor.start(principal, authority, req2);
    (containers.get(workerContainerId)!).State = {Status: 'exited', Running: false, ExitCode: 1, FinishedAt: pastLimitAt};
    (containers.get(toolsContainerId)!).State = {Status: 'exited', Running: false, ExitCode: 0, FinishedAt: pastLimitAt};
    const execResultPath2 = join(spool, job2, 'output', 'execution-result.json');
    await writeFile(execResultPath2, JSON.stringify({
      schemaVersion: 1, jobId: job2, output: '', normalizedTokensUsed: null, usageWindows: null, nativeSessionId: null, failureCode: 'PROVIDER_USAGE_LIMIT', exitCode: 1,
    }), {mode: 0o600});
    await rm(join(spool, job2, 'worker-token'));

    const outcome2 = await supervisor.reconcile(principal, authority, req2);
    assert.equal(outcome2.state, 'failed');
    assert.equal(outcome2.failureCode, 'ENOENT');
    assert.equal(memory.one('ac_capacity_grants', grant2).state, 'released');
    await assert.rejects(() => lstat(join(spool, job2, 'input', 'launch.json')), {code: 'ENOENT'});
    const supervisorWrittenRaw2 = await readFile(execResultPath2, 'utf8');
    assert.equal((JSON.parse(supervisorWrittenRaw2) as {failureCode: string | null}).failureCode, 'ENOENT');
    assert.equal(supervisorWrittenRaw2.includes(accessSecret), false);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in prevEnv)) delete process.env[k];
    }
    Object.assign(process.env, prevEnv);
    server.close();
    homes.mock.restore();
    snaps.mock.restore();
    await rm(area, {recursive: true, force: true});
  }
});
