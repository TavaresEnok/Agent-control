import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {copyFile, mkdir, open} from 'node:fs/promises';
import {isAbsolute, resolve} from 'node:path';
import {z} from 'zod';
import {AccountHomes} from './account-homes.ts';
import {Capacity} from './capacity.ts';
import {Refusal} from './contracts.ts';
import {syncInstallationActivation, type Installation} from './installation.ts';
import type {Ledger} from './ledger.ts';

const Provider=z.enum(['codex','claude','grok']);
export type ProviderLogin={accountId:string;provider:'codex'|'claude'|'grok';label:string;state:'pending'|'active'|'error';url?:string;userCode?:string};
const sessions=new Map<string,ProviderLogin>();
/** Test team only. The permanent roster in AGENTS.md stays Codex for manager and programmer. */
const ROLES={
 codex:[] as {role:'manager'|'programmer'|'reviewer'|'qa';model:string}[],
 claude:[{role:'manager' as const,model:'claude-sonnet-5-5'},{role:'reviewer' as const,model:'claude-sonnet-5-5'},{role:'qa' as const,model:'claude-sonnet-5-5'}],
 grok:[{role:'programmer' as const,model:'grok-4.7'}],
};

export function providerLogin(accountId:string){return sessions.get(accountId)??null;}

function capture(accountId:string,chunk:Buffer){
 const current=sessions.get(accountId);if(!current)return;
 const text=chunk.toString('utf8');
 const url=text.match(/https:\/\/[^\s"'<>]+/)?.[0];
 const userCode=text.match(/(?:code|código|enter)[:\s]+([A-Z0-9-]{4,16})/i)?.[1];
 sessions.set(accountId,{...current,...(url?{url}:{}),...(userCode?{userCode}:{})});
}

function startDeviceLogin(provider:'codex'|'claude'|'grok',home:string,accountId:string){
 const command=provider==='codex'?'codex':provider==='claude'?'claude':'grok';
 const args=provider==='claude'?['setup-token']:['login','--device-auth'];
 const child=spawn(command,args,{env:{...process.env,CODEX_HOME:home,CLAUDE_CONFIG_DIR:home,HOME:provider==='grok'?home:process.env.HOME},stdio:['ignore','pipe','pipe'],detached:true});
 child.stdout.on('data',(chunk:Buffer)=>capture(accountId,chunk));
 child.stderr.on('data',(chunk:Buffer)=>capture(accountId,chunk));
 child.on('error',()=>{const current=sessions.get(accountId);if(current)sessions.set(accountId,{...current,state:'error'});});
 child.on('exit',code=>{const current=sessions.get(accountId);if(current&&current.state==='pending')sessions.set(accountId,{...current,state:code===0?'active':'error'});});
 child.unref();
 for(const stream of [child.stdout,child.stderr])(stream as {unref?:()=>void}|null)?.unref?.();
}

/** Registers one real subscription account and starts device login. Secrets stay in the private home. */
export async function addProviderAccount(config:Installation,ledger:Ledger,raw:{provider:string;label:string;authFile?:string}){
 if(config.activation!=='personal')throw new Refusal('PERSONAL_ACTIVATION_REQUIRED',403);
 const provider=Provider.parse(raw.provider);
 const label=z.string().trim().min(1).max(100).parse(raw.label);
 const root=config.accountHomesDirectory;if(!root)throw new Refusal('ACCOUNT_HOMES_NOT_CONFIGURED',403);
 await syncInstallationActivation(ledger,config.activation);
 const owner=config.project.owner,projectId=config.project.id;
 await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1) ON CONFLICT DO NOTHING',[owner]);
 const capacity=new Capacity(ledger);
 if(!(await ledger.pool.query('SELECT 1 FROM ac_capacity_config WHERE id=1')).rowCount)
  await capacity.configure(owner,{programmingLimit:4,evaluationLimit:2});
 const accountId=randomUUID();
 const subject=createHash('sha256').update(provider+'\0'+accountId).digest('hex');
 for(const profile of ROLES[provider])
  await capacity.registerModel(owner,{provider,model:profile.model,efforts:['low','medium','high'],roles:['manager','programmer','reviewer','qa','specialist','judge'],source:'personal://account-add'});
 await capacity.addAccount(owner,projectId,{id:accountId,provider,label,resourceIdentity:provider+':'+subject,mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'personal://owner',maxConcurrent:2});
 for(const profile of ROLES[provider])
  await capacity.addProfile(owner,projectId,{id:randomUUID(),accountId,model:profile.model,effort:'medium',role:profile.role});
 await capacity.observeQuota(owner,accountId,{status:'available',source:'personal://account-add',ttlSeconds:3600});
 const repositories=[config.project.repo,...config.projects.map(project=>project.repo)];
 await new AccountHomes(ledger,root,repositories).initialize(owner,projectId,accountId);
 const home=resolve(root,accountId);
 const login:ProviderLogin={accountId,provider,label,state:'pending'};
 sessions.set(accountId,login);
 if(raw.authFile){
  if(!isAbsolute(raw.authFile)||resolve(raw.authFile)!==raw.authFile)throw new Refusal('AUTH_FILE_INVALID',400);
  const target=provider==='grok'?resolve(home,'.grok','auth.json'):provider==='claude'?resolve(home,'.credentials.json'):resolve(home,'auth.json');
  if(provider==='grok')await mkdir(resolve(home,'.grok'),{recursive:true,mode:0o700});
  await copyFile(raw.authFile,target);
  const file=await open(target,constants.O_RDONLY);
  try{await file.chmod(0o600);}finally{await file.close();}
  sessions.set(accountId,{...login,state:'active'});
 }else{
  startDeviceLogin(provider,home,accountId);
  const deadline=Date.now()+4000;
  while(Date.now()<deadline&&sessions.get(accountId)?.state==='pending'&&!sessions.get(accountId)?.url)await new Promise(resolve=>setTimeout(resolve,200));
 }
 return sessions.get(accountId)!;
}
