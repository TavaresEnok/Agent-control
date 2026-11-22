import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Capacity} from '../src/capacity.ts';
import {Refusal} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {ProviderCollectors} from '../src/providers.ts';
import {createSyntheticProviderAdapter} from '../src/synthetic-provider-adapter.ts';
import {runSecurityVerification} from '../src/verify-runtime.ts';
import {planSecuritySlices, SECURITY_READ_FACTOR} from '../src/verify-slices.ts';
import {loadSecurityChecklist} from '../src/verify-checklist.ts';
import type {VerifyWorker} from '../src/verify-types.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';


async function bootVerify(label: string, evaluators = 1) {
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
    maxEvaluatorsPerContext: evaluators,
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
    // Sem parada por orçamento, o resultado ainda diz quais arquivos ficaram sem julgamento.
    assert.equal(result.partial, undefined);
    assert.deepEqual(result.pendingFiles, ['src/m01.ts']);
    assert.equal(result.examFiles, 3);
    const blob = await reportBlob(result.directory);
    assert.match(blob, /Arquivo pendente, sem julgamento do examinador: src\/m01\.ts/);
    assert.match(blob, /src\/m01\.ts \| [a-f0-9]{16} \| pendente/);
  } finally { await ready.close(); }
});


test('orçamento de chamadas esgotado no reexame deixa o arquivo pendente em vez de abortar o job', async () => {
  const ready = await bootVerify('vrt_batch_budget');
  try {
    await seed(ready.repo, 4);
    const tasks: string[] = [];
    // map + batch exam use the whole budget; the file left unjudged cannot be asked alone.
    const result = await run(ready, worker(tasks, {unreadFirst: ['src/m02.ts']}), {batch: {tokens: 40_000, files: 8}, modelCallBudget: 2});
    assert.equal(tasks.filter(task => task.startsWith('Pedido de exame.')).length, 1);
    assert.deepEqual(result.coverage.map(row => row.file), ['src/m00.ts', 'src/m01.ts', 'src/m03.ts']);
    const blob = await reportBlob(result.directory);
    assert.match(blob, /Arquivo pendente, sem julgamento do examinador: src\/m02\.ts/);
    assert.match(blob, /orçamento de chamadas do modelo acabou/);
    assert.match(blob, /src\/m02\.ts \| [a-f0-9]{16} \| pendente/);
  } finally { await ready.close(); }
});

/** Exam calls answer after a pause; counts how many run at once. `failAt` makes that file's call fail with a quota refusal. */
function slowWorker(state: {tasks: string[]; inFlight: number; peak: number; started: string[]}, failAt?: string): VerifyWorker {
  const plain = worker(state.tasks);
  return {async run(call) {
    if (!call.task.startsWith('Pedido de exame.')) return plain.run(call);
    const file = call.task.split('\n').find(line => line.startsWith('- '))!.slice(2);
    state.started.push(file);
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    try {
      // Later files answer sooner, so completion order differs from slice order.
      await new Promise(resolve => setTimeout(resolve, 40 - Number(file.match(/\d+/)?.[0] ?? 0) * 3));
      if (file === failAt) throw new Refusal('PROVIDER_USAGE_LIMIT', 409);
      return await plain.run(call);
    } finally { state.inFlight -= 1; }
  }};
}

test('pool do módulo 1: fatias em paralelo até o limite, com cobertura, recibos e relatório iguais aos da execução em série', async () => {
  const ready = await bootVerify('vrt_pool', 2);
  try {
    await seed(ready.repo, 8);
    const serial = {tasks: [] as string[], inFlight: 0, peak: 0, started: [] as string[]};
    const one = await run(ready, slowWorker(serial), {batch: false});
    const parallel = {tasks: [] as string[], inFlight: 0, peak: 0, started: [] as string[]};
    const two = await run(ready, slowWorker(parallel), {batch: false, concurrency: 2});
    assert.equal(serial.peak, 1);
    assert.equal(parallel.peak, 2);
    assert.deepEqual(two.coverage.map(row => row.file), one.coverage.map(row => row.file));
    const receipts = async (directory: string) => (JSON.parse(await readFile(join(directory, 'bruto', 'achados-brutos.json'), 'utf8')) as
      {receipts: {callId: string; files: {file: string; sha256: string; judged: boolean}[]}[]}).receipts
      .map(({callId, files}) => ({callId, files}));
    assert.deepEqual(await receipts(two.directory), await receipts(one.directory));
    // Only ids, times and the receipt digests (which bind those ids) differ between the two runs.
    const notes = async (directory: string) => (await reportBlob(directory)).replace(/[0-9a-f-]{36}/g, '').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '')
      .replace(/\d{8}-\d{6}-[0-9a-f]{8}/g, '').replace(/"digest": "[0-9a-f]+"/g, '').replace(/\| [0-9a-f]{16} \|/g, '|');
    assert.equal(await notes(two.directory), await notes(one.directory));
  } finally { await ready.close(); }
});

test('pool do módulo 1: limite de cota numa fatia para de abrir chamadas, espera as que já rodam e falha o exame', async () => {
  const ready = await bootVerify('vrt_pool_quota', 2);
  try {
    await seed(ready.repo, 8);
    const state = {tasks: [] as string[], inFlight: 0, peak: 0, started: [] as string[]};
    await assert.rejects(run(ready, slowWorker(state, 'src/m02.ts'), {batch: false, concurrency: 2}),
      (error: unknown) => error instanceof Refusal && error.code === 'PROVIDER_USAGE_LIMIT');
    assert.equal(state.inFlight, 0, 'nenhuma chamada fica rodando depois da falha');
    assert.ok(state.started.length <= 4, `chamadas abertas: ${state.started.join(', ')}`);
    assert.equal(state.started.includes('src/m07.ts'), false);
  } finally { await ready.close(); }
});

test('módulo 1: testes, documentação e gerados saem do modelo com nota, seguem legíveis na confirmação e a opção do projeto volta tudo', async () => {
  const ready = await bootVerify('vrt_production');
  try {
    await mkdir(join(ready.repo, 'src', '__tests__'), {recursive: true});
    await mkdir(join(ready.repo, 'docs'), {recursive: true});
    await mkdir(join(ready.repo, 'api'), {recursive: true});
    await writeFile(join(ready.repo, 'src', 'app.ts'), 'export const app = 1;\n');
    await writeFile(join(ready.repo, 'src', 'app.test.ts'), 'export const helperValue = 42;\n');
    await writeFile(join(ready.repo, 'src', '__tests__', 'util.ts'), 'export {};\n');
    await writeFile(join(ready.repo, 'docs', 'guia.md'), '# Guia\n');
    await writeFile(join(ready.repo, 'package-lock.json'), '{}\n');
    await writeFile(join(ready.repo, 'api', 'openapi.json'), '{}\n');
    await writeFile(join(ready.repo, 'src', 'schema.ts'), '/**\n * This file was auto-generated by openapi-typescript.\n */\nexport {};\n' + '// s\n'.repeat(3000));
    await writeFile(join(ready.repo, 'requirements.txt'), 'flask==3.0.0\n');
    // A route under a folder named test is production code and stays with the examiner.
    await mkdir(join(ready.repo, 'app', 'api', 'test'), {recursive: true});
    await writeFile(join(ready.repo, 'app', 'api', 'test', 'route.ts'), 'export const GET = () => 1;\n');
    await mkdir(join(ready.repo, 'dbgen'), {recursive: true});
    for (let index = 1; index <= 6; index++) await writeFile(join(ready.repo, 'dbgen', `q${index}.sql.go`), '// Code generated by sqlc. DO NOT EDIT.\npackage dbgen\n' + '// q\n'.repeat(3000));
    const examined = (tasks: string[]) => tasks.filter(task => task.startsWith('Pedido de exame.')).flatMap(task => {
      const lines = task.split('\n');
      const after = lines.slice(lines.indexOf('Arquivos:') + 1);
      return after.slice(0, after.findIndex(line => !line.startsWith('- '))).map(line => line.slice(2));
    }).sort();
    const tasks: string[] = [];
    const confirm: VerifyWorker = {async run(call) {
      if (call.task.startsWith('Pedido de confirmação.')) {
        tasks.push(call.task);
        return JSON.stringify({kind: 'confirmacao', status: 'provavel', reason: 'r', proof: 'p'});
      }
      return worker(tasks).run(call);
    }};
    const rawFindings = [{tool: 'gitleaks', rule: 'generic-api-key', cwe: null, file: 'src/app.test.ts', line: 1, severity: 'media', snippet: 'token', fingerprint: 'a'.repeat(64)}];
    const result = await run(ready, confirm, {batch: {tokens: 40_000, files: 8}, rawFindings});
    assert.deepEqual(examined(tasks), ['app/api/test/route.ts', 'requirements.txt', 'src/app.ts']);
    assert.deepEqual(result.coverage.map(row => row.file), ['app/api/test/route.ts', 'requirements.txt', 'src/app.ts']);
    const confirmation = tasks.find(task => task.startsWith('Pedido de confirmação.'))!;
    assert.match(confirmation, /export const helperValue = 42;/, 'o achado da ferramenta no teste é confirmado lendo o arquivo');
    const blob = await reportBlob(result.directory);
    assert.match(blob, /Ficaram fora do exame do modelo 2 testes: src\/__tests__\/util\.ts, src\/app\.test\.ts/);
    assert.match(blob, /Ficaram fora do exame do modelo 1 documentação: docs\/guia\.md/);
    // Every generated file is named, past the five shown for the other classes.
    assert.match(blob, /Ficaram fora do exame do modelo 9 arquivos gerados: api\/openapi\.json, dbgen\/q1\.sql\.go, dbgen\/q2\.sql\.go, dbgen\/q3\.sql\.go, dbgen\/q4\.sql\.go, dbgen\/q5\.sql\.go, dbgen\/q6\.sql\.go, package-lock\.json, src\/schema\.ts\. /);

    const all: string[] = [];
    await run(ready, worker(all), {batch: {tokens: 40_000, files: 8}, productionOnly: false});
    assert.equal(examined(all).length, 15);
  } finally { await ready.close(); }
});
