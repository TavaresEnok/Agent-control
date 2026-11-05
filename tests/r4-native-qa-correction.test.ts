import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {NativeExecutionSupervisor} from '../src/native-execution-supervisor.ts';
import {NativeImplementation} from '../src/native-implementation.ts';
import {NativeVerification,nativeReviewVerifierDigest} from '../src/native-verification.ts';
import {NativeQa,NativeQaContract,nativeQaContractDigest,assertCompleteQaLogs} from '../src/native-qa.ts';
import {authorizeNativeSyntheticFixture} from '../src/native-synthetic-fixture.ts';
import {ProviderEligibility} from '../src/provider-eligibility.ts';
import {AccountHomes} from '../src/account-homes.ts';
import {Templates} from '../src/templates.ts';
import {ManagerPlans} from '../src/planning.ts';
import {ProjectEnvironments} from '../src/project-environments.ts';
import {Operators,operatorMessage} from '../src/operator.ts';
import {digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {provisionEngineering} from './fixtures/provision-engineering.ts';
import {installGraphAllocator} from './fixtures/r2-graph-allocator.ts';
import {cleanupGraphResources} from './fixtures/native-graph-cleanup.ts';
import {provisionFlowResources,retireFlowResources,assertFlowResourceLimits,type FlowResourceEnvelope} from './fixtures/r3-flow-resources.ts';

/** Actual effects; only model behavior and subnet allocation are deterministic.
 * No Happier/planner/cancellation duplicate, provider login or official inference. */
test('T21 physical QA reproduces defect after initial review, then normal correction needs new review and QA',{timeout:180000},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL,image=process.env.AC_R3_FLOW_IMAGE,network=process.env.AC_R3_FLOW_NETWORK,label=process.env.AC_R3_FLOW_LABEL;
 if(!base||!image||!network||!label||process.env.AC_R3_FLOW_TOOLS_KIND!=='codex-exec-server')throw Error('R4_CORRECTION_ISOLATED_RUNNER_REQUIRED');
 const database=await isolatedDatabase(base,'r4nativecorr'),db=new Ledger(database.url),area=await mkdtemp('/tmp/ac-r4-native-correction-');
 let runtime:CezarRuntime|undefined,resources:FlowResourceEnvelope|undefined,heartbeat:ReturnType<typeof setInterval>|undefined,primary:unknown;
 try{
  installGraphAllocator();await db.migrate();resources=await provisionFlowResources(area,image);await assertFlowResourceLimits(resources);
  const project=randomUUID(),principal='r4-correction-'+randomUUID(),repo=join(area,'repo'),spool=join(area,'execution'),homes=join(area,'homes'),qaRoot=join(area,'qa');
  for(const path of [spool,homes,qaRoot])await mkdir(path,{mode:0o700});
  execFileSync('git',['init','-q','-b','main',repo]);await chmod(repo,0o700);await chmod(join(repo,'.git'),0o700);
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();git('config','user.name','Correction lab');git('config','user.email','lab@example.invalid');
  await mkdir(join(repo,'src'),{mode:0o700});await writeFile(join(repo,'src/.gitkeep'),'');git('add','.');git('commit','-qm','base');const original=git('rev-parse','HEAD');git('branch','protected');
  await mkdir(join(repo,'.ai/cezar'),{recursive:true});await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[],worktreeRetention:0}));
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,label]);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);await db.pool.query('INSERT INTO ac_project_repositories VALUES($1,$2)',[project,repo]);
  const {revision,options}=await provisionEngineering(db,principal,project,repo),capacity=new Capacity(db),context=await db.createContext(principal,project,randomUUID());await capacity.assignPolicy(principal,context,revision);
  const account=(await db.pool.query('SELECT account_id FROM ac_account_access WHERE project_id=$1',[project])).rows[0].account_id as string,subject='c'.repeat(64);
  await db.pool.query('UPDATE ac_accounts SET resource_identity=$2 WHERE id=$1',[account,'synthetic-engineering:'+subject]);await new AccountHomes(db,homes,[repo]).initialize(principal,project,account);
  const capability=await authorizeNativeSyntheticFixture({contract:'native-synthetic-fixture-v1',projectId:project,contextId:context,provider:'synthetic-engineering',label,workerImage:image,toolsImage:image,providerNetworkId:network});
  const signing=generateKeyPairSync('ed25519'),supervisor=new NativeExecutionSupervisor(db,{id:'r4-correction-execution',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:homes,repository:repo,protectedRepositories:[],signingKeyPem:signing.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:network,accountSubjects:[{accountId:account,subjectDigest:subject}],workerEnv:['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','NODE_VERSION=22.23.3','YARN_VERSION=1.22.22'],toolsEnv:['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','NODE_VERSION=22.23.3','YARN_VERSION=1.22.22'],syntheticFixture:capability,resourceEnvelope:resources});
  await new ProviderEligibility(db).publish(principal,project,{accountId:account,expectedRevision:0,plan:'deterministic correction lab',adapterId:'r4-correction-execution',adapterVersion:supervisor.executorDigest,authenticationMode:'synthetic',executionMode:'synthetic',sourceURL:'https://example.invalid/r4-correction',status:'documented_supported',reason:'Disposable deterministic test',reviewedAt:new Date().toISOString(),validForSeconds:3600});
  const profiles=(await db.pool.query('SELECT model FROM ac_profiles WHERE account_id=$1',[account])).rows;for(const profile of profiles)await capacity.observeModelQuota(principal,account,profile.model,{status:'available',source:'synthetic://r4-correction',ttlSeconds:3600});
  const qaCode="const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');const box={module:{exports:{}}};vm.runInNewContext(fs.readFileSync('/work/src/sum.ts','utf8'),box);const actual=box.module.exports(2,3);console.log('T21_REPRO sum(2,3)='+actual+' expected=5');assert.equal(actual,5,'reproducible sum defect');";
  const qaContract=NativeQaContract.parse({schemaVersion:1,id:'r4-correction-qa',image,argv:['/usr/local/bin/node','-e',qaCode],environment:['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','NODE_VERSION=22.23.3','YARN_VERSION=1.22.22','HOME=/tmp'],timeoutMs:15000,memoryBytes:268435456,pids:64,nanoCpus:1000000000});
  const qualityRevision=await options.quality.publish(principal,project,1,{schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:false,requireJudge:false,verifierDigest:nativeReviewVerifierDigest,qaVerifierDigest:nativeQaContractDigest(qaContract)});
  await new Templates(db).publish(principal,context,0,{workflow:'engineering-native-v1',qualityRevision,targetRef:'refs/heads/protected',writePaths:['src'],execution:'plan'});
  const authority=await db.acquire(principal,context,randomUUID(),'r4-correction-manager',60);heartbeat=setInterval(()=>{void db.heartbeat(authority).catch(()=>{});},2000);
  const human=generateKeyPairSync('ed25519'),deviceId=randomUUID();await new Operators(db).enroll('synthetic-engineering-admin',principal,deviceId,human.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const environment={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.environments.configure' as const,payload:{projectId:project,expectedRevision:0,config:{sourceBranch:'refs/heads/main',environments:[{id:'lab',label:'Correction lab',targetRef:'refs/heads/protected',authorizedDirectories:['src'],destinations:[{id:'local',label:'Local',kind:'local_repository' as const}]}]}}};
  const installation=(await db.pool.query('SELECT id FROM ac_installation_identity')).rows[0].id,p={deviceId,expiresAt:Date.now()+120000};await new ProjectEnvironments(db,[{id:'lab',path:area}],join(area,'private')).configure(principal,environment,{...p,signature:sign(null,Buffer.from(operatorMessage(principal,environment,p,installation)),human.privateKey).toString('hex')});
  const nativeQa=new NativeQa(db,options.quality,repo,qaRoot,qaContract,options.verifierKey,undefined,undefined,resources),nativeImplementation=new NativeImplementation(db,repo,options.quality,[supervisor]),nativeVerification=new NativeVerification(db,options.quality,[supervisor],options.verifierKey);
  runtime=new CezarRuntime(db,repo,project,{...options,nativeQa,nativeVerification,allowedTargets:['refs/heads/protected']},undefined,undefined,{nativeExecutions:[supervisor],nativeImplementation});await runtime.start();
  const plan={schemaVersion:1 as const,contextId:context,objectiveRef:'message:sum',sourceMessageRef:'message:sum',parallelism:1,constraintRefs:[],tasks:[{id:'sum',objectiveRef:'message:sum',acceptanceRefs:['acceptance:sum-2-3-is-5'],inputRefs:[],outputRefs:['output:sum'],dependsOn:[],writePaths:['src/sum.ts'],qualityRevision,targetRef:'refs/heads/protected',maxCorrections:1}]};
  const proposal=await new ManagerPlans(db).publish(principal,authority,0,plan),intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:revision,action:'plan.start',payload:{workflow:'managed-synthetic-v1',messageRef:'message:sum',proposalRevision:proposal.revision,proposalDigest:proposal.digest,native:true}},authority,'api');
  const frozen=(await db.pool.query('SELECT recipe,recipe_digest FROM ac_managed_executions WHERE parent_intent_id=$1',[intent.id])).rows[0];assert.equal(frozen.recipe.schemaVersion,4);assert.equal(digest(frozen.recipe),frozen.recipe_digest);
  await runtime.dispatch(intent,authority);const deadline=Date.now()+120000;
  while(!['done','failed'].includes(runtime.store.getRun(intent.run_id)?.status??'')){if(Date.now()>deadline)throw Error('T21_GRAPH_TIMEOUT '+JSON.stringify(runtime.store.getRun(intent.run_id)?.error));await new Promise(resolve=>setTimeout(resolve,250));}
  assert.equal(runtime.store.getRun(intent.run_id)?.status,'done',JSON.stringify(runtime.store.getRun(intent.run_id)?.error));
  const decisions=(await db.pool.query('SELECT * FROM ac_managed_correction_decisions WHERE parent_intent_id=$1',[intent.id])).rows;assert.equal(decisions.length,1);const decision=decisions[0];assert.equal(decision.revision,1);assert.equal(decision.task_id,'sum');
  const artifacts=(await db.pool.query('SELECT a.* FROM ac_artifacts a JOIN ac_intents i ON i.id=a.intent_id WHERE i.parent_intent_id=$1 ORDER BY a.id',[intent.id])).rows;assert.equal(artifacts.length,2);
  const prior=artifacts.find(a=>a.id===decision.prior_artifact_id)!,corrected=artifacts.find(a=>a.intent_id===decision.next_intent_id)!;assert(prior&&corrected);assert.notEqual(prior.commit_id,corrected.commit_id);assert.notEqual(prior.tree_id,corrected.tree_id);assert.equal(prior.base_id,original);assert.equal(corrected.base_id,original);
  const evidence=(await db.pool.query('SELECT e.*,s.id stage_id,s.started_at,s.finished_at,q.created_at qa_created_at FROM ac_verification_evidence e JOIN ac_stage_operations s ON s.session_id=e.session_id LEFT JOIN ac_native_qa_jobs q ON q.id=s.id WHERE e.artifact_id=ANY($1::uuid[]) ORDER BY s.started_at',[artifacts.map(a=>a.id)])).rows;
  for(const artifact of [prior,corrected]){const receipts=evidence.filter(e=>e.artifact_id===artifact.id),review=receipts.find(e=>e.kind==='review'),qa=receipts.find(e=>e.kind==='qa');assert(review&&qa);assert.equal(review.status,'passed');assert(review.finished_at&&qa.qa_created_at);assert(review.finished_at<=qa.qa_created_at,'QA job is admitted only after initial/fresh review finishes');assert.equal(qa.status,artifact.id===prior.id?'failed':'passed');}
  const failed=evidence.find(e=>e.artifact_id===prior.id&&e.kind==='qa')!;assert.deepEqual(decision.failed_evidence_ids,[failed.id]);
  const fresh=evidence.filter(e=>e.artifact_id===corrected.id),old=evidence.filter(e=>e.artifact_id===prior.id);assert.equal(evidence.length,4);
  assert(fresh.every(e=>e.status==='passed'&&old.every(previous=>e.session_id!==previous.session_id&&e.grant_id!==previous.grant_id&&e.id!==previous.id)));
  const qaLogs=[];for(const qa of evidence.filter(e=>e.kind==='qa')){const bytes=await readFile(join(qaRoot,qa.stage_id,'qa-logs.bin'));assert.equal(createHash('sha256').update(bytes).digest('hex'),qa.receipt.logSha256);assertCompleteQaLogs(bytes);const payloads:Buffer[]=[];for(let offset=0;offset<bytes.length;){const size=bytes.readUInt32BE(offset+4);payloads.push(bytes.subarray(offset+8,offset+8+size));offset+=8+size;}const line=Buffer.concat(payloads).toString('utf8').split('\n').find(line=>line.startsWith('T21_REPRO '));assert.equal(line,qa.artifact_id===prior.id?'T21_REPRO sum(2,3)=-1 expected=5':'T21_REPRO sum(2,3)=5 expected=5');qaLogs.push({artifactId:qa.artifact_id,logSha256:qa.receipt.logSha256,reproduction:line});}
  const correctedJob=(await db.pool.query("SELECT id FROM ac_native_execution_jobs WHERE intent_id=$1 AND role='programmer'",[corrected.intent_id])).rows[0];
  const correctedRequest=JSON.parse(await readFile(join(spool,correctedJob.id,'request.json'),'utf8')),correction=JSON.parse(correctedRequest.task).correction;assert.equal(correction.decisionDigest,decision.decision_digest);assert.deepEqual(correction.failedEvidenceIds,[failed.id]);assert.equal(correction.priorArtifactId,prior.id);
  console.log('T21_QA_REPRODUCTIONS '+JSON.stringify(qaLogs));
  assert.equal(git('show',prior.commit_id+':src/sum.ts'),'module.exports = (a, b) => a - b;','rejected immutable source matches the physically reproduced defect');
  await assert.rejects(db.tx(c=>options.quality.assertReady(c,prior.id,authority)),/VERIFICATION_NOT_PASSED/);
  assert.equal(git('rev-parse','protected'),corrected.commit_id);const source=git('show','protected:src/sum.ts');assert(source.includes('a + b'));
  const jobs=(await db.pool.query('SELECT j.role,j.receipt,g.physical_receipt FROM ac_native_execution_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id JOIN ac_intents i ON i.id=j.intent_id WHERE i.parent_intent_id=$1',[intent.id])).rows;assert.equal(jobs.filter(j=>j.role==='programmer').length,2);assert.equal(jobs.filter(j=>j.role==='reviewer').length,2);assert(jobs.every(j=>j.physical_receipt?.synthetic===true&&j.receipt?.payload?.physicalDigest===digest(j.physical_receipt)));
  const qaJobs=(await db.pool.query('SELECT j.state,j.receipt FROM ac_native_qa_jobs j JOIN ac_intents i ON i.id=j.intent_id WHERE i.parent_intent_id=$1',[intent.id])).rows;assert.equal(qaJobs.length,2);assert(qaJobs.some(j=>j.state==='failed'&&j.receipt.exitCode===1));assert(qaJobs.some(j=>j.state==='completed'&&j.receipt.exitCode===0));
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_capacity_grants WHERE context_id=$1 AND state<>'released'",[context])).rows[0].n,0);
  console.log('T21_PHYSICAL_PROOF '+JSON.stringify({recipe:4,programmerAttempts:2,readonlyReviews:2,physicalQaAttempts:2,initialQa:'reproducible_defect',normalCorrection:true,failedEvidenceBound:true,oldArtifactBlocked:true,newCommit:true,newTree:true,newReviewAndQa:true,integration:'CAS_corrected_only',inference:'deterministic',officialAccounts:false}));
 }catch(error){primary=error;throw error;}
 finally{
  if(heartbeat)clearInterval(heartbeat);const errors:{phase:string;error:unknown}[]=[];
  const attempt=async(phase:string,action:()=>Promise<unknown>|unknown)=>{try{await action();}catch(error){errors.push({phase,error});}};
  await attempt('runtime',()=>runtime?.close());await attempt('graph',()=>cleanupGraphResources(db,image));
  if(resources)await attempt('resource-authority',()=>retireFlowResources(resources!,area));
  await attempt('mocks',()=>mock.restoreAll());await attempt('ledger',()=>db.close());await attempt('database',()=>database.close());await attempt('directory',()=>rm(area,{recursive:true,force:true}));
  if(errors.length&&!primary)throw new AggregateError(errors.map(item=>item.error),'T21_FIXTURE_CLEANUP_FAILED');
  if(errors.length&&primary)console.error('T21_CLEANUP_FAILED_AFTER_PRIMARY '+JSON.stringify(errors.map(item=>({phase:item.phase,error:item.error instanceof Error?item.error.name:'UNKNOWN'}))));
 }
});
