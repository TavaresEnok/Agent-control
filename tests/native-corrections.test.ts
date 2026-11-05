import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,generateKeyPairSync,randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {NativeImplementation,assertNativeCorrectionDistinct} from '../src/native-implementation.ts';
import {NativeExecutionSupervisor,NativeExecutionRequest} from '../src/native-execution-supervisor.ts';
import {NativeVerification,nativeReviewVerifierDigest} from '../src/native-verification.ts';
import type {NativeQa} from '../src/native-qa.ts';
import {Templates} from '../src/templates.ts';
import {canonical,digest,Refusal} from '../src/contracts.ts';
import {ManagerPlans,type ManagerPlan} from '../src/planning.ts';
import {engineeringNativePlanWorkflowPrefix} from '../src/workflows.ts';
import {executionRecipe,nativeCorrectionExecutionRecipe,nativeExecutionRecipe} from '../src/managed-plan.ts';
import {nativeReviewCorrectionEvidenceAccepted} from '../src/engineering.ts';
import {VerificationReceipt} from '../src/quality.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {provisionEngineering} from './fixtures/provision-engineering.ts';

/** PostgreSQL and Ruby come from deploy/compose.lab.yml. This file does not
 * download binaries, start pg_ctl, or bind another interpreter over /usr/bin/ruby. */
const labDatabase=process.env.AC_TEST_DATABASE_URL;
const labReady=Boolean(labDatabase&&existsSync('/usr/bin/ruby'));
const labSkip=labReady?false:'AC_TEST_DATABASE_URL and /usr/bin/ruby from deploy/compose.lab.yml are required';
const policyBody={schemaVersion:1 as const,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:false,verifierDigest:'ab'.repeat(32)};
function task(id:string,maxCorrections:number,dependsOn:string[]=[],writePaths=[`src/${id}/a.ts`,`src/${id}/b.ts`],acceptanceRefs=['acceptance:real-tests']){
 return {id,objectiveRef:`message:${id}`,acceptanceRefs,inputRefs:[],outputRefs:[`output:${id}`],dependsOn,writePaths,qualityRevision:1,targetRef:'refs/heads/protected',maxCorrections};
}
function plan(contextId:string,tasks:ReturnType<typeof task>[]):ManagerPlan{
 return {schemaVersion:1,contextId,objectiveRef:'message:objective',sourceMessageRef:'message:request',parallelism:4,constraintRefs:[],tasks};
}

test('native correction recipe gives each rejection a new identity and stops at the configured limit',()=>{
 const contextId=randomUUID(),parent=randomUUID(),policies=[{qualityRevision:1,policy:policyBody}];
 assert.throws(()=>nativeExecutionRecipe(plan(contextId,[task('alpha',1)]),policies,parent,1),/NATIVE_PLAN_CORRECTION_UNAVAILABLE/);
 assert.throws(()=>nativeCorrectionExecutionRecipe(plan(contextId,[task('alpha',0)]),policies,parent,1),/NATIVE_PLAN_CORRECTION_UNAVAILABLE/);
 assert.throws(()=>nativeCorrectionExecutionRecipe(plan(contextId,[task('alpha',1,[],['src/same.ts']),task('beta',0,[],['src/same.ts'])]),policies,parent,1),/NATIVE_PLAN_SCOPE_OVERLAP/);
 assert.throws(()=>nativeCorrectionExecutionRecipe(plan(contextId,[task('alpha',1,['beta']),task('beta',0,['alpha'])]),policies,parent,1),/PLAN_DEPENDENCY_CYCLE/);
 assert.throws(()=>nativeCorrectionExecutionRecipe(plan(contextId,[task('alpha',1)]),[{qualityRevision:1,policy:{...policyBody,requireSpecialistBeforeImplementation:true,specialistVerifierDigest:'cd'.repeat(32)}}],parent,1),/NATIVE_PLAN_SPECIALIST_UNAVAILABLE/);
 const recipe=nativeCorrectionExecutionRecipe(plan(contextId,[task('alpha',1),task('beta',0),task('gamma',0,['alpha','beta'])]),policies,parent,1);
 assert.equal(recipe.mode,'native');assert.equal(recipe.schemaVersion,4);
 assert.equal(recipe.workflow.name,`${engineeringNativePlanWorkflowPrefix}${parent}`);
 const original=recipe.units.find(unit=>unit.taskId==='alpha'&&unit.correctionRevision===0);
 const corrected=recipe.units.find(unit=>unit.taskId==='alpha'&&unit.correctionRevision===1);
 const extra=recipe.units.find(unit=>unit.taskId==='alpha'&&(unit.correctionRevision??0)>1);
 assert(original&&corrected);assert.equal(extra,undefined);
 for(const field of ['id','intentId','runId','operationId','attemptId'] as const)assert.notEqual(original[field],corrected[field]);
 assert.deepEqual(corrected.acceptanceRefs,['acceptance:real-tests']);
 assert.deepEqual(corrected.writePaths,['src/alpha/a.ts','src/alpha/b.ts']);
 const graph=recipe.workflow.graph;assert(graph);
 const edge=(from:string,to:string)=>graph.edges.some(item=>item.from===from&&item.to===to);
 assert(edge(`${original.id}-qa.failed`,'failed'));
 assert(edge(`${original.id}-review.failed`,'failed'));
 assert(edge(`${original.id}-qa.reject`,`${corrected.id}-launch`));
 assert(edge(`${original.id}-review.reject`,`${corrected.id}-launch`));
 assert(edge(`${corrected.id}-qa.reject`,'failed'));
 assert(edge(`${corrected.id}-review.reject`,'failed'));
 assert(!graph.nodes.some(node=>node.id.includes('correction')&&node.id.endsWith('-2')));
 assert.deepEqual(recipe.launches['launch-0'],['task-alpha','task-beta']);
 assert(graph.edges.some(item=>item.from==='compose-0-integrate'&&item.to==='launch-1'));
 const synthetic=executionRecipe(plan(contextId,[task('alpha',0,[],['src/a.ts'],['acceptance:synthetic-effect-v1'])]),policies,parent,1);
 assert.equal(synthetic.schemaVersion,1);assert.equal(synthetic.mode,'synthetic-only');
 assert.throws(()=>assertNativeCorrectionDistinct('a'.repeat(40),'b'.repeat(40),'a'.repeat(40),'c'.repeat(40)),/NATIVE_CORRECTION_REUSED_COMMIT/);
 assert.throws(()=>assertNativeCorrectionDistinct('a'.repeat(40),'b'.repeat(40),'c'.repeat(40),'b'.repeat(40)),/NATIVE_CORRECTION_REUSED_COMMIT/);
 assert.doesNotThrow(()=>assertNativeCorrectionDistinct('a'.repeat(40),'b'.repeat(40),'c'.repeat(40),'d'.repeat(40)));
 const sessionId=randomUUID(),grantId=randomUUID(),intentId=randomUUID(),stageId=randomUUID();
 const physical={jobId:stageId,containerId:'e'.repeat(64),toolsContainerId:'f'.repeat(64),exitCode:0,workerExitCode:0,finishedAt:'2026-11-03T12:00:00.000Z',synthetic:false};
 const payload={sessionId,grantId,intentId,jobId:stageId,exitCode:0,workerExitCode:0,physicalDigest:digest(physical)};
 const accepted={kind:'review',sessionId,grantId,intentId,stageId,physical,payload,executionSignature:'ab'.repeat(64)};
 assert.equal(nativeReviewCorrectionEvidenceAccepted(accepted),true);
 assert.equal(nativeReviewCorrectionEvidenceAccepted({...accepted,kind:'judge'}),false);
 assert.equal(nativeReviewCorrectionEvidenceAccepted({...accepted,kind:'qa'}),false);
 assert.equal(nativeReviewCorrectionEvidenceAccepted({...accepted,physical:{...physical,exitCode:1},payload:{...payload,physicalDigest:digest({...physical,exitCode:1})}}),false);
 assert.equal(nativeReviewCorrectionEvidenceAccepted({...accepted,payload:{...payload,exitCode:1}}),false);
 assert.equal(nativeReviewCorrectionEvidenceAccepted({...accepted,payload:{...payload,workerExitCode:1}}),false);
 assert.equal(nativeReviewCorrectionEvidenceAccepted({...accepted,payload:{...payload,physicalDigest:'0'.repeat(64)}}),false);
 const stale={...physical,finishedAt:'0001-01-01T00:00:00.000Z'};
 assert.equal(nativeReviewCorrectionEvidenceAccepted({...accepted,physical:stale,payload:{...payload,physicalDigest:digest(stale)}}),false);
 assert.equal(nativeReviewCorrectionEvidenceAccepted({...accepted,executionSignature:'ab'.repeat(32)}),false);
});

test('authenticated native rejection corrects once, an exhausted limit stops, and infrastructure does not consume an attempt',{timeout:300000,skip:labSkip},async()=>{
 const baseUrl=labDatabase;if(!baseUrl)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(baseUrl,'nativecorr'),db=new Ledger(fixture.url);
 const area=await mkdtemp(join(tmpdir(),'native-corr-'));
 let runtime:CezarRuntime|undefined,heartbeat:ReturnType<typeof setInterval>|undefined;
 try{
  await db.migrate();
  const project=randomUUID(),principal='native-corr-'+randomUUID();
  const repo=join(area,'repo'),spool=join(area,'native'),accounts=join(area,'accounts');
  for(const path of [spool,accounts])await mkdir(path,{mode:0o700});
  execFileSync('git',['init','-q','-b','main',repo],{stdio:'ignore'});
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  git('config','user.name','Fixture');git('config','user.email','fixture@invalid');
  await mkdir(join(repo,'src'));await writeFile(join(repo,'src/.gitkeep'),'');
  git('add','.');git('commit','-qm','base');const original=git('rev-parse','HEAD');git('update-ref','refs/heads/protected',original);
  await mkdir(join(repo,'.ai/cezar'),{recursive:true});
  await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[],worktreeRetention:0}));
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'native corrections']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
  const {revision,options}=await provisionEngineering(db,principal,project,repo,1,false,false);
  const qaDigest=createHash('sha256').update('native-corrections-qa-substitute-v1').digest('hex');
  const qualityRevision=await options.quality.publish(principal,project,1,{schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:false,verifierDigest:nativeReviewVerifierDigest,qaVerifierDigest:qaDigest});
  const context=await db.createContext(principal,project,randomUUID());
  await new Capacity(db).assignPolicy(principal,context,revision);
  const authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  await new Templates(db).publish(principal,context,0,{workflow:'engineering-native-v1',qualityRevision,targetRef:'refs/heads/protected',writePaths:['src'],execution:'plan'});
  const account=(await db.pool.query('SELECT account_id AS id FROM ac_account_access WHERE project_id=$1',[project])).rows[0].id as string;
  const keys=generateKeyPairSync('ed25519'),modelImage='sha256:'+'a'.repeat(64);
  const supervisor=new NativeExecutionSupervisor(db,{id:'fixture-model-native',workerImage:modelImage,toolsImage:modelImage,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:'b'.repeat(64),accountSubjects:[{accountId:account,subjectDigest:'c'.repeat(64)}],workerEnv:[],toolsEnv:[]});
  const physical=new Map<string,{Id:string;Image:string;Config:{Labels:Record<string,string>};State:{Status:string;Running:boolean;ExitCode:number;FinishedAt:string}}>();
  Object.defineProperty(supervisor,'docker',{value:{inspect:async(name:string)=>physical.get(name)??null,inspectPrivateNetwork:async()=>null,removePrivateNetwork:async()=>{},stop:async()=>{},logs:async()=>Buffer.from('synthetic native log\n'),
   remove:async(id:string)=>{for(const [name,item] of physical)if(item.Id===id)physical.delete(name);}}});
  let mode:'correct'|'limit'|'infra'='correct',openProgrammers=0,maxProgrammers=0,parallelArrivals=0;
  const show=(commit:string,path:string)=>{try{return execFileSync('git',['-C',repo,'show',`${commit}:${path}`],{encoding:'utf8'});}catch{return '';}};
  Object.defineProperty(supervisor,'start',{value:async(_principal:string,a:typeof authority,raw:unknown)=>{
   const input=NativeExecutionRequest.parse(raw);
   const path=input.writePaths[0]??'';const parallel=input.role==='programmer'&&(path.startsWith('src/alpha/')||path.startsWith('src/beta/'));
   if(parallel){openProgrammers++;maxProgrammers=Math.max(maxProgrammers,openProgrammers);parallelArrivals++;
    const until=Date.now()+4000;while(parallelArrivals<2&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));}
   try{
    const g=(await db.pool.query('SELECT g.*,p.model,p.effort FROM ac_capacity_grants g JOIN ac_profiles p ON p.id=g.profile_id WHERE g.id=$1',[input.grantId])).rows[0];
    const workerId=createHash('sha256').update(input.jobId+'worker').digest('hex'),toolsId=createHash('sha256').update(input.jobId+'tools').digest('hex'),inputDigest=digest(input);
    await db.tx(async c=>{await db.authorize(c,principal,a.contextId);await db.fence(c,a);
     await c.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state,worker_id,tools_id,network_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,$14,'running',$15,$16,$17)`,[input.jobId,input.grantId,input.intentId,a.contextId,a.epoch,input.sessionId,g.account_id,g.profile_id,digest({accountId:g.account_id,profileId:g.profile_id,model:g.model,effort:g.effort,role:g.role}),supervisor.executorDigest,supervisor.keyFingerprint,inputDigest,input.base,input.role,workerId,toolsId,'d'.repeat(64)]);
     await c.query("UPDATE ac_capacity_grants SET state='running' WHERE id=$1",[input.grantId]);
     if(input.role==='programmer')await c.query("UPDATE ac_operations SET state='uncertain',native_session_id=$2 WHERE id=$1",[input.jobId,input.sessionId]);
     else await c.query("UPDATE ac_stage_operations SET state='uncertain' WHERE id=$1",[input.jobId]);
    });
    const dir=join(spool,input.jobId);await mkdir(dir,{mode:0o700});await mkdir(join(dir,'output'),{mode:0o700});await writeFile(join(dir,'request.json'),JSON.stringify(input),{mode:0o600});
    let output='fixture implementation complete';
    if(input.role==='programmer'){
     const request=JSON.parse(input.task) as {correction?:{decisionDigest:string;priorCommit:string}};
     await options.git.snapshot(input.base,input.base,join(dir,'work'));
     const body=mode==='limit'?(request.correction?`qa-reject ${request.correction.decisionDigest}\n`:'qa-reject\n'):request.correction?`fixed ${request.correction.decisionDigest}\n`:path.startsWith('src/alpha/')?'qa-reject\n':path.startsWith('src/beta/')?'review-reject\n':'ok\n';
     if(request.correction)assert.notEqual(request.correction.priorCommit,input.base);
     for(const file of input.writePaths){await mkdir(join(dir,'work',dirname(file)),{recursive:true});await writeFile(join(dir,'work',file),body);}
    }else{
     const artifact=(await db.pool.query('SELECT * FROM ac_artifacts WHERE id=$1',[input.artifactId])).rows[0];
     const reviewReject=show(artifact.commit_id,'src/beta/a.ts').startsWith('review-reject')||(mode==='limit'&&show(artifact.commit_id,'src/solo/a.ts').startsWith('never'));
     output=JSON.stringify({schemaVersion:1,kind:'review',artifactId:artifact.id,policyRevision:artifact.policy_revision,commit:artifact.commit_id,tree:artifact.tree_id,base:artifact.base_id,verdict:reviewReject?'reject':'pass',findings:[]});
    }
    await writeFile(join(dir,'output/execution-result.json'),JSON.stringify({schemaVersion:1,jobId:input.jobId,output,normalizedTokensUsed:null,usageWindows:null,nativeSessionId:null,failureCode:null,exitCode:0}),{mode:0o600});
    const item=(id:string)=>({Id:id,Image:modelImage,Config:{Labels:{'agent-control.job':input.jobId,'agent-control.launch':inputDigest,'agent-control.contract':'native-execution-v1'}},State:{Status:'exited',Running:false,ExitCode:0,FinishedAt:new Date().toISOString()}});
    const worker=item(workerId),tools=item(toolsId);physical.set(workerId,worker);physical.set(toolsId,tools);physical.set('ac-native-worker-'+input.jobId,worker);physical.set('ac-native-tools-'+input.jobId,tools);
    if(input.role==='programmer')throw Error('FIXTURE_START_ACK_LOST');
    return {state:'running' as const};
   }finally{if(parallel)openProgrammers--;}
  }});
  const nativeQa={ledger:db,quality:options.quality,verifierDigest:qaDigest,reconcileContext:async()=>{},async run(owner:string,intent:{id:string;context_id:string},a:typeof authority,stage:{id:string;session_id:string},grantId:string,artifact:{id:string;policy_revision:number;commit_id:string;tree_id:string;base_id:string}){
   if(mode==='infra')throw new Refusal('NATIVE_QA_TRANSPORT_LOST');
   const alpha=show(artifact.commit_id,'src/alpha/a.ts'),solo=show(artifact.commit_id,'src/solo/a.ts');
   const failed=alpha.startsWith('qa-reject')||solo.startsWith('qa-reject');
   const log=failed?'substitute-fail':'substitute-pass';
   const machine={schemaVersion:1,jobId:stage.id,artifactId:artifact.id,grantId,sessionId:stage.session_id,contractDigest:qaDigest,containerId:'e'.repeat(64),exitCode:failed?1:0,finishedAt:new Date().toISOString(),status:failed?'failed':'passed',logSha256:createHash('sha256').update(log).digest('hex'),logsAvailable:true,synthetic:false,modelInference:false};
   const receipt=VerificationReceipt.parse({schemaVersion:1,id:randomUUID(),artifactId:artifact.id,kind:'qa',sessionId:stage.session_id,grantId,policyRevision:artifact.policy_revision,commit:artifact.commit_id,tree:artifact.tree_id,base:artifact.base_id,status:failed?'failed':'passed',exitCode:failed?1:0,verifierDigest:qaDigest,logSha256:machine.logSha256,commandDigest:digest({executor:'native-corrections-qa-substitute-v1'}),verifierVersion:'native-corrections-qa-substitute-v1'});
   const signature=createHmac('sha256',options.verifierKey).update(canonical(receipt)).digest('hex');
   await db.tx(async c=>{await db.authorize(c,owner,a.contextId);await db.fence(c,a,true);
    if(failed)await c.query(`INSERT INTO ac_native_qa_jobs(id,context_id,intent_id,artifact_id,grant_id,session_id,manager_epoch,request_digest,contract_digest,container_id,state,deadline_at,receipt)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'failed',clock_timestamp(),$11)`,[stage.id,a.contextId,intent.id,artifact.id,grantId,stage.session_id,a.epoch,digest({qa:stage.id}),qaDigest,machine.containerId,machine]);
    const released=await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1 AND state='reserved' AND role='qa' RETURNING id",[grantId,machine]);
    if(!released.rowCount)throw new Refusal('GRANT_RECONCILIATION_REQUIRED');
    await c.query("UPDATE ac_stage_operations SET state='completed',grant_id=$2,receipt=$3,finished_at=clock_timestamp() WHERE id=$1",[stage.id,grantId,{verification:receipt,signature,...(failed?{nativeQa:machine}:{})}]);
   });
   await options.quality.record(owner,receipt,signature,a);return receipt;
  }} as unknown as NativeQa;
  const native=new NativeImplementation(db,repo,options.quality,[supervisor]);
  const nativeVerification=new NativeVerification(db,options.quality,[supervisor],options.verifierKey);
  runtime=new CezarRuntime(db,repo,project,{...options,allowedTargets:['refs/heads/protected'],nativeQa,nativeVerification},undefined,undefined,{nativeExecutions:[supervisor],nativeImplementation:native});
  await runtime.start();heartbeat=setInterval(()=>{void db.heartbeat(authority).catch(()=>{});},5000);
  const runPlan=async(body:ManagerPlan,message:string)=>{
   const proposal=await new ManagerPlans(db).publish(principal,authority,Number((await db.pool.query('SELECT COALESCE(max(revision),0) n FROM ac_manager_plans WHERE context_id=$1',[context])).rows[0].n),body);
   const before=Number((await db.pool.query('SELECT count(*) n FROM ac_intents WHERE context_id=$1',[context])).rows[0].n);
   const synthetic={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start' as const,payload:{workflow:'managed-synthetic-v1' as const,messageRef:message,proposalRevision:proposal.revision,proposalDigest:proposal.digest}};
   await assert.rejects(db.accept(principal,synthetic,authority,'api'),/MANAGED_CORRECTION_EXECUTOR_UNAVAILABLE/);
   assert.equal(Number((await db.pool.query('SELECT count(*) n FROM ac_intents WHERE context_id=$1',[context])).rows[0].n),before);
   const intent=await db.accept(principal,{...synthetic,intentId:randomUUID(),deliveryAttemptId:randomUUID(),payload:{...synthetic.payload,messageRef:message+':native',native:true}},authority,'api');
   await runtime!.dispatch(intent,authority);
   let status='';
   for(let i=0;i<200;i++){const run=runtime!.store.getRun(intent.run_id);if(run?.status==='done'||run?.status==='failed'){status=run.status;break;}await new Promise(resolve=>setTimeout(resolve,500));}
   return {intent,status,failure:status==='failed'?JSON.stringify(runtime!.store.getRun(intent.run_id)?.error):''};
  };
  mode='correct';parallelArrivals=0;maxProgrammers=0;
  const corrected=await runPlan(plan(context,[
   {...task('alpha',1),qualityRevision},{...task('beta',1),qualityRevision},{...task('gamma',0,['alpha','beta']),qualityRevision},
  ]), 'encrypted:correct');
  assert.equal(corrected.failure,'');assert.equal(corrected.status,'done');assert(maxProgrammers>=2);
  const decisions=(await db.pool.query('SELECT * FROM ac_managed_correction_decisions WHERE parent_intent_id=$1 ORDER BY task_id',[corrected.intent.id])).rows;
  assert.equal(decisions.length,2);
  const children=(await db.pool.query('SELECT i.*,o.state operation_state,o.receipt,o.native_session_id,o.grant_id FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id WHERE i.parent_intent_id=$1',[corrected.intent.id])).rows;
  for(const decision of decisions){
   const prior=children.find(row=>row.id===decision.prior_intent_id),next=children.find(row=>row.id===decision.next_intent_id);
   assert(prior&&next);assert.notEqual(prior.id,next.id);assert.notEqual(prior.run_id,next.run_id);assert.notEqual(prior.operation_id,next.operation_id);
   assert.notEqual(prior.native_session_id,next.native_session_id);assert.notEqual(prior.grant_id,next.grant_id);
   assert.equal(prior.receipt.base,original);assert.equal(next.receipt.base,original);assert.notEqual(prior.receipt.commit,next.receipt.commit);assert.notEqual(prior.receipt.tree,next.receipt.tree);
   assert.equal(git('rev-parse',`${next.receipt.commit}^`),original);assert.notEqual(next.receipt.commit,decision.prior_commit);
   const rejected=(await db.pool.query('SELECT * FROM ac_verification_evidence WHERE id=ANY($1::uuid[])',[decision.failed_evidence_ids])).rows;
   assert(rejected.length>0&&rejected.every(row=>row.status==='failed'&&row.receipt.exitCode>0));
   const artifact=(await db.pool.query('SELECT * FROM ac_artifacts WHERE intent_id=$1',[next.id])).rows[0];
   const fresh=(await db.pool.query('SELECT * FROM ac_verification_evidence WHERE artifact_id=$1',[artifact.id])).rows;
   assert.deepEqual(fresh.map(row=>row.kind).sort(),['qa','review']);
   assert(fresh.every(row=>row.status==='passed'&&!decision.failed_evidence_ids.includes(row.id)&&!rejected.some(item=>item.session_id===row.session_id||item.grant_id===row.grant_id)));
  }
  const selected=(await db.pool.query('SELECT * FROM ac_managed_task_selections WHERE parent_intent_id=$1',[corrected.intent.id])).rows;
  assert.equal(selected.find(row=>row.task_id==='alpha')?.selected_intent_id,decisions.find(row=>row.task_id==='alpha')?.next_intent_id);
  assert.equal(selected.find(row=>row.task_id==='beta')?.selected_intent_id,decisions.find(row=>row.task_id==='beta')?.next_intent_id);
  const composed=children.find(row=>row.parent_unit_id.startsWith('compose-'));assert(composed);
  const snapshot=(await db.pool.query('SELECT snapshot FROM ac_managed_composition_sources WHERE intent_id=$1',[composed.id])).rows[0].snapshot as {artifactId:string;commit:string}[];
  assert(snapshot.every(item=>!decisions.some(decision=>decision.prior_artifact_id===item.artifactId||decision.prior_commit===item.commit)));
  const approvedTarget=git('rev-parse','refs/heads/protected');
  assert.equal(approvedTarget,children.find(row=>row.parent_unit_id==='task-gamma')?.receipt.commit);
  assert.notEqual(approvedTarget,original);
  assert.equal(show(approvedTarget,'src/alpha/a.ts').startsWith('fixed '),true);
  assert.equal(show(approvedTarget,'src/beta/a.ts').startsWith('fixed '),true);
  assert(!show(approvedTarget,'src/alpha/a.ts').includes('qa-reject'));
  await runtime.observe(corrected.intent,authority);
  console.log(JSON.stringify({proof:'native-corrections',tasks:3,corrections:decisions.length,parallelProgrammers:maxProgrammers,modelCalls:0,qa:'injected substitute',review:'synthetic model substitute'}));

  mode='limit';parallelArrivals=0;
  assert.equal(git('rev-parse','refs/heads/protected'),approvedTarget);
  const limited=await runPlan(plan(context,[{...task('solo',1,[],['src/solo/a.ts']),qualityRevision}]),'encrypted:limit');
  assert.equal(limited.status,'failed');
  const limitDecisions=(await db.pool.query('SELECT * FROM ac_managed_correction_decisions WHERE parent_intent_id=$1',[limited.intent.id])).rows;
  assert.equal(limitDecisions.length,1);assert.equal(limitDecisions[0].revision,1);
  const limitChildren=(await db.pool.query('SELECT i.parent_unit_id,o.state FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id WHERE i.parent_intent_id=$1',[limited.intent.id])).rows;
  assert.equal(limitChildren.filter(row=>row.parent_unit_id.includes('correction')).length,1);
  assert.equal(git('rev-parse','refs/heads/protected'),approvedTarget);
  assert.notEqual(limitDecisions[0].prior_commit,approvedTarget);
  assert.notEqual(limitDecisions[0].base_id,limitDecisions[0].prior_commit);

  mode='infra';
  assert.equal(git('rev-parse','refs/heads/protected'),approvedTarget);
  const broken=await runPlan(plan(context,[{...task('down',1,[],['src/down/a.ts']),qualityRevision},{...task('peer',0,[],['src/peer/a.ts']),qualityRevision}]),'encrypted:infra');
  assert.equal(broken.status,'failed');
  const infraDecisions=Number((await db.pool.query('SELECT count(*) n FROM ac_managed_correction_decisions WHERE parent_intent_id=$1',[broken.intent.id])).rows[0].n);
  assert.equal(infraDecisions,0);
  const correction=(await db.pool.query(`SELECT o.state,o.grant_id,o.native_session_id FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id
   WHERE i.parent_intent_id=$1 AND i.parent_unit_id LIKE 'correction-%'`,[broken.intent.id])).rows;
  assert(correction.length>=1);assert(correction.every(row=>row.state==='registered'&&row.grant_id===null&&row.native_session_id===null));
  assert.equal(git('rev-parse','refs/heads/protected'),approvedTarget);
 }finally{if(heartbeat)clearInterval(heartbeat);await runtime?.close();await db.close();await fixture.close();await rm(area,{recursive:true,force:true});}
});
