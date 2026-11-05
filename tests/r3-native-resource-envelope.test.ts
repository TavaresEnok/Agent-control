import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {mkdtemp,writeFile,readFile,mkdir,rm,rmdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash,randomBytes,generateKeyPairSync,sign} from 'node:crypto';
import {NativePlanningSupervisor,nativePlanningExecutorDigest} from '../src/native-planning-supervisor.ts';
import {NativeExecutionSupervisor} from '../src/native-execution-supervisor.ts';
import {NativeQa,NativeQaContract,nativeQaContractDigest} from '../src/native-qa.ts';
import {Quality} from '../src/quality.ts';
import {GitArtifacts} from '../src/git.ts';
import {nativeReviewVerifierDigest} from '../src/native-verification.ts';
import {Control} from '../src/control.ts';
import {Operators,operatorMessage} from '../src/operator.ts';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {admitNativeResources,reconcileNativeResourceAdmissions,NativeResourceDockerDaemon} from '../src/native-resource-envelope.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
const exec=promisify(execFile);
test('R3 native backend binds real Capacity across controllers to aggregate kernel limits and preserves orphan admissions',{timeout:240000},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;assert(base);const isolated=await isolatedDatabase(base,'r3_native_res'),db=new Ledger(isolated.url),capacity=new Capacity(db),area=await mkdtemp(join(tmpdir(),'ac-r3-native-resources-'));
 let heartbeat:ReturnType<typeof setInterval>|undefined;
 const children:ReturnType<typeof spawn>[]=[],ids:string[]=[];let envelope:any,anchor:string|undefined;
 const label='ac-r3-resources-native-'+randomUUID(),prefix=createHash('sha256').update(label).digest('hex').slice(0,24),parent='acr'+prefix+'.slice';
 try{
  const image=JSON.parse((await exec('docker',['image','inspect','agent-control-ssh-lab:0.1.0'])).stdout)[0].Id;
  const configFile=join(area,'authority.json');await exec('/usr/bin/python3',['scripts/r3-provision-resource-authority.py','--lab-provision','--authority',label,'--image',image,'--output',configFile,'--pids','16','--jobs','2','--memory','268435456']);
  envelope=JSON.parse(await readFile(configFile,'utf8'));anchor=envelope.resourceAuthority.anchorId;
  await db.migrate();const project=randomUUID(),principal='r3-native-resources-owner',account=randomUUID(),profile=randomUUID();await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'R3 native aggregate resource proof']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);await capacity.configure(principal,{programmingLimit:8,evaluationLimit:4});await capacity.registerModel(principal,{provider:'synthetic-resources',model:'worker',efforts:['medium'],roles:['programmer','qa'],source:'synthetic://r3-native-resources'});await capacity.addAccount(principal,project,{id:account,provider:'synthetic-resources',label:'Physical envelope fixture',resourceIdentity:account,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://r3-native-resources',maxConcurrent:4});await capacity.addProfile(principal,project,{id:profile,accountId:account,model:'worker',effort:'medium',role:'programmer'});await capacity.observeQuota(principal,account,{status:'available',source:'synthetic://r3-native-resources',ttlSeconds:3600});const qaProfile=randomUUID();await capacity.addProfile(principal,project,{id:qaProfile,accountId:account,model:'worker',effort:'medium',role:'qa'});const revision=await capacity.publish(principal,project,0,{schemaVersion:1,maxProgrammersPerContext:4,maxEvaluatorsPerContext:2,roles:{programmer:{regular:[profile],emergency:[]},qa:{regular:[qaProfile],emergency:[]}}});
  const gate=join(area,'gate');await mkdir(gate,{mode:0o755});
  const code="import os,time\nwhile not os.path.exists('/gate/go'): time.sleep(.05)\nfor i in range(10):\n try:\n  pid=os.fork()\n  if pid==0:\n   os.setsid()\n   while True: pass\n except OSError: break\nwhile True: time.sleep(1)";
  const configuration={Image:image,User:'1000:1000',WorkingDir:'/',Entrypoint:['python3','-c',code],Cmd:[],Env:[],Labels:{'agent-control.contract':'native-envelope-fixture-v1','ac.r3.disposable':'true'},HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:96,Memory:512*1024*1024,NanoCpus:1e9,Binds:[gate+':/gate:ro']}};
  const sessions:{authority:import('../src/contracts.ts').Authority;request:{attemptId:string;contextId:string;intentId:string;role:'programmer'};stateRoot:string}[]=[];
  for(let i=0;i<2;i++){const context=await db.createContext(principal,project,randomUUID());await capacity.assignPolicy(principal,context,revision);const authority=await db.acquire(principal,context,randomUUID(),'native-resource-manager',60);const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:native-resources'}},authority,'api');const stateRoot=join(area,'controller-'+i);await mkdir(stateRoot,{mode:0o700});sessions.push({authority,request:{attemptId:randomUUID(),contextId:context,intentId:intent.id,role:'programmer' as const},stateRoot});}
  heartbeat=setInterval(()=>{for(const session of sessions)void db.heartbeat(session.authority).catch(()=>{});},3000);
  const ready=await Promise.all(sessions.map(async(session,i)=>{const file=join(area,'input-'+i+'.json');await writeFile(file,JSON.stringify({database:isolated.url,principal,envelope:{...envelope,stateRoot:session.stateRoot},request:session.request,authority:session.authority,name:'ac-native-'+(i?'tools':'worker')+'-'+randomUUID(),configuration}),{mode:0o600});const child=spawn(process.execPath,['--import','tsx','tests/fixtures/r3-native-resource-controller.ts',file],{stdio:['ignore','pipe','pipe']});children[i]=child;let err='';child.stderr!.on('data',(v:Buffer)=>{err+=v.toString();});const line=await Promise.race([once(child.stdout!,'data').then(([value])=>JSON.parse(value.toString())),once(child,'exit').then(()=>{throw Error('CONTROLLER_FAILED '+err);})]);ids[i]=line.id;return line;}));
  await writeFile(join(gate,'go'),'go');
  const root='/sys/fs/cgroup/'+parent;
  assert.equal((await readFile(root+'/cpu.max','utf8')).trim(),'50000 100000');assert.equal((await readFile(root+'/memory.max','utf8')).trim(),'268435456');assert.equal((await readFile(root+'/pids.max','utf8')).trim(),'16');
  await new Promise(r=>setTimeout(r,500));assert(Number((await readFile(root+'/pids.current','utf8')).trim())<=16);assert.match(await readFile(root+'/pids.events','utf8'),/max [1-9][0-9]*/);assert.match(await readFile(root+'/cpu.stat','utf8'),/nr_throttled [1-9][0-9]*/);
  for(const id of ids){const physical=JSON.parse((await exec('docker',['inspect',id])).stdout)[0];assert.equal(physical.State.Running,true);assert.equal(physical.HostConfig.CgroupParent,parent);assert((await readFile(root+'/docker-'+id+'.scope/cgroup.procs','utf8')).includes(String(physical.State.Pid)));}
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_capacity_grants WHERE account_id=$1 AND state='running'",[account])).rows[0].n,2);
  // Actual native QA product path must wait before its journal when the parent is full.
  const repo=join(area,'repo'),qaRoot=join(area,'qa');await mkdir(qaRoot,{mode:0o700});
  const git=async(...args:string[])=>(await exec('git',['-C',repo,...args])).stdout.trim();await exec('git',['init',repo]);await git('config','user.name','Synthetic resource fixture');await git('config','user.email','fixture@example.invalid');await writeFile(join(repo,'fixture.txt'),'base');await git('add','.');await git('commit','-m','base');const sourceBase=await git('rev-parse','HEAD');await writeFile(join(repo,'fixture.txt'),'candidate');await git('add','.');await git('commit','-m','candidate');const candidate=await git('rev-parse','HEAD'),tree=await git('rev-parse','HEAD^{tree}');
  await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
  const contract=NativeQaContract.parse({schemaVersion:1,id:'r3-resource-qa',image,argv:['/usr/bin/python3','-c','import time;time.sleep(1)'],environment:JSON.parse((await exec('docker',['image','inspect',image])).stdout)[0].Config.Env,timeoutMs:15000,memoryBytes:268435456,pids:64,nanoCpus:1000000000}),key=randomBytes(32),quality=new Quality(db,key,new GitArtifacts(repo));await quality.publish(principal,project,0,{schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:true,verifierDigest:nativeReviewVerifierDigest,qaVerifierDigest:nativeQaContractDigest(contract)});
  const qaEnvelope={...envelope,stateRoot:qaRoot},qa=new NativeQa(db,quality,repo,qaRoot,contract,key,undefined,undefined,qaEnvelope),qaAuthority=sessions[1].authority;
  const device=randomUUID(),keys=generateKeyPairSync('ed25519');await new Operators(db).enroll(principal,principal,device,keys.publicKey.export({format:'der',type:'spki'}).toString('base64'));const installationId=(await db.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0].id,control=new Control(db);
  const signed=async(action:'plan.cancel'|'context.pause',payload:any)=>{const command={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:qaAuthority.contextId,action,payload},proof={deviceId:device,expiresAt:Date.now()+120000};return control.execute(principal,command as any,{...proof,signature:sign(null,Buffer.from(operatorMessage(principal,command,proof,installationId)),keys.privateKey).toString('hex')});};
  const startQa=async(prepareFailure=false)=>{
   const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:qaAuthority.contextId,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:physical-resource-wait'}},qaAuthority,'api');
   const implementation=await capacity.reserve(principal,{attemptId:randomUUID(),contextId:qaAuthority.contextId,intentId:intent.id,role:'programmer'},qaAuthority);await capacity.transition(principal,implementation.id,qaAuthority,'released',{state:'not_started',processId:'synthetic-artifact-fixture'});const writer=randomUUID();await db.pool.query("UPDATE ac_operations SET state='completed',grant_id=$2,native_session_id=$3,receipt=$4 WHERE id=$1",[intent.operation_id,implementation.id,writer,{commit:candidate,tree,base:sourceBase,exitCode:0,synthetic:true}]);
   const artifact=await quality.register(principal,{id:randomUUID(),contextId:qaAuthority.contextId,intentId:intent.id,implementationGrantId:implementation.id,implementationSessionId:writer,policyRevision:1,commit:candidate,tree,base:sourceBase,risk:'high'},qaAuthority),attempt=randomUUID(),stage={id:randomUUID(),session_id:randomUUID()};await db.pool.query("INSERT INTO ac_stage_operations(id,intent_id,node_id,session_id,attempt_id,manager_epoch,state) VALUES($1,$2,'qa',$3,$4,$5,'registered')",[stage.id,intent.id,stage.session_id,attempt,qaAuthority.epoch]);const grant=await capacity.reserve(principal,{attemptId:attempt,contextId:qaAuthority.contextId,intentId:intent.id,role:'qa'},qaAuthority);
   if(prepareFailure)await mkdir(join(qaRoot,stage.id),{mode:0o700});
   const promise=qa.run(principal,intent,qaAuthority,stage,grant.id,artifact,()=>false);void promise.catch(()=>{});
   if(prepareFailure)return {intent,stage,grant,promise};
   for(let i=0;i<100;i++){if((await db.pool.query('SELECT state FROM ac_native_resource_admissions WHERE job_id=$1',[stage.id])).rows[0]?.state==='waiting')break;await new Promise(r=>setTimeout(r,25));}
   assert.equal((await db.pool.query('SELECT state FROM ac_native_resource_admissions WHERE job_id=$1',[stage.id])).rows[0]?.state,'waiting');assert.equal((await db.pool.query('SELECT 1 FROM ac_native_qa_jobs WHERE id=$1',[stage.id])).rowCount,0);return {intent,stage,grant,promise};
  };
  const restarted=new NativeResourceDockerDaemon({...envelope,stateRoot:sessions[0].stateRoot});
  const canceledQa=await startQa();await signed('plan.cancel',{intentId:canceledQa.intent.id,planRevision:canceledQa.intent.plan_revision});await assert.rejects(canceledQa.promise,/PLAN_CANCELLATION_REQUESTED/);assert.equal((await db.pool.query('SELECT state FROM ac_native_resource_admissions WHERE job_id=$1',[canceledQa.stage.id])).rows[0].state,'canceled');assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[canceledQa.grant.id])).rows[0].state,'released');
  const resumedQa=await startQa();
  const extraRequest={...sessions[1].request,attemptId:randomUUID()},extra=await capacity.reserve(principal,extraRequest,sessions[1].authority);
  await assert.rejects(restarted.create('ac-native-qa-'+randomUUID(),configuration),/RESOURCE_CAPACITY_EXHAUSTED/);await capacity.transition(principal,extra.id,sessions[1].authority,'released',{state:'not_started',processId:'physical-admission-rejected-before-create'});
  await signed('context.pause',{paused:true,expectedRevision:0});
  children[0].kill('SIGKILL');await once(children[0],'exit');await capacity.transition(principal,ready[0].grantId,sessions[0].authority,'uncertain');
  assert.equal((await restarted.inspect(ids[0]))?.State.Running,true);
  // Kernel group survives controller death, and its durable admission cannot be timed out away.
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[ready[0].grantId])).rows[0].state,'uncertain');
  await restarted.stop(ids[0]);await restarted.remove(ids[0]);await capacity.transition(principal,ready[0].grantId,sessions[0].authority,'released',{state:'exited',processId:ids[0]});
  const replacementName='ac-native-plan-'+randomUUID(),replacementConfig={...configuration,Entrypoint:['sleep','infinity']};const replacement=await restarted.create(replacementName,replacementConfig);ids.push(replacement);
  const secondOwner=new NativeResourceDockerDaemon({...envelope,stateRoot:sessions[1].stateRoot});await secondOwner.stop(ids[1]);await secondOwner.remove(ids[1]);
  await new Promise(r=>setTimeout(r,200));assert.equal((await db.pool.query('SELECT reason FROM ac_native_resource_admissions WHERE job_id=$1',[resumedQa.stage.id])).rows[0].reason,'human_pause');assert.equal((await db.pool.query('SELECT 1 FROM ac_native_qa_jobs WHERE id=$1',[resumedQa.stage.id])).rowCount,0);
  await signed('context.pause',{paused:false,expectedRevision:1});const qaResult=await resumedQa.promise;assert.equal(qaResult.status,'passed');
  await restarted.start(replacement);assert.equal((await restarted.inspect(replacement))?.State.Running,true);await restarted.stop(replacement);await restarted.remove(replacement);await restarted.remove(replacement);
  await assert.rejects(restarted.create(replacementName,replacementConfig),/NATIVE_RESOURCE_CREATE_UNCERTAIN/);
  // Exact replay after retirement must not consume a new pending resource slot.
  const afterReplay=await restarted.create('ac-native-qa-'+randomUUID(),replacementConfig);ids.push(afterReplay);await restarted.start(afterReplay);await restarted.stop(afterReplay);await restarted.remove(afterReplay);await capacity.transition(principal,ready[1].grantId,sessions[1].authority,'released',{state:'exited',processId:ids[1]});
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_capacity_grants WHERE account_id=$1 AND state<>'released'",[account])).rows[0].n,0);
  const failedPreparation=await startQa(true);assert.equal((await failedPreparation.promise).status,'missing_result');
  assert.equal((await db.pool.query('SELECT state FROM ac_native_resource_admissions WHERE job_id=$1',[failedPreparation.stage.id])).rows[0].state,'canceled');
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[failedPreparation.grant.id])).rows[0].state,'released');
  // Kill after the durable batch reservation and before any native job exists.
  const takeoverContext=await db.createContext(principal,project,randomUUID());await capacity.assignPolicy(principal,takeoverContext,revision);
  const old=await db.acquire(principal,takeoverContext,randomUUID(),'prejournal-old',60);
  const newIntent=async(authority:import('../src/contracts.ts').Authority)=>db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:authority.contextId,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:prejournal'}},authority,'api');
  const abandoned=await newIntent(old),jobId=randomUUID(),names=['ac-native-tools-'+jobId,'ac-native-worker-'+jobId],recoveryRoot=join(area,'prejournal');await mkdir(recoveryRoot,{mode:0o700});
  const inputFile=join(area,'prejournal.json');await writeFile(inputFile,JSON.stringify({database:isolated.url,principal,envelope:{...envelope,stateRoot:recoveryRoot},request:{attemptId:randomUUID(),contextId:takeoverContext,intentId:abandoned.id,role:'programmer'},authority:old,prejournal:true,jobId,names}),{mode:0o600});
  const orphan=spawn(process.execPath,['--import','tsx','tests/fixtures/r3-native-resource-controller.ts',inputFile],{stdio:['ignore','pipe','pipe']});children.push(orphan);let orphanErrors='';orphan.stderr!.on('data',(v:Buffer)=>{orphanErrors+=v;});
  const reservation=await Promise.race([once(orphan.stdout!,'data').then(([v])=>JSON.parse(v.toString())),once(orphan,'exit').then(()=>{throw Error(orphanErrors);})]);
  orphan.kill('SIGKILL');await once(orphan,'exit');
  assert.equal((await db.pool.query('SELECT state FROM ac_native_resource_admissions WHERE job_id=$1',[jobId])).rows[0].state,'admitted');
  const recoveryDocker=new NativeResourceDockerDaemon({...envelope,stateRoot:recoveryRoot});
  const foreignIntent=await newIntent(old),foreignGrant=await capacity.reserve(principal,{attemptId:randomUUID(),contextId:takeoverContext,intentId:foreignIntent.id,role:'programmer'},old);
  await assert.rejects(admitNativeResources({docker:recoveryDocker,ledger:db,principal,authority:old,intentId:foreignIntent.id,grantId:foreignGrant.id,jobId,names,isCanceled:()=>true}),/NATIVE_RESOURCE_ADMISSION_UNCERTAIN/);
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[foreignGrant.id])).rows[0].state,'reserved');
  assert.equal((await db.pool.query('SELECT state FROM ac_native_resource_admissions WHERE job_id=$1',[jobId])).rows[0].state,'admitted');
  await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[takeoverContext]);
  const successor=await db.acquire(principal,takeoverContext,randomUUID(),'prejournal-successor',60);
  sessions.push({authority:successor,request:{attemptId:randomUUID(),contextId:takeoverContext,intentId:abandoned.id,role:'programmer'},stateRoot:recoveryRoot});
  await assert.rejects(admitNativeResources({docker:recoveryDocker,ledger:db,principal,authority:old,intentId:abandoned.id,grantId:reservation.grantId,jobId,names,isCanceled:()=>true}),/STALE_MANAGER/);
  assert.equal((await db.pool.query('SELECT state FROM ac_native_resource_admissions WHERE job_id=$1',[jobId])).rows[0].state,'admitted');
  await reconcileNativeResourceAdmissions({docker:recoveryDocker,ledger:db,principal,authority:successor});
  assert.equal((await db.pool.query('SELECT state FROM ac_native_resource_admissions WHERE job_id=$1',[jobId])).rows[0].state,'canceled');
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[reservation.grantId])).rows[0].state,'released');
  // An impossible batch fails finitely and returns only its own never-started grant.
  const oversized=await newIntent(successor),oversizedGrant=await capacity.reserve(principal,{attemptId:randomUUID(),contextId:takeoverContext,intentId:oversized.id,role:'programmer'},successor),oversizedJob=randomUUID();
  await assert.rejects(admitNativeResources({docker:recoveryDocker,ledger:db,principal,authority:successor,intentId:oversized.id,grantId:oversizedGrant.id,jobId:oversizedJob,names:['ac-native-worker-'+oversizedJob,'ac-native-tools-'+oversizedJob,'ac-native-qa-'+oversizedJob]}),/NATIVE_RESOURCE_BATCH_TOO_LARGE/);
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[oversizedGrant.id])).rows[0].state,'released');
  // Reuse the same never-started operation with an explicit new Capacity attempt.
  const retriedGrant=await capacity.reserve(principal,{attemptId:randomUUID(),contextId:takeoverContext,intentId:abandoned.id,role:'programmer'},successor);
  await admitNativeResources({docker:recoveryDocker,ledger:db,principal,authority:successor,intentId:abandoned.id,grantId:retriedGrant.id,jobId,names});
  assert.equal((await db.pool.query('SELECT grant_id FROM ac_native_resource_admissions WHERE job_id=$1',[jobId])).rows[0].grant_id,retriedGrant.id);
  // This fixture explicitly cancels the reattempt before create.
  await db.pool.query("UPDATE ac_intents SET state='failed' WHERE id=$1",[abandoned.id]);await reconcileNativeResourceAdmissions({docker:recoveryDocker,ledger:db,principal,authority:successor});
  const recoveryKeys=generateKeyPairSync('ed25519'),signingKeyPem=recoveryKeys.privateKey.export({format:'pem',type:'pkcs8'}).toString();
  const execution=new NativeExecutionSupervisor(db,{id:'resource-recovery',workerImage:image,toolsImage:image,hostRoot:recoveryRoot,accountRoot:join(area,'recovery-accounts'),repository:repo,protectedRepositories:[],signingKeyPem,providerNetworkId:'f'.repeat(64),accountSubjects:[{accountId:account,subjectDigest:'a'.repeat(64)}],workerEnv:[],toolsEnv:[],resourceEnvelope:{...envelope,stateRoot:recoveryRoot}});
  // Journal-before-create crash: no request files or groups. Known network is
  // retired by immutable identity; a missing network ACK keeps the grant held.
  for(const knownNetwork of [true,false]){
   const intent=await newIntent(successor),grant=await capacity.reserve(principal,{attemptId:randomUUID(),contextId:takeoverContext,intentId:intent.id,role:'programmer'},successor),id=randomUUID(),jobNames=['ac-native-tools-'+id,'ac-native-worker-'+id];
   await admitNativeResources({docker:recoveryDocker,ledger:db,principal,authority:successor,intentId:intent.id,grantId:grant.id,jobId:id,names:jobNames});
   const network=knownNetwork?await recoveryDocker.createPrivateNetwork('ac-native-exec-'+id,{'agent-control.contract':'native-execution-v1','agent-control.job':id,'agent-control.launch':'a'.repeat(64)}):null;
   await db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,executor_digest,key_fingerprint,input_digest,base_id,role,account_id,profile_id,profile_digest,eligibility_revision,state,network_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'programmer',$11,$12,$9,1,'uncertain',$13)`,[id,grant.id,intent.id,takeoverContext,successor.epoch,randomUUID(),execution.executorDigest,execution.keyFingerprint,'a'.repeat(64),sourceBase,account,profile,network]);
   await db.pool.query("UPDATE ac_capacity_grants SET state='uncertain' WHERE id=$1",[grant.id]);
   await db.pool.query("UPDATE ac_intents SET state='failed' WHERE id=$1",[intent.id]);
   // All three supervisors may share one state root. A planning/QA callback
   // must never consume an execution job or its terminal history membership.
   for(const source of ['ac_native_planning_jobs','ac_native_qa_jobs'] as const)await reconcileNativeResourceAdmissions({docker:recoveryDocker,ledger:db,principal,authority:successor,recoverSource:source,recoverJob:async()=>assert.fail('FOREIGN_NATIVE_JOB_DISPATCH')});
   await execution.reconcileResourceAdmissions(principal,successor);
   const result=await execution.recover(principal,successor,id);assert.equal(result.state,knownNetwork?'released_unstarted':'uncertain');
   assert.equal((await db.pool.query('SELECT state FROM ac_native_resource_admissions WHERE job_id=$1',[id])).rows[0].state,'canceled');
   assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[grant.id])).rows[0].state,knownNetwork?'released':'uncertain');
   if(network)assert.equal(await recoveryDocker.inspectPrivateNetwork(network),null);
  }
  const planningDigest=nativePlanningExecutorDigest(image),planning=new NativePlanningSupervisor(db,{id:'resource-planning-recovery',executorDigest:planningDigest,imageId:image,hostRoot:recoveryRoot,accountRoot:join(area,'recovery-accounts'),protectedRepositories:[],signingKeyPem,providerNetwork:'ac-native-provider',accountSubjects:[{accountId:account,subjectDigest:'a'.repeat(64)}],resourceEnvelope:{...envelope,stateRoot:recoveryRoot}});
  const planningIntent=await newIntent(successor),planningAttempt=randomUUID(),planningGrant=await capacity.reserve(principal,{attemptId:planningAttempt,contextId:takeoverContext,intentId:planningIntent.id,role:'programmer'},successor),planningJob=randomUUID();
  await admitNativeResources({docker:recoveryDocker,ledger:db,principal,authority:successor,intentId:planningIntent.id,grantId:planningGrant.id,jobId:planningJob,names:['ac-native-plan-'+planningJob]});
  const fingerprint=createHash('sha256').update(recoveryKeys.publicKey.export({format:'der',type:'spki'})).digest('hex');
  await db.pool.query(`INSERT INTO ac_semantic_planning_calls(id,context_id,intent_id,principal_id,input_digest,executor_id,executor_digest,expected_revision,attempt_id,session_id,grant_id,profile_id,execution_epoch,state,selected_executor_id,selected_executor_digest,selected_key_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,$11,$12,'uncertain',$6,$7,$13)`,[planningJob,takeoverContext,planningIntent.id,principal,'a'.repeat(64),'resource-planning-recovery',planningDigest,planningAttempt,randomUUID(),planningGrant.id,profile,successor.epoch,fingerprint]);
  await db.pool.query("INSERT INTO ac_native_planning_jobs(id,grant_id,context_id,input_digest,launch_digest,container_name,state) VALUES($1,$2,$3,$4,$4,$5,'uncertain')",[planningJob,planningGrant.id,takeoverContext,'a'.repeat(64),'ac-native-plan-'+planningJob]);
  await db.pool.query("UPDATE ac_capacity_grants SET state='uncertain' WHERE id=$1",[planningGrant.id]);
  await db.pool.query("UPDATE ac_intents SET state='failed' WHERE id=$1",[planningIntent.id]);
  await planning.reconcileResourceAdmissions(principal,successor);
  assert.equal((await planning.recover(principal,successor,planningJob)).state,'released_unstarted');
  assert.equal((await db.pool.query('SELECT state FROM ac_native_resource_admissions WHERE job_id=$1',[planningJob])).rows[0].state,'canceled');


 }finally{
  if(heartbeat)clearInterval(heartbeat);
  for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}
  const ownedIds=(await exec('docker',['ps','-aq','--no-trunc','--filter','label=ac.resources.authority='+label])).stdout.trim().split('\n').filter(Boolean);
  for(const id of ownedIds)await exec('docker',['rm','-f',id]).catch(()=>{});
  if(anchor)await exec('docker',['rm','-f',anchor]).catch(()=>{});
  if(envelope){const directory='/var/tmp/ac-resource-authority-'+process.geteuid!();for(const name of await readdir(directory)){if(name.startsWith('operation-')){const claim=JSON.parse(await readFile(join(directory,name),'utf8'));if(claim.installationId===label)await rm(join(directory,name));}
   if(name===createHash('sha256').update(label).digest('hex')+'.json'||name.startsWith('reservation-'+prefix+'-'))await rm(join(directory,name));}}
  if(envelope){
   const bindingDirectory='/var/tmp/ac-resource-installation-'+createHash('sha256').update(envelope.installationId).digest('hex');
   const remaining=(await exec('docker',['ps','-aq','--filter','label=ac.resources.installation='+envelope.installationId])).stdout.trim();
   if(!remaining){for(const name of ['binding.json','authority.lock'])await rm(join(bindingDirectory,name),{force:true});await rmdir(bindingDirectory);}
  }
  await db.close();await isolated.close();await rm(area,{recursive:true,force:true});
 }
});
