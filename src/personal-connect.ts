import {execFileSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {chmod,mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import nacl from 'tweetnacl';
import {Capacity} from './capacity.ts';
import {enqueuePersonalOwner} from './conversation-transport.ts';
import {Refusal} from './contracts.ts';
import {ContextKeys,keyFingerprint} from './context-keys.ts';
import {ContextVault} from './context-vault.ts';
import {loadHappier} from './happier.ts';
import {loadInstallation,readPrivateFile,type Installation} from './installation.ts';
import {Ledger} from './ledger.ts';
import {publishFirstPersonalPolicies,shareProjectAccounts} from './personal-policies.ts';
import {Templates} from './templates.ts';

const b64=(bytes:Uint8Array)=>Buffer.from(bytes).toString('base64');
/** A 32-byte secret in an owner-only regular file; created on first use and never accepted in any other shape. */
async function privateBytes(path:string){
 let bytes:Buffer;
 try{bytes=await readPrivateFile(path,64);}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;bytes=randomBytes(32);await writeFile(path,bytes,{mode:0o600,flag:'wx'});await chmod(path,0o600);}
 if(bytes.length!==32)throw new Error('PRIVATE_KEY_FILE_INVALID');
 return bytes;
}
/** The conversation key and token only ever go to a Happier server on this host. */
function localOrigin(origin:string){
 if(!['127.0.0.1','localhost','[::1]'].includes(new URL(origin).hostname))throw new Error('HAPPIER_UPSTREAM_MUST_BE_LOCAL');
 return origin;
}
async function writePrivate(path:string,content:string){
 const temporary=path+'.'+randomUUID()+'.tmp';
 await writeFile(temporary,content,{mode:0o600,flag:'wx'});await chmod(temporary,0o600);await rename(temporary,path);
}

/** Narrow Happier boundary. Production calls the local server; tests pass a fake. */
export type PersonalHappierClient={
 ready(origin:string):Promise<boolean>;
 authenticate(origin:string,body:{publicKey:string;challenge:string;signature:string}):Promise<{token:string}>;
 profile(origin:string,token:string):Promise<{id:string}>;
 createMachine(origin:string,token:string,body:{id:string;metadata:string;daemonState:string}):Promise<void>;
 createSession(origin:string,token:string,body:{tag:string;encryptionMode:'e2ee';metadata:string;agentState:string}):Promise<{sessionId:string}>;
 seal(secret:Uint8Array,value:unknown):Promise<string>;
};
export function livePersonalHappier():PersonalHappierClient{
 const headers=(token:string)=>({authorization:'Bearer '+token,'content-type':'application/json'});
 return {
  ready(origin){return fetch(origin+'/v1/account/profile',{signal:AbortSignal.timeout(5000)}).then(r=>r.status===401,()=>false);},
  async authenticate(origin,body){
   const auth=await fetch(origin+'/v1/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
   if(!auth.ok)throw new Error('HAPPIER_AUTH_FAILED');
   return await auth.json() as {token:string};
  },
  async profile(origin,token){
   const response=await fetch(origin+'/v1/account/profile',{headers:{authorization:'Bearer '+token}});
   if(!response.ok)throw new Error('HAPPIER_AUTH_FAILED');
   return await response.json() as {id:string};
  },
  async createMachine(origin,token,body){
   const machine=await fetch(origin+'/v1/machines',{method:'POST',headers:headers(token),body:JSON.stringify(body)});
   if(!machine.ok)throw new Error('HAPPIER_MACHINE_FAILED');
  },
  async createSession(origin,token,body){
   const created=await fetch(origin+'/v1/sessions',{method:'POST',headers:headers(token),body:JSON.stringify(body)});
   if(!created.ok)throw new Error('HAPPIER_SESSION_FAILED');
   return {sessionId:String(((await created.json()) as {session:{id:string}}).session.id)};
  },
  async seal(secret,value){
   const boundary=await loadHappier();
   return boundary.encodeBase64(boundary.encrypt(secret,'legacy',value));
  },
 };
}
type ListedProject=Installation['project'];
type TransportContext={projectId:string;contextId:string;sessionId:string;profileId:string;keyVersion:number;encryptionVariant:'legacy'|'dataKey'};
function currentBranch(repo:string){
 try{return execFileSync('/usr/bin/git',['-C',repo,'symbolic-ref','--short','HEAD'],{encoding:'utf8'}).trim();}
 catch{throw new Error('REPOSITORY_BRANCH_REQUIRED');}
}
function accountsRequired(path:string){
 return {state:'accounts_required' as const,next:'Registre as contas (account-add) e rode node scripts/personal-setup.mjs '+path+' antes de criar a conversa.'};
}

/**
 * Personal mode only. Creates (once) the owner's Happier account, one conversation per
 * project on that same account, the context vault and the managerTransport block.
 * Run again to refresh the token and to open conversations for projects that do not have one.
 * The Happier server must already be running. A second machine, token file or account key is never created.
 */
export async function personalConnect(path:string,injected?:PersonalHappierClient,options?:{local?:boolean}){
 const config=await loadInstallation(path);
 if(config.activation!=='personal')throw new Error('PERSONAL_ACTIVATION_REQUIRED');
 if(options?.local||config.managerTransport?.transport==='local')return connectPersonalLocal(path,config);
 const happier=injected??livePersonalHappier();
 const origin=localOrigin(config.happier.upstreamOrigin);
 if(!await happier.ready(origin))return {state:'happier_required' as const,next:'Suba o servidor Happier: npm run personal:happier -- '+path};
 // One secret is both the sign-in seed and the legacy conversation key, as in the Happier client.
 const secret=await privateBytes(join(config.dataDirectory,'happier-account.key'));
 const pair=nacl.sign.keyPair.fromSeed(secret),challenge=randomBytes(32);
 const {token}=await happier.authenticate(origin,{publicKey:b64(pair.publicKey),challenge:b64(challenge),signature:b64(nacl.sign.detached(challenge,pair.secretKey))});
 const profile=await happier.profile(origin,token);
 const tokenFile=join(config.dataDirectory,'manager-token');
 await writePrivate(tokenFile,token);
 const raw=JSON.parse(await readFile(path,'utf8')) as Record<string,any>;
 const projects:ListedProject[]=[config.project,...config.projects];
 const sameAccount=raw.managerTransport?.principal===profile.id;
 const listed:TransportContext[]=sameAccount?[...(raw.managerTransport?.contexts??[])]:[];
 const pending=projects.filter(project=>!listed.some(item=>item.projectId===project.id));
 const primary=listed.find(item=>item.projectId===config.project.id);
 if(!pending.length){secret.fill(0);return {state:'connected' as const,principal:profile.id,sessionId:primary?.sessionId,contextId:primary?.contextId,refreshed:'token' as const};}
 const ledger=new Ledger(config.databaseUrl,config.installationAuthority?.token);
 try{
  const boot=config.nativeBootstrap&&config.nativeBootstrap.state!=='disabled'&&config.nativeBootstrap.state!=='bench'?config.nativeBootstrap:undefined;
  const branches=new Map<string,string>();
  for(const project of pending){
   await shareProjectAccounts(ledger,config.project.owner,config.project.id,project.id);
   await publishFirstPersonalPolicies(ledger,config.project.owner,project.id,config.project.id,boot?{qaVerifierDigest:boot.qaDigest}:undefined);
   const ready=(await ledger.pool.query('SELECT (SELECT count(*) FROM ac_policy_revisions WHERE project_id=$1)::int policies,(SELECT count(*) FROM ac_quality_policies WHERE project_id=$1)::int quality',[project.id])).rows[0];
   if(!ready?.policies||!ready?.quality){if(project.id===config.project.id)return accountsRequired(path);throw new Error('ACCOUNTS_REQUIRED');}
   branches.set(project.id,currentBranch(project.repo));
  }
  // Reuse the machine already recorded for this account. The first conversation is the only one that creates it.
  let machineId:string=sameAccount&&raw.managerTransport?.machineId?String(raw.managerTransport.machineId):'';
  if(!machineId){
   machineId=randomUUID();
   await happier.createMachine(origin,token,{id:machineId,metadata:await happier.seal(secret,{host:'agent-control',platform:'linux',happyCliVersion:'0.2.18',homeDir:config.dataDirectory}),daemonState:await happier.seal(secret,{status:'running',startedAt:Date.now()})});
  }
  const vault=raw.contextVault??{directory:join(config.dataDirectory,'vault'),masterFile:join(config.dataDirectory,'vault-master')};
  await mkdir(vault.directory,{recursive:true,mode:0o700});await chmod(vault.directory,0o700);await privateBytes(vault.masterFile);
  const installationId=(await ledger.pool.query('SELECT id FROM ac_installation_identity WHERE singleton')).rows[0].id;
  const repositories=[...new Set([config.project.repo,...config.projects.map(p=>p.repo),...(await ledger.pool.query('SELECT repo FROM ac_project_repositories')).rows.map(r=>String(r.repo))])];
  const created:string[]=[];
  for(const project of pending){
   const linked=(await ledger.pool.query(`SELECT x.id AS "contextId",s.session_id AS "sessionId" FROM ac_contexts x JOIN ac_session_links s ON s.context_id=x.id
    WHERE x.project_id=$1 AND s.principal_id=$2 AND NOT x.archived ORDER BY x.created_at LIMIT 1`,[project.id,profile.id])).rows[0] as {contextId:string;sessionId:string}|undefined;
   const sessionId=linked?.sessionId??(await happier.createSession(origin,token,{tag:'agent-control-'+project.id,encryptionMode:'e2ee',
    metadata:await happier.seal(secret,{machineId,path:project.repo,host:'agent-control',homeDir:config.dataDirectory,version:'0.2.18',name:project.label,flavor:'claude',startedBy:'terminal',startedFromDaemon:false}),
    agentState:await happier.seal(secret,{controlledByUser:false,requests:{},completedRequests:{}})})).sessionId;
   await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner') ON CONFLICT DO NOTHING",[project.id,profile.id]);
   const contextId=linked?.contextId??await ledger.createContext(profile.id,project.id,sessionId);
   const policy=Number((await ledger.pool.query('SELECT max(revision) r FROM ac_policy_revisions WHERE project_id=$1',[project.id])).rows[0]?.r??0);
   if(!policy)throw new Error('ACCOUNTS_REQUIRED');
   if(!(await ledger.pool.query('SELECT capacity_policy_revision FROM ac_contexts WHERE id=$1 AND capacity_policy_revision IS NOT NULL',[contextId])).rowCount)
    await new Capacity(ledger).assignPolicy(profile.id,contextId,policy);
   if(!(await ledger.pool.query("SELECT 1 FROM ac_context_keys WHERE context_id=$1 AND version=1 AND state='active'",[contextId])).rowCount)
    await new ContextKeys(ledger).authorize(profile.id,contextId,1,'legacy',keyFingerprint(secret),{sessionId});
   const quality=Number((await ledger.pool.query('SELECT max(revision) r FROM ac_quality_policies WHERE project_id=$1',[project.id])).rows[0]?.r??0);
   if(!quality)throw new Error('QUALITY_POLICY_REQUIRED');
   if(!(await ledger.pool.query('SELECT 1 FROM ac_context_templates WHERE context_id=$1',[contextId])).rowCount)
    await new Templates(ledger).publish(profile.id,contextId,0,{workflow:'semantic-proposal-v1',targetRef:'refs/heads/'+branches.get(project.id),qualityRevision:quality});
   const profileId=String((await ledger.pool.query(`SELECT p.id FROM ac_profiles p JOIN ac_account_access x ON x.account_id=p.account_id
    WHERE p.role='manager' AND p.enabled AND x.project_id=$1 ORDER BY p.id LIMIT 1`,[project.id])).rows[0]?.id??'personal-manager');
   const request={contextId,sessionId,profileId,keyVersion:1 as const,encryptionVariant:'legacy' as const};
   try{await new ContextVault(ledger,installationId,vault.directory,vault.masterFile,repositories).importKey({...request,principal:profile.id},secret);}
   catch(error){if(!(error instanceof Refusal)||error.code!=='VAULT_ENTRY_EXISTS')throw error;}
   if(!listed.some(item=>item.projectId===project.id))listed.push({projectId:project.id,...request});
   created.push(project.id);
   raw.contextVault=vault;
   const kept=raw.managerTransport?.transport;
   raw.managerTransport={principal:profile.id,tokenFile,machineId,contexts:listed,...(kept?{transport:kept}:{})};
   if(raw.nativeBootstrap&&raw.nativeBootstrap.projectId===config.project.id){
    const bound=listed.find(entry=>entry.projectId===config.project.id);
    if(bound)raw.nativeBootstrap.contextId=bound.contextId;
   }
   await writePrivate(path,JSON.stringify(raw,null,2)+'\n');
  }
  const current=listed.find(item=>item.projectId===config.project.id);
  return {state:'connected' as const,principal:profile.id,sessionId:current?.sessionId,contextId:current?.contextId,created};
 }finally{secret.fill(0);await ledger.close();}
}

/**
 * Same ledger steps as the Happier connect, without a session, a machine registration or a token read.
 * The token file stays (the schema still requires a path) and is not overwritten when it already exists.
 */
async function connectPersonalLocal(path:string,config:Installation){
 const raw=JSON.parse(await readFile(path,'utf8')) as Record<string,any>;
 const principal=String(raw.managerTransport?.principal||config.project.owner);
 const projects:ListedProject[]=[config.project,...config.projects];
 const listed:TransportContext[]=[...(raw.managerTransport?.contexts??[])];
 const pending=projects.filter(project=>!listed.some(item=>item.projectId===project.id));
 const tokenFile=String(raw.managerTransport?.tokenFile||join(config.dataDirectory,'manager-token'));
 const machineId=String(raw.managerTransport?.machineId||randomUUID());
 const secret=await privateBytes(join(config.dataDirectory,'happier-account.key'));
 try{
  try{await readPrivateFile(tokenFile,16384);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await writePrivate(tokenFile,randomBytes(32).toString('hex'));}
  if(!pending.length){
   raw.managerTransport={...raw.managerTransport,principal,tokenFile,machineId,transport:'local',contexts:listed};
   await writePrivate(path,JSON.stringify(raw,null,2)+'\n');
   const primary=listed.find(item=>item.projectId===config.project.id);
   return {state:'connected' as const,principal,sessionId:primary?.sessionId,contextId:primary?.contextId,refreshed:'local' as const};
  }
  const ledger=new Ledger(config.databaseUrl,config.installationAuthority?.token);
  try{
   const boot=config.nativeBootstrap&&config.nativeBootstrap.state!=='disabled'&&config.nativeBootstrap.state!=='bench'?config.nativeBootstrap:undefined;
   const branches=new Map<string,string>();
   for(const project of pending){
    await shareProjectAccounts(ledger,config.project.owner,config.project.id,project.id);
    await publishFirstPersonalPolicies(ledger,config.project.owner,project.id,config.project.id,boot?{qaVerifierDigest:boot.qaDigest}:undefined);
    const ready=(await ledger.pool.query('SELECT (SELECT count(*) FROM ac_policy_revisions WHERE project_id=$1)::int policies,(SELECT count(*) FROM ac_quality_policies WHERE project_id=$1)::int quality',[project.id])).rows[0];
    if(!ready?.policies||!ready?.quality){if(project.id===config.project.id)return accountsRequired(path);throw new Error('ACCOUNTS_REQUIRED');}
    branches.set(project.id,currentBranch(project.repo));
   }
   const vault=raw.contextVault??{directory:join(config.dataDirectory,'vault'),masterFile:join(config.dataDirectory,'vault-master')};
   await mkdir(vault.directory,{recursive:true,mode:0o700});await chmod(vault.directory,0o700);await privateBytes(vault.masterFile);
   const installationId=(await ledger.pool.query('SELECT id FROM ac_installation_identity WHERE singleton')).rows[0].id;
   const repositories=[...new Set([config.project.repo,...config.projects.map(p=>p.repo),...(await ledger.pool.query('SELECT repo FROM ac_project_repositories')).rows.map(r=>String(r.repo))])];
   const created:string[]=[];
   for(const project of pending){
    const linked=(await ledger.pool.query(`SELECT x.id AS "contextId",s.session_id AS "sessionId" FROM ac_contexts x JOIN ac_session_links s ON s.context_id=x.id
     WHERE x.project_id=$1 AND s.principal_id=$2 AND NOT x.archived ORDER BY x.created_at LIMIT 1`,[project.id,principal])).rows[0] as {contextId:string;sessionId:string}|undefined;
    const sessionId=linked?.sessionId??randomUUID();
    await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner') ON CONFLICT DO NOTHING",[project.id,principal]);
    const contextId=linked?.contextId??await ledger.createContext(principal,project.id,sessionId);
    const policy=Number((await ledger.pool.query('SELECT max(revision) r FROM ac_policy_revisions WHERE project_id=$1',[project.id])).rows[0]?.r??0);
    if(!policy)throw new Error('ACCOUNTS_REQUIRED');
    if(!(await ledger.pool.query('SELECT capacity_policy_revision FROM ac_contexts WHERE id=$1 AND capacity_policy_revision IS NOT NULL',[contextId])).rowCount)
     await new Capacity(ledger).assignPolicy(principal,contextId,policy);
    if(!(await ledger.pool.query("SELECT 1 FROM ac_context_keys WHERE context_id=$1 AND version=1 AND state='active'",[contextId])).rowCount)
     await new ContextKeys(ledger).authorize(principal,contextId,1,'legacy',keyFingerprint(secret),{sessionId});
    const quality=Number((await ledger.pool.query('SELECT max(revision) r FROM ac_quality_policies WHERE project_id=$1',[project.id])).rows[0]?.r??0);
    if(!quality)throw new Error('QUALITY_POLICY_REQUIRED');
    if(!(await ledger.pool.query('SELECT 1 FROM ac_context_templates WHERE context_id=$1',[contextId])).rowCount)
     await new Templates(ledger).publish(principal,contextId,0,{workflow:'semantic-proposal-v1',targetRef:'refs/heads/'+branches.get(project.id),qualityRevision:quality});
    const profileId=String((await ledger.pool.query(`SELECT p.id FROM ac_profiles p JOIN ac_account_access x ON x.account_id=p.account_id
     WHERE p.role='manager' AND p.enabled AND x.project_id=$1 ORDER BY p.id LIMIT 1`,[project.id])).rows[0]?.id??'personal-manager');
    const request={contextId,sessionId,profileId,keyVersion:1 as const,encryptionVariant:'legacy' as const};
    try{await new ContextVault(ledger,installationId,vault.directory,vault.masterFile,repositories).importKey({...request,principal},secret);}
    catch(error){if(!(error instanceof Refusal)||error.code!=='VAULT_ENTRY_EXISTS')throw error;}
    if(!listed.some(item=>item.projectId===project.id))listed.push({projectId:project.id,...request});
    created.push(project.id);
    raw.contextVault=vault;
    raw.managerTransport={principal,tokenFile,machineId,transport:'local',contexts:listed};
    if(raw.nativeBootstrap&&raw.nativeBootstrap.projectId===config.project.id){
     const bound=listed.find(entry=>entry.projectId===config.project.id);
     if(bound)raw.nativeBootstrap.contextId=bound.contextId;
    }
    await writePrivate(path,JSON.stringify(raw,null,2)+'\n');
   }
   const current=listed.find(item=>item.projectId===config.project.id);
   return {state:'connected' as const,principal,sessionId:current?.sessionId,contextId:current?.contextId,created};
  }finally{await ledger.close();}
 }finally{secret.fill(0);}
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
 if(config.managerTransport.transport==='local')return personalSayLocal(config,item.contextId,text,waitSeconds,print);
 const origin=localOrigin(config.happier.upstreamOrigin),secret=await readPrivateFile(join(config.dataDirectory,'happier-account.key'),64);
 if(secret.length!==32)throw new Error('PRIVATE_KEY_FILE_INVALID');
 const token=(await readPrivateFile(config.managerTransport.tokenFile,16384)).toString('utf8').trim(),headers={authorization:'Bearer '+token,'content-type':'application/json'};
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

async function personalSayLocal(config:Installation,contextId:string,text:string|undefined,waitSeconds:number,print:(line:string)=>void){
 const ledger=new Ledger(config.databaseUrl,config.installationAuthority?.token);
 try{
  const read=async()=>(await ledger.pool.query('SELECT id,role,text,seq FROM ac_personal_messages WHERE context_id=$1 ORDER BY seq',[contextId])).rows as {id:string;role:string;text:string;seq:string}[];
  const seen=new Set((await read()).map(message=>message.id));
  if(text)await enqueuePersonalOwner(ledger.pool,contextId,randomUUID(),text);
  else for(const message of await read())print((message.role==='owner'?'você: ':'gerente: ')+message.text);
  const until=Date.now()+waitSeconds*1000;let quiet=0;
  while(Date.now()<until){
   await new Promise(resolve=>setTimeout(resolve,2000));
   const fresh=(await read()).filter(message=>!seen.has(message.id));
   for(const message of fresh){seen.add(message.id);if(message.role!=='owner')print('gerente: '+message.text);}
   quiet=fresh.some(message=>message.role!=='owner')?1:quiet?quiet+1:0;
   if(text&&quiet>8)break;
  }
 }finally{await ledger.close();}
}

/** The account secret in the Happier app's "Restore with Secret Key" format (base32, groups of 5). Printed only to the owner's terminal. */
export async function personalAppKey(path:string){
 const config=await loadInstallation(path);
 if(config.activation!=='personal')throw new Error('PERSONAL_ACTIVATION_REQUIRED');
 const secret=await readPrivateFile(join(config.dataDirectory,'happier-account.key'),64);
 if(secret.length!==32)throw new Error('PRIVATE_KEY_FILE_INVALID');
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let out='',buffer=0,bits=0;
 for(const byte of secret){buffer=(buffer<<8)|byte;bits+=8;while(bits>=5){bits-=5;out+=alphabet[(buffer>>bits)&31];}buffer&=(1<<bits)-1;}
 if(bits>0)out+=alphabet[(buffer<<(5-bits))&31];
 secret.fill(0);
 return {server:config.happier.upstreamOrigin,secretKey:out.match(/.{1,5}/g)!.join('-')};
}
