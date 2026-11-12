import {createHash, randomInt, randomUUID, timingSafeEqual} from 'node:crypto';
import {chmod, readFile, rename, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {z} from 'zod';
import {Refusal} from './contracts.ts';

const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const lifetimeMs=10*60*1000;
const windowMs=60*1000;
const attemptLimit=5;
const chains=new Map<string,Promise<unknown>>();
const fileSchema=z.object({
 codes:z.array(z.object({hash:z.string().regex(/^[a-f0-9]{64}$/),expiresAt:z.number().int().positive()}).strict()).max(20),
 failures:z.array(z.number().int().nonnegative()).max(20),
 lockedUntil:z.number().int().nonnegative(),
}).strict();
type Store=z.infer<typeof fileSchema>;

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
async function readStore(path:string):Promise<Store>{
 try{return fileSchema.parse(JSON.parse(await readFile(path,'utf8')));}
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
/** One use, ten minutes, then five wrong attempts lock every try for a minute. */
export async function redeemPairCode(dataDirectory:string,code:string,now=Date.now()):Promise<'accepted'|'invalid'|'limited'>{
 const path=codePath(dataDirectory);
 return exclusive(path,async()=>{
  const store=await readStore(path);
  if(store.lockedUntil>now)return 'limited';
  if(store.lockedUntil){store.lockedUntil=0;store.failures=[];}
  store.codes=store.codes.filter(item=>item.expiresAt>now);
  store.failures=store.failures.filter(at=>now-at<windowMs);
  const normalized=normalize(code);
  const shaped=/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(normalized);
  const hash=shaped?hashCode(normalized):'';
  const index=shaped?store.codes.findIndex(item=>same(item.hash,hash)):-1;
  if(index<0){
   store.failures.push(now);
   if(store.failures.length>=attemptLimit)store.lockedUntil=now+windowMs;
   await writeStore(path,store);
   return 'invalid';
  }
  store.codes.splice(index,1);
  store.failures=[];
  store.lockedUntil=0;
  await writeStore(path,store);
  return 'accepted';
 });
}
