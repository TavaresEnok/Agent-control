import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,generateKeyPairSync} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import nacl from 'tweetnacl';
import {Ledger} from '../../src/ledger.ts';
import {ContextKeys,keyFingerprint} from '../../src/context-keys.ts';
import {ContextVault} from '../../src/context-vault.ts';
import {ManagerRegistry} from '../../src/managers.ts';
import {loadHappier,HappierEndpoint} from '../../src/happier.ts';
import {Capacity} from '../../src/capacity.ts';
import {QualityPolicies} from '../../src/quality-policy.ts';
import {composeSyntheticContextPlanning} from '../../src/context-switch.ts';
import {nativePlanningExecutorDigest} from '../../src/native-planning-supervisor.ts';
import {authorizeNativeSyntheticFixture} from '../../src/native-synthetic-fixture.ts';
import {AccountHomes} from '../../src/account-homes.ts';
import {ProviderEligibility} from '../../src/provider-eligibility.ts';
import {provisionFlowResources,retireFlowResources,type FlowResourceEnvelope} from '../../tests/fixtures/r3-flow-resources.ts';
import {CezarRuntime} from '../../src/cezar.ts';

test('canonical encrypted history survives manager profile restart with vault custody', {timeout:180000}, async()=>{
 const url=process.env.AC_TEST_DATABASE_URL,base=process.env.AC_TEST_HAPPIER_URL,images=[process.env.AC_R3_FLOW_IMAGE,process.env.AC_R6_FLOW_IMAGE2],network=process.env.AC_R3_FLOW_NETWORK,label=process.env.AC_R3_FLOW_LABEL;
 if(!url||!base||new URL(base).hostname!=='127.0.0.1'||!images[0]||!images[1]||!network||!label||images[0]===images[1])throw Error('ISOLATED_FIXTURE_REQUIRED');
 const root=await mkdtemp(join(tmpdir(),'ac-r6-history-')),db=new Ledger(url);let registry:ManagerRegistry|undefined,resourceEnvelope:FlowResourceEnvelope|undefined;
 try{
  await db.migrate();const key=randomBytes(32),b=await loadHappier(),pair=nacl.sign.keyPair.fromSeed(key),challenge=randomBytes(32),b64=(v:Uint8Array)=>Buffer.from(v).toString('base64');
  const auth=await fetch(base+'/v1/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({publicKey:b64(pair.publicKey),challenge:b64(challenge),signature:b64(nacl.sign.detached(challenge,pair.secretKey))})});assert.equal(auth.status,200);const {token}=await auth.json() as {token:string};
  async function api(path:string,body?:unknown):Promise<any>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});assert.equal(r.ok,true,`${path}: ${r.status}`);return r.json();}
  const principal=(await api('/v1/account/profile')).id,seal=(v:unknown)=>b.encodeBase64(b.encrypt(key,'legacy',v)),machineId=randomUUID();
  await api('/v1/machines',{id:machineId,metadata:seal({host:'fixture',platform:'linux',happyCliVersion:'0.2.18',homeDir:'/tmp/fixture'}),daemonState:seal({status:'running',startedAt:Date.now()})});
  const sessionId=(await api('/v1/sessions',{tag:'r6-'+randomUUID(),encryptionMode:'e2ee',metadata:seal({machineId,path:'/tmp/fixture',host:'fixture',homeDir:'/tmp/fixture',version:'0.2.18',name:'R6',flavor:'claude',startedBy:'terminal',startedFromDaemon:false}),agentState:seal({controlledByUser:false,requests:{},completedRequests:{}})})).session.id;
  const messages=['before 1','before 2'].map(text=>({role:'user',content:{type:'text',text}}));
  for(const message of messages)await api(`/v2/sessions/${sessionId}/messages`,{ciphertext:seal(message),localId:randomUUID()});
  const project=randomUUID();await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'R6 history']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const contextId=await db.createContext(principal,project,sessionId);await new ContextKeys(db).authorize(principal,contextId,1,'legacy',keyFingerprint(key));
  const installationId=(await db.pool.query('SELECT id FROM ac_installation_identity')).rows[0].id,vaultPath=join(root,'vault'),master=join(root,'master');await mkdir(vaultPath,{mode:0o700});await writeFile(master,randomBytes(32),{mode:0o600});
  const vault=new ContextVault(db,installationId,vaultPath,master,[]),request={principal,contextId,sessionId,profileId:'fixture-profile-1',keyVersion:1,encryptionVariant:'legacy' as const};await vault.importKey(request,key);
  const runtime=new CezarRuntime(db,root,project);let endpoint:HappierEndpoint|undefined;
  registry=new ManagerRegistry(db,project,input=>{endpoint=new HappierEndpoint(db,runtime,b,{baseUrl:base,token,key:input.key,principal,sessionId,machineId,authority:input.authority,transportOnly:true});return endpoint;});
  const first=await registry.startFromKeySource(request,vault);assert(endpoint);assert.deepEqual(endpoint.recoveredMessages,messages);
  const capacity=new Capacity(db);await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);await capacity.configure(principal,{programmingLimit:8,evaluationLimit:2});
  const accounts=[randomUUID(),randomUUID()],profiles=[randomUUID(),randomUUID()],models=['fixture-codex-a','fixture-codex-b'];
  for(let i=0;i<2;i++){
   await capacity.registerModel(principal,{provider:'synthetic-engineering',model:models[i],efforts:['high'],roles:['manager'],source:'synthetic://fixture'});
   await capacity.addAccount(principal,project,{id:accounts[i],provider:'synthetic-engineering',label:`Synthetic ${i}`,resourceIdentity:'synthetic-engineering:'+String(i+1).repeat(64),mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://fixture',maxConcurrent:1});
   await capacity.addProfile(principal,project,{id:profiles[i],accountId:accounts[i],model:models[i],effort:'high',role:'manager'});
   await capacity.observeQuota(principal,accounts[i],{status:'available',source:'synthetic://fixture',ttlSeconds:300});await capacity.observeModelQuota(principal,accounts[i],models[i],{status:'available',source:'synthetic://fixture',ttlSeconds:300});
  }
  const revision=await capacity.publish(principal,project,0,{schemaVersion:1,maxProgrammersPerContext:8,maxEvaluatorsPerContext:2,roles:{manager:{regular:profiles,emergency:[]}}});await capacity.assignPolicy(principal,contextId,revision);
  const qualityRevision=await new QualityPolicies(db).publish(principal,project,0,{schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:true,verifierDigest:'a'.repeat(64)});
  const homes=join(root,'homes'),spool=join(root,'planning');await mkdir(homes,{mode:0o700});await mkdir(spool,{mode:0o700});
  resourceEnvelope=await provisionFlowResources(root,images[0]!);const signingKeyPem=generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}).toString();
  const configs=[];
  for(let i=0;i<2;i++){
   const image=images[i]!,subjectDigest=String(i+1).repeat(64),id=`r6-planning-${i+1}`;
   const fixture=await authorizeNativeSyntheticFixture({contract:'native-synthetic-fixture-v1',projectId:project,contextId,provider:'synthetic-engineering',label,workerImage:image,toolsImage:image,providerNetworkId:network});
   await new AccountHomes(db,homes,[]).initialize(principal,project,accounts[i]);
   const config={resourceEnvelope,id,executorDigest:nativePlanningExecutorDigest(image),imageId:image,hostRoot:spool,accountRoot:homes,protectedRepositories:[],signingKeyPem,providerNetwork:network,accountSubjects:accounts.map((accountId,j)=>({accountId,subjectDigest:String(j+1).repeat(64)})),syntheticFixture:fixture};
   configs.push({config,fixture});
   await new ProviderEligibility(db).publish(principal,project,{accountId:accounts[i],expectedRevision:0,plan:'deterministic lab',adapterId:id,adapterVersion:config.executorDigest,authenticationMode:'synthetic',executionMode:'synthetic',sourceURL:'https://example.invalid/r6',status:'documented_supported',reason:'Explicit disposable fixture',reviewedAt:new Date().toISOString(),validForSeconds:3600});
  }
  async function plan(authority:typeof first,index:number){const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:revision,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
   const {planning}=composeSyntheticContextPlanning(db,{projectId:project,contextId},configs.map((entry,i)=>({...entry,active:i===index})));const id=randomUUID();
   const result=await planning.plan(principal,{id,intentId:intent.id,contextId,expectedRevision:index,sourceMessageRef:'message:fixture-request',qualityRevision,targetRef:'refs/heads/protected',knownReferences:['acceptance:fixture'],text:messages[index].content.text},authority);assert.equal(result.revision,index+1);
   const row=(await db.pool.query(`SELECT c.context_id,c.profile_id,c.selected_executor_id,c.selected_executor_digest,g.account_id,p.model,j.container_id,g.physical_receipt FROM ac_semantic_planning_calls c JOIN ac_capacity_grants g ON g.id=c.grant_id JOIN ac_profiles p ON p.id=c.profile_id JOIN ac_native_planning_jobs j ON j.id=c.id WHERE c.id=$1`,[id])).rows[0];
   assert.equal(row.context_id,contextId);assert.equal(row.profile_id,profiles[index]);assert.equal(row.account_id,accounts[index]);assert.equal(row.model,models[index]);assert.equal(row.selected_executor_id,configs[index].config.id);assert.equal(row.selected_executor_digest,configs[index].config.executorDigest);assert(row.container_id);assert(row.physical_receipt);assert.equal(row.physical_receipt.nativeSessionId,`r6-thread-${index+1}`);}
  await plan(first,0);
  const before=await api(`/v1/sessions/${sessionId}/messages?scope=main&limit=150`);
  const second=await registry.restartFromKeySource({...request,profileId:'fixture-profile-2'},vault);assert(endpoint);assert.deepEqual(endpoint.recoveredMessages,messages);assert.equal(second.contextId,first.contextId);assert(second.epoch>first.epoch);
  await capacity.observeQuota(principal,accounts[0],{status:'exhausted',source:'synthetic://fixture',ttlSeconds:300});await capacity.observeModelQuota(principal,accounts[0],models[0],{status:'exhausted',source:'synthetic://fixture',ttlSeconds:300});await plan(second,1);
  const after=await api(`/v1/sessions/${sessionId}/messages?scope=main&limit=150`);assert.deepEqual(after,before);assert.equal(before.messages.length,2);assert(before.messages.every((m:{seq:number},i:number,a:{seq:number}[])=>i===0||m.seq<a[i-1].seq));
  const link=await db.pool.query('SELECT context_id,session_id FROM ac_session_links WHERE context_id=$1',[contextId]);assert.equal(link.rows.length,1);assert.equal(link.rows[0].session_id,sessionId);
  const loaded=await vault.load(request);assert.equal(keyFingerprint(loaded),keyFingerprint(key));loaded.fill(0);
  const third={role:'user',content:{type:'text',text:'after restart'}};await api(`/v2/sessions/${sessionId}/messages`,{ciphertext:seal(third),localId:randomUUID()});
  await registry.restartFromKeySource({...request,profileId:'fixture-profile-2'},vault);assert(endpoint);assert.deepEqual(endpoint.recoveredMessages,[...messages,third]);
 }finally{try{await registry?.close();if(resourceEnvelope)await retireFlowResources(resourceEnvelope,root);}finally{await db.close();await rm(root,{recursive:true,force:true});}}
});
