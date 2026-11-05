import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {Templates} from '../src/templates.ts';
import {ManagerPlans} from '../src/planning.ts';
import {readManagedRecipe} from '../src/managed-plan.ts';
import {NativeImplementation} from '../src/native-implementation.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {NativeExecutionSupervisor} from '../src/native-execution-supervisor.ts';
import {digest,Refusal} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {provisionEngineering} from './fixtures/provision-engineering.ts';

test('unstarted managed native task adopts the successor only with intact frozen input and no launch',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(url,'nativeunstarted'),db=new Ledger(fixture.url),area=await mkdtemp(join(tmpdir(),'ac-unstarted-'));
 try{
  await db.migrate();const repo=join(area,'repo');execFileSync('git',['init','-q','-b','main',repo]);
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
  git('config','user.name','fixture');git('config','user.email','fixture@invalid');await writeFile(join(repo,'README'),'fixture');git('add','.');git('commit','-qm','base');git('branch','protected');const base=git('rev-parse','HEAD');
  const project=randomUUID(),principal='unstarted-'+randomUUID();await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'unstarted']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
  const {revision,options}=await provisionEngineering(db,principal,project,repo);const context=await db.createContext(principal,project,randomUUID());await new Capacity(db).assignPolicy(principal,context,revision);
  await new Templates(db).publish(principal,context,0,{workflow:'engineering-native-v1',qualityRevision:1,targetRef:'refs/heads/protected',writePaths:['src'],execution:'plan'});
  const authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  const task={id:'one',objectiveRef:'message:one',acceptanceRefs:['acceptance:one'],inputRefs:[],outputRefs:['output:one'],dependsOn:[],writePaths:['src/one'],qualityRevision:1,targetRef:'refs/heads/protected',maxCorrections:0};
  const plan={schemaVersion:1 as const,contextId:context,objectiveRef:'message:objective',sourceMessageRef:'message:request',constraintRefs:[],tasks:[task]};const proposal=await new ManagerPlans(db).publish(principal,authority,0,plan);
  const parent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'managed-synthetic-v1',messageRef:'encrypted:fixture',proposalRevision:proposal.revision,proposalDigest:proposal.digest,native:true}},authority,'api');
  const recipe=await readManagedRecipe(db,parent.id),unit=recipe.units.find(u=>u.kind==='task')!;const intent=(await db.pool.query('SELECT * FROM ac_intents WHERE id=$1',[unit.intentId])).rows[0];
  const input={parentIntentId:parent.id,unitId:unit.id,kind:unit.kind,base,writePaths:unit.writePaths,acceptanceRefs:unit.acceptanceRefs,sources:unit.sources};await db.pool.query('INSERT INTO ac_managed_delivery_inputs VALUES($1,$2,$3,$4)',[intent.id,base,input,digest(input)]);
  const account=(await db.pool.query('SELECT account_id FROM ac_account_access WHERE project_id=$1',[project])).rows[0].account_id;
  const spool=join(area,'spool'),accounts=join(area,'accounts');await mkdir(spool);await mkdir(accounts);const keys=generateKeyPairSync('ed25519');
  const supervisor=new NativeExecutionSupervisor(db,{id:'fixture-native',workerImage:'sha256:'+'a'.repeat(64),toolsImage:'sha256:'+'a'.repeat(64),hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:'b'.repeat(64),accountSubjects:[{accountId:account,subjectDigest:'c'.repeat(64)}],workerEnv:[],toolsEnv:[]});
  const native=new NativeImplementation(db,repo,options.quality,[supervisor]);await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);const next=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  await assert.rejects(native.prepareRecovery(intent,authority),/STALE_MANAGER/);
  const [cursor,ids]=Object.entries(recipe.launches).find(([,members])=>members.includes(unit.id))!;
  const session=randomUUID(),run={id:parent.run_id,workflowDef:recipe.workflow,graphState:{cursor,outputs:{[cursor]:{runId:unit.runId}}},steps:[]};
  assert.equal(ids.length,1);
  const child={id:unit.runId,workflowDef:{name:'(planned)',source:'built-in',steps:[{id:'task',name:unit.id,prompt:'{{task}}'}]},dispatch:{parentRunId:run.id,rootRunId:run.id},status:'waiting',error:'Managed execution awaiting authoritative reconciliation',graphState:{cursor:'task'},steps:[{id:'task',sessionId:session}]};
  let resumes=0;const boundary={ledger:db,projectId:project,store:{getRun:(id:string)=>id===run.id?run:id===child.id?child:undefined},nativeImplementation:native,engineering:{},managedPlans:new Map(),authorities:new Map(),resumeManagedRecord:async()=>{resumes++;return true;}};
  const recover=(CezarRuntime.prototype as unknown as {recoverManagedGraph:(this:unknown,i:typeof parent,a:typeof next)=>Promise<void>}).recoverManagedGraph;
  await db.pool.query('UPDATE ac_operations SET native_session_id=$2 WHERE id=$1',[intent.operation_id,randomUUID()]);
  await assert.rejects(recover.call(boundary,parent,next),/MANAGED_RECOVERY_SESSION_MISMATCH/);assert.equal(resumes,0);
  await db.pool.query('UPDATE ac_operations SET native_session_id=NULL WHERE id=$1',[intent.operation_id]);
  await recover.call(boundary,parent,next);assert.equal(resumes,1,'unstarted child can resume under successor');
  const op=(await db.pool.query('SELECT * FROM ac_operations WHERE id=$1',[intent.operation_id])).rows[0];assert.equal(Number(op.manager_epoch),next.epoch);assert.equal(op.native_session_id,null);assert.equal(op.grant_id,null);
  await db.pool.query('INSERT INTO ac_execution_launches(operation_id,context_id,manager_epoch,snapshot,digest) VALUES($1,$2,$3,$4,$5)',[intent.operation_id,context,next.epoch,{},digest({})]);
  assert.equal(await native.prepareRecovery(intent,next),false,'recorded launch must never be adopted as unstarted');
  await recover.call(boundary,parent,next);assert.equal(resumes,1,'launch evidence prevents resumption');
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_native_execution_jobs')).rows[0].n,0);
 }finally{await db.close();await fixture.close();await rm(area,{recursive:true,force:true});}
});

test('retirement retries a lost network removal acknowledgement once',async()=>{
 let calls=0;const supervisor={retireManagedWriter:async()=>{if(++calls===1)throw new Refusal('DOCKER_NETWORK_UNCERTAIN');return {state:'neutralized'};}};
 const retire=(NativeImplementation.prototype as unknown as {retire:(this:unknown,s:unknown,p:string,a:unknown,id:string)=>Promise<unknown>}).retire;
 assert.deepEqual(await retire.call({},supervisor,'fixture',{},randomUUID()),{state:'neutralized'});assert.equal(calls,2);
 let rejected=0;const other={retireManagedWriter:async()=>{rejected++;throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');}};
 await assert.rejects(retire.call({},other,'fixture',{},randomUUID()),/NATIVE_RETIREMENT_UNCONFIRMED/);assert.equal(rejected,1);
});
