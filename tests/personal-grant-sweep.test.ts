// The host disk is not what this file proves: a fixed reading keeps a server disk near 95% from refusing these flows.
import {useFixedDisk} from './fixtures/fixed-disk.ts';
useFixedDisk();
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import {chmod,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import pg from 'pg';
import {Capacity} from '../src/capacity.ts';
import {digest} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {NativeExecutionRequest,NativeExecutionSupervisor,openGrantLaunchLockSession,tryGrantLaunchLock,withGrantLaunchLock} from '../src/native-execution-supervisor.ts';
import {releaseDeadPersonalGrants} from '../src/personal-runtime.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const url=process.env.AC_TEST_DATABASE_URL;
const OLD=10; // minutes; the sweep below uses a 5 minute threshold

/** Docker is a script on PATH: it lists the names in a file the test edits, so a container can "appear" at an exact moment. */
async function fakeDocker(area:string){
 const names=join(area,'names'),bin=join(area,'bin');
 await mkdir(bin);await writeFile(names,'');
 await writeFile(join(bin,'docker'),`#!/bin/sh\n[ "$1" = ps ] && { cat "${names}"; exit 0; }\nexit 1\n`);await chmod(join(bin,'docker'),0o755);
 const previous=process.env.PATH;process.env.PATH=bin+':'+previous;
 return {
  add:(name:string)=>writeFile(names,name+'\n',{flag:'a'}),
  restore:()=>{process.env.PATH=previous;},
 };
}

async function fixture(db:Ledger,area:string){
 const principal='sweep-'+randomUUID(),project=randomUUID(),account=randomUUID(),profile=randomUUID();
 await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'sweep fixture']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
 const repo=join(area,'repo');await mkdir(repo,{mode:0o700});await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
 const subject='a'.repeat(64);
 await new Capacity(db).addAccount(principal,project,{id:account,provider:'codex',label:'sweep',resourceIdentity:'codex:'+subject,mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/fixture',maxConcurrent:8});
 await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'fixture-model','medium','programmer',false)",[profile,account]);
 const context=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
 await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),principal]);
 const grant=async(minutesOld:number,state='reserved')=>{
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
  const id=randomUUID();
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,'programmer',$8,1,1,$9,false,$10,clock_timestamp()-make_interval(mins=>$11))`,[id,randomUUID(),intent.id,context,authority.epoch,account,profile,project,digest({id}),state,minutesOld]);
  return {id,intent,jobId:intent.operation_id as string};
 };
 const job=async(g:{id:string;intent:any;jobId:string},minutesOld:number,state='uncertain',identity:{executor:string;fingerprint:string}={executor:'1'.repeat(64),fingerprint:'2'.repeat(64)})=>{
  const input=NativeExecutionRequest.parse({jobId:g.jobId,intentId:g.intent.id,grantId:g.id,sessionId:randomUUID(),base:'e'.repeat(40),role:'programmer',task:'synthetic metadata only',writePaths:['src/example.ts']});
  await db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,'programmer',$14,clock_timestamp()-make_interval(mins=>$15))`,
   [g.jobId,g.id,g.intent.id,context,authority.epoch,input.sessionId,account,profile,digest({fixture:true}),identity.executor,identity.fingerprint,digest(input),input.base,state,minutesOld]);
  return input;
 };
 const state=async(id:string)=>String((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[id])).rows[0].state);
 return {principal,project,account,profile,context,authority,subject,repo,grant,job,state};
}

test('dead grants are released only when no launch holds them and no container exists, whatever appears after the inventory',{skip:!url,timeout:120000},async()=>{
 const database=await isolatedDatabase(url!,'sweep'),db=new Ledger(database.url),area=await mkdtemp(join(tmpdir(),'ac-sweep-')),docker=await fakeDocker(area);
 try{
  await db.migrate();
  const f=await fixture(db,area);
  // Abandoned reservation: old, no launch, no container. A young one is kept.
  const abandoned=await f.grant(OLD),young=await f.grant(0);
  assert.equal(await releaseDeadPersonalGrants(db,5),1);
  assert.equal(await f.state(abandoned.id),'released');assert.equal(await f.state(young.id),'reserved');
  const receipt=(await db.pool.query('SELECT physical_receipt FROM ac_capacity_grants WHERE id=$1',[abandoned.id])).rows[0].physical_receipt;
  assert.equal(receipt.source,'personal-startup-sweep');assert.equal(receipt.containersAbsent,true);

  // Window between inventory and update: a valid launch creates its container right after the candidates were chosen.
  const racing=await f.grant(OLD);await f.job(racing,OLD,'uncertain');
  const original=db.pool.query.bind(db.pool) as any;let armed=true;
  (db.pool as any).query=async(sql:any,...rest:any[])=>{
   const result=await original(sql,...rest);
   if(armed&&typeof sql==='string'&&sql.includes('FROM ac_capacity_grants')&&sql.includes('ORDER BY created_at')){armed=false;await docker.add('ac-native-worker-'+racing.jobId);}
   return result;
  };
  try{assert.equal(await releaseDeadPersonalGrants(db,5),0);}finally{(db.pool as any).query=original;}
  assert.equal(await f.state(racing.id),'reserved','a container that appeared after the inventory keeps its reservation');

  // A listing failure releases nothing.
  const unlisted=await f.grant(OLD);
  assert.equal(await releaseDeadPersonalGrants(db,5,{containers:async()=>null}),0);assert.equal(await f.state(unlisted.id),'reserved');
 }finally{docker.restore();await db.close();await database.close();await rm(area,{recursive:true,force:true});}
});

test('a launch in preparation keeps its reservation at every interruption point and an abandoned one returns to the queue',{skip:!url,timeout:120000},async()=>{
 const database=await isolatedDatabase(url!,'sweeplock'),db=new Ledger(database.url),area=await mkdtemp(join(tmpdir(),'ac-sweep-lock-')),docker=await fakeDocker(area);
 try{
  await db.migrate();
  const f=await fixture(db,area);
  // Point 1: reserved, start checking (no job row yet). Its launch lock protects it; when the process dies, the lock goes with it.
  const first=await f.grant(OLD);
  await withGrantLaunchLock(db,first.id,async()=>{assert.equal(await releaseDeadPersonalGrants(db,5),0);});
  assert.equal(await f.state(first.id),'reserved');
  const crashed=await openGrantLaunchLockSession(db);assert(crashed);assert.equal(await tryGrantLaunchLock(crashed,first.id),true);
  assert.equal(await releaseDeadPersonalGrants(db,5),0,'a live session holds it');
  await crashed.end(); // the controller dies without unlocking
  let released=0;for(let i=0;i<50&&!released;i++){released=await releaseDeadPersonalGrants(db,5);if(!released)await new Promise(r=>setTimeout(r,50));}
  assert.equal(released,1);assert.equal(await f.state(first.id),'released');

  // Point 2: job row written, files being prepared. The launch lock holds it; without a lock a young job row still holds it; an old one does not.
  const second=await f.grant(OLD,'uncertain');await f.job(second,0);
  await withGrantLaunchLock(db,second.id,async()=>{assert.equal(await releaseDeadPersonalGrants(db,5),0);});
  assert.equal(await releaseDeadPersonalGrants(db,5),0,'a job row younger than the threshold may belong to a launch without the lock');
  await db.pool.query("UPDATE ac_native_execution_jobs SET created_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",[second.jobId]);
  assert.equal(await releaseDeadPersonalGrants(db,5),1);assert.equal(await f.state(second.id),'released');

  // Point 3: containers created, nothing else written yet: kept while the container exists, even with no lock.
  const third=await f.grant(OLD,'uncertain');await f.job(third,OLD);await docker.add('ac-native-tools-'+third.jobId);
  assert.equal(await releaseDeadPersonalGrants(db,5),0);assert.equal(await f.state(third.id),'uncertain');
  // The same grant is released once the container is gone.
  await writeFile(join(area,'names'),'');
  assert.equal(await releaseDeadPersonalGrants(db,5),1);assert.equal(await f.state(third.id),'released');

  // The lock is per grant: another reservation is not blocked by a live launch.
  const live=await f.grant(OLD),other=await f.grant(OLD);
  await withGrantLaunchLock(db,live.id,async()=>{assert.equal(await releaseDeadPersonalGrants(db,5),1);});
  assert.equal(await f.state(other.id),'released');assert.equal(await f.state(live.id),'reserved');
 }finally{docker.restore();await db.close();await database.close();await rm(area,{recursive:true,force:true});}
});

test('the supervisor start holds the launch lock, and its recovery defers to a live launch',{skip:!url,timeout:120000},async()=>{
 const database=await isolatedDatabase(url!,'sweepstart'),db=new Ledger(database.url),area=await mkdtemp(join(tmpdir(),'ac-sweep-start-')),docker=await fakeDocker(area);
 try{
  await db.migrate();
  const f=await fixture(db,area),spool=join(area,'spool'),accounts=join(area,'accounts');for(const path of [spool,accounts])await mkdir(path,{mode:0o700});
  const g=await f.grant(0);
  const keys=generateKeyPairSync('ed25519'),image='sha256:'+'c'.repeat(64);
  const config={disabledMeasurementProjects:[f.project],id:'codex-native-execution',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:accounts,repository:f.repo,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:'d'.repeat(64),socketPath:'/no-operational-docker.sock',accountSubjects:[{accountId:f.account,subjectDigest:f.subject}],workerEnv:[],toolsEnv:[]};
  const supervisor=new NativeExecutionSupervisor(db,config as any);
  const input=NativeExecutionRequest.parse({jobId:g.jobId,intentId:g.intent.id,grantId:g.id,sessionId:randomUUID(),base:'e'.repeat(40),role:'programmer',task:'synthetic metadata only',writePaths:['src/example.ts']});
  const probe=new pg.Client({connectionString:database.url});await probe.connect();
  try{
  const heldFromOutside=async()=>!await tryGrantLaunchLock(probe as any,g.id);
  // While start runs (here: while it validates the reservation), another session cannot take the lock.
  const originalTx=db.tx.bind(db);let observed:boolean|undefined;
  (db as any).tx=async(fn:any)=>{if(observed===undefined){observed=await heldFromOutside();}return originalTx(fn);};
  try{await assert.rejects(supervisor.start(f.principal,f.authority,input),/NATIVE_EXECUTION_NOT_ELIGIBLE/);}finally{(db as any).tx=originalTx;}
  assert.equal(observed,true,'start must hold the launch lock while it prepares');
  assert.equal(await tryGrantLaunchLock(probe as any,g.id),true,'and release it when it ends, even by refusal');
  await probe.query('SELECT pg_advisory_unlock_all()');

  // Recovery of the same job while a launch is live: preserved, Docker is not touched.
  const fingerprint=createHash('sha256').update(keys.publicKey.export({format:'der',type:'spki'})).digest('hex');
  const jobGrant=await f.grant(OLD,'uncertain');await f.job(jobGrant,0,'uncertain',{executor:supervisor.executorDigest,fingerprint});
  await withGrantLaunchLock(db,jobGrant.id,async()=>{
   const recovery=await supervisor.recover(f.principal,f.authority,jobGrant.jobId);
   assert.deepEqual({state:recovery.state,interval:recovery.interval,grant:recovery.grant},{state:'uncertain',interval:'before_terminal_evidence',grant:'preserved'});
  });
  assert.equal(await f.state(jobGrant.id),'uncertain');
  }finally{await probe.end();}
 }finally{docker.restore();await db.close();await database.close();await rm(area,{recursive:true,force:true});}
});
