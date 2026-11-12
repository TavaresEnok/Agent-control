import {createHash, randomInt, randomUUID, timingSafeEqual} from 'node:crypto';
import {chmod, readFile, rename, writeFile} from 'node:fs/promises';
import {isIP} from 'node:net';
import {join, resolve} from 'node:path';
import {z} from 'zod';
import {Refusal} from './contracts.ts';

const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const lifetimeMs=10*60*1000;
const windowMs=60*1000;
const attemptLimit=5;
const globalLimit=100;
const chains=new Map<string,Promise<unknown>>();
const failureSchema=z.union([
 z.number().int().nonnegative(),
 z.object({ip:z.string().min(1).max(64),at:z.number().int().nonnegative()}).strict(),
]);
const fileSchema=z.object({
 codes:z.array(z.object({hash:z.string().regex(/^[a-f0-9]{64}$/),expiresAt:z.number().int().positive()}).strict()).max(20),
 failures:z.array(failureSchema).max(globalLimit),
 lockedUntil:z.number().int().nonnegative(),
}).strict();
type Failure={ip:string;at:number};
type Store={codes:{hash:string;expiresAt:number}[];failures:Failure[];lockedUntil:number};

function exclusive<T>(path:string,fn:()=>Promise<T>):Promise<T>{
 const previous=chains.get(path)??Promise.resolve();
 const run=previous.then(fn,fn);
 chains.set(path,run.then(()=>undefined,()=>undefined));
 return run;
}
function codePath(dataDirectory:string){
 const root=resolve(dataDirectory);
 if(root!==dataDirectory)throw new Refusal('NON_CANONICAL_PRIVATE_DIRECTORY');
 return join(root,'pair-codes.json');
}
function same(left:string,right:string){
 const a=Buffer.from(left),b=Buffer.from(right);
 return a.length===b.length&&timingSafeEqual(a,b);
}
function hashCode(code:string){return createHash('sha256').update(code).digest('hex');}
function randomCode(){
 let code='';
 for(let index=0;index<8;index++)code+=alphabet[randomInt(alphabet.length)];
 return code;
}
function clientKey(ip:string){
 const clean=ip.trim().toLowerCase();
 if(clean==='legacy'||clean==='unknown')return clean;
 return isIP(clean)?clean:'unknown';
}
/** First address Caddy puts in x-forwarded-for, otherwise the connection address. */
export function pairClientIp(forwardedFor:string|null|undefined,connectionAddress?:string|null){
 const first=forwardedFor?.split(',')[0]?.trim()??'';
 if(isIP(first))return first.toLowerCase();
 const remote=connectionAddress?.trim()??'';
 if(isIP(remote))return remote.toLowerCase();
 return 'unknown';
}
async function readStore(path:string):Promise<Store>{
 try{
  const parsed=fileSchema.parse(JSON.parse(await readFile(path,'utf8')));
  return {codes:parsed.codes,lockedUntil:parsed.lockedUntil,failures:parsed.failures.map(item=>typeof item==='number'?{ip:'legacy',at:item}:{ip:clientKey(item.ip),at:item.at})};
 }
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {codes:[],failures:[],lockedUntil:0};throw error;}
}
async function writeStore(path:string,store:Store){
 const temporary=`${path}.${randomUUID()}.tmp`;
 await writeFile(temporary,JSON.stringify(store)+'\n',{mode:0o600,flag:'wx'});
 await chmod(temporary,0o600);
 await rename(temporary,path);
 await chmod(path,0o600);
}
function normalize(code:string){return code.trim().toUpperCase().replaceAll(' ','');}

/** Prints nothing. The caller shows the code once; only its hash is stored. */
export async function createPairCode(dataDirectory:string,now=Date.now()){
 const path=codePath(dataDirectory);
 return exclusive(path,async()=>{
  const store=await readStore(path);
  store.codes=store.codes.filter(item=>item.expiresAt>now).slice(-19);
  const code=randomCode();
  const expiresAt=now+lifetimeMs;
  store.codes.push({hash:hashCode(code),expiresAt});
  await writeStore(path,store);
  return {code,expiresAt};
 });
}
/** One use, ten minutes. Five wrong attempts in a minute lock that address; one hundred lock every address. */
export async function redeemPairCode(dataDirectory:string,code:string,now=Date.now(),ip='unknown'):Promise<'accepted'|'invalid'|'limited'>{
 const path=codePath(dataDirectory);
 const key=clientKey(ip);
 return exclusive(path,async()=>{
  const store=await readStore(path);
  // A lock written by the previous global limiter still blocks every address until it expires.
  if(store.lockedUntil>now)return 'limited';
  const failures=store.failures.filter(item=>now-item.at<windowMs);
  if(failures.filter(item=>item.ip===key).length>=attemptLimit||failures.length>=globalLimit)return 'limited';
  store.codes=store.codes.filter(item=>item.expiresAt>now);
  const normalized=normalize(code);
  const shaped=/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(normalized);
  const hash=shaped?hashCode(normalized):'';
  const index=shaped?store.codes.findIndex(item=>same(item.hash,hash)):-1;
  if(index<0){
   failures.push({ip:key,at:now});
   // Five errors block this address for a full minute from the last one, not from the first.
   if(failures.filter(item=>item.ip===key).length>=attemptLimit){
    for(const item of failures)if(item.ip===key)item.at=now;
   }
   store.failures=failures;
   store.lockedUntil=0;
   await writeStore(path,store);
   return 'invalid';
  }
  store.codes.splice(index,1);
  store.failures=failures.filter(item=>item.ip!==key);
  store.lockedUntil=0;
  await writeStore(path,store);
  return 'accepted';
 });
}
