import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync,spawn,type ChildProcess} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {Capacity} from '../src/capacity.ts';
import {IsolatedImplementation} from '../src/isolated-implementation.ts';
import {ManagerPlans,type ManagerPlan} from '../src/planning.ts';
import {provisionEngineering} from './fixtures/provision-engineering.ts';
import {digest} from '../src/contracts.ts';

for(const stop of ['physical','cas'] as const)test(`managed SIGKILL after ${stop} reconciles without repeating effect`,{timeout:180000,skip:process.env.AC_MANAGED_RECOVERY_TEST!=='1'},async()=>{
 const url=process.env.AC_SANDBOX_DATABASE_URL;
 if(!url||!/^\/ac_managed_test_[a-f0-9]+$/.test(new URL(url).pathname))throw Error('FRESH_MANAGED_DATABASE_REQUIRED');
 const db=new Ledger(url);let runtime:CezarRuntime|undefined,processChild:ChildProcess|undefined;
 try{
  await db.migrate();const project=randomUUID(),principal='managed-recovery-'+randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'managed recovery fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await mkdir('.state/projects',{recursive:true});const repo=await mkdtemp(resolve('.state/projects/managed-crash-'));
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
  git('init','-q','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','fixture');
  await writeFile(join(repo,'README.md'),'fixture\n');git('add','.');git('commit','-qm','base');git('branch','protected');
  const base=git('rev-parse','HEAD');await mkdir(join(repo,'.ai/cezar'),{recursive:true});
  await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[],worktreeRetention:0}));
  const {revision,options}=await provisionEngineering(db,principal,project,repo,1,false);
  const context=await db.createContext(principal,project,randomUUID());await new Capacity(db).assignPolicy(principal,context,revision);
  const authority=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
  const task=(id:string)=>({id,objectiveRef:`message:${id}`,acceptanceRefs:['acceptance:synthetic-effect-v1'],inputRefs:[],outputRefs:[`output:${id}`],dependsOn:[],writePaths:[`src/${id}.txt`],qualityRevision:options.qualityRevision!,targetRef:options.targetRef!,maxCorrections:0});
  const plan:ManagerPlan={schemaVersion:1,contextId:context,objectiveRef:'message:objective',sourceMessageRef:'message:request',constraintRefs:[],tasks:[task('one'),task('two')]};
  const proposal=await new ManagerPlans(db).publish(principal,authority,0,plan);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'managed-synthetic-v1',messageRef:'encrypted:crash',proposalRevision:proposal.revision,proposalDigest:proposal.digest}},authority,'api');
  const marker=join(repo,'marker.json'),config=join(repo,'fixture.json');
  await writeFile(config,JSON.stringify({scope:'managed-crash-fixture',repo,project,intent,authority,marker,stop,verifierKey:Buffer.from(options.verifierKey).toString('base64'),qualityRevision:options.qualityRevision}),{mode:0o600});
  processChild=spawn(process.execPath,['--import','tsx','tests/fixtures/managed-interrupted-controller.ts',config],{stdio:['ignore','pipe','pipe']});
  let output='';processChild.stdout?.on('data',b=>{output=(output+String(b)).slice(-5000);});processChild.stderr?.on('data',b=>{output=(output+String(b)).slice(-5000);});
  const closed=new Promise<void>((ok,fail)=>{processChild!.once('close',()=>ok());processChild!.once('error',fail);});
  let markerData:any;for(let i=0;i<600;i++){try{markerData=JSON.parse(await readFile(marker,'utf8'));}catch{}if(markerData?.ready)break;
   if(processChild.exitCode!==null)throw Error('CONTROLLER_EXITED '+output);await new Promise(r=>setTimeout(r,50));}
  assert(markerData?.ready,'marker missing '+output);processChild.kill('SIGKILL');await closed;
  const children=(await db.pool.query('SELECT i.*,o.state operation_state,o.receipt FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id WHERE i.parent_intent_id=$1',[intent.id])).rows;
  assert.equal(children.length,3);const tasks=children.filter(row=>row.parent_unit_id.startsWith('task-'));
  const composition=children.find(row=>row.parent_unit_id.startsWith('compose-'))!;assert.equal(tasks.length,2);assert(composition);
  const grantsBefore=(await db.pool.query('SELECT id,attempt_id,intent_id FROM ac_capacity_grants WHERE intent_id=ANY($1::uuid[]) ORDER BY id',[children.map(row=>row.id)])).rows;
  let markedReceiptDigest:string|undefined,markedContainer:string|undefined;
  if(stop==='physical'){
   const unit=tasks.find(row=>row.operation_id===markerData.jobId);assert(unit);
   const job=(await db.pool.query('SELECT state,receipt FROM ac_sandbox_jobs WHERE id=$1',[unit.operation_id])).rows[0];
   assert.equal(job?.state,'completed');assert.equal(job.receipt.exitCode,0);assert.notEqual(unit.operation_state,'completed');assert.equal(git('rev-parse','protected'),base);
   markedReceiptDigest=digest(job.receipt);markedContainer=job.receipt.containerId;assert.match(markedContainer!,/^[a-f0-9]{64}$/);
  }else assert.notEqual(git('rev-parse','protected'),base);
  await db.pause(principal,context,true);await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);
  const successor=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
  await assert.rejects(db.tx(c=>db.fence(c,authority)),/STALE_MANAGER/);
  const pausedUnit=stop==='physical'?tasks.find(row=>row.operation_id===markerData.jobId)!:composition;
  const pausedCwd=join(repo,'.ai/cezar/managed',intent.id,pausedUnit.run_id);
  const headAtPause=execFileSync('git',['-C',pausedCwd,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),targetAtPause=git('rev-parse','protected');
  const cas=options.git.cas.bind(options.git);let casCalls=0;options.git.cas=async(...args)=>{casCalls++;return cas(...args);};
  runtime=new CezarRuntime(db,repo,project,options,new IsolatedImplementation(db));await runtime.start();
  await runtime.recoverManaged(successor);assert.equal(runtime.store.getRun(intent.run_id)?.status,'waiting');
  assert.equal(execFileSync('git',['-C',pausedCwd,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),headAtPause);
  assert.equal(git('rev-parse','protected'),targetAtPause);
  await db.pause(principal,context,false);let done=false;
  for(let i=0;i<400;i++){
   await runtime.recoverManaged(successor);const run=runtime.store.getRun(intent.run_id);
   if(run?.status==='failed')throw Error('RECOVERY_FAILED '+JSON.stringify({error:run.error,steps:run.steps}));
   if(run?.status==='done'){done=true;break;}await new Promise(r=>setTimeout(r,100));
  }
  assert(done,'managed graph did not resume '+JSON.stringify(runtime.store.getRun(intent.run_id)));
  for(const unit of tasks)assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_sandbox_jobs WHERE id=$1',[unit.operation_id])).rows[0].n,1);
  if(stop==='physical'){
   const job=(await db.pool.query('SELECT receipt FROM ac_sandbox_jobs WHERE id=$1',[markerData.jobId])).rows[0];
   assert.equal(digest(job.receipt),markedReceiptDigest);assert.equal(job.receipt.containerId,markedContainer);
  }
  const grantsAfter=(await db.pool.query('SELECT id,attempt_id,intent_id FROM ac_capacity_grants WHERE intent_id=ANY($1::uuid[]) ORDER BY id',[children.map(row=>row.id)])).rows;
  for(const before of grantsBefore)assert(grantsAfter.some(after=>after.id===before.id&&after.attempt_id===before.attempt_id&&after.intent_id===before.intent_id));
  if(stop==='cas')assert.deepEqual(grantsAfter,grantsBefore,'terminal CAS replay must not create any grant');
  if(stop==='cas')assert.equal(casCalls,0,'applied CAS must not be repeated');
  if(stop==='physical'){
   const adoption=(await db.pool.query("SELECT detail FROM ac_audit WHERE context_id=$1 AND kind='managed.operation_adopted' AND detail->>'intentId'=$2",[context,composition.id])).rows;
   assert.equal(adoption.length,1);assert.equal(adoption[0].detail.operationId,composition.operation_id);
   assert.equal(adoption[0].detail.previousEpoch,authority.epoch);assert.equal(adoption[0].detail.epoch,successor.epoch);
   assert.equal(adoption[0].detail.proof,'no-launch-or-grant');
  }
  const op=(await db.pool.query('SELECT state,receipt FROM ac_operations WHERE id=$1',[composition.operation_id])).rows[0];
  assert.equal(op.state,'completed');assert.equal(git('rev-parse','protected'),op.receipt.commit);
  const artifacts=(await db.pool.query('SELECT * FROM ac_artifacts WHERE intent_id=ANY($1::uuid[])',[children.map(row=>row.id)])).rows;
  assert.equal(artifacts.length,3);
  for(const artifact of artifacts){
   const evidence=(await db.pool.query('SELECT kind,status FROM ac_verification_evidence WHERE artifact_id=$1 ORDER BY kind',[artifact.id])).rows;
   assert.deepEqual(evidence,[{kind:'qa',status:'passed'},{kind:'review',status:'passed'}]);
  }
  const composedArtifact=artifacts.find(row=>row.intent_id===composition.id);assert(composedArtifact);
  assert.equal(composedArtifact.commit_id,op.receipt.commit);assert.equal(composedArtifact.tree_id,op.receipt.tree);assert.equal(composedArtifact.base_id,base);
  const integrations=(await db.pool.query('SELECT id,artifact_id,target_ref,state,receipt FROM ac_integration_intents WHERE context_id=$1',[context])).rows;
  assert.equal(integrations.length,1);const integration=integrations[0]!;
  assert.equal(integration.artifact_id,composedArtifact.id);assert.equal(integration.target_ref,'refs/heads/protected');assert.equal(integration.state,'integrated');
  assert.equal(integration.receipt.commit,op.receipt.commit);assert.equal(integration.receipt.tree,op.receipt.tree);assert.equal(integration.receipt.base,base);
  if(stop==='cas'){assert.equal(integration.receipt.operationId,integration.id);assert.equal(integration.receipt.reconciliation?.kind,'observed-approved-target');}
  assert.notEqual(tasks[0].run_id,tasks[1].run_id);
  for(const unit of tasks){const cwd=join(repo,'.ai/cezar/managed',intent.id,unit.run_id);
   const head=execFileSync('git',['-C',cwd,'rev-parse','HEAD'],{encoding:'utf8'}).trim();assert.equal(head,artifacts.find(a=>a.intent_id===unit.id).commit_id);}
 }finally{if(processChild&&processChild.exitCode===null&&processChild.signalCode===null)processChild.kill('SIGKILL');await runtime?.close();await db.close();}
});
