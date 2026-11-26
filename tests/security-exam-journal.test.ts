// The host disk is not what this file proves: a fixed reading keeps a server disk near 95% from refusing these flows.
import {useFixedDisk} from './fixtures/fixed-disk.ts';
useFixedDisk();
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, randomUUID, sign} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Capacity} from '../src/capacity.ts';
import {canonical, digest} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {ProviderCollectors} from '../src/providers.ts';
import {createSyntheticProviderAdapter} from '../src/synthetic-provider-adapter.ts';
import {runSecurityVerification} from '../src/verify-runtime.ts';
import {
  appendSecurityJournal, confirmationKey, journaledJudgment, loadSecurityJournal, parseExamTask, securityJournalPath,
  type ImportedExamJob, type JournalExam,
} from '../src/security-exam-journal.ts';
import {securityExamJobsFromStore} from '../src/security-exam-journal-jobs.ts';
import type {VerifyWorker} from '../src/verify-types.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';
const SHA = 'a'.repeat(64);
const seat = {provider: 'claude', model: 'claude-sonnet-5-5', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()};

function exam(file: string, sha256: string, checklist = ['A', 'B']): JournalExam {
  return {kind: 'exame', schemaVersion: 1, commit: COMMIT, intentId: 'intent-1', jobId: null, sliceId: 'fatia-1', checklist, declared: checklist,
    files: [{file, sha256, judged: true}], findings: [], seat, sessionId: null};
}

test('diário: só reaproveita o mesmo commit, o mesmo conteúdo e os mesmos itens; linha quebrada é ignorada', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ac-journal-'));
  try {
    const path = securityJournalPath(dir, 'proj', COMMIT);
    const journal = await loadSecurityJournal(path, COMMIT);
    assert.equal(journal.exams.length, 0);
    assert.equal(await appendSecurityJournal(journal, exam('src/a.ts', SHA)), true);
    assert.equal(await appendSecurityJournal(journal, {...exam('src/b.ts', SHA), commit: OTHER}), false);
    await writeFile(path, (await readFile(path, 'utf8')) + 'não é json\n' + JSON.stringify({...exam('src/c.ts', SHA), commit: OTHER}) + '\n');
    const again = await loadSecurityJournal(path, COMMIT);
    assert.equal(again.exams.length, 1);
    assert.ok(journaledJudgment(again, 'src/a.ts', SHA, ['A']));
    assert.equal(journaledJudgment(again, 'src/a.ts', 'b'.repeat(64), ['A']), undefined, 'conteúdo mudou');
    assert.equal(journaledJudgment(again, 'src/a.ts', null, ['A']), undefined, 'arquivo ilegível');
    assert.equal(journaledJudgment(again, 'src/a.ts', SHA, ['A', 'C']), undefined, 'item não julgado');
    const finding = {file: 'src/a.ts', line: 3, title: 'x', snippet: 'y', severity: 'media' as const, rule: null};
    assert.notEqual(confirmationKey(finding, SHA), confirmationKey(finding, 'b'.repeat(64)));
    assert.notEqual(confirmationKey(finding, SHA), confirmationKey({...finding, line: 4}, SHA));
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('diário: lê a fatia, os arquivos e os itens do pedido de exame', () => {
  assert.deepEqual(parseExamTask('Pedido de exame.\nResponda...\nFatia: fatia-3\nArquivos:\n- a.ts\n- b/c.go\nItens: A01, B02\nMapa:'),
    {sliceId: 'fatia-3', files: ['a.ts', 'b/c.go'], checklist: ['A01', 'B02']});
  assert.equal(parseExamTask('Pedido de confirmação.\nFatia: x'), undefined);
  assert.equal(parseExamTask('Pedido de exame.\nFatia: x\nArquivos:\nItens: A'), undefined);
});

test('jobs antigos: só entra o job com recibo assinado, saída íntegra e as mesmas identidades do banco', async () => {
  const host = await mkdtemp(join(tmpdir(), 'ac-journal-host-'));
  try {
    const {privateKey} = generateKeyPairSync('ed25519');
    const pem = privateKey.export({type: 'pkcs8', format: 'pem'}).toString();
    const other = generateKeyPairSync('ed25519').privateKey;
    const rows: Record<string, unknown>[] = [];
    const make = async (label: 'ok' | 'tampered' | 'unsigned' | 'mismatch') => {
      const id = randomUUID(), intent = randomUUID(), session = randomUUID(), account = randomUUID(), profile = randomUUID(), grant = randomUUID();
      const output = JSON.stringify({kind: 'exame', filesRead: ['a.ts'], checklist: ['A'], findings: []});
      const payload = {schemaVersion: 1, jobId: id, intentId: intent, accountId: account, profileId: profile, grantId: grant, sessionId: session, exitCode: 0, outputDigest: digest(output)};
      const key = label === 'unsigned' ? other : privateKey;
      const signature = sign(null, Buffer.from('agent-control:native-execution-receipt:v1\n' + canonical(payload)), key).toString('hex');
      await mkdir(join(host, id, 'output'), {recursive: true, mode: 0o700});
      const saved = label === 'tampered' ? output.replace('"A"', '"B"') : output;
      await writeFile(join(host, id, 'output', 'execution-result.json'), JSON.stringify({schemaVersion: 1, jobId: id, output: saved, normalizedTokensUsed: null, usageWindows: null, nativeSessionId: null, failureCode: null, exitCode: 0}), {mode: 0o600});
      await writeFile(join(host, id, 'request.json'), JSON.stringify({jobId: id, intentId: intent, task: 'Pedido de exame.\nFatia: f\nArquivos:\n- a.ts\nItens: A'}), {mode: 0o600});
      await chmod(join(host, id, 'request.json'), 0o600);
      rows.push({id, intent_id: intent, session_id: label === 'mismatch' ? randomUUID() : session, account_id: account, profile_id: profile, grant_id: grant,
        receipt: {payload, signature}, model: 'claude-sonnet-5-5', provider: 'claude'});
      return id;
    };
    const good = await make('ok');
    await make('tampered');
    await make('unsigned');
    await make('mismatch');
    const queries: unknown[][] = [];
    const jobs = await securityExamJobsFromStore({
      pool: {async query(_text, values) { queries.push(values ?? []); return {rows}; }},
      hostRoot: host, signingKeyPem: pem, projectId: 'proj', commit: COMMIT,
    });
    assert.deepEqual(jobs.map(job => job.jobId), [good]);
    assert.deepEqual(queries[0], ['proj', COMMIT, 'security-verify-readonly-v1']);
    assert.equal(jobs[0]!.seat.model, 'claude-sonnet-5-5');
  } finally { await rm(host, {recursive: true, force: true}); }
});

async function bootVerify(label: string, evaluators = 1) {
  const url = process.env.AC_TEST_DATABASE_URL;
  assert.ok(url);
  const database = await isolatedDatabase(url, label);
  const db = new Ledger(database.url);
  const capacity = new Capacity(db);
  const repo = await mkdtemp(join(tmpdir(), 'ac-journal-repo-'));
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ac-journal-data-'));
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
  const adapters = labels.map(name => createSyntheticProviderAdapter({
    id: 'fixture-' + name, provider: 'claude', version: 'verify-v1',
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
    schemaVersion: 1, maxProgrammersPerContext: 1, maxEvaluatorsPerContext: evaluators,
    roles: {specialist: {regular: specialistProfiles, emergency: []}, reviewer: {regular: reviewerProfiles, emergency: []}},
  });
  const context = await db.createContext(principal, project, randomUUID());
  await capacity.assignPolicy(principal, context, revision);
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  await db.pool.query("UPDATE ac_provider_bindings SET last_started_at=clock_timestamp()-interval '2 seconds'");
  for (const accountId of accounts) await collectors.collect(principal, project, accountId, randomUUID());
  const authority = await db.acquire(principal, context, randomUUID(), label, 60);
  return {
    db, repo, dataDirectory, principal, project, authority,
    async close() {
      await db.close();
      await database.close();
      await rm(repo, {recursive: true, force: true});
      await rm(dataDirectory, {recursive: true, force: true});
    },
  };
}

/** Every exam reports one finding per file; the confirmation fails while `failConfirm` is set (a usage limit, say). */
function worker(calls: {task: string; output: string}[], state: {failConfirm: boolean}): VerifyWorker {
  return {async run(call) {
    let output: string;
    if (call.task.startsWith('Pedido de mapa.')) output = JSON.stringify({kind: 'mapa', routes: [], surfaces: []});
    else if (call.task.startsWith('Pedido de exame.')) {
      const task = parseExamTask(call.task)!;
      output = JSON.stringify({kind: 'exame', filesRead: task.files, checklist: task.checklist, findings: task.files.map(file => ({
        title: `Ponto em ${file}`, severity: 'media', file, line: 1, scenario: 'cenário', suggestion: 'corrigir', cwe: null, reference: 'ref', snippet: 'export const',
      }))});
    } else if (call.task.startsWith('Pedido de confirmação.')) {
      if (state.failConfirm) throw new Error('PROVIDER_USAGE_LIMIT');
      output = JSON.stringify({kind: 'confirmacao', status: 'confirmado', reason: 'visto', proof: 'linha 1'});
    } else throw new Error('task inesperada');
    calls.push({task: call.task, output});
    return output;
  }};
}

const count = (calls: {task: string}[], prefix: string) => calls.filter(call => call.task.startsWith(prefix)).length;

test('rodada que cai na confirmação não perde o exame: a seguinte reaproveita julgamentos e confirmações do diário', async () => {
  const ready = await bootVerify('sej_resume');
  try {
    await mkdir(join(ready.repo, 'src'), {recursive: true});
    for (const name of ['a', 'b', 'c']) await writeFile(join(ready.repo, 'src', `${name}.ts`), `export const ${name} = 1;\n`);
    const journalPath = securityJournalPath(ready.dataDirectory, ready.project, COMMIT);
    const run = (w: VerifyWorker, extra: Record<string, unknown> = {}) => runSecurityVerification({ledger: ready.db, principal: ready.principal, authority: ready.authority,
      projectId: ready.project, repoPath: ready.repo, dataDirectory: ready.dataDirectory, commit: COMMIT, policyRevision: 1, worker: w, journalPath, ...extra});

    const first: {task: string; output: string}[] = [];
    await assert.rejects(run(worker(first, {failConfirm: true})));
    assert.equal(count(first, 'Pedido de exame.'), 1);
    assert.equal((await loadSecurityJournal(journalPath, COMMIT)).exams.length, 1);

    const second: {task: string; output: string}[] = [];
    const resumed = await run(worker(second, {failConfirm: false}));
    assert.equal(count(second, 'Pedido de exame.'), 0, 'o exame já pago não se repete');
    assert.equal(count(second, 'Pedido de confirmação.'), 3);
    assert.equal(resumed.coverage.length, 3);
    assert.deepEqual(resumed.pendingFiles, []);
    assert.equal(resumed.achados.length, 3);
    assert.ok(resumed.achados.every(item => item.status === 'confirmado'));

    await writeFile(join(ready.repo, 'src', 'b.ts'), 'export const b = 2;\n');
    const third: {task: string; output: string}[] = [];
    const changed = await run(worker(third, {failConfirm: false}));
    assert.equal(count(third, 'Pedido de exame.'), 1);
    assert.match(third.find(call => call.task.startsWith('Pedido de exame.'))!.task, /Arquivos:\n- src\/b\.ts\nItens:/);
    assert.equal(count(third, 'Pedido de confirmação.'), 1, 'só o achado do arquivo mudado é confirmado de novo');
    assert.equal(changed.achados.length, 3);

    // Jobs de rodadas anteriores entram num diário novo pelos recibos: nenhuma chamada de exame se repete.
    const fresh = join(ready.dataDirectory, 'outro-diario.jsonl');
    const jobs: ImportedExamJob[] = [...second, ...third, ...first].filter(call => call.task.startsWith('Pedido de exame.')).map(call => ({
      jobId: randomUUID(), intentId: randomUUID(), task: call.task, output: call.output, seat, sessionId: null,
    }));
    const fourth: {task: string; output: string}[] = [];
    const imported = await run(worker(fourth, {failConfirm: false}), {journalPath: fresh, importExamJobs: async () => jobs});
    assert.equal(count(fourth, 'Pedido de exame.'), 0);
    assert.equal(imported.coverage.length, 3);
    assert.equal((await loadSecurityJournal(fresh, COMMIT)).exams.length, 2);
  } finally { await ready.close(); }
});

test('confirmações em paralelo pelo revisor escolhido no projeto, relatório na ordem original e tudo no diário', async () => {
  const ready = await bootVerify('sej_parallel', 3);
  try {
    await mkdir(join(ready.repo, 'src'), {recursive: true});
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) await writeFile(join(ready.repo, 'src', `${name}.ts`), `export const ${name} = 1;\n`);
    const journalPath = securityJournalPath(ready.dataDirectory, ready.project, COMMIT);
    let inFlight = 0, peak = 0;
    const calls: {task: string; output: string}[] = [];
    const base = worker(calls, {failConfirm: false});
    const slow: VerifyWorker = {async run(call) {
      if (!call.task.startsWith('Pedido de confirmação.')) return base.run(call);
      inFlight += 1; peak = Math.max(peak, inFlight);
      try { await new Promise(done => setTimeout(done, 150)); return await base.run(call); } finally { inFlight -= 1; }
    }};
    const run = (extra: Record<string, unknown>) => runSecurityVerification({ledger: ready.db, principal: ready.principal, authority: ready.authority,
      projectId: ready.project, repoPath: ready.repo, dataDirectory: ready.dataDirectory, commit: COMMIT, policyRevision: 1, worker: slow, journalPath, ...extra});
    await assert.rejects(run({confirmConcurrency: 2, reviewer: {model: 'outro-modelo', effort: 'medium'}}),
      (error: unknown) => (error as {code?: string}).code === 'VERIFY_REVIEWER_UNAVAILABLE');
    const result = await run({confirmConcurrency: 2, reviewer: {model: 'fixture-model', effort: 'medium'}});
    assert.equal(peak, 2, 'duas confirmações ao mesmo tempo');
    assert.equal(count(calls, 'Pedido de confirmação.'), 6);
    assert.deepEqual(result.achados.map(item => item.where.file), ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts']);
    assert.deepEqual(result.achados.map(item => item.id), ['ACH-001', 'ACH-002', 'ACH-003', 'ACH-004', 'ACH-005', 'ACH-006']);
    assert.ok(result.achados.every(item => item.verifier?.model === 'fixture-model'));
    assert.equal((await loadSecurityJournal(journalPath, COMMIT)).confirms.size, 6);
  } finally { await ready.close(); }
});
