import {createHash, randomBytes, randomUUID, scrypt, timingSafeEqual} from 'node:crypto';
import {open, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {isIP} from 'node:net';
import {dirname, join, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {Writable} from 'node:stream';
import {z} from 'zod';
import {Refusal} from './contracts.ts';
import {withPrivateFileLock} from './private-file-lock.ts';

const params={N:2**15,r:8,p:1,length:64} as const;
const maxmem=64*1024*1024;
const windowMs=60*1000;
const attemptLimit=5;
const globalLimit=100;
const userPattern=/^[a-z0-9._-]{3,40}$/;
/** Thirty days. BrowserSessions already accepts this as its maximum age. */
export const panelSessionSeconds=30*24*60*60;
const chains=new Map<string,Promise<unknown>>();
const dummySalt=randomBytes(16);
const dummyHash=randomBytes(64);
const dummyPassword='panel-login-dummy';
const credentialSchema=z.object({
 user:z.string().regex(userPattern),
 salt:z.string().regex(/^[a-f0-9]{32}$/),
 hash:z.string().regex(/^[a-f0-9]{128}$/),
 params:z.object({N:z.literal(params.N),r:z.literal(params.r),p:z.literal(params.p),length:z.literal(params.length)}).strict(),
 updatedAt:z.iso.datetime(),
 changedAt:z.number().int().positive().optional(),
}).strict();
const attemptSchema=z.object({
 failures:z.array(z.object({ip:z.string().min(1).max(64),at:z.number().int().nonnegative()}).strict()).max(globalLimit),
 lockedUntil:z.number().int().nonnegative(),
}).strict();
const epochSchema=z.object({changedAt:z.number().int().positive()}).strict();
type Credential=z.infer<typeof credentialSchema>;
type Attempts=z.infer<typeof attemptSchema>;

function exclusive<T>(path:string,fn:()=>Promise<T>):Promise<T>{
 const previous=chains.get(path)??Promise.resolve();
 const run=previous.then(()=>withPrivateFileLock(path+'.lock','PANEL_LOGIN_STORE_BUSY',fn));
 const tail=run.then(()=>undefined,()=>undefined);
 chains.set(path,tail);
 void tail.then(()=>{if(chains.get(path)===tail)chains.delete(path);});
 return run;
}
function paths(dataDirectory:string){
 const root=resolve(dataDirectory);
 if(root!==dataDirectory)throw new Refusal('NON_CANONICAL_PRIVATE_DIRECTORY');
 return {login:join(root,'panel-login.json'),attempts:join(root,'panel-login-attempts.json'),epoch:join(root,'panel-login-epoch.json')};
}
function same(left:string,right:string){
 return timingSafeEqual(createHash('sha256').update(left).digest(),createHash('sha256').update(right).digest());
}
function normalizeUser(user:string){return user.trim().toLowerCase();}
function clientKey(ip:string){
 const clean=ip.trim().toLowerCase();
 if(clean==='legacy'||clean==='unknown')return clean;
 return isIP(clean)?clean:'unknown';
}
function hashPassword(password:string,salt:Buffer){
 return new Promise<Buffer>((resolveHash,reject)=>{
  scrypt(password,salt,params.length,{N:params.N,r:params.r,p:params.p,maxmem},(error,value)=>{
   if(error||!value)reject(error??Error('PANEL_PASSWORD_HASH_FAILED'));
   else resolveHash(Buffer.from(value));
  });
 });
}
async function writePrivate(path:string,value:unknown){
 const temporary=`${path}.${randomUUID()}.tmp`;
 try{
  await writeFile(temporary,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});
  await rename(temporary,path);
 }finally{await rm(temporary,{force:true});}
}
async function readLoginState({login,epoch}:ReturnType<typeof paths>){
 try{
  const record:unknown=JSON.parse(await readFile(login,'utf8'));
  const credential=credentialSchema.safeParse(record);
  if(credential.success){
   if(credential.data.changedAt!==undefined)return {credential:credential.data,changedAt:credential.data.changedAt,legacy:false};
   return {credential:credential.data,changedAt:await legacyEpoch(epoch),legacy:true};
  }
  return {credential:null,changedAt:epochSchema.parse(record).changedAt,legacy:false};
 }catch(error){
  if((error as NodeJS.ErrnoException).code==='ENOENT')return {credential:null,changedAt:await legacyEpoch(epoch),legacy:true};
  return {credential:null,changedAt:Infinity,legacy:false};
 }
}
async function legacyEpoch(path:string){
 try{return epochSchema.parse(JSON.parse(await readFile(path,'utf8'))).changedAt;}
 catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT'?0:Infinity;}
}
async function commitLoginState(path:string,state:unknown){
 const temporary=path+'.'+randomUUID()+'.tmp';
 const handle=await open(temporary,'wx',0o600);
 try{
  try{await handle.writeFile(JSON.stringify(state)+'\n');await handle.sync();}
  finally{await handle.close();}
  await rename(temporary,path);
  const parent=await open(dirname(path),'r');
  try{await parent.sync();}finally{await parent.close();}
 }finally{await rm(temporary,{force:true});}
}
async function readAttempts(path:string):Promise<Attempts>{
 try{return attemptSchema.parse(JSON.parse(await readFile(path,'utf8')));}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {failures:[],lockedUntil:0};throw error;}
}
export async function panelCredentialState(dataDirectory:string){
 const {changedAt,legacy}=await readLoginState(paths(dataDirectory));
 return {changedAt,legacy};
}
async function nextEpoch(dataDirectory:string){
 const {changedAt}=await panelCredentialState(dataDirectory);
 return Math.max(Date.now(),Number.isFinite(changedAt)?changedAt+1:0);
}
/** Asks twice with readline output silenced, unless AC_PANEL_PASSWORD is already set. */
export async function promptPanelPassword(ask:(label:string)=>Promise<string>=hiddenQuestion){
 if(process.env.AC_PANEL_PASSWORD!==undefined)return process.env.AC_PANEL_PASSWORD;
 const first=await ask('Senha: ');
 const second=await ask('Repita a senha: ');
 if(first!==second)throw Error('PANEL_PASSWORD_MISMATCH');
 return first;
}
function hiddenQuestion(label:string){
 return new Promise<string>((resolveQuestion,reject)=>{
  const output=new Writable({write(_chunk,_encoding,callback){callback();}});
  const rl=createInterface({input:process.stdin,output,terminal:true});
  let settled=false;
  const finish=(error:Error|undefined,answer?:string)=>{
   if(settled)return;
   settled=true;
   rl.close();
   if(error)reject(error);
   else{process.stdout.write('\n');resolveQuestion(answer??'');}
  };
  process.stdout.write(label);
  rl.once('error',error=>finish(error));
  rl.question('',answer=>finish(undefined,answer));
 });
}
export async function savePanelLogin(dataDirectory:string,user:string,password:string,now=Date.now()){
 const normalized=normalizeUser(user);
 if(!userPattern.test(normalized))throw Error('INVALID_PANEL_USER');
 if(password.length<12||password.length>200)throw Error('INVALID_PANEL_PASSWORD');
 const file=paths(dataDirectory);
 return exclusive(file.login,async()=>{
  const salt=randomBytes(16);
  const hash=await hashPassword(password,salt);
  const record:Credential={user:normalized,salt:salt.toString('hex'),hash:hash.toString('hex'),params:{N:params.N,r:params.r,p:params.p,length:params.length},updatedAt:new Date(now).toISOString(),changedAt:await nextEpoch(dataDirectory)};
  await writePrivate(file.attempts,{failures:[],lockedUntil:0});
  await commitLoginState(file.login,record);
  return {user:normalized};
 });
}
export async function removePanelLogin(dataDirectory:string){
 const file=paths(dataDirectory);
 return exclusive(file.login,async()=>{
  await rm(file.attempts,{force:true});
  await commitLoginState(file.login,{changedAt:await nextEpoch(dataDirectory)});
 });
}
export async function panelPasswordConfigured(dataDirectory:string){
 try{return (await readLoginState(paths(dataDirectory))).credential!==null;}
 catch{return false;}
}
/** Wrong user and wrong password both return invalid. A missing user still runs scrypt. */
export async function verifyPanelLogin(dataDirectory:string,user:string,password:string,now=Date.now(),ip='unknown'):Promise<'accepted'|'invalid'|'limited'>{
 const file=paths(dataDirectory);
 const key=clientKey(ip);
 return exclusive(file.login,async()=>{
  const attempts=await readAttempts(file.attempts);
  if(attempts.lockedUntil>now)return 'limited';
  const failures=attempts.failures.filter(item=>now-item.at<windowMs);
  if(failures.filter(item=>item.ip===key).length>=attemptLimit||failures.length>=globalLimit)return 'limited';
  const {credential}=await readLoginState(file);
  const normalized=normalizeUser(user);
  const userOk=credential!==null&&same(credential.user,normalized);
  const bounded=password.length>=12&&password.length<=200;
  const salt=credential&&userOk?Buffer.from(credential.salt,'hex'):dummySalt;
  const expected=credential&&userOk?Buffer.from(credential.hash,'hex'):dummyHash;
  const actual=await hashPassword(bounded?password:dummyPassword,salt);
  const ok=userOk&&bounded&&actual.length===expected.length&&timingSafeEqual(actual,expected);
  if(!ok){
   failures.push({ip:key,at:now});
   if(failures.filter(item=>item.ip===key).length>=attemptLimit){
    for(const item of failures)if(item.ip===key)item.at=now;
   }
   await writePrivate(file.attempts,{failures,lockedUntil:0});
   return 'invalid';
  }
  await writePrivate(file.attempts,{failures:failures.filter(item=>item.ip!==key),lockedUntil:0});
  return 'accepted';
 });
}
export function panelLoginDenied(verdict:'invalid'|'limited'){
 if(verdict==='limited')return Response.json({error:'LOGIN_LIMIT'},{status:429,headers:{'cache-control':'no-store','retry-after':'60'}});
 return Response.json({error:'LOGIN_INVALID'},{status:401,headers:{'cache-control':'no-store'}});
}
