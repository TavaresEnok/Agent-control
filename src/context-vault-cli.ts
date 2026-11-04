import {constants} from 'node:fs';
import {open,realpath,lstat} from 'node:fs/promises';
import {dirname,isAbsolute,resolve,sep} from 'node:path';
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {Id,Refusal} from './contracts.ts';
import {ContextKeys,keyFingerprint} from './context-keys.ts';
import {ContextVault} from './context-vault.ts';
import {executeKeyRotationPlan} from './key-rotation-cli.ts';
import {privateDirectory,readPrivateFile,type Installation} from './installation.ts';
import type {Ledger} from './ledger.ts';

const Descriptor=z.object({principal:z.string().min(1).max(200),contextId:Id,sessionId:z.string().min(1).max(200),
 profileId:z.string().min(1).max(100),keyVersion:z.number().int().positive(),encryptionVariant:z.enum(['legacy','dataKey']),
 keyFile:z.string().refine(path=>isAbsolute(path)&&resolve(path)===path)}).strict();
const BackupDescriptor=z.object({sourceRoot:z.string().refine(path=>isAbsolute(path)&&resolve(path)===path),
 backupKeyFile:z.string().refine(path=>isAbsolute(path)&&resolve(path)===path),
 archiveFile:z.string().refine(path=>isAbsolute(path)&&resolve(path)===path),
 destinationDirectory:z.string().refine(path=>isAbsolute(path)&&resolve(path)===path).optional()}).strict();
const overlaps=(a:string,b:string)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep);
async function requireOutsideRepositories(path:string,repositories:readonly string[]){
 if(!isAbsolute(path)||resolve(path)!==path||await realpath(path)!==path||repositories.some(repo=>overlaps(repo,path)))throw new Refusal('VAULT_PATH_UNSAFE',403);
}
async function exactPrivateFile(path:string,max:number){
 if(!isAbsolute(path)||resolve(path)!==path||await realpath(path)!==path)throw new Refusal('UNSAFE_PRIVATE_FILE',403);
 const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o600)throw new Refusal('UNSAFE_PRIVATE_FILE',403);
 return readPrivateFile(path,max);
}
async function environment(config:Installation,ledger:Ledger){
 if(!config.contextVault)throw new Refusal('VAULT_NOT_CONFIGURED',403);
 const row=(await ledger.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0];
 if(!row)throw new Refusal('INSTALLATION_IDENTITY_MISSING');
 const repos=(await ledger.pool.query('SELECT repo FROM ac_project_repositories')).rows.map(r=>String(r.repo));
 const all=[...new Set([...repos,config.project.repo,...config.projects.map(p=>p.repo)])];
 for(const repo of all){
  if(resolve(repo)!==repo||await realpath(repo)!==repo||overlaps(repo,config.contextVault.directory)||overlaps(repo,config.contextVault.masterFile))throw new Refusal('VAULT_PATH_UNSAFE',403);
 }
 await privateDirectory(config.dataDirectory);
 return {installationId:String(row.id),repositories:all,vault:config.contextVault};
}
export async function initializeContextVault(config:Installation,ledger:Ledger){
 const {vault}=await environment(config,ledger);
 await privateDirectory(vault.directory);await privateDirectory(dirname(vault.masterFile));
 const rootInfo=await lstat(vault.directory);if((rootInfo.mode&0o777)!==0o700)throw new Refusal('VAULT_ROOT_UNSAFE',403);
 const secret=randomBytes(32);let created=false;
 try{
  try{
   const file=await open(vault.masterFile,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
   try{await file.writeFile(secret);await file.sync();created=true;}finally{await file.close();}
  }catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const existing=await exactPrivateFile(vault.masterFile,32);try{if(existing.length!==32)throw new Refusal('VAULT_MASTER_INVALID',403);}finally{existing.fill(0);}
  if(created){const directory=await open(dirname(vault.masterFile),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}}
  return {state:created?'initialized' as const:'exists' as const};
 }finally{secret.fill(0);}
}
export async function executeContextKey(command:'context-key-authorize'|'context-key-import',config:Installation,ledger:Ledger,descriptorPath:string){
 const env=await environment(config,ledger);let descriptorBytes:Buffer|undefined,key:Buffer|undefined;
 try{
  await requireOutsideRepositories(descriptorPath,env.repositories);
  descriptorBytes=await exactPrivateFile(descriptorPath,16384);const descriptor=Descriptor.parse(JSON.parse(descriptorBytes.toString('utf8')));
  if(descriptor.principal!==config.project.owner)throw new Refusal('CONTROL_ADMIN_REQUIRED',403);
  await ledger.tx(async c=>{
   const context=await ledger.authorize(c,descriptor.principal,descriptor.contextId);
   if(context.role!=='owner')throw new Refusal('PROJECT_OWNER_REQUIRED',403);
   const link=(await c.query('SELECT principal_id,session_id FROM ac_session_links WHERE context_id=$1',[descriptor.contextId])).rows[0];
   if(link?.principal_id!==descriptor.principal||link?.session_id!==descriptor.sessionId)throw new Refusal('SESSION_CONTEXT_MISMATCH',403);
  });
  await requireOutsideRepositories(descriptor.keyFile,env.repositories);
  key=await exactPrivateFile(descriptor.keyFile,32);if(key.length!==32)throw new Refusal('INVALID_CONTEXT_KEY',403);
  const {keyFile:_,...input}=descriptor;
  if(command==='context-key-authorize')await new ContextKeys(ledger).authorize(input.principal,input.contextId,input.keyVersion,input.encryptionVariant,keyFingerprint(key),{sessionId:input.sessionId});
  else await new ContextVault(ledger,env.installationId,env.vault.directory,env.vault.masterFile,env.repositories).importKey(input,key);
  return {state:command==='context-key-authorize'?'authorized' as const:'imported' as const};
 }finally{descriptorBytes?.fill(0);key?.fill(0);}
}
/** Dry-run only. The descriptor is an inventory; this does not open the vault or the ledger. */
export async function executeContextKeyRotatePlan(descriptorPath:string){
 return executeKeyRotationPlan(descriptorPath);
}
export async function executeVaultBackup(command:'vault-backup'|'vault-restore',config:Installation,ledger:Ledger,descriptorPath:string){
 const env=await environment(config,ledger);let bytes:Buffer|undefined;
 try{
  await requireOutsideRepositories(descriptorPath,env.repositories);
  bytes=await exactPrivateFile(descriptorPath,16384);const descriptor=BackupDescriptor.parse(JSON.parse(bytes.toString('utf8')));
  if(descriptor.sourceRoot!==env.vault.directory)throw new Refusal('VAULT_BACKUP_IDENTITY_MISMATCH',403);
  const {backupContextVault,restoreContextVault}=await import('./context-vault-backup.ts');
  const common={installationId:env.installationId,backupKeyFile:descriptor.backupKeyFile,archiveFile:descriptor.archiveFile,repositories:env.repositories};
  if(command==='vault-backup'){
   if(descriptor.destinationDirectory!==undefined)throw new Refusal('VAULT_BACKUP_DESCRIPTOR_INVALID',400);
   return await backupContextVault({...common,root:env.vault.directory,masterFile:env.vault.masterFile});
  }
  if(!descriptor.destinationDirectory)throw new Refusal('VAULT_BACKUP_DESCRIPTOR_INVALID',400);
  return await restoreContextVault({...common,sourceRoot:env.vault.directory,sourceMasterFile:env.vault.masterFile,destinationDirectory:descriptor.destinationDirectory});
 }finally{bytes?.fill(0);}
}
