import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {Refusal} from './contracts.ts';

export type RecoveryCatalogLeaseRequest={directory:string;installationId:string;catalogId:string;manifestHash:string;epoch:number;kind:'native'|'ssh';authority:string;identity:Record<string,unknown>;operation:string;requestDigest:string};
const helper=fileURLToPath(new URL('../services/recovery/catalog_lease.py',import.meta.url));
/** The pending journal entry is synced before this resolves. Keep the returned
 * lease until the transport finishes, including its uncertain-error path.
 * The signal detects helper death for local cancellation, but a host-side
 * epoch fence is still required for requests already in flight. */
export async function acquireRecoveryCatalogLease(request:RecoveryCatalogLeaseRequest){
 const child=spawn('/usr/bin/python3',[helper],{env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'},stdio:['pipe','pipe','ignore']});
 const lines=createInterface({input:child.stdout}),controller=new AbortController();let ended=false,released=false;
 const exit=new Promise<number|null>((resolve,reject)=>{child.once('error',error=>{controller.abort();reject(error);});child.once('close',code=>{ended=true;if(!released)controller.abort();resolve(code);});});
 try{
  const result=await new Promise<{state?:string;error?:string}>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Refusal('CATALOG_LEASE_UNCERTAIN')),10000);
   lines.once('line',line=>{clearTimeout(timer);try{resolve(JSON.parse(line));}catch{reject(new Refusal('CATALOG_LEASE_UNCERTAIN'));}});
   exit.then(()=>{clearTimeout(timer);reject(new Refusal('CATALOG_LEASE_UNCERTAIN'));},()=>{clearTimeout(timer);reject(new Refusal('CATALOG_LEASE_UNCERTAIN'));});
   child.stdin.on('error',()=>{});child.stdin.write(JSON.stringify(request)+'\n');
  });
  if(result.state!=='pending')throw new Refusal(typeof result.error==='string'&&/^CATALOG_[A-Z0-9_]+$/.test(result.error)?result.error:'CATALOG_LEASE_UNCERTAIN');
  if(controller.signal.aborted)throw new Refusal('CATALOG_LEASE_UNCERTAIN');
  return {signal:controller.signal,async release(){if(released)return;released=true;child.stdin.end();const code=await exit;lines.close();if(code!==0)throw new Refusal('CATALOG_LEASE_UNCERTAIN');}};
 }catch(error){child.stdin.destroy();if(!ended)child.kill('SIGKILL');await exit.catch(()=>{});lines.close();throw error;}
}
