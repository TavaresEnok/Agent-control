import {execFileSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {chmod,mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Capacity} from './capacity.ts';
import {enqueuePersonalOwner} from './conversation-transport.ts';
import {Refusal} from './contracts.ts';
import {ContextKeys,keyFingerprint} from './context-keys.ts';
import {ContextVault} from './context-vault.ts';
import {loadInstallation,readPrivateFile,type Installation} from './installation.ts';
import {Ledger} from './ledger.ts';
import {publishFirstPersonalPolicies,shareProjectAccounts} from './personal-policies.ts';
import {Templates} from './templates.ts';

/** Prefer the manager named by the project's current regular chain, then the lowest id. */
const managerProfileSql=`SELECT p.id FROM ac_profiles p JOIN ac_account_access x ON x.account_id=p.account_id
 LEFT JOIN LATERAL (SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 ORDER BY revision DESC LIMIT 1) policy ON true
 WHERE p.role='manager' AND p.enabled AND x.project_id=$1
 ORDER BY CASE WHEN COALESCE(policy.snapshot->'roles'->'manager'->'regular','[]'::jsonb) ? p.id::text THEN 0 ELSE 1 END, p.id
 LIMIT 1`;
/** A 32-byte secret in an owner-only regular file; created on first use and never accepted in any other shape. */
async function privateBytes(path:string){
 let bytes:Buffer;
 try{bytes=await readPrivateFile(path,64);}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;bytes=randomBytes(32);await writeFile(path,bytes,{mode:0o600,flag:'wx'});await chmod(path,0o600);}
 if(bytes.length!==32)throw new Error('PRIVATE_KEY_FILE_INVALID');
 return bytes;
}
/** Owner's 32-byte conversation key in the data directory. The file name predates the local transcript and is
 * kept so an existing installation keeps the same key, the same fingerprint and the same vault entries. */
export const ACCOUNT_KEY_FILE='happier-account.key';
async function writePrivate(path:string,content:string){
 const temporary=path+'.'+randomUUID()+'.tmp';
 await writeFile(temporary,content,{mode:0o600,flag:'wx'});await chmod(temporary,0o600);await rename(temporary,path);
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
 * Personal mode only. Opens one conversation per project, the context vault and the managerTransport block.
 * Run again to open conversations for projects that do not have one; existing ones are kept.
 */
export async function personalConnect(path:string){
 const config=await loadInstallation(path);
 if(config.activation!=='personal')throw new Error('PERSONAL_ACTIVATION_REQUIRED');
 return connectPersonalLocal(path,config);
}

/** Ledger steps of the connect: policies, context, capacity, key, template and vault entry, per pending project. */
async function connectPersonalLocal(path:string,config:Installation){
 const raw=JSON.parse(await readFile(path,'utf8')) as Record<string,any>;
 const principal=String(raw.managerTransport?.principal||config.project.owner);
 const projects:ListedProject[]=[config.project,...config.projects];
 const listed:TransportContext[]=[...(raw.managerTransport?.contexts??[])];
 const pending=projects.filter(project=>!listed.some(item=>item.projectId===project.id));
 const secret=await privateBytes(join(config.dataDirectory,ACCOUNT_KEY_FILE));
 try{
  if(!pending.length){
   raw.managerTransport={...raw.managerTransport,principal,transport:'local',contexts:listed};
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
    await publishFirstPersonalPolicies(ledger,config.project.owner,project.id,config.project.id,boot?{qaVerifierDigest:boot.qaDigest}:undefined,config.dataDirectory);
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
    const profileId=String((await ledger.pool.query(managerProfileSql,[project.id])).rows[0]?.id??'personal-manager');
    const request={contextId,sessionId,profileId,keyVersion:1 as const,encryptionVariant:'legacy' as const};
    try{await new ContextVault(ledger,installationId,vault.directory,vault.masterFile,repositories).importKey({...request,principal},secret);}
    catch(error){if(!(error instanceof Refusal)||error.code!=='VAULT_ENTRY_EXISTS')throw error;}
    if(!listed.some(item=>item.projectId===project.id))listed.push({projectId:project.id,...request});
    created.push(project.id);
    raw.contextVault=vault;
    raw.managerTransport={...raw.managerTransport,principal,transport:'local',contexts:listed};
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
 * The message is queued in the local transcript; the gateway (`serve`) picks it up. Then new messages are printed.
 */
export async function personalSay(path:string,text:string|undefined,waitSeconds=text===undefined?0:120,print:(line:string)=>void=console.log){
 const config=await loadInstallation(path);
 const item=config.managerTransport?.contexts.find(context=>context.projectId===config.project.id);
 if(config.activation!=='personal'||!item||!config.managerTransport)throw new Error('PERSONAL_CONNECT_REQUIRED');
 return personalSayLocal(config,item.contextId,text,waitSeconds,print);
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
