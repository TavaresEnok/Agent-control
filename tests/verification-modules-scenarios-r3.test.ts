import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {listModuleReports, reconcileModuleReports, runVerificationModule} from '../src/verification-modules.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const url = process.env.AC_TEST_DATABASE_URL;
const finding = (file: string) => ({tool: 'synthetic', rule: 'rule', file, line: 1, severity: 'baixa', message: 'synthetic', evidence: 'synthetic'});
const output = (file: string) => ({coverage: [{tool: 'synthetic', version: '2', status: 'ok', detail: 'synthetic', files: [file]}], findings: [finding(file)]});
const refusal = (code: string) => (error: unknown) => error instanceof Refusal && error.code === code;

test('cenários sintéticos: isolamento, caminhos, processo e identidade do examinador', {skip: url ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const database = await isolatedDatabase(url!, 'vmodr3scenario');
  const db = new Ledger(database.url);
  const root = await mkdtemp(join(tmpdir(), 'ac-vmod-r3-'));
  try {
    const repo = join(root, 'repo');
    const otherRepo = join(root, 'other');
    const data = join(root, 'data');
    await mkdir(join(repo, '.github', 'workflows'), {recursive: true});
    await mkdir(otherRepo);
    await mkdir(data);
    await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'name: CI\n');
    await writeFile(join(repo, 'app.ts'), 'export const x = 1;\n');
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
    git('init'); git('add', '.'); git('-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
    const commit = git('rev-parse', 'HEAD');
    await db.migrate();
    const principal = 'synthetic-owner';
    const projectId = randomUUID();
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [projectId, 'Synthetic']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [projectId, principal]);
    await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)', [projectId, repo]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await db.createContext(principal, projectId, randomUUID());
    const exam = await db.ensureExamContext(principal, projectId, 'qa');
    const authority = await db.acquire(principal, exam.contextId, randomUUID(), 'personal-qa', 60);
    const base = {module: 'qa' as const, ledger: db, principal, authority, projectId, repoPath: repo, dataDirectory: data, commit};

    const inside = join(repo, 'private-data');
    await mkdir(inside);
    const alias = join(root, 'alias');
    await symlink(inside, alias);
    await assert.rejects(() => runVerificationModule({...base, dataDirectory: alias, collectorOutput: output('app.ts')}), refusal('VERIFY_REPORT_INSIDE_REPO'));
    await assert.rejects(() => runVerificationModule({...base, repoPath: otherRepo, collectorOutput: output('app.ts')}), refusal('PROJECT_SCOPE_MISMATCH'));

    const github = await runVerificationModule({...base, collectorOutput: output('.github/workflows/ci.yml')});
    assert.equal(github.hasToolFailure, false);
    assert.equal(github.achados[0]?.where.file, '.github/workflows/ci.yml');
    const absent = await runVerificationModule({...base, collectorOutput: output('missing.ts')});
    assert.equal(absent.hasToolFailure, true);
    assert.deepEqual(absent.achados, []);
    assert.equal(absent.toolCoverage[0]?.status, 'failed');
    const failed = await runVerificationModule({...base, runCollector: async () => {throw Error('synthetic process failure');}});
    assert.equal(failed.hasToolFailure, true);
    assert.equal(failed.toolCoverage[0]?.status, 'failed');
    const recorded = await db.pool.query('SELECT status FROM ac_verify_runs WHERE id=$1', [failed.runId]);
    assert.equal(recorded.rows[0]?.status, 'failed');
    assert.match(await readFile(join(failed.directory, 'README.md'), 'utf8'), /falha/i);

    // The server commits, but the client observes a lost COMMIT acknowledgement.
    const ackRun = randomUUID();
    const originalTx = db.tx.bind(db);
    db.tx = (async fn => {
      const value = await originalTx(fn);
      if (value && typeof value === 'object' && 'summary' in value) throw Error('synthetic lost commit ACK');
      return value;
    }) as typeof db.tx;
    try {
      await assert.rejects(runVerificationModule({...base, runId:ackRun,
        collectorOutput:{coverage:[{tool:'synthetic', version:'1', status:'ok', detail:'ok', files:['app.ts']}], findings:[]}}), /synthetic lost commit ACK/);
    } finally { db.tx = originalTx; }
    const ackRow = (await db.pool.query('SELECT status,report_dir FROM ac_verify_runs WHERE id=$1', [ackRun])).rows[0];
    assert.equal(ackRow.status, 'done');
    assert.ok(await readFile(join(ackRow.report_dir, '.run-pending.json'), 'utf8'));
    await reconcileModuleReports(db, principal, authority, data, projectId);
    assert.ok((await listModuleReports(data, projectId)).some(item => item.id === ackRun));

    let workerCalls = 0;
    await assert.rejects(() => runVerificationModule({...base, collectorOutput: output('app.ts'), worker: {run: async () => {workerCalls++; return '{}';}}}));
    assert.equal(workerCalls, 0, 'sem reserva comprovada, o worker não recebe identidade fabricada');
    // Perde o processo depois da preparação e antes do COMMIT, sem executar
    // a transação de compensação. Somente a reserva sobrevive no banco.
    const orphanId = randomUUID();
    let interrupted = false;
    db.tx = (async fn => {
      if (interrupted) throw Error('synthetic connection unavailable');
      return originalTx(async client => {
        const value = await fn(client);
        if (value && typeof value === 'object' && 'summary' in value) {
          interrupted = true;
          throw Error('synthetic stop before commit');
        }
        return value;
      });
    }) as typeof db.tx;
    try {
      await assert.rejects(runVerificationModule({...base, runId: orphanId, collectorOutput: output('app.ts')}), /synthetic stop before commit/);
    } finally {
      db.tx = originalTx;
    }
    const {rows: [orphan]} = await db.pool.query(
      'SELECT status, report_dir, report_prepared_dir FROM ac_verify_runs WHERE id=$1', [orphanId],
    );
    assert.equal(orphan.status, 'running');
    assert.equal(orphan.report_dir, 'pending');
    assert.ok(await readFile(join(orphan.report_prepared_dir, '.run-pending.json'), 'utf8'));
    assert.ok(!(await listModuleReports(data, projectId)).some(item => item.id === orphanId));
    await assert.rejects(() => runVerificationModule({...base, collectorOutput: output('app.ts')}), refusal('VERIFY_ALREADY_RUNNING'));
    await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1", [exam.contextId]);
    const nextAuthority = await db.acquire(principal, exam.contextId, randomUUID(), 'personal-qa', 60);
    const retried = await runVerificationModule({...base, authority: nextAuthority, collectorOutput: output('app.ts')});
    assert.equal(retried.hasToolFailure, false);
    const abandoned = await db.pool.query('SELECT r.status, i.state FROM ac_verify_runs r JOIN ac_intents i ON i.id=r.intent_id WHERE r.id=$1', [orphanId]);
    assert.deepEqual(abandoned.rows[0], {status: 'failed', state: 'failed'});
    await assert.rejects(stat(orphan.report_prepared_dir), {code: 'ENOENT'});
    const hidden = join(root, 'interrupted-storage');
    await rename(join(data, 'verificacoes'), hidden);
    await assert.rejects(reconcileModuleReports(db, principal, nextAuthority, data, projectId), refusal('VERIFY_REPORT_INTEGRITY'));
    assert.equal((await db.pool.query('SELECT report_legacy_missing FROM ac_verify_runs WHERE id=$1', [retried.runId])).rows[0]?.report_legacy_missing, false);
    await rename(hidden, join(data, 'verificacoes'));
    await reconcileModuleReports(db, principal, nextAuthority, data, projectId);
    assert.ok((await listModuleReports(data, projectId)).some(item => item.id === retried.runId));
    await db.releaseLease(nextAuthority);
  } finally {
    await db.pool.end();
    await database.close();
    await rm(root, {recursive: true, force: true});
  }
});
