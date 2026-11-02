import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {Capacity} from '../src/capacity.ts';
import {Templates} from '../src/templates.ts';
import {provisionEngineering} from './fixtures/provision-engineering.ts';

test('human pause holds the next native node and resumes the same plan without repeating implementation',{timeout:30000},async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url?.endsWith('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();let runtime:CezarRuntime|undefined;
 try{
  const principal='boundary-'+randomUUID(),project=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Native pause fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await mkdir('.state/projects',{recursive:true});const repo=await mkdtemp(resolve('.state/projects/ac-pause-'));
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
  git('init','-q','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','Synthetic fixture');
  await writeFile(join(repo,'README.md'),'Pause fixture only\n');git('add','.');git('commit','-qm','base');git('branch','protected');
  await mkdir(join(repo,'.ai/cezar'),{recursive:true});
  await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[],worktreeRetention:0}));
  const {revision,options}=await provisionEngineering(db,principal,project,repo,1,false);
  const context=await db.createContext(principal,project,randomUUID());await new Capacity(db).assignPolicy(principal,context,revision);
  await new Templates(db).publish(principal,context,0,{workflow:'engineering-synthetic-v1',qualityRevision:options.qualityRevision!,targetRef:options.targetRef!});
  const authority=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
  runtime=new CezarRuntime(db,repo,project,options);await runtime.start();
  const original=runtime.recordReceipt.bind(runtime);let implementationReceipts=0;
  runtime.recordReceipt=async(...args)=>{await original(...args);implementationReceipts++;await db.pause(principal,context,true);};
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,
   action:'plan.start',payload:{workflow:'engineering-synthetic-v1',messageRef:'encrypted:pause-fixture'}},authority,'api');
  await runtime.dispatch(intent,authority);
  for(let i=0;i<100;i++){
   const run=runtime.store.getRun(intent.run_id);if(run?.status==='failed')throw Error(run.error);
   if(run?.status==='waiting'&&run.graphState?.cursor==='qa')break;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  const parked=runtime.store.getRun(intent.run_id);assert.equal(parked?.status,'waiting');assert.equal(parked?.graphState?.cursor,'qa');
  assert.equal(parked?.steps.find(step=>step.id==='implement')?.status,'done');
  assert.equal((await db.pool.query('SELECT count(*) n FROM ac_stage_operations WHERE intent_id=$1',[intent.id])).rows[0].n,'0');
  await new Promise(resolve=>setTimeout(resolve,400));assert.equal(runtime.store.getRun(intent.run_id)?.status,'waiting');
  const account=(await db.pool.query('SELECT a.id FROM ac_accounts a JOIN ac_account_access x ON x.account_id=a.id WHERE x.project_id=$1',[project])).rows[0].id;
  await new Capacity(db).observeQuota(principal,account,{status:'exhausted',source:'synthetic://pause-capacity-fixture',ttlSeconds:3600});
  await db.pause(principal,context,false);
  let waitingForCapacity=false;
  for(let i=0;i<80;i++){
   const row=(await db.pool.query("SELECT w.reason FROM ac_capacity_waits w JOIN ac_stage_operations s ON s.attempt_id=w.attempt_id WHERE s.intent_id=$1 AND s.node_id='qa'",[intent.id])).rows[0];
   if(row?.reason==='NO_ELIGIBLE_CAPACITY'){waitingForCapacity=true;break;}
   if(runtime.store.getRun(intent.run_id)?.status==='failed')throw Error('CAPACITY_WAIT_BECAME_FAILURE');
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert(waitingForCapacity,'QA should persist its wait when quota is exhausted');
  assert.equal((await db.pool.query("SELECT count(*) n FROM ac_stage_operations WHERE intent_id=$1 AND node_id='qa'",[intent.id])).rows[0].n,'1');
  assert.equal((await db.pool.query("SELECT count(*) n FROM ac_capacity_grants WHERE intent_id=$1 AND role='qa'",[intent.id])).rows[0].n,'0');
  await new Capacity(db).observeQuota(principal,account,{status:'available',source:'synthetic://pause-capacity-fixture',ttlSeconds:3600});
  let complete=false;
  for(let i=0;i<150;i++){
   const run=runtime.store.getRun(intent.run_id);if(run?.status==='failed')throw Error(run.error);
   if(run&&['done','review'].includes(run.status)){complete=true;break;}
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert(complete,'same native graph failed to resume');assert.equal(implementationReceipts,1);assert.equal(runtime.store.listRuns().length,1);
  const receipt=(await db.pool.query('SELECT receipt FROM ac_operations WHERE id=$1',[intent.operation_id])).rows[0].receipt;
  assert.equal(git('rev-parse','protected'),receipt.commit);
 }finally{await runtime?.close();await db.close();}
});
