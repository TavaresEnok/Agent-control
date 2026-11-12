import {createHash, randomBytes, randomUUID, scrypt, timingSafeEqual} from 'node:crypto';
import {chmod, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {isIP} from 'node:net';
import {join, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {Writable} from 'node:stream';
import {z} from 'zod';
import {Refusal} from './contracts.ts';

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
}).strict();
const attemptSchema=z.object({
 failures:z.array(z.object({ip:z.string().min(1).max(64),at:z.number().int().nonnegative()}).strict()).max(globalLimit),
 lockedUntil:z.number().int().nonnegative(),
}).strict();
type Credential=z.infer<typeof credentialSchema>;
type Attempts=z.infer<typeof attemptSchema>;

function exclusive<T>(path:string,fn:()=>Promise<T>):Promise<T>{
 const previous=chains.get(path)??Promise.resolve();
 const run=previous.then(fn,fn);
 chains.set(path,run.then(()=>undefined,()=>undefined));
 return run;
}
function paths(dataDirectory:string){
 const root=resolve(dataDirectory);
 if(root!==dataDirectory)throw new Refusal('NON_CANONICAL_PRIVATE_DIRECTORY');
 return {login:join(root,'panel-login.json'),attempts:join(root,'panel-login-attempts.json')};
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
 await writeFile(temporary,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});
 await chmod(temporary,0o600);
 await rename(temporary,path);
 await chmod(path,0o600);
}
async function readCredential(path:string):Promise<Credential|null>{
 try{return credentialSchema.parse(JSON.parse(await readFile(path,'utf8')));}
 catch(error){
  const code=(error as NodeJS.ErrnoException).code;
  if(code==='ENOENT'||error instanceof SyntaxError||error instanceof z.ZodError||(error as {name?:string}).name==='ZodError')return null;
  throw error;
 }
}
async function readAttempts(path:string):Promise<Attempts>{
 try{return attemptSchema.parse(JSON.parse(await readFile(path,'utf8')));}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {failures:[],lockedUntil:0};throw error;}
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
  const record:Credential={user:normalized,salt:salt.toString('hex'),hash:hash.toString('hex'),params:{N:params.N,r:params.r,p:params.p,length:params.length},updatedAt:new Date(now).toISOString()};
  await writePrivate(file.login,record);
  await writePrivate(file.attempts,{failures:[],lockedUntil:0});
  return {user:normalized};
 });
}
export async function removePanelLogin(dataDirectory:string){
 const file=paths(dataDirectory);
 return exclusive(file.login,async()=>{
  await rm(file.login,{force:true});
  await rm(file.attempts,{force:true});
 });
}
export async function panelPasswordConfigured(dataDirectory:string){
 try{return (await readCredential(paths(dataDirectory).login))!==null;}
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
  const credential=await readCredential(file.login);
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
