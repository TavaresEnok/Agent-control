import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign,verify} from 'node:crypto';
import {execFile} from 'node:child_process';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {chmod,mkdir,mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {NativeExecutionRequest,NativeExecutionSupervisor,ModuleExamRecoveryPreserved} from '../src/native-execution-supervisor.ts';
import {runPersonalMaintenance} from '../src/personal-maintenance.ts';
import {releaseDeadPersonalGrants} from '../src/personal-runtime.ts';
import {maintenanceCliFailureText} from '../src/personal-maintenance-cli.ts';
import {nativePlanningExecutorDigest} from '../src/native-planning-contract.ts';
import {nativeExecutionExecutorDigest} from '../src/native-execution-contract.ts';
import {NativeQaContract,nativeQaContractDigest} from '../src/native-qa-contract.ts';
import {nativeReviewVerifierDigest} from '../src/native-review-contract.ts';
import {Authority,Refusal,canonical,digest} from '../src/contracts.ts';
import {grantLaunchLockKey} from '../src/native-execution-shared.ts';
import {loadInstallation} from '../src/installation.ts';
import {recoverPersonalOrphanedExams} from '../src/personal-orphaned-exams.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const ZERO='0001-01-01T00:00:00Z';
const RemovalDomain='agent-control:native-module-exam-tools-removed:v1\n';
const companion=['node','-e','setInterval(() => {}, 60_000)'];
type Body=Record<string,any>;
type Fake={containers:Map<string,Body>;networks:Map<string,Body>;mutations:string[];forbidden:string[];unavailable:boolean;failNetworkDelete:number;failContainerDelete:boolean;beforeNetworkDelete?:(id:string)=>Promise<void>};

/** A Docker that only answers inspects and DELETE of a container or network. Anything that could create or start is recorded as forbidden. */
async function fakeDocker(socket:string,state:Fake){
 const server=createServer((req:IncomingMessage,res:ServerResponse)=>{
  const url=req.url??'',method=req.method??'GET';
  res.setHeader('content-type','application/json');
  if(state.unavailable){res.statusCode=503;res.end();return;}
  const container=(ref:string)=>state.containers.get(ref)??[...state.containers.values()].find(item=>item.Id===ref);
  if(method==='GET'&&url.startsWith('/v1.44/containers/json?')){
   const params=new URL(url,'http://localhost').searchParams;
   const {label:[filter]}=JSON.parse(params.get('filters')!);
   const [name,value]=filter.split('=');
   const matching=[...state.containers.values()].filter(item=>item.Config.Labels[name]===value&&(params.get('all')==='1'||item.State.Running));
   res.end(JSON.stringify(matching.map(item=>({Id:item.Id}))));
   return;
  }
  if(method==='GET'&&url.startsWith('/v1.44/containers/')&&url.endsWith('/json')){
   const found=container(decodeURIComponent(url.slice('/v1.44/containers/'.length,-'/json'.length)));
   res.statusCode=found?200:404;res.end(JSON.stringify(found??{message:'no such container'}));return;
  }
  if(method==='GET'&&url.startsWith('/v1.44/networks/')){
   const ref=decodeURIComponent(url.slice('/v1.44/networks/'.length));
   const found=state.networks.get(ref)??[...state.networks.values()].find(item=>item.Name===ref);
   res.statusCode=found?200:404;res.end(JSON.stringify(found??{message:'no such network'}));return;
  }
  if(method==='DELETE'&&url.startsWith('/v1.44/containers/')){
   if(state.failContainerDelete){res.statusCode=500;res.end(JSON.stringify({message:'boom'}));return;}
   const id=url.slice('/v1.44/containers/'.length);state.mutations.push('DELETE container '+id);
   for(const [name,item] of [...state.containers])if(item.Id===id)state.containers.delete(name);
   res.statusCode=204;res.end();return;
  }
  if(method==='DELETE'&&url.startsWith('/v1.44/networks/')){
   if(state.failNetworkDelete>0){state.failNetworkDelete--;res.statusCode=500;res.end(JSON.stringify({message:'boom'}));return;}
   const id=url.slice('/v1.44/networks/'.length);
   void (state.beforeNetworkDelete?.(id)??Promise.resolve()).then(()=>{state.mutations.push('DELETE network '+id);state.networks.delete(id);res.statusCode=204;res.end();},
    (error:unknown)=>{res.statusCode=500;res.end(JSON.stringify({message:String(error)}));});
   return;
  }
  state.forbidden.push(method+' '+url);res.statusCode=500;res.end(JSON.stringify({message:'forbidden'}));
 });
 await new Promise<void>(resolve=>server.listen(socket,resolve));
 return ()=>new Promise<void>(resolve=>server.close(()=>resolve()));
}

test('passive module-exam recovery retires only a proven never-started attempt, preserves the grant otherwise, and replays safely',{skip:!process.env.AC_TEST_DATABASE_URL},async t=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'modexamrec');
 const db=new Ledger(fixture.url),area=await mkdtemp(join(tmpdir(),'ac-modexam-rec-'));
 const closers:(()=>Promise<void>)[]=[];
 try{
  await db.migrate();
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  const capacity=new Capacity(db);
  const project=randomUUID(),owner='app-'+randomUUID(),gateway='gateway:owner-'+randomUUID(),account=randomUUID(),profile=randomUUID();
  const repo=join(area,'repo'),dataDir=join(area,'data'),spool=join(dataDir,'exec-host'),accounts=join(dataDir,'accounts');
  const planHost=join(dataDir,'plan-host'),planAccounts=join(dataDir,'plan-accounts'),keysDir=join(dataDir,'keys'),vaultDir=join(dataDir,'vault');
  for(const dir of [repo,dataDir,spool,accounts,planHost,planAccounts,keysDir,vaultDir]){await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700);}
  const commit='e'.repeat(40);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Passive exam recovery fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner'),($1,$3,'owner'),($1,$4,'operator')",[project,owner,gateway,'operator-'+randomUUID()]);
  await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
  const subject=digest({provider:'claude',subject:'passive-exam-fixture'});
  await capacity.addAccount(owner,project,{id:account,provider:'claude',label:'passive exam fixture',resourceIdentity:'claude:'+subject,mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/fixture',maxConcurrent:2});
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'claude-sonnet-5-5','medium','specialist',true)",[profile,account]);
  await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),owner]);
  const examContext=await db.createContext(owner,project,randomUUID());
  await db.pool.query("INSERT INTO ac_exam_contexts(project_id,module,context_id) VALUES($1,'qa',$2)",[project,examContext]);
  const mainContext=await db.createContext(gateway,project,randomUUID());
  const gatewayAuthority=await db.acquire(gateway,mainContext,randomUUID(),'gateway-manager',60);
  await db.pool.query("INSERT INTO ac_exam_contexts(project_id,module,context_id) VALUES($1,'verify',$2)",[project,mainContext]);

  const keys=generateKeyPairSync('ed25519'),otherKeys=generateKeyPairSync('ed25519');
  const pem=keys.privateKey.export({format:'pem',type:'pkcs8'}).toString();
  const fingerprint=createHash('sha256').update(keys.publicKey.export({format:'der',type:'spki'})).digest('hex');
  const image='sha256:'+'0'.repeat(64),providerNetwork='d'.repeat(64);
  const socket=join(area,'docker.sock');
  const docker:Fake={containers:new Map(),networks:new Map(),mutations:[],forbidden:[],unavailable:false,failNetworkDelete:0,failContainerDelete:false};
  closers.push(await fakeDocker(socket,docker));
  const config=(signingKeyPem=pem)=>({id:'codex-native-execution',provider:'claude' as const,workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem,providerNetworkId:providerNetwork,socketPath:socket,accountSubjects:[{accountId:account,subjectDigest:subject}],workerEnv:[],toolsEnv:[]});
  const supervisor=new NativeExecutionSupervisor(db,config(),{assertAdmission:async()=>{}});
  const lease=()=>db.acquire(owner,examContext,randomUUID(),'personal-maintenance',60);
  const scope={projectId:project,repository:repo};
  const user=`${process.getuid?.()}:${process.getgid?.()}`;

  type Plant={workflow?:string;module?:string;intentState?:string;runStatus?:string;grantState?:string;state?:string;workerId?:string;launchDigest?:string;networkId?:string|null;
   messageModule?:string;noRun?:boolean;bindManagerEpoch?:boolean;
   tools?:'created'|'running'|'absent';noNetwork?:boolean;noRequest?:boolean;plainRequest?:boolean;context?:string;siblings?:number};
  const insertIntent=async(contextId:string,workflow:string,module:string,state:string,runStatus:string,messageModule=module,noRun=false,epoch=1)=>{
   const intentId=randomUUID();
   const command={schemaVersion:1 as const,intentId,deliveryAttemptId:randomUUID(),contextId,policyRevision:0,action:'plan.start' as const,payload:{workflow,messageRef:`${messageModule}:${project}:${commit}`,projectId:project,commit}};
   await db.pool.query(`INSERT INTO ac_intents (id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,0)`,
    [intentId,contextId,owner,digest(command),JSON.stringify(command),randomUUID(),randomUUID(),epoch]);
   if(!noRun)await db.pool.query(`INSERT INTO ac_verify_runs (id,project_id,context_id,intent_id,principal_id,commit_id,status,report_dir,module) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,
    [randomUUID(),project,contextId,intentId,owner,commit,runStatus,module]);
   await db.pool.query('UPDATE ac_intents SET state=$2 WHERE id=$1',[intentId,state]);
   return intentId;
  };
  const insertGrant=async(intentId:string,contextId:string,epoch:number,state:string,receipt:unknown=null)=>{
   const id=randomUUID();
   await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state,physical_receipt)
    VALUES($1,$2,$3,$4,$5,$6,$7,'specialist',$8,1,1,$9,false,$10,$11)`,[id,randomUUID(),intentId,contextId,epoch,account,profile,project,digest({grant:id}),state,receipt]);
   return id;
  };
  const profileDigest=digest({accountId:account,profileId:profile,model:'claude-sonnet-5-5',effort:'medium',role:'specialist'});
  const insertJob=async(o:{jobId:string;intentId:string;grantId:string;contextId:string;sessionId:string;inputDigest:string;state:string;epoch:number;networkId?:string|null;workerId?:string|null;launchDigest?:string|null;receipt?:unknown}) =>
   db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state,network_id,worker_id,launch_digest,receipt)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,'specialist',$14,$15,$16,$17,$18)`,
    [o.jobId,o.grantId,o.intentId,o.contextId,o.epoch,o.sessionId,account,profile,profileDigest,supervisor.executorDigest,fingerprint,o.inputDigest,commit,o.state,o.networkId??null,o.workerId??null,o.launchDigest??null,o.receipt??null]);
  const epochOf=async(contextId:string)=>Number((await db.pool.query('SELECT epoch FROM ac_managers WHERE context_id=$1',[contextId])).rows[0]?.epoch??1);
  const ids={n:0};
  const hex=()=>{ids.n++;return createHash('sha256').update('fixture-'+ids.n).digest('hex');};

  /** The aggregated real scenario: the intent is finished, other attempts are terminal, and this one is uncertain with only a Created tools container. */
  const plant=async(o:Plant={})=>{
   const contextId=o.context??examContext,epoch=await epochOf(contextId);
   const intentId=await insertIntent(contextId,o.workflow??'security-verify-readonly-v1',o.module??'qa',o.intentState??'failed',o.runStatus??'failed',
    o.messageModule,o.noRun,o.bindManagerEpoch?epoch:1);
   for(let i=0;i<(o.siblings??3);i++){
    const sibling=randomUUID(),siblingGrant=await insertGrant(intentId,contextId,Number(epoch),'released',{executionStarted:true,jobId:sibling});
    await insertJob({jobId:sibling,intentId,grantId:siblingGrant,contextId,sessionId:randomUUID(),inputDigest:digest({sibling}),state:'failed',epoch:Number(epoch),networkId:hex(),workerId:hex(),receipt:{terminal:true}});
   }
   const jobId=randomUUID(),sessionId=randomUUID(),grantId=await insertGrant(intentId,contextId,Number(epoch),o.grantState??'uncertain');
   const request=NativeExecutionRequest.parse({jobId,intentId,grantId,sessionId,base:commit,role:'specialist',task:'passive functional exam',writePaths:[],artifactId:randomUUID(),outputSchema:{type:'object'},
    ...(o.plainRequest?{}:{moduleExam:{accountId:account,profileId:profile,model:'claude-sonnet-5-5'}}),timeoutMs:120000});
   const inputDigest=digest(request),networkId=o.networkId===undefined?hex():o.networkId;
   await insertJob({jobId,intentId,grantId,contextId,sessionId,inputDigest,state:o.state??'uncertain',epoch:Number(epoch),networkId,workerId:o.workerId,launchDigest:o.launchDigest});
   const root=join(spool,jobId);
   for(const dir of [root,join(root,'input'),join(root,'output')]){await mkdir(dir,{mode:0o700});await chmod(dir,0o700);}
   if(!o.noRequest){await writeFile(join(root,'request.json'),JSON.stringify(request),{mode:0o600});await chmod(join(root,'request.json'),0o600);}
   const labels={'agent-control.contract':'native-execution-v1','agent-control.job':jobId,'agent-control.launch':inputDigest};
   const toolsId=hex(),toolsName='ac-native-tools-'+jobId;
   const body:Body={Id:toolsId,Image:image,Config:{User:user,Labels:labels,Entrypoint:companion,Cmd:[],Env:[],WorkingDir:'/'},
    State:{Status:'created',Running:false,ExitCode:0,FinishedAt:ZERO,StartedAt:ZERO,Pid:0},
    HostConfig:{NetworkMode:networkId,ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:96,Memory:512*1024*1024,NanoCpus:1e9},Mounts:[]};
   if(o.tools==='running')body.State={Status:'running',Running:true,ExitCode:0,FinishedAt:ZERO,StartedAt:'2026-11-20T00:00:00Z',Pid:4242};
   if(o.tools!=='absent')docker.containers.set(toolsName,body);
   if(networkId&&!o.noNetwork)docker.networks.set(networkId,{Id:networkId,Name:'ac-native-exec-'+jobId,Internal:true,Labels:labels,Containers:{}});
   return {jobId,intentId,grantId,contextId,sessionId,request,inputDigest,networkId,toolsId,toolsName,root,labels,body};
  };
  const snapshot=async(jobId:string,grantId:string,intentId:string)=>{
   const job=(await db.pool.query('SELECT state,worker_id,tools_id,network_id,launch_digest,receipt FROM ac_native_execution_jobs WHERE id=$1',[jobId])).rows[0];
   const grant=(await db.pool.query('SELECT state,physical_receipt FROM ac_capacity_grants WHERE id=$1',[grantId])).rows[0];
   const intent=(await db.pool.query('SELECT state FROM ac_intents WHERE id=$1',[intentId])).rows[0];
   const run=(await db.pool.query('SELECT status,finished_at FROM ac_verify_runs WHERE intent_id=$1',[intentId])).rows[0];
   const journal=(await db.pool.query('SELECT state FROM ac_native_terminal_retirements WHERE job_id=$1',[jobId])).rows[0];
   return {job,grant,intent,run,journal};
  };
  const reset=()=>{docker.beforeNetworkDelete=undefined;docker.mutations.length=0;docker.forbidden.length=0;docker.unavailable=false;docker.failNetworkDelete=0;docker.failContainerDelete=false;};
  /** Evidence is insufficient: nothing physical or durable changes and the reason comes back. */
  const preserved=async(p:Awaited<ReturnType<typeof plant>>,reason:string,run=()=>supervisor.recoverNeverStartedModuleExam(owner,authority,p.jobId,scope))=>{
   const before=await snapshot(p.jobId,p.grantId,p.intentId),mutations=docker.mutations.length;
   const out=await run();
   assert.equal(out.state,'preserved');assert.equal(out.reason,reason);assert.equal(out.grant,'preserved');assert.equal(out.replayed,false);assert.deepEqual(out.removed,[]);
   assert.deepEqual(await snapshot(p.jobId,p.grantId,p.intentId),before);
   assert.equal(docker.mutations.length,mutations);assert.deepEqual(docker.forbidden,[]);
   assert.notEqual(before.grant.state,'released');assert.notEqual(before.job.state,'failed');
  };

  let authority:Authority=await lease();

  // ── The generic recover keeps the grant for this exact scenario and is not relaxed.
  const generic=await plant();
  const genericOut=await supervisor.recover(owner,authority,generic.jobId);
  assert.equal(genericOut.state,'uncertain');assert.equal(genericOut.interval,'before_terminal_evidence');assert.equal(genericOut.grant,'preserved');
  assert.equal((await snapshot(generic.jobId,generic.grantId,generic.intentId)).grant.state,'uncertain');
  assert.deepEqual(docker.mutations,[]);assert.deepEqual(docker.forbidden,[]);
  // The design withdrawal is untouched: it still refuses this attempt.
  await assert.rejects(supervisor.recoverUnstartedExam(owner,authority,generic.jobId,{...scope,explicitDesignWithdrawal:true}),(error:unknown)=>error instanceof Refusal);
  assert.deepEqual(docker.mutations,[]);

  // ── Positive: the aggregated real scenario retires exactly this attempt.
  const good=await plant();
  const siblingsBefore=(await db.pool.query("SELECT id,state,receipt FROM ac_native_execution_jobs WHERE intent_id=$1 AND id<>$2 ORDER BY id",[good.intentId,good.jobId])).rows;
  const out=await supervisor.recoverNeverStartedModuleExam(owner,authority,good.jobId,scope);
  assert.equal(out.state,'retired');assert.equal(out.reason,'proven_never_started');assert.equal(out.grant,'released');assert.equal(out.replayed,false);assert.deepEqual(out.removed,[good.toolsId]);
  assert.deepEqual(docker.mutations,['DELETE container '+good.toolsId,'DELETE network '+good.networkId]);
  assert.deepEqual(docker.forbidden,[]);
  const after=await snapshot(good.jobId,good.grantId,good.intentId);
  assert.equal(after.job.state,'failed');assert.equal(after.job.tools_id,good.toolsId);assert.equal(after.job.worker_id,null);assert.equal(after.job.launch_digest,null);assert.equal(after.job.network_id,good.networkId);
  assert.equal(after.grant.state,'released');
  assert.deepEqual(after.grant.physical_receipt,{executionStarted:false,jobId:good.jobId,containerId:null,toolsContainerId:good.toolsId,networkId:good.networkId,synthetic:false,modelInference:false,moduleExam:true,reason:'module_exam_tools_create_lost'});
  assert.equal(after.job.receipt.payload.physicalDigest,digest(after.grant.physical_receipt));assert.equal(after.job.receipt.payload.executionStarted,false);
  assert.equal(after.journal.state,'removed');
  assert.equal(after.intent.state,'failed');assert.equal(after.run.status,'failed');
  assert.deepEqual((await db.pool.query("SELECT id,state,receipt FROM ac_native_execution_jobs WHERE intent_id=$1 AND id<>$2 ORDER BY id",[good.intentId,good.jobId])).rows,siblingsBefore);
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_native_execution_jobs WHERE intent_id=$1",[good.intentId])).rows[0].n,4);
  // No new work: no worker, no launch, no model.
  assert.equal(docker.containers.has('ac-native-worker-'+good.jobId),false);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_native_execution_jobs')).rows[0].n,8);

  // ── Replay: the signed result is verified and nothing physical happens again.
  reset();
  const replay=await supervisor.recoverNeverStartedModuleExam(owner,authority,good.jobId,scope);
  assert.equal(replay.state,'retired');assert.equal(replay.replayed,true);assert.equal(replay.grant,'released');assert.deepEqual(replay.removed,[]);
  assert.deepEqual(docker.mutations,[]);assert.deepEqual(docker.forbidden,[]);
  assert.deepEqual(await snapshot(good.jobId,good.grantId,good.intentId),after);
  // The generic path now reads it as a terminal, acknowledged attempt (the reconcile branch for the new receipt).
  const ack=await supervisor.recover(owner,authority,good.jobId);
  assert.equal(ack.state,'acknowledged');assert.equal(ack.grant,'released');assert.deepEqual(docker.mutations,[]);
  const outcome=await supervisor.reconcile(owner,authority,good.request);
  assert.equal(outcome.state,'failed');
  // Another signing key is not this attempt's supervisor: it cannot replay or retire it.
  const stranger=new NativeExecutionSupervisor(db,config(otherKeys.privateKey.export({format:'pem',type:'pkcs8'}).toString()),{assertAdmission:async()=>{}});
  assert.equal((await stranger.recoverNeverStartedModuleExam(owner,authority,good.jobId,scope)).reason,'supervisor_identity');

  // ── Race: two supervisors on one attempt perform one removal; the other replays.
  reset();
  const race=await plant();
  const second=new NativeExecutionSupervisor(db,config(),{assertAdmission:async()=>{}});
  const results=await Promise.all([supervisor.recoverNeverStartedModuleExam(owner,authority,race.jobId,scope),second.recoverNeverStartedModuleExam(owner,authority,race.jobId,scope)]);
  assert.deepEqual(results.map(item=>item.state),['retired','retired']);
  assert.equal(results.filter(item=>item.replayed).length,1);
  assert.deepEqual(docker.mutations,['DELETE container '+race.toolsId,'DELETE network '+race.networkId]);assert.deepEqual(docker.forbidden,[]);

  // ── Crash safety: the container goes, the network delete is lost; the grant stays until a repeat completes it.
  reset();
  const resume=await plant();docker.failNetworkDelete=1;
  const partial=await supervisor.recoverNeverStartedModuleExam(owner,authority,resume.jobId,scope);
  assert.equal(partial.state,'preserved');assert.equal(partial.reason,'docker_uncertain');assert.equal(partial.grant,'preserved');assert.deepEqual(partial.removed,[resume.toolsId]);
  let mid=await snapshot(resume.jobId,resume.grantId,resume.intentId);
  assert.equal(mid.grant.state,'uncertain');assert.equal(mid.job.state,'uncertain');assert.equal(mid.journal.state,'prepared');
  // The journal stage was written only after the confirmed DELETE and carries the pre-removal evidence.
  const stage=(await db.pool.query('SELECT binding FROM ac_native_terminal_retirements WHERE job_id=$1',[resume.jobId])).rows[0].binding;
  assert.equal(stage.schemaVersion,2);assert.equal(stage.stage,'tools_removed');assert.equal(stage.toolsId,resume.toolsId);assert.match(stage.toolsEvidenceDigest,/^[a-f0-9]{64}$/);
  // Signed by this supervisor's key under its own domain, over every other field of the stage.
  const {removalSignature:stageSignature,...stageUnsigned}=stage;
  assert.equal(verify(null,Buffer.from(RemovalDomain+canonical(stageUnsigned)),keys.publicKey,Buffer.from(stageSignature,'hex')),true);
  assert.equal(verify(null,Buffer.from('agent-control:native-terminal-retirement:v1\n'+canonical(stageUnsigned)),keys.publicKey,Buffer.from(stageSignature,'hex')),false);
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_audit WHERE kind='native.module_exam_tools_removed' AND detail->>'jobId'=$1",[resume.jobId])).rows[0].n,1);
  const done=await supervisor.recoverNeverStartedModuleExam(owner,authority,resume.jobId,scope);
  assert.equal(done.state,'retired');assert.equal(done.replayed,false);assert.deepEqual(done.removed,[]);
  assert.equal((await snapshot(resume.jobId,resume.grantId,resume.intentId)).grant.state,'released');
  assert.deepEqual(docker.forbidden,[]);

  // ── Interruption between the decision and the DELETE: a failed DELETE writes no journal stage, so a container that
  // then vanishes (it could have started and been removed by someone else) is never accepted as proof.
  reset();
  const lostDelete=await plant();docker.failContainerDelete=true;
  const keptDelete=await supervisor.recoverNeverStartedModuleExam(owner,authority,lostDelete.jobId,scope);
  assert.equal(keptDelete.state,'preserved');assert.equal(keptDelete.reason,'docker_uncertain');assert.deepEqual(keptDelete.removed,[]);
  docker.failContainerDelete=false;
  assert.equal((await snapshot(lostDelete.jobId,lostDelete.grantId,lostDelete.intentId)).journal,undefined);
  docker.containers.delete(lostDelete.toolsName);
  await preserved(lostDelete,'tools_absent');
  // Retry after the same interruption with the container still Created completes normally.
  const retried=await plant();docker.failContainerDelete=true;
  assert.equal((await supervisor.recoverNeverStartedModuleExam(owner,authority,retried.jobId,scope)).state,'preserved');
  docker.failContainerDelete=false;
  const retriedOut=await supervisor.recoverNeverStartedModuleExam(owner,authority,retried.jobId,scope);
  assert.equal(retriedOut.state,'retired');assert.deepEqual(retriedOut.removed,[retried.toolsId]);
  assert.equal((await snapshot(retried.jobId,retried.grantId,retried.intentId)).grant.state,'released');
  // A crash after the DELETE but before the commit leaves the same state as an absent container without a stage: preserved.
  reset();
  const crashed=await plant();docker.containers.delete(crashed.toolsName);
  await preserved(crashed,'tools_absent');
  // A legacy (v1) journal was written before any DELETE: it is honoured while the container is still there, but its
  // absence is never proof, and the network alone cannot be missing either.
  const legacyBinding=async(p:Awaited<ReturnType<typeof plant>>)=>({schemaVersion:1,kind:'native-module-exam-never-started-retired',jobId:p.jobId,contextId:p.contextId,intentId:p.intentId,grantId:p.grantId,sessionId:p.sessionId,
   epoch:await epochOf(p.contextId),role:'specialist',inputDigest:p.inputDigest,toolsId:p.toolsId,networkId:p.networkId,toolsImage:image,workerId:null,executionStarted:false,moduleExam:true});
  const legacyGone=await plant();
  await db.pool.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[legacyGone.jobId,await legacyBinding(legacyGone)]);
  docker.containers.delete(legacyGone.toolsName);
  await preserved(legacyGone,'removal_unproven');
  const legacyNoNet=await plant({noNetwork:true});
  await db.pool.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[legacyNoNet.jobId,await legacyBinding(legacyNoNet)]);
  await preserved(legacyNoNet,'network_unproven');
  const legacyHere=await plant();
  await db.pool.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[legacyHere.jobId,await legacyBinding(legacyHere)]);
  const legacyOut=await supervisor.recoverNeverStartedModuleExam(owner,authority,legacyHere.jobId,scope);
  assert.equal(legacyOut.state,'retired');assert.deepEqual(legacyOut.removed,[legacyHere.toolsId]);
  reset();
  const legacyReplay=await supervisor.recoverNeverStartedModuleExam(owner,authority,legacyHere.jobId,scope);
  assert.equal(legacyReplay.state,'retired');assert.equal(legacyReplay.replayed,true);assert.deepEqual(docker.mutations,[]);
  // Legacy v1 journal, container still there: the DELETE is confirmed, then the network delete fails. The v1 row was
  // already promoted to the signed v2 stage and committed, so the retry accepts the absent container and completes.
  reset();
  const legacyNet=await plant();
  const legacyNetV1=await legacyBinding(legacyNet);
  await db.pool.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[legacyNet.jobId,legacyNetV1]);
  docker.failNetworkDelete=1;
  const legacyNetOut=await supervisor.recoverNeverStartedModuleExam(owner,authority,legacyNet.jobId,scope);
  assert.equal(legacyNetOut.state,'preserved');assert.equal(legacyNetOut.reason,'docker_uncertain');assert.deepEqual(legacyNetOut.removed,[legacyNet.toolsId]);
  assert.equal(docker.containers.has(legacyNet.toolsName),false);
  const promotedRow=(await db.pool.query('SELECT state,proof,binding FROM ac_native_terminal_retirements WHERE job_id=$1',[legacyNet.jobId])).rows[0];
  assert.equal(promotedRow.state,'prepared');assert.equal(promotedRow.proof,null);
  const {removalSignature:promotedSignature,schemaVersion:_v,stage:_s,toolsEvidenceDigest:promotedEvidence,...promotedRest}=promotedRow.binding;
  const {schemaVersion:_v1,...legacyRest}=legacyNetV1;
  assert.deepEqual(promotedRest,legacyRest);assert.equal(_v,2);assert.equal(_s,'tools_removed');assert.match(promotedEvidence,/^[a-f0-9]{64}$/);
  const {removalSignature:_sig,...promotedUnsigned}=promotedRow.binding;
  assert.equal(verify(null,Buffer.from(RemovalDomain+canonical(promotedUnsigned)),keys.publicKey,Buffer.from(promotedSignature,'hex')),true);
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_audit WHERE kind='native.module_exam_tools_removed' AND detail->>'jobId'=$1 AND detail->>'promotedLegacy'='true'",[legacyNet.jobId])).rows[0].n,1);
  assert.equal((await snapshot(legacyNet.jobId,legacyNet.grantId,legacyNet.intentId)).grant.state,'uncertain');
  const legacyNetDone=await supervisor.recoverNeverStartedModuleExam(owner,authority,legacyNet.jobId,scope);
  assert.equal(legacyNetDone.state,'retired');assert.equal(legacyNetDone.replayed,false);assert.deepEqual(legacyNetDone.removed,[]);
  assert.deepEqual(docker.mutations,['DELETE container '+legacyNet.toolsId,'DELETE network '+legacyNet.networkId]);
  const legacyNetReplay=await supervisor.recoverNeverStartedModuleExam(owner,authority,legacyNet.jobId,scope);
  assert.equal(legacyNetReplay.state,'retired');assert.equal(legacyNetReplay.replayed,true);assert.deepEqual(legacyNetReplay.receipt,legacyNetDone.receipt);
  assert.equal(docker.mutations.length,2);assert.deepEqual(docker.forbidden,[]);
  // ── Crash right after the network disappears and before the final commit. The signed stage was committed before
  // the network was touched, so a retry on another connection concludes; this holds for a fresh stage and for a
  // promoted v1 journal. The crashing supervisor has its own pool whose final transaction dies before COMMIT.
  for(const legacy of [false,true]){
   reset();
   const fall=await plant();
   const fallV1=await legacyBinding(fall);
   if(legacy)await db.pool.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[fall.jobId,fallV1]);
   const crashDb=new Ledger(fixture.url);
   try{
    crashDb.tx=async<T>(fn:(c:import('pg').PoolClient)=>Promise<T>):Promise<T>=>{
     const c=await crashDb.pool.connect();
     try{await c.query('BEGIN');const v=await fn(c);
      if(docker.mutations.includes('DELETE network '+fall.networkId))throw Error('SIMULATED_CRASH_BEFORE_COMMIT');
      await c.query('COMMIT');return v;}
     catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    };
    const crashing=new NativeExecutionSupervisor(crashDb,config(),{assertAdmission:async()=>{}});
    // At the moment of the network DELETE, a distinct connection already sees the committed, signed removal stage.
    const seen:Record<string,any>[]=[];
    docker.beforeNetworkDelete=async()=>{seen.push((await db.pool.query('SELECT state,proof,binding FROM ac_native_terminal_retirements WHERE job_id=$1',[fall.jobId])).rows[0]);};
    await assert.rejects(crashing.recoverNeverStartedModuleExam(owner,authority,fall.jobId,scope),/SIMULATED_CRASH_BEFORE_COMMIT/);
    assert.equal(seen.length,1);assert.equal(seen[0].state,'prepared');assert.equal(seen[0].proof,null);
    assert.equal(seen[0].binding.schemaVersion,2);assert.equal(seen[0].binding.stage,'tools_removed');assert.equal(seen[0].binding.toolsId,fall.toolsId);
    const {removalSignature:fallSig,...fallUnsigned}=seen[0].binding;
    assert.equal(verify(null,Buffer.from(RemovalDomain+canonical(fallUnsigned)),keys.publicKey,Buffer.from(fallSig,'hex')),true);
    if(legacy){const {schemaVersion:_a,stage:_b,toolsEvidenceDigest:_c,...rest}=fallUnsigned;const {schemaVersion:_d,...v1rest}=fallV1;assert.deepEqual(rest,v1rest);}
   }finally{docker.beforeNetworkDelete=undefined;await crashDb.close().catch(()=>undefined);}
   assert.deepEqual(docker.mutations,['DELETE container '+fall.toolsId,'DELETE network '+fall.networkId]);
   assert.equal(docker.containers.has(fall.toolsName),false);assert.equal(docker.networks.has(String(fall.networkId)),false);
   const fallMid=await snapshot(fall.jobId,fall.grantId,fall.intentId);
   assert.equal(fallMid.grant.state,'uncertain');assert.equal(fallMid.job.state,'uncertain');assert.equal(fallMid.journal.state,'prepared');
   const fallDone=await supervisor.recoverNeverStartedModuleExam(owner,authority,fall.jobId,scope);
   assert.equal(fallDone.state,'retired');assert.equal(fallDone.replayed,false);assert.equal(fallDone.grant,'released');assert.deepEqual(fallDone.removed,[]);
   assert.equal(docker.mutations.length,2);
   const fallAfter=await snapshot(fall.jobId,fall.grantId,fall.intentId);
   assert.equal(fallAfter.grant.state,'released');assert.equal(fallAfter.job.state,'failed');assert.equal(fallAfter.journal.state,'removed');
   const fallReplay=await supervisor.recoverNeverStartedModuleExam(owner,authority,fall.jobId,scope);
   assert.equal(fallReplay.state,'retired');assert.equal(fallReplay.replayed,true);assert.deepEqual(fallReplay.removed,[]);assert.deepEqual(fallReplay.receipt,fallDone.receipt);
   assert.equal(docker.mutations.length,2);assert.deepEqual(docker.forbidden,[]);
  }
  // The database guard only allows that exact promotion: changing any v1 field, or a v2 row, stays immutable.
  const guarded=await plant();const guardedV1=await legacyBinding(guarded);
  await db.pool.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[guarded.jobId,guardedV1]);
  const {schemaVersion:_g,...guardedRest}=guardedV1;
  const guardedV2={...guardedRest,schemaVersion:2,stage:'tools_removed',toolsEvidenceDigest:'c'.repeat(64),removalSignature:'d'.repeat(128)};
  await assert.rejects(db.pool.query('UPDATE ac_native_terminal_retirements SET binding=$2 WHERE job_id=$1',[guarded.jobId,{...guardedV2,toolsId:hex()}]),/NATIVE_TERMINAL_RETIREMENT_IMMUTABLE/);
  await assert.rejects(db.pool.query('UPDATE ac_native_terminal_retirements SET binding=$2 WHERE job_id=$1',[guarded.jobId,{...guardedV2,extra:true}]),/NATIVE_TERMINAL_RETIREMENT_IMMUTABLE/);
  await db.pool.query('UPDATE ac_native_terminal_retirements SET binding=$2 WHERE job_id=$1',[guarded.jobId,guardedV2]);
  await assert.rejects(db.pool.query('UPDATE ac_native_terminal_retirements SET binding=$2 WHERE job_id=$1',[guarded.jobId,{...guardedV2,removalSignature:'e'.repeat(128)}]),/NATIVE_TERMINAL_RETIREMENT_IMMUTABLE/);
  // That row is well formed but its signature is fake: with the container gone it proves nothing.
  docker.containers.delete(guarded.toolsName);
  await preserved(guarded,'retirement_conflict');
  // A v2 stage with a correct digest and every field right, but a fake signature or another key's signature, is a conflict.
  const stageFor=async(p:Awaited<ReturnType<typeof plant>>,evidence='c'.repeat(64))=>{const {schemaVersion:_x,...rest}=await legacyBinding(p);return {...rest,schemaVersion:2,stage:'tools_removed',toolsEvidenceDigest:evidence};};
  const fakeSig=await plant();docker.containers.delete(fakeSig.toolsName);
  await db.pool.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[fakeSig.jobId,{...await stageFor(fakeSig),removalSignature:'a'.repeat(128)}]);
  await preserved(fakeSig,'retirement_conflict');
  const otherKey=await plant();docker.containers.delete(otherKey.toolsName);
  const otherUnsigned=await stageFor(otherKey);
  await db.pool.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[otherKey.jobId,{...otherUnsigned,removalSignature:sign(null,Buffer.from(RemovalDomain+canonical(otherUnsigned)),otherKeys.privateKey).toString('hex')}]);
  await preserved(otherKey,'retirement_conflict');
  // The right key under another domain (the final retirement proof's) is not a removal signature either.
  const otherDomain=await plant();docker.containers.delete(otherDomain.toolsName);
  const otherDomainUnsigned=await stageFor(otherDomain);
  await db.pool.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[otherDomain.jobId,{...otherDomainUnsigned,removalSignature:sign(null,Buffer.from('agent-control:native-terminal-retirement:v1\n'+canonical(otherDomainUnsigned)),keys.privateKey).toString('hex')}]);
  await preserved(otherDomain,'retirement_conflict');
  // A genuine signature over another evidence digest does not cover the saved one.
  const swapped=await plant();docker.containers.delete(swapped.toolsName);
  const swappedSigned=await stageFor(swapped,'b'.repeat(64));
  await db.pool.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[swapped.jobId,{...await stageFor(swapped),removalSignature:sign(null,Buffer.from(RemovalDomain+canonical(swappedSigned)),keys.privateKey).toString('hex')}]);
  await preserved(swapped,'retirement_conflict');
  // Control: the same stage correctly signed by this supervisor's key is accepted.
  const genuine=await plant();docker.containers.delete(genuine.toolsName);
  const genuineUnsigned=await stageFor(genuine);
  await db.pool.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[genuine.jobId,{...genuineUnsigned,removalSignature:sign(null,Buffer.from(RemovalDomain+canonical(genuineUnsigned)),keys.privateKey).toString('hex')}]);
  assert.equal((await supervisor.recoverNeverStartedModuleExam(owner,authority,genuine.jobId,scope)).state,'retired');
  // Replay re-verifies the removal signature: a closed journal whose stage signature is swapped, even with a final
  // proof re-signed over it by the right key, is refused.
  const closedRow=(await db.pool.query('SELECT binding FROM ac_native_terminal_retirements WHERE job_id=$1',[genuine.jobId])).rows[0].binding;
  const tamperedBinding={...closedRow,removalSignature:sign(null,Buffer.from(RemovalDomain+canonical(genuineUnsigned)),otherKeys.privateKey).toString('hex')};
  const tamperedProof={payload:tamperedBinding,signature:sign(null,Buffer.from('agent-control:native-terminal-retirement:v1\n'+canonical(tamperedBinding)),keys.privateKey).toString('hex')};
  await db.pool.query('ALTER TABLE ac_native_terminal_retirements DISABLE TRIGGER ac_native_terminal_retirement_guard');
  try{await db.pool.query('UPDATE ac_native_terminal_retirements SET binding=$2,proof=$3 WHERE job_id=$1',[genuine.jobId,tamperedBinding,tamperedProof]);}
  finally{await db.pool.query('ALTER TABLE ac_native_terminal_retirements ENABLE TRIGGER ac_native_terminal_retirement_guard');}
  await assert.rejects(supervisor.recoverNeverStartedModuleExam(owner,authority,genuine.jobId,scope),(error:unknown)=>error instanceof Refusal&&error.code==='NATIVE_RETIREMENT_UNCONFIRMED');
  // A v2 stage that does not match this job, or whose container is back, is a conflict.
  const forgedStage=await plant();docker.containers.delete(forgedStage.toolsName);
  await db.pool.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[forgedStage.jobId,{...await legacyBinding(forgedStage),schemaVersion:2,stage:'tools_removed',toolsEvidenceDigest:'z'}]);
  await preserved(forgedStage,'retirement_conflict');
  const back=await plant();
  await db.pool.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[back.jobId,{...await legacyBinding(back),schemaVersion:2,stage:'tools_removed',toolsEvidenceDigest:'c'.repeat(64)}]);
  await preserved(back,'retirement_conflict');

  // ── Negative: insufficient evidence keeps the grant, changes nothing, returns the reason.
  reset();
  await preserved(await plant({tools:'running'}),'tools_started');
  const finished=await plant();finished.body.State.FinishedAt='2026-11-20T00:00:00Z';await preserved(finished,'tools_started');
  // Both Docker timestamps must be exactly the zero time: empty, another year-1 date or garbage are not.
  for(const [field,value] of [['FinishedAt',''],['FinishedAt','0001-01-01T00:00:01Z'],['FinishedAt','0001-garbage'],['FinishedAt','2026-11-20T00:00:00Z'],['StartedAt',''],['StartedAt','0001-12-31T23:59:59Z']] as const){
   const odd=await plant();odd.body.State[field]=value;await preserved(odd,'tools_started');
  }
  const noPid=await plant();delete noPid.body.State.Pid;await preserved(noPid,'tools_started');
  const exited=await plant();exited.body.State.Status='exited';await preserved(exited,'tools_started');
  await preserved(await plant({tools:'absent'}),'tools_absent');
  const wrongImage=await plant();wrongImage.body.Image='sha256:'+'9'.repeat(64);await preserved(wrongImage,'tools_mismatch');
  const wrongLaunch=await plant();wrongLaunch.body.Config.Labels={...wrongLaunch.labels,'agent-control.launch':'f'.repeat(64)};await preserved(wrongLaunch,'tools_mismatch');
  const wrongJob=await plant();wrongJob.body.Config.Labels={...wrongJob.labels,'agent-control.job':randomUUID()};await preserved(wrongJob,'tools_mismatch');
  const wrongEntry=await plant();wrongEntry.body.Config.Entrypoint=['node','/opt/agent-control/dist/src/native-tools-worker.mjs'];await preserved(wrongEntry,'tools_mismatch');
  const mounted=await plant();mounted.body.Mounts=[{Source:'/etc',Destination:'/work',RW:true}];await preserved(mounted,'tools_mismatch');
  const hostNet=await plant();hostNet.body.HostConfig.NetworkMode='host';await preserved(hostNet,'tools_mismatch');
  const privileged=await plant();privileged.body.HostConfig.Privileged=true;await preserved(privileged,'tools_mismatch');
  const otherId=await plant();await db.pool.query('UPDATE ac_native_execution_jobs SET tools_id=$2 WHERE id=$1',[otherId.jobId,hex()]);await preserved(otherId,'tools_registered');
  // The create was answered and recorded, then the launch stopped before start: same Docker evidence, but not a lost
  // create response, so this recovery does not sign it.
  const registered=await plant();await db.pool.query('UPDATE ac_native_execution_jobs SET tools_id=$2 WHERE id=$1',[registered.jobId,registered.toolsId]);await preserved(registered,'tools_registered');
  const withWorker=await plant();docker.containers.set('ac-native-worker-'+withWorker.jobId,{...withWorker.body,Id:hex()});await preserved(withWorker,'worker_present');
  const attached=await plant();attached.networkId&&(docker.networks.get(attached.networkId)!.Containers={[attached.toolsId]:{IPv4Address:'10.0.0.2/24'}});await preserved(attached,'network_attached');
  await preserved(await plant({noNetwork:true}),'network_unproven');
  const openNetwork=await plant();docker.networks.get(openNetwork.networkId!)!.Internal=false;await preserved(openNetwork,'network_mismatch');
  const foreignNetwork=await plant();docker.networks.get(foreignNetwork.networkId!)!.Labels={...foreignNetwork.labels,'agent-control.job':randomUUID()};await preserved(foreignNetwork,'network_mismatch');
  const renamedNetwork=await plant();docker.networks.get(renamedNetwork.networkId!)!.Name='ac-native-exec-'+randomUUID();await preserved(renamedNetwork,'network_mismatch');
  await preserved(await plant({networkId:null}),'network_unproven');
  await preserved(await plant({networkId:providerNetwork}),'network_unproven');
  const published=await plant();await writeFile(join(published.root,'input','launch.json'),'{"published":true}\n',{mode:0o600});await preserved(published,'launch_present');
  const pending=await plant();await writeFile(join(pending.root,'input','launch.pending'),'{}',{mode:0o600});await preserved(pending,'launch_present');
  const output=await plant();await writeFile(join(output.root,'output','execution-result.json'),'{}',{mode:0o600});await preserved(output,'spool_touched');
  const logged=await plant();await writeFile(join(logged.root,'tools-terminal.log'),'x',{mode:0o600});await preserved(logged,'spool_touched');
  await preserved(await plant({noRequest:true}),'request_unproven');
  await preserved(await plant({plainRequest:true}),'request_unproven');
  const tampered=await plant();await writeFile(join(tampered.root,'request.json'),JSON.stringify({...tampered.request,task:'another task'}),{mode:0o600});await preserved(tampered,'request_unproven');
  await preserved(await plant({intentState:'accepted'}),'intent_open');
  await preserved(await plant({runStatus:'running'}),'intent_open');
  await preserved(await plant({state:'running'}),'job_state');
  await preserved(await plant({workerId:hex()}),'journal_started');
  await preserved(await plant({launchDigest:'a'.repeat(64)}),'journal_started');
  await preserved(await plant({grantState:'running'}),'grant_state');
  const busy=await plant();
  await insertGrant(busy.intentId,busy.contextId,await epochOf(busy.contextId),'reserved');
  await preserved(busy,'sibling_unresolved');
  const busyJob=await plant();
  {const sib=randomUUID(),grant=await insertGrant(busyJob.intentId,busyJob.contextId,await epochOf(busyJob.contextId),'released',{x:1});
   await insertJob({jobId:sib,intentId:busyJob.intentId,grantId:grant,contextId:busyJob.contextId,sessionId:randomUUID(),inputDigest:digest({sib}),state:'uncertain',epoch:await epochOf(busyJob.contextId),networkId:hex()});}
  await preserved(busyJob,'sibling_unresolved');
  const prepared=await plant();await db.pool.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[prepared.jobId,{kind:'native-module-exam-never-started-retired',toolsId:prepared.toolsId,jobId:randomUUID()}]);
  await preserved(prepared,'retirement_conflict');
  const down=await plant();
  await preserved(down,'docker_uncertain',async()=>{docker.unavailable=true;try{return await supervisor.recoverNeverStartedModuleExam(owner,authority,down.jobId,scope);}finally{docker.unavailable=false;}});
  const failedRemove=await plant();docker.failContainerDelete=true;
  const keptOnRemove=await supervisor.recoverNeverStartedModuleExam(owner,authority,failedRemove.jobId,scope);
  assert.equal(keptOnRemove.state,'preserved');assert.equal(keptOnRemove.reason,'docker_uncertain');assert.equal(keptOnRemove.grant,'preserved');
  assert.equal((await snapshot(failedRemove.jobId,failedRemove.grantId,failedRemove.intentId)).grant.state,'uncertain');docker.failContainerDelete=false;
  assert.deepEqual(docker.forbidden,[]);

  // ── Negative: wrong scope is refused, never retired.
  const scoped=await plant();
  const refuse=async(p:Awaited<ReturnType<typeof plant>>,code:RegExp,run:()=>Promise<unknown>)=>{
   const before=await snapshot(p.jobId,p.grantId,p.intentId),mutations=docker.mutations.length;
   await assert.rejects(run(),code);
   assert.deepEqual(await snapshot(p.jobId,p.grantId,p.intentId),before);assert.equal(docker.mutations.length,mutations);
  };
  await refuse(scoped,/NATIVE_EXECUTION_SCOPE_MISMATCH/,()=>supervisor.recoverNeverStartedModuleExam(owner,authority,scoped.jobId,{projectId:randomUUID(),repository:repo}));
  await mkdir(join(area,'elsewhere'),{mode:0o700});
  await refuse(scoped,/NATIVE_EXECUTION_SCOPE_MISMATCH/,()=>supervisor.recoverNeverStartedModuleExam(owner,authority,scoped.jobId,{projectId:project,repository:join(area,'elsewhere')}));
  await refuse(scoped,/CONTEXT_FORBIDDEN/,()=>supervisor.recoverNeverStartedModuleExam('stranger-'+randomUUID(),authority,scoped.jobId,scope));
  await refuse(scoped,/NATIVE_EXECUTION_SCOPE_MISMATCH/,()=>supervisor.recoverNeverStartedModuleExam(gateway,authority,scoped.jobId,scope));
  await refuse(scoped,/NATIVE_EXECUTION_JOB_NOT_FOUND/,()=>supervisor.recoverNeverStartedModuleExam(owner,authority,randomUUID(),scope));
  const design=await plant({workflow:'design-readonly-v1'});
  await refuse(design,/NATIVE_EXECUTION_SCOPE_MISMATCH/,()=>supervisor.recoverNeverStartedModuleExam(owner,authority,design.jobId,scope));
  const stale=await plant();
  await db.releaseLease(authority);
  await refuse(stale,/STALE_MANAGER/,()=>supervisor.recoverNeverStartedModuleExam(owner,authority,stale.jobId,scope));
  authority=await lease();

  // ── Another principal's lease cannot stand in for the owner's, and an already held lease reports busy.
  await db.releaseLease(authority);
  const held=await db.acquire(gateway,examContext,randomUUID(),'gateway-manager',60);void held;
  await assert.rejects(lease(),(error:unknown)=>error instanceof Refusal&&error.code==='MANAGER_ACTIVE');
  await db.releaseLease(held);

  // ── Maintenance command: usage, owner, lease and supervisor all come from the installation.
  await assert.rejects(runPersonalMaintenance(['/nonexistent.json','--recuperar-exame-passivo','not-a-uuid']),(error:unknown)=>error instanceof Refusal&&error.code==='MAINTENANCE_USAGE');
  await assert.rejects(runPersonalMaintenance(['/nonexistent.json','--recuperar-exame-passivo']),(error:unknown)=>error instanceof Refusal&&error.code==='MAINTENANCE_USAGE');
  await assert.rejects(runPersonalMaintenance(['/nonexistent.json','--outro',randomUUID()]),(error:unknown)=>error instanceof Refusal&&error.code==='MAINTENANCE_USAGE');
  assert.match(maintenanceCliFailureText(new ModuleExamRecoveryPreserved('tools_started',['a'])),/mantida.*iniciado ou terminou.*Contêineres já removidos: a/);
  assert.match(maintenanceCliFailureText(new Refusal('MAINTENANCE_USAGE')),/--recuperar-exame-passivo <jobId>/);
  assert.match(maintenanceCliFailureText(new ModuleExamRecoveryPreserved('removal_unproven')),/sumiu sem prova/);
  assert.match(maintenanceCliFailureText(new ModuleExamRecoveryPreserved('tools_registered')),/já estava registrado/);

  const planKeys=generateKeyPairSync('ed25519'),reviewKeys=generateKeyPairSync('ed25519');
  const fingerprintOf=(key:import('node:crypto').KeyObject)=>createHash('sha256').update(key.export({format:'der',type:'spki'})).digest('hex');
  const planKeyFile=join(keysDir,'plan.pem'),execKeyFile=join(keysDir,'exec.pem'),reviewKeyFile=join(keysDir,'review.pem');
  await writeFile(planKeyFile,planKeys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),{mode:0o600});
  await writeFile(execKeyFile,pem,{mode:0o600});
  await writeFile(reviewKeyFile,reviewKeys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),{mode:0o600});
  const vaultMaster=join(dataDir,'vault-master'),tokenFile=join(dataDir,'manager-token');
  await writeFile(vaultMaster,'master-fixture',{mode:0o600});await writeFile(tokenFile,'token-fixture',{mode:0o600});
  const qaContract=NativeQaContract.parse({schemaVersion:1,id:'qa-synthetic',image,argv:['/bin/true'],environment:[],timeoutMs:15000,memoryBytes:268435456,pids:64,nanoCpus:1000000000});
  const installationFile=join(area,'installation.json');
  await writeFile(installationFile,JSON.stringify({
   schemaVersion:1,mode:'administration-only',activation:'personal',databaseUrl:fixture.url,dataDirectory:dataDir,
   contextVault:{directory:vaultDir,masterFile:vaultMaster},
   project:{id:project,label:'Passive exam project',repo,owner},
   managerTransport:{principal:gateway,tokenFile,machineId:'machine-fixture',transport:'local',contexts:[{projectId:project,contextId:mainContext,sessionId:'sess-1',profileId:profile,keyVersion:1,encryptionVariant:'dataKey'}]},
   nativeBootstrap:{
    state:'active',contract:'native-bootstrap-configured-v1',projectId:project,contextId:mainContext,epoch:gatewayAuthority.epoch,instanceId:gatewayAuthority.instanceId,source:'authorized-endpoint',
    accounts:[{accountId:account,subjectDigest:subject}],
    planning:{id:'codex-native-planning',imageId:image,executorDigest:nativePlanningExecutorDigest(image),signingKeyFile:planKeyFile,keyFingerprint:fingerprintOf(planKeys.publicKey),hostRoot:planHost,accountRoot:planAccounts},
    execution:{id:'codex-native-execution',workerImage:image,toolsImage:image,executorDigest:nativeExecutionExecutorDigest(image,image),signingKeyFile:execKeyFile,keyFingerprint:fingerprintOf(keys.publicKey),hostRoot:spool,accountRoot:accounts,providerNetworkId:providerNetwork,workerEnv:[],toolsEnv:[]},
    qa:qaContract,qaDigest:nativeQaContractDigest(qaContract),
    review:{signingKeyFile:reviewKeyFile,keyFingerprint:fingerprintOf(reviewKeys.publicKey),verifierDigest:nativeReviewVerifierDigest},
   },
   http:{listen:'127.0.0.1',port:43111,publicOrigin:'http://127.0.0.1:43111'},
  }),{mode:0o600});
  // Only the Docker transport is redirected, to the fake socket. The entry point, installation, lease and supervisor are real.
  const preload=join(area,'fake-docker.cjs');
  await writeFile(preload,`
   const http = require('node:http');
   const request = http.request;
   http.request = (options, ...args) => request(
    options.socketPath === '/var/run/docker.sock' ? {...options, socketPath: ${JSON.stringify(socket)}} : options,
    ...args
   );
   require('node:module').syncBuiltinESMExports();
  `);
  const cliEnv={...process.env,NODE_OPTIONS:'--require='+preload};
  // Asynchronous on purpose: the fake Docker lives in this process and must keep answering while the command runs.
  const personalCli=(script:string,...args:string[])=>new Promise<{status:number;stdout:string;stderr:string}>(resolve=>{
   execFile(process.execPath,[script,installationFile,...args],{encoding:'utf8',env:cliEnv},(error,stdout,stderr)=>
    resolve({status:error?Number((error as NodeJS.ErrnoException & {code?:number}).code??1):0,stdout,stderr}));
  });
  const cli=(...args:string[])=>personalCli('scripts/personal-maintenance.mjs',...args);

  reset();
  // The aggregated real case: 47 terminal sibling attempts on the same intent.
  const viaCli=await plant({siblings:47});
  // While another manager holds the exam context, the command refuses without touching anything.
  const holder=await db.acquire(owner,examContext,randomUUID(),'gateway-manager',60);
  const blocked=await cli('--recuperar-exame-passivo',viaCli.jobId);
  assert.equal(blocked.status,1);assert.match(blocked.stderr,/systemctl --user stop/);
  assert.equal((await snapshot(viaCli.jobId,viaCli.grantId,viaCli.intentId)).grant.state,'uncertain');assert.deepEqual(docker.mutations,[]);
  await db.releaseLease(holder);
  // Evidence that does not prove "never started" exits 1, explains why and keeps the reserve.
  viaCli.body.State={Status:'running',Running:true,ExitCode:0,FinishedAt:ZERO,StartedAt:'2026-11-20T00:00:00Z',Pid:7};
  const refused=await cli('--recuperar-exame-passivo',viaCli.jobId);
  assert.equal(refused.status,1);assert.match(refused.stderr,/reserva da tentativa foi mantida.*contêiner de ferramentas já foi iniciado ou terminou/);
  assert.equal((await snapshot(viaCli.jobId,viaCli.grantId,viaCli.intentId)).grant.state,'uncertain');assert.deepEqual(docker.mutations,[]);
  viaCli.body.State={Status:'created',Running:false,ExitCode:0,FinishedAt:ZERO,StartedAt:ZERO,Pid:0};
  const ok=await cli('--recuperar-exame-passivo',viaCli.jobId);
  assert.equal(ok.status,0,ok.stderr);assert.match(ok.stdout,new RegExp(`retirada sem execução.*${viaCli.toolsId}`));
  assert.equal((await snapshot(viaCli.jobId,viaCli.grantId,viaCli.intentId)).grant.state,'released');
  assert.deepEqual(docker.mutations,['DELETE container '+viaCli.toolsId,'DELETE network '+viaCli.networkId]);
  const again=await cli('--recuperar-exame-passivo',viaCli.jobId);
  assert.equal(again.status,0,again.stderr);assert.match(again.stdout,/já estava retirada/);
  assert.equal(docker.mutations.length,2);assert.deepEqual(docker.forbidden,[]);
  // Another project's design job or an unknown job is not eligible through this command either.
  const unknown=await cli('--recuperar-exame-passivo',randomUUID());
  assert.equal(unknown.status,1);
  // The lease is released after every run: the owner can take the context again.
  await db.releaseLease(await lease());
  // The security module (verify) and design are never recovered by this command, even with a never-started tools container.
  await db.releaseLease(gatewayAuthority);
  const verifyAuthority=await db.acquire(owner,mainContext,randomUUID(),'personal-maintenance',60);
  const securityModule=await plant({module:'verify',context:mainContext});
  await refuse(securityModule,/NATIVE_EXECUTION_SCOPE_MISMATCH/,()=>supervisor.recoverNeverStartedModuleExam(owner,verifyAuthority,securityModule.jobId,scope));
  await db.releaseLease(verifyAuthority);

  const plantOrphan=(options:Plant)=>plant({...options,bindManagerEpoch:true});
  const recover=(job:Awaited<ReturnType<typeof plant>>,apply=true)=>
   supervisor.recoverOrphanedExam(owner,job.jobId,{...scope,contextId:job.contextId},apply);
  const writeResult=(job:Awaited<ReturnType<typeof plant>>,exitCode=1,resultJobId=job.jobId)=>
   writeFile(join(job.root,'output','execution-result.json'),JSON.stringify({
    schemaVersion:1,jobId:resultJobId,output:'resultado preservado',normalizedTokensUsed:null,
    usageWindows:null,nativeSessionId:null,failureCode:exitCode?'EXECUTION_CANCELED':null,exitCode,
   }),{mode:0o600});

  await t.test('a CLI reconcilia segurança com resultado, libera a vaga e registra a retirada',async()=>{
   reset();
   const orphan=await plantOrphan({module:'verify',context:mainContext,tools:'absent',state:'running',grantState:'running',plainRequest:true,
    workerId:hex(),launchDigest:hex(),intentState:'accepted',siblings:0});
   await writeResult(orphan);
   const before=await snapshot(orphan.jobId,orphan.grantId,orphan.intentId);
   assert.equal(await recover(orphan,false),'eligible');
   assert.deepEqual(await snapshot(orphan.jobId,orphan.grantId,orphan.intentId),before);
   assert.deepEqual(docker.mutations,[]);
   const applied=await cli('--recuperar-exame-orfao',orphan.jobId);
   assert.equal(applied.status,0,applied.stderr);
   assert.match(applied.stdout,/reconciliado, vaga liberada/);
   const after=await snapshot(orphan.jobId,orphan.grantId,orphan.intentId);
   assert.equal(after.job.state,'failed');
   assert.equal(after.job.receipt.payload.workerExitCode,1);
   assert.equal(after.grant.state,'released');
   assert.equal(after.grant.physical_receipt.failureCode,'EXECUTION_CANCELED');
   assert.equal(after.intent.state,'failed');
   assert.equal(after.journal.state,'removed');
   assert.deepEqual(docker.mutations,['DELETE network '+orphan.networkId]);
   assert.equal(await recover(orphan),'already_recovered');
   const replay=await db.acquire(owner,mainContext,randomUUID(),'verify-replay',60);
   try{
    const reconciled=await supervisor.reconcile(owner,replay,orphan.request);
    assert.equal(reconciled.state,'failed');
    assert.ok('failureCode' in reconciled && reconciled.failureCode==='EXECUTION_CANCELED');
   }finally{await db.releaseLease(replay);}
  });

  await t.test('a recuperação recusa lease válido, contêiner, resultado errado e falta de prova',async()=>{
   reset();
   const live=await lease();
   const orphan=await plantOrphan({state:'running',grantState:'running',tools:'running',siblings:0});
   await writeResult(orphan);
   const before=await snapshot(orphan.jobId,orphan.grantId,orphan.intentId);
   docker.containers.delete(orphan.toolsName);
   await assert.rejects(recover(orphan),/NATIVE_ORPHAN_ACTIVE_LEASE/);
   await db.releaseLease(live);
   // A renamed container that is not journaled still has the job label.
   docker.containers.set('renamed-'+orphan.jobId,orphan.body);
   await assert.rejects(recover(orphan),/NATIVE_ORPHAN_CONTAINER_PRESENT/);
   docker.containers.delete('renamed-'+orphan.jobId);
   await writeResult(orphan,1,randomUUID());
   await assert.rejects(recover(orphan),/NATIVE_EXECUTION_OUTPUT_INVALID/);
   await rm(join(orphan.root,'output','execution-result.json'));
   await assert.rejects(recover(orphan),/NATIVE_EXECUTION_OUTPUT_MISSING/);
   await releaseDeadPersonalGrants(db,-1,{containers:async()=>[]});
   assert.deepEqual(await snapshot(orphan.jobId,orphan.grantId,orphan.intentId),before);
   assert.deepEqual(docker.mutations,[]);
  });

  await t.test('recupera o worker sem resultado após lease vencido e ausência inclusive de contêiner parado',async()=>{
   reset();
   const live=await lease();
   const orphan=await plantOrphan({state:'running',grantState:'running',workerId:hex(),tools:'absent',
    runStatus:'running',intentState:'accepted',siblings:0});
   await assert.rejects(recover(orphan),/NATIVE_ORPHAN_ACTIVE_LEASE/);
   await db.releaseLease(live);
   orphan.body.State={Status:'exited',Running:false,ExitCode:1,FinishedAt:new Date().toISOString()};
   docker.containers.set('renamed-tools-'+orphan.jobId,orphan.body);
   await assert.rejects(recover(orphan),/NATIVE_ORPHAN_CONTAINER_PRESENT/);
   docker.containers.delete('renamed-tools-'+orphan.jobId);
   assert.equal(await recover(orphan,false),'eligible');
   assert.equal(await recover(orphan),'recovered');
   const after=await snapshot(orphan.jobId,orphan.grantId,orphan.intentId);
   assert.equal(after.job.state,'failed');
   assert.equal(after.job.receipt.payload.executionStarted,true);
   assert.equal(after.job.receipt.payload.resultDigest,null);
   assert.equal(after.job.receipt.payload.failureCode,'NATIVE_EXAM_ORPHANED_NO_RESULT');
   assert.equal(after.grant.state,'released');
   assert.equal(after.grant.physical_receipt.failureCode,'NATIVE_EXAM_ORPHANED_NO_RESULT');
   assert.equal(after.journal.state,'removed');
   assert.equal(await recover(orphan),'already_recovered');
   const replay=await lease();
   try{
    const outcome=await supervisor.reconcile(owner,replay,orphan.request);
    assert.equal(outcome.state,'failed');
    assert.ok('failureCode' in outcome && outcome.failureCode==='NATIVE_EXAM_ORPHANED_NO_RESULT');
   }finally{await db.releaseLease(replay);}
  });

  await t.test('preserva o worker sem resultado enquanto outra sessão segura o lock de lançamento',async()=>{
   reset();
   const orphan=await plantOrphan({state:'running',grantState:'running',workerId:hex(),tools:'absent',siblings:0});
   const before=await snapshot(orphan.jobId,orphan.grantId,orphan.intentId);
   const holder=await db.pool.connect();
   try{
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[grantLaunchLockKey(orphan.grantId)]);
    await assert.rejects(recover(orphan),{code:'NATIVE_EXECUTION_BUSY'});
    assert.deepEqual(await snapshot(orphan.jobId,orphan.grantId,orphan.intentId),before);
    assert.deepEqual(docker.mutations,[]);
   }finally{
    await holder.query('ROLLBACK');
    holder.release();
   }
   assert.equal(await recover(orphan),'recovered');
  });

  await t.test('a retenção prova e aplica a recuperação de módulo e de design sem início',async()=>{
   reset();
   const module=await plantOrphan({tools:'absent',state:'running',grantState:'running',workerId:hex(),launchDigest:hex(),siblings:0});
   await db.pool.query('UPDATE ac_native_execution_jobs SET tools_id=$2 WHERE id=$1',[module.jobId,module.toolsId]);
   const work=join(module.root,'work');
   await mkdir(work,{mode:0o700});
   await writeResult(module,0);
   const design=await db.createContext(owner,project,randomUUID());
   await db.pool.query("INSERT INTO ac_exam_contexts(project_id,module,context_id) VALUES($1,'design',$2)",[project,design]);
   await db.releaseLease(await db.acquire(owner,design,randomUUID(),'personal-design',60));
   const unstarted=await plantOrphan({context:design,workflow:'design-readonly-v1',messageModule:'design-exam',noRun:true,
    plainRequest:true,tools:'absent',networkId:null,siblings:0});
   const preview=await cli('--retencao-automatica');
   assert.equal(preview.status,0,preview.stdout+preview.stderr);
   assert.match(preview.stdout,new RegExp(module.jobId+'.*elegível'));
   assert.match(preview.stdout,new RegExp(unstarted.jobId+'.*elegível'));
   assert.equal((await snapshot(module.jobId,module.grantId,module.intentId)).job.state,'running');
   assert.ok((await stat(work)).isDirectory());
   assert.equal((await snapshot(unstarted.jobId,unstarted.grantId,unstarted.intentId)).grant.state,'uncertain');
   const applied=await cli('--retencao-automatica','--aplicar');
   assert.equal(applied.status,0,applied.stdout+applied.stderr);
   assert.match(applied.stdout,new RegExp(module.jobId+'.*reconciliado'));
   assert.match(applied.stdout,new RegExp(unstarted.jobId+'.*reconciliado'));
   const done=await snapshot(module.jobId,module.grantId,module.intentId);
   assert.equal(done.grant.state,'released');
   assert.equal(done.job.state,'failed');
   assert.equal(done.job.receipt.payload.exitCode,0);
   assert.equal(done.job.receipt.payload.workerExitCode,0);
   assert.equal(done.grant.physical_receipt.exitCode,0);
   assert.equal(done.job.receipt.payload.failureCode,'NATIVE_EXAM_ORPHANED');
   await assert.rejects(stat(work),{code:'ENOENT'});
   const replay=await lease();
   try{
    const outcome=await supervisor.reconcile(owner,replay,module.request);
    assert.equal(outcome.state,'failed');
    assert.ok('failureCode' in outcome && outcome.failureCode==='NATIVE_EXAM_ORPHANED');
    assert.ok('output' in outcome && outcome.output==='resultado preservado');
   }finally{await db.releaseLease(replay);}
   const beforeLaunch=await snapshot(unstarted.jobId,unstarted.grantId,unstarted.intentId);
   assert.equal(beforeLaunch.job.receipt.payload.executionStarted,false);
   assert.equal(beforeLaunch.grant.state,'released');
   assert.equal(beforeLaunch.journal.state,'removed');
   assert.deepEqual(docker.forbidden,[]);
  });

  await t.test('a CLI de módulo recupera apenas os jobs do próprio contexto ao abrir',async()=>{
   await db.createContext(owner,project,randomUUID());
   const own=await plantOrphan({state:'running',grantState:'running',tools:'absent',siblings:0});
   const foreign=await plantOrphan({module:'verify',context:mainContext,state:'running',grantState:'running',tools:'absent',plainRequest:true,siblings:0});
   await writeResult(own);
   await writeResult(foreign);
   // The missing report rejects this command after startup, without starting an exam.
   const command=await personalCli('scripts/personal-qa.mjs',project,'--corrigir',randomUUID(),'ACH-001');
   assert.equal(command.status,1);
   assert.equal((await snapshot(own.jobId,own.grantId,own.intentId)).grant.state,'released',command.stderr);
   assert.equal((await snapshot(foreign.jobId,foreign.grantId,foreign.intentId)).grant.state,'running');
  });

  await t.test('repositório inexistente recusa com motivo de escopo',async()=>{
   const orphan=await plantOrphan({tools:'absent',siblings:0});
   await assert.rejects(supervisor.recoverOrphanedExam(owner,orphan.jobId,{
    ...scope,contextId:orphan.contextId,repository:join(area,'repo-ausente'),
   },false),{code:'NATIVE_EXECUTION_SCOPE_MISMATCH'});
  });

  await t.test('as varreduras automática e por contexto prosseguem após erro inesperado de um job',async()=>{
   const rejected=await plantOrphan({tools:'absent',networkId:null,siblings:0});
   const before=await snapshot(rejected.jobId,rejected.grantId,rejected.intentId);
   const config=await loadInstallation(installationFile);
   await db.pool.query(`
    CREATE FUNCTION fixture_fail_orphan() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
     IF NEW.id = '${rejected.jobId}' AND NEW.state = 'failed' THEN
      RAISE EXCEPTION 'falha de teste na gravação do job';
     END IF;
     RETURN NEW;
    END;
    $$;
    CREATE TRIGGER fixture_fail_orphan BEFORE UPDATE ON ac_native_execution_jobs
    FOR EACH ROW EXECUTE FUNCTION fixture_fail_orphan();
   `);
   try{
    for(const selection of [{limit:100,deadline:Date.now()+60_000},{contextId:rejected.contextId}]){
     const next=await plantOrphan({tools:'absent',networkId:null,siblings:0});
     const lines=await recoverPersonalOrphanedExams(config,db,selection,true);
     const rejectedIndex=lines.findIndex(line=>line.includes(rejected.jobId));
     assert.ok(rejectedIndex>=0);
     assert.match(lines[rejectedIndex],/preservado \(P0001\)/);
     assert.ok(lines.findIndex(line=>line.includes(next.jobId)&&line.includes('reconciliado'))>rejectedIndex);
     assert.deepEqual(await snapshot(rejected.jobId,rejected.grantId,rejected.intentId),before);
     assert.equal((await snapshot(next.jobId,next.grantId,next.intentId)).grant.state,'released');
    }
   }finally{
    await db.pool.query('DROP TRIGGER fixture_fail_orphan ON ac_native_execution_jobs; DROP FUNCTION fixture_fail_orphan()');
   }
  });
 }finally{
  for(const close of closers)await close().catch(()=>undefined);
  await db.close().catch(()=>undefined);
  await fixture.close().catch(()=>undefined);
  await rm(area,{recursive:true,force:true});
 }
});
