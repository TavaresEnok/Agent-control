import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {runPersonalModuleCli} from '../src/personal-module-cli.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const base=process.env.AC_TEST_DATABASE_URL;
test('descarte retoma publicação parcial e não aceita caminhos fora do projeto', {skip:base?false:'AC_TEST_DATABASE_URL is unset'}, async()=>{
 const fixture=await isolatedDatabase(base!,'clir3'), db=new Ledger(fixture.url);
 const root=await mkdtemp(join(tmpdir(),'ac-cli-r3-'));
 try {
  await db.migrate();
  const data=join(root,'data'),repo=join(root,'repo'),project=randomUUID(),owner='synthetic-owner';
  await mkdir(data,{recursive:true}); await mkdir(repo);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Projeto']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,owner]);
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  await db.createContext(owner,project,randomUUID());
  const {contextId}=await db.ensureExamContext(owner,project,'qa');
  const intent=randomUUID(),run=randomUUID();
  await db.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision)
   VALUES($1,$2,$3,'synthetic','{}',$4,$5,1,0)`,[intent,contextId,owner,randomUUID(),randomUUID()]);
  const dir=join(data,'verificacoes',project,`20261119-120000-${run.slice(0,8)}-qa`);
  await mkdir(dir,{recursive:true}); await writeFile(join(dir,'.run-pending.json'),'private');
  await db.pool.query(`INSERT INTO ac_verify_runs(id,project_id,context_id,intent_id,principal_id,commit_id,status,report_dir,module)
   VALUES($1,$2,$3,$4,$5,$6,'done',$7,'qa')`,[run,project,contextId,intent,owner,'a'.repeat(40),dir]);
  const file=join(data,'installation.json');
  await writeFile(file,JSON.stringify({schemaVersion:1,mode:'administration-only',activation:'personal',databaseUrl:fixture.url,dataDirectory:data,
   project:{id:project,label:'Projeto',repo,owner},projects:[],http:{listen:'127.0.0.1',port:8765,publicOrigin:'http://127.0.0.1:8765'},
   happier:{upstreamOrigin:'http://127.0.0.1:8766',webOrigin:'http://127.0.0.1:8766',publicServerOrigin:'http://127.0.0.1:8765'}}),{mode:0o600});
  const discard=()=>runPersonalModuleCli('qa',[file,project,'--descartar',run]);
  // Simulates termination after the tombstone commit, before filesystem cleanup.
  await db.pool.query('UPDATE ac_verify_runs SET report_dir=$2 WHERE id=$1',[run,'discarded:'+dir]);
  await db.pool.query('DELETE FROM ac_memberships WHERE project_id=$1',[project]);
  await assert.rejects(discard,(e:unknown)=>e instanceof Refusal&&e.code==='PROJECT_FORBIDDEN');
  assert.equal(await readFile(join(dir,'.run-pending.json'),'utf8'),'private');
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,owner]);
  await discard(); await assert.rejects(()=>stat(dir),{code:'ENOENT'}); await discard();
  assert.equal((await db.pool.query('SELECT report_dir FROM ac_verify_runs WHERE id=$1',[run])).rows[0].report_dir,'discarded:'+dir);
  const outside=join(root,'outside'); await mkdir(outside); await writeFile(join(outside,'keep'),'safe');
  await db.pool.query('UPDATE ac_verify_runs SET report_dir=$2 WHERE id=$1',[run,outside]);
  await assert.rejects(discard,(e:unknown)=>e instanceof Refusal&&e.code==='VERIFY_PATH_FORBIDDEN');
  assert.equal(await readFile(join(outside,'keep'),'utf8'),'safe');
 } finally { await db.close(); await fixture.close(); await rm(root,{recursive:true,force:true}); }
});
