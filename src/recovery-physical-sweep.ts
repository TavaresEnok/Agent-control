import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Ledger} from './ledger.ts';
import {digest,Refusal} from './contracts.ts';
import {beginRestoredPhysicalRecovery,configureRecoveryInventory,readRecoveryManifest,RecoveryCatalogCheckpoint,type RecoveryInventoryConfig} from './recovery-inventory.ts';
import {NativeResourceDockerDaemon,assertIssuedNativeResourceDaemon} from './native-resource-envelope.ts';
import {OpenSshTransport,assertIssuedOpenSshTransport,type RemoteHost} from './remote.ts';
import {assertAdmissionReconciled} from './admission.ts';

const Authority=z.object({kind:z.enum(['native','ssh']),id:z.string().min(1),identity:z.record(z.string(),z.unknown())}).strict();
const Manifest=z.object({schemaVersion:z.literal(1),catalogId:z.uuid(),installationId:z.uuid(),directoryDevice:z.number(),directoryInode:z.number(),authorities:z.array(Authority).min(1)}).strict();
const Physical=z.object({schemaVersion:z.literal(1),operationId:z.uuid(),authorityId:z.string(),anchorId:z.string().regex(/^[a-f0-9]{64}$/),installationId:z.string(),stateRoot:z.string(),authorityEpoch:z.number().int().positive(),recoveryRequired:z.literal(true)}).strict();
const RemoteProof=Physical.omit({recoveryRequired:true}).extend({state:z.literal('neutralized'),operations:z.array(z.uuid())}).strict();
const Locked=z.object({state:z.literal('locked'),epoch:z.number().int().positive(),manifest:Manifest,pending:z.record(z.string(),z.unknown())}).strict();
const Recorded=z.object({state:z.literal('recorded'),checkpoint:RecoveryCatalogCheckpoint}).strict();
type Adapters={native:ReadonlyMap<string,NativeResourceDockerDaemon>;ssh:ReadonlyMap<string,{host:RemoteHost;transport:OpenSshTransport}>};

async function releaseAuthority(authority:z.infer<typeof Authority>,adapters:Adapters,recoveryId:string,epoch:number){
 if(authority.kind==='native'){
  const adapter=adapters.native.get(authority.id);assertIssuedNativeResourceDaemon(adapter);
  if(Object.getPrototypeOf(adapter)!==NativeResourceDockerDaemon.prototype||adapter.recoveryEpoch!==epoch||digest(adapter.recoveryIdentity)!==digest(authority.identity))throw new Refusal('RECOVERY_PHYSICAL_IDENTITY_MISMATCH');
  await adapter.releaseRecovery(recoveryId);return;
 }
 const adapter=adapters.ssh.get(authority.id);if(!adapter||Object.getPrototypeOf(adapter.transport)!==OpenSshTransport.prototype||adapter.host.id!==authority.id)throw new Refusal('RECOVERY_PHYSICAL_IDENTITY_MISMATCH');
 assertIssuedOpenSshTransport(adapter.transport);
 const operationId=randomUUID(),host=Physical.parse(await adapter.transport.exchange(adapter.host,{schemaVersion:1,action:'recovery-authority',operationId,recoveryToken:recoveryId}));
 const identity={hostId:adapter.host.id,hostFingerprint:adapter.host.fingerprint,authorityId:host.authorityId,anchorId:host.anchorId,installationId:host.installationId,stateRoot:host.stateRoot};
 if(host.operationId!==operationId||host.authorityEpoch!==epoch||digest(identity)!==digest(authority.identity))throw new Refusal('RECOVERY_PHYSICAL_IDENTITY_MISMATCH');
 const reply=z.object({schemaVersion:z.literal(1),operationId:z.uuid(),state:z.literal('released'),authorityId:z.string(),authorityEpoch:z.number().int().positive()}).strict().parse(await adapter.transport.exchange(adapter.host,{schemaVersion:1,action:'recovery-release',operationId,recoveryToken:recoveryId}));
 if(reply.operationId!==operationId||reply.authorityId!==host.authorityId||reply.authorityEpoch!==epoch)throw new Refusal('RECOVERY_PHYSICAL_IDENTITY_MISMATCH');
}

/** Trusted installation bootstrap supplies the exact local physical adapters. */
export async function sweepRestoredPhysicalInventory(input:{ledger:Ledger;principal:string;config:RecoveryInventoryConfig;recoveryId:string;
 native:ReadonlyMap<string,NativeResourceDockerDaemon>;ssh:ReadonlyMap<string,{host:RemoteHost;transport:OpenSshTransport}>}){
 const {ledger,config,recoveryId}=input;const advanced=await beginRestoredPhysicalRecovery(ledger,config,recoveryId);
 const row=(await ledger.pool.query(`SELECT r.checkpoint,r.recovery_id,r.source_epoch,r.recovery_epoch,a.enabled,a.reason FROM ac_recovery_inventory_restores r
  CROSS JOIN ac_installation_identity i CROSS JOIN ac_admission_control a WHERE r.installation_id=i.id AND a.id=1`)).rows[0];
 if(!row||row.enabled!==false||row.reason!=='r3-restored-awaiting-reconciliation'||row.recovery_id!==recoveryId||row.source_epoch!==config.epoch||row.recovery_epoch!==advanced.epoch)throw new Refusal('RESTORE_PHYSICAL_RECONCILIATION_REQUIRED');
 const checkpoint=RecoveryCatalogCheckpoint.parse(row.checkpoint);
 const child=spawn('/usr/bin/python3',[fileURLToPath(new URL('../services/recovery/catalog_reconcile.py',import.meta.url))],{env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'},stdio:['pipe','pipe','ignore']});
 const lines=createInterface({input:child.stdout}),iterator=lines[Symbol.asyncIterator]();let exited=false;
 const closed=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>{exited=true;resolve(code);});});
 const next=async()=>{let timer:ReturnType<typeof setTimeout>|undefined;try{const result=await Promise.race([iterator.next(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Refusal('CATALOG_UNCERTAIN')),30000);})]);if(result.done)throw new Refusal('CATALOG_UNCERTAIN');try{return JSON.parse(result.value) as unknown;}catch{throw new Refusal('CATALOG_UNCERTAIN');}}finally{if(timer)clearTimeout(timer);}};
 const live=()=>{if(exited||child.exitCode!==null||child.signalCode!==null)throw new Refusal('CATALOG_UNCERTAIN');};
 try{
  child.stdin.on('error',()=>{});child.stdin.write(JSON.stringify({directory:config.directory,installationId:config.installationId,catalogId:config.catalogId,manifestHash:config.manifestHash,checkpoint,expectedEpoch:config.epoch,recoveryId})+'\n');
  const locked=Locked.parse(await next());if(locked.epoch!==advanced.epoch||locked.manifest.catalogId!==config.catalogId||locked.manifest.installationId!==config.installationId)throw new Refusal('CATALOG_IDENTITY_MISMATCH');
  const authorities=locked.manifest.authorities,keys=new Set(authorities.map(a=>a.kind+'\0'+a.id));
  if(keys.size!==authorities.length||input.native.size!==authorities.filter(a=>a.kind==='native').length||input.ssh.size!==authorities.filter(a=>a.kind==='ssh').length)throw new Refusal('RECOVERY_PHYSICAL_SCOPE_INCOMPLETE');
  const proofs:{kind:'native'|'ssh';authority:string;proofDigest:string}[]=[];
  for(const authority of authorities){
   live();let proof:unknown;
   if(authority.kind==='native'){
    const adapter=input.native.get(authority.id);
    assertIssuedNativeResourceDaemon(adapter);
    if(!adapter||Object.getPrototypeOf(adapter)!==NativeResourceDockerDaemon.prototype||adapter.recoveryEpoch!==advanced.epoch||digest(adapter.recoveryIdentity)!==digest(authority.identity))throw new Refusal('RECOVERY_PHYSICAL_IDENTITY_MISMATCH');
    proof=await adapter.sweepRecovery(recoveryId);
   }else{
    const adapter=input.ssh.get(authority.id);if(!adapter||Object.getPrototypeOf(adapter.transport)!==OpenSshTransport.prototype||adapter.host.id!==authority.id)throw new Refusal('RECOVERY_PHYSICAL_IDENTITY_MISMATCH');
    assertIssuedOpenSshTransport(adapter.transport);
    const operationId=randomUUID(),host=Physical.parse(await adapter.transport.exchange(adapter.host,{schemaVersion:1,action:'recovery-authority',operationId,recoveryToken:recoveryId}));
    const identity={hostId:adapter.host.id,hostFingerprint:adapter.host.fingerprint,authorityId:host.authorityId,anchorId:host.anchorId,installationId:host.installationId,stateRoot:host.stateRoot};
    if(host.operationId!==operationId||host.authorityEpoch!==advanced.epoch||digest(identity)!==digest(authority.identity))throw new Refusal('RECOVERY_PHYSICAL_IDENTITY_MISMATCH');
    const swept=RemoteProof.parse(await adapter.transport.exchange(adapter.host,{schemaVersion:1,action:'recovery-sweep',operationId,recoveryToken:recoveryId}));
    if(swept.operationId!==operationId||swept.authorityEpoch!==advanced.epoch||swept.authorityId!==host.authorityId||swept.anchorId!==host.anchorId||swept.installationId!==host.installationId||swept.stateRoot!==host.stateRoot)throw new Refusal('RECOVERY_PHYSICAL_IDENTITY_MISMATCH');
    proof=swept;
   }
   live();proofs.push({kind:authority.kind,authority:authority.id,proofDigest:digest(proof)});
  }
  child.stdin.write(JSON.stringify({proofs})+'\n');const recorded=Recorded.parse(await next());live();
  const proofDigest=digest(proofs);
  await configureRecoveryInventory(ledger,{...config,epoch:advanced.epoch});
  const revision=await ledger.tx(async c=>{
   if(!(await c.query('SELECT 1 FROM ac_control_admins WHERE principal_id=$1',[input.principal])).rowCount)throw new Refusal('CONTROL_ADMIN_REQUIRED',403);
   const gate=(await c.query('SELECT * FROM ac_admission_control WHERE id=1 FOR UPDATE')).rows[0];
   const saved=(await c.query(`SELECT r.* FROM ac_recovery_inventory_restores r JOIN ac_installation_identity i ON i.id=r.installation_id FOR UPDATE OF r`)).rows[0];
   const policy=(await c.query('SELECT * FROM ac_recovery_inventory_policy WHERE singleton FOR SHARE')).rows[0];
   if(!gate||gate.enabled||gate.reason!=='r3-restored-awaiting-reconciliation'||!saved||saved.state!=='physical-reconciliation-required'||saved.recovery_id!==recoveryId||saved.source_epoch!==config.epoch||saved.recovery_epoch!==advanced.epoch||digest(saved.checkpoint)!==digest(checkpoint)||!policy?.required||policy.catalog_id!==config.catalogId||policy.manifest_hash!==config.manifestHash||policy.source_installation_id!==config.installationId)throw new Refusal('RESTORE_PHYSICAL_RECONCILIATION_REQUIRED');
   await assertAdmissionReconciled(c);live();
   await c.query("UPDATE ac_recovery_inventory_restores SET state='reconciled',proof_digest=$2,proof_checkpoint=$3 WHERE installation_id=$1",[saved.installation_id,proofDigest,recorded.checkpoint]);
   await c.query("UPDATE ac_admission_control SET enabled=true,revision=revision+1,reason='physical-reconciliation-confirmed',updated_at=clock_timestamp() WHERE id=1");
   return Number(gate.revision)+1;
  });
  // Physical holds remain active through the PG commit. A release failure is
  // an availability issue, and must never be reported as full completion.
  const pending:string[]=[];
  for(const authority of authorities){try{await releaseAuthority(authority,input,recoveryId,advanced.epoch);}catch{pending.push(authority.kind+':'+authority.id);}}
  return {state:pending.length?'reconciled-host-release-pending' as const:'reconciled' as const,epoch:advanced.epoch,checkpoint:recorded.checkpoint,proofDigest,admissionRevision:revision,pending};
 }finally{child.stdin.end();lines.close();if(!exited){const timer=setTimeout(()=>child.kill('SIGKILL'),5000);await closed.catch(()=>{});clearTimeout(timer);}}
}

/** Retry a partial host release only after the durable PG proof and admission
 * CAS. This never turns a failed or incomplete sweep into a success. */
export async function releaseRestoredPhysicalHolds(input:{ledger:Ledger;principal:string;config:RecoveryInventoryConfig;recoveryId:string}&Adapters){
 const {ledger,config,recoveryId}=input;
 const row=await ledger.tx(async c=>{
  if(!(await c.query('SELECT 1 FROM ac_control_admins WHERE principal_id=$1',[input.principal])).rowCount)throw new Refusal('CONTROL_ADMIN_REQUIRED',403);
  const saved=(await c.query('SELECT r.* FROM ac_recovery_inventory_restores r JOIN ac_installation_identity i ON i.id=r.installation_id')).rows[0];
  if(!saved||saved.state!=='reconciled'||saved.recovery_id!==recoveryId||saved.source_installation_id!==config.installationId||saved.source_epoch!==config.epoch||saved.recovery_epoch!==config.epoch+1||!saved.proof_digest||!saved.proof_checkpoint)throw new Refusal('RESTORE_PHYSICAL_RECONCILIATION_REQUIRED');
  return saved;
 });
 const manifest=Manifest.parse(await readRecoveryManifest(config,RecoveryCatalogCheckpoint.parse(row.proof_checkpoint)));
 if(manifest.catalogId!==config.catalogId||manifest.installationId!==config.installationId||input.native.size!==manifest.authorities.filter(a=>a.kind==='native').length||input.ssh.size!==manifest.authorities.filter(a=>a.kind==='ssh').length)throw new Refusal('RECOVERY_PHYSICAL_SCOPE_INCOMPLETE');
 const pending:string[]=[];
 for(const authority of manifest.authorities){try{await releaseAuthority(authority,input,recoveryId,Number(row.recovery_epoch));}catch{pending.push(authority.kind+':'+authority.id);}}
 return {state:pending.length?'host-release-pending' as const:'released' as const,pending};
}
