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
 const value=await runCatalog('catalog_checkpoint.py',{directory:config.directory,installationId:config.installationId,catalogId:config.catalogId,manifestHash:config.manifestHash});
 try{return RecoveryCatalogCheckpoint.parse(value);}catch{throw new Refusal('CATALOG_UNCERTAIN');}
}
async function runCatalog(helper:string,request:object){
 const child=spawn('/usr/bin/python3',[fileURLToPath(new URL('../services/recovery/'+helper,import.meta.url))],{env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'},stdio:['pipe','pipe','ignore']});
 const output=await new Promise<string>((resolve,reject)=>{let bytes='',settled=false;
  const timer=setTimeout(()=>{settled=true;child.kill('SIGKILL');reject(new Refusal('CATALOG_UNCERTAIN'));},10000);
  child.stdout.on('data',chunk=>{bytes+=String(chunk);if(bytes.length>16384){settled=true;clearTimeout(timer);child.kill('SIGKILL');reject(new Refusal('CATALOG_UNCERTAIN'));}});
  child.once('error',()=>{if(!settled){settled=true;clearTimeout(timer);reject(new Refusal('CATALOG_UNCERTAIN'));}});
  child.once('close',code=>{if(!settled){settled=true;clearTimeout(timer);if(code!==0)reject(new Refusal('CATALOG_UNCERTAIN'));else resolve(bytes);}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request)+'\n');
 });
 try{return JSON.parse(output) as unknown;}catch{throw new Refusal('CATALOG_UNCERTAIN');}
}
export async function readRecoveryManifest(config:RecoveryInventoryConfig,checkpoint:z.infer<typeof RecoveryCatalogCheckpoint>){
 const parsed=Config.parse(config);RecoveryCatalogCheckpoint.parse(checkpoint);
 return runCatalog('catalog_manifest.py',{directory:parsed.directory,installationId:parsed.installationId,catalogId:parsed.catalogId,manifestHash:parsed.manifestHash,checkpoint});
}
/** Advance only after the restored installation's durable closed marker has
 * been checked. No PG row lock is held while waiting on the catalog lock. */
export async function beginRestoredPhysicalRecovery(ledger:Ledger,raw:Config,recoveryId:string){
 const config=Config.parse(raw);z.uuid().parse(recoveryId);await configureRecoveryInventory(ledger,config);
 const row=await ledger.tx(async c=>{
  const state=(await c.query(`SELECT r.*,a.enabled,a.reason FROM ac_recovery_inventory_restores r CROSS JOIN ac_installation_identity i CROSS JOIN ac_admission_control a
   WHERE r.installation_id=i.id AND a.id=1 FOR UPDATE OF r`)).rows[0];
  if(!state||state.enabled!==false||state.reason!=='r3-restored-awaiting-reconciliation'||state.state!=='physical-reconciliation-required'||state.source_installation_id!==config.installationId)throw new Refusal('RESTORE_PHYSICAL_RECONCILIATION_REQUIRED');
  if(state.recovery_id&&(state.recovery_id!==recoveryId||state.source_epoch!==config.epoch))throw new Refusal('CATALOG_RECOVERY_CONFLICT');
  if(!state.recovery_id)await c.query('UPDATE ac_recovery_inventory_restores SET recovery_id=$2,source_epoch=$3 WHERE installation_id=$1',[state.installation_id,recoveryId,config.epoch]);
  return RecoveryCatalogCheckpoint.parse(state.checkpoint);
 });
 const result=z.object({epoch:z.number().int().positive(),checkpoint:RecoveryCatalogCheckpoint}).strict().parse(await runCatalog('catalog_advance.py',{
  directory:config.directory,installationId:config.installationId,catalogId:config.catalogId,manifestHash:config.manifestHash,
  checkpoint:row,expectedEpoch:config.epoch,recoveryId}));
 await ledger.tx(async c=>{const saved=await c.query(`UPDATE ac_recovery_inventory_restores SET recovery_epoch=$2 WHERE installation_id=(SELECT id FROM ac_installation_identity) AND recovery_id=$1 AND source_epoch=$3 AND (recovery_epoch IS NULL OR recovery_epoch=$2)`,[recoveryId,result.epoch,config.epoch]);if(saved.rowCount!==1)throw new Refusal('CATALOG_RECOVERY_CONFLICT');});
 return result;
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
