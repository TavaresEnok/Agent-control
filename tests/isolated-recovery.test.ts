import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {SandboxClient} from '../src/sandbox-client.ts';
import {IsolatedImplementation} from '../src/isolated-implementation.ts';
import {digest,type Command} from '../src/contracts.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';

test('successor reconciles completed isolated effect without launching a second worker',
 {timeout:20000,skip:!process.env.AC_SANDBOX_DATABASE_URL},async()=>{
 const url=process.env.AC_SANDBOX_DATABASE_URL!;
 if(!url.endsWith('/ac_sandbox_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();
 const project=randomUUID(),principal='isolated-recovery-'+randomUUID();
 await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Synthetic recovery']);
 await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
 const capacity=await provisionCapacity(db,principal,project),context=await db.createContext(principal,project,randomUUID());
 await new Capacity(db).assignPolicy(principal,context,capacity.revision);
 const first=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
 const command:Command={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,
  policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:recovery'}};
 const intent=await db.accept(principal,command,first,'api');
 const attempt=(await db.pool.query('SELECT execution_attempt_id FROM ac_operations WHERE id=$1',[intent.operation_id])).rows[0].execution_attempt_id;
 const grant=await capacity.service.reserve(principal,{attemptId:attempt,intentId:intent.id,contextId:context,role:'programmer'},first);
 await mkdir('.state/projects',{recursive:true});const cwd=await mkdtemp(resolve('.state/projects/ac-recovery-'));
 const git=(...args:string[])=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
 git('init','-q','-b','main');git('config','user.name','Synthetic fixture');git('config','user.email','fixture@example.invalid');
 await writeFile(join(cwd,'README.md'),'Recovery fixture\n');git('add','.');git('commit','-qm','base');
 const base=git('rev-parse','HEAD'),bundlePath=join(cwd,'source.bundle');
 git('bundle','create',bundlePath,'HEAD');const bundle=(await readFile(bundlePath)).toString('base64');
 const launch={profile:'synthetic-implementation-v1' as const,source:{base,bundle}};
 await db.pool.query('UPDATE ac_operations SET state=$2,grant_id=$3 WHERE id=$1',[intent.operation_id,'uncertain',grant.id]);
 await db.pool.query('INSERT INTO ac_execution_launches(operation_id,context_id,manager_epoch,snapshot,digest) VALUES($1,$2,$3,$4,$5)',
  [intent.operation_id,context,first.epoch,launch,digest(launch)]);
 const client=new SandboxClient(),recovery=new IsolatedImplementation(db,client);
 try{
  const started=await client.perform('start',intent.operation_id,grant.id,first,launch) as {state:string};
  assert.equal(started.state,'running');
  let physical:any;
  for(let i=0;i<60;i++){
   physical=await client.perform('reconcile',intent.operation_id,grant.id,first,launch);
   if(physical.exitCode!==undefined)break;
   await new Promise(r=>setTimeout(r,100));
  }
  assert.equal(physical.exitCode,0);
  assert.equal(git('rev-parse','HEAD'),base,'controller has not applied the physical result');
  await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);
  const successor=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
  await assert.rejects(recovery.reconcileExisting({...intent,run_id:randomUUID()},successor,cwd),/INTENT_SCOPE_MISMATCH/);
  assert.equal(await recovery.reconcileExisting(intent,successor,cwd),'completed');
  const op=(await db.pool.query('SELECT state,manager_epoch,receipt FROM ac_operations WHERE id=$1',[intent.operation_id])).rows[0];
  assert.equal(op.state,'completed');assert.equal(Number(op.manager_epoch),successor.epoch);
  assert.equal(git('rev-parse','HEAD'),op.receipt.commit);
  assert.equal(git('rev-parse','HEAD^'),base);
  assert.equal(await recovery.reconcileExisting(intent,successor,cwd),'completed','replay is read-only');
  assert.equal((await db.pool.query('SELECT count(*) n FROM ac_sandbox_jobs WHERE id=$1',[intent.operation_id])).rows[0].n,'1');
 }finally{recovery.close();await db.close();}
});
