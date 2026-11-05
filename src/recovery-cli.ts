import {isAbsolute,resolve} from 'node:path';
import {z} from 'zod';
import {Refusal} from './contracts.ts';
import {readPrivateFile,type Installation} from './installation.ts';
import {Ledger} from './ledger.ts';
import {NativeResourceDockerDaemon,NativeResourceEnvelope} from './native-resource-envelope.ts';
import {RemoteHostInput} from './remote.ts';
import {RemoteReturnConfig,remoteReturnTransport} from './remote-return-config.ts';
import {backupLaboratoryDatabase} from './laboratory-recovery.ts';
import {releaseRestoredPhysicalHolds,sweepRestoredPhysicalInventory} from './recovery-physical-sweep.ts';

const path=z.string().refine(p=>isAbsolute(p)&&resolve(p)===p&&!/[\0\r\n]/.test(p));
const host=RemoteHostInput.pick({id:true,hostname:true,port:true,username:true,publicKey:true,fingerprint:true,credentialRef:true,remoteRoot:true}).strict();
const adapters={native:z.array(NativeResourceEnvelope).max(64),ssh:z.array(host).max(64),transport:RemoteReturnConfig.optional()};
export const RecoveryCommandDescriptor=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('backup-laboratory'),containerId:z.string().regex(/^[a-f0-9]{64}$/),directory:path,canonicalHistoryFile:path,vaultArchiveFile:path,happierSnapshotFile:path.optional()}).strict(),
 z.object({operation:z.literal('sweep'),principal:z.string().min(1).max(200),recoveryId:z.uuid(),...adapters}).strict(),
 z.object({operation:z.literal('release'),principal:z.string().min(1).max(200),recoveryId:z.uuid(),...adapters}).strict(),
]);
/** A local private descriptor selects only existing, physically fenced authorities.
 * Backup remains restricted to the disposable synthetic laboratory helper. */
export async function executeRecoveryCommand(config:Installation,ledger:Ledger,descriptorPath:string){
 const bytes=await readPrivateFile(descriptorPath,65536,{canonical:true});let descriptor:z.infer<typeof RecoveryCommandDescriptor>;
 try{descriptor=RecoveryCommandDescriptor.parse(JSON.parse(bytes.toString('utf8')));}finally{bytes.fill(0);}
 const catalog=config.recoveryInventory;if(!catalog)throw new Refusal('RECOVERY_INVENTORY_REQUIRED');
 if(descriptor.operation==='backup-laboratory'){
  const {operation,...options}=descriptor;
  return backupLaboratoryDatabase({...options,sourceUrl:config.databaseUrl,recoveryInventory:catalog});
 }
 if(!(await ledger.pool.query('SELECT 1 FROM ac_control_admins WHERE principal_id=$1',[descriptor.principal])).rowCount)throw new Refusal('CONTROL_ADMIN_REQUIRED',403);
 const native=new Map<string,NativeResourceDockerDaemon>();
 for(const envelope of descriptor.native){
  if(envelope.authorityEpoch!==catalog.epoch+1)throw new Refusal('RECOVERY_PHYSICAL_EPOCH_MISMATCH');
  const adapter=new NativeResourceDockerDaemon(envelope),id=adapter.authorityId+':'+adapter.stateRoot;
  if(native.has(id))throw new Refusal('RECOVERY_PHYSICAL_SCOPE_INCOMPLETE');native.set(id,adapter);
 }
 const transport=remoteReturnTransport(descriptor.transport),ssh=new Map();
 if(descriptor.ssh.length&&!transport)throw new Refusal('RECOVERY_PHYSICAL_SCOPE_INCOMPLETE');
 for(const item of descriptor.ssh){
  if(ssh.has(item.id))throw new Refusal('RECOVERY_PHYSICAL_SCOPE_INCOMPLETE');
  ssh.set(item.id,{host:{id:item.id,hostname:item.hostname,port:item.port,username:item.username,public_key:item.publicKey,fingerprint:item.fingerprint,credential_ref:item.credentialRef,remote_root:item.remoteRoot},transport:transport!});
 }
 const input={ledger,principal:descriptor.principal,config:catalog,recoveryId:descriptor.recoveryId,native,ssh};
 return descriptor.operation==='sweep'?sweepRestoredPhysicalInventory(input):releaseRestoredPhysicalHolds(input);
}
