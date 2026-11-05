import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {io} from 'socket.io-client';
import {serve} from '@hono/node-server';
import nacl from 'tweetnacl';
import {Ledger} from '../src/ledger.ts';
import {Control} from '../src/control.ts';
import {Capacity} from '../src/capacity.ts';
import type {ProviderAdapter} from '../src/providers.ts';
import {Operators,operatorMessage} from '../src/operator.ts';
import {ContextKeys,keyFingerprint} from '../src/context-keys.ts';
import {loadHappier} from '../src/happier.ts';
import {ManagerRegistry,happierEndpointFactory} from '../src/managers.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {createApi} from '../src/api.ts';
import {chatConfigurationHandler} from '../src/chat-control.ts';

test('RF36 signed typed configuration through actual Happier equals panel control, including replay and transportOnly', {timeout:120000},async()=>{
 const database=process.env.AC_TEST_DATABASE_URL,base=process.env.AC_TEST_HAPPIER_URL;
 if(!database?.includes('/ac_implementation_test')||!base?.startsWith('http://127.0.0.1:'))throw Error('ISOLATED_HAPPIER_DATABASE_REQUIRED');
 const ledger=new Ledger(database);await ledger.migrate();
 const boundary=await loadHappier(),key=randomBytes(32),identity=nacl.sign.keyPair(),challenge=randomBytes(32),b64=(v:Uint8Array)=>Buffer.from(v).toString('base64');
 const authentication=await fetch(base+'/v1/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({publicKey:b64(identity.publicKey),challenge:b64(challenge),signature:b64(nacl.sign.detached(challenge,identity.secretKey))})});
 assert.equal(authentication.status,200);const {token}=await authentication.json() as {token:string};
 const canonical=async(path:string,body?:unknown)=>{
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  assert(response.ok);return response.json() as Promise<Record<string,any>>;
 };
 const principal=(await canonical('/v1/account/profile')).id as string,project=randomUUID(),machineId=randomUUID();
 const seal=(value:unknown)=>boundary.encodeBase64(boundary.encrypt(key,'legacy',value));
 await canonical('/v1/machines',{id:machineId,metadata:seal({host:'ac-r3-chat',platform:'linux',happyCliVersion:'0.2.18',homeDir:'/tmp/ac-r3-chat'}),daemonState:seal({status:'running',startedAt:Date.now()})});
 await mkdir('.state/projects',{recursive:true});const repo=await mkdtemp(resolve('.state/projects/ac-r3-chat-'));
 const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
 git('init','-q','-b','main');git('config','user.name','Synthetic fixture');git('config','user.email','fixture@example.invalid');await writeFile(join(repo,'README.md'),'synthetic chat control\n');git('add','.');git('commit','-qm','base');
 await mkdir(join(repo,'.ai/cezar'),{recursive:true});await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[],maxParallel:1,worktreeRetention:0}));
 await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'R3 typed chat']);await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
 const deviceId=randomUUID(),operator=generateKeyPairSync('ed25519');await new Operators(ledger).enroll(principal,principal,deviceId,operator.publicKey.export({format:'der',type:'spki'}).toString('base64'));
 const installation=(await ledger.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0].id;
 const proof=(command:Record<string,unknown>)=>{const data={deviceId,expiresAt:Date.now()+120000};return {...data,signature:sign(null,Buffer.from(operatorMessage(principal,command,data,installation)),operator.privateKey).toString('hex')};};
 const sessions:string[]=[],contexts:string[]=[];
 for(let i=0;i<2;i++){
  const session=(await canonical('/v1/sessions',{tag:'ac-r3-chat-'+randomUUID(),encryptionMode:'e2ee',metadata:seal({machineId,path:repo,host:'ac-r3-chat',homeDir:'/tmp/ac-r3-chat',version:'0.2.18',name:'Typed config '+i,flavor:'claude',startedBy:'terminal',startedFromDaemon:false}),agentState:seal({controlledByUser:false,requests:{},completedRequests:{}})})).session.id as string;
  sessions.push(session);const context=await ledger.createContext(principal,project,session);contexts.push(context);await new ContextKeys(ledger).authorize(principal,context,1,'legacy',keyFingerprint(key));
 }
 const adapter:ProviderAdapter={manifest:{id:'synthetic-chat-adapter',version:'1',provider:'synthetic-chat',mode:'synthetic',eligibility:'documented_supported',source:'synthetic://r3-chat-adapter',timeoutMs:1000},probe:async()=>{throw Error('PROBE_MUST_NOT_RUN')}};
 const accountId=randomUUID();await new Capacity(ledger).addAccount(principal,project,{id:accountId,provider:'synthetic-chat',label:'Chat fixture',resourceIdentity:'chat-'+accountId,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://r3-chat',maxConcurrent:1});
 const runtime=new CezarRuntime(ledger,repo,project),control=new Control(ledger,[adapter],project);
 const registry=new ManagerRegistry(ledger,project,happierEndpointFactory(ledger,runtime,boundary,{baseUrl:base,token,machineId,transportOnly:true,configurationControl:control}));
 const user=io(base,{path:'/v1/updates',transports:['websocket'],auth:{token,clientType:'user-scoped'}});
 const app=createApi(ledger,runtime,async request=>{
  const authorization=request.headers.get('authorization');if(!authorization)return null;
  const response=await fetch(base+'/v1/account/profile',{headers:{authorization}});return response.ok?(await response.json() as {id:string}).id:null;
 },context=>registry.authority(context),undefined,undefined,undefined,undefined,[adapter],undefined,undefined,undefined,undefined,control);
 const panel=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});
 try{
  await new Promise<void>((ok,fail)=>{user.once('connect',ok);user.once('connect_error',fail)});
  for(let i=0;i<2;i++)await registry.start({principal,contextId:contexts[i],sessionId:sessions[i],profileId:'synthetic-config',keyVersion:1,encryptionVariant:'legacy',key});
  const address=panel.address();assert(address&&typeof address!=='string');const panelBase='http://127.0.0.1:'+address.port;
  const rpc=async(index:number,params:unknown,method='agent-control.configure')=>{
   const response=await new Promise<any>((ok,fail)=>user.timeout(12000).emit('rpc-call',{method:sessions[index]+':'+method,params:seal(params),timeoutMs:10000},(error:Error|null,value:unknown)=>error?fail(error):ok(value)));
   if(!response.ok)return response;
   return boundary.decrypt(key,'legacy',boundary.decodeBase64(response.result)) as {ok:boolean;result?:unknown;error?:string};
  };
  const panelControl=async(command:Record<string,unknown>,signature=proof(command))=>fetch(panelBase+'/api/v1/ac/control',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','x-ac-operator-proof':Buffer.from(JSON.stringify(signature)).toString('base64url')},body:JSON.stringify(command)});
  const revision=Number((await ledger.pool.query('SELECT revision FROM ac_capacity_config WHERE id=1')).rows[0]?.revision??0);
  const command={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:contexts[0],action:'capacity.configure',payload:{programmingLimit:3,evaluationLimit:2,expectedRevision:revision}};
  const chat=await rpc(0,{command,proof:proof(command)});assert.equal(chat.ok,true);
  const replay={...command,deliveryAttemptId:randomUUID()},panelReplay=await panelControl(replay);assert.equal(panelReplay.status,200);assert.deepEqual(await panelReplay.json(),chat.result);
  const fromPanel={...command,intentId:randomUUID(),deliveryAttemptId:randomUUID(),payload:{programmingLimit:4,evaluationLimit:3,expectedRevision:revision+1}};
  const firstPanel=await panelControl(fromPanel);assert.equal(firstPanel.status,200);
  assert.deepEqual((await rpc(0,{command:{...fromPanel,deliveryAttemptId:randomUUID()},proof:proof(fromPanel)})).result,await firstPanel.json());
  const bindingCommand={...command,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'provider.bind',payload:{accountId,adapterId:adapter.manifest.id,expectedRevision:0,minimumIntervalSeconds:1}};
  const bound=await rpc(0,{command:bindingCommand,proof:proof(bindingCommand)});assert.equal(bound.ok,true);
  const boundReplay=await panelControl({...bindingCommand,deliveryAttemptId:randomUUID()});assert.equal(boundReplay.status,200);assert.deepEqual(await boundReplay.json(),bound.result);
  await registry.stop(contexts[0]);
  await registry.start({principal,contextId:contexts[0],sessionId:sessions[0],profileId:'synthetic-config',keyVersion:1,encryptionVariant:'legacy',key});
  assert.deepEqual((await rpc(0,{command:{...command,deliveryAttemptId:randomUUID()},proof:proof(command)})).result,chat.result);
  assert.equal((await rpc(0,{text:'configure programming limit 99'})).ok,false);
  assert.equal((await rpc(0,{command})).ok,false);
  assert.equal((await rpc(0,{command:{...fromPanel,intentId:randomUUID(),payload:{...fromPanel.payload,programmingLimit:99}},proof:proof(fromPanel)})).ok,false);
  const cross={...fromPanel,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:contexts[1],payload:{...fromPanel.payload,expectedRevision:revision+2}};
  assert.equal((await rpc(0,{command:cross,proof:proof(cross)})).ok,false);
  const disabled=await rpc(0,{text:'perform a task',localId:randomUUID()},'session.userMessage.send');
  assert.notEqual(disabled.ok,true);assert.match(JSON.stringify(disabled),/EXECUTION_DISABLED/);
  assert.equal((await ledger.pool.query('SELECT count(*) n FROM ac_control_intents WHERE context_id=ANY($1::uuid[])',[contexts])).rows[0].n,'3');
  assert.equal((await ledger.pool.query('SELECT count(*) n FROM ac_intents WHERE context_id=ANY($1::uuid[])',[contexts])).rows[0].n,'0');
  const binding={authority:registry.authority(contexts[0])!,principal,sessionId:sessions[0],keyVersion:1,encryptionVariant:'legacy' as const,keyFingerprint:keyFingerprint(key)};
  const direct=chatConfigurationHandler(control,binding),later={...fromPanel,intentId:randomUUID(),deliveryAttemptId:randomUUID(),payload:{...fromPanel.payload,expectedRevision:revision+2}};
  await ledger.pool.query("UPDATE ac_context_keys SET state='revoked' WHERE context_id=$1",[contexts[0]]);
  await assert.rejects(direct({command:later,proof:proof(later)}),/CONTEXT_KEY_UNAUTHORIZED/);
  await ledger.pool.query("UPDATE ac_context_keys SET state='active' WHERE context_id=$1",[contexts[0]]);
  await ledger.pool.query('UPDATE ac_session_links SET session_id=$2 WHERE context_id=$1',[contexts[0],randomUUID()]);
  await assert.rejects(direct({command:later,proof:proof(later)}),/SESSION_CONTEXT_MISMATCH/);
  await ledger.pool.query('UPDATE ac_session_links SET session_id=$2 WHERE context_id=$1',[contexts[0],sessions[0]]);
  await ledger.pool.query('UPDATE ac_managers SET lease_until=clock_timestamp() WHERE context_id=$1',[contexts[0]]);
  await assert.rejects(direct({command:later,proof:proof(later)}),/STALE_MANAGER/);
  const state=(await ledger.pool.query('SELECT revision,programming_limit,evaluation_limit FROM ac_capacity_config WHERE id=1')).rows[0];
  assert.deepEqual(state,{revision:revision+2,programming_limit:4,evaluation_limit:3});
 }finally{
  user.disconnect();await registry.close();await runtime.close();await new Promise<void>((ok,fail)=>panel.close(error=>error?fail(error):ok()));await ledger.close();await rm(repo,{recursive:true,force:true});key.fill(0);identity.secretKey.fill(0);
 }
});
