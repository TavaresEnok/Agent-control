import {simpleJobRetention} from '../src/personal-simple-retention.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID,randomBytes,generateKeyPairSync,createHash,sign} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm,readFile,symlink,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {Quality} from '../src/quality.ts';
import {GitArtifacts} from '../src/git.ts';
import {writeNativeSecretSnapshot} from '../src/native-execution-secret-snapshot.ts';
import {NativeExecutionSupervisor,NativeExecutionRequest} from '../src/native-execution-supervisor.ts';
import {NativeVerification,nativeReviewRequest,nativeReviewVerifierDigest} from '../src/native-verification.ts';
import {canonical,digest} from '../src/contracts.ts';
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
  await db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state,worker_id,tools_id,network_id,launch_digest)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,'programmer','running',$14,$15,$16,$17)`,[input.jobId,grant,intent.id,context,authority.epoch,input.sessionId,account,profile,digest({fixture:true}),supervisor.executorDigest,fingerprint,digest(input),base,workerId,toolsId,network,digest({launch:input.jobId})]);
  const root=join(spool,input.jobId),work=join(root,'work');await mkdir(root,{mode:0o700});await mkdir(join(root,'output'),{mode:0o700});await writeNativeSecretSnapshot(join(root,'redaction.enc'),input.jobId,keys.privateKey,['fixture-secret-snapshot']);await artifacts.snapshot(base,base,work);
  await writeFile(join(root,'request.json'),JSON.stringify(input),{mode:0o600});await writeFile(join(work,'src/example.ts'),'export const value = 2;\n');
  await writeFile(join(root,'output/execution-result.json'),JSON.stringify({schemaVersion:1,jobId:input.jobId,output:'synthetic turn result',normalizedTokensUsed:null,usageWindows:null,nativeSessionId:null,failureCode:null,exitCode:0}),{mode:0o600});
  const physical=(id:string)=>({Id:id,Image:image,Config:{Labels:{'agent-control.contract':'native-execution-v1','agent-control.job':input.jobId,'agent-control.launch':digest(input)}},State:{Status:'exited',Running:false,ExitCode:0,FinishedAt:new Date().toISOString()}});
  const w=physical(workerId),t=physical(toolsId);Object.defineProperty(supervisor,'docker',{value:{inspect:async(name:string)=>name===workerId||name.startsWith('ac-native-worker-')?w:t},configurable:true});
  const done=await supervisor.reconcile(principal,authority,input);assert.equal(done.state,'completed');assert('artifact' in done&&done.artifact);
  const retention={databaseUrl:fixture.url,dataDirectory:area,project:{id:project,label:'fixture',owner:principal,repo},projects:[],nativeBootstrap:{state:'active' as const,execution:{hostRoot:spool}}};
  assert.deepEqual(await simpleJobRetention(retention,true,async()=>[]),[]);
  assert.ok((await lstat(work)).isDirectory(),'pending import retains the only candidate');
  // Two registrations at once are serialized by the job's work lock: one import, one row, one private ref created by CAS.
  const [artifact,twin]=await Promise.all([supervisor.registerArtifact(principal,authority,input.jobId,quality),supervisor.registerArtifact(principal,authority,input.jobId,quality)]);
  assert.deepEqual(await simpleJobRetention(retention,false,async()=>[]),['Elegível '+work]);
  assert.equal(twin.id,artifact.id);assert.equal(artifact.risk,'high');assert.equal(artifact.base_id,base);
  assert.equal(git('rev-parse','refs/agent-control/retained/'+input.jobId),artifact.commit_id);
  // Whoever holds that lock (work retention, another registration) makes a registration wait, not fail.
  const holder=await db.pool.connect();
  try{
   await holder.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['agent-control:terminal-work:'+input.jobId]);
   let settled=false;const waiting=supervisor.registerArtifact(principal,authority,input.jobId,quality).finally(()=>{settled=true;});
   await new Promise(done=>setTimeout(done,500));
   assert.equal(settled,false,'registration waits for the job lock');
   await holder.query('SELECT pg_advisory_unlock_all()');
   assert.equal((await waiting).id,artifact.id);
  }finally{await holder.query('SELECT pg_advisory_unlock_all()').catch(()=>undefined);holder.release();}
  assert.equal(git('show',`${artifact.commit_id}:src/example.ts`),'export const value = 2;');assert.equal(git('rev-parse','refs/heads/protected'),base);
  await assert.rejects(db.tx(c=>quality.assertReady(c,artifact.id,authority)),/QA_MISSING/);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_native_artifact_finalizations')).rows[0].n,1);
  await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);
  const successor=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  assert.equal((await supervisor.registerArtifact(principal,successor,input.jobId,quality)).id,artifact.id);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_artifacts')).rows[0].n,1);
  await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);
  const reviewAuthority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  Object.assign(successor,reviewAuthority);
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
  // A stateful fake daemon: stopped containers keep one finish time, return logs and disappear once removed, as retirement requires.
  const fakeDocker=(job:string,launch:string,worker:string,tools:string)=>{const finished=new Date().toISOString(),gone=new Set<string>();
   const item=(id:string)=>gone.has(id)?null:{Id:id,Image:image,Config:{Labels:{'agent-control.contract':'native-execution-v1','agent-control.job':job,'agent-control.launch':launch}},State:{Status:'exited',Running:false,ExitCode:0,FinishedAt:finished}};
   return {inspect:async(name:string)=>name===worker||name==='ac-native-worker-'+job?item(worker):name===tools||name==='ac-native-tools-'+job?item(tools):null,
    logs:async()=>Buffer.from('fixture log\n'),remove:async(id:string)=>{gone.add(id);},inspectPrivateNetwork:async()=>null,removePrivateNetwork:async()=>{}};};
  Object.defineProperty(supervisor,'docker',{value:fakeDocker(reviewId,digest(request),reviewWorker,reviewTools),configurable:true});
  const verifier=new NativeVerification(db,quality,[supervisor],verifierKey),review=(await verifier.record(principal,successor,reviewId))!;
  assert.equal(review.status,'passed');assert.notEqual(review.sessionId,artifact.implementation_session_id);assert.equal(review.kind,'review');
  assert.equal((await verifier.record(principal,successor,reviewId))!.id,review.id);
  await assert.rejects(db.tx(c=>quality.assertReady(c,artifact.id,successor)),/QA_MISSING/);assert.equal(git('rev-parse','refs/heads/protected'),base);
  // A reviewer whose answer is not a readable verdict closes its stage without evidence and is retired, so reconciliation stops retrying it.
  const slipGrant=randomUUID(),slipId=randomUUID(),slipSession=randomUUID(),slipAttempt=randomUUID();
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,'reviewer',$8,1,1,$9,false,'running')`,[slipGrant,slipAttempt,intent.id,context,successor.epoch,account,reviewProfile,project,digest({fixture:'slip'})]);
  await db.pool.query("INSERT INTO ac_stage_operations(id,intent_id,node_id,session_id,attempt_id,grant_id,manager_epoch,state) VALUES($1,$2,'review',$3,$4,$5,$6,'uncertain')",[slipId,intent.id,slipSession,slipAttempt,slipGrant,successor.epoch]);
  const slipRequest=nativeReviewRequest({id:slipId,session_id:slipSession},intent.id,slipGrant,artifact,'review'),slipWorker='5'.repeat(64),slipTools='6'.repeat(64);
  await db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state,worker_id,tools_id,network_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,'reviewer','running',$14,$15,$16)`,[slipId,slipGrant,intent.id,context,successor.epoch,slipSession,account,reviewProfile,digest({fixture:true}),supervisor.executorDigest,fingerprint,digest(slipRequest),artifact.commit_id,slipWorker,slipTools,network]);
  const slipRoot=join(spool,slipId);await mkdir(slipRoot,{mode:0o700});await mkdir(join(slipRoot,'output'),{mode:0o700});await writeFile(join(slipRoot,'request.json'),JSON.stringify(slipRequest),{mode:0o600});
  const slipped=JSON.stringify({...verdict}).replace('"base":"'+artifact.base_id+'"','"base":"'+artifact.base_id+'"]');
  await writeFile(join(slipRoot,'output/execution-result.json'),JSON.stringify({schemaVersion:1,jobId:slipId,output:slipped,normalizedTokensUsed:null,usageWindows:null,nativeSessionId:null,failureCode:null,exitCode:0}),{mode:0o600});
  Object.defineProperty(supervisor,'docker',{value:fakeDocker(slipId,digest(slipRequest),slipWorker,slipTools),configurable:true});
  assert.equal(await verifier.record(principal,successor,slipId),null);
  const slipStage=(await db.pool.query('SELECT state,receipt FROM ac_stage_operations WHERE id=$1',[slipId])).rows[0];
  assert.equal(slipStage.state,'completed');assert.equal(slipStage.receipt.invalidVerdict,true);assert.equal(slipStage.receipt.verification,undefined);
  assert.equal((await db.pool.query("SELECT state FROM ac_native_terminal_retirements WHERE job_id=$1",[slipId])).rows[0]?.state,'removed');
  assert.equal(await verifier.record(principal,successor,slipId),null);
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_verification_evidence WHERE session_id=$1",[slipSession])).rows[0].n,0);
  // Collection after concurrent registrations: the programmer's checkout is freed only with the physical proof, and only once its
  // artifact is pinned. A registration racing with the collection either runs first or replays from the repository afterwards.
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  const job=(await db.pool.query('SELECT * FROM ac_native_execution_jobs WHERE id=$1',[input.jobId])).rows[0];
  assert.equal(job.state,'completed');
  const binding={schemaVersion:1,jobId:input.jobId,contextId:context,intentId:intent.id,grantId:grant,sessionId:input.sessionId,epoch:Number(job.manager_epoch),role:'programmer',inputDigest:digest(input),
   terminalDigest:digest(job.receipt),workerId,toolsId,networkId:network,workerLogSha256:'7'.repeat(64),toolsLogSha256:'8'.repeat(64)};
  const retirementProof={payload:binding,signature:sign(null,Buffer.from('agent-control:native-terminal-retirement:v1\n'+canonical(binding)),keys.privateKey).toString('hex')};
  const scope={contextId:context,projectId:project,repository:repo};
  assert.equal((await supervisor.retireTerminalWork(principal,input.jobId,true,scope) as {reason?:string}).reason,'retirement','no physical proof yet: kept');
  await db.pool.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[input.jobId,binding]);
  await db.pool.query("UPDATE ac_native_terminal_retirements SET state='removed',proof=$2 WHERE job_id=$1",[input.jobId,retirementProof]);
  assert.equal((await supervisor.retireTerminalWork(principal,input.jobId,false,scope)).state,'eligible');
  await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);
  const collector=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  const [first,second,collected]=await Promise.all([supervisor.registerArtifact(principal,collector,input.jobId,quality),supervisor.registerArtifact(principal,collector,input.jobId,quality),
   supervisor.retireTerminalWork(principal,input.jobId,true,scope)]);
  assert.equal(first.id,artifact.id);assert.equal(second.id,artifact.id);
  assert.ok(collected.state==='released'||(collected.state==='refused'&&collected.reason==='busy'),JSON.stringify(collected));
  if(collected.state!=='released')assert.equal((await supervisor.retireTerminalWork(principal,input.jobId,true,scope)).state,'released');
  assert.equal(await lstat(work).then(()=>true,()=>false),false,'the checkout is gone');
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_artifacts')).rows[0].n,1);
  // After the retirement the repository alone keeps the artifact: the private ref survives garbage collection and replay still works.
  git('reflog','expire','--expire=now','--all');git('gc','-q','--prune=now');
  assert.equal(git('rev-parse','refs/agent-control/retained/'+input.jobId),artifact.commit_id);
  assert.equal(git('show',`${artifact.commit_id}:src/example.ts`),'export const value = 2;');
  assert.equal((await supervisor.registerArtifact(principal,collector,input.jobId,quality)).id,artifact.id);
  assert.equal((await supervisor.retireTerminalWork(principal,input.jobId,true,scope)).state,'absent');
  // A separate direct helper fixture proves refusal of writes outside scope.
  const badId=randomUUID(),bad=join(spool,badId);await mkdir(bad,{mode:0o700});await artifacts.snapshot(base,base,join(bad,'work'));await writeFile(join(bad,'work/outside.txt'),'unauthorized');
  execFileSync('/usr/bin/ruby',[new URL('../services/agent-control-git/native_finalize.rb',import.meta.url).pathname],{input:JSON.stringify({jobId:badId,inputDigest:'a'.repeat(64),scopeDigest:digest(['src/example.ts']),base,writePaths:['src/example.ts'],work:join(bad,'work'),output:join(bad,'finalizer-result.json')}),stdio:['pipe','ignore','pipe']});
  assert.equal(JSON.parse(await readFile(join(bad,'finalizer-result.json'),'utf8')).failureCode,'INVALID_SCOPE');
 }finally{await db.close();await fixture.close();await rm(area,{recursive:true,force:true});}
});
