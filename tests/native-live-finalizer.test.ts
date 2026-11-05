import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {randomUUID,generateKeyPairSync,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,readlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {GitArtifacts} from '../src/git.ts';
import {NativeExecutionSupervisor,NativeExecutionRequest} from '../src/native-execution-supervisor.ts';
import {digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

for(const namespace of ['same','different','legacy','otherboot','controllercrash'] as const)test(`native finalizer remains conservative with ${namespace} process identity`, {timeout:30000},async()=>{
 const baseUrl=process.env.AC_TEST_DATABASE_URL;if(!baseUrl)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(baseUrl,'livefinalizer'),db=new Ledger(fixture.url),area=await mkdtemp(join(tmpdir(),'ac-finalizer-live-'));
 let child:ChildProcess|undefined,orphanPid:number|undefined,orphanStart:string|undefined;
 try{
  await db.migrate();const project=randomUUID(),principal='live-finalizer-'+randomUUID(),account=randomUUID(),profile=randomUUID();
  const repo=join(area,'repo'),spool=join(area,'spool'),accounts=join(area,'accounts');for(const p of [spool,accounts])await mkdir(p,{mode:0o700});
  execFileSync('git',['init','-q','-b','main',repo]);const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
  git('config','user.name','Synthetic');git('config','user.email','fixture@invalid');await mkdir(join(repo,'src'));await writeFile(join(repo,'src/a.ts'),'base\n');git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'isolated finalizer']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
  await new Capacity(db).addAccount(principal,project,{id:account,provider:'codex',label:'fixture only',resourceIdentity:'codex:'+('a'.repeat(64)),mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/fixture',maxConcurrent:1});
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'fixture','medium','programmer',false)",[profile,account]);
  const context=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),principal]);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
  const grant=randomUUID(),keys=generateKeyPairSync('ed25519'),image='sha256:'+'d'.repeat(64);
  const supervisorConfig={id:'fixture-native-finalizer',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:'e'.repeat(64),socketPath:'/no-operational-socket',accountSubjects:[{accountId:account,subjectDigest:'a'.repeat(64)}],workerEnv:[],toolsEnv:[]};
  const supervisor=new NativeExecutionSupervisor(db,supervisorConfig);
  const input=NativeExecutionRequest.parse({jobId:intent.operation_id,intentId:intent.id,grantId:grant,sessionId:randomUUID(),base,role:'programmer',task:'synthetic fixture',writePaths:['src/a.ts']});
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,'programmer',$8,1,1,$9,false,'running')`,[grant,randomUUID(),intent.id,context,authority.epoch,account,profile,project,digest(input)]);
  await db.pool.query("UPDATE ac_operations SET state='uncertain',grant_id=$2,native_session_id=$3 WHERE id=$1",[input.jobId,grant,input.sessionId]);
  const frozen={base,writePaths:input.writePaths};await db.pool.query('INSERT INTO ac_managed_delivery_inputs VALUES($1,$2,$3,$4)',[intent.id,base,frozen,digest(frozen)]);
  const worker='f'.repeat(64),tools='1'.repeat(64),fingerprint=createHash('sha256').update(keys.publicKey.export({format:'der',type:'spki'})).digest('hex');
  await db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state,worker_id,tools_id,network_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,'programmer','running',$14,$15,$16)`,[input.jobId,grant,intent.id,context,authority.epoch,input.sessionId,account,profile,digest({fixture:true}),supervisor.executorDigest,fingerprint,digest(input),base,worker,tools,'2'.repeat(64)]);
  const root=join(spool,input.jobId),work=join(root,'work');await mkdir(root,{mode:0o700});await mkdir(join(root,'output'),{mode:0o700});await new GitArtifacts(repo).snapshot(base,base,work);
  await writeFile(join(root,'request.json'),JSON.stringify(input),{mode:0o600});await writeFile(join(root,'output/execution-result.json'),JSON.stringify({schemaVersion:1,jobId:input.jobId,output:'fixture',normalizedTokensUsed:null,usageWindows:null,nativeSessionId:null,failureCode:null,exitCode:0}),{mode:0o600});
  const labels={'agent-control.contract':'native-execution-v1','agent-control.job':input.jobId,'agent-control.launch':digest(input)},finished=new Date().toISOString();
  const physical=(id:string)=>({Id:id,Image:image,Config:{Labels:labels},State:{Status:'exited',Running:false,ExitCode:0,FinishedAt:finished}});
  Object.defineProperty(supervisor,'docker',{value:{inspect:async(name:string)=>name===worker||name.startsWith('ac-native-worker-')?physical(worker):physical(tools),stop:async()=>{}}});
  const finalizerCode="const fs=require('fs');setInterval(()=>fs.writeFileSync(process.argv[1],'active synthetic finalizer\\n'),20)";
  const pidFile=join(root,'fixture-finalizer-pid');
  if(namespace==='controllercrash'){
   const controllerCode="const {spawn}=require('child_process'),fs=require('fs');const c=spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{detached:true,stdio:'ignore'});fs.writeFileSync(process.argv[3],String(c.pid));setInterval(()=>{},1000)";
   child=spawn(process.execPath,['-e',controllerCode,finalizerCode,join(work,'src/a.ts'),pidFile],{stdio:'ignore'});
  }else child=spawn(process.execPath,['-e',finalizerCode,join(work,'src/a.ts')],{detached:true,stdio:'ignore'});
  const closed=new Promise<void>((resolve,reject)=>{child!.once('exit',()=>resolve());child!.once('error',reject);});
  if(!child.pid)throw Error('SYNTHETIC_FINALIZER_NOT_STARTED');
  if(namespace==='controllercrash'){
   for(let i=0;i<100;i++){try{orphanPid=Number(await readFile(pidFile,'utf8'));if(orphanPid>1)break;}catch{}await new Promise(r=>setTimeout(r,20));}
   if(!orphanPid)throw Error('SYNTHETIC_FINALIZER_PID_MISSING');
  }
  const finalizerPid=orphanPid??child.pid;
  let observed='';for(let i=0;i<100;i++){observed=await readFile(join(work,'src/a.ts'),'utf8');if(observed==='active synthetic finalizer\n')break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(observed,'active synthetic finalizer\n');
  const proc=await readFile(`/proc/${finalizerPid}/stat`,'utf8'),startTime=proc.slice(proc.lastIndexOf(')')+2).split(' ')[19];
  if(orphanPid)orphanStart=startTime;
  const actualNamespace=await readlink('/proc/self/ns/pid');
  const handle={pid:finalizerPid,startTime,bootId:namespace==='otherboot'?'unverified-other-host':(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),
   ...(namespace==='legacy'?{}:{pidNamespace:namespace==='different'?'pid:[999999999]':actualNamespace})};
  await db.pool.query(`INSERT INTO ac_native_artifact_finalizations(job_id,context_id,manager_epoch,input_digest,scope_digest,base_id,state,process_handle)
   VALUES($1,$2,$3,$4,$5,$6,'running',$7)`,[input.jobId,context,authority.epoch,digest(input),digest(input.writePaths),base,handle]);
  if(namespace==='controllercrash'){
   child.kill('SIGKILL');await closed;assert.equal(child.signalCode,'SIGKILL');process.kill(-finalizerPid,0);
  }
  assert.equal((await supervisor.reconcile(principal,authority,input)).state,'uncertain');
  const live=(await db.pool.query('SELECT j.state,j.receipt,g.state grant_state,o.state operation_state FROM ac_native_execution_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id JOIN ac_operations o ON o.id=j.id WHERE j.id=$1',[input.jobId])).rows[0];
  assert.equal(live.state,'running');assert.equal(live.receipt,null);assert.equal(live.grant_state,'running');assert.equal(live.operation_state,'uncertain');
  await db.pool.query('INSERT INTO ac_plan_cancellations(intent_id,context_id,requested_by,plan_revision) VALUES($1,$2,$3,$4)',[intent.id,context,principal,intent.plan_revision]);
  if(namespace!=='same'&&namespace!=='controllercrash'){
   assert.equal((await supervisor.reconcileCancellation(principal,authority,input.jobId)).state,'uncertain');
   assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);
   process.kill(-child.pid,'SIGKILL');await closed;
   assert.equal((await supervisor.reconcileCancellation(principal,authority,input.jobId)).state,'uncertain');
   const unknown=(await db.pool.query('SELECT j.state,j.receipt,g.state grant_state,o.state operation_state FROM ac_native_execution_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id JOIN ac_operations o ON o.id=j.id WHERE j.id=$1',[input.jobId])).rows[0];
   assert.equal(unknown.state,'running');assert.equal(unknown.receipt,null);assert.equal(unknown.grant_state,'running');assert.equal(unknown.operation_state,'uncertain');
   return;
  }
  let settled=false;
  if(namespace==='controllercrash'){
   await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);
   const successor=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
   await assert.rejects(supervisor.reconcileCancellation(principal,authority,input.jobId),/STALE_MANAGER/);process.kill(-finalizerPid,0);
   const configFile=join(area,'reconciler.json');await writeFile(configFile,JSON.stringify({url:fixture.url,principal,authority:successor,input,supervisorConfig,worker,tools,finished}),{mode:0o600,flag:'wx'});
   const next=spawn(process.execPath,['--import','tsx',new URL('./fixtures/native-live-finalizer-reconciler.ts',import.meta.url).pathname,configFile],{stdio:['ignore','ignore','pipe']});
   let error='';next.stderr?.on('data',bytes=>{error=(error+String(bytes)).slice(-2000);});
   const exit=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{next.once('error',reject);next.once('close',(code,signal)=>resolve({code,signal}));});
   assert.equal(exit.code,0,`NEW_SUPERVISOR_FAILED ${error}`);settled=true;
  }else for(let i=0;i<100;i++){
   const result=await supervisor.reconcileCancellation(principal,authority,input.jobId);
   if(result.state==='reconciled'){settled=true;break;}await new Promise(r=>setTimeout(r,20));
  }
  assert(settled);if(namespace!=='controllercrash')await closed;else orphanPid=undefined;
  const final=(await db.pool.query('SELECT j.state,j.receipt,g.state grant_state,o.receipt operation_receipt,f.state finalizer_state,f.receipt finalizer_receipt FROM ac_native_execution_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id JOIN ac_operations o ON o.id=j.id JOIN ac_native_artifact_finalizations f ON f.job_id=j.id WHERE j.id=$1',[input.jobId])).rows[0];
  assert.equal(final.state,'failed');assert.equal(final.grant_state,'released');assert.equal(final.operation_receipt.cancellation,true);
  assert.equal(final.finalizer_state,'failed');assert.equal(final.finalizer_receipt.failureCode,'FINALIZER_EXITED_WITHOUT_RESULT');assert.equal(final.finalizer_receipt.process.groupAbsent,true);
  assert.equal(final.receipt.payload.artifact,null);assert.notEqual(final.receipt.payload.exitCode,0);
 }finally{
  if(orphanPid&&orphanStart)try{const stat=await readFile(`/proc/${orphanPid}/stat`,'utf8');if(stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]===orphanStart)process.kill(-orphanPid,'SIGKILL');}catch{}
  if(child?.pid&&child.exitCode===null&&child.signalCode===null)try{if(namespace==='controllercrash')child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL');}catch{}
  await db.close();await fixture.close();await rm(area,{recursive:true,force:true});
 }
});
