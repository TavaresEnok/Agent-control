import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import nacl from 'tweetnacl';
import {Ledger} from '../src/ledger.ts';
import {Notifications,type OutgoingMessage} from '../src/notifications.ts';
import {loadHappier} from '../src/happier.ts';
import {exportContext} from '../src/context-export-cli.ts';
import type {Installation} from '../src/installation.ts';
import {digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {RecoveryHappier} from './fixtures/r3-happier-recovery.ts';

/** No model, inference, bundler, provider or execution fixture. Actual canonical
 * Happier socket writes and HTTP pagination are the integration under test. */
test('R4 actual Happier groups notifications and resumes ACK loss; CLI v2 exports complete encrypted paginated history',{timeout:60000},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const native=await loadHappier();
 const database=await isolatedDatabase(base,'r4noticecli'),ledger=new Ledger(database.url),folder=await mkdtemp('/tmp/ac-r4-notice-cli-');
 const service=new RecoveryHappier(join(folder,'happier'),join(folder,'home')),key=randomBytes(32),identity=nacl.sign.keyPair.fromSeed(randomBytes(32));
 const seal=(value:unknown)=>native.encodeBase64(native.encrypt(key,'legacy',value)),decode=(ciphertext:string)=>native.decrypt(key,'legacy',native.decodeBase64(ciphertext)) as any;
 let wire:ReturnType<typeof native.createSessionSocketTransport>|undefined;
 try{
  await service.start();const b64=(value:Uint8Array)=>Buffer.from(value).toString('base64'),challenge=randomBytes(32);
  const auth=await fetch(service.origin+'/v1/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({publicKey:b64(identity.publicKey),challenge:b64(challenge),signature:b64(nacl.sign.detached(challenge,identity.secretKey))}),signal:AbortSignal.timeout(5000)});assert.equal(auth.status,200);
  const token=(await auth.json() as any).token as string;
  const api=async(path:string,payload?:unknown)=>{const response=await fetch(service.origin+path,{method:payload?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:payload?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(5000)});assert(response.ok,'local Happier HTTP '+response.status);return response.json() as Promise<any>;};
  const principal=(await api('/v1/account/profile')).id as string,machineId=randomUUID();
  await api('/v1/machines',{id:machineId,metadata:seal({host:'r4-disposable',platform:'linux',happyCliVersion:'0.2.18',homeDir:folder}),daemonState:seal({status:'running',startedAt:Date.now()})});
  const session=(await api('/v1/sessions',{tag:'r4-notice-cli-'+randomUUID(),encryptionMode:'e2ee',metadata:seal({machineId,path:folder,host:'r4-disposable',homeDir:folder,version:'0.2.18',name:'R4 notices',flavor:'codex',startedBy:'terminal',startedFromDaemon:false}),agentState:seal({controlledByUser:false,requests:{},completedRequests:{}})})).session.id as string;
  const connect=async()=>{const transport=native.createSessionSocketTransport({token,sessionId:session,machineId,serverUrl:service.origin,transports:['websocket']});await transport.transport.connect();
   // Production receivePending establishes current machine runtime ownership
   // before transcript publishing; a bare authenticated socket has no authority.
   const request=native.SessionRuntimeActivitySnapshotRequestSchema.parse({sessionId:session,mutationId:randomUUID(),snapshot:{state:'idle',activeCount:0}});
   const snapshot=await new Promise<any>((resolve,reject)=>transport.socket.timeout(5000).emit(native.SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT,request,(error:Error|null,ack:unknown)=>error?reject(error):resolve(ack)));
   assert(['applied','unchanged'].includes(snapshot.status));return transport;};
  wire=await connect();
  const realPublish=(message:OutgoingMessage)=>new Promise<any>((resolve,reject)=>wire!.socket.timeout(5000).emit('message',{sid:session,message:message.ciphertext,localId:message.localId,echoToSender:true},(error:Error|null,ack:unknown)=>error?reject(error):resolve(ack)));
  await ledger.migrate();const project=randomUUID();await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'R4 notices and export']);await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const context=await ledger.createContext(principal,project,session),authority=await ledger.acquire(principal,context,randomUUID(),'r4-notice-manager',60),policy={completionWindowMs:0,maxBatchSize:20,maxDeliveriesPerTick:10};
  let notices=new Notifications(ledger,policy);const observations=[1,2].map(planRevision=>({entityId:randomUUID(),source:'runtime' as const,planRevision,seq:1,status:'done' as const}));
  for(const observation of observations)await notices.observe(principal,authority,session,observation);
  assert.equal((await notices.observe(principal,authority,session,{...observations[0],seq:2})).duplicate,true);
  await notices.observe(principal,authority,session,{entityId:randomUUID(),source:'runtime',planRevision:3,seq:1,status:'waiting',reason:'STORAGE_LOW_SPACE'});
  assert.deepEqual(await notices.flush(principal,authority,session,seal),{messages:2,observations:3});
  const outbox=(await ledger.pool.query('SELECT id,ciphertext FROM ac_chat_messages WHERE session_id=$1 ORDER BY priority DESC,sequence',[session])).rows;
  assert.equal(outbox.length,2);const grouped=decode(outbox[1].ciphertext);assert.equal(grouped.meta.agentControl.kind,'completion');assert.equal(grouped.meta.agentControl.itemIds.length,2);
  let lost=false,originalAck:any;
  await assert.rejects(notices.deliver(principal,authority,session,async message=>{const ack=await realPublish(message);if(decode(message.ciphertext).meta.agentControl.kind==='completion'&&!lost){lost=true;originalAck=ack;throw Error('FIXTURE_REAL_SERVER_WROTE_ACK_LOST');}return ack;}),/REAL_SERVER_WROTE_ACK_LOST/);
  assert(lost);assert.equal((await ledger.pool.query('SELECT count(*)::int n FROM ac_chat_publication_receipts WHERE session_id=$1',[session])).rows[0].n,1);
  assert.equal((await ledger.pool.query('SELECT sent FROM ac_chat_messages WHERE id=$1',[outbox[1].id])).rows[0].sent,false);
  wire.socket.disconnect();wire=await connect();notices=new Notifications(ledger,policy);let retryAck:any;
  assert.deepEqual(await notices.deliver(principal,authority,session,async message=>{retryAck=await realPublish(message);assert.equal(message.ciphertext,outbox[1].ciphertext);return retryAck;}),{sent:1});
  assert.equal(retryAck.didWrite,false);assert.equal(retryAck.id,originalAck.id);assert.equal(retryAck.seq,originalAck.seq);assert.equal(retryAck.localId,originalAck.localId);
  const receipt=(await ledger.pool.query('SELECT * FROM ac_chat_publication_receipts WHERE message_id=$1',[outbox[1].id])).rows[0];assert.equal(receipt.local_id,retryAck.localId);assert.equal(receipt.provider_message_id,retryAck.id);assert.equal(Number(receipt.provider_seq),retryAck.seq);
  assert.deepEqual(await notices.deliver(principal,authority,session,realPublish),{sent:0});assert.deepEqual(await notices.flush(principal,authority,session,seal),{messages:0,observations:0});
  // More than150 canonical messages forces the unchanged CLI history paginator
  // to collect a second real page, not a synthetic transport list.
  for(let index=0;index<151;index++){const localId='r4-history-'+index;const ack=await realPublish({id:session+'|'+localId,localId,ciphertext:seal({role:'user',content:{type:'text',text:'CLI_PLAINTEXT_CANARY_'+index}})});assert.equal(ack.ok,true);}
  const firstPage=await api('/v1/sessions/'+session+'/messages?scope=main&limit=150');assert.equal(firstPage.hasMore,true);assert.equal(firstPage.messages.length,150);
  // Portable controller metadata fixtures are deliberately not admitted work:
  // no account, grant, accepted intent, worker or model is created.
  const capacityPolicy={schemaVersion:1,maxProgrammersPerContext:2,maxEvaluatorsPerContext:1,roles:{programmer:{regular:[randomUUID()],emergency:[randomUUID()]}}};
  await ledger.pool.query('INSERT INTO ac_policy_revisions(project_id,revision,snapshot,digest,published_by) VALUES($1,1,$2,$3,$4)',[project,capacityPolicy,digest(capacityPolicy),principal]);
  const plan={schemaVersion:1,contextId:context,objectiveRef:'message:CLI_METADATA_CANARY',sourceMessageRef:'message:CLI_METADATA_CANARY',constraintRefs:[],tasks:Array.from({length:64},(_,index)=>({
   id:'cli-task-secret-'+index,objectiveRef:'message:CLI_METADATA_CANARY',acceptanceRefs:['acceptance:CLI_METADATA_CANARY'],inputRefs:[],outputRefs:['output:CLI_METADATA_CANARY'],dependsOn:index?['cli-task-secret-'+(index-1)]:[],writePaths:Array.from({length:64},(_,j)=>'src/CLI_METADATA_CANARY_'+index+'_'+j+'.ts'),qualityRevision:1,targetRef:'refs/heads/CLI_METADATA_CANARY',maxCorrections:1}))};
  const compilation={schemaVersion:1,workflow:{steps:[{id:'implementation',prompt:'CLI_METADATA_CANARY'}],graph:{nodes:[{id:'implementation',type:'agent',prompt:'CLI_METADATA_CANARY'}],edges:[]}},bindings:[]};
  await ledger.pool.query('INSERT INTO ac_manager_plans(context_id,revision,parent_revision,manager_epoch,manager_instance_id,principal_id,digest,snapshot,compilation_digest,compilation) VALUES($1,1,NULL,$2,$3,$4,$5,$6,$7,$8)',[context,authority.epoch,authority.instanceId,principal,digest(plan),plan,digest(compilation),compilation]);
  const repo=join(folder,'repo'),privateDirectory=join(folder,'private');await mkdir(repo,{mode:0o700});await mkdir(privateDirectory,{mode:0o700});
  const tokenFile=join(privateDirectory,'token'),outputFile=join(privateDirectory,'context.json'),descriptor=join(privateDirectory,'export.json');await writeFile(tokenFile,token,{mode:0o600});await writeFile(descriptor,JSON.stringify({contextId:context,tokenFile,outputFile}),{mode:0o600});
  const config={project:{id:project,repo,owner:principal},projects:[],happier:{upstreamOrigin:service.origin}} as unknown as Installation;
  const result=await exportContext(config,ledger,descriptor);assert.equal(result.messageCount,153);assert.equal(result.metadataTruncated,false);
  const bytes=await readFile(outputFile),output=JSON.parse(bytes.toString()),{digest:actualDigest,...envelope}=output;assert.equal(actualDigest,digest(envelope));assert.equal(output.schemaVersion,2);assert.equal(output.metadata.schemaVersion,2);assert.equal(output.messages.length,153);assert.equal(output.keysIncluded,false);
  assert.deepEqual(output.metadata.sections.capacityPolicies[0].policy,capacityPolicy);
  assert.equal(output.metadata.sections.managerPlans[0].plan.tasks.length,64);assert.equal(output.metadata.sections.managerPlans[0].plan.tasks[0].writePaths.length,64);
  assert.equal(output.metadata.sections.managerPlans[0].sourceDigest,digest(plan));assert(output.metadata.manifest.find((section:any)=>section.section==='managerPlans').bytes>256*1024);
  assert(!bytes.includes(Buffer.from('CLI_METADATA_CANARY')));assert(!bytes.includes(Buffer.from('cli-task-secret')));
  assert.equal((await stat(outputFile)).mode&0o777,0o600);
  assert(!bytes.includes(Buffer.from(token)));assert(!bytes.includes(key));assert(!bytes.includes(Buffer.from(key.toString('base64'))));assert(!bytes.includes(Buffer.from('CLI_PLAINTEXT_CANARY')));
  const completions=output.messages.map((message:any)=>decode(message.ciphertext)).filter((message:any)=>message?.meta?.agentControl?.kind==='completion');assert.equal(completions.length,1);assert.equal(completions[0].meta.agentControl.itemIds.length,2);
  assert.deepEqual(output.messages.map((m:any)=>m.seq),Array.from({length:153},(_,i)=>i+1));assert.equal(new Set(output.messages.map((m:any)=>m.localId)).size,153);
  assert.equal((await ledger.pool.query('SELECT count(*)::int n FROM ac_portable_export_snapshots WHERE principal_id=$1',[principal])).rows[0].n,0,'successful CLI releases temporary metadata cut');
  await assert.rejects(exportContext(config,ledger,descriptor),/EEXIST/);assert.deepEqual(await readFile(outputFile),bytes);
  assert.equal((await ledger.pool.query('SELECT count(*)::int n FROM ac_portable_export_snapshots WHERE principal_id=$1',[principal])).rows[0].n,0,'CLI failure leaves no temporary metadata cut');
  console.log('R4_NOTICE_CLI_PROOF '+JSON.stringify({canonicalMessages:153,historyPages:2,groupedCompletions:2,canonicalCompletionMessages:1,realAckLoss:true,reconnected:true,stableLocalId:true,metadataVersion:2,oversizedMetadataRecord:true,fullFallbackPolicy:true,outputPrivate:true,keysIncluded:false,snapshotsRemaining:0,inference:false}));
 }finally{wire?.socket.disconnect();await service.stop();key.fill(0);identity.secretKey.fill(0);await ledger.close();await database.close();await rm(folder,{recursive:true,force:true});}
});
