import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {Capacity} from '../src/capacity.ts';
import {IsolatedImplementation} from '../src/isolated-implementation.ts';
import {ManagerPlans,type ManagerPlan} from '../src/planning.ts';
import {authorizeSyntheticSpecialistAdvice} from '../src/managed-plan.ts';
import {digest} from '../src/contracts.ts';
import {provisionEngineering} from './fixtures/provision-engineering.ts';

test('owner policy requires independent specialist on frozen source before managed writers',{timeout:180000,skip:process.env.AC_SPECIALIST_TEST!=='1'},async()=>{
 const url=process.env.AC_SANDBOX_DATABASE_URL;if(!url||!/^\/ac_managed_test_[a-f0-9]+$/.test(new URL(url).pathname))throw Error('FRESH_MANAGED_DATABASE_REQUIRED');
 const db=new Ledger(url);let runtime:CezarRuntime|undefined,heartbeat:ReturnType<typeof setInterval>|undefined;
 try{
  await db.migrate();const project=randomUUID(),principal='specialist-'+randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'specialist fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await mkdir('.state/projects',{recursive:true});const repo=await mkdtemp(resolve('.state/projects/managed-specialist-'));
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
  git('init','-q','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','fixture');
  await writeFile(join(repo,'README'),'fixture\n');git('add','.');git('commit','-qm','base');git('branch','protected');const base=git('rev-parse','HEAD');
  await mkdir(join(repo,'.ai/cezar'),{recursive:true});await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[],worktreeRetention:0}));
  const {revision,options}=await provisionEngineering(db,principal,project,repo,1,false),service=new Capacity(db);
  const account=(await db.pool.query(`SELECT p.account_id FROM ac_profiles p JOIN ac_account_access a ON a.account_id=p.account_id
   WHERE a.project_id=$1 AND p.role='programmer' LIMIT 1`,[project])).rows[0].account_id;
  await service.registerModel('synthetic-engineering-admin',{provider:'synthetic-engineering',model:'fixed-specialist',efforts:['medium'],roles:['specialist'],source:'synthetic://fixture'});
  const specialistProfile=randomUUID();await service.addProfile(principal,project,{id:specialistProfile,accountId:account,model:'fixed-specialist',effort:'medium',role:'specialist'});
  const originalCapacity=(await db.pool.query('SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 AND revision=$2',[project,revision])).rows[0].snapshot;
  const capacityRevision=await service.publish(principal,project,revision,{...originalCapacity,roles:{...originalCapacity.roles,specialist:{regular:[specialistProfile],emergency:[]}}});
  const prior=(await db.pool.query('SELECT snapshot,digest FROM ac_quality_policies WHERE project_id=$1 AND revision=$2',[project,options.qualityRevision])).rows[0];
  assert.equal(digest(prior.snapshot),prior.digest,'legacy policy digest remains unchanged');
  const specialistVerifierDigest=createHash('sha256').update(await readFile(resolve('tests/fixtures/synthetic-specialist-policy.mjs'))).digest('hex');
  const qualityRevision=await options.quality.publish(principal,project,options.qualityRevision!,{...prior.snapshot,requireSpecialistBeforeImplementation:true,specialistVerifierDigest});
  const context=await db.createContext(principal,project,randomUUID());await service.assignPolicy(principal,context,capacityRevision);
  const authority=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
  const task=(id:string)=>({id,objectiveRef:`message:${id}`,acceptanceRefs:['acceptance:synthetic-effect-v1'],inputRefs:[],outputRefs:[`output:${id}`],dependsOn:[],writePaths:[`src/${id}.txt`],qualityRevision,targetRef:options.targetRef!,maxCorrections:0});
  const plan:ManagerPlan={schemaVersion:1,contextId:context,objectiveRef:'message:objective',sourceMessageRef:'message:request',constraintRefs:[],tasks:[task('one'),task('two')]};
  const proposal=await new ManagerPlans(db).publish(principal,authority,0,plan);
  const command={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start' as const,payload:{workflow:'managed-synthetic-v1' as const,messageRef:'encrypted:specialist',proposalRevision:proposal.revision,proposalDigest:proposal.digest}};
  await assert.rejects(db.accept(principal,command,authority,'api'),/MANAGED_SPECIALIST_EXECUTOR_UNAVAILABLE/);
  authorizeSyntheticSpecialistAdvice(db);const intent=await db.accept(principal,command,authority,'api');
  runtime=new CezarRuntime(db,repo,project,options,new IsolatedImplementation(db));await runtime.start();heartbeat=setInterval(()=>{void db.heartbeat(authority).catch(()=>{});},10000);
  const children=(await db.pool.query('SELECT * FROM ac_intents WHERE parent_intent_id=$1',[intent.id])).rows;
  const initial=children.find(row=>row.parent_unit_id==='task-one');assert(initial&&runtime.engineering);
  await assert.rejects(db.tx(async c=>{await db.fence(c,authority);await runtime!.engineering!.assertSpecialistApproved(c,initial.id,authority);}),/SPECIALIST_INPUT_MISMATCH|PREIMPLEMENTATION_ADVICE_REQUIRED/);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_execution_launches')).rows[0].n,0);
  await runtime.dispatch(intent,authority);let done=false;
  for(let i=0;i<1200;i++){const run=runtime.store.getRun(intent.run_id);if(run?.status==='failed')throw Error('SPECIALIST_RUN_FAILED '+JSON.stringify({error:run.error,steps:run.steps}));
   if(run?.status==='done'){done=true;break;}await new Promise(r=>setTimeout(r,100));}
  assert(done,'specialist graph did not finish');await runtime.observe(intent,authority);
  const advice=(await db.pool.query(`SELECT a.*,g.role,g.resource_kind,g.state grant_state,g.physical_receipt,j.receipt job_receipt,j.state job_state,l.created_at writer_launch,
   o.native_session_id writer_session,o.grant_id writer_grant FROM ac_specialist_advice a JOIN ac_capacity_grants g ON g.id=a.grant_id
   JOIN ac_sandbox_jobs j ON j.id=a.id JOIN ac_operations o ON o.intent_id=a.intent_id JOIN ac_execution_launches l ON l.operation_id=o.id
   WHERE a.context_id=$1`,[context])).rows;
  assert.equal(advice.length,2);
  for(const a of advice){
   assert.equal(a.state,'completed');assert.equal(a.role,'specialist');assert.equal(a.resource_kind,'model');assert.equal(a.grant_state,'released');assert.equal(a.job_state,'completed');
   assert.equal(a.receipt.status,'approved');assert.equal(a.receipt.sourceBase,base);assert.notEqual(a.session_id,a.writer_session);assert.notEqual(a.grant_id,a.writer_grant);
   assert.deepEqual(a.physical_receipt,a.job_receipt);assert.equal(a.job_receipt.adviceIsolation.readOnlySnapshot,true);assert.equal(a.job_receipt.adviceIsolation.uid,10001);
   assert(new Date(a.writer_launch).getTime()>=Date.parse(a.job_receipt.finishedAt),'physical advice must finish before writer launch');
  }
  const compositions=children.find(row=>row.parent_unit_id.startsWith('compose-'));assert(compositions);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_specialist_advice WHERE intent_id=$1',[compositions.id])).rows[0].n,0);
  assert.notEqual(git('rev-parse','protected'),base);
  const rejectedBase=git('rev-parse','protected'),rejectedContext=await db.createContext(principal,project,randomUUID());
  await service.assignPolicy(principal,rejectedContext,capacityRevision);
  const rejectedAuthority=await db.acquire(principal,rejectedContext,randomUUID(),'synthetic-manager',60);
  const rejectedPlan:ManagerPlan={...plan,contextId:rejectedContext,tasks:[task('reject')]};
  const rejectedProposal=await new ManagerPlans(db).publish(principal,rejectedAuthority,0,rejectedPlan);
  const rejectedIntent=await db.accept(principal,{...command,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:rejectedContext,
   payload:{...command.payload,proposalRevision:rejectedProposal.revision,proposalDigest:rejectedProposal.digest}},rejectedAuthority,'api');
  await runtime.dispatch(rejectedIntent,rejectedAuthority);let failed=false;
  for(let i=0;i<600;i++){const run=runtime.store.getRun(rejectedIntent.run_id);if(run?.status==='failed'){failed=true;break;}await new Promise(r=>setTimeout(r,100));}
  assert(failed,'physical rejection must stop the graph');
  const rejection=(await db.pool.query(`SELECT a.receipt,g.physical_receipt,j.receipt job_receipt,o.id operation_id FROM ac_specialist_advice a
   JOIN ac_capacity_grants g ON g.id=a.grant_id JOIN ac_sandbox_jobs j ON j.id=a.id JOIN ac_operations o ON o.intent_id=a.intent_id
   WHERE a.context_id=$1`,[rejectedContext])).rows;
  assert.equal(rejection.length,1);assert.equal(rejection[0].receipt.status,'rejected');
  assert.equal(rejection[0].physical_receipt.advice.verdict,'reject');assert.deepEqual(rejection[0].physical_receipt,rejection[0].job_receipt);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_execution_launches WHERE operation_id=$1',[rejection[0].operation_id])).rows[0].n,0);
  assert.equal(git('rev-parse','protected'),rejectedBase);
 }finally{if(heartbeat)clearInterval(heartbeat);await runtime?.close();await db.close();}
});
