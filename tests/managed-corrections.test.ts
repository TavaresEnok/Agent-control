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
import {provisionEngineering} from './fixtures/provision-engineering.ts';
import {authorizeSyntheticManagedCorrections,correctionExecutionRecipe,executionRecipe} from '../src/managed-plan.ts';

test('correction graph is bounded and the existing zero-correction recipe stays v1',()=>{
 const task=(maxCorrections:number)=>({id:'one',objectiveRef:'message:one',acceptanceRefs:['acceptance:synthetic-effect-v1'],inputRefs:[],outputRefs:['output:one'],dependsOn:[],writePaths:['src/one.txt'],qualityRevision:1,targetRef:'refs/heads/protected',maxCorrections});
 const plan=(maxCorrections:number):ManagerPlan=>({schemaVersion:1,contextId:randomUUID(),objectiveRef:'message:objective',sourceMessageRef:'message:request',constraintRefs:[],tasks:[task(maxCorrections)]});
 const policy={schemaVersion:1 as const,requiredReviews:1,allowLowRiskQaWaiver:false,requireJudge:false,requireHumanIntegration:false,verifierDigest:'a'.repeat(64)};
 const policies=[{qualityRevision:1,policy}];
 assert.equal(executionRecipe(plan(0),policies,randomUUID(),1).schemaVersion,1);
 assert.throws(()=>executionRecipe(plan(1),policies,randomUUID(),1),/MANAGED_CORRECTION_EXECUTOR_UNAVAILABLE/);
 const recipe=correctionExecutionRecipe(plan(1),policies,randomUUID(),1),last=recipe.units.find(unit=>unit.correctionRevision===1)!;
 assert.equal(recipe.units.length,2);assert(recipe.workflow.graph?.edges.some(edge=>edge.from===`${last.id}-qa.reject`&&edge.to==='failed'));
 assert(recipe.workflow.graph?.edges.some(edge=>edge.from===`${last.id}-review.reject`&&edge.to==='failed'));
});

test('physical QA rejection leads to one corrected artifact; infrastructure failure does not',{timeout:180000,skip:process.env.AC_CORRECTION_TEST!=='1'},async()=>{
 const url=process.env.AC_SANDBOX_DATABASE_URL;if(!url||!/^\/ac_managed_test_[a-f0-9]+$/.test(new URL(url).pathname))throw Error('FRESH_MANAGED_DATABASE_REQUIRED');
 const db=new Ledger(url);let runtime:CezarRuntime|undefined,heartbeat:ReturnType<typeof setInterval>|undefined;
 try{
  await db.migrate();authorizeSyntheticManagedCorrections(db);
  for(const mode of ['quality','infra'] as const){
   const project=randomUUID(),principal='correction-'+randomUUID();await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'correction fixture']);
   await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
   await mkdir('.state/projects',{recursive:true});const repo=await mkdtemp(resolve('.state/projects/managed-correction-'));
   const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
   git('init','-q','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','fixture');
   await writeFile(join(repo,'README'),'fixture\n');git('add','.');git('commit','-qm','base');git('branch','protected');const base=git('rev-parse','HEAD');
   await mkdir(join(repo,'.ai/cezar'),{recursive:true});await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[],worktreeRetention:0}));
   const {revision,options}=await provisionEngineering(db,principal,project,repo,1,false),verifier=resolve('tests/fixtures/synthetic-correction-verifier.mjs');
   const verifierDigest=createHash('sha256').update(await readFile(verifier)).digest('hex');
   const old=(await db.pool.query('SELECT snapshot FROM ac_quality_policies WHERE project_id=$1 AND revision=$2',[project,options.qualityRevision])).rows[0].snapshot;
   const qualityRevision=await options.quality.publish(principal,project,options.qualityRevision!,{...old,verifierDigest});options.qualityRevision=qualityRevision;options.syntheticVerifierPath=verifier;
   const context=await db.createContext(principal,project,randomUUID());await new Capacity(db).assignPolicy(principal,context,revision);
   const authority=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
   const task=(id:string,path:string,maxCorrections:number)=>({id,objectiveRef:`message:${id}`,acceptanceRefs:['acceptance:synthetic-effect-v1'],inputRefs:[],outputRefs:[`output:${id}`],dependsOn:[],writePaths:[path],qualityRevision,targetRef:options.targetRef!,maxCorrections});
   const plan:ManagerPlan={schemaVersion:1,contextId:context,objectiveRef:'message:objective',sourceMessageRef:'message:request',constraintRefs:[],tasks:mode==='quality'?[task('one','src/one.txt',1),task('two','src/two.txt',0)]:[task('bad','README/blocked.txt',1)]};
   const proposal=await new ManagerPlans(db).publish(principal,authority,0,plan);
   runtime=new CezarRuntime(db,repo,project,options,new IsolatedImplementation(db));await runtime.start();heartbeat=setInterval(()=>{void db.heartbeat(authority).catch(()=>{});},10000);
   try{
    const command={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start' as const,payload:{workflow:'managed-synthetic-v1' as const,messageRef:'encrypted:fixture',proposalRevision:proposal.revision,proposalDigest:proposal.digest}};
    const untrusted=new Ledger(url);
    try{await assert.rejects(untrusted.accept(principal,command,authority,'api'),/MANAGED_CORRECTION_EXECUTOR_UNAVAILABLE/);}
    finally{await untrusted.close();}
    const intent=await db.accept(principal,command,authority,'api');
    await runtime.dispatch(intent,authority);let status='';
    for(let i=0;i<1200;i++){const run=runtime.store.getRun(intent.run_id);if(run?.status==='done'||run?.status==='failed'){status=run.status;break;}await new Promise(r=>setTimeout(r,100));}
    assert.equal(status,mode==='quality'?'done':'failed',JSON.stringify(runtime.store.getRun(intent.run_id)));
    const decisions=(await db.pool.query('SELECT * FROM ac_managed_correction_decisions WHERE parent_intent_id=$1',[intent.id])).rows;
    const children=(await db.pool.query(`SELECT i.*,o.state operation_state,o.receipt,o.native_session_id,o.grant_id FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id WHERE i.parent_intent_id=$1`,[intent.id])).rows;
    if(mode==='infra'){
     assert.equal(decisions.length,0);assert.equal(children.filter(row=>row.operation_state==='completed').length,0);
     assert.equal(git('rev-parse','protected'),base);
     assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_sandbox_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id WHERE g.context_id=$1',[context])).rows[0].n,1);
    }else{
     assert.equal(decisions.length,1);const decision=decisions[0]!,prior=children.find(c=>c.id===decision.prior_intent_id),next=children.find(c=>c.id===decision.next_intent_id);
     assert(prior&&next);assert.notEqual(prior.id,next.id);assert.notEqual(prior.operation_id,next.operation_id);assert.notEqual(prior.run_id,next.run_id);
     assert.notEqual(prior.native_session_id,next.native_session_id);assert.notEqual(prior.grant_id,next.grant_id);assert.equal(decision.revision,1);
     assert.equal(prior.receipt.base,base);assert.equal(next.receipt.base,base);assert.notEqual(prior.receipt.commit,next.receipt.commit);
     const rejected=(await db.pool.query('SELECT * FROM ac_verification_evidence WHERE id=ANY($1::uuid[])',[decision.failed_evidence_ids])).rows;
     assert(rejected.length>0&&rejected.every(e=>e.status==='failed'&&e.receipt.exitCode>0));
     const selected=(await db.pool.query('SELECT * FROM ac_managed_task_selections WHERE parent_intent_id=$1',[intent.id])).rows;
     assert.equal(selected.length,2);assert.equal(selected.find(s=>s.task_id==='one')?.selected_intent_id,next.id);
     const artifact=(await db.pool.query('SELECT * FROM ac_artifacts WHERE intent_id=$1',[next.id])).rows[0];
     const fresh=(await db.pool.query('SELECT * FROM ac_verification_evidence WHERE artifact_id=$1',[artifact.id])).rows;
     assert.deepEqual(fresh.map(e=>e.kind).sort(),['qa','review']);assert(fresh.every(e=>e.status==='passed'&&!decision.failed_evidence_ids.includes(e.id)));
     const composed=children.find(c=>c.parent_unit_id.startsWith('compose-'));assert(composed);
     const snapshot=(await db.pool.query('SELECT snapshot FROM ac_managed_composition_sources WHERE intent_id=$1',[composed.id])).rows[0].snapshot;
     assert(snapshot.some((s:{artifactId:string})=>s.artifactId===artifact.id));assert(!snapshot.some((s:{artifactId:string})=>s.artifactId===decision.prior_artifact_id));
     assert.equal(git('rev-parse','protected'),composed.receipt.commit);assert.equal(git('rev-parse',`${composed.receipt.commit}^`),base);
     const priorBytes=execFileSync('git',['-C',repo,'show',`${prior.receipt.commit}:src/one.txt`]);
     const result=git('show',`${composed.receipt.commit}:src/one.txt`);
     assert(result.includes(`Prior content sha256 ${createHash('sha256').update(priorBytes).digest('hex')}`));
     assert(result.includes(`Decision ${decision.decision_digest}`));
     await runtime.observe(intent,authority);
    }
   }finally{if(heartbeat)clearInterval(heartbeat);heartbeat=undefined;await runtime.close();runtime=undefined;}
  }
 }finally{if(heartbeat)clearInterval(heartbeat);await runtime?.close();await db.close();}
});
