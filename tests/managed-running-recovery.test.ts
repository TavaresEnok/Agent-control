import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {digest} from '../src/contracts.ts';
import {SandboxClient} from '../src/sandbox-client.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';

test('successor observes and stops the same live physical broker job',{timeout:90000,skip:process.env.AC_MANAGED_SLOW_TEST!=='1'},async()=>{
 const url=process.env.AC_SANDBOX_DATABASE_URL;
 if(!url||!/^\/ac_managed_test_[a-f0-9]+$/.test(new URL(url).pathname))throw Error('ISOLATED_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();const project=randomUUID(),principal='slow-recovery-'+randomUUID();
 const dir=await mkdtemp(resolve('.state','slow-recovery-'));const git=(...args:string[])=>execFileSync('git',['-C',dir,...args],{encoding:'utf8'}).trim();
 const client=new SandboxClient();
 try{
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'physical slow recovery fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const fixture=await provisionCapacity(db,principal,project),contextId=await db.createContext(principal,project,randomUUID());
  await fixture.service.assignPolicy(principal,contextId,fixture.revision);
  const old=await db.acquire(principal,contextId,randomUUID(),'synthetic-manager',60);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:slow-recovery'}},old,'api');
  const grant=await fixture.service.reserve(principal,{attemptId:randomUUID(),intentId:intent.id,contextId,role:'programmer'},old);
  git('init','-q');git('config','user.name','fixture');git('config','user.email','fixture@example.invalid');
  await writeFile(join(dir,'base.txt'),'base\n');git('add','base.txt');git('commit','-qm','base');const base=git('rev-parse','HEAD');
  const bundlePath=join(dir,'source.bundle');git('bundle','create',bundlePath,'HEAD');
  const execution={profile:'synthetic-implementation-v1' as const,source:{base,bundle:(await readFile(bundlePath)).toString('base64')}};
  await db.pool.query('UPDATE ac_operations SET grant_id=$2,state=$3 WHERE id=$1',[intent.operation_id,grant.id,'uncertain']);
  await db.pool.query('INSERT INTO ac_execution_launches(operation_id,context_id,manager_epoch,snapshot,digest) VALUES($1,$2,$3,$4,$5)',[intent.operation_id,contextId,old.epoch,execution,digest(execution)]);
  const started=await client.perform('start',intent.operation_id,grant.id,old,execution) as {state:string;containerId:string};
  assert.equal(started.state,'running');assert.match(started.containerId,/^[a-f0-9]{64}$/);
  // Reconcile inspects Docker; this is stronger than trusting only the start acknowledgement.
  const observed=await client.perform('reconcile',intent.operation_id,grant.id,old,execution) as {state:string};
  assert.equal(observed.state,'running','Docker must observe the old writer running');
  await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[contextId]);
  const successor=await db.acquire(principal,contextId,randomUUID(),'synthetic-manager',60);assert(successor.epoch>old.epoch);
  await assert.rejects(client.perform('start',intent.operation_id,grant.id,successor,execution),/SANDBOX_RECONCILIATION_REQUIRED/);
  const stopped=await client.perform('reconcile',intent.operation_id,grant.id,successor,execution) as {state?:string;reason?:string};
  assert.equal(stopped.state,'uncertain');assert.equal(stopped.reason,'OLD_WRITER_STOP_REQUESTED','the broker must inspect a live old-epoch writer');
  let terminal:any;
  for(let i=0;i<80;i++){
   terminal=await client.perform('reconcile',intent.operation_id,grant.id,successor,execution);
   if(typeof terminal?.exitCode==='number')break;
   const still=(await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[grant.id])).rows[0];
   assert.notEqual(still.state,'released','uncertain physical work must retain its grant');
   await new Promise(r=>setTimeout(r,250));
  }
  assert.equal(terminal.jobId,intent.operation_id);assert.equal(terminal.containerId,started.containerId);assert.notEqual(terminal.exitCode,0);
  assert(Number.isFinite(Date.parse(terminal.finishedAt)));assert.equal(terminal.implementation,null);
  const saved=(await db.pool.query(`SELECT j.id,j.grant_id,j.container_id,j.state,j.receipt,g.state grant_state,g.physical_receipt
   FROM ac_sandbox_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id WHERE j.id=$1`,[intent.operation_id])).rows[0];
  assert.equal(saved.id,intent.operation_id);assert.equal(saved.grant_id,grant.id);assert.equal(saved.container_id,started.containerId);
  assert.equal(saved.state,'failed');assert.equal(saved.grant_state,'released');assert.deepEqual(saved.receipt,terminal);assert.deepEqual(saved.physical_receipt,terminal);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_sandbox_jobs WHERE grant_id=$1',[grant.id])).rows[0].n,1);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_capacity_grants WHERE intent_id=$1',[intent.id])).rows[0].n,1);
  await client.perform('cleanup',intent.operation_id,grant.id,successor,execution);
 }finally{await db.close();await rm(dir,{recursive:true,force:true});}
});
