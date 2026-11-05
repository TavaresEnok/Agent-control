import {spawn,type ChildProcess} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute,resolve} from 'node:path';
import {z} from 'zod';

/** Explicit trusted binding: no path, executable, or identity is accepted from a request. */
export type CodexReadonlyBinding={accountId:string;home:string;device:string;inode:string;uid:string;subjectDigest:string};
export type CodexReadonlySupervisor={launch(input:{home:string;homeFd:number}):Promise<ChildProcess>;stop():Promise<boolean>};
export type CodexReadonlyResult={kind:'stdout';stdout:string}|{kind:'auth'|'unknown'};
const uuid=z.uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/);
// Multiple injected instances must not bypass an in-flight or quarantined account.
const activeAccounts=new Set<string>(),quarantinedAccounts=new Set<string>();
export function codexReadonlyIdentity(value:unknown):string|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const a=value as Record<string,unknown>;
 if(a.type!=='chatgpt'||typeof a.email!=='string'||!a.email.trim())return null;
 return createHash('sha256').update(JSON.stringify(['chatgpt',a.email.trim().toLowerCase(),typeof a.accountId==='string'?a.accountId:null])).digest('hex');
}
/** No scheduler or registration. Callers must separately authorize use of this binding.
 * Unconfirmed teardown quarantines the account in this process until restart/reconciliation. */
export class CodexReadonlyQuotaSource{
 private readonly binding:CodexReadonlyBinding;private quarantined=false;
 constructor(private readonly executable:string,binding:CodexReadonlyBinding,private readonly timeoutMs=4000,private readonly supervisor?:CodexReadonlySupervisor){
  uuid.parse(binding.accountId);hash.parse(binding.subjectDigest);
  if(!isAbsolute(executable)||resolve(executable)!==executable||!isAbsolute(binding.home)||resolve(binding.home)!==binding.home||!/^\d+$/.test(binding.device)||!/^\d+$/.test(binding.inode)||!/^\d+$/.test(binding.uid)||!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw new TypeError('CODEX_READONLY_CONFIGURATION_INVALID');
  this.binding=Object.freeze({...binding});
 }
 async read(input:{accountId:string;signal:AbortSignal}):Promise<CodexReadonlyResult>{
  if(input.accountId!==this.binding.accountId||input.signal.aborted||activeAccounts.has(this.binding.accountId)||!this.supervisor&&(quarantinedAccounts.has(this.binding.accountId)||this.quarantined))return {kind:'unknown'};
  if(this.supervisor)this.quarantined=false;
  activeAccounts.add(this.binding.accountId);
  try{return await this.run(input.signal);}catch{return {kind:'unknown'};}finally{if(this.quarantined)quarantinedAccounts.add(this.binding.accountId);activeAccounts.delete(this.binding.accountId);}
 }
 private async run(signal:AbortSignal):Promise<CodexReadonlyResult>{
  const b=this.binding,stat=await lstat(b.home,{bigint:true});
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o7777n)!==0o700n||String(stat.uid)!==b.uid||b.uid!==String(process.geteuid?.())||String(stat.dev)!==b.device||String(stat.ino)!==b.inode||await realpath(b.home)!==b.home)return {kind:'unknown'};
  const home=await open(b.home,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{
   const opened=await home.stat({bigint:true});if(String(opened.dev)!==b.device||String(opened.ino)!==b.inode||String(opened.uid)!==b.uid||(opened.mode&0o7777n)!==0o700n||signal.aborted)return {kind:'unknown'};
   // Inherit the verified directory as fd 3; neither cwd nor the child's HOME
   // resolve the mutable pathname after verification. Linux /proc is required.
   const anchored='/proc/self/fd/3';
   const child=this.supervisor?await this.supervisor.launch({home:b.home,homeFd:home.fd}):spawn(this.executable,['app-server'],{cwd:`/proc/self/fd/${home.fd}`,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',HOME:anchored,CODEX_HOME:anchored},detached:true,stdio:['pipe','pipe','pipe',home.fd]});
   let rejectCurrent:(e:Error)=>void=()=>{},resolveCurrent:(v:any)=>void=()=>{},expected=0,buffer='',bytes=0,finished=false,failed=false;
   const pendingError=()=>{failed=true;rejectCurrent(new Error('READONLY_PROTOCOL_FAILED'));};
   const closed=new Promise<void>(resolve=>{child.once('close',()=>{finished=true;if(expected!==0)pendingError();resolve();});child.once('error',()=>{pendingError();});});
   child.stdin!.on('error',pendingError);
   const count=(n:number)=>{bytes+=n;if(bytes>256*1024){pendingError();return false;}return true;};
   child.stderr!.on('data',(v:Buffer)=>{count(v.length);});
   child.stdout!.on('data',(v:Buffer)=>{
    if(!count(v.length))return;buffer+=v.toString('utf8');let index:number;
    while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);let msg:any;
     try{msg=JSON.parse(line);}catch{pendingError();return;}
     if(!msg||typeof msg!=='object'||Array.isArray(msg)){pendingError();return;}
     if(msg.id===undefined&&typeof msg.method==='string')continue;
     if(String(msg.id)!==String(expected)||expected===0||msg.error!==undefined||msg.result===undefined){pendingError();return;}
     expected=0;resolveCurrent(msg.result);
    }
   });
   const abort=()=>pendingError(),timer=setTimeout(abort,this.timeoutMs);signal.addEventListener('abort',abort,{once:true});
   const request=(id:number,method:'initialize'|'account/read'|'account/rateLimits/read',params:object)=>new Promise<any>((resolve,reject)=>{
    if(signal.aborted||finished||failed){reject(new Error('READONLY_PROTOCOL_FAILED'));return;}
    expected=id;resolveCurrent=resolve;rejectCurrent=reject;child.stdin!.write(JSON.stringify({id,method,params})+'\n');
   });
   let answer:CodexReadonlyResult={kind:'unknown'};
   try{
    await request(1,'initialize',{clientInfo:{name:'cezar',title:'cezar',version:'0.1.0'},capabilities:{experimentalApi:true}});
    child.stdin!.write(JSON.stringify({method:'initialized',params:{}})+'\n');
    const account=await request(2,'account/read',{refreshToken:false});
    const identity=codexReadonlyIdentity(account?.account);
    if(!identity||identity!==b.subjectDigest)answer={kind:'auth'};
    else {const result=await request(3,'account/rateLimits/read',{});answer={kind:'stdout',stdout:JSON.stringify({id:'rpc-1',result})};}
   }catch{answer={kind:'unknown'};}
   finally{
    clearTimeout(timer);signal.removeEventListener('abort',abort);child.stdin!.destroy();
    if(this.supervisor){if(!await this.supervisor.stop())this.quarantined=true;}
    else if(child.pid){try{process.kill(-child.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')this.quarantined=true;}}
    const stopped=await Promise.race([closed.then(()=>true),new Promise<false>(r=>setTimeout(()=>r(false),1000))]);
    if(!stopped)this.quarantined=true;
    if(!this.supervisor&&child.pid){try{process.kill(-child.pid,0);this.quarantined=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')this.quarantined=true;}}
   }
   return this.quarantined||signal.aborted||failed?{kind:'unknown'}:answer;
  }finally{await home.close();}
 }
}
