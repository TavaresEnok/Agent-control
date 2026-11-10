import {execFileSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import nacl from 'tweetnacl';
import {Capacity} from './capacity.ts';
import {ContextKeys,keyFingerprint} from './context-keys.ts';
import {ContextVault} from './context-vault.ts';
import {loadHappier} from './happier.ts';
import {loadInstallation} from './installation.ts';
import {Ledger} from './ledger.ts';
import {Templates} from './templates.ts';

const b64=(bytes:Uint8Array)=>Buffer.from(bytes).toString('base64');
async function privateBytes(path:string){
 try{return await readFile(path);}catch{const bytes=randomBytes(32);await writeFile(path,bytes,{mode:0o600,flag:'wx'});return bytes;}
}

/**
 * Personal mode only. Creates (once) the owner's Happier account, a project conversation,
 * the context vault and the managerTransport block, so `serve` hosts the conversation.
 * Run again to refresh the token. The Happier server must already be running.
 */
export async function personalConnect(path:string){
 const config=await loadInstallation(path);
 if(config.activation!=='personal')throw new Error('PERSONAL_ACTIVATION_REQUIRED');
 const origin=config.happier.upstreamOrigin;
 const up=await fetch(origin+'/v1/account/profile',{signal:AbortSignal.timeout(5000)}).then(r=>r.status===401,()=>false);
 if(!up)return {state:'happier_required',next:'Suba o servidor Happier: npm run personal:happier -- '+path};
 // One secret is both the sign-in seed and the legacy conversation key, as in the Happier client.
 const secret=await privateBytes(join(config.dataDirectory,'happier-account.key'));
 const pair=nacl.sign.keyPair.fromSeed(secret),challenge=randomBytes(32);
 const auth=await fetch(origin+'/v1/auth',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({publicKey:b64(pair.publicKey),challenge:b64(challenge),signature:b64(nacl.sign.detached(challenge,pair.secretKey))})});
 if(!auth.ok)throw new Error('HAPPIER_AUTH_FAILED');
 const {token}=await auth.json() as {token:string};
 const authorization='Bearer '+token,json={authorization,'content-type':'application/json'};
 const profile=await (await fetch(origin+'/v1/account/profile',{headers:{authorization}})).json() as {id:string};
 const tokenFile=join(config.dataDirectory,'manager-token');
 await writeFile(tokenFile,token,{mode:0o600});
 const raw=JSON.parse(await readFile(path,'utf8')) as Record<string,any>;
 const existing=raw.managerTransport?.contexts?.find((item:{projectId:string})=>item.projectId===config.project.id);
 if(existing&&raw.managerTransport.principal===profile.id)return {state:'connected',principal:profile.id,sessionId:existing.sessionId,contextId:existing.contextId,refreshed:'token'};
 const ledger=new Ledger(config.databaseUrl,config.installationAuthority?.token);
 try{
  const boundary=await loadHappier(),seal=(value:unknown)=>boundary.encodeBase64(boundary.encrypt(secret,'legacy',value));
  const machineId=randomUUID();
  const machine=await fetch(origin+'/v1/machines',{method:'POST',headers:json,body:JSON.stringify({id:machineId,
   metadata:seal({host:'agent-control',platform:'linux',happyCliVersion:'0.2.18',homeDir:config.dataDirectory}),daemonState:seal({status:'running',startedAt:Date.now()})})});
  if(!machine.ok)throw new Error('HAPPIER_MACHINE_FAILED');
  const created=await fetch(origin+'/v1/sessions',{method:'POST',headers:json,body:JSON.stringify({tag:'agent-control-'+config.project.id,encryptionMode:'e2ee',
   metadata:seal({machineId,path:config.project.repo,host:'agent-control',homeDir:config.dataDirectory,version:'0.2.18',name:config.project.label,flavor:'claude',startedBy:'terminal',startedFromDaemon:false}),
   agentState:seal({controlledByUser:false,requests:{},completedRequests:{}})})});
  if(!created.ok)throw new Error('HAPPIER_SESSION_FAILED');
  const sessionId=String(((await created.json()) as {session:{id:string}}).session.id);
  await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner') ON CONFLICT DO NOTHING",[config.project.id,profile.id]);
  const contextId=await ledger.createContext(profile.id,config.project.id,sessionId);
  const policy=Number((await ledger.pool.query('SELECT max(revision) r FROM ac_policy_revisions WHERE project_id=$1',[config.project.id])).rows[0]?.r??1)||1;
  await new Capacity(ledger).assignPolicy(profile.id,contextId,policy);
  await new ContextKeys(ledger).authorize(profile.id,contextId,1,'legacy',keyFingerprint(secret),{sessionId});
  const quality=Number((await ledger.pool.query('SELECT max(revision) r FROM ac_quality_policies WHERE project_id=$1',[config.project.id])).rows[0]?.r);
  if(!quality)throw new Error('QUALITY_POLICY_REQUIRED');
  const branch=execFileSync('/usr/bin/git',['-C',config.project.repo,'symbolic-ref','--short','HEAD'],{encoding:'utf8'}).trim();
  await new Templates(ledger).publish(profile.id,contextId,0,{workflow:'semantic-proposal-v1',targetRef:'refs/heads/'+branch,qualityRevision:quality});
  const vault=raw.contextVault??{directory:join(config.dataDirectory,'vault'),masterFile:join(config.dataDirectory,'vault-master')};
  await mkdir(vault.directory,{recursive:true,mode:0o700});await privateBytes(vault.masterFile);
  const installationId=(await ledger.pool.query('SELECT id FROM ac_installation_identity WHERE singleton')).rows[0].id;
  const profileId=String((await ledger.pool.query("SELECT id FROM ac_profiles WHERE role='manager' AND enabled ORDER BY id LIMIT 1")).rows[0]?.id??'personal-manager');
  const request={contextId,sessionId,profileId,keyVersion:1,encryptionVariant:'legacy' as const};
  const repositories=[...new Set([config.project.repo,...config.projects.map(p=>p.repo),...(await ledger.pool.query('SELECT repo FROM ac_project_repositories')).rows.map(r=>String(r.repo))])];
  await new ContextVault(ledger,installationId,vault.directory,vault.masterFile,repositories).importKey({...request,principal:profile.id},secret);
  raw.contextVault=vault;
  raw.managerTransport={principal:profile.id,tokenFile,machineId,contexts:[...(raw.managerTransport?.principal===profile.id?raw.managerTransport.contexts:[]),{projectId:config.project.id,...request}]};
  // The native bootstrap is bound to the conversation it serves.
  if(raw.nativeBootstrap&&raw.nativeBootstrap.projectId===config.project.id)raw.nativeBootstrap.contextId=raw.managerTransport.contexts.find((entry:{projectId:string})=>entry.projectId===config.project.id).contextId;
  await writeFile(path,JSON.stringify(raw,null,2)+'\n',{mode:0o600});
  return {state:'connected',principal:profile.id,sessionId,contextId};
 }finally{await ledger.close();}
}

/**
 * Personal mode only: the owner talks to the project conversation from the terminal.
 * The message is encrypted with the owner's key and queued in Happier exactly as the app
 * does; the gateway (`serve`) picks it up. Then new conversation messages are printed.
 */
export async function personalSay(path:string,text:string|undefined,waitSeconds=text===undefined?0:120,print:(line:string)=>void=console.log){
 const config=await loadInstallation(path);
 const item=config.managerTransport?.contexts.find(context=>context.projectId===config.project.id);
 if(config.activation!=='personal'||!item||!config.managerTransport)throw new Error('PERSONAL_CONNECT_REQUIRED');
 const origin=config.happier.upstreamOrigin,secret=await readFile(join(config.dataDirectory,'happier-account.key'));
 const token=(await readFile(config.managerTransport.tokenFile,'utf8')).trim(),headers={authorization:'Bearer '+token,'content-type':'application/json'};
 const boundary=await loadHappier();
 const read=async()=>{
  const response=await fetch(origin+'/v1/sessions/'+item.sessionId+'/messages?scope=main&limit=150',{headers});
  if(!response.ok)throw new Error('HAPPIER_HTTP_'+response.status);
  const body=await response.json() as {messages:{id:string;seq?:number;content:unknown}[]};
  return body.messages.map(message=>{
   const envelope=(typeof message.content==='string'?JSON.parse(message.content):message.content) as {c?:string};
   let record:any;try{record=boundary.decrypt(secret,'legacy',boundary.decodeBase64(String(envelope.c)));}catch{record=null;}
   const body=record?.content?.text??record?.content?.data?.message?.content?.map((part:{text?:string})=>part.text).join(' ')??'';
   return {id:message.id,seq:Number(message.seq??0),role:String(record?.role??'?'),text:String(body)};
  }).sort((a,b)=>a.seq-b.seq);
 };
 const seen=new Set((await read()).map(message=>message.id));
 if(text){
  const sent=await fetch(origin+'/v2/sessions/'+item.sessionId+'/pending',{method:'POST',headers,
   body:JSON.stringify({ciphertext:boundary.encodeBase64(boundary.encrypt(secret,'legacy',{role:'user',content:{type:'text',text}})),localId:randomUUID()})});
  if(!sent.ok)throw new Error('HAPPIER_HTTP_'+sent.status);
 }else for(const message of await read())print((message.role==='user'?'você: ':'gerente: ')+message.text);
 const until=Date.now()+waitSeconds*1000;let quiet=0;
 // With a message: stop once the manager has gone quiet. Without one (chat-log N): follow for N seconds.
 while(Date.now()<until){
  await new Promise(resolve=>setTimeout(resolve,2000));
  const fresh=(await read()).filter(message=>!seen.has(message.id));
  for(const message of fresh){seen.add(message.id);if(message.role!=='user')print('gerente: '+message.text);}
  quiet=fresh.some(message=>message.role!=='user')?1:quiet?quiet+1:0;
  if(text&&quiet>8)break;
 }
}
