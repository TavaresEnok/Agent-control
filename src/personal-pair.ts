import {createHash, randomInt, randomUUID, timingSafeEqual} from 'node:crypto';
import {chmod, readFile, rename, writeFile} from 'node:fs/promises';
import {BlockList,isIP} from 'node:net';
import {join, resolve} from 'node:path';
import {z} from 'zod';
import {Refusal} from './contracts.ts';
import {withPrivateFileLock} from './private-file-lock.ts';

const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const lifetimeMs=10*60*1000;
const windowMs=60*1000;
const attemptLimit=5;
const globalLimit=100;
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
function plainAddress(value:string){
 const clean=value.trim().toLowerCase();
 const mapped=/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(clean);
 const address=mapped?mapped[1]!:clean;
 return isIP(address)?address:'';
}
/** Trusted proxies are exact addresses or CIDR ranges ("127.0.0.1", "::1", "10.0.0.0/8"). Invalid entries are dropped, never trusted. */
export function trustedProxyList(value:string|readonly string[]|undefined|null){
 const list=new BlockList();
 const items=typeof value==='string'?value.split(','):[...(value??[])];
 for(const raw of items){
  const item=raw.trim();if(!item)continue;
  const [host,prefix,...rest]=item.split('/');
  const address=plainAddress(host??'');
  if(!address||rest.length)continue;
  const family=isIP(address)===4?'ipv4':'ipv6';
  try{
   if(prefix===undefined)list.addAddress(address,family);
   else if(/^\d{1,3}$/.test(prefix)&&Number(prefix)<=(family==='ipv4'?32:128))list.addSubnet(address,Number(prefix),family);
  }catch{/* ignored: an unparseable entry trusts nothing */}
 }
 return list;
}
function trusted(list:BlockList,address:string){
 return list.check(address,isIP(address)===4?'ipv4':'ipv6');
}
/** Proxies the installation trusts to report the client in x-forwarded-for. Empty by default: only the connection address counts. */
export function configuredTrustedProxies(env:NodeJS.ProcessEnv=process.env){return trustedProxyList(env.AC_TRUSTED_PROXIES);}
/**
 * Address that owns a login attempt. The connection address is used unless it belongs to a
 * trusted proxy; only then is x-forwarded-for read, from the right, skipping further trusted
 * proxies, so a client-written entry on the left is never believed.
 */
export function pairClientIp(forwardedFor:string|null|undefined,connectionAddress?:string|null,trustedProxies:BlockList=configuredTrustedProxies()){
 const remote=plainAddress(connectionAddress??'');
 if(!remote)return 'unknown';
 if(!trusted(trustedProxies,remote))return remote;
 const hops=(forwardedFor??'').split(',').map(item=>item.trim()).filter(Boolean);
 for(let index=hops.length-1;index>=0;index--){
  const hop=plainAddress(hops[index]!);
  if(!hop)return remote;
  if(!trusted(trustedProxies,hop))return hop;
 }
 return remote;
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
 return withPrivateFileLock(path+'.lock','PAIR_CODE_STORE_BUSY',async()=>{
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
 return withPrivateFileLock(path+'.lock','PAIR_CODE_STORE_BUSY',async()=>{
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
