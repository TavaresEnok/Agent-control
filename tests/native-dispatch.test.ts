import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,generateKeyPairSync,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {Quality} from '../src/quality.ts';
import {GitArtifacts} from '../src/git.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {NativeImplementation} from '../src/native-implementation.ts';
import {NativeExecutionSupervisor,NativeExecutionRequest} from '../src/native-execution-supervisor.ts';
import {NativeVerification,nativeReviewVerifierDigest} from '../src/native-verification.ts';
import {NativeQa,NativeQaContract,nativeQaContractDigest} from '../src/native-qa.ts';
import {ContextKeys,keyFingerprint} from '../src/context-keys.ts';
import {Templates} from '../src/templates.ts';
import {HappierEndpoint,loadHappier} from '../src/happier.ts';
import {digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {DockerDaemon} from '../src/sandbox-broker.ts';

test('canonical encrypted request follows the native Cezar graph through real QA and exact controlled integration',async()=>{
 const root=process.env.AC_NATIVE_DISPATCH_ROOT,base=process.env.AC_TEST_DATABASE_URL;if(!root||!base)throw Error('ISOLATED_NATIVE_CONTROLLER_REQUIRED');
 const fixture=await isolatedDatabase(base,'nativedispatch'),db=new Ledger(fixture.url),area=await mkdtemp(join(root,'fixture-'));let runtime:CezarRuntime|undefined,endpoint:HappierEndpoint|undefined;
 try{
  await db.migrate();const project=randomUUID(),principal='native-'+randomUUID(),account=randomUUID(),profiles={programmer:randomUUID(),qa:randomUUID(),reviewer:randomUUID()},session=randomUUID(),chatKey=randomBytes(32),signer=randomBytes(32);
  const repo=join(area,'repo'),spool=join(area,'native'),qaRoot=join(area,'qa'),accounts=join(area,'accounts');for(const p of [spool,qaRoot,accounts])await mkdir(p,{mode:0o700});
  execFileSync('git',['init',repo],{stdio:'ignore'});const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();git('config','user.name','Fixture');git('config','user.email','fixture@invalid');await mkdir(join(repo,'src'));await writeFile(join(repo,'src/example.ts'),'export const value = 1;\n');git('add','.');git('commit','-m','base');const sourceBase=git('rev-parse','HEAD');git('update-ref','refs/heads/protected',sourceBase);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'native graph fixture']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  const capacity=new Capacity(db);await capacity.configure(principal,{programmingLimit:8,evaluationLimit:2});await capacity.registerModel(principal,{provider:'fixture-native',model:'fixture-model',efforts:['medium'],roles:['programmer','qa','reviewer'],source:'synthetic://fixture'});
  await capacity.addAccount(principal,project,{id:account,provider:'fixture-native',label:'fixture metadata only',resourceIdentity:account,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://fixture',maxConcurrent:4});
  for(const [role,id] of Object.entries(profiles))await capacity.addProfile(principal,project,{id,accountId:account,model:'fixture-model',effort:'medium',role:role as 'programmer'|'qa'|'reviewer'});
  await capacity.observeQuota(principal,account,{status:'available',source:'synthetic://fixture',ttlSeconds:300});const context=await db.createContext(principal,project,session);
  const revision=await capacity.publish(principal,project,0,{schemaVersion:1,maxProgrammersPerContext:8,maxEvaluatorsPerContext:2,roles:{programmer:{regular:[profiles.programmer],emergency:[]},qa:{regular:[profiles.qa],emergency:[]},reviewer:{regular:[profiles.reviewer],emergency:[]}}});await capacity.assignPolicy(principal,context,revision);
  const image=JSON.parse(await readFile(join(root,'image.json'),'utf8')) as {id:string;environment:string[]};
  const qaContract=NativeQaContract.parse({schemaVersion:1,id:'native-value-check',image:image.id,argv:['/usr/local/bin/node','--experimental-strip-types','--input-type=module','-e',"import assert from 'node:assert/strict';const {value}=await import('/work/src/example.ts');assert.equal(value,2)"],environment:[...image.environment,'HOME=/tmp','CI=1'],timeoutMs:15000,memoryBytes:268435456,pids:64,nanoCpus:1000000000});
  const artifacts=new GitArtifacts(repo),quality=new Quality(db,signer,artifacts);await quality.publish(principal,project,0,{schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:false,verifierDigest:nativeReviewVerifierDigest,qaVerifierDigest:nativeQaContractDigest(qaContract)});
  await new Templates(db).publish(principal,context,0,{workflow:'engineering-native-v1',qualityRevision:1,targetRef:'refs/heads/protected',writePaths:['src/example.ts']});await new ContextKeys(db).authorize(principal,context,1,'legacy',keyFingerprint(chatKey));const authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  const keys=generateKeyPairSync('ed25519'),modelImage='sha256:'+'a'.repeat(64);
  const supervisor=new NativeExecutionSupervisor(db,{id:'fixture-model-native',workerImage:modelImage,toolsImage:modelImage,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:'b'.repeat(64),accountSubjects:[{accountId:account,subjectDigest:'c'.repeat(64)}],workerEnv:[],toolsEnv:[]});
  const physical=new Map<string,any>();let launches=0;const marker='PRIVATE AUTHORIZED REQUEST '+randomUUID();
  Object.defineProperty(supervisor,'docker',{value:{inspect:async(name:string)=>physical.get(name)??null,stop:async()=>{}}});
  // Test-only model substitute. The production supervisor's start eligibility
  // is not weakened; no account home, login or model CLI is used by this fixture.
  Object.defineProperty(supervisor,'start',{value:async(_principal:string,a:typeof authority,raw:unknown)=>{
   const input=NativeExecutionRequest.parse(raw);launches++;if(input.role==='programmer')assert.equal(JSON.parse(input.task).request,marker);
   const g=(await db.pool.query('SELECT g.*,p.model,p.effort FROM ac_capacity_grants g JOIN ac_profiles p ON p.id=g.profile_id WHERE g.id=$1',[input.grantId])).rows[0];
   const workerId=createHash('sha256').update(input.jobId+'worker').digest('hex'),toolsId=createHash('sha256').update(input.jobId+'tools').digest('hex'),inputDigest=digest(input),fingerprint=createHash('sha256').update(keys.publicKey.export({format:'der',type:'spki'})).digest('hex');
   await db.tx(async c=>{await db.authorize(c,principal,a.contextId);await db.fence(c,a);
   await c.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state,worker_id,tools_id,network_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,$14,'running',$15,$16,$17)`,[input.jobId,input.grantId,input.intentId,a.contextId,a.epoch,input.sessionId,g.account_id,g.profile_id,digest({accountId:g.account_id,profileId:g.profile_id,model:g.model,effort:g.effort,role:g.role}),supervisor.executorDigest,fingerprint,inputDigest,input.base,input.role,workerId,toolsId,'d'.repeat(64)]);
   await c.query("UPDATE ac_capacity_grants SET state='running' WHERE id=$1",[input.grantId]);
   if(input.role==='programmer')await c.query("UPDATE ac_operations SET state='uncertain',native_session_id=$2 WHERE id=$1",[input.jobId,input.sessionId]);else await c.query("UPDATE ac_stage_operations SET state='uncertain' WHERE id=$1",[input.jobId]);
   });
   const dir=join(spool,input.jobId);await mkdir(dir,{mode:0o700});await mkdir(join(dir,'output'),{mode:0o700});await writeFile(join(dir,'request.json'),JSON.stringify(input),{mode:0o600});let output='fixture implementation complete';
   if(input.role==='programmer'){await artifacts.snapshot(input.base,input.base,join(dir,'work'));await writeFile(join(dir,'work/src/example.ts'),'export const value = 2;\n');}
   else{const ar=(await db.pool.query('SELECT * FROM ac_artifacts WHERE id=$1',[input.artifactId])).rows[0];output=JSON.stringify({schemaVersion:1,kind:'review',artifactId:ar.id,policyRevision:ar.policy_revision,commit:ar.commit_id,tree:ar.tree_id,base:ar.base_id,verdict:'pass',findings:[]});}
   await writeFile(join(dir,'output/execution-result.json'),JSON.stringify({schemaVersion:1,jobId:input.jobId,output,normalizedTokensUsed:null,usageWindows:null,nativeSessionId:null,failureCode:null,exitCode:0}),{mode:0o600});
   const item=(id:string)=>({Id:id,Image:modelImage,Config:{Labels:{'agent-control.job':input.jobId,'agent-control.launch':inputDigest,'agent-control.contract':'native-execution-v1'}},State:{Status:'exited',Running:false,ExitCode:0,FinishedAt:new Date().toISOString()}});
   const w=item(workerId),t=item(toolsId);physical.set(workerId,w);physical.set(toolsId,t);physical.set('ac-native-worker-'+input.jobId,w);physical.set('ac-native-tools-'+input.jobId,t);
   if(input.role==='programmer')throw Error('FIXTURE_START_ACK_LOST');return {state:'running'};
  }});
  // A second registered executor belongs to another account. It must never
  // receive this account's work even when it appears first in the registry.
  const unrelated=new Proxy(supervisor,{get(target,key){if(key==='supportsAccount')return ()=>false;if(key==='keyFingerprint')return 'e'.repeat(64);if(key==='start')return ()=>{throw Error('WRONG_ACCOUNT_EXECUTOR');};return Reflect.get(target,key,target);}});
  const registry=[unrelated,supervisor];
  const native=new NativeImplementation(db,repo,quality,registry),nativeQa=new NativeQa(db,quality,repo,qaRoot,qaContract,signer),nativeVerification=new NativeVerification(db,quality,registry,signer);
  runtime=new CezarRuntime(db,repo,project,{quality,git:artifacts,verifierKey:signer,allowedTargets:['refs/heads/protected'],nativeQa,nativeVerification},undefined,undefined,{nativeExecutions:registry,nativeImplementation:native});await runtime.start();
  const boundary=await loadHappier();endpoint=Object.create(HappierEndpoint.prototype) as HappierEndpoint;
  Object.defineProperties(endpoint,{ledger:{value:db},runtime:{value:runtime},boundary:{value:boundary},options:{value:{baseUrl:'http://127.0.0.1',token:'synthetic',key:chatKey,principal,sessionId:session,machineId:'fixture',authority}},lifecycle:{value:new AbortController()},socket:{value:{connected:true,emit:()=>{},disconnect:()=>{}}},notifications:{value:{observe:async()=>{}}},receivePending:{value:async()=>{}},flushNotifications:{value:async()=>{}},deliverQueuedMessages:{value:async()=>{}},seal:{value:(v:unknown)=>boundary.encodeBase64(boundary.encrypt(chatKey,'legacy',v))}});
  const request={localId:'native-'+randomUUID(),text:marker};const accepted=await endpoint.accept(request);assert.equal((await endpoint.accept(request)).result.intentId,accepted.result.intentId);await assert.rejects(endpoint.accept({...request,text:'collision'}),/INTENT_PAYLOAD_CONFLICT/);
  let terminal=false;for(let i=0;i<150;i++){await endpoint.tick();const row=(await db.pool.query('SELECT state FROM ac_intents WHERE id=$1',[accepted.result.intentId])).rows[0];if(['done','failed','review'].includes(row.state)){if(row.state!=='done'){const i=(await db.pool.query('SELECT * FROM ac_intents WHERE id=$1',[accepted.result.intentId])).rows[0];const r=runtime.store.getRun(i.run_id);console.log(JSON.stringify({state:row.state,runStatus:r?.status,error:r?.error,steps:r?.steps.map(s=>({id:s.id,status:s.status,error:s.error})),operation:(await db.pool.query('SELECT state,receipt FROM ac_operations WHERE id=$1',[i.operation_id])).rows[0]}));}assert.equal(row.state,'done');terminal=true;break;}await new Promise(r=>setTimeout(r,200));}
  if(!terminal){const i=(await db.pool.query('SELECT * FROM ac_intents WHERE id=$1',[accepted.result.intentId])).rows[0];const run=runtime.store.getRun(i.run_id);console.log(JSON.stringify({intentState:i.state,runStatus:run?.status,error:run?.error,steps:run?.steps.map(s=>({id:s.id,status:s.status,error:s.error}))}));}
  assert(terminal,'NATIVE_GRAPH_NOT_COMPLETE');assert.equal(launches,2);const artifact=(await db.pool.query('SELECT * FROM ac_artifacts WHERE intent_id=$1',[accepted.result.intentId])).rows[0];assert.equal(git('rev-parse','refs/heads/protected'),artifact.commit_id);assert.equal(git('show','refs/heads/protected:src/example.ts'),'export const value = 2;');
  const evidence=(await db.pool.query('SELECT kind,status,session_id FROM ac_verification_evidence WHERE artifact_id=$1 ORDER BY kind',[artifact.id])).rows;assert.deepEqual(evidence.map(e=>[e.kind,e.status]),[['qa','passed'],['review','passed']]);assert.notEqual(evidence[0].session_id,evidence[1].session_id);
  const recorded=(await db.pool.query('SELECT * FROM ac_intents WHERE id=$1',[accepted.result.intentId])).rows[0];
  await assert.rejects(db.accept(principal,{...recorded.command,intentId:randomUUID(),deliveryAttemptId:randomUUID()},authority,'api'),/NATIVE_CANONICAL_MESSAGE_REQUIRED/);
  await assert.rejects(new Templates(db).publish(principal,context,1,{workflow:'engineering-native-v1',qualityRevision:1,targetRef:'refs/heads/protected',writePaths:['../outside']}));
  await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);
  const successor=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  const cleanup=native.bindSource(successor,async()=>marker);endpoint.close();assert(native.hasSource(successor));
  await assert.rejects(endpoint.accept({localId:'stale-'+randomUUID(),text:marker}),/STALE_MANAGER/);
  assert(await native.prepareRecovery(recorded,successor));assert.equal(launches,2);cleanup();
  // A missing target is a preparation failure, not a launched worker. Ensure
  // it cannot strand a global programmer slot or fabricate a QA verdict.
  const failedCommand={...recorded.command,intentId:randomUUID(),deliveryAttemptId:randomUUID()};
  const failedIntent=await db.accept(principal,failedCommand,successor,'happier',async()=>{});
  native.bindSource(successor,async()=>marker);git('update-ref','-d','refs/heads/protected');
  const failed=native.start(failedIntent,successor,{sessionId:randomUUID()} as Parameters<NativeImplementation['start']>[2]);
  await assert.rejects(failed.result);assert.equal(launches,2);
  const failedState=(await db.pool.query("SELECT o.state,g.state grant_state,g.physical_receipt FROM ac_operations o JOIN ac_capacity_grants g ON g.id=o.grant_id WHERE o.id=$1",[failedIntent.operation_id])).rows[0];
  assert.equal(failedState.state,'completed');assert.equal(failedState.grant_state,'released');assert.equal(failedState.physical_receipt.state,'not_started');
  assert.equal((await db.pool.query('SELECT 1 FROM ac_native_execution_jobs WHERE id=$1',[failedIntent.operation_id])).rowCount,0);
  git('update-ref','refs/heads/protected',artifact.commit_id);
  const snapshots=(await db.pool.query('SELECT command::text value FROM ac_intents UNION ALL SELECT snapshot::text FROM ac_native_task_inputs')).rows;assert(!JSON.stringify(snapshots).includes(marker));
  console.log(JSON.stringify({proof:'canonical-native-cezar-flow',encryptedSource:true,codeGeneration:'synthetic model substitute',qa:'real isolated Docker',review:'synthetic model substitute',gitIntegration:'real exact CAS',duplicateRequestDeduplicated:true,modelCalls:0}));
 }finally{endpoint?.close();await runtime?.close();const docker=new DockerDaemon();if((await db.pool.query("SELECT to_regclass('ac_native_qa_jobs') relation")).rows[0].relation)for(const j of (await db.pool.query('SELECT id FROM ac_native_qa_jobs')).rows){const p=await docker.inspect('ac-native-qa-'+j.id);if(p&&p.Config.Labels['agent-control.job']===j.id){if(p.State.Running)await docker.stop(p.Id);await docker.remove(p.Id);}}await db.close();await fixture.close();await rm(area,{recursive:true,force:true});}
});
