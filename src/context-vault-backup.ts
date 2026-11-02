import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open,realpath,lstat,readdir,mkdir,rename,link,unlink,rm} from 'node:fs/promises';
import {dirname,basename,isAbsolute,resolve,join,sep} from 'node:path';
import {z} from 'zod';
import {Id,Refusal} from './contracts.ts';

const LIMIT=16*1024*1024,MAX_ENTRIES=10000;
const hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const Entry=z.object({name:z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/),sha256:sha,data:z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/)}).strict();
const Payload=z.object({schemaVersion:z.literal(1),installationId:Id,masterName:z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/),files:z.array(Entry).min(1).max(MAX_ENTRIES+1)}).strict();
const Envelope=z.object({schemaVersion:z.literal(1),installationId:Id,nonce:z.string().regex(/^[a-f0-9]{24}$/),ciphertext:z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),tag:z.string().regex(/^[a-f0-9]{32}$/)}).strict();
const aad=(installationId:string)=>Buffer.from(JSON.stringify(['agent-control-context-vault-backup',1,installationId]));
const overlaps=(a:string,b:string)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep);
const entryName=(name:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[1-9][0-9]*\.vault$/i.test(name);
async function canonical(path:string){if(!isAbsolute(path)||resolve(path)!==path||await realpath(path)!==path)throw new Refusal('VAULT_BACKUP_PATH_UNSAFE',403);}
async function privateDir(path:string){await canonical(path);const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o777)!==0o700)throw new Refusal('VAULT_BACKUP_PATH_UNSAFE',403);}
async function privateFile(path:string,max:number){
 await canonical(path);const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const s=await file.stat();if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid?.()||(s.mode&0o777)!==0o600||s.size>max)throw new Refusal('VAULT_BACKUP_FILE_UNSAFE',403);
  const data=await file.readFile();if(data.length>max){data.fill(0);throw new Refusal('VAULT_BACKUP_TOO_LARGE');}return {data,dev:s.dev,ino:s.ino};
 }finally{await file.close();}
}
async function syncDir(path:string){const file=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await file.sync();}finally{await file.close();}}
function outside(path:string,repos:readonly string[]){if(!isAbsolute(path)||resolve(path)!==path||repos.some(repo=>overlaps(path,repo)))throw new Refusal('VAULT_BACKUP_PATH_UNSAFE',403);}
async function checkPaths(root:string,master:string,keyFile:string,repos:readonly string[]){
 for(const repo of repos)await canonical(repo);outside(root,repos);outside(master,repos);outside(keyFile,repos);
 await privateDir(root);if(dirname(master)!==root||entryName(basename(master))||!(/^[a-zA-Z0-9._-]{1,128}$/.test(basename(master)))||basename(master)==='.'||basename(master)==='..')throw new Refusal('VAULT_BACKUP_LAYOUT_UNSUPPORTED',403);
 if(overlaps(root,keyFile))throw new Refusal('VAULT_BACKUP_KEY_UNSAFE',403);
 const key=await privateFile(keyFile,32);
 try{if(key.data.length!==32)throw new Refusal('VAULT_BACKUP_KEY_UNSAFE',403);const main=await privateFile(master,32);
  try{if(main.data.length!==32||key.dev===main.dev&&key.ino===main.ino||key.data.equals(main.data))throw new Refusal('VAULT_BACKUP_KEY_UNSAFE',403);}
  finally{main.data.fill(0);}
  return key.data;
 }catch(error){key.data.fill(0);throw error;}
}
async function snapshot(root:string,master:string){
 const names=(await readdir(root)).sort(),masterName=basename(master);
 if(names.length>MAX_ENTRIES+1||!names.includes(masterName)||names.some(name=>name!==masterName&&!entryName(name)))throw new Refusal('VAULT_BACKUP_INVENTORY_INVALID',403);
 const files:{name:string;sha256:string;data:string;dev:number;ino:number}[]=[];let total=0;
 for(const name of names){const value=await privateFile(join(root,name),name===masterName?32:4096);
  try{total+=value.data.length;if(total>10*1024*1024)throw new Refusal('VAULT_BACKUP_TOO_LARGE');
   if(name===masterName&&value.data.length!==32)throw new Refusal('VAULT_MASTER_INVALID',403);
   files.push({name,sha256:hash(value.data),data:value.data.toString('base64'),dev:value.dev,ino:value.ino});
  }finally{value.data.fill(0);}
 }
 return files;
}
export async function backupContextVault(options:{installationId:string;root:string;masterFile:string;backupKeyFile:string;archiveFile:string;repositories:readonly string[]}){
 Id.parse(options.installationId);const {root,masterFile,backupKeyFile,archiveFile,repositories}=options;
 outside(archiveFile,repositories);if(overlaps(root,archiveFile)||archiveFile===backupKeyFile)throw new Refusal('VAULT_BACKUP_PATH_UNSAFE',403);
 await privateDir(dirname(archiveFile));const key=await checkPaths(root,masterFile,backupKeyFile,repositories);
 let plain:Buffer|undefined,archive:Buffer|undefined,temp:string|undefined;
 try{
  const files=await snapshot(root,masterFile),masterSnapshot=Buffer.from(files.find(file=>file.name===basename(masterFile))!.data,'base64');
  try{if(masterSnapshot.equals(key))throw new Refusal('VAULT_BACKUP_KEY_UNSAFE',403);}finally{masterSnapshot.fill(0);}
  plain=Buffer.from(JSON.stringify({schemaVersion:1,installationId:options.installationId,masterName:basename(masterFile),files:files.map(({name,sha256,data})=>({name,sha256,data}))}));
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad(options.installationId));
  const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);archive=Buffer.from(JSON.stringify({schemaVersion:1,installationId:options.installationId,nonce:nonce.toString('hex'),ciphertext:encrypted.toString('base64'),tag:cipher.getAuthTag().toString('hex')}));encrypted.fill(0);
  if(archive.length>LIMIT)throw new Refusal('VAULT_BACKUP_TOO_LARGE');
  const again=await snapshot(root,masterFile);if(JSON.stringify(files)!==JSON.stringify(again))throw new Refusal('VAULT_BACKUP_SOURCE_CHANGED');
  temp=join(dirname(archiveFile),`.vault-backup-${randomUUID()}`);const file=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await file.writeFile(archive);await file.sync();}finally{await file.close();}
  try{await link(temp,archiveFile);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Refusal('VAULT_BACKUP_ALREADY_EXISTS');throw error;}
  await unlink(temp);temp=undefined;await syncDir(dirname(archiveFile));return {state:'backed_up' as const,entries:files.length-1};
 }finally{key.fill(0);plain?.fill(0);archive?.fill(0);if(temp)await unlink(temp).catch(()=>{});}
}
export async function restoreContextVault(options:{installationId:string;sourceRoot:string;sourceMasterFile:string;backupKeyFile:string;archiveFile:string;destinationDirectory:string;repositories:readonly string[]}){
 Id.parse(options.installationId);const {sourceRoot,sourceMasterFile,backupKeyFile,archiveFile,destinationDirectory,repositories}=options;
 for(const path of [archiveFile,destinationDirectory])outside(path,repositories);
 if(overlaps(sourceRoot,archiveFile)||overlaps(sourceRoot,destinationDirectory)||overlaps(destinationDirectory,backupKeyFile)||overlaps(destinationDirectory,archiveFile))throw new Refusal('VAULT_BACKUP_PATH_UNSAFE',403);
 for(const repo of repositories)await canonical(repo);outside(sourceRoot,repositories);outside(sourceMasterFile,repositories);outside(backupKeyFile,repositories);
 if(dirname(sourceMasterFile)!==sourceRoot||overlaps(sourceRoot,backupKeyFile))throw new Refusal('VAULT_BACKUP_LAYOUT_UNSUPPORTED',403);
 await privateDir(dirname(destinationDirectory));const key=(await privateFile(backupKeyFile,32)).data;
 if(key.length!==32){key.fill(0);throw new Refusal('VAULT_BACKUP_KEY_UNSAFE',403);}
 let input:Buffer|undefined,plain:Buffer|undefined,owned=false;
 try{
  input=(await privateFile(archiveFile,LIMIT)).data;const envelope=Envelope.parse(JSON.parse(input.toString('utf8')));
  if(envelope.installationId!==options.installationId)throw new Refusal('VAULT_INSTALLATION_MISMATCH',403);
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.nonce,'hex'));decipher.setAAD(aad(options.installationId));decipher.setAuthTag(Buffer.from(envelope.tag,'hex'));
  const partial=decipher.update(Buffer.from(envelope.ciphertext,'base64'));
  try{const end=decipher.final();try{plain=Buffer.concat([partial,end]);}finally{end.fill(0);}}catch{throw new Refusal('VAULT_BACKUP_AUTHENTICATION_FAILED',403);}finally{partial.fill(0);}
  if(plain.length>LIMIT)throw new Refusal('VAULT_BACKUP_TOO_LARGE');const payload=Payload.parse(JSON.parse(plain.toString('utf8')));
  if(payload.installationId!==options.installationId||payload.masterName!==basename(sourceMasterFile))throw new Refusal('VAULT_BACKUP_IDENTITY_MISMATCH',403);
  const names=new Set<string>();for(const item of payload.files){if(names.has(item.name)||item.name!==payload.masterName&&!entryName(item.name))throw new Refusal('VAULT_BACKUP_INVENTORY_INVALID',403);names.add(item.name);
   const bytes=Buffer.from(item.data,'base64');try{if(hash(bytes)!==item.sha256||(item.name===payload.masterName?bytes.length!==32:bytes.length>4096))throw new Refusal('VAULT_BACKUP_INVENTORY_INVALID',403);if(item.name===payload.masterName&&bytes.equals(key))throw new Refusal('VAULT_BACKUP_KEY_UNSAFE',403);}finally{bytes.fill(0);}}
  if(!names.has(payload.masterName))throw new Refusal('VAULT_BACKUP_INVENTORY_INVALID',403);
  await mkdir(destinationDirectory,{mode:0o700});owned=true;const staging=join(destinationDirectory,`.staging-${randomUUID()}`);await mkdir(staging,{mode:0o700});
  for(const item of payload.files){const bytes=Buffer.from(item.data,'base64');try{const file=await open(join(staging,item.name),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}}finally{bytes.fill(0);}}
  await syncDir(staging);await rename(staging,join(destinationDirectory,'vault'));await syncDir(destinationDirectory);await syncDir(dirname(destinationDirectory));
  owned=false;return {state:'restored_inactive' as const,entries:payload.files.length-1};
 }finally{key.fill(0);input?.fill(0);plain?.fill(0);if(owned)await rm(destinationDirectory,{recursive:true,force:true}).catch(()=>{});}
}
