import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmod,lstat,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync,createHash,createPublicKey,randomBytes,randomUUID} from 'node:crypto';
import {Installation} from '../src/installation.ts';
import {CodexPlanningAdapter} from '../src/codex-planning-adapter.ts';
import {CodexExecutionAdapter} from '../src/codex-execution-adapter.ts';
import {ManagerRegistry} from '../src/managers.ts';
import {nativePlanningExecutorDigest} from '../src/native-planning-contract.ts';
import {nativeExecutionExecutorDigest} from '../src/native-execution-contract.ts';
import {nativeQaContractDigest,type NativeQaContract} from '../src/native-qa-contract.ts';
import {nativeReviewVerifierDigest} from '../src/native-review-contract.ts';
import {assertManagerTransportAllowed,NativeBootstrapRefusal,assertNativeBootstrapAttachment,composeBenchNativeBootstrap,disabledNativeBootstrapReport,nativeBootstrapRuntimeAttachment,prepareNativeBootstrap,releaseProvenUnstartedGrant,type BenchRuntime,type NativeBootstrapAttachment,type NativeBootstrapSession} from '../src/native-bootstrap.ts';
import {CezarRuntime} from '../src/cezar.ts';
import type {Authority} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';

const hash=(seed:string)=>createHash('sha256').update(seed).digest('hex');
const qa:NativeQaContract={schemaVersion:1,id:'native-qa-bootstrap',image:'sha256:'+hash('qa-image'),argv:['/usr/bin/true'],environment:['PATH=/usr/bin'],timeoutMs:1000,memoryBytes:67108864,pids:16,nanoCpus:100000000};

function fingerprint(pem:string){
 const key=createPublicKey(pem);return createHash('sha256').update(key.export({format:'der',type:'spki'})).digest('hex');
}
function pem(){return generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}).toString();}

async function layout(){
 const root=await mkdtemp(join(tmpdir(),'ac-native-bootstrap-'));
 const canonical=await (await import('node:fs/promises')).realpath(root);
 const data=join(canonical,'private'),repo=join(canonical,'repo');
 await mkdir(data,{mode:0o700});await mkdir(repo,{mode:0o700});
 const dirs=['plan-host','plan-account','exec-host','exec-account'].map(name=>join(data,name));
 for(const dir of dirs){await mkdir(dir,{mode:0o700});await chmod(dir,0o700);}
 const keys={planning:join(data,'planning.pem'),execution:join(data,'execution.pem'),review:join(data,'review.pem')};
 const material={planning:pem(),execution:pem(),review:pem()};
 for(const name of Object.keys(keys) as (keyof typeof keys)[])await writeFile(keys[name],material[name],{mode:0o600});
 const projectId=randomUUID(),contextId=randomUUID(),instanceId=randomUUID(),accountId=randomUUID();
 const planningImage='sha256:'+hash('planning-image'),workerImage='sha256:'+hash('worker-image'),toolsImage='sha256:'+hash('tools-image');
 const base={schemaVersion:1 as const,mode:'administration-only' as const,databaseUrl:'postgres://localhost/native_bootstrap',dataDirectory:data,
  project:{id:projectId,label:'Bootstrap project',repo,owner:'synthetic-owner'},
  http:{listen:'127.0.0.1' as const,port:18443,publicOrigin:'http://127.0.0.1:18443'},
  happier:{upstreamOrigin:'http://127.0.0.1:18441',webOrigin:'http://127.0.0.1:18440',publicServerOrigin:'http://127.0.0.1:18441'}};
 return {root:canonical,data,repo,dirs,keys,material,projectId,contextId,instanceId,accountId,planningImage,workerImage,toolsImage,base};
}

function configured(env:Awaited<ReturnType<typeof layout>>,patch:Record<string,unknown>={}){
 const body={state:'configured' as const,contract:'native-bootstrap-configured-v1' as const,projectId:env.projectId,contextId:env.contextId,epoch:3,instanceId:env.instanceId,source:'authorized-endpoint' as const,
  accounts:[{accountId:env.accountId,subjectDigest:hash('subject')}],
  planning:{id:'native-plan',imageId:env.planningImage,executorDigest:nativePlanningExecutorDigest(env.planningImage),signingKeyFile:env.keys.planning,keyFingerprint:fingerprint(env.material.planning),hostRoot:env.dirs[0],accountRoot:env.dirs[1]},
  execution:{id:'native-exec',workerImage:env.workerImage,toolsImage:env.toolsImage,executorDigest:nativeExecutionExecutorDigest(env.workerImage,env.toolsImage),signingKeyFile:env.keys.execution,keyFingerprint:fingerprint(env.material.execution),hostRoot:env.dirs[2],accountRoot:env.dirs[3],providerNetworkId:hash('network'),workerEnv:['PATH=/usr/bin'],toolsEnv:['PATH=/usr/bin']},
  qa,qaDigest:nativeQaContractDigest(qa),review:{signingKeyFile:env.keys.review,keyFingerprint:fingerprint(env.material.review),verifierDigest:nativeReviewVerifierDigest}};
 return Installation.parse({...env.base,nativeBootstrap:{...body,...patch}});
}

test('default and explicit disabled bootstrap stay administrative and perform no queries',async()=>{
 const env=await layout();
 try{
  const absent=Installation.parse(env.base);
  const client={query:async()=>{throw new Error('QUERY');}};
  const prepared=await prepareNativeBootstrap(absent,client);
  assert.deepEqual(prepared.report,disabledNativeBootstrapReport());
  assert.equal(prepared.report.executionEnabled,false);
  assert.equal(prepared.report.inferenceEnabled,false);
  assert.equal(prepared.report.adaptersComposed,false);
  assert.equal(prepared.report.ready,false);
  const disabled=Installation.parse({...env.base,nativeBootstrap:{state:'disabled'}});
  assert.equal((await prepareNativeBootstrap(disabled,client)).report.state,'disabled');
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('incomplete, incompatible and socket configuration is refused before effects',async()=>{
 const env=await layout();
 try{
  const whole=configured(env).nativeBootstrap;
  assert.ok(whole&&whole.state==='configured');
  const incomplete={...whole};delete (incomplete as {qaDigest?:string}).qaDigest;
  assert.throws(()=>Installation.parse({...env.base,nativeBootstrap:incomplete}),/qaDigest|invalid/i);
  assert.throws(()=>Installation.parse({...env.base,nativeBootstrap:{...whole,projectId:randomUUID()}}),/NATIVE_BOOTSTRAP_PROJECT_MISMATCH/);
  assert.throws(()=>Installation.parse({...env.base,nativeBootstrap:{...whole,planning:{...whole.planning,executorDigest:hash('other')}}}),/NATIVE_BOOTSTRAP_DIGEST_MISMATCH/);
  assert.throws(()=>Installation.parse({...env.base,nativeBootstrap:{...whole,source:'synthetic-fallback'}}));
  assert.throws(()=>Installation.parse({...env.base,nativeBootstrap:{...whole,execution:{...whole.execution,workerEnv:['DOCKER_HOST=unix:///var/run/docker.sock']}}}),/NATIVE_BOOTSTRAP_SOCKET_FORBIDDEN/);
  const vault={directory:join(env.data,'vault'),masterFile:join(env.data,'vault-master.key')};
  assert.throws(()=>Installation.parse({...env.base,contextVault:vault,managerTransport:{principal:'synthetic-owner',tokenFile:join(env.data,'token'),machineId:'machine-a',contexts:[{projectId:env.projectId,contextId:randomUUID(),sessionId:'session-a',profileId:'profile-a',keyVersion:1,encryptionVariant:'dataKey'}]},nativeBootstrap:whole}),/NATIVE_BOOTSTRAP_CONTEXT_MISMATCH/);
  await assert.rejects(readFile(join(env.data,'effect-marker')));
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('configured opt-in refuses bad keys, paths, sources and accounts before writes, and does not become ready',async()=>{
 const env=await layout();
 const calls:string[]=[];
 const boundAccount=(patch:Record<string,unknown>={})=>({id:env.accountId,mode:'subscription_cli',enabled:false,provider:'codex',resource_identity:'codex:'+hash('subject'),...patch});
 const clientFor=(manager:{instance_id:string;epoch:number;project_id:string},accounts:{id:string;mode:string;enabled:boolean;provider?:string;resource_identity?:string}[])=>({
  async query(sql:string,params?:readonly unknown[]){
   calls.push(sql);
   if(sql.includes('ac_accounts'))assert.equal(params?.[1],env.projectId);
   if(/\b(UPDATE|INSERT|DELETE|ALTER)\b/i.test(sql))throw new Error('EFFECT');
   if(sql.includes('ac_managers'))return {rows:[manager],rowCount:1};
   if(sql.includes('ac_accounts'))return {rows:accounts,rowCount:accounts.length};
   throw new Error('UNEXPECTED_SQL');
  },
 });
 try{
  calls.length=0;
  const badKey=configured(env);
  if(badKey.nativeBootstrap?.state!=='configured')throw new Error('expected configured');
  badKey.nativeBootstrap.planning.keyFingerprint=hash('wrong-key');
  await assert.rejects(prepareNativeBootstrap(badKey,{query:async()=>{throw new Error('QUERY');}}),/NATIVE_BOOTSTRAP_KEY_MISMATCH/);
  assert.equal(calls.length,0);
  const link=join(env.data,'linked-host');await symlink(env.dirs[0]!,link);
  const badPath=configured(env);
  if(badPath.nativeBootstrap?.state!=='configured')throw new Error('expected configured');
  const retarget=Installation.parse({...badPath,nativeBootstrap:{...badPath.nativeBootstrap,planning:{...badPath.nativeBootstrap.planning,hostRoot:link}}});
  await assert.rejects(prepareNativeBootstrap(retarget,{query:async()=>{throw new Error('QUERY');}}),/NATIVE_BOOTSTRAP_PATH_INVALID|UNSAFE_PRIVATE_FILE/);
  calls.length=0;
  const config=configured(env);
  await assert.rejects(prepareNativeBootstrap(config,clientFor({instance_id:env.instanceId,epoch:9,project_id:env.projectId},[])),/NATIVE_BOOTSTRAP_SOURCE_UNAUTHORIZED/);
  assert.equal(calls.length,1);
  assert.match(calls[0]!,/SELECT/);
  calls.length=0;
  await assert.rejects(prepareNativeBootstrap(config,clientFor({instance_id:env.instanceId,epoch:3,project_id:env.projectId},[])),/NATIVE_BOOTSTRAP_ACCOUNT_UNBOUND/);
  assert.equal(calls.filter(sql=>sql.includes('ac_accounts')).length,1);
  assert.match(calls.find(sql=>sql.includes('ac_accounts'))!,/ac_account_access/);
  calls.length=0;
  await assert.rejects(prepareNativeBootstrap(config,clientFor({instance_id:env.instanceId,epoch:3,project_id:env.projectId},[boundAccount({resource_identity:'codex:'+hash('other')})])),/NATIVE_BOOTSTRAP_ACCOUNT_UNBOUND/);
  assert.equal(calls.some(sql=>/\b(UPDATE|INSERT|DELETE)\b/i.test(sql)),false);
  calls.length=0;
  const blocked=await prepareNativeBootstrap(config,clientFor({instance_id:env.instanceId,epoch:3,project_id:env.projectId},[boundAccount()]));
  assert.equal(blocked.report.state,'activation-blocked');
  assert.equal(blocked.report.reason,'NATIVE_ACTIVATION_NOT_PERMITTED');
  assert.equal(blocked.report.executionEnabled,false);
  assert.equal(blocked.report.inferenceEnabled,false);
  assert.equal(blocked.report.realAccountsEnabled,false);
  assert.equal(blocked.report.adaptersComposed,false);
  assert.equal(blocked.report.ready,false);
  assert.equal(blocked.report.dormantGuard,'sql-042');
  assert.equal(blocked.report.capacityGuard,'intact');
  assert.equal(calls.some(sql=>/\b(UPDATE|INSERT|DELETE)\b/i.test(sql)),false);
  calls.length=0;
  const real=await prepareNativeBootstrap(config,clientFor({instance_id:env.instanceId,epoch:3,project_id:env.projectId},[boundAccount({enabled:true})]));
  assert.equal(real.report.state,'activation-blocked');
  assert.equal(real.report.reason,'PROVIDER_RUNTIME_NOT_ACTIVATED');
  assert.equal(real.report.ready,false);
  assert.equal(nativeBootstrapRuntimeAttachment(env.projectId,disabledNativeBootstrapReport()),undefined);
  const attached=nativeBootstrapRuntimeAttachment(env.projectId,blocked.report);
  assert.equal(attached?.state,'activation-blocked');
  assert.equal(attached?.executionEnabled,false);
  assert.equal(attached?.inferenceEnabled,false);
  assert.equal(attached?.benchAdapters,undefined);
  assert.throws(()=>nativeBootstrapRuntimeAttachment(env.projectId,{...blocked.report,adaptersComposed:true}),/NATIVE_BOOTSTRAP_ACTIVATION_BLOCKED/);
  assert.throws(()=>nativeBootstrapRuntimeAttachment(env.projectId,{...disabledNativeBootstrapReport(),state:'bench-ready',adaptersComposed:true,reason:'BENCH_SUBSTITUTE_ONLY'}),/NATIVE_BOOTSTRAP_ACTIVATION_BLOCKED/);
  const bench=Installation.parse({...env.base,nativeBootstrap:{state:'bench',contract:'native-bootstrap-bench-v1',projectId:env.projectId,contextId:env.contextId,epoch:3,instanceId:env.instanceId,source:'authorized-endpoint',accounts:[{accountId:env.accountId,subjectDigest:hash('subject')}],planningDigest:hash('plan'),executionDigest:hash('exec')}});
  await assert.rejects(prepareNativeBootstrap(bench,{query:async()=>{throw new Error('QUERY');}}),/NATIVE_BOOTSTRAP_BENCH_REQUIRES_INJECTION/);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('bench injection composes explicit substitutes, authorizes the source and never calls a model',async()=>{
 const env=await layout();
 const calls:string[]=[];
 const runner={backend:'codex' as const,startSession(){calls.push('model');throw new Error('MODEL_CALLED');}};
 const planning=new CodexPlanningAdapter(runner as never);
 const execution=new CodexExecutionAdapter(runner as never);
 const planningDigest=hash('plan'),executionDigest=hash('exec');
 const config=Installation.parse({...env.base,nativeBootstrap:{state:'bench',contract:'native-bootstrap-bench-v1',projectId:env.projectId,contextId:env.contextId,epoch:4,instanceId:env.instanceId,source:'authorized-endpoint',accounts:[{accountId:env.accountId,subjectDigest:hash('subject')}],planningDigest,executionDigest}});
 let constructed=0;let connected=false;
 const constructRuntime=(attachment:NativeBootstrapAttachment):BenchRuntime=>{
  constructed+=1;assertNativeBootstrapAttachment(env.projectId,attachment);
  assert.equal(attachment.benchAdapters?.planning,planning);
  assert.equal(attachment.benchAdapters?.execution,execution);
  return {executionMode:'administration-only',nativeExecutionReady:false,nativeBootstrapReport:attachment.report,
   readAuthorizedBootstrapSource:authority=>attachment.readSource!(authority),
   async start(mode){if(mode==='execution')throw Object.assign(new Error('NATIVE_BOOTSTRAP_ACTIVATION_BLOCKED'),{code:'NATIVE_BOOTSTRAP_ACTIVATION_BLOCKED'});connected=true;},
   close(){}};
 };
 try{
  await assert.rejects(()=>composeBenchNativeBootstrap({config,ledger:{} as Ledger,repo:env.repo,substitutes:{planning:{adapter:planning,digest:hash('no')},execution:{adapter:execution,digest:executionDigest}},source:{projectId:env.projectId,contextId:env.contextId,epoch:4,instanceId:env.instanceId,resolve:async()=>'task'},registry:{boundAuthority(){return undefined;}},constructRuntime}),(error:unknown)=>{
   assert.ok(error instanceof NativeBootstrapRefusal);
   assert.equal(error.code,'NATIVE_BOOTSTRAP_DIGEST_MISMATCH');
   assert.deepEqual(error.shutdown.closed,['planning-adapter']);
   assert.deepEqual(error.shutdown.released,[]);
   assert.equal(constructed,0);
   return true;
  });
  let reads=0;
  const source={projectId:env.projectId,contextId:env.contextId,epoch:9,instanceId:env.instanceId,resolve:async()=>{reads+=1;return 'task';}};
  await assert.rejects(()=>composeBenchNativeBootstrap({config,ledger:{} as Ledger,repo:env.repo,substitutes:{planning:{adapter:planning,digest:planningDigest},execution:{adapter:execution,digest:executionDigest}},source:{...source,epoch:4},registry:undefined,constructRuntime}),(error:unknown)=>{
   assert.ok(error instanceof NativeBootstrapRefusal);
   assert.equal(error.code,'NATIVE_BOOTSTRAP_SOURCE_UNAUTHORIZED');
   assert.deepEqual(error.shutdown.closed,[]);
   assert.equal(reads,0);
   assert.equal(constructed,0);
   return true;
  });
  await assert.rejects(()=>composeBenchNativeBootstrap({config,ledger:{} as Ledger,repo:env.repo,substitutes:{planning:{adapter:planning,digest:planningDigest},execution:{adapter:execution,digest:executionDigest}},source,registry:{boundAuthority:()=>undefined},constructRuntime}),(error:unknown)=>{
   assert.ok(error instanceof NativeBootstrapRefusal);
   assert.equal(error.code,'NATIVE_BOOTSTRAP_SOURCE_UNAUTHORIZED');
   assert.deepEqual(error.shutdown.closed,['execution-adapter','planning-adapter']);
   assert.equal(reads,0);
   assert.equal(constructed,0);
   return true;
  });
  const authority:Authority={contextId:env.contextId,epoch:4,instanceId:env.instanceId};
  let live:Authority|undefined=authority;let registryClosed=false;
  const composed=await composeBenchNativeBootstrap({config,ledger:{pool:{connect(){connected=true;throw new Error('CONNECT');}}} as unknown as Ledger,repo:env.repo,
   substitutes:{planning:{adapter:planning,digest:planningDigest},execution:{adapter:execution,digest:executionDigest}},
   source:{...source,epoch:4,resolve:async()=>{reads+=1;return 'authorized task';}},registry:{boundAuthority(){if(registryClosed)return undefined;return live;}},constructRuntime});
  assert.equal(composed.report.state,'bench-ready');
  assert.equal(composed.report.reason,'BENCH_SUBSTITUTE_ONLY');
  assert.equal(composed.report.adaptersComposed,true);
  assert.equal(composed.report.ready,false);
  assert.equal(composed.report.executionEnabled,false);
  assert.equal(composed.report.inferenceEnabled,false);
  assert.equal(composed.runtime.executionMode,'administration-only');
  assert.equal(composed.runtime.nativeExecutionReady,false);
  assert.equal(await composed.runtime.readAuthorizedBootstrapSource(authority),'authorized task');
  assert.equal(reads,1);
  await assert.rejects(composed.runtime.readAuthorizedBootstrapSource({...authority,epoch:1}),/NATIVE_BOOTSTRAP_SOURCE_UNAUTHORIZED/);
  assert.equal(reads,1);
  live={...authority,epoch:8};
  await assert.rejects(composed.runtime.readAuthorizedBootstrapSource(authority),/NATIVE_BOOTSTRAP_SOURCE_UNAUTHORIZED/);
  assert.equal(reads,1);
  live=undefined;
  await assert.rejects(composed.runtime.readAuthorizedBootstrapSource(authority),/NATIVE_BOOTSTRAP_SOURCE_UNAUTHORIZED/);
  assert.equal(reads,1);
  live=authority;registryClosed=true;
  await assert.rejects(composed.runtime.readAuthorizedBootstrapSource(authority),/NATIVE_BOOTSTRAP_SOURCE_UNAUTHORIZED/);
  assert.equal(reads,1);
  registryClosed=false;
  await assert.rejects(composed.runtime.start('execution'),/NATIVE_BOOTSTRAP_ACTIVATION_BLOCKED/);
  assert.equal(connected,false);
  assert.deepEqual(calls,[]);
  assert.equal(constructed,1);
  const shutdown=await composed.session.shutdown();
  assert.deepEqual(shutdown.closed,['runtime','execution-adapter','planning-adapter']);
  assert.deepEqual(shutdown.released,[]);
  assert.equal(composed.session.replayCount,0);
  await assert.rejects(composeBenchNativeBootstrap({config,ledger:{} as Ledger,repo:env.repo,substitutes:{planning:{adapter:{} as CodexPlanningAdapter,digest:planningDigest},execution:{adapter:execution,digest:executionDigest}},source:{...source,epoch:4},registry:undefined,constructRuntime}),/NATIVE_BOOTSTRAP_ADAPTER_MISMATCH/);
  const sourceText=await readFile(new URL('../src/cezar.ts',import.meta.url),'utf8');
  assert.match(sourceText,/assertNativeBootstrapAttachment/);
  assert.match(sourceText,/NATIVE_BOOTSTRAP_ACTIVATION_BLOCKED/);
  assert.match(sourceText,/readAuthorizedBootstrapSource/);
  assert.match(sourceText,/if\(this\.nativeBootstrapAttachment\)throw new Refusal\('NATIVE_BOOTSTRAP_REPLAY_FORBIDDEN'\)/);
  const server=await readFile(new URL('../src/server-main.ts',import.meta.url),'utf8');
  assert.match(server,/prepareNativeBootstrap/);
  assert.match(server,/nativeBootstrapRuntimeAttachment/);
  assert.match(server,/start\('administration-only'\)/);
  assert.match(server,/executionEnabled:false/);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('partial shutdown closes only unstarted components and preserves uncertain grants',async()=>{
 const reserved=randomUUID(),uncertain=randomUUID();
 const sessionQueries:string[]=[];
 const {NativeBootstrapSession}=await import('../src/native-bootstrap.ts');
 const session=new NativeBootstrapSession();
 let closed=false;
 session.track({name:'partial',phase:'constructed',close(){closed=true;}});
 session.track({name:'uncertain-job',phase:'uncertain',grantId:uncertain});
 session.track({name:'reserved-grant',phase:'proven-not-started',grantId:reserved});
 const outcome=await session.shutdown({async query(sql,params){
  sessionQueries.push(sql);
  assert.equal(params?.[0],reserved);
  assert.match(sql,/g\.state='reserved'/);
  assert.match(sql,/ac_native_planning_jobs/);
  assert.match(sql,/ac_native_execution_jobs/);
  assert.match(sql,/ac_native_qa_jobs/);
  assert.doesNotMatch(sql,/recover|replay|INSERT|DELETE/i);
  return {rows:[{id:reserved}],rowCount:1};
 }});
 assert.equal(closed,true);
 assert.deepEqual(outcome.closed,['partial']);
 assert.deepEqual(outcome.released,['reserved-grant']);
 assert.deepEqual(outcome.preserved,['uncertain-job']);
 assert.equal(session.replayCount,0);
 assert.equal(sessionQueries.length,1);
 const again=await session.shutdown({async query(){throw new Error('REPLAY');}});
 assert.deepEqual(again,outcome);
 const held=await releaseProvenUnstartedGrant({async query(sql){assert.match(sql,/state='reserved'/);return {rows:[],rowCount:0};}},uncertain);
 assert.equal(held,'preserved');
});

test('shutdown keeps going when close or the release query rejects and a later call is not an empty success',async()=>{
 const reserved=randomUUID(),uncertain=randomUUID(),failedGrant=randomUUID();
 const {NativeBootstrapSession}=await import('../src/native-bootstrap.ts');
 const session=new NativeBootstrapSession();
 let kept=false,closeAttempts=0,queries=0;
 session.track({name:'kept',phase:'constructed',close(){kept=true;}});
 session.track({name:'bad-close',phase:'constructed',close(){closeAttempts+=1;if(closeAttempts===1)throw new Error('CLOSE_FAIL');}});
 session.track({name:'uncertain-job',phase:'uncertain',grantId:uncertain});
 session.track({name:'bad-grant',phase:'proven-not-started',grantId:failedGrant});
 session.track({name:'reserved-grant',phase:'proven-not-started',grantId:reserved});
 await assert.rejects(session.shutdown({async query(sql,params){
  queries+=1;
  assert.match(sql,/g\.state='reserved'/);
  assert.doesNotMatch(sql,/recover|replay|INSERT|DELETE/i);
  if(params?.[0]===failedGrant)throw new Error('QUERY_FAIL');
  assert.equal(params?.[0],reserved);
  return {rows:[{id:reserved}],rowCount:1};
 }}),(error:unknown)=>{
  assert.ok(error instanceof NativeBootstrapRefusal);
  assert.equal(error.code,'NATIVE_BOOTSTRAP_SHUTDOWN_INCOMPLETE');
  assert.equal(kept,true);
  assert.equal(closeAttempts,1);
  assert.deepEqual(error.shutdown.closed,['kept']);
  assert.deepEqual(error.shutdown.released,['reserved-grant']);
  assert.deepEqual(error.shutdown.preserved,['bad-grant','uncertain-job']);
  assert.deepEqual(error.shutdown.failures,[{name:'bad-grant',code:'QUERY_FAIL'},{name:'bad-close',code:'CLOSE_FAIL'}]);
  return true;
 });
 assert.equal(queries,2);
 const retried=await session.shutdown({async query(){queries+=1;throw new Error('REPLAY');}});
 assert.equal(closeAttempts,2);
 assert.equal(queries,2);
 assert.deepEqual(retried.closed,['kept','bad-close']);
 assert.deepEqual(retried.released,['reserved-grant']);
 assert.deepEqual(retried.preserved,['bad-grant','uncertain-job']);
 assert.equal(retried.failures,undefined);
 assert.equal(session.replayCount,0);
 const again=await session.shutdown({async query(){queries+=1;throw new Error('REPLAY');}});
 assert.deepEqual(again,retried);
 assert.equal(queries,2);
});

test('bench composition builds the real CezarRuntime and refuses a revoked fence without a model',async()=>{
 const env=await layout();
 const calls:string[]=[];
 const runner={backend:'codex' as const,startSession(){calls.push('model');throw new Error('MODEL_CALLED');}};
 const planning=new CodexPlanningAdapter(runner as never);
 const execution=new CodexExecutionAdapter(runner as never);
 const planningDigest=hash('plan'),executionDigest=hash('exec');
 const config=Installation.parse({...env.base,nativeBootstrap:{state:'bench',contract:'native-bootstrap-bench-v1',projectId:env.projectId,contextId:env.contextId,epoch:4,instanceId:env.instanceId,source:'authorized-endpoint',accounts:[{accountId:env.accountId,subjectDigest:hash('subject')}],planningDigest,executionDigest}});
 const authority:Authority={contextId:env.contextId,epoch:4,instanceId:env.instanceId};
 let live:Authority|undefined=authority;let registryClosed=false;let reads=0;
 let session:NativeBootstrapSession|undefined;
 try{
  const composed=await composeBenchNativeBootstrap({config,ledger:{pool:{connect(){throw new Error('CONNECT');}}} as unknown as Ledger,repo:env.repo,
   substitutes:{planning:{adapter:planning,digest:planningDigest},execution:{adapter:execution,digest:executionDigest}},
   source:{projectId:env.projectId,contextId:env.contextId,epoch:4,instanceId:env.instanceId,resolve:async()=>{reads+=1;return 'authorized task';}},
   registry:{boundAuthority(){if(registryClosed)return undefined;return live;}}});
  session=composed.session;
  assert.ok(composed.runtime instanceof CezarRuntime);
  assert.equal(composed.runtime.executionMode,'administration-only');
  assert.equal(composed.runtime.nativeExecutionReady,false);
  assert.equal(composed.runtime.nativeBootstrapReport?.state,'bench-ready');
  assert.equal(composed.runtime.nativeBootstrapReport?.ready,false);
  assert.equal(composed.report.adaptersComposed,true);
  assert.equal(await composed.runtime.readAuthorizedBootstrapSource(authority),'authorized task');
  assert.equal(reads,1);
  live={...authority,epoch:9};
  await assert.rejects(composed.runtime.readAuthorizedBootstrapSource(authority),/NATIVE_BOOTSTRAP_SOURCE_UNAUTHORIZED/);
  live=undefined;
  await assert.rejects(composed.runtime.readAuthorizedBootstrapSource(authority),/NATIVE_BOOTSTRAP_SOURCE_UNAUTHORIZED/);
  live=authority;registryClosed=true;
  await assert.rejects(composed.runtime.readAuthorizedBootstrapSource(authority),/NATIVE_BOOTSTRAP_SOURCE_UNAUTHORIZED/);
  assert.equal(reads,1);
  await assert.rejects(composed.runtime.start('execution'),/NATIVE_BOOTSTRAP_ACTIVATION_BLOCKED/);
  assert.deepEqual(calls,[]);
  const shutdown=await session.shutdown();
  session=undefined;
  assert.deepEqual(shutdown.closed,['runtime','execution-adapter','planning-adapter']);
  assert.equal(shutdown.failures,undefined);
 }finally{await session?.shutdown().catch(()=>{});await rm(env.root,{recursive:true,force:true});}
});

test('a ledger takeover leaves the old registry open and refuses the read before the resolver',async()=>{
 const env=await layout();
 const calls:string[]=[];
 const runner={backend:'codex' as const,startSession(){calls.push('model');throw new Error('MODEL_CALLED');}};
 const planning=new CodexPlanningAdapter(runner as never);
 const execution=new CodexExecutionAdapter(runner as never);
 const principal='synthetic-owner',sessionId='session-fence',key=randomBytes(32);
 let held:Authority|undefined;let takenOver=false;let fenceQueries=0;let closes=0;
 const endpoint={lastError:undefined as string|undefined,async start(){},async close(){closes+=1;}};
 const client={async query(sql:string,params?:readonly unknown[]){
  if(sql.includes('ac_session_links'))return {rows:[{session_id:sessionId,principal_id:principal}],rowCount:1};
  if(sql.includes('JOIN ac_managers')){
   fenceQueries+=1;
   if(takenOver||!held||params?.[1]!==held.instanceId||Number(params?.[2])!==held.epoch)return {rows:[],rowCount:0};
   return {rows:[{paused:false,epoch:held.epoch}],rowCount:1};
  }
  if(sql.includes('ac_admission_control'))return {rows:[{enabled:true}],rowCount:1};
  return {rows:[],rowCount:0};
 }};
 const managerLedger=Object.create(Ledger.prototype) as Ledger;
 const open=managerLedger as unknown as {tx:Ledger['tx'];authorize:Ledger['authorize'];acquire:Ledger['acquire'];pool:{query(sql:string):Promise<{rows:unknown[];rowCount:number}>}};
 open.tx=async fn=>fn(client as never);
 open.authorize=async()=>({project_id:env.projectId,role:'owner'});
 open.acquire=async(_principal,contextId,instanceId)=>(held={contextId,instanceId,epoch:1});
 open.pool={query:async(sql:string)=>sql.includes('ac_context_keys')?{rows:[{}],rowCount:1}:{rows:[],rowCount:0}};
 const registry=new ManagerRegistry(managerLedger,env.projectId,()=>endpoint);
 let session:NativeBootstrapSession|undefined;
 try{
  const authority=await registry.start({principal,contextId:env.contextId,sessionId,profileId:'profile-a',keyVersion:1,encryptionVariant:'legacy',key});
  assert.equal(authority.epoch,1);
  assert.deepEqual(await registry.boundAuthority(env.contextId),authority);
  const planningDigest=hash('plan-fence'),executionDigest=hash('exec-fence');
  const config=Installation.parse({...env.base,nativeBootstrap:{state:'bench',contract:'native-bootstrap-bench-v1',projectId:env.projectId,contextId:env.contextId,epoch:authority.epoch,instanceId:authority.instanceId,source:'authorized-endpoint',accounts:[{accountId:env.accountId,subjectDigest:hash('subject')}],planningDigest,executionDigest}});
  let resolverCalls=0;
  const composed=await composeBenchNativeBootstrap({config,ledger:{pool:{connect(){throw new Error('CONNECT');}}} as unknown as Ledger,repo:env.repo,
   substitutes:{planning:{adapter:planning,digest:planningDigest},execution:{adapter:execution,digest:executionDigest}},
   source:{projectId:env.projectId,contextId:env.contextId,epoch:authority.epoch,instanceId:authority.instanceId,resolve:async()=>{resolverCalls+=1;return 'authorized task';}},
   registry});
  session=composed.session;
  assert.ok(composed.runtime instanceof CezarRuntime);
  assert.equal(await composed.runtime.readAuthorizedBootstrapSource(authority),'authorized task');
  assert.equal(resolverCalls,1);
  const fencesBeforeError=fenceQueries;
  endpoint.lastError='STALE_MANAGER';
  await assert.rejects(composed.runtime.readAuthorizedBootstrapSource(authority),/NATIVE_BOOTSTRAP_SOURCE_UNAUTHORIZED/);
  assert.equal(resolverCalls,1);
  assert.equal(fenceQueries,fencesBeforeError);
  endpoint.lastError=undefined;
  takenOver=true;
  const fencesBeforeTakeover=fenceQueries;
  await assert.rejects(composed.runtime.readAuthorizedBootstrapSource(authority),/NATIVE_BOOTSTRAP_SOURCE_UNAUTHORIZED/);
  assert.equal(resolverCalls,1);
  assert.ok(fenceQueries>fencesBeforeTakeover);
  assert.equal(closes,0);
  assert.equal(await registry.boundAuthority(env.contextId),undefined);
  assert.ok(fenceQueries>fencesBeforeTakeover+1);
  assert.deepEqual(calls,[]);
 }finally{await session?.shutdown().catch(()=>{});await registry.close().catch(()=>{});await rm(env.root,{recursive:true,force:true});}
});

test('manager transport and registry do not start for bench bootstrap or an unbound context',async()=>{
 const env=await layout();
 let fetched=0;
 const original=globalThis.fetch;
 globalThis.fetch=(()=>{fetched+=1;throw new Error('FETCH');}) as typeof fetch;
 try{
  const config=Installation.parse({...env.base,nativeBootstrap:{state:'bench',contract:'native-bootstrap-bench-v1',projectId:env.projectId,contextId:env.contextId,epoch:4,instanceId:env.instanceId,source:'authorized-endpoint',accounts:[{accountId:env.accountId,subjectDigest:hash('subject')}],planningDigest:hash('plan'),executionDigest:hash('exec')},
   contextVault:{directory:join(env.data,'vault'),masterFile:join(env.data,'vault-master.key')},
   managerTransport:{principal:'synthetic-owner',tokenFile:join(env.data,'token'),machineId:'machine-a',contexts:[{projectId:env.projectId,contextId:env.contextId,sessionId:'session-a',profileId:'profile-a',keyVersion:1,encryptionVariant:'dataKey'}]}});
  assert.throws(()=>assertManagerTransportAllowed(config),/NATIVE_BOOTSTRAP_BENCH_REQUIRES_INJECTION/);
  assert.equal(fetched,0);
  const transport=await readFile(new URL('../src/manager-transport.ts',import.meta.url),'utf8');
  assert.match(transport,/assertManagerTransportAllowed\(config\)/);
  let factoryCalls=0;
  const registry=new ManagerRegistry({} as Ledger,env.projectId,()=>{factoryCalls+=1;throw new Error('FACTORY');});
  assert.equal(await registry.boundAuthority(env.contextId),undefined);
  assert.equal(factoryCalls,0);
  assert.throws(()=>assertNativeBootstrapAttachment(env.projectId,{projectId:env.projectId,state:'bench-ready',executionEnabled:true,inferenceEnabled:false,report:disabledNativeBootstrapReport()}),/NATIVE_BOOTSTRAP_ACTIVATION_BLOCKED/);
  assert.throws(()=>assertNativeBootstrapAttachment(env.projectId,{projectId:env.projectId,state:'activation-blocked',executionEnabled:false,inferenceEnabled:false,report:{...disabledNativeBootstrapReport(),state:'activation-blocked',reason:'NATIVE_ACTIVATION_NOT_PERMITTED'}},{executions:1}),/NATIVE_BOOTSTRAP_ACTIVATION_BLOCKED/);
 }finally{globalThis.fetch=original;await rm(env.root,{recursive:true,force:true});}
});
