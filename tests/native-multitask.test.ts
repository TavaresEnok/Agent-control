import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {NativeImplementation} from '../src/native-implementation.ts';
import {NativeExecutionSupervisor,NativeExecutionRequest} from '../src/native-execution-supervisor.ts';
import {NativeVerification,nativeReviewVerifierDigest} from '../src/native-verification.ts';
import type {NativeQa} from '../src/native-qa.ts';
import {Templates} from '../src/templates.ts';
import {canonical,digest,Refusal} from '../src/contracts.ts';
import {ManagerPlans,type ManagerPlan} from '../src/planning.ts';
import {engineeringNativePlanWorkflowPrefix} from '../src/workflows.ts';
import {executionRecipe,nativeExecutionRecipe,nativeManagedTaskText} from '../src/managed-plan.ts';
import {VerificationReceipt} from '../src/quality.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {provisionEngineering} from './fixtures/provision-engineering.ts';

/** PostgreSQL and Ruby come from deploy/compose.lab.yml. This file does not
 * download binaries, start pg_ctl, or bind another interpreter over /usr/bin/ruby. */
const labDatabase=process.env.AC_TEST_DATABASE_URL;
const labReady=Boolean(labDatabase&&existsSync('/usr/bin/ruby'));
const labSkip=labReady?false:'AC_TEST_DATABASE_URL and /usr/bin/ruby from deploy/compose.lab.yml are required';

const policyBody={schemaVersion:1 as const,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:false,verifierDigest:'ab'.repeat(32)};
function task(id:string,dependsOn:string[]=[],writePaths=[`src/${id}/a.ts`,`src/${id}/b.ts`],acceptanceRefs=['acceptance:real-tests']){
 return {id,objectiveRef:`message:${id}`,acceptanceRefs,inputRefs:[],outputRefs:[`output:${id}`],dependsOn,writePaths,qualityRevision:1,targetRef:'refs/heads/protected',maxCorrections:0};
}
function plan(contextId:string,tasks:ReturnType<typeof task>[]):ManagerPlan{
 return {schemaVersion:1,contextId,objectiveRef:'message:objective',sourceMessageRef:'message:request',parallelism:4,constraintRefs:[],tasks};
}

test('native recipe refuses a cycle and an overlapping scope before any execution',()=>{
 const contextId=randomUUID();
 assert.throws(()=>nativeExecutionRecipe(plan(contextId,[task('alpha',['beta']),task('beta',['alpha'])]),[{qualityRevision:1,policy:policyBody}],randomUUID(),1),/PLAN_DEPENDENCY_CYCLE/);
 assert.throws(()=>nativeExecutionRecipe(plan(contextId,[task('alpha',[],['src/shared.txt']),task('beta',[],['src/shared.txt'])]),[{qualityRevision:1,policy:policyBody}],randomUUID(),1),/NATIVE_PLAN_SCOPE_OVERLAP/);
 assert.throws(()=>nativeExecutionRecipe(plan(contextId,[task('alpha',[],['src']),task('beta',[],['src/beta.txt'])]),[{qualityRevision:1,policy:policyBody}],randomUUID(),1),/NATIVE_PLAN_SCOPE_OVERLAP/);
 assert.throws(()=>nativeExecutionRecipe(plan(contextId,[{...task('alpha'),maxCorrections:1}]),[{qualityRevision:1,policy:policyBody}],randomUUID(),1),/NATIVE_PLAN_CORRECTION_UNAVAILABLE/);
});

test('native recipe keeps real acceptances and several write paths, and orders dependencies after the parallel batch',()=>{
 const contextId=randomUUID(),parent=randomUUID(),policies=[{qualityRevision:1,policy:policyBody}];
 const real=plan(contextId,[
  task('alpha',[],['src/alpha/a.ts','src/alpha/b.ts'],['acceptance:real-tests']),
  task('beta',[],['src/beta/a.ts'],['acceptance:real-tests','acceptance:second-check']),
 ]);
 const recipe=nativeExecutionRecipe(real,policies,parent,1);
 assert.equal(recipe.mode,'native');assert.equal(recipe.schemaVersion,1);
 assert.equal(recipe.workflow.name,`${engineeringNativePlanWorkflowPrefix}${parent}`);
 const alpha=recipe.units.find(unit=>unit.id==='task-alpha'),beta=recipe.units.find(unit=>unit.id==='task-beta');
 const composed=recipe.units.find(unit=>unit.kind==='composition');
 assert(alpha&&beta&&composed);
 assert.equal(alpha.taskId,'alpha');assert.deepEqual(alpha.acceptanceRefs,['acceptance:real-tests']);
 assert.deepEqual(alpha.writePaths,['src/alpha/a.ts','src/alpha/b.ts']);
 assert.deepEqual(beta.acceptanceRefs,['acceptance:real-tests','acceptance:second-check']);
 assert.deepEqual(composed.acceptanceRefs,['acceptance:real-tests','acceptance:second-check']);
 assert.deepEqual(composed.writePaths,['src/alpha/a.ts','src/alpha/b.ts','src/beta/a.ts']);
 assert.throws(()=>executionRecipe(real,policies,parent,1),/MANAGED_ACCEPTANCE_EXECUTOR_UNAVAILABLE/);
 const pair=plan(contextId,[
  task('alpha',[],['src/a.ts'],['acceptance:synthetic-effect-v1']),
  task('beta',[],['src/b.ts'],['acceptance:synthetic-effect-v1']),
 ]);
 const synthetic=executionRecipe(pair,policies,parent,1);
 assert.equal(synthetic.mode,'synthetic-only');
 assert.equal(synthetic.workflow.name,`managed-synthetic-${parent}`);
 assert(synthetic.units.every(unit=>unit.acceptanceRefs.length===1&&unit.acceptanceRefs[0]==='acceptance:synthetic-effect-v1'&&unit.taskId===undefined));
 const files=plan(contextId,[task('alpha',[],['src/a.ts','src/b.ts'],['acceptance:synthetic-effect-v1'])]);
 assert.throws(()=>executionRecipe(files,policies,parent,1),/MANAGED_WRITE_SCOPE_UNAVAILABLE/);
 assert.deepEqual(nativeExecutionRecipe(files,policies,parent,1).units.find(unit=>unit.taskId==='alpha')?.writePaths,['src/a.ts','src/b.ts']);
 const plus=plan(contextId,[task('alpha',[],['src/a+b.ts'],['acceptance:synthetic-effect-v1'])]);
 assert.throws(()=>executionRecipe(plus,policies,parent,1),/MANAGED_WRITE_SCOPE_UNAVAILABLE/);
 assert.deepEqual(nativeExecutionRecipe(plus,policies,parent,1).units.find(unit=>unit.taskId==='alpha')?.writePaths,['src/a+b.ts']);
 const ordered=nativeExecutionRecipe(plan(contextId,[task('alpha'),task('beta'),task('gamma',['alpha','beta'])]),policies,parent,1);
 const graph=ordered.workflow.graph;assert(graph);
 assert.equal(graph.nodes.find(node=>node.type==='fork')?.branches,2);
 assert.deepEqual(ordered.launches['launch-0'],['task-alpha','task-beta']);
 assert.deepEqual(ordered.launches['launch-1'],['task-gamma']);
 assert(graph.edges.some(edge=>edge.from==='start'&&edge.to==='launch-0'));
 assert(graph.edges.some(edge=>edge.from==='compose-0-integrate'&&edge.to==='launch-1'));
 assert(!graph.edges.some(edge=>edge.from==='start'&&edge.to==='launch-1'));
});

test('native plan runs independent tasks together, then the dependent task, and refuses invalid plans before effects',{timeout:180000,skip:labSkip},async()=>{
 const baseUrl=labDatabase;if(!baseUrl)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(baseUrl,'nativemulti'),db=new Ledger(fixture.url);
 const area=await mkdtemp(join(tmpdir(),'native-multi-'));
 let runtime:CezarRuntime|undefined,heartbeat:ReturnType<typeof setInterval>|undefined;
 try{
  await db.migrate();
  const project=randomUUID(),principal='native-multi-'+randomUUID();
  const repo=join(area,'repo'),spool=join(area,'native'),accounts=join(area,'accounts');
  for(const path of [spool,accounts])await mkdir(path,{mode:0o700});
  execFileSync('git',['init','-q','-b','main',repo],{stdio:'ignore'});
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  git('config','user.name','Fixture');git('config','user.email','fixture@invalid');
  await mkdir(join(repo,'src'));await writeFile(join(repo,'src/.gitkeep'),'');
  git('add','.');git('commit','-qm','base');const original=git('rev-parse','HEAD');git('update-ref','refs/heads/protected',original);
  await mkdir(join(repo,'.ai/cezar'),{recursive:true});
  await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[],worktreeRetention:0}));
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'native multitask']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
  const {revision,options}=await provisionEngineering(db,principal,project,repo,1,false,false);
  const qaDigest=createHash('sha256').update('native-multitask-qa-substitute-v1').digest('hex');
  const qualityRevision=await options.quality.publish(principal,project,1,{schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:false,verifierDigest:nativeReviewVerifierDigest,qaVerifierDigest:qaDigest});
  assert.equal(qualityRevision,2);
  const context=await db.createContext(principal,project,randomUUID());
  await new Capacity(db).assignPolicy(principal,context,revision);
  const authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  await new Templates(db).publish(principal,context,0,{workflow:'engineering-native-v1',qualityRevision,targetRef:'refs/heads/protected',writePaths:['src'],execution:'plan'});
  const account=(await db.pool.query('SELECT account_id AS id FROM ac_account_access WHERE project_id=$1',[project])).rows[0].id as string;
  const keys=generateKeyPairSync('ed25519'),modelImage='sha256:'+'a'.repeat(64);
  const supervisor=new NativeExecutionSupervisor(db,{id:'fixture-model-native',workerImage:modelImage,toolsImage:modelImage,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:'b'.repeat(64),accountSubjects:[{accountId:account,subjectDigest:'c'.repeat(64)}],workerEnv:[],toolsEnv:[]});
  const physical=new Map<string,{Id:string;Image:string;Config:{Labels:Record<string,string>};State:{Status:string;Running:boolean;ExitCode:number;FinishedAt:string}}>();
  Object.defineProperty(supervisor,'docker',{value:{inspect:async(name:string)=>physical.get(name)??null,stop:async()=>{}}});
  let openProgrammers=0,maxProgrammers=0,parallelArrivals=0;const programmerOrder:string[]=[];
  Object.defineProperty(supervisor,'start',{value:async(_principal:string,a:typeof authority,raw:unknown)=>{
   const input=NativeExecutionRequest.parse(raw);
   const path=input.writePaths[0]??'';const parallel=input.role==='programmer'&&!path.startsWith('src/gamma/');
   if(input.role==='programmer')programmerOrder.push(path);
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
    if(input.role==='programmer'){await options.git.snapshot(input.base,input.base,join(dir,'work'));
     for(const file of input.writePaths){await mkdir(join(dir,'work',dirname(file)),{recursive:true});await writeFile(join(dir,'work',file),`${file}\n`);}}
    else{const artifact=(await db.pool.query('SELECT * FROM ac_artifacts WHERE id=$1',[input.artifactId])).rows[0];
     output=JSON.stringify({schemaVersion:1,kind:'review',artifactId:artifact.id,policyRevision:artifact.policy_revision,commit:artifact.commit_id,tree:artifact.tree_id,base:artifact.base_id,verdict:'pass',findings:[]});}
    await writeFile(join(dir,'output/execution-result.json'),JSON.stringify({schemaVersion:1,jobId:input.jobId,output,normalizedTokensUsed:null,usageWindows:null,nativeSessionId:null,failureCode:null,exitCode:0}),{mode:0o600});
    const item=(id:string)=>({Id:id,Image:modelImage,Config:{Labels:{'agent-control.job':input.jobId,'agent-control.launch':inputDigest,'agent-control.contract':'native-execution-v1'}},State:{Status:'exited',Running:false,ExitCode:0,FinishedAt:new Date().toISOString()}});
    const worker=item(workerId),tools=item(toolsId);physical.set(workerId,worker);physical.set(toolsId,tools);physical.set('ac-native-worker-'+input.jobId,worker);physical.set('ac-native-tools-'+input.jobId,tools);
    if(input.role==='programmer')throw Error('FIXTURE_START_ACK_LOST');
    return {state:'running' as const};
   }finally{if(parallel)openProgrammers--;}
  }});
  const nativeQa={ledger:db,quality:options.quality,verifierDigest:qaDigest,reconcileContext:async()=>{},async run(owner:string,intent:{id:string;context_id:string},a:typeof authority,stage:{id:string;session_id:string},grantId:string,artifact:{id:string;policy_revision:number;commit_id:string;tree_id:string;base_id:string}){
   const receipt=VerificationReceipt.parse({schemaVersion:1,id:randomUUID(),artifactId:artifact.id,kind:'qa',sessionId:stage.session_id,grantId,policyRevision:artifact.policy_revision,commit:artifact.commit_id,tree:artifact.tree_id,base:artifact.base_id,status:'passed',exitCode:0,verifierDigest:qaDigest,logSha256:createHash('sha256').update('substitute-pass').digest('hex'),commandDigest:digest({executor:'native-multitask-qa-substitute-v1'}),verifierVersion:'native-multitask-qa-substitute-v1'});
   const signature=createHmac('sha256',options.verifierKey).update(canonical(receipt)).digest('hex');
   const physicalReceipt={state:'exited',exitCode:0,source:'native-multitask-qa-substitute'};
   await db.tx(async c=>{await db.authorize(c,owner,a.contextId);await db.fence(c,a,true);
    const released=await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1 AND state='reserved' AND role='qa' RETURNING id",[grantId,physicalReceipt]);
    if(!released.rowCount)throw new Refusal('GRANT_RECONCILIATION_REQUIRED');
    await c.query("UPDATE ac_stage_operations SET state='completed',receipt=$2,finished_at=clock_timestamp() WHERE id=$1",[stage.id,{verification:receipt,signature}]);
   });
   await options.quality.record(owner,receipt,signature,a);return receipt;
  }} as unknown as NativeQa;
  const native=new NativeImplementation(db,repo,options.quality,[supervisor]);
  const nativeVerification=new NativeVerification(db,options.quality,[supervisor],options.verifierKey);
  runtime=new CezarRuntime(db,repo,project,{...options,allowedTargets:['refs/heads/protected'],nativeQa,nativeVerification},undefined,undefined,{nativeExecutions:[supervisor],nativeImplementation:native});
  await runtime.start();heartbeat=setInterval(()=>{void db.heartbeat(authority).catch(()=>{});},5000);
  const proposal=await new ManagerPlans(db).publish(principal,authority,0,plan(context,[
   {...task('alpha'),qualityRevision},{...task('beta'),qualityRevision},{...task('gamma',['alpha','beta']),qualityRevision},
  ]));
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'managed-synthetic-v1',messageRef:'encrypted:fixture',proposalRevision:proposal.revision,proposalDigest:proposal.digest,native:true}},authority,'api');
  await runtime.dispatch(intent,authority);
  let done=false,failure='';
  for(let i=0;i<200;i++){
   const run=runtime.store.getRun(intent.run_id);
   if(run?.status==='failed'){failure=JSON.stringify({error:run.error,steps:run.steps.map(step=>({id:step.id,status:step.status,error:step.error}))});break;}
   if(run?.status==='done'){done=true;break;}
   await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.equal(failure,'');assert(done,'NATIVE_MULTITASK_NOT_COMPLETE');
  await runtime.observe(intent,authority);
  assert(maxProgrammers>=2);assert.equal(parallelArrivals,2);
  const children=(await db.pool.query('SELECT i.parent_unit_id,i.id,o.receipt,o.state,o.native_session_id,o.grant_id FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id WHERE i.parent_intent_id=$1',[intent.id])).rows;
  assert.equal(children.length,4);assert(children.every(row=>row.state==='completed'));
  const unit=(name:string)=>children.find(row=>row.parent_unit_id===name);
  const alpha=unit('task-alpha'),beta=unit('task-beta'),gamma=unit('task-gamma'),composed=children.find(row=>row.parent_unit_id.startsWith('compose-'));
  assert(alpha&&beta&&gamma&&composed);
  assert.equal(alpha.receipt.base,original);assert.equal(beta.receipt.base,original);assert.equal(alpha.receipt.synthetic,false);assert.equal(beta.receipt.synthetic,false);
  assert.equal(composed.receipt.synthetic,true);assert.equal(composed.receipt.base,original);assert.equal(git('rev-parse',`${composed.receipt.commit}^`),original);
  assert.equal(gamma.receipt.base,composed.receipt.commit);assert.equal(git('rev-parse',`${gamma.receipt.commit}^`),composed.receipt.commit);
  assert.equal(git('rev-parse','refs/heads/protected'),gamma.receipt.commit);
  for(const path of ['src/alpha/a.ts','src/alpha/b.ts','src/beta/a.ts','src/beta/b.ts','src/gamma/a.ts','src/gamma/b.ts'])assert.equal(execFileSync('git',['-C',repo,'show',`refs/heads/protected:${path}`],{encoding:'utf8'}),`${path}\n`);
  assert.deepEqual(programmerOrder.filter(path=>path.startsWith('src/alpha/')||path.startsWith('src/beta/')).sort(),['src/alpha/a.ts','src/beta/a.ts']);
  assert(programmerOrder.indexOf('src/gamma/a.ts')>programmerOrder.indexOf('src/alpha/a.ts'));
  assert(programmerOrder.indexOf('src/gamma/a.ts')>programmerOrder.indexOf('src/beta/a.ts'));
  const artifacts=(await db.pool.query('SELECT * FROM ac_artifacts WHERE intent_id=ANY($1::uuid[])',[children.map(row=>row.id)])).rows;
  assert.equal(artifacts.length,4);
  const integrations=(await db.pool.query('SELECT artifact_id,state,target_ref FROM ac_integration_intents WHERE artifact_id=ANY($1::uuid[])',[artifacts.map(row=>row.id)])).rows;
  assert.equal(integrations.length,2);assert(integrations.every(row=>row.state==='integrated'&&row.target_ref==='refs/heads/protected'));
  const integrated=new Set(integrations.map(row=>row.artifact_id));
  assert(integrated.has(artifacts.find(row=>row.intent_id===composed.id).id));
  assert(integrated.has(artifacts.find(row=>row.intent_id===gamma.id).id));
  assert(!integrated.has(artifacts.find(row=>row.intent_id===alpha.id).id));
  assert(!integrated.has(artifacts.find(row=>row.intent_id===beta.id).id));
  const evidence=(await db.pool.query('SELECT * FROM ac_verification_evidence WHERE artifact_id=ANY($1::uuid[])',[artifacts.map(row=>row.id)])).rows;
  for(const artifact of artifacts){
   const checks=evidence.filter(row=>row.artifact_id===artifact.id);
   assert.deepEqual(checks.map(row=>row.kind).sort(),['qa','review']);
   assert.equal(new Set(checks.map(row=>row.session_id)).size,2);
   const child=children.find(row=>row.id===artifact.intent_id)!;
   assert(checks.every(row=>row.session_id!==child.native_session_id&&row.grant_id!==child.grant_id));
  }
  for(const id of ['alpha','beta','gamma']){
   const child=unit('task-'+id)!;
   const frozen=(await db.pool.query('SELECT snapshot FROM ac_native_task_inputs WHERE intent_id=$1',[child.id])).rows[0];
   assert.equal(frozen.snapshot.messageDigest,digest(nativeManagedTaskText({...task(id,id==='gamma'?['alpha','beta']:[]),qualityRevision})));
  }
  const parent=(await db.pool.query('SELECT state,receipt FROM ac_operations WHERE id=$1',[intent.operation_id])).rows[0];
  assert.equal(parent.state,'completed');assert.equal(parent.receipt.kind,'managed-aggregate-v1');
  const workflow=(await db.pool.query('SELECT snapshot->>\'name\' AS name FROM ac_frozen_plans WHERE intent_id=$1',[intent.id])).rows[0];
  assert.equal(workflow.name,`engineering-native-plan-${intent.id}`);
  console.log(JSON.stringify({proof:'native-multitask',tasks:3,parallelProgrammers:maxProgrammers,dependency:'gamma',modelCalls:0,qa:'injected substitute',review:'synthetic model substitute',git:'real finalizer and CAS'}));

  const effects=async()=>Number((await db.pool.query("SELECT (SELECT count(*) FROM ac_intents WHERE context_id=$1)+(SELECT count(*) FROM ac_native_execution_jobs WHERE context_id=$1)+(SELECT count(*) FROM ac_native_task_inputs n JOIN ac_intents i ON i.id=n.intent_id WHERE i.context_id=$1) AS n",[context])).rows[0].n);
  const before=await effects();
  const overlap=await new ManagerPlans(db).publish(principal,authority,proposal.revision,plan(context,[
   {...task('left',[],['src/same.txt']),qualityRevision},{...task('right',[],['src/same.txt']),qualityRevision},
  ]));
  await assert.rejects(db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'managed-synthetic-v1',messageRef:'encrypted:overlap',proposalRevision:overlap.revision,proposalDigest:overlap.digest,native:true}},authority,'api'),/NATIVE_PLAN_SCOPE_OVERLAP/);
  await assert.rejects(new ManagerPlans(db).publish(principal,authority,overlap.revision,plan(context,[
   {...task('loop',['back']),qualityRevision},{...task('back',['loop']),qualityRevision},
  ])),/PLAN_DEPENDENCY_CYCLE/);
  git('update-ref','-d','refs/heads/protected');
  const missing=await new ManagerPlans(db).publish(principal,authority,overlap.revision,plan(context,[{...task('solo'),qualityRevision}]));
  await assert.rejects(db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'managed-synthetic-v1',messageRef:'encrypted:missing',proposalRevision:missing.revision,proposalDigest:missing.digest,native:true}},authority,'api'),/NATIVE_TASK_BASE_MISSING/);
  assert.equal(await effects(),before);
  const other=await db.createContext(principal,project,randomUUID());
  await new Capacity(db).assignPolicy(principal,other,revision);
  const otherAuthority=await db.acquire(principal,other,randomUUID(),'fixture-manager',60);
  git('update-ref','refs/heads/protected',gamma.receipt.commit);
  await new Templates(db).publish(principal,other,0,{workflow:'engineering-native-v1',qualityRevision,targetRef:'refs/heads/protected',writePaths:['src']});
  const rooted=await new ManagerPlans(db).publish(principal,otherAuthority,0,plan(other,[{...task('solo'),qualityRevision}]));
  await assert.rejects(db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:other,policyRevision:1,action:'plan.start',payload:{workflow:'managed-synthetic-v1',messageRef:'encrypted:root',proposalRevision:rooted.revision,proposalDigest:rooted.digest,native:true}},otherAuthority,'api'),/NATIVE_PLAN_TEMPLATE_REQUIRED/);
  assert.equal(Number((await db.pool.query('SELECT count(*) AS n FROM ac_intents WHERE context_id=$1',[other])).rows[0].n),0);
 }finally{if(heartbeat)clearInterval(heartbeat);await runtime?.close();await db.close();await fixture.close();await rm(area,{recursive:true,force:true});}
});
