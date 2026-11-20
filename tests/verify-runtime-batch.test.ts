import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Capacity} from '../src/capacity.ts';
import {Ledger} from '../src/ledger.ts';
import {ProviderCollectors} from '../src/providers.ts';
import {createSyntheticProviderAdapter} from '../src/synthetic-provider-adapter.ts';
import {runSecurityVerification} from '../src/verify-runtime.ts';
import {planSecuritySlices, SECURITY_READ_FACTOR} from '../src/verify-slices.ts';
import {loadSecurityChecklist} from '../src/verify-checklist.ts';
import type {VerifyWorker} from '../src/verify-types.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';


async function bootVerify(label: string) {
  const url = process.env.AC_TEST_DATABASE_URL;
  assert.ok(url);
  const database = await isolatedDatabase(url, label);
  const db = new Ledger(database.url);
  const capacity = new Capacity(db);
  const repo = await mkdtemp(join(tmpdir(), 'ac-verify-repo-'));
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ac-verify-data-'));
  await db.migrate();
  const principal = 'verify-owner';
  const project = randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Verificação']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
  await capacity.configure(principal, {programmingLimit: 10, evaluationLimit: 2});
  await capacity.registerModel(principal, {provider: 'claude', model: 'fixture-model', efforts: ['medium'], roles: ['specialist', 'reviewer'], source: 'synthetic://verify-runtime'});
  const labels = ['claude-a', 'claude-b'] as const;
  const accounts = labels.map(() => randomUUID());
  const specialistProfiles = labels.map(() => randomUUID());
  const reviewerProfiles = labels.map(() => randomUUID());
  const adapters = labels.map(label => createSyntheticProviderAdapter({
    id: 'fixture-' + label,
    provider: 'claude',
    version: 'verify-v1',
    runner: async input => ({protocol: 'ac-synthetic-quota-v1', provider: 'claude', accountId: input.accountId, status: 'available', remainingPercent: 75, resetAt: null}),
  }));
  const collectors = new ProviderCollectors(db, adapters);
  for (let i = 0; i < labels.length; i++) {
    await capacity.addAccount(principal, project, {id: accounts[i], provider: 'claude', label: 'Synthetic ' + labels[i], resourceIdentity: 'verify-' + accounts[i], mode: 'synthetic', eligibility: 'documented_supported', eligibilitySource: 'synthetic://verify-runtime', maxConcurrent: 2});
    await capacity.addProfile(principal, project, {id: specialistProfiles[i], accountId: accounts[i], model: 'fixture-model', effort: 'medium', role: 'specialist'});
    await capacity.addProfile(principal, project, {id: reviewerProfiles[i], accountId: accounts[i], model: 'fixture-model', effort: 'medium', role: 'reviewer'});
    await collectors.bind(principal, project, {accountId: accounts[i], adapterId: adapters[i].manifest.id, expectedRevision: 0, minimumIntervalSeconds: 1});
  }
  const revision = await capacity.publish(principal, project, 0, {
    schemaVersion: 1,
    maxProgrammersPerContext: 1,
    maxEvaluatorsPerContext: 1,
    roles: {specialist: {regular: specialistProfiles, emergency: []}, reviewer: {regular: reviewerProfiles, emergency: []}},
  });
  const context = await db.createContext(principal, project, randomUUID());
  await capacity.assignPolicy(principal, context, revision);
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  await db.pool.query("UPDATE ac_provider_bindings SET last_started_at=clock_timestamp()-interval '2 seconds'");
  for (const accountId of accounts) await collectors.collect(principal, project, accountId, randomUUID());
  const authority = await db.acquire(principal, context, randomUUID(), label, 60);
  return {
    db, database, repo, dataDirectory, principal, project, authority,
    async close() {
      await db.close();
      await database.close();
      await rm(repo, {recursive: true, force: true});
      await rm(dataDirectory, {recursive: true, force: true});
    },
  };
}

async function reportBlob(root: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, {withFileTypes: true})) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) parts.push(await readFile(full, 'utf8'));
    }
  };
  await walk(root);
  return parts.join('\n');
}

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
type Behavior = {unreadFirst?: string[]; invalidFirst?: boolean; neverRead?: string[]};

/** Answers map, exam and confirm. `behavior` makes a multi-file slice leave files unjudged or come back invalid. */
function worker(tasks: string[], behavior: Behavior = {}): VerifyWorker {
  let firstExam = true;
  return {async run(call) {
    tasks.push(call.task);
    if (call.task.startsWith('Pedido de mapa.')) return JSON.stringify({kind: 'mapa', routes: [], surfaces: []});
    if (call.task.startsWith('Pedido de exame.')) {
      const lines = call.task.split('\n');
      const at = lines.findIndex(line => line === 'Arquivos:');
      const files: string[] = [];
      for (const line of lines.slice(at + 1)) { if (!line.startsWith('- ')) break; files.push(line.slice(2)); }
      const items = (call.task.match(/^Itens: (.*)$/m)?.[1] ?? '').split(',').map(item => item.trim()).filter(Boolean);
      const first = firstExam && files.length > 1;
      if (files.length > 1) firstExam = false;
      if (first && behavior.invalidFirst) return 'isto não é JSON';
      const unread = new Set([...(first ? behavior.unreadFirst ?? [] : []), ...(behavior.neverRead ?? [])]);
      const read = files.filter(file => !unread.has(file));
      return JSON.stringify({kind: 'exame', filesRead: read.length ? read : ['src/nunca.ts'], checklist: items.length ? items : ['SEM-ITEM'], findings: []});
    }
    throw new Error('task inesperada');
  }};
}

async function seed(repo: string, count: number) {
  await mkdir(join(repo, 'src'), {recursive: true});
  for (let index = 0; index < count; index += 1) await writeFile(join(repo, 'src', `m${String(index).padStart(2, '0')}.ts`), `export const v${index} = ${index};\n`);
}

async function run(ready: Awaited<ReturnType<typeof bootVerify>>, w: VerifyWorker, extra: Record<string, unknown> = {}) {
  return runSecurityVerification({ledger: ready.db, principal: ready.principal, authority: ready.authority, projectId: ready.project,
    repoPath: ready.repo, dataDirectory: ready.dataDirectory, commit: COMMIT, policyRevision: 1, worker: w, ...extra});
}

test('fatias do módulo 1 seguem o orçamento do projeto e a opção desligada manda um arquivo por chamada', () => {
  const files = Array.from({length: 20}, (_, index) => `src/m${String(index).padStart(2, '0')}.ts`);
  const checklist = loadSecurityChecklist();
  const small = new Map(files.map(file => [file, 100]));
  assert.deepEqual(planSecuritySlices(files, checklist, small, undefined).map(slice => slice.files.length), [15, 5]);
  assert.deepEqual(planSecuritySlices(files, checklist, small, {tokens: 40_000, files: 8}).map(slice => slice.files.length), [15, 5]);
  assert.equal(planSecuritySlices(files, checklist, small, false).length, 20);
  const big = new Map(small);
  big.set('src/m03.ts', 40_000 * SECURITY_READ_FACTOR + 1);
  const sizes = planSecuritySlices(files, checklist, big, {tokens: 40_000, files: 8}).map(slice => slice.files);
  assert.deepEqual(sizes.map(group => group.length), [3, 1, 15, 1]);
  assert.deepEqual(sizes[1], ['src/m03.ts']);
});

test('lote de segurança: uma chamada para o grupo, recibo por arquivo e opção desligada volta ao arquivo a arquivo', async () => {
  const ready = await bootVerify('vrt_batch');
  try {
    await seed(ready.repo, 6);
    const grouped: string[] = [];
    const result = await run(ready, worker(grouped), {batch: {tokens: 40_000, files: 8}});
    const groupedExams = grouped.filter(task => task.startsWith('Pedido de exame.'));
    assert.equal(groupedExams.length, 1);
    assert.equal(result.coverage.length, 6);
    const blob = await reportBlob(result.directory);
    assert.match(blob, /## Recibos das chamadas/);
    for (let index = 0; index < 6; index += 1) assert.match(blob, new RegExp(`src/m0${index}\\.ts \\| [a-f0-9]{16} \\| sim`));
    const raw = JSON.parse(await readFile(join(result.directory, 'bruto', 'achados-brutos.json'), 'utf8')) as {receipts: {digest: string; files: {file: string; sha256: string; judged: boolean}[]}[]};
    assert.equal(raw.receipts.length, 1);
    assert.equal(raw.receipts[0]!.files.length, 6);
    assert.ok(raw.receipts[0]!.files.every(item => item.judged && /^[a-f0-9]{64}$/.test(item.sha256)));

    const single: string[] = [];
    const off = await run(ready, worker(single), {batch: false});
    const singleExams = single.filter(task => task.startsWith('Pedido de exame.'));
    assert.equal(singleExams.length, 6);
    assert.equal(off.coverage.length, 6);
    const chars = (list: string[]) => list.reduce((sum, task) => sum + task.length, 0);
    console.log(`segurança lote: ${singleExams.length} chamadas de exame e ${chars(singleExams)} caracteres sem lote; ${groupedExams.length} chamada e ${chars(groupedExams)} com lote`);
    assert.ok(chars(groupedExams) < chars(singleExams));
  } finally { await ready.close(); }
});

test('arquivo que o lote não julgou é pedido sozinho e nenhum fica sem julgamento calado', async () => {
  const ready = await bootVerify('vrt_batch_gap');
  try {
    await seed(ready.repo, 4);
    const tasks: string[] = [];
    const result = await run(ready, worker(tasks, {unreadFirst: ['src/m02.ts']}), {batch: {tokens: 40_000, files: 8}});
    const exams = tasks.filter(task => task.startsWith('Pedido de exame.'));
    assert.equal(exams.length, 2);
    assert.match(exams[1]!, /Fatia: fatia-1-src\/m02\.ts/);
    assert.deepEqual(result.coverage.map(row => row.file), ['src/m00.ts', 'src/m01.ts', 'src/m02.ts', 'src/m03.ts']);
    const blob = await reportBlob(result.directory);
    assert.match(blob, /src\/m02\.ts \| [a-f0-9]{16} \| pendente/);
    assert.match(blob, /src\/m02\.ts \| [a-f0-9]{16} \| sim/);
  } finally { await ready.close(); }
});

test('envelope inválido cai para chamadas individuais e o arquivo que nunca é lido aparece como pendente', async () => {
  const ready = await bootVerify('vrt_batch_bad');
  try {
    await seed(ready.repo, 3);
    const tasks: string[] = [];
    const result = await run(ready, worker(tasks, {invalidFirst: true, neverRead: ['src/m01.ts']}), {batch: {tokens: 40_000, files: 8}});
    const exams = tasks.filter(task => task.startsWith('Pedido de exame.'));
    assert.equal(exams.length, 4);
    assert.deepEqual(result.coverage.map(row => row.file), ['src/m00.ts', 'src/m02.ts']);
    const blob = await reportBlob(result.directory);
    assert.match(blob, /Arquivo pendente, sem julgamento do examinador: src\/m01\.ts/);
    assert.match(blob, /src\/m01\.ts \| [a-f0-9]{16} \| pendente/);
  } finally { await ready.close(); }
});

