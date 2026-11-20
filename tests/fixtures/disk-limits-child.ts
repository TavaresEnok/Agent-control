// Subprocess of tests/personal-disk-limits-entrypoints.test.ts. It runs with tests/fixtures/statfs-rules.mjs preloaded,
// so every disk measurement is a fake table and no volume is filled. It drives the real entrypoints and prints one RESULT line.
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Capacity} from '../../src/capacity.ts';
import {Refusal, type Command} from '../../src/contracts.ts';
import {runDesignModule} from '../../src/design-module.ts';
import {Ledger} from '../../src/ledger.ts';
import {installationVolumes} from '../../src/personal-disk.ts';
import {beginPersonalVerification, readVerificationProgress} from '../../src/verify-command.ts';
import {isolatedDatabase} from './isolated-database.ts';

type Rules = {prefix: string; used: number}[];
const globals = globalThis as unknown as {__statfsRules: Rules; __statfsCalls: string[]};
const SENTINEL = 'DISK_LIMITS_SENTINEL';
const base = process.env.AC_TEST_DATABASE_URL;
if (!base) throw new Error('ISOLATED_DATABASE_REQUIRED');

async function code(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'OK'; } catch (error) { return error instanceof Refusal ? error.code : 'ERR:' + String((error as Error).message).slice(0, 80); }
}

const root = await mkdtemp(join(tmpdir(), 'ac-disk-limits-'));
const data = join(root, 'dados'), repo = join(root, 'repo'), databases = join(root, 'bases');
const planningHost = join(root, 'planejamento'), planningAccounts = join(root, 'contas-planejamento');
const executionHost = join(root, 'execucao'), executionAccounts = join(root, 'contas-execucao'), homes = join(root, 'homes');
for (const dir of [data, repo, databases]) await mkdir(dir, {recursive: true, mode: 0o700});
const volumes = installationVolumes({dataDirectory: data, accountHomesDirectory: homes, nativeBootstrap: {
  planning: {hostRoot: planningHost, accountRoot: planningAccounts}, execution: {hostRoot: executionHost, accountRoot: executionAccounts}}});

function setRules(used: (volume: string) => number, rootUsed: number): void {
  globals.__statfsRules = [{prefix: '/', used: rootUsed}, ...volumes.map(volume => ({prefix: volume, used: used(volume)}))];
  globals.__statfsCalls = [];
}

const fixture = await isolatedDatabase(base, 'disklimit');
const db = new Ledger(fixture.url, undefined, undefined, volumes);
const out: Record<string, unknown> = {volumes};
try {
  await db.migrate();
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  const principal = 'disk-limits-' + randomUUID(), project = randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'disk limits']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
  const capacity = new Capacity(db);
  await capacity.configure(principal, {programmingLimit: 8, evaluationLimit: 8});
  await capacity.registerModel(principal, {provider: 'synthetic-disk', model: 'worker', efforts: ['medium'], roles: ['programmer'], source: 'synthetic://disk'});
  const accountId = randomUUID(), profileId = randomUUID();
  await capacity.addAccount(principal, project, {id: accountId, provider: 'synthetic-disk', label: 'disk', resourceIdentity: accountId, mode: 'synthetic',
    eligibility: 'documented_supported', eligibilitySource: 'synthetic://disk', maxConcurrent: 4});
  await capacity.addProfile(principal, project, {id: profileId, accountId, model: 'worker', effort: 'medium', role: 'programmer'});
  await capacity.observeQuota(principal, accountId, {status: 'available', source: 'synthetic://disk', ttlSeconds: 3600});
  await capacity.publish(principal, project, 0, {schemaVersion: 1, maxProgrammersPerContext: 4, maxEvaluatorsPerContext: 2, roles: {programmer: {regular: [profileId], emergency: []}}});
  const context = await db.createContext(principal, project, randomUUID());
  await capacity.assignPolicy(principal, context, 1);
  const authority = await db.acquire(principal, context, randomUUID(), 'disk-limits-manager', 60);
  const command: Command = {schemaVersion: 1, intentId: randomUUID(), deliveryAttemptId: randomUUID(), contextId: context, policyRevision: 1, action: 'plan.start', payload: {workflow: 'baseline-synthetic-v1', messageRef: 'encrypted:disk-limits'}};
  const intentId = (await db.accept(principal, command, authority, 'api')).id;

  const counts = async () => ({
    grants: Number((await db.pool.query('SELECT count(*)::int n FROM ac_capacity_grants WHERE intent_id=$1', [intentId])).rows[0].n),
    waits: Number((await db.pool.query('SELECT count(*)::int n FROM ac_capacity_waits WHERE intent_id=$1', [intentId])).rows[0].n),
  });
  const request = (attemptId: ReturnType<typeof randomUUID>) => ({attemptId, intentId, contextId: context, role: 'programmer' as const});
  async function reserve(attemptId: `${string}-${string}-${string}-${string}-${string}` = randomUUID()) {
    let grantId: string | undefined;
    const result = await code(async () => { grantId = (await capacity.reserve(principal, request(attemptId), authority)).id; });
    return {result, grantId};
  }
  const release = (id: string) => capacity.transition(principal, id, authority, 'released', {processId: 'disk-limits', state: 'not_started'});
  async function newExam(): Promise<string> {
    let job: Promise<void> | undefined;
    let begun = 'OK';
    try {
      await beginPersonalVerification({projectId: project, dataDirectory: data, repoPath: repo, commit: 'ab'.repeat(20), ledger: db, principal, authority, policyRevision: 1,
        worker: {async run() { return ''; }}, databasesDirectory: databases, image: 'sha256:' + 'ab'.repeat(32),
        runTools: async () => { throw new Error(SENTINEL); }, observe: running => { job = running; }});
    } catch (error) { begun = error instanceof Refusal ? error.code : 'ERR:' + String((error as Error).message).slice(0, 80); }
    if (job) { const failure = await job.then(() => 'DONE', (error: Error) => error.message); return begun + '/' + failure; }
    return begun;
  }
  const newDesign = () => code(() => runDesignModule({activation: 'personal', projectId: project, repo, targetUrl: 'http://127.0.0.1:9/app', dataDirectory: data, launchVolumes: db.launchVolumes!,
    intentId: randomUUID(), runId: randomUUID(), createdAt: new Date(), commit: 'ab'.repeat(20), files: [], worker: {async run() { return ''; }} as never,
    reserve: async () => { throw new Error(SENTINEL); }, release: async () => undefined}));
  const verificationDirectory = async () => (await readdir(data)).includes('verificacoes');

  // Held grant that every later replay and release has to keep reaching.
  setRules(() => 10, 10);
  const held = await reserve(), heldAttempt = (await db.pool.query('SELECT attempt_id FROM ac_capacity_grants WHERE id=$1', [held.grantId])).rows[0].attempt_id as ReturnType<typeof randomUUID>;
  out.baseline = {reserve: held.result, counts: await counts()};

  // One volume at a time at 95: each of them alone blocks, and the root volume at 10 does not matter.
  const single: Record<string, unknown>[] = [];
  for (const hot of volumes) {
    setRules(volume => volume === hot ? 95 : 10, 10);
    const before = await counts();
    const worker = await reserve(), exam = await newExam(), design = await newDesign();
    const after = await counts(), measured = [...globals.__statfsCalls];
    setRules(volume => volume === hot ? 94.99 : 10, 10);
    const admitted = await reserve();
    if (admitted.grantId) await release(admitted.grantId);
    single.push({hot, worker: worker.result, exam, design, unchanged: JSON.stringify(before) === JSON.stringify(after), measuredHot: measured.includes(hot), edgeWorker: admitted.result});
  }
  out.single = single;
  out.noExamDirectoryBeforeAdmission = !(await verificationDirectory());

  // Every volume full: new work refuses, existing work and read paths continue.
  setRules(() => 95, 10);
  const before = await counts();
  const refusedWorker = await reserve(), refusedExam = await newExam(), refusedDesign = await newDesign();
  const replay = await reserve(heldAttempt);
  const released = await code(() => release(held.grantId!));
  const progress = await code(() => readVerificationProgress(data, project));
  const state = (await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1', [held.grantId])).rows[0].state;
  out.full = {refusedWorker: refusedWorker.result, refusedExam, refusedDesign, replay: replay.result, replayId: replay.grantId === held.grantId, released, progress, state,
    newWork: JSON.stringify(before) === JSON.stringify(await counts()) ? 'unchanged' : 'changed', examDirectory: await verificationDirectory()};

  // Installation volumes at 94.99 admit, even with the root volume at 99: the root is not what the installation writes to.
  setRules(() => 94.99, 99);
  const edgeWorker = await reserve();
  if (edgeWorker.grantId) await release(edgeWorker.grantId);
  const edgeExam = await newExam(), edgeDesign = await newDesign();
  out.edge = {worker: edgeWorker.result, exam: edgeExam, design: edgeDesign, measuredRoot: globals.__statfsCalls.includes('/'), measuredAll: volumes.every(volume => globals.__statfsCalls.includes(volume)),
    examDirectory: await verificationDirectory()};

  // Without a list on the Ledger the capacity gate falls back to the root volume, which is the only place it should.
  const bare = new Ledger(fixture.url);
  try {
    setRules(() => 10, 95);
    out.bareRootFallback = await code(async () => { await new Capacity(bare).reserve(principal, request(randomUUID()), authority); });
  } finally { await bare.close(); }
  process.stdout.write('RESULT ' + JSON.stringify(out) + '\n');
} finally {
  await db.close();
  await fixture.close();
  await rm(root, {recursive: true, force: true});
}
