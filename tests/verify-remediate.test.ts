import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest, Refusal} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {acceptSecurityVerification} from '../src/verify-intent.ts';
import {requestCorrection, recheckFindings} from '../src/verify-remediate.ts';
import {REMEDIATION_ACCEPTANCE, type VerifyWorker} from '../src/verify-types.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const secret = 'sk-somente-no-payload-interno';
const file = 'src/nao-escrever-verify-remediate.ts';

function refusal(code: string) {
  return (error: unknown) => error instanceof Refusal && error.code === code;
}

function worker(status: 'descartado' | 'confirmado', seen: {role: string; task: string; writePaths: readonly string[]}[]): VerifyWorker {
  return {async run(call) {
    seen.push({role: call.role, task: call.task, writePaths: call.writePaths});
    return JSON.stringify({kind: 'confirmacao', status, reason: 'o ponto foi relido', proof: 'saida da bancada'});
  }};
}

test('correction asks the owner for the write paths and recheck closes or reopens', async () => {
  const url = process.env.AC_TEST_DATABASE_URL;
  assert.ok(url);
  const database = await isolatedDatabase(url, 'remediate');
  const db = new Ledger(database.url);
  let data = '';
  try {
    await db.migrate();
    const principal = 'verify-remediate-owner';
    const project = randomUUID();
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Verificação']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    const context = await db.createContext(principal, project, randomUUID());
    const authority = await db.acquire(principal, context, randomUUID(), 'verify-remediate', 60);
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const intent = await acceptSecurityVerification(db, principal, authority, {projectId: project, commit, policyRevision: 1});
    const runId = randomUUID();
    await db.pool.query(
      `INSERT INTO ac_verify_runs(id,project_id,context_id,intent_id,principal_id,commit_id,status,report_dir)
       VALUES($1,$2,$3,$4,$5,$6,'done',$7)`,
      [runId, project, context, intent.id, principal, commit, '20261116-120000-seguranca'],
    );
    await db.pool.query(
      `INSERT INTO ac_verify_findings(run_id,achado_id,status,severity,file,line,payload) VALUES
       ($1,'ACH-001','confirmado','alta',$2,12,$3::jsonb),
       ($1,'ACH-002','reaberto','media',$2,40,$4::jsonb),
       ($1,'ACH-003','descartado','baixa','src/outro.ts',3,$5::jsonb),
       ($1,'ACH-004','confirmado','alta','../fora.ts',1,$5::jsonb)`,
      [
        runId,
        file,
        JSON.stringify({title: 'Consulta sem autorização', snippet: secret, scenario: secret}),
        JSON.stringify({title: 'Cabeçalho ausente', note: secret}),
        JSON.stringify({title: 'Ruído', snippet: secret}),
      ],
    );
    data = await mkdtemp(join(tmpdir(), 'ac-verify-fix-'));
    const input = {runId, dataDirectory: data, projectId: project};
    await db.pool.query("UPDATE ac_installation_activation SET mode='locked' WHERE id=1");
    await assert.rejects(() => requestCorrection(db, principal, authority, {...input, achadoIds: ['ACH-001']}), refusal('PERSONAL_ACTIVATION_REQUIRED'));
    await assert.rejects(() => recheckFindings(db, principal, authority, {...input, achadoIds: ['ACH-001'], worker: worker('descartado', [])}), refusal('PERSONAL_ACTIVATION_REQUIRED'));
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await assert.rejects(() => requestCorrection(db, principal, authority, {...input, achadoIds: []}), refusal('VERIFY_NOTHING_TO_FIX'));
    await assert.rejects(() => requestCorrection(db, principal, authority, {...input, achadoIds: ['ACH-999']}), refusal('VERIFY_FINDING_MISSING'));
    await assert.rejects(() => requestCorrection(db, principal, authority, {...input, achadoIds: ['ACH-003']}), refusal('VERIFY_FINDING_MISSING'));
    await assert.rejects(() => requestCorrection(db, principal, authority, {...input, achadoIds: ['ACH-004']}), refusal('VERIFY_PATH_FORBIDDEN'));
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM ac_personal_messages')).rows[0].n, 0);
    await assert.rejects(() => stat(join(process.cwd(), file)));
    const corrected = await requestCorrection(db, principal, authority, {...input, achadoIds: ['ACH-002', 'ACH-001', 'ACH-002']});
    const messageLocalId = `verify-fix-${runId}-${digest(['ACH-001', 'ACH-002']).slice(0, 12)}`;
    const regression = [
      'O teste tests/seguranca/ach-001.test.ts tem de falhar antes da correção e passar depois.',
      'O teste tests/seguranca/ach-002.test.ts tem de falhar antes da correção e passar depois.',
    ].join('\n');
    assert.equal(corrected.messageLocalId, messageLocalId);
    assert.deepEqual(corrected.writePaths, [file]);
    assert.deepEqual(await readdir(data), []);
    await assert.rejects(() => stat(join(process.cwd(), file)));
    const message = (await db.pool.query(
      'SELECT role, text, accepted FROM ac_personal_messages WHERE context_id=$1 AND local_id=$2',
      [context, messageLocalId],
    )).rows[0];
    assert.equal(message.role, 'owner');
    assert.equal(message.accepted, false);
    assert.equal(message.text.includes(file), true);
    assert.equal(message.text.includes(regression), true);
    assert.equal(message.text.includes(REMEDIATION_ACCEPTANCE), true);
    assert.equal(message.text.includes('Consulta sem autorização'), true);
    assert.equal(message.text.includes('Cabeçalho ausente'), true);
    assert.equal(message.text.includes(secret), false);
    const row = (await db.pool.query(
      'SELECT finding_ids, message_local_id, write_paths, regression_test, acceptance FROM ac_verify_remediations WHERE run_id=$1',
      [runId],
    )).rows[0];
    assert.deepEqual(row.finding_ids, ['ACH-001', 'ACH-002']);
    assert.equal(row.message_local_id, messageLocalId);
    assert.deepEqual(row.write_paths, [file]);
    assert.equal(row.regression_test, regression);
    assert.equal(row.acceptance, REMEDIATION_ACCEPTANCE);
    assert.equal(String(row.regression_test).includes(secret), false);
    assert.equal((await db.pool.query("SELECT payload->>'snippet' AS snippet FROM ac_verify_findings WHERE run_id=$1 AND achado_id='ACH-001'", [runId])).rows[0].snippet, secret);
    const report = join(data, 'verificacoes', project, '20261116-120000-seguranca');
    const other = join(data, 'verificacoes', project, '20261116-120001-seguranca');
    await mkdir(join(report, 'achados'), {recursive: true, mode: 0o700});
    await mkdir(join(other, 'achados'), {recursive: true, mode: 0o700});
    await writeFile(join(report, 'run.json'), JSON.stringify({id: runId}) + '\n', {mode: 0o600});
    await writeFile(join(other, 'run.json'), JSON.stringify({id: randomUUID()}) + '\n', {mode: 0o600});
    const original = '# ACH-001: Consulta sem autorização\n- Gravidade: alta\n- Situação: confirmado (verificador: bancada, bancada)\n- Onde: src/nao-escrever-verify-remediate.ts:12\n';
    const decoy = '# ACH-001: outro\n- Situação: confirmado\n';
    const achado = join(report, 'achados', 'ACH-001.md');
    const decoyPath = join(other, 'achados', 'ACH-001.md');
    await writeFile(achado, original, {mode: 0o644});
    await writeFile(decoyPath, decoy, {mode: 0o644});
    const seen: {role: string; task: string; writePaths: readonly string[]}[] = [];
    const closed = await recheckFindings(db, principal, authority, {...input, achadoIds: ['ACH-001', 'ACH-002'], worker: worker('descartado', seen)});
    assert.deepEqual(closed.results, [{id: 'ACH-001', status: 'fechado'}, {id: 'ACH-002', status: 'fechado'}]);
    assert.equal(await readFile(achado, 'utf8'), original.replace('Situação: confirmado', 'Situação: fechado'));
    assert.equal((await stat(achado)).mode & 0o777, 0o600);
    assert.equal(await readFile(decoyPath, 'utf8'), decoy);
    assert.equal((await stat(decoyPath)).mode & 0o777, 0o644);
    await assert.rejects(() => stat(join(report, 'achados', 'ACH-002.md')));
    const reopened = await recheckFindings(db, principal, authority, {...input, achadoIds: ['ACH-001'], worker: worker('confirmado', seen)});
    assert.deepEqual(reopened.results, [{id: 'ACH-001', status: 'reaberto'}]);
    assert.equal(await readFile(achado, 'utf8'), original.replace('Situação: confirmado', 'Situação: reaberto'));
    assert.equal((await stat(achado)).mode & 0o777, 0o600);
    assert.equal((await db.pool.query("SELECT status FROM ac_verify_findings WHERE run_id=$1 AND achado_id='ACH-002'", [runId])).rows[0].status, 'fechado');
    assert.equal(seen.length, 3);
    for (const call of seen) {
      assert.equal(call.role, 'reviewer');
      assert.deepEqual(call.writePaths, []);
      assert.equal(call.task.includes(secret), false);
      assert.equal(call.task.includes(file), true);
      assert.equal(call.task.includes('{"kind":"confirmacao","status":"descartado"|"confirmado","reason":"...","proof":"..."}'), true);
    }
    assert.equal(seen[0]?.task.includes('Consulta sem autorização'), true);
    assert.equal(seen[0]?.task.includes('Linha: 12'), true);
    assert.equal(seen[1]?.task.includes('Cabeçalho ausente'), true);
    assert.equal(seen[1]?.task.includes('Linha: 40'), true);
    assert.equal(message.text.includes(secret), false);
  } finally {
    if (data) await rm(data, {recursive: true, force: true});
    await db.close();
    await database.close();
  }
});
