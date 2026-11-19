import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Ledger} from '../src/ledger.ts';
import {listModuleReports, reconcileModuleReports, writeModuleReport} from '../src/verification-modules.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('publicação interrompida e atualizações concorrentes reconciliam com o banco', async () => {
  assert.ok(process.env.AC_TEST_DATABASE_URL);
  const database = await isolatedDatabase(process.env.AC_TEST_DATABASE_URL, 'vmodr3persist');
  const ledger = new Ledger(database.url);
  const root = await mkdtemp(join(tmpdir(), 'vmod-r3-'));
  try {
    await ledger.migrate();
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
      deferPublication:true, achados:[achado], toolCoverage:coverage, fileCoverage:[], raw:{coverage,findings:[]}});
    await ledger.pool.query(`INSERT INTO ac_intents (id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,0)`, [intent,contextId,principal,'0'.repeat(64),'{}',randomUUID(),randomUUID(),authority.epoch]);
    await ledger.pool.query(`INSERT INTO ac_verify_runs(id,project_id,context_id,intent_id,principal_id,commit_id,status,report_dir,module)
      VALUES($1,$2,$3,$4,$5,$6,'done',$7,'qa')`, [runId,projectId,contextId,intent,principal,commit,report.directory]);
    await ledger.pool.query(`INSERT INTO ac_verify_findings(run_id,achado_id,status,severity,file,line,payload)
      VALUES($1,'ACH-001','confirmado','alta','src/a.ts',1,$2::jsonb)`, [runId,JSON.stringify(achado)]);
    assert.equal((await listModuleReports(join(root,'data'), projectId)).length, 0);
    await Promise.all([reconcileModuleReports(ledger,principal,authority,join(root,'data'),projectId), reconcileModuleReports(ledger,principal,authority,join(root,'data'),projectId)]);
    assert.equal((await listModuleReports(join(root,'data'), projectId))[0]?.counts.alta, 1);
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
    await writeFile(file, JSON.stringify(stale));
    await reconcileModuleReports(ledger,principal,authority,join(root,'data'),projectId);
    assert.equal(JSON.parse(await readFile(file,'utf8')).achados[0].status, 'fechado');
    assert.equal((await listModuleReports(join(root,'data'), projectId))[0]?.counts.alta, 0);
  } finally { await ledger.pool.end(); await database.close(); await rm(root,{recursive:true,force:true}); }
});
