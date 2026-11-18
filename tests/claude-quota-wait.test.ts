import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,createHash,sign} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {NativePlanningSupervisor,nativePlanningExecutorDigest} from '../src/native-planning-supervisor.ts';
import {SemanticPlanning} from '../src/semantic-planning.ts';
import {ClaudePlanningAdapter,ClaudePlanningFailure} from '../src/claude-planning-adapter.ts';
import {ClaudeExecutionAdapter,ClaudeExecutionFailure} from '../src/claude-execution-adapter.ts';
import {claudeLimitFromText,claudeLimitNotice,isProviderLimit} from '../src/quota-exhaustion.ts';
import {Refusal,canonical,digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import type {AgentEvent,AgentRunner,AgentRunResult} from '../upstream/cezar/packages/cezar/dist/core/agent-runner.js';

test('claude limit text becomes PROVIDER_USAGE_LIMIT and keeps a future reset',()=>{
 const now=Date.parse('2026-11-13T12:00:00Z');
 const epoch=Math.floor(now/1000)+30*60;
 const marked=claudeLimitFromText([`Claude AI usage limit reached|${epoch}`],now);
 assert.equal(marked?.failureCode,'PROVIDER_USAGE_LIMIT');
 assert.equal(marked?.usageWindows?.windows[0]?.resetsAt,epoch*1000);
 assert.equal(isProviderLimit(marked?.failureCode),true);
 const prose=claudeLimitFromText(['USAGE LIMIT REACHED. limit will reset at 2026-11-13T12:20:00Z'],now);
 assert.equal(prose?.usageWindows?.windows[0]?.resetsAt,Date.parse('2026-11-13T12:20:00Z'));
 const relative=claudeLimitFromText(['session limit reached, try again in 15 minutes'],now);
 assert.equal(relative?.usageWindows?.windows[0]?.resetsAt,now+15*60*1000);
 const hour=claudeLimitFromText(['rate limit reached'],now);
 assert.equal(hour?.failureCode,'PROVIDER_USAGE_LIMIT');
 assert.equal(hour?.usageWindows,null);
 assert.equal(claudeLimitFromText(['the build failed for another reason'],now),null);
 assert.equal(claudeLimitFromText(['try again in 10 minutes'],now),null);
 const until=new Date(now+60*60*1000);
 assert.equal(claudeLimitNotice(until),`Limite do Claude atingido. Retomo sozinho às ${String(until.getHours()).padStart(2,'0')}:${String(until.getMinutes()).padStart(2,'0')}.`);
});

function planningRunner(backend:'claude',result:Promise<AgentRunResult>,events:AgentEvent[]=[]):AgentRunner{
 return {backend,run:async()=>{throw Error('UNUSED');},interrupt:async()=>{},startSession(_spec,onEvent){
  for(const event of events)onEvent?.(event);
  return {result,open:false,sendMessage:()=>false,end:()=>{},interrupt:()=>{},hardStop:()=>{}};
 }};
}
const planRequest=()=>({sessionId:randomUUID(),model:'fixture-model',effort:'medium' as const,sourceMessageRef:'message:fixture',text:'Synthetic input',
 constraints:{contextId:randomUUID(),qualityRevision:1,targetRef:'refs/heads/test',knownReferences:[] as string[]},outputSchema:{type:'object'},timeoutMs:1000});

test('a fake claude planning or review failure with a usage limit becomes the limit code',async()=>{
 const epoch=Math.floor(Date.now()/1000)+1800;
 const events:AgentEvent[]=[{type:'error',message:`Claude AI usage limit reached|${epoch}`},{type:'turn-end'}];
 await assert.rejects(new ClaudePlanningAdapter(planningRunner('claude',Promise.resolve({text:'not a plan',toolCalls:[],tokensUsed:4}),events)).generate(planRequest(),async()=>{}),error=>{
  assert.ok(error instanceof ClaudePlanningFailure);assert.equal(error.code,'PROVIDER_USAGE_LIMIT');assert.equal(error.usageWindows?.windows[0]?.resetsAt,epoch*1000);assert.equal(error.message.includes('usage limit'),false);return true;
 });
 const stderr=new Error(`claude CLI exited with code 1 — usage limit reached`);
 await assert.rejects(new ClaudeExecutionAdapter(planningRunner('claude',Promise.reject(stderr))).run({sessionId:randomUUID(),model:'fixture-model',effort:'high',role:'reviewer',task:'Leia o diff.',writePaths:[],artifactCommit:'a'.repeat(40),environment:{id:'private-job-tools',url:'ws://127.0.0.1:19493',authBearerToken:'b'.repeat(32),cwd:'/work'},timeoutMs:1000,outputSchema:{type:'object'}},async()=>{}),error=>{
  assert.ok(error instanceof ClaudeExecutionFailure);assert.equal(error.code,'PROVIDER_USAGE_LIMIT');assert.equal(error.usageWindows,null);return true;
 });
 await assert.rejects(new ClaudePlanningAdapter(planningRunner('claude',Promise.resolve({text:'not a plan',toolCalls:[],tokensUsed:0}),[{type:'error',message:'private upstream diagnostic'},{type:'turn-end'}])).generate(planRequest(),async()=>{}),/PLANNING_NATIVE_TURN_FAILED/);
});

test('a fake claude execution auth failure becomes PROVIDER_AUTH_FAILED',async()=>{
 const runInput={sessionId:randomUUID(),model:'fixture-model',effort:'high' as const,role:'reviewer' as const,task:'Leia o diff.',writePaths:[] as string[],artifactCommit:'a'.repeat(40),environment:{id:'private-job-tools',url:'ws://127.0.0.1:19493',authBearerToken:'b'.repeat(32),cwd:'/work' as const},timeoutMs:1000,outputSchema:{type:'object'}};
 const stderr=new Error('Failed to authenticate: OAuth session expired and could not be refreshed');
 await assert.rejects(new ClaudeExecutionAdapter(planningRunner('claude',Promise.reject(stderr))).run(runInput,async()=>{}),error=>{
  assert.ok(error instanceof ClaudeExecutionFailure);assert.equal(error.code,'PROVIDER_AUTH_FAILED');assert.equal(error.message.includes('Failed to authenticate'),false);assert.equal(error.message.includes('usage limit'),false);return true;
 });
 const events:AgentEvent[]=[{type:'error',message:'Failed to authenticate: OAuth session expired'},{type:'turn-end'}];
 await assert.rejects(new ClaudeExecutionAdapter(planningRunner('claude',Promise.resolve({text:'still no json',toolCalls:[],tokensUsed:1}),events)).run(runInput,async()=>{}),error=>{
  assert.ok(error instanceof ClaudeExecutionFailure);assert.equal(error.code,'PROVIDER_AUTH_FAILED');assert.equal(error.message.includes('authenticate'),false);return true;
 });
});

test('a claude planning limit exhausts the account and the stage waits without failing the plan',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'claudelimit'),db=new Ledger(fixture.url),capacity=new Capacity(db),area=await mkdtemp(join(tmpdir(),'ac-claude-limit-'));
 const spool=join(area,'spool'),accounts=join(area,'accounts');await mkdir(spool,{mode:0o700});await mkdir(accounts,{mode:0o700});
 try{
  await db.migrate();
  const project=randomUUID(),principal='claude-limit-'+randomUUID(),account=randomUUID(),profile=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'isolated claude limit']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const subject='a'.repeat(64);
  await capacity.addAccount(principal,project,{id:account,provider:'claude',label:'claude subscription',resourceIdentity:'claude:'+subject,mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/fixture',maxConcurrent:1});
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'fixture-model','high','manager',false)",[profile,account]);
  await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),principal]);
  const imageId='sha256:'+'c'.repeat(64),executorDigest=nativePlanningExecutorDigest(imageId),keys=generateKeyPairSync('ed25519');
  const supervisor=new NativePlanningSupervisor(db,{id:'claude-native-planning',executorDigest,imageId,hostRoot:spool,accountRoot:accounts,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetwork:'ac-native-provider',provider:'claude',accountSubjects:[{accountId:account,subjectDigest:subject}]});
  const planning=new SemanticPlanning(db,supervisor.executor);
  const context=await db.createContext(principal,project,randomUUID());
  const authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
  const call=randomUUID(),grant=randomUUID(),session=randomUUID(),launchDigest='d'.repeat(64),containerId='e'.repeat(64);
  const request={id:call,intentId:intent.id,contextId:context,expectedRevision:0,sourceMessageRef:'message:fixture-request' as const,qualityRevision:1,targetRef:'refs/heads/protected' as const,text:'pedido bloqueado pelo limite do Claude'};
  const inputDigest=digest({principal,...request});
  const fingerprint=createHash('sha256').update(Buffer.from(supervisor.executor.publicKey,'base64')).digest('hex');
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,'manager',$8,1,1,$9,false,'running')`,[grant,randomUUID(),intent.id,context,authority.epoch,account,profile,project,inputDigest]);
  await db.pool.query(`INSERT INTO ac_semantic_planning_calls(id,context_id,intent_id,principal_id,input_digest,executor_id,executor_digest,expected_revision,attempt_id,session_id,grant_id,profile_id,execution_epoch,state,selected_executor_id,selected_executor_digest,selected_key_fingerprint)
   VALUES($1,$2,$3,$4,$5,'semantic-planning-v1',$6,0,$7,$8,$9,$10,$11,'uncertain',$12,$13,$14)`,[call,context,intent.id,principal,inputDigest,digest({contract:'semantic-planning-v1'}),randomUUID(),session,grant,profile,authority.epoch,supervisor.executor.id,executorDigest,fingerprint]);
  const name='ac-native-plan-'+call;
  await db.pool.query(`INSERT INTO ac_native_planning_jobs(id,grant_id,context_id,input_digest,launch_digest,container_name,container_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,'running')`,[call,grant,context,inputDigest,launchDigest,name,containerId]);
  const root=join(spool,call);await mkdir(root,{mode:0o700});await mkdir(join(root,'input'),{mode:0o700});await mkdir(join(root,'output'),{mode:0o700});await mkdir(join(root,'planning'),{mode:0o700});
  const epoch=Math.floor(Date.now()/1000)+30*60;
  const limit=claudeLimitFromText([`Claude AI usage limit reached|${epoch}`]);
  assert.ok(limit);
  await writeFile(join(root,'output','planning-result.json'),JSON.stringify({schemaVersion:1,callId:call,output:'',normalizedTokensUsed:null,usageWindows:limit.usageWindows,nativeSessionId:null,failureCode:limit.failureCode,exitCode:1}),{mode:0o600});
  const physical={Id:containerId,Image:imageId,Config:{User:`${process.getuid?.()}:${process.getgid?.()}`,Entrypoint:['node','/opt/agent-control/dist/src/native-planning-worker.mjs'],Cmd:[],WorkingDir:'/planning',Env:['PATH=/usr/bin'],Labels:{'agent-control.job':call,'agent-control.launch':launchDigest,'agent-control.contract':'native-planning-v1'}},
   HostConfig:{NetworkMode:'ac-native-provider',ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:96,Memory:512*1024*1024,NanoCpus:1e9},
   State:{Running:false,Status:'exited',ExitCode:1,FinishedAt:new Date().toISOString()},Mounts:[
    {Source:join(accounts,account),Destination:'/account',RW:true},{Source:join(root,'input'),Destination:'/input',RW:false},
    {Source:join(root,'output'),Destination:'/output',RW:true},{Source:join(root,'planning'),Destination:'/planning',RW:false},
    {Source:join(root,'public-key.pem'),Destination:'/runner/planning-public-key.pem',RW:false}]};
  let starts=0;
  Object.defineProperty(supervisor,'docker',{value:{inspect:async()=>physical,start:async(id:string)=>{assert.equal(id,containerId);starts++;physical.State={Running:true,Status:'running',ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z'};}}});
  const code=async(run:Promise<unknown>)=>{try{await run;assert.fail('expected a refusal');}catch(error){assert.ok(error instanceof Refusal);return error.code;}};
  assert.equal(await code(planning.plan(principal,request,authority)),'NO_ELIGIBLE_CAPACITY');
  assert.equal(starts,0);
  const saved=(await db.pool.query('SELECT state,failure_code FROM ac_semantic_planning_calls WHERE id=$1',[call])).rows[0];
  assert.equal(saved.state,'uncertain');assert.equal(saved.failure_code,null);
  assert.equal((await db.pool.query('SELECT state FROM ac_native_planning_jobs WHERE id=$1',[call])).rows[0].state,'running');
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[grant])).rows[0].state,'running');
  assert.notEqual((await db.pool.query('SELECT state FROM ac_intents WHERE id=$1',[intent.id])).rows[0].state,'failed');
  const until=new Date((await db.pool.query('SELECT exhausted_until FROM ac_accounts WHERE id=$1',[account])).rows[0].exhausted_until);
  assert.ok(Math.abs(until.getTime()-epoch*1000)<5000);
  const payload={schemaVersion:1,callId:call,expiresAt:Date.now()+1000};
  await writeFile(join(root,'input','launch.json'),JSON.stringify({payload,signature:sign(null,Buffer.from('agent-control:native-planning-launch:v1\n'+canonical(payload)),keys.privateKey).toString('hex')}),{mode:0o600});
  await writeFile(join(root,'output','planning-result.json'),JSON.stringify({schemaVersion:1,callId:call,output:'',normalizedTokensUsed:null,usageWindows:null,nativeSessionId:null,failureCode:'PROVIDER_USAGE_LIMIT',exitCode:1}),{mode:0o600});
  await db.pool.query("UPDATE ac_accounts SET exhausted_until=clock_timestamp()-interval '1 minute' WHERE id=$1",[account]);
  // The job hit the limit before the recorded reset; only a limit seen after the reset would wait again.
  physical.State={...physical.State,FinishedAt:new Date(Date.now()-120000).toISOString()};
  assert.equal(await code(planning.plan(principal,request,authority)),'PLANNING_RESULT_UNCERTAIN');
  assert.equal(starts,1);
  assert.equal((await db.pool.query('SELECT state,failure_code FROM ac_semantic_planning_calls WHERE id=$1',[call])).rows[0].state,'uncertain');
  assert.equal((await db.pool.query('SELECT state FROM ac_native_planning_jobs WHERE id=$1',[call])).rows[0].state,'running');
  assert.notEqual((await db.pool.query('SELECT state FROM ac_intents WHERE id=$1',[intent.id])).rows[0].state,'failed');
 }finally{await db.close();await fixture.close();await rm(area,{recursive:true,force:true});}
});

test('a native planning failure that is not a usage limit still rejects the call',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'claudelimit2'),db=new Ledger(fixture.url),capacity=new Capacity(db),area=await mkdtemp(join(tmpdir(),'ac-claude-other-'));
 const spool=join(area,'spool'),accounts=join(area,'accounts');await mkdir(spool,{mode:0o700});await mkdir(accounts,{mode:0o700});
 try{
  await db.migrate();
  const project=randomUUID(),principal='claude-other-'+randomUUID(),account=randomUUID(),profile=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'isolated other failure']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const subject='a'.repeat(64);
  await capacity.addAccount(principal,project,{id:account,provider:'claude',label:'claude subscription',resourceIdentity:'claude:'+subject,mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/fixture',maxConcurrent:1});
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'fixture-model','high','manager',false)",[profile,account]);
  await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),principal]);
  const imageId='sha256:'+'c'.repeat(64),executorDigest=nativePlanningExecutorDigest(imageId),keys=generateKeyPairSync('ed25519');
  const supervisor=new NativePlanningSupervisor(db,{id:'claude-native-planning',executorDigest,imageId,hostRoot:spool,accountRoot:accounts,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetwork:'ac-native-provider',provider:'claude',accountSubjects:[{accountId:account,subjectDigest:subject}]});
  const planning=new SemanticPlanning(db,supervisor.executor);
  const context=await db.createContext(principal,project,randomUUID());
  const authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
  const call=randomUUID(),grant=randomUUID(),session=randomUUID(),launchDigest='d'.repeat(64),containerId='e'.repeat(64);
  const request={id:call,intentId:intent.id,contextId:context,expectedRevision:0,sourceMessageRef:'message:fixture-request' as const,qualityRevision:1,targetRef:'refs/heads/protected' as const,text:'pedido com falha comum'};
  const inputDigest=digest({principal,...request});
  const fingerprint=createHash('sha256').update(Buffer.from(supervisor.executor.publicKey,'base64')).digest('hex');
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,'manager',$8,1,1,$9,false,'running')`,[grant,randomUUID(),intent.id,context,authority.epoch,account,profile,project,inputDigest]);
  await db.pool.query(`INSERT INTO ac_semantic_planning_calls(id,context_id,intent_id,principal_id,input_digest,executor_id,executor_digest,expected_revision,attempt_id,session_id,grant_id,profile_id,execution_epoch,state,selected_executor_id,selected_executor_digest,selected_key_fingerprint)
   VALUES($1,$2,$3,$4,$5,'semantic-planning-v1',$6,0,$7,$8,$9,$10,$11,'uncertain',$12,$13,$14)`,[call,context,intent.id,principal,inputDigest,digest({contract:'semantic-planning-v1'}),randomUUID(),session,grant,profile,authority.epoch,supervisor.executor.id,executorDigest,fingerprint]);
  await db.pool.query(`INSERT INTO ac_native_planning_jobs(id,grant_id,context_id,input_digest,launch_digest,container_name,container_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,'running')`,[call,grant,context,inputDigest,launchDigest,'ac-native-plan-'+call,containerId]);
  const root=join(spool,call);await mkdir(root,{mode:0o700});await mkdir(join(root,'output'),{mode:0o700});
  await writeFile(join(root,'output','planning-result.json'),JSON.stringify({schemaVersion:1,callId:call,output:'',normalizedTokensUsed:null,usageWindows:null,nativeSessionId:null,failureCode:'PLANNING_NATIVE_EXECUTION_FAILED',exitCode:1}),{mode:0o600});
  const physical={Id:containerId,Image:imageId,Config:{User:`${process.getuid?.()}:${process.getgid?.()}`,Entrypoint:['node','/opt/agent-control/dist/src/native-planning-worker.mjs'],Cmd:[],WorkingDir:'/planning',Env:['PATH=/usr/bin'],Labels:{'agent-control.job':call,'agent-control.launch':launchDigest,'agent-control.contract':'native-planning-v1'}},
   HostConfig:{NetworkMode:'ac-native-provider',ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:96,Memory:512*1024*1024,NanoCpus:1e9},
   State:{Running:false,Status:'exited',ExitCode:1,FinishedAt:new Date().toISOString()},Mounts:[
    {Source:join(accounts,account),Destination:'/account',RW:true},{Source:join(root,'input'),Destination:'/input',RW:false},
    {Source:join(root,'output'),Destination:'/output',RW:true},{Source:join(root,'planning'),Destination:'/planning',RW:false},
    {Source:join(root,'public-key.pem'),Destination:'/runner/planning-public-key.pem',RW:false}]};
  let present=true;
  Object.defineProperty(supervisor,'docker',{value:{inspect:async()=>present?physical:null,remove:async()=>{present=false;}}});
  await assert.rejects(planning.plan(principal,request,authority),(error:unknown)=>{assert.ok(error instanceof Refusal);assert.equal(error.code,'PLANNING_EXECUTOR_FAILED');return true;});
  assert.equal((await db.pool.query('SELECT state,failure_code FROM ac_semantic_planning_calls WHERE id=$1',[call])).rows[0].state,'rejected');
  assert.equal((await db.pool.query('SELECT state FROM ac_native_planning_jobs WHERE id=$1',[call])).rows[0].state,'failed');
  assert.equal((await db.pool.query('SELECT exhausted_until FROM ac_accounts WHERE id=$1',[account])).rows[0].exhausted_until,null);
 }finally{await db.close();await fixture.close();await rm(area,{recursive:true,force:true});}
});
