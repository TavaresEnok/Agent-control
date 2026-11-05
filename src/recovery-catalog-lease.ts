import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {Refusal} from './contracts.ts';

export type RecoveryCatalogLeaseRequest={directory:string;installationId:string;catalogId:string;epoch:number;kind:'native'|'ssh';authority:string;operation:string;requestDigest:string};
const helper=fileURLToPath(new URL('../services/recovery/catalog_lease.py',import.meta.url));
/** The pending journal entry is synced before this resolves. Keep the returned
 * lease until the transport finishes, including its uncertain-error path. */
export async function acquireRecoveryCatalogLease(request:RecoveryCatalogLeaseRequest){
 const child=spawn('/usr/bin/python3',[helper],{env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'},stdio:['pipe','pipe','ignore']});
 const lines=createInterface({input:child.stdout});let ended=false;
 const exit=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>{ended=true;resolve(code);});});
 try{
  const result=await new Promise<{state?:string;error?:string}>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Refusal('CATALOG_LEASE_UNCERTAIN')),10000);
   lines.once('line',line=>{clearTimeout(timer);try{resolve(JSON.parse(line));}catch{reject(new Refusal('CATALOG_LEASE_UNCERTAIN'));}});
   exit.then(()=>{clearTimeout(timer);reject(new Refusal('CATALOG_LEASE_UNCERTAIN'));},()=>{clearTimeout(timer);reject(new Refusal('CATALOG_LEASE_UNCERTAIN'));});
   child.stdin.on('error',()=>{});child.stdin.write(JSON.stringify(request)+'\n');
  });
  if(result.state!=='pending')throw new Refusal(typeof result.error==='string'&&/^CATALOG_[A-Z0-9_]+$/.test(result.error)?result.error:'CATALOG_LEASE_UNCERTAIN');
  let released=false;
  return {async release(){if(released)return;released=true;child.stdin.end();const code=await exit;lines.close();if(code!==0)throw new Refusal('CATALOG_LEASE_UNCERTAIN');}};
 }catch(error){child.stdin.destroy();if(!ended)child.kill('SIGKILL');await exit.catch(()=>{});lines.close();throw error;}
}
