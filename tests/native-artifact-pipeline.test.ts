import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID,randomBytes,generateKeyPairSync,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm,readFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {Quality} from '../src/quality.ts';
import {GitArtifacts} from '../src/git.ts';
import {NativeExecutionSupervisor,NativeExecutionRequest} from '../src/native-execution-supervisor.ts';
import {NativeVerification,nativeReviewRequest,nativeReviewVerifierDigest} from '../src/native-verification.ts';
import {digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('stopped native fixture finalizes exact scoped Git code, registers high-risk artifact and does not approve it',async()=>{
 const database=process.env.AC_TEST_DATABASE_URL;if(!database)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(database,'nativeartifact'),db=new Ledger(fixture.url),area=await mkdtemp(join(tmpdir(),'ac-native-artifact-'));
 try{
  await db.migrate();const project=randomUUID(),principal='artifact-'+randomUUID(),account=randomUUID(),profile=randomUUID();
  const repo=join(area,'repo'),spool=join(area,'spool'),accounts=join(area,'accounts');for(const p of [spool,accounts])await mkdir(p,{mode:0o700});
  execFileSync('git',['init',repo],{stdio:'ignore'});const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  git('config','user.name','Fixture');git('config','user.email','fixture@invalid');await mkdir(join(repo,'src'));await writeFile(join(repo,'src','example.ts'),'export const value = 1;\n');git('add','.');git('commit','-m','base');const base=git('rev-parse','HEAD');git('update-ref','refs/heads/protected',base);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'isolated artifact']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
  await new Capacity(db).addAccount(principal,project,{id:account,provider:'codex',label:'dormant fixture',resourceIdentity:'codex:'+('a'.repeat(64)),mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/fixture',maxConcurrent:1});
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'fixture-model','medium','programmer',false)",[profile,account]);
  const context=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),principal]);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
  const artifacts=new GitArtifacts(repo),verifierKey=randomBytes(32),quality=new Quality(db,verifierKey,artifacts);
  await quality.publish(principal,project,0,{schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:true,verifierDigest:nativeReviewVerifierDigest});
  await db.pool.query('INSERT INTO ac_execution_contracts VALUES($1,$2,1,$3,$4)',[intent.id,project,'refs/heads/protected',digest({qualityRevision:1,targetRef:'refs/heads/protected'})]);
  const grant=randomUUID(),keys=generateKeyPairSync('ed25519'),image='sha256:'+'d'.repeat(64);
  const supervisor=new NativeExecutionSupervisor(db,{id:'codex-native-execution',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:'e'.repeat(64),socketPath:'/no-operational-socket',accountSubjects:[{accountId:account,subjectDigest:'a'.repeat(64)}],workerEnv:[],toolsEnv:[]});
  const input=NativeExecutionRequest.parse({jobId:intent.operation_id,intentId:intent.id,grantId:grant,sessionId:randomUUID(),base,role:'programmer',task:'synthetic code fixture',writePaths:['src/example.ts']});
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,'programmer',$8,1,1,$9,false,'running')`,[grant,randomUUID(),intent.id,context,authority.epoch,account,profile,project,digest(input)]);
  await db.pool.query("UPDATE ac_operations SET state='uncertain',grant_id=$2,native_session_id=$3 WHERE id=$1",[input.jobId,grant,input.sessionId]);
  const frozen={base,writePaths:input.writePaths};await db.pool.query('INSERT INTO ac_managed_delivery_inputs VALUES($1,$2,$3,$4)',[intent.id,base,frozen,digest(frozen)]);
  const workerId='f'.repeat(64),toolsId='1'.repeat(64),network='2'.repeat(64),fingerprint=createHash('sha256').update(keys.publicKey.export({format:'der',type:'spki'})).digest('hex');
  await db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state,worker_id,tools_id,network_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,'programmer','running',$14,$15,$16)`,[input.jobId,grant,intent.id,context,authority.epoch,input.sessionId,account,profile,digest({fixture:true}),supervisor.executorDigest,fingerprint,digest(input),base,workerId,toolsId,network]);
  const root=join(spool,input.jobId),work=join(root,'work');await mkdir(root,{mode:0o700});await mkdir(join(root,'output'),{mode:0o700});await artifacts.snapshot(base,base,work);
  await writeFile(join(root,'request.json'),JSON.stringify(input),{mode:0o600});await writeFile(join(work,'src/example.ts'),'export const value = 2;\n');
  await writeFile(join(root,'output/execution-result.json'),JSON.stringify({schemaVersion:1,jobId:input.jobId,output:'synthetic turn result',normalizedTokensUsed:null,usageWindows:null,nativeSessionId:null,failureCode:null,exitCode:0}),{mode:0o600});
  const physical=(id:string)=>({Id:id,Image:image,Config:{Labels:{'agent-control.contract':'native-execution-v1','agent-control.job':input.jobId,'agent-control.launch':digest(input)}},State:{Status:'exited',Running:false,ExitCode:0,FinishedAt:new Date().toISOString()}});
  const w=physical(workerId),t=physical(toolsId);Object.defineProperty(supervisor,'docker',{value:{inspect:async(name:string)=>name===workerId||name.startsWith('ac-native-worker-')?w:t},configurable:true});
  const done=await supervisor.reconcile(principal,authority,input);assert.equal(done.state,'completed');assert('artifact' in done&&done.artifact);
  const artifact=await supervisor.registerArtifact(principal,authority,input.jobId,quality);assert.equal(artifact.risk,'high');assert.equal(artifact.base_id,base);
  assert.equal(git('show',`${artifact.commit_id}:src/example.ts`),'export const value = 2;');assert.equal(git('rev-parse','refs/heads/protected'),base);
  await assert.rejects(db.tx(c=>quality.assertReady(c,artifact.id,authority)),/QA_MISSING/);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_native_artifact_finalizations')).rows[0].n,1);
  await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);
  const successor=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  assert.equal((await supervisor.registerArtifact(principal,successor,input.jobId,quality)).id,artifact.id);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_artifacts')).rows[0].n,1);
  const reviewProfile=randomUUID(),reviewGrant=randomUUID(),reviewId=randomUUID(),reviewSession=randomUUID(),reviewAttempt=randomUUID();
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'fixture-model','medium','reviewer',false)",[reviewProfile,account]);
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,'reviewer',$8,1,1,$9,false,'running')`,[reviewGrant,reviewAttempt,intent.id,context,successor.epoch,account,reviewProfile,project,digest({fixture:'review'})]);
  await db.pool.query("INSERT INTO ac_stage_operations(id,intent_id,node_id,session_id,attempt_id,grant_id,manager_epoch,state) VALUES($1,$2,'review',$3,$4,$5,$6,'uncertain')",[reviewId,intent.id,reviewSession,reviewAttempt,reviewGrant,successor.epoch]);
  const request=nativeReviewRequest({id:reviewId,session_id:reviewSession},intent.id,reviewGrant,artifact,'review');
  const reviewWorker='3'.repeat(64),reviewTools='4'.repeat(64);
  await db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state,worker_id,tools_id,network_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,'reviewer','running',$14,$15,$16)`,[reviewId,reviewGrant,intent.id,context,successor.epoch,reviewSession,account,reviewProfile,digest({fixture:true}),supervisor.executorDigest,fingerprint,digest(request),artifact.commit_id,reviewWorker,reviewTools,network]);
  const reviewRoot=join(spool,reviewId);await mkdir(reviewRoot,{mode:0o700});await mkdir(join(reviewRoot,'output'),{mode:0o700});await writeFile(join(reviewRoot,'request.json'),JSON.stringify(request),{mode:0o600});
  const verdict={schemaVersion:1,kind:'review',artifactId:artifact.id,policyRevision:artifact.policy_revision,commit:artifact.commit_id,tree:artifact.tree_id,base:artifact.base_id,verdict:'pass',findings:[]};
  await writeFile(join(reviewRoot,'output/execution-result.json'),JSON.stringify({schemaVersion:1,jobId:reviewId,output:JSON.stringify(verdict),normalizedTokensUsed:null,usageWindows:null,nativeSessionId:null,failureCode:null,exitCode:0}),{mode:0o600});
  const reviewPhysical=(id:string)=>({Id:id,Image:image,Config:{Labels:{'agent-control.contract':'native-execution-v1','agent-control.job':reviewId,'agent-control.launch':digest(request)}},State:{Status:'exited',Running:false,ExitCode:0,FinishedAt:new Date().toISOString()}});
  Object.defineProperty(supervisor,'docker',{value:{inspect:async(name:string)=>name===reviewWorker||name.startsWith('ac-native-worker-')?reviewPhysical(reviewWorker):reviewPhysical(reviewTools)},configurable:true});
  const verifier=new NativeVerification(db,quality,[supervisor],verifierKey),review=await verifier.record(principal,successor,reviewId);
  assert.equal(review.status,'passed');assert.notEqual(review.sessionId,artifact.implementation_session_id);assert.equal(review.kind,'review');
  assert.equal((await verifier.record(principal,successor,reviewId)).id,review.id);
  await assert.rejects(db.tx(c=>quality.assertReady(c,artifact.id,successor)),/QA_MISSING/);assert.equal(git('rev-parse','refs/heads/protected'),base);
  // A separate direct helper fixture proves refusal of writes outside scope.
  const badId=randomUUID(),bad=join(spool,badId);await mkdir(bad,{mode:0o700});await artifacts.snapshot(base,base,join(bad,'work'));await writeFile(join(bad,'work/outside.txt'),'unauthorized');
  execFileSync('/usr/bin/ruby',[new URL('../services/agent-control-git/native_finalize.rb',import.meta.url).pathname],{input:JSON.stringify({jobId:badId,inputDigest:'a'.repeat(64),scopeDigest:digest(['src/example.ts']),base,writePaths:['src/example.ts'],work:join(bad,'work'),output:join(bad,'finalizer-result.json')}),stdio:['pipe','ignore','pipe']});
  assert.equal(JSON.parse(await readFile(join(bad,'finalizer-result.json'),'utf8')).failureCode,'INVALID_SCOPE');
 }finally{await db.close();await fixture.close();await rm(area,{recursive:true,force:true});}
});
