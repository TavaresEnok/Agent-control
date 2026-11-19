import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Ledger} from '../src/ledger.ts';
import {discardModuleReport, listModuleReports, reconcileModuleReports, runVerificationModule, writeModuleReport} from '../src/verification-modules.ts';
import {withModuleRecoveryFixture} from './fixtures/module-recovery.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('publicação interrompida e atualizações concorrentes reconciliam com o banco', async () => {
  assert.ok(process.env.AC_TEST_DATABASE_URL);
  const database = await isolatedDatabase(process.env.AC_TEST_DATABASE_URL, 'vmodr3persist');
  const ledger = new Ledger(database.url);
  const root = await mkdtemp(join(tmpdir(), 'vmod-r3-'));
  try {
    await ledger.migrate();
    await ledger.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    const principal = 'owner-persistence';
    const projectId = randomUUID();
    await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [projectId, 'Projeto']);
    await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [projectId, principal]);
    await ledger.createContext(principal, projectId, randomUUID());
    const {contextId} = await ledger.ensureExamContext(principal, projectId, 'qa');
    const authority = await ledger.acquire(principal, contextId, randomUUID(), 'test-persistence', 60);
    const runId = randomUUID(), intent = randomUUID(), commit = 'a'.repeat(40);
    const achado = {id:'ACH-001', title:'Falha', severity:'alta' as const, status:'confirmado' as const, verifier:null,
      reference:'regra', where:{file:'src/a.ts',line:1}, scenario:'cenário', proof:'prova', suggestion:'corrigir', acceptance:'corrigido', sources:['tool','regra'], secretPreview:null};
    const coverage = [{tool:'tool', version:'1', status:'ok' as const, detail:'exame concluído', files:['src/a.ts']}];
    await mkdir(join(root,'data'), {mode:0o700});
    const report = await writeModuleReport({dataDirectory:join(root,'data'), projectId, module:'qa', runId, createdAt:new Date(), commit,
      directoryName:`20261119-120000-${runId.slice(0, 8)}-qa`,
      deferPublication:true, achados:[achado], toolCoverage:coverage, fileCoverage:[], raw:{coverage,findings:[]}});
    await ledger.pool.query(`INSERT INTO ac_intents (id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,0)`, [intent,contextId,principal,'0'.repeat(64),'{}',randomUUID(),randomUUID(),authority.epoch]);
    await ledger.pool.query(`INSERT INTO ac_verify_runs(id,project_id,context_id,intent_id,principal_id,commit_id,status,report_dir,module)
      VALUES($1,$2,$3,$4,$5,$6,'done',$7,'qa')`, [runId,projectId,contextId,intent,principal,commit,report.directory]);
    await ledger.pool.query(`INSERT INTO ac_verify_findings(run_id,achado_id,status,severity,file,line,payload)
      VALUES($1,'ACH-001','confirmado','alta','src/a.ts',1,$2::jsonb)`, [runId,JSON.stringify(achado)]);
    await ledger.pool.query(`INSERT INTO ac_verify_tool_coverage(run_id,seq,tool,version,status,detail)
      VALUES($1,1,'tool','1','ok','exame concluído')`, [runId]);
    await ledger.pool.query(`INSERT INTO ac_verify_coverage(run_id,file,examiner_provider,examiner_model,checklist)
      VALUES($1,'src/a.ts','ferramenta','tool@1','[]'), ($1,'src/sem-evidencia.ts','ferramenta','tool@1','[]')`, [runId]);
    assert.equal((await listModuleReports(join(root,'data'), projectId)).length, 0);
    await Promise.all([reconcileModuleReports(ledger,principal,authority,join(root,'data'),projectId), reconcileModuleReports(ledger,principal,authority,join(root,'data'),projectId)]);
    assert.equal((await listModuleReports(join(root,'data'), projectId))[0]?.counts.alta, 1);
    assert.deepEqual((await ledger.pool.query('SELECT file, provenance FROM ac_verify_coverage WHERE run_id=$1 ORDER BY file', [runId])).rows,
      [{file:'src/a.ts', provenance:'collector'}, {file:'src/sem-evidencia.ts', provenance:'unknown'}]);
    // Simulates process death immediately after a committed status change.
    await ledger.pool.query("UPDATE ac_verify_findings SET status='fechado' WHERE run_id=$1", [runId]);
    assert.equal((await listModuleReports(join(root,'data'), projectId))[0]?.counts.alta, 1);
    await Promise.all([reconcileModuleReports(ledger,principal,authority,join(root,'data'),projectId), reconcileModuleReports(ledger,principal,authority,join(root,'data'),projectId)]);
    assert.equal((await listModuleReports(join(root,'data'), projectId))[0]?.counts.alta, 0);
    assert.equal(JSON.parse(await readFile(join(report.directory,'achados.json'),'utf8')).achados[0].status, 'fechado');
    assert.match(await readFile(join(report.directory,'achados','ACH-001.md'),'utf8'), /Situação: fechado/);
    assert.match(await readFile(join(report.directory,'README.md'),'utf8'), /\| alta \| 0 \|/);
    await reconcileModuleReports(ledger,principal,authority,join(root,'data'),projectId);
    assert.equal((await listModuleReports(join(root,'data'), projectId))[0]?.counts.alta, 0);
    // Simula arquivo escrito por transação revertida; o banco permanece fechado.
    const file = join(report.directory, 'achados.json');
    const stale = JSON.parse(await readFile(file, 'utf8'));
    stale.achados[0].status = 'confirmado';
    stale.achados[0].severity = 'baixa';
    stale.achados[0].proof = 'não corresponde ao registro confirmado';
    await writeFile(file, JSON.stringify(stale));
    await reconcileModuleReports(ledger,principal,authority,join(root,'data'),projectId);
    assert.equal(JSON.parse(await readFile(file,'utf8')).achados[0].status, 'fechado');
    assert.equal((await listModuleReports(join(root,'data'), projectId))[0]?.counts.alta, 0);
    const corrected = JSON.parse(await readFile(file, 'utf8')).achados[0];
    assert.equal(corrected.severity, 'alta');
    assert.equal(corrected.proof, achado.proof);
    await rename(file, file + '.original');
    await writeFile(file, '{"achados":');
    await reconcileModuleReports(ledger,principal,authority,join(root,'data'),projectId);
    assert.deepEqual(await listModuleReports(join(root,'data'), projectId), []);
    await rm(file);
    await mkdir(file);
    await reconcileModuleReports(ledger,principal,authority,join(root,'data'),projectId);
    assert.deepEqual(await listModuleReports(join(root,'data'), projectId), []);
    await rm(file, {recursive:true});
    await rename(file + '.original', file);
    const coverageFile = join(report.directory, 'cobertura.md');
    await rename(coverageFile, coverageFile + '.saved');
    await reconcileModuleReports(ledger,principal,authority,join(root,'data'),projectId);
    assert.equal((await ledger.pool.query('SELECT report_legacy_missing FROM ac_verify_runs WHERE id=$1',[runId])).rows[0].report_legacy_missing, true);
    assert.deepEqual(await listModuleReports(join(root,'data'), projectId), []);
    await rename(coverageFile + '.saved', coverageFile);
    // The pre-tombstone CLI used to remove a directory and leave its path in
    // the database. Missing historical files have an indeterminate cause.
    const hidden = join(root, 'historical');
    await rename(report.directory, hidden);
    await reconcileModuleReports(ledger,principal,authority,join(root,'data'),projectId);
    assert.deepEqual((await ledger.pool.query('SELECT report_dir, report_legacy_missing FROM ac_verify_runs WHERE id=$1', [runId])).rows[0],
      {report_dir: report.directory, report_legacy_missing: true});
    assert.deepEqual(await listModuleReports(join(root,'data'), projectId), []);
    await rename(hidden, report.directory);
    await reconcileModuleReports(ledger,principal,authority,join(root,'data'),projectId);
    assert.equal((await ledger.pool.query('SELECT report_legacy_missing FROM ac_verify_runs WHERE id=$1', [runId])).rows[0]?.report_legacy_missing, false);
  } finally { await ledger.pool.end(); await database.close(); await rm(root,{recursive:true,force:true}); }
});

test('descarte de diretório legado incompleto com prefixo ambíguo preserva os dados', async () => {
  await withModuleRecoveryFixture(process.env.AC_TEST_DATABASE_URL!, async base => {
    const {ledger, projectId, principal, dataDirectory} = base;
    const firstId = randomUUID();
    const secondId = firstId.slice(0, 8) + randomUUID().slice(8);
    const collectorOutput = {coverage: [{tool:'fixture', version:'1', status:'ok', detail:'synthetic'}], findings:[]};
    const first = await runVerificationModule({...base, runId:firstId, collectorOutput});
    const second = await runVerificationModule({...base, runId:secondId, collectorOutput});
    const old = first.directory.replace(firstId.replaceAll('-', ''), firstId.slice(0, 8));
    assert.notEqual(old, first.directory);
    await rename(first.directory, old);
    await rm(join(old, 'run.json'));
    await rm(join(old, '.run-pending.json'), {force:true});
    await ledger.pool.query('UPDATE ac_verify_runs SET report_prepared_dir=NULL, report_dir=$2 WHERE id=$1', [firstId, old]);
    await ledger.pool.query("UPDATE ac_verify_runs SET report_prepared_dir=NULL, report_dir='pending' WHERE id=$1", [secondId]);
    await assert.rejects(discardModuleReport(ledger, principal, dataDirectory, projectId, 'qa', firstId), /VERIFY_REPORT_INTEGRITY/);
    assert.match(await readFile(join(old, 'mapa.md'), 'utf8'), /Mapa/);
    assert.match(await readFile(join(second.directory, 'run.json'), 'utf8'), new RegExp(secondId));
    await ledger.pool.query('UPDATE ac_verify_runs SET report_dir=$2 WHERE id=$1', [secondId, second.directory]);
    await discardModuleReport(ledger, principal, dataDirectory, projectId, 'qa', firstId);
    await assert.rejects(readFile(join(old, 'mapa.md')), {code:'ENOENT'});
    assert.match(await readFile(join(second.directory, 'run.json'), 'utf8'), new RegExp(secondId));
  });
});
