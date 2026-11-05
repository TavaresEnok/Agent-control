import {DockerDaemon as FlowDockerDaemon} from '../src/sandbox-broker.ts';
import {ProjectEnvironments} from '../src/project-environments.ts';
import {provisionFlowResources,assertFlowResourceLimits,assertFlowResourceMembers,retireFlowResources,type FlowResourceEnvelope} from './fixtures/r3-flow-resources.ts';
import {measureCommandRequests,startCommittedEventProbe,assertEventReport} from './fixtures/r3-latency-probe.ts';
import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,generateKeyPairSync,sign} from 'node:crypto';
import {chmod,mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawn} from 'node:child_process';
import nacl from 'tweetnacl';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {NativeExecutionSupervisor} from '../src/native-execution-supervisor.ts';
import {NativePlanningSupervisor,nativePlanningExecutorDigest} from '../src/native-planning-supervisor.ts';
import {NativeImplementation} from '../src/native-implementation.ts';
import {NativeVerification,nativeReviewVerifierDigest} from '../src/native-verification.ts';
import {NativeQa,NativeQaContract,nativeQaContractDigest} from '../src/native-qa.ts';
import {authorizeNativeSyntheticFixture} from '../src/native-synthetic-fixture.ts';
import {ProviderEligibility} from '../src/provider-eligibility.ts';
import {AccountHomes} from '../src/account-homes.ts';
import {Templates} from '../src/templates.ts';
import {ContextKeys,keyFingerprint} from '../src/context-keys.ts';
import {HappierEndpoint,loadHappier} from '../src/happier.ts';
import {SemanticPlanning} from '../src/semantic-planning.ts';
import {createApi} from '../src/api.ts';
import {BrowserSessions} from '../src/sessions.ts';
import {assertNativeSyntheticFixture} from '../src/native-synthetic-fixture.ts';
import {Operators,operatorMessage} from '../src/operator.ts';
import {provisionEngineering} from './fixtures/provision-engineering.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {installGraphAllocator} from './fixtures/r2-graph-allocator.ts';
import {cleanupGraphResources} from './fixtures/native-graph-cleanup.ts';

const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(check:()=>Promise<boolean>,reason:()=>string,ms=140000){const deadline=Date.now()+ms;while(Date.now()<deadline){if(await check())return;await sleep(250);}throw Error(reason());}

test('R3 encrypted conversation → admitted isolated plan → native graph → QA/review → integration → canonical chat; signed active cancellation',{timeout:300000},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL,url=process.env.AC_TEST_HAPPIER_URL,image=process.env.AC_R3_FLOW_IMAGE,network=process.env.AC_R3_FLOW_NETWORK,label=process.env.AC_R3_FLOW_LABEL;
 if(!base||!url||!image||!network||!label||process.env.AC_R3_FLOW_TOOLS_KIND!=='codex-exec-server')throw Error('R3_FLOW_ISOLATED_RUNNER_REQUIRED');
 const fixture=await isolatedDatabase(base,'r3flow'),db=new Ledger(fixture.url),area=await mkdtemp(join(tmpdir(),'ac-r3-flow-'));
 let resourceEnvelope:FlowResourceEnvelope|undefined,managerHeartbeat:ReturnType<typeof setInterval>|undefined;
 let runtime:CezarRuntime|undefined,endpoint:HappierEndpoint|undefined,controller:ReturnType<typeof spawn>|undefined,eventProbe:ReturnType<typeof startCommittedEventProbe>|undefined,primary:unknown;const evidence:Record<string,unknown>={fixture:'r3-conversation-flow',inference:'deterministic-only',substitutions:['deterministic planning/model output','private subnet allocator'],providerGuards:'intact',tools:{kind:'actual native-tools-worker with public Codex exec-server',version:process.env.AC_R3_FLOW_PUBLIC_CODEX_VERSION,publicBinarySha256:process.env.AC_R3_FLOW_PUBLIC_CODEX_SHA256,transport:'authenticated WebSocket capability token',operations:['initialize','initialized','fs/createDirectory','fs/writeFile','fs/readFile'],inference:false}};
 try{
  installGraphAllocator();await db.migrate();resourceEnvelope=await provisionFlowResources(area,image);evidence.resourceLimits=await assertFlowResourceLimits(resourceEnvelope);
  const boundary=await loadHappier(),key=randomBytes(32),kp=nacl.sign.keyPair.fromSeed(key),challenge=randomBytes(32),b64=(v:Uint8Array)=>Buffer.from(v).toString('base64');
  const auth=await fetch(url+'/v1/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({publicKey:b64(kp.publicKey),challenge:b64(challenge),signature:b64(nacl.sign.detached(challenge,kp.secretKey))})});assert.equal(auth.status,200);
  const {token}=await auth.json() as {token:string};
  const api=async(path:string,body?:unknown)=>{const r=await fetch(url+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});assert(r.ok,'HAPPIER_'+r.status+'_'+path);return r.json() as Promise<any>;};
  const {id:principal}=await api('/v1/account/profile'),machineId=randomUUID(),seal=(v:unknown)=>boundary.encodeBase64(boundary.encrypt(key,'legacy',v));
  await api('/v1/machines',{id:machineId,metadata:seal({host:'r3-flow',platform:'linux',happyCliVersion:'0.2.18',homeDir:area}),daemonState:seal({status:'running',startedAt:Date.now()})});
  const session=(await api('/v1/sessions',{tag:label+'-'+randomUUID(),encryptionMode:'e2ee',metadata:seal({machineId,path:area,host:'r3-flow',homeDir:area,version:'0.2.18',name:'R3 flow',flavor:'codex',startedBy:'terminal',startedFromDaemon:false}),agentState:seal({controlledByUser:false,requests:{},completedRequests:{}})})).session.id as string;
  const project=randomUUID(),repo=join(area,'repo'),spool=join(area,'execution'),planRoot=join(area,'planning'),homes=join(area,'homes'),qaRoot=join(area,'qa');
  for(const p of [spool,planRoot,homes,qaRoot])await mkdir(p,{mode:0o700});
  execFileSync('git',['init','-q','-b','main',repo]);await chmod(repo,0o700);await chmod(join(repo,'.git'),0o700);const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
  git('config','user.name','R3 synthetic');git('config','user.email','r3-flow@example.invalid');await mkdir(join(repo,'src'),{mode:0o700});await writeFile(join(repo,'src/.gitkeep'),'');git('add','.');git('commit','-qm','base');const original=git('rev-parse','HEAD');git('branch','protected');
  await mkdir(join(repo,'.ai/cezar'),{recursive:true});await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[],worktreeRetention:0}));
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,label]);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
  const {revision,options}=await provisionEngineering(db,principal,project,repo,1,false,false),capacity=new Capacity(db);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  const context=await db.createContext(principal,project,session);
  const fixtureCapability=await authorizeNativeSyntheticFixture({contract:'native-synthetic-fixture-v1',projectId:project,contextId:context,provider:'synthetic-engineering',label,workerImage:image,toolsImage:image,providerNetworkId:network});
  assert.throws(()=>assertNativeSyntheticFixture({...fixtureCapability},fixtureCapability),/SYNTHETIC_FIXTURE_CAPABILITY_INVALID/);
  assert.throws(()=>assertNativeSyntheticFixture(fixtureCapability,{...fixtureCapability,workerImage:'sha256:'+'f'.repeat(64)}),/SYNTHETIC_FIXTURE_CAPABILITY_INVALID/);
  assert.throws(()=>assertNativeSyntheticFixture(fixtureCapability,fixtureCapability,{projectId:project,contextId:randomUUID()}),/SYNTHETIC_FIXTURE_CAPABILITY_INVALID/);
  const execAccount=(await db.pool.query('SELECT account_id FROM ac_account_access WHERE project_id=$1',[project])).rows[0].account_id as string,subject='c'.repeat(64);
  // Identity updates preserve synthetic mode and the dormant-provider SQL guards.
  await db.pool.query('UPDATE ac_accounts SET resource_identity=$2 WHERE id=$1',[execAccount,'synthetic-engineering:'+subject]);
  const accountHomes=new AccountHomes(db,homes,[repo]);await accountHomes.initialize(principal,project,execAccount);
  await chmod(join(homes,execAccount),0o755);await assert.rejects(accountHomes.inspect(principal,project,execAccount),/ACCOUNT_HOME_IDENTITY_MISMATCH/);await chmod(join(homes,execAccount),0o700);
  await assert.rejects(db.pool.query("UPDATE ac_accounts SET mode='subscription_cli' WHERE id=$1",[execAccount]));
  const keys=generateKeyPairSync('ed25519'),pem=keys.privateKey.export({format:'pem',type:'pkcs8'}).toString();
  const executionConfig={resourceEnvelope,id:'r3-flow-execution',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:homes,repository:repo,protectedRepositories:[],signingKeyPem:pem,providerNetworkId:network,accountSubjects:[{accountId:execAccount,subjectDigest:subject}],workerEnv:['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','NODE_VERSION=22.23.3','YARN_VERSION=1.22.22'],toolsEnv:['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','NODE_VERSION=22.23.3','YARN_VERSION=1.22.22'],syntheticFixture:fixtureCapability};
  const supervisor=new NativeExecutionSupervisor(db,executionConfig);
  const canary='AC_R3_SYNTHETIC_SECRET_'+randomUUID();await writeFile(join(homes,execAccount,'r3-secret-canary'),canary,{mode:0o600,flag:'wx'});
  const outsider='r3-outsider-'+randomUUID();await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'viewer')",[project,outsider]);await assert.rejects(accountHomes.inspect(outsider,project,execAccount),/ACCOUNT_FORBIDDEN/);
  const managerAccount=randomUUID(),managerProfile=randomUUID();
  await capacity.addAccount(principal,project,{id:managerAccount,provider:'synthetic-engineering',label:'R3 deterministic manager',resourceIdentity:'synthetic-engineering:'+'d'.repeat(64),mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://r3-flow',maxConcurrent:1});
  await capacity.registerModel(principal,{provider:'synthetic-engineering',model:'fixed-manager',efforts:['medium'],roles:['manager'],source:'synthetic://r3-flow'});
  await capacity.addProfile(principal,project,{id:managerProfile,accountId:managerAccount,model:'fixed-manager',effort:'medium',role:'manager'});await capacity.observeQuota(principal,managerAccount,{status:'available',source:'synthetic://r3-flow',ttlSeconds:3600});await new AccountHomes(db,homes,[repo]).initialize(principal,project,managerAccount);
  await writeFile(join(homes,managerAccount,'r3-secret-canary'),canary,{mode:0o600,flag:'wx'});
  const planning=new NativePlanningSupervisor(db,{resourceEnvelope,id:'r3-flow-planning',executorDigest:nativePlanningExecutorDigest(image),imageId:image,hostRoot:planRoot,accountRoot:homes,protectedRepositories:[repo],signingKeyPem:pem,providerNetwork:network,accountSubjects:[{accountId:managerAccount,subjectDigest:'d'.repeat(64)}],syntheticFixture:fixtureCapability});
  for(const [accountId,id,version] of [[execAccount,'r3-flow-execution',supervisor.executorDigest],[managerAccount,planning.executor.id,planning.executor.digest]])await new ProviderEligibility(db).publish(principal,project,{accountId,expectedRevision:0,plan:'deterministic lab',adapterId:id,adapterVersion:version,authenticationMode:'synthetic',executionMode:'synthetic',sourceURL:'https://example.invalid/r3-flow',status:'documented_supported',reason:'Explicit disposable fixture',reviewedAt:new Date().toISOString(),validForSeconds:3600});
  const prior=(await db.pool.query('SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 AND revision=$2',[project,revision])).rows[0].snapshot;
  const policyRevision=await capacity.publish(principal,project,revision,{...prior,roles:{...prior.roles,manager:{regular:[managerProfile],emergency:[]}}});await capacity.assignPolicy(principal,context,policyRevision);
  const qaContract=NativeQaContract.parse({schemaVersion:1,id:'r3-flow-qa',image,argv:['/usr/local/bin/node','-e',"const fs=require('fs'); const names=['alpha','beta','gamma'].filter(n=>fs.existsSync('/work/src/'+n)); if(!names.length)process.exit(1); for(const n of names)if(!fs.readFileSync('/work/src/'+n+'/a.ts','utf8').startsWith('// synthetic src/'))process.exit(2); console.log('physical QA passed '+names.join(','))"],environment:['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','NODE_VERSION=22.23.3','YARN_VERSION=1.22.22','HOME=/tmp'],timeoutMs:15000,memoryBytes:268435456,pids:64,nanoCpus:1000000000});
  const qualityRevision=await options.quality.publish(principal,project,1,{schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:false,verifierDigest:nativeReviewVerifierDigest,qaVerifierDigest:nativeQaContractDigest(qaContract)});
  await new Templates(db).publish(principal,context,0,{workflow:'semantic-proposal-v1',qualityRevision,targetRef:'refs/heads/protected'});await new ContextKeys(db).authorize(principal,context,1,'legacy',keyFingerprint(key));
  const authority=await db.acquire(principal,context,randomUUID(),'r3-fixture-manager',60);managerHeartbeat=setInterval(()=>{void db.heartbeat(authority).catch(()=>{});},2000);
  const nativeQa=new NativeQa(db,options.quality,repo,qaRoot,qaContract,options.verifierKey,undefined,undefined,resourceEnvelope),nativeImplementation=new NativeImplementation(db,repo,options.quality,[supervisor]),nativeVerification=new NativeVerification(db,options.quality,[supervisor],options.verifierKey);
  runtime=new CezarRuntime(db,repo,project,{...options,allowedTargets:['refs/heads/protected'],nativeQa,nativeVerification},undefined,undefined,{nativeExecutions:[supervisor],nativeImplementation,nativePlanning:[planning]});await runtime.start();
  const semantic=new SemanticPlanning(db,planning.executor);endpoint=new HappierEndpoint(db,runtime,boundary,{baseUrl:url,token,key,principal,sessionId:session,machineId,authority,semanticPlanning:semantic});await endpoint.start();
  let completionAckLost=false;const realAck=endpoint.ack.bind(endpoint);
  endpoint.ack=async(event,data)=>{const result=await realAck(event,data);if(event==='message'&&!completionAckLost){const payload=data as {message?:string};if(payload.message){const decoded=boundary.decrypt(key,'legacy',boundary.decodeBase64(payload.message));if(JSON.stringify(decoded).includes('"kind":"completion"')){completionAckLost=true;throw Error('FIXTURE_COMPLETION_ACK_LOST_AFTER_SERVER_WRITE');}}}return result;};
  const deviceId=randomUUID(),operator=generateKeyPairSync('ed25519');await new Operators(db).enroll(principal,principal,deviceId,operator.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const installation=(await db.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0].id;
  const environmentCommand={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.environments.configure' as const,payload:{projectId:project,expectedRevision:0,config:{sourceBranch:'refs/heads/main',environments:[{id:'lab',label:'Combined lab',targetRef:'refs/heads/protected',authorizedDirectories:['src'],destinations:[{id:'local',label:'Local repository',kind:'local_repository' as const}]}]}}};
  const environmentProof={deviceId,expiresAt:Date.now()+120000};
  await new ProjectEnvironments(db,[{id:'flow',path:area}],join(area,'environment-private')).configure(principal,environmentCommand,{...environmentProof,signature:sign(null,Buffer.from(operatorMessage(principal,environmentCommand,environmentProof,installation)),operator.privateKey).toString('hex')});
  const models=(await db.pool.query('SELECT DISTINCT p.account_id,p.model FROM ac_profiles p JOIN ac_account_access a ON a.account_id=p.account_id WHERE a.project_id=$1',[project])).rows;
  for(const profile of models)await capacity.observeModelQuota(principal,profile.account_id,profile.model,{status:'available',source:'synthetic://r4-combined-model-scope',ttlSeconds:3600});
  assert.equal((await db.pool.query('SELECT ac_profile_quota_status($1,$2) status',[execAccount,'unobserved-fixture-model'])).rows[0].status,'unknown');
  evidence.scopedQuota={unknownModelUnavailable:true,models:models.map(row=>row.model).sort(),mode:'model',source:'deterministic fixture observation'};
  const verifyBearer=async(request:Request)=>{const authorization=request.headers.get('authorization');if(!authorization?.startsWith('Bearer '))return null;const response=await fetch(url+'/v1/account/profile',{headers:{authorization},signal:AbortSignal.timeout(5000)});if(!response.ok)return null;const identity=await response.json() as {id:string};return identity.id;};
  const origin='http://127.0.0.1:18889',browserSessions=new BrowserSessions(db,randomBytes(32),verifyBearer,{origin,secure:false,maxAgeSeconds:600});
  const createProduct=()=>createApi(db,runtime!,verifyBearer,id=>id===context?authority:undefined,undefined,undefined,browserSessions);let product=createProduct();
  const browserLogin=await product.request('/api/v1/ac/auth/session',{method:'POST',headers:{authorization:'Bearer '+token,origin}});assert.equal(browserLogin.status,200);
  const cookie=browserLogin.headers.get('set-cookie')!.split(';')[0];

  const request=async(path:string,command:Record<string,unknown>,signed=false)=>{const proof={deviceId,expiresAt:Date.now()+120000};const headers:Record<string,string>={cookie,origin,'content-type':'application/json'};if(signed)headers['x-ac-operator-proof']=Buffer.from(JSON.stringify({...proof,signature:sign(null,Buffer.from(operatorMessage(principal,command,proof,installation)),operator.privateKey).toString('hex')})).toString('base64url');return product.request(path,{method:'POST',headers,body:JSON.stringify(command)});};
  // Real encrypted request is admitted through the canonical Happier endpoint.
  const localId='r3-request-'+randomUUID(),accepted=await endpoint.accept({text:'Implement alpha and beta, then gamma after both; run tests and independent review.',localId});assert.equal((await endpoint.accept({text:'Implement alpha and beta, then gamma after both; run tests and independent review.',localId})).result.intentId,accepted.result.intentId);
  await until(async()=>Number((await db.pool.query('SELECT count(*) n FROM ac_manager_plans WHERE context_id=$1',[context])).rows[0].n)===1,()=>JSON.stringify(endpoint?.lastError));
  const proposal=(await db.pool.query('SELECT revision,digest FROM ac_manager_plans WHERE context_id=$1',[context])).rows[0];
  const planningPhysical=new FlowDockerDaemon();for(const job of (await db.pool.query('SELECT id,container_id FROM ac_native_planning_jobs WHERE context_id=$1',[context])).rows)await until(async()=>await planningPhysical.inspect(job.container_id)===null,()=>"PRODUCT_TERMINAL_PLANNING_CONTAINER_REMAINS",30000);evidence.productPlanningRetirementConfirmed=true;
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_native_execution_jobs')).rows[0].n,0,'proposal never starts implementation');
  const executionTemplate={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,action:'template.publish',payload:{expectedRevision:1,template:{workflow:'engineering-native-v1',qualityRevision,targetRef:'refs/heads/protected',writePaths:['src'],execution:'plan'}}};
  const configured=await request('/api/v1/ac/control',executionTemplate,true);assert.equal(configured.status,200,await configured.clone().text());
  const command={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'managed-synthetic-v1',messageRef:'message:r3-approved-plan',proposalRevision:proposal.revision,proposalDigest:proposal.digest,native:true}};
  assert.equal((await product.request('/api/v1/ac/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(command)})).status,401);
  eventProbe=startCommittedEventProbe({ledger:db,contextId:context,fetchEvents:async()=>product.request('/api/v1/ac/contexts/'+context+'/events',{headers:{cookie,origin}}),samples:10,timeoutMs:90000});await eventProbe.ready;
  const measured=await measureCommandRequests(value=>request('/api/v1/ac/commands',value),command,8);evidence.commandLatency=measured.report;
  const response=measured.response;const started=await response.json() as {intentId:string;runId:string};
  await until(async()=>{const status=runtime!.store.getRun(started.runId)?.status;if(status==='failed')throw Error('COMBINED_POSITIVE_RUN_FAILED');return status==='done';},()=>JSON.stringify({error:endpoint?.lastError,run:runtime?.store.getRun(started.runId)}));
  evidence.eventLatency=assertEventReport(await eventProbe.done);eventProbe.stop();
  const jobs=(await db.pool.query('SELECT id,role,state,receipt FROM ac_native_execution_jobs')).rows;assert.equal(jobs.filter(j=>j.role==='programmer').length,3);assert(jobs.filter(j=>j.role==='reviewer').length>=3);assert(jobs.every(j=>j.state==='completed'&&j.receipt));
  const qa=(await db.pool.query('SELECT state,receipt FROM ac_native_qa_jobs')).rows;assert(qa.length>=3&&qa.every(j=>j.state==='completed'&&j.receipt.exitCode===0));
  assert.notEqual(git('rev-parse','protected'),original);assert(git('show','protected:src/gamma/a.ts').startsWith('// synthetic'));
  const history=async()=>{const data=await api('/v1/sessions/'+session+'/messages?scope=main&limit=150');return data.messages.map((m:any)=>{const encrypted=typeof m.content==='string'?JSON.parse(m.content):m.content;assert.equal(encrypted.t,'encrypted');return boundary.decrypt(key,'legacy',boundary.decodeBase64(encrypted.c));});};
  await until(async()=>JSON.stringify(await history()).includes('"kind":"completion"'),()=>JSON.stringify(endpoint?.lastError),15000);
  const canonical=await history();assert(completionAckLost,'real server completed publication before injected ACK loss');assert.equal(canonical.filter((m:any)=>m?.meta?.agentControl?.kind==='completion').length,1);assert(JSON.stringify(canonical).includes('Implement alpha'));assert(JSON.stringify(canonical).includes('execução concluída'));assert.equal(canonical.filter((m:any)=>m?.role==='user').length,1);
  endpoint.close();endpoint=new HappierEndpoint(db,runtime,boundary,{baseUrl:url,token,key,principal,sessionId:session,machineId,authority,semanticPlanning:semantic});await endpoint.start();
  assert(JSON.stringify(endpoint.recoveredMessages).includes('Implement alpha'));assert(JSON.stringify(endpoint.recoveredMessages).includes('"kind":"completion"'));
  assert.equal((await endpoint.accept({text:'Implement alpha and beta, then gamma after both; run tests and independent review.',localId})).result.intentId,accepted.result.intentId);
  evidence.positive={planningJobs:(await db.pool.query('SELECT count(*)::int n FROM ac_native_planning_jobs')).rows[0].n,executionJobs:jobs.map(j=>({id:j.id,role:j.role,state:j.state})),qaJobs:qa.length,protectedCommit:git('rev-parse','protected'),capacity:'actual',eligibility:'actual',home:'actual',conversation:'real Happier E2EE',canonicalCompletion:true,publicationAckLoss:true,reconnectRecovered:true};
  // Start another approved plan, hold workers using their immutable fixture task
  // and cancel through the authenticated signed product endpoint.
  await endpoint.close();endpoint=undefined;
  const previousPlan=(await db.pool.query('SELECT snapshot FROM ac_manager_plans WHERE context_id=$1 AND revision=$2',[context,proposal.revision])).rows[0].snapshot;
  const heldPlan={...previousPlan,tasks:previousPlan.tasks.map((task:any)=>({...task,writePaths:['src/hold-'+task.id+'/a.ts']}))};
  const publishedHeld=await request('/api/v1/ac/contexts/'+context+'/manager-plans',{expectedRevision:proposal.revision,plan:heldPlan});assert.equal(publishedHeld.status,201,await publishedHeld.clone().text());const heldProposal=await publishedHeld.json() as {revision:number;digest:string};
  const cancelCommand={...command,intentId:randomUUID(),deliveryAttemptId:randomUUID(),payload:{...command.payload,proposalRevision:heldProposal.revision,proposalDigest:heldProposal.digest}};const cancellationResponse=await request('/api/v1/ac/commands',cancelCommand);assert.equal(cancellationResponse.status,202);const canceled=await cancellationResponse.json() as {intentId:string;runId:string};
  // Dispatch explicitly so the original same manager owns the graph while the
  // transport is stopped. Physical start still passes all supervisor gates.
  const cancelIntent=(await db.pool.query('SELECT * FROM ac_intents WHERE id=$1',[canceled.intentId])).rows[0];
  clearInterval(managerHeartbeat);managerHeartbeat=undefined;await runtime.close();runtime=undefined;
  const manifest=join(area,'controller.json');await writeFile(manifest,JSON.stringify({contract:'r3-flow-controller-v1',database:fixture.url,fixture:fixtureCapability,executionConfig,repo,project,qaRoot,qaContract,qualityRevision,verifierKey:Buffer.from(options.verifierKey).toString('base64'),authority,intentId:canceled.intentId}),{mode:0o600,flag:'wx'});
  controller=spawn(process.execPath,['--import','tsx',new URL('./fixtures/r3-flow-controller.ts',import.meta.url).pathname,manifest],{cwd:process.cwd(),env:{PATH:process.env.PATH!,HOME:area,TZ:'UTC'},stdio:['ignore','pipe','pipe']});let controllerOutput='';controller.stdout?.on('data',b=>{controllerOutput+=String(b);});controller.stderr?.on('data',b=>{controllerOutput+=String(b);});

  const {DockerDaemon}=await import('../src/sandbox-broker.ts');const physical=new DockerDaemon();let activeWorkers:string[]=[];
  await until(async()=>{const rows=(await db.pool.query("SELECT j.worker_id FROM ac_native_execution_jobs j JOIN ac_intents i ON i.id=j.intent_id WHERE i.parent_intent_id=$1 AND j.state='running'",[canceled.intentId])).rows;if(rows.length!==2)return false;for(const row of rows){const c=await physical.inspect(row.worker_id);if(!c?.State.Running)return false;}activeWorkers=rows.map(j=>j.worker_id);return true;},()=>JSON.stringify({controllerOutput,exit:controller?.exitCode}),30000);
  evidence.runningResourceMembers=await assertFlowResourceMembers(resourceEnvelope,activeWorkers);
  const pause={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,action:'context.pause',payload:{paused:true,expectedRevision:0}};assert.equal((await request('/api/v1/ac/control',pause,true)).status,200);
  controller.kill('SIGKILL');await new Promise(resolve=>controller!.once('exit',resolve));assert.equal(controller.signalCode,'SIGKILL');controller=undefined;
  for(const id of activeWorkers)assert((await physical.inspect(id))?.State.Running,'worker persists after controller SIGKILL');
  // A successor waits for the real PostgreSQL lease; no fixture lease mutation.
  await sleep(16000);const successor=await db.acquire(principal,context,randomUUID(),'r3-fixture-successor',60);assert.equal(successor.epoch,authority.epoch+1);
  Object.assign(authority,successor);
  runtime=new CezarRuntime(db,repo,project,{...options,allowedTargets:['refs/heads/protected'],nativeQa,nativeVerification},undefined,undefined,{nativeExecutions:[supervisor],nativeImplementation,nativePlanning:[planning]});await runtime.start();product=createProduct();
  assert.equal((await db.pool.query('SELECT paused FROM ac_contexts WHERE id=$1',[context])).rows[0].paused,true);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_native_execution_jobs j JOIN ac_intents i ON i.id=j.intent_id WHERE i.parent_intent_id=$1',[canceled.intentId])).rows[0].n,2);
  for(const id of activeWorkers)assert((await physical.inspect(id))?.State.Running);
  const cancel={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,action:'plan.cancel',payload:{intentId:canceled.intentId,planRevision:cancelIntent.plan_revision}};
  assert.equal((await request('/api/v1/ac/control',cancel)).status,403);
  const forged={deviceId,expiresAt:Date.now()+120000,signature:'0'.repeat(128)};
  assert.equal((await product.request('/api/v1/ac/control',{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-ac-operator-proof':Buffer.from(JSON.stringify(forged)).toString('base64url')},body:JSON.stringify(cancel)})).status,403);
  assert.equal((await product.request('/api/v1/ac/control',{method:'POST',headers:{cookie,origin:'http://evil.invalid','content-type':'application/json'},body:JSON.stringify(cancel)})).status,403);
  assert.equal((await db.pool.query('SELECT 1 FROM ac_plan_cancellations WHERE intent_id=$1',[canceled.intentId])).rowCount,0);

  const cancelResponse=await request('/api/v1/ac/control',cancel,true);assert.equal(cancelResponse.status,200,await cancelResponse.clone().text());
  await until(async()=>{await db.heartbeat(authority);await runtime!.reconcileCancellations(authority,principal);return (await db.pool.query('SELECT state FROM ac_plan_cancellations WHERE intent_id=$1',[canceled.intentId])).rows[0]?.state==='confirmed';},()=>JSON.stringify(runtime?.store.getRun(canceled.runId)),60000);
  const live=(await db.pool.query("SELECT count(*)::int n FROM ac_capacity_grants g JOIN ac_intents i ON i.id=g.intent_id WHERE (i.id=$1 OR i.parent_intent_id=$1) AND g.state<>'released'",[canceled.intentId])).rows[0].n;assert.equal(live,0);
  for(const id of activeWorkers)assert.equal(await physical.inspect(id),null,'confirmed cancellation removed the original worker');
  const canceledWriters=(await db.pool.query('SELECT state FROM ac_worktree_writers WHERE parent_intent_id=$1',[canceled.intentId])).rows;assert.equal(canceledWriters.length,2);assert(canceledWriters.every(row=>row.state==='neutralized'));
  assert.equal(git('rev-parse','protected'),(evidence.positive as {protectedCommit:string}).protectedCommit,'canceled plan cannot integrate');
  const guards=(await db.pool.query("SELECT tgname,tgenabled FROM pg_trigger WHERE tgname='ac_dormant_provider_mode_guard'")).rows;assert(guards.length===1&&guards[0].tgenabled==='O');assert((await db.pool.query("SELECT 1 FROM ac_accounts WHERE mode<>'synthetic'")).rowCount===0);
  let scannedFiles=0,toolWrites=0,toolReadonlyDenials=0,toolCapabilityDenials=0;async function scan(directory:string){for(const entry of await readdir(directory,{withFileTypes:true})){if(entry.name==='.git')continue;const path=join(directory,entry.name);if(entry.isDirectory())await scan(path);else if(entry.isFile()){const content=await readFile(path);assert(!content.includes(Buffer.from(canary)),'SYNTHETIC_CANARY_LEAK_IN_GENERATED_FILE');toolWrites+=content.toString().split('R3_REAL_EXEC_SERVER_WRITE_READ_OK').length-1;toolReadonlyDenials+=content.toString().split('R3_REAL_EXEC_SERVER_READONLY_DENIED').length-1;toolCapabilityDenials+=content.toString().split('R3_REAL_EXEC_SERVER_BAD_CAPABILITY_REFUSED').length-1;scannedFiles++;}}}
  for(const root of [spool,planRoot,qaRoot])await scan(root);
  for(const path of git('ls-tree','-r','--name-only','protected').split('\n').filter(Boolean))assert(!git('show','protected:'+path).includes(canary),'SYNTHETIC_CANARY_LEAK_IN_ARTIFACT');
  assert(!JSON.stringify(await history()).includes(canary),'SYNTHETIC_CANARY_LEAK_IN_CANONICAL_CHAT');
  assert(toolWrites>=3&&toolReadonlyDenials>=4&&toolCapabilityDenials>=7,'REAL_EXEC_SERVER_LOG_PROOF_REQUIRED');Object.assign(evidence.tools as object,{writeReadProofs:toolWrites,readOnlyRefusals:toolReadonlyDenials,badCapabilityRefusals:toolCapabilityDenials,accountHomeAbsent:true});
  evidence.secretCanary={synthetic:true,surfaces:['execution/planning requests, launches, outputs and retained logs','QA retained logs','protected Git artifact files','decrypted canonical Happier messages'],generatedFilesScanned:scannedFiles,wrongOwnerRefused:true,leaks:0,excluded:['vault (not configured)','portable export (not exercised)','real provider secrets']};
  const bindings=(await db.pool.query('SELECT b.intent_id,b.revision,b.environment_id FROM ac_project_environment_bindings b JOIN ac_intents i ON i.id=b.intent_id WHERE i.context_id=$1',[context])).rows;
  assert(bindings.length>=5);assert(bindings.every(row=>row.revision===1&&row.environment_id==='lab'));const sources=(await db.pool.query('SELECT s.source_commit FROM ac_project_environment_sources s JOIN ac_intents i ON i.id=s.parent_intent_id WHERE i.context_id=$1',[context])).rows;assert.equal(sources.length,2);assert(sources.every(row=>row.source_commit===original));evidence.environment={revision:1,id:'lab',sourceCommit:original,boundIntents:bindings.length};
  const cancelAdmissions=(await db.pool.query("SELECT r.state FROM ac_native_resource_admissions r JOIN ac_capacity_grants g ON g.id=r.grant_id JOIN ac_intents i ON i.id=g.intent_id WHERE i.id=$1 OR i.parent_intent_id=$1",[canceled.intentId])).rows;assert(cancelAdmissions.length>=2);assert(cancelAdmissions.every(row=>row.state!=='waiting'&&row.state!=='uncertain'));
  const admissions=(await db.pool.query('SELECT state,count(*)::int n FROM ac_native_resource_admissions GROUP BY state')).rows;assert(admissions.length>0);evidence.resourceAdmissions=admissions;
  evidence.cancel={authenticated:'real Happier bearer → encrypted browser session → Origin cookie',signed:true,paused:true,controllerSigkill:true,successorEpoch:authority.epoch,physicallyRunningBeforeRequest:activeWorkers.length,confirmed:true,remainingGrants:live};console.log(JSON.stringify(evidence));

 }catch(error){primary=error;}finally{
  if(managerHeartbeat)clearInterval(managerHeartbeat);eventProbe?.stop();
  if(controller?.pid&&controller.exitCode===null&&controller.signalCode===null){controller.kill('SIGKILL');await new Promise(resolve=>controller!.once('exit',resolve));}
  endpoint?.close();const errors:unknown[]=[];try{await runtime?.close();}catch(e){errors.push(e);}
  try{const plans=(await db.pool.query('SELECT container_id FROM ac_native_planning_jobs')).rows;for(const j of plans)if(j.container_id){try{execFileSync('docker',['rm','-f',j.container_id],{stdio:'ignore'});}catch{}}
   const {DockerDaemon}=await import('../src/sandbox-broker.ts');const docker=new DockerDaemon();for(const j of (await db.pool.query('SELECT id FROM ac_native_qa_jobs')).rows){const c=await docker.inspect('ac-native-qa-'+j.id);if(c){assert.equal(c.Config.Labels['agent-control.job'],j.id);assert.equal(c.Image,image);if(c.State.Running)await docker.stop(c.Id);await docker.remove(c.Id);}}
   await cleanupGraphResources(db,image!);if(resourceEnvelope)evidence.resourceRetirement=await retireFlowResources(resourceEnvelope,area);
  }catch(e){errors.push(e);}mock.restoreAll();try{await db.close();await fixture.close();await rm(area,{recursive:true,force:true});}catch(e){errors.push(e);}if(errors.length)throw new AggregateError(primary?[primary,...errors]:errors,'R3_FLOW_CLEANUP_FAILED');
 }if(primary)throw primary;
 if(process.env.AC_R3_FLOW_EVIDENCE)await writeFile(process.env.AC_R3_FLOW_EVIDENCE,JSON.stringify(evidence,null,2)+'\n');
});
