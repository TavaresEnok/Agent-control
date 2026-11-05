import {realpath} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {Ledger} from './ledger.ts';
import {Refusal} from './contracts.ts';
import {acquireRecoveryCatalogLease} from './recovery-catalog-lease.ts';

const Config=z.object({directory:z.string().min(1),installationId:z.uuid(),catalogId:z.uuid(),manifestHash:z.string().regex(/^[a-f0-9]{64}$/),epoch:z.number().int().positive()}).strict();
type Config=z.infer<typeof Config>;
export type RecoveryInventoryConfig=Config;
export const RecoveryCatalogCheckpoint=z.object({catalogId:z.uuid(),installationId:z.uuid(),manifestHash:z.string().regex(/^[a-f0-9]{64}$/),seq:z.number().int().nonnegative(),head:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type RecoveryInventoryCapability={readonly config:Readonly<Config>;lease(kind:'native'|'ssh',authority:string,identity:Record<string,unknown>,requestDigest:string):ReturnType<typeof acquireRecoveryCatalogLease>;checkpoint():Promise<z.infer<typeof RecoveryCatalogCheckpoint>>};
const attached=new WeakMap<Ledger,RecoveryInventoryCapability>();
/** Trusted installation bootstrap supplies this capability; serialized request
 * data alone does not activate a new external authority. */
export async function configureRecoveryInventory(ledger:Ledger,raw:Config):Promise<void>{
 const config=Config.parse(raw);
 if(!isAbsolute(config.directory)||resolve(config.directory)!==config.directory||await realpath(config.directory)!==config.directory)throw new Refusal('CATALOG_DIRECTORY_UNSAFE');
 const row=(await ledger.pool.query('SELECT * FROM ac_recovery_inventory_policy WHERE singleton')).rows[0];
 if(!row?.required||row.source_installation_id!==config.installationId||row.catalog_id!==config.catalogId||row.manifest_hash!==config.manifestHash)throw new Refusal('RECOVERY_INVENTORY_POLICY_MISMATCH');
 const frozen=Object.freeze({...config});
 attached.set(ledger,{config:frozen,lease:(kind,authority,identity,requestDigest)=>acquireRecoveryCatalogLease({...frozen,kind,authority,identity,requestDigest,operation:randomUUID()}),checkpoint:()=>catalogCheckpoint(frozen)});
}
async function catalogCheckpoint(config:Readonly<Config>){
 const child=spawn('/usr/bin/python3',[fileURLToPath(new URL('../services/recovery/catalog_checkpoint.py',import.meta.url))],{env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'},stdio:['pipe','pipe','ignore']});
 const output=await new Promise<string>((resolve,reject)=>{let bytes='',settled=false;
  const timer=setTimeout(()=>{settled=true;child.kill('SIGKILL');reject(new Refusal('CATALOG_UNCERTAIN'));},10000);
  child.stdout.on('data',chunk=>{bytes+=String(chunk);if(bytes.length>16384){settled=true;clearTimeout(timer);child.kill('SIGKILL');reject(new Refusal('CATALOG_UNCERTAIN'));}});
  child.once('error',()=>{if(!settled){settled=true;clearTimeout(timer);reject(new Refusal('CATALOG_UNCERTAIN'));}});
  child.once('close',code=>{if(!settled){settled=true;clearTimeout(timer);if(code!==0)reject(new Refusal('CATALOG_UNCERTAIN'));else resolve(bytes);}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({directory:config.directory,installationId:config.installationId,catalogId:config.catalogId,manifestHash:config.manifestHash})+'\n');
 });
 try{return RecoveryCatalogCheckpoint.parse(JSON.parse(output));}catch{throw new Refusal('CATALOG_UNCERTAIN');}
}
/** Must be called within the effect's existing transaction. The row lock
 * serializes any policy transition with the authorized transport effect. */
export async function requireRecoveryInventory(c:Pick<PoolClient,'query'>,ledger:Ledger):Promise<RecoveryInventoryCapability|undefined>{
 const row=(await c.query('SELECT * FROM ac_recovery_inventory_policy WHERE singleton FOR SHARE')).rows[0];
 if(!row)throw new Refusal('RECOVERY_INVENTORY_POLICY_MISSING');
 if(!row.required)return;
 const cap=attached.get(ledger);
 if(!cap||row.source_installation_id!==cap.config.installationId||row.catalog_id!==cap.config.catalogId||row.manifest_hash!==cap.config.manifestHash)throw new Refusal('RECOVERY_INVENTORY_REQUIRED');
 return cap;
}
