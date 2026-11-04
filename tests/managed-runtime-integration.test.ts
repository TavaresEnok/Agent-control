import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {IsolatedImplementation} from '../src/isolated-implementation.ts';
import {Capacity} from '../src/capacity.ts';
import {ManagerPlans,type ManagerPlan} from '../src/planning.ts';
import {provisionEngineering} from './fixtures/provision-engineering.ts';
import {claimWorktreeWriter} from '../src/worktree-lease.ts';
import {Refusal} from '../src/contracts.ts';
import {digest} from '../src/contracts.ts';
import {ProjectTemplates} from '../src/project-templates.ts';
import {authorizeExplicitQaWaiver} from '../src/quality.ts';

// The caller provisions a new disposable DB and broker bound to that DB.
test('managed fork joins verified unit artifacts and verifies the composition',{timeout:180000,skip:process.env.AC_MANAGED_RUNTIME_TEST!=='1'},async(t)=>{
 const url=process.env.AC_SANDBOX_DATABASE_URL;
 if(!url||!/^\/ac_managed_test_[a-f0-9]+$/.test(new URL(url).pathname))throw Error('FRESH_MANAGED_DATABASE_REQUIRED');
 const db=new Ledger(url);t.after(()=>db.close());await db.migrate();
 const project=randomUUID(),principal='managed-'+randomUUID();
 await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'managed test']);
 await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
 await mkdir('.state/projects',{recursive:true});const repo=await mkdtemp(resolve('.state/projects/managed-runtime-'));
 const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
 git('init','-q','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','fixture');
 await writeFile(join(repo,'README.md'),'fixture\n');git('add','.');git('commit','-qm','base');git('branch','protected');
 const base=git('rev-parse','HEAD');await mkdir(join(repo,'.ai/cezar'),{recursive:true});
 await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[],worktreeRetention:0}));
 const {revision,options}=await provisionEngineering(db,principal,project,repo,1,false);
 const waiverEnabled=process.env.AC_MANAGED_WAIVER_TEST==='1';
 if(waiverEnabled){
  const saved=(await db.pool.query('SELECT snapshot FROM ac_quality_policies WHERE project_id=$1 AND revision=$2',[project,options.qualityRevision])).rows[0];
  options.qualityRevision=await options.quality.publish(principal,project,options.qualityRevision!,{...saved.snapshot,allowLowRiskQaWaiver:true});
 }
 const context=await db.createContext(principal,project,randomUUID());await new Capacity(db).assignPolicy(principal,context,revision);
 if(waiverEnabled){
  const templateId=randomUUID(),template={workflow:'engineering-synthetic-v1' as const,qualityRevision:options.qualityRevision!,targetRef:options.targetRef!},catalog=new ProjectTemplates(db);
  await catalog.publish(principal,context,{templateId,expectedRevision:0,name:'Dispensa no sandbox',template,digest:digest(template)});
  await catalog.apply(principal,context,{templateId,revision:1,expectedRevision:1,expectedContextRevision:0});
  await db.tx(c=>authorizeExplicitQaWaiver(c,principal,context,{policyRevision:options.qualityRevision!,templateId,templateRevision:1,taskId:'one',riskRule:'explicit-low'}));
 }
 const authority=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
 const task=(id:string)=>({id,objectiveRef:`message:${id}`,acceptanceRefs:['acceptance:synthetic-effect-v1'],inputRefs:[],outputRefs:[`output:${id}`],dependsOn:[],writePaths:[`src/${id}.txt`],qualityRevision:options.qualityRevision!,targetRef:options.targetRef!,maxCorrections:0});
 const plan:ManagerPlan={schemaVersion:1,contextId:context,objectiveRef:'message:objective',sourceMessageRef:'message:request',constraintRefs:[],tasks:[task('one'),task('two')]};
 const proposal=await new ManagerPlans(db).publish(principal,authority,0,plan);
 const runtime=new CezarRuntime(db,repo,project,options,new IsolatedImplementation(db));await runtime.start();
 const heartbeat=setInterval(()=>{void db.heartbeat(authority).catch(()=>{});},10000);
 try{
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'managed-synthetic-v1',messageRef:'encrypted:fixture',proposalRevision:proposal.revision,proposalDigest:proposal.digest}},authority,'api');
  await runtime.dispatch(intent,authority);
  let done=false;
  for(let i=0;i<1200;i++){
   const run=runtime.store.getRun(intent.run_id);
   if(run?.status==='failed')throw Error('MANAGED_FAILED '+JSON.stringify({error:run.error,steps:run.steps}));
   if(run?.status==='done'){done=true;break;}
   await new Promise(r=>setTimeout(r,100));
  }
  assert(done,'managed run did not finish');
  await runtime.observe(intent,authority);
  const parent=(await db.pool.query('SELECT state,grant_id,receipt FROM ac_operations WHERE id=$1',[intent.operation_id])).rows[0];
  assert.equal(parent.state,'completed');assert.equal(parent.grant_id,null);assert.equal(parent.receipt.kind,'managed-aggregate-v1');
  const children=(await db.pool.query('SELECT i.*,o.receipt,o.native_session_id,o.grant_id,o.state operation_state FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id WHERE i.parent_intent_id=$1 ORDER BY i.parent_unit_id',[intent.id])).rows;
  const writers=(await db.pool.query('SELECT * FROM ac_worktree_writers WHERE parent_intent_id=$1',[intent.id])).rows;
  assert.equal(writers.length,2);
  for(const writer of writers){
   assert.equal(writer.state,'held');
   const child=children.find(row=>row.id===writer.holder_intent_id);assert(child);assert.equal(child.run_id,writer.run_id);
   await assert.rejects(db.tx(c=>claimWorktreeWriter(c,{parentIntentId:intent.id,runId:writer.run_id,intentId:randomUUID(),epoch:authority.epoch+1})),
    (error:unknown)=>error instanceof Refusal&&error.code==='WORKTREE_WRITER_BUSY');
  }
  assert.equal(children.length,3);assert(children.every(row=>row.operation_state==='completed'));
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_outbox WHERE intent_id=ANY($1::uuid[])',[children.map(row=>row.id)])).rows[0].n,0);
  const composed=children.find(row=>row.parent_unit_id.startsWith('compose-'));
  assert(composed);assert.equal(git('rev-parse','refs/heads/protected'),composed.receipt.commit);
  assert.equal(git('rev-parse',`${composed.receipt.commit}^`),base);
  for(const path of ['src/one.txt','src/two.txt'])assert(git('show',`${composed.receipt.commit}:${path}`).startsWith('Synthetic isolated effect '));
  const artifacts=(await db.pool.query('SELECT * FROM ac_artifacts WHERE intent_id=ANY($1::uuid[])',[children.map(row=>row.id)])).rows;
  assert.equal(artifacts.length,3);
  const evidence=(await db.pool.query('SELECT * FROM ac_verification_evidence WHERE artifact_id=ANY($1::uuid[])',[artifacts.map(row=>row.id)])).rows;
  for(const artifact of artifacts){
   const checks=evidence.filter(e=>e.artifact_id===artifact.id);
   const child=children.find(row=>row.id===artifact.intent_id)!;
   const waived=waiverEnabled&&child.parent_unit_id==='task-one';
   assert.deepEqual(checks.map(e=>e.kind).sort(),waived?['review']:['qa','review']);
   assert(checks.every(e=>e.status==='passed'&&e.receipt.commit===artifact.commit_id&&e.receipt.tree===artifact.tree_id&&e.receipt.base===artifact.base_id));
   assert.equal(new Set(checks.map(e=>e.session_id)).size,waived?1:2);
   assert.equal(new Set(checks.map(e=>e.grant_id)).size,waived?1:2);
   assert(checks.every(e=>e.session_id!==child.native_session_id&&e.grant_id!==child.grant_id));
   if(waived){
    const qa=(await db.pool.query("SELECT id,state,grant_id,receipt FROM ac_stage_operations WHERE intent_id=$1 AND node_id='qa'",[child.id])).rows;
    assert.equal(artifact.risk,'low');assert.equal(qa.length,1);assert.equal(qa[0].state,'completed');assert.equal(qa[0].grant_id,null);
    assert.equal(qa[0].receipt.qaWaiver.basis,'not_required');
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_sandbox_jobs WHERE id=$1',[qa[0].id])).rows[0].n,0);
   }
  }
  const integration=(await db.pool.query('SELECT * FROM ac_integration_intents WHERE artifact_id=$1',[artifacts.find(a=>a.intent_id===composed.id).id])).rows[0];
  assert(integration);assert.equal(integration.state,'integrated');assert.equal(integration.target_ref,'refs/heads/protected');
  assert.equal(artifacts.find(a=>a.intent_id===composed.id).commit_id,composed.receipt.commit);
  assert.equal(artifacts.find(a=>a.intent_id===composed.id).tree_id,composed.receipt.tree);
  assert.equal(artifacts.find(a=>a.intent_id===composed.id).base_id,base);
  const jobs=(await db.pool.query(`SELECT j.*,g.state grant_state,g.physical_receipt FROM ac_sandbox_jobs j
   JOIN ac_capacity_grants g ON g.id=j.grant_id WHERE g.intent_id=ANY($1::uuid[])`,[children.map(row=>row.id)])).rows;
  assert(jobs.length>=(waiverEnabled?7:8));assert(jobs.every(j=>j.state==='completed'&&j.grant_state==='released'&&j.physical_receipt));
  assert(jobs.filter(j=>j.profile==='synthetic-verification-v1').every(j=>j.receipt.verificationIsolation?.readOnlySnapshot));
  if(waiverEnabled){
   const before=(await db.pool.query('SELECT count(*)::int n FROM ac_qa_waivers')).rows[0].n;
   await runtime.observe(intent,authority);
   assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_qa_waivers')).rows[0].n,before);
  }
  const altered=children[0]!;
  await db.pool.query('UPDATE ac_operations SET receipt=$2 WHERE id=$1',[altered.operation_id,{...altered.receipt,exitCode:1}]);
  await assert.rejects(runtime.observe(intent,authority),/MANAGED_AGGREGATE_INCOMPLETE/);
  await db.pool.query('UPDATE ac_operations SET receipt=$2 WHERE id=$1',[altered.operation_id,altered.receipt]);
 }finally{clearInterval(heartbeat);await runtime.close();}
});

test('failed fork branch cannot produce a composition or advance the target',{timeout:180000,skip:process.env.AC_MANAGED_RUNTIME_TEST!=='1'},async()=>{
 const url=process.env.AC_SANDBOX_DATABASE_URL;
 if(!url||!/^\/ac_managed_test_[a-f0-9]+$/.test(new URL(url).pathname))throw Error('FRESH_MANAGED_DATABASE_REQUIRED');
 const db=new Ledger(url);let runtime:CezarRuntime|undefined,heartbeat:ReturnType<typeof setInterval>|undefined;
 try{
  await db.migrate();const project=randomUUID(),principal='managed-negative-'+randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'managed negative']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await mkdir('.state/projects',{recursive:true});const repo=await mkdtemp(resolve('.state/projects/managed-negative-'));
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
  git('init','-q','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','fixture');
  await writeFile(join(repo,'README'),'fixture\n');git('add','.');git('commit','-qm','base');git('branch','protected');
  const base=git('rev-parse','HEAD');await mkdir(join(repo,'.ai/cezar'),{recursive:true});
  await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[],worktreeRetention:0}));
  const {revision,options}=await provisionEngineering(db,principal,project,repo,1,false);
  const context=await db.createContext(principal,project,randomUUID());await new Capacity(db).assignPolicy(principal,context,revision);
  const authority=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
  heartbeat=setInterval(()=>{void db.heartbeat(authority).catch(()=>{});},10000);
  const task=(id:string,path:string)=>({id,objectiveRef:`message:${id}`,acceptanceRefs:['acceptance:synthetic-effect-v1'],inputRefs:[],outputRefs:[`output:${id}`],dependsOn:[],writePaths:[path],qualityRevision:options.qualityRevision!,targetRef:options.targetRef!,maxCorrections:0});
  const plan:ManagerPlan={schemaVersion:1,contextId:context,objectiveRef:'message:objective',sourceMessageRef:'message:request',constraintRefs:[],tasks:[task('bad','README/blocked.txt'),task('good','src/good.txt')]};
  const proposal=await new ManagerPlans(db).publish(principal,authority,0,plan);
  runtime=new CezarRuntime(db,repo,project,options,new IsolatedImplementation(db));await runtime.start();
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'managed-synthetic-v1',messageRef:'encrypted:negative',proposalRevision:proposal.revision,proposalDigest:proposal.digest}},authority,'api');
  await runtime.dispatch(intent,authority);let failed=false;
  for(let i=0;i<1200;i++){
   const run=runtime.store.getRun(intent.run_id);
   if(run?.status==='failed'){failed=true;break;}
   if(run?.status==='done')throw Error('MANAGED_FORK_UNEXPECTED_SUCCESS');
   await new Promise(r=>setTimeout(r,100));
  }
  assert(failed,'failed branch did not fail parent');
  const children=(await db.pool.query('SELECT i.*,o.state operation_state FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id WHERE i.parent_intent_id=$1',[intent.id])).rows;
  const bad=children.find(c=>c.parent_unit_id==='task-bad'),composition=children.find(c=>c.parent_unit_id.startsWith('compose-'));
  assert(bad&&composition);assert.equal(composition.operation_state,'registered');
  const physical=(await db.pool.query('SELECT * FROM ac_sandbox_jobs WHERE id=$1',[bad.operation_id])).rows[0];
  assert(physical,'failed branch must have reached the broker');
  assert(physical.receipt&&typeof physical.receipt.exitCode==='number'&&physical.receipt.exitCode!==0,'failed branch must prove nonzero physical exit');
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_integration_intents WHERE context_id=$1',[context])).rows[0].n,0);
  assert.equal(git('rev-parse','refs/heads/protected'),base);
 }finally{if(heartbeat)clearInterval(heartbeat);await runtime?.close();await db.close();}
});
