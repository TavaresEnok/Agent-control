import {execFile,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod,lstat,mkdir,open,readdir,readFile,realpath,rename,rm,unlink,writeFile} from 'node:fs/promises';
import {basename,dirname,join,relative,resolve,sep} from 'node:path';
import {promisify} from 'node:util';
import {releaseRegisteredDirectory} from './native-work-retention.ts';
import {Refusal} from './contracts.ts';
import {loadInstallation} from './installation.ts';
import {assertPersonalBackupDestination,canonicalPath,runPersonalBackup,runPersonalRestoreCheck,type PersonalBackupOptions,type PersonalRestoreOptions} from './personal-backup.ts';
import {defaultBackupRetention,explicitBackupRetention,personalBackupRoot,personalDefaultBackupDirectory} from './personal-backup-paths.ts';
import {deliverPersonalPush} from './personal-push.ts';
import {personalSshPaths,shellSingleQuote,sshOptionArgs} from './personal-ssh.ts';

const exec=promisify(execFile);
const stampName=/^\d{8}-\d{6}$/;
const offsiteLine=/^([A-Za-z_][A-Za-z0-9._-]{0,31})@([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):(\/[A-Za-z0-9._~/-]+)$/;

export const offsiteFailedNotice='Cópia do backup para fora do servidor falhou.';
export const restoreCheckFailedNotice='A conferência do backup novo falhou. Nada foi apagado.';
export const retentionDegradedNotice='O backup novo está íntegro, mas backups antigos não puderam ser apagados.';
export const retentionRepeatedNotice=(rounds:number)=>`${retentionDegradedNotice} Já são ${rounds} rodadas seguidas com a retenção degradada: confira o espaço e as permissões da pasta de destino.`;

export class OffsiteCopyRefusal extends Refusal{
 constructor(readonly lines:string[]){super('BACKUP_OFFSITE_FAILED');}
}

/** The new backup did not pass restore-check. Nothing was deleted. `lines` is the backup report so far. */
export class RestoreCheckRefusal extends Refusal{
 constructor(readonly lines:string[],readonly cause:string){super('BACKUP_RESTORE_CHECK_FAILED');}
}

/** The backup is complete and checked, the offsite copy (if any) is done, but old folders could not be deleted.
 * The command exits non-zero so the timer unit shows as failed; the next run retries the pending removals. */
export class RetentionDegradedRefusal extends Refusal{
 constructor(readonly lines:string[],readonly failed:number){super('BACKUP_RETENTION_DEGRADED');}
}

/** One state per stage, so one stage failing never hides another. */
export type BackupRotateStatus={
 copy:'ok'|'check-failed';
 offsite:'not-configured'|'ok'|'failed'|'skipped';
 retention:'ok'|'degraded'|'skipped';
 removed:number;
 failed:number;
 /** Consecutive runs, this one included, that ended with the retention degraded; 0 when it is not. */
 degradedRounds?:number;
};
export const backupRotateStatusFile='backup-rotate-status.json';

export type OffsiteDestination={user:string;host:string;path:string};
export type RsyncPlan={command:'rsync';args:string[]};
export type PersonalBackupRotateOptions=PersonalBackupOptions&PersonalRestoreOptions&{
 /** Test hook. Replaces `/home/app/backups-agent-control` as the parent of the default destination. */
 defaultRoot?:string;
 rsync?:(plan:RsyncPlan)=>Promise<void>;
 notify?:(dataDirectory:string,body:string)=>Promise<void>;
};

export function personalBackupRotateStamp(now:Date){
 const part=(value:number)=>String(value).padStart(2,'0');
 return `${now.getFullYear()}${part(now.getMonth()+1)}${part(now.getDate())}-${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}`;
}

/** `usuario@host:/caminho`, absolute path, no empty or parent segments. */
export function parseOffsiteDestination(value:string):OffsiteDestination|null{
 if(value!==value.trim()||value.includes('..')||value.includes('//'))return null;
 const match=offsiteLine.exec(value);
 if(!match)return null;
 const path=match[3]!;
 if(path.endsWith('/')||path.split('/').slice(1).some(part=>part===''||part==='.'||part==='..'))return null;
 const host=match[2]!;
 if(host.includes('..')||host.startsWith('-')||host.endsWith('-')||host.endsWith('.'))return null;
 return {user:match[1]!,host,path};
}

/** `rsync -a` over SSH. The remote shell string is quoted; the destination never comes from a shell. */
export function personalOffsiteRsyncPlan(source:string,destination:string,identityFile:string,knownHosts:string):RsyncPlan|null{
 const parsed=parseOffsiteDestination(destination);
 if(!parsed)return null;
 if(!source.startsWith('/')||source.includes('\n')||source.includes('\0'))return null;
 if(!identityFile.startsWith('/')||identityFile.includes('\n')||!knownHosts.startsWith('/')||knownHosts.includes('\n'))return null;
 const ssh=['ssh',...sshOptionArgs(knownHosts,identityFile)].map(part=>shellSingleQuote(part)).join(' ');
 return {command:'rsync',args:['-a','-e',ssh,'--',source,`${parsed.user}@${parsed.host}:${parsed.path}/`]};
}

function inside(parent:string,child:string){
 const base=parent.endsWith(sep)?parent.slice(0,-1):parent;
 return child===base||child.startsWith(base+sep);
}

async function defaultNotify(dataDirectory:string,body:string){
 await deliverPersonalPush(dataDirectory,{messageId:'backup-'+randomUUID(),title:'Agent Control',body,url:'/'});
}

async function defaultRsync(plan:RsyncPlan){
 await exec('rsync',plan.args,{timeout:30*60*1000,env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:'/nonexistent',LANG:'C'}});
}

async function readOffsite(dataDirectory:string){
 const path=join(dataDirectory,'backup-offsite');
 let info;
 try{info=await lstat(path);}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
 if(!info.isFile()||info.isSymbolicLink()||info.size>1024)throw new Refusal('BACKUP_OFFSITE_INVALID');
 const text=(await readFile(path,'utf8')).trim();
 if(!parseOffsiteDestination(text))throw new Refusal('BACKUP_OFFSITE_INVALID');
 return text;
}

async function regularFile(path:string){
 try{
  const info=await lstat(path);
  return info.isFile()&&!info.isSymbolicLink();
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}

/** Delete only a direct child whose real path is that literal directory. Symlinks are left alone. */
async function realChild(root:string,name:string,pattern:RegExp){
 if(!pattern.test(name))return null;
 const literal=join(root,name);
 let info;
 try{info=await lstat(literal);}catch{return null;}
 if(!info.isDirectory()||info.isSymbolicLink())return null;
 let real:string;
 try{real=await realpath(literal);}catch{return null;}
 if(real!==literal||relative(root,real)!==name)return null;
 return literal;
}

/** Where the timers write this installation's backups. Retention is 3 here. */
export function personalBackupDefaultDestination(installationArg:string,defaultRoot:string=personalBackupRoot){
 return personalDefaultBackupDirectory(resolve(installationArg),defaultRoot);
}

async function readSmallJson(path:string){
 try{
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)return null;
  return JSON.parse(await readFile(path,'utf8')) as unknown;
 }catch{return null;}
}

/**
 * A dated folder holding exactly one `agent-control-*` backup with a MANIFEST.txt whose
 * installation.json names this project. Anything else (other installations, hand-made
 * folders, damaged copies) is not recognized and is never counted or deleted.
 */
async function recognizedBackup(dated:string,projectId:string,dataDirectory:string,options:PersonalRestoreOptions){
 try{
  const before=await lstat(dated,{bigint:true});
  const entries=await readdir(dated,{withFileTypes:true});
  const entry=entries[0];
  if(entries.length!==1||!entry?.isDirectory()||!entry.name.startsWith('agent-control-'))return false;
  const backup=join(dated,entry.name);
  const raw=await readSmallJson(join(backup,'installation.json')) as {project?:{id?:unknown};dataDirectory?:unknown}|null;
  if(raw?.project?.id!==projectId||raw.dataDirectory!==dataDirectory)return false;
  await runPersonalRestoreCheck([backup],options);
  const after=await lstat(dated,{bigint:true});
  return before.isDirectory()&&before.dev===after.dev&&before.ino===after.ino?before:false;
 }catch{return false;}
}

type PruneResult={kept:number;removed:number;failed:number};

/** flock locks the inherited open file description until this process closes it or dies. */
async function acquireLock(parent:string){
 const handle=await open(parent,'r');
 const result=spawnSync('/usr/bin/flock',['--exclusive','--nonblock','3'],{stdio:['ignore','ignore','ignore',handle.fd]});
 if(result.status!==0){
  await handle.close();
  throw new Refusal(result.status===1?'BACKUP_ROTATE_BUSY':'BACKUP_ROTATE_LOCK_FAILED');
 }
 return ()=>handle.close();
}

// Persist the identity before renaming. On a later successful rotation only the
// exact directory originally selected for deletion may be retired.
const pendingName=/^\.retencao-([0-9a-f-]{36})\.json$/;
async function finishPending(root:string,marker:string,projectId:string,dataDirectory:string){
 const match=pendingName.exec(marker);
 if(!match)return false;
 const proof=await readSmallJson(join(root,marker)) as {
  projectId?:unknown;dataDirectory?:unknown;dev?:unknown;ino?:unknown
 }|null;
 if(proof?.projectId!==projectId||proof.dataDirectory!==dataDirectory)return false;
 const condemned=join(root,'.removendo-'+match[1]);
 const entry=await lstat(condemned,{bigint:true}).catch((error:NodeJS.ErrnoException)=>{
  if(error.code==='ENOENT')return null;
  throw error;
 });
 if(entry){
  if(!entry.isDirectory()||String(entry.dev)!==proof.dev||String(entry.ino)!==proof.ino)return false;
  await releaseRegisteredDirectory(condemned,{dev:String(entry.dev),ino:String(entry.ino)});
 }
 await unlink(join(root,marker));
 return !!entry;
}

/**
 * Keep the new backup plus the newest recognized ones of this installation, `keep` in all.
 * A condemned folder is renamed first, so a half-deleted copy never looks like a backup.
 * Folders that are not recognized, symlinks and other files stay untouched.
 */
async function pruneBackups(parent:string,keep:number,newName:string,projectId:string,dataDirectory:string,options:PersonalRestoreOptions):Promise<PruneResult>{
 const root=await realpath(parent);
 let failed=0;
 const names:string[]=[];
 for(const entry of await readdir(root,{withFileTypes:true})){
  const literal=await realChild(root,entry.name,stampName);
  if(literal&&(entry.name===newName||await recognizedBackup(literal,projectId,dataDirectory,options)))names.push(entry.name);
 }
 names.sort();
 if(!names.includes(newName))return {kept:names.length,removed:0,failed:failed+1};
 const keepSet=new Set(names.slice(-keep));
 let removed=0;
 for(const marker of await readdir(root)){
  if(!pendingName.test(marker))continue;
  try{if(await finishPending(root,marker,projectId,dataDirectory))removed++;}catch{failed++;}
 }
 for(const name of names){
  if(keepSet.has(name))continue;
  const literal=await realChild(root,name,stampName);
  const entry=literal&&await recognizedBackup(literal,projectId,dataDirectory,options);
  if(!literal||!entry)continue;
  if(await retire(root,literal,entry,projectId,dataDirectory))removed++;
  else failed++;
 }
 return {kept:keepSet.size,removed,failed};
}

/** Rename aside, with the identity written first, then empty it under the removal guard. False when it could not finish. */
async function retire(root:string,literal:string,entry:{dev:bigint;ino:bigint},projectId:string,dataDirectory:string){
 const id=randomUUID(),marker=`.retencao-${id}.json`;
 try{
  await writeFile(join(root,marker),JSON.stringify({projectId,dataDirectory,dev:String(entry.dev),ino:String(entry.ino)}),{flag:'wx',mode:0o600});
  await rename(literal,join(root,'.removendo-'+id));
  return await finishPending(root,marker,projectId,dataDirectory);
 }catch{return false;}
}

/** Newest dated backup of this installation in `parent`, by its layout only: dedupe compares every byte before linking. */
async function latestBackupFolder(parent:string,projectId:string,dataDirectory:string){
 const root=await realpath(parent);
 const names=(await readdir(root)).filter(name=>stampName.test(name)).sort().reverse();
 for(const name of names){
  const literal=await realChild(root,name,stampName);
  if(!literal)continue;
  try{
   const entries=await readdir(literal,{withFileTypes:true});
   const entry=entries[0];
   if(entries.length!==1||!entry?.isDirectory()||!entry.name.startsWith('agent-control-'))continue;
   const raw=await readSmallJson(join(literal,entry.name,'installation.json')) as {project?:{id?:unknown};dataDirectory?:unknown}|null;
   if(raw?.project?.id===projectId&&raw.dataDirectory===dataDirectory)return join(literal,entry.name);
  }catch{/* not a backup of this installation */}
 }
 return undefined;
}

const looseName=/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

/**
 * Hand-made backups next to the default destination (`<nome>-antes-*`, `<nome>-db-*`): only this installation's prefix,
 * only after `looseDays` and only when the dated backup just checked is newer. A folder holding dated or pending entries is
 * another installation's destination and is never touched; folders with another prefix never are either.
 */
async function pruneLooseBackups(parent:string,looseDays:number,checkedAt:Date,projectId:string,dataDirectory:string):Promise<{removed:number;failed:number}>{
 const root=dirname(parent),prefix=basename(parent)+'-';
 // Older than looseDays before the checked backup, so that backup is always the newer one.
 const limit=checkedAt.getTime()-looseDays*24*60*60*1000;
 let removed=0,failed=0;
 for(const marker of await readdir(root)){
  if(!pendingName.test(marker))continue;
  try{if(await finishPending(root,marker,projectId,dataDirectory))removed++;}catch{failed++;}
 }
 for(const name of await readdir(root)){
  if(!name.startsWith(prefix)||name.length===prefix.length||!looseName.test(name))continue;
  const literal=await realChild(root,name,looseName);
  if(!literal)continue;
  try{
   const entry=await lstat(literal,{bigint:true});
   const children=await readdir(literal);
   if(children.length===0||children.some(child=>stampName.test(child)||pendingName.test(child)||child.startsWith('.removendo-')))continue;
   let newest=Number(entry.mtimeMs);
   for(const child of children)newest=Math.max(newest,Number((await lstat(join(literal,child),{bigint:true})).mtimeMs));
   if(newest>=limit)continue;
   if(await retire(root,literal,entry,projectId,dataDirectory))removed++;
   else failed++;
  }catch{failed++;}
 }
 return {removed,failed};
}

const stateText={
 copy:{ok:'ok','check-failed':'conferência falhou'},
 offsite:{'not-configured':'não configurado',ok:'ok',failed:'falhou',skipped:'não feito'},
 retention:{ok:'ok',degraded:'degradada',skipped:'não feita'},
} as const;
function statusLine(status:BackupRotateStatus){
 return `Estados: cópia ${stateText.copy[status.copy]}; envio externo ${stateText.offsite[status.offsite]}; retenção ${stateText.retention[status.retention]}.`;
}

/** Degraded rounds in a row up to the previous run; a run that did not reach retention keeps the count. */
async function previousDegradedRounds(dataDirectory:string){
 try{
  const previous=JSON.parse(await readFile(join(dataDirectory,backupRotateStatusFile),'utf8')) as {degradedRounds?:unknown};
  return typeof previous.degradedRounds==='number'&&Number.isInteger(previous.degradedRounds)&&previous.degradedRounds>0?previous.degradedRounds:0;
 }catch{return 0;}
}

/** Last run, one state per stage. Best effort: a write problem never changes the outcome. */
async function publishStatus(dataDirectory:string,at:Date,status:BackupRotateStatus){
 const path=join(dataDirectory,backupRotateStatusFile);
 const temporary=`${path}.${randomUUID()}.tmp`;
 try{
  await writeFile(temporary,JSON.stringify({at:at.toISOString(),...status})+'\n',{mode:0o600,flag:'wx'});
  await rename(temporary,path);
 }catch{/* status is best effort (see above) */await rm(temporary,{force:true}).catch(()=>{/* best-effort removal of a temporary file */});}
}

async function failOffsite(lines:string[],dataDirectory:string,notify:(dataDirectory:string,body:string)=>Promise<void>,at:Date):Promise<never>{
 const status:BackupRotateStatus={copy:'ok',offsite:'failed',retention:'skipped',removed:0,failed:0,degradedRounds:await previousDegradedRounds(dataDirectory)};
 await publishStatus(dataDirectory,at,status);
 lines.push(statusLine(status));
 try{await notify(dataDirectory,offsiteFailedNotice);}catch{/* pruning stays off either way */}
 throw new OffsiteCopyRefusal(lines);
}

/**
 * Same backup as personal:backup, in a dated folder, then restore-check on the new copy.
 * Nothing is deleted unless that check passes (and the offsite copy, when configured, succeeded).
 * Default destination (`/home/app/backups-agent-control/<nome>`): keeps the 3 newest. Explicit
 * destination: keeps 7. Only dated folders recognized as this installation's are ever counted or deleted.
 */
export async function runPersonalBackupRotate(argv:string[],options:PersonalBackupRotateOptions={}){
 const [installationArg,destinationArg]=argv;
 if(!installationArg||installationArg.startsWith('--')||argv.length>2||(destinationArg!==undefined&&(!destinationArg||destinationArg.startsWith('--'))))throw new Refusal('BACKUP_ROTATE_USAGE');
 const installationFile=resolve(installationArg);
 const config=await loadInstallation(installationFile);
 const defaultDirectory=personalDefaultBackupDirectory(installationFile,options.defaultRoot);
 const requested=resolve(destinationArg??defaultDirectory);
 try{
  const info=await lstat(requested);
  if(info.isSymbolicLink()||!info.isDirectory())throw new Refusal('BACKUP_ROTATE_NOT_A_DIRECTORY');
 }catch(error){
  if(error instanceof Refusal)throw error;
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
 }
 const parent=await assertPersonalBackupDestination(config,requested);
 const isDefault=parent===await canonicalPath(defaultDirectory);
 const keep=isDefault?defaultBackupRetention:explicitBackupRetention;
 await mkdir(parent,{recursive:true,mode:0o700});
 await chmod(parent,0o700);
 const release=await acquireLock(parent);
 try{
  return await rotateLocked({installationFile,config,parent,isDefault,keep,options});
 }finally{await release();}
}

async function rotateLocked(input:{installationFile:string;config:Awaited<ReturnType<typeof loadInstallation>>;parent:string;isDefault:boolean;keep:number;options:PersonalBackupRotateOptions}){
 const {installationFile,config,parent,isDefault,keep,options}=input;
 const at=options.now??new Date();
 const stamp=personalBackupRotateStamp(at);
 const dated=join(parent,stamp);
 try{
  const info=await lstat(dated);
  if(info)throw new Refusal('BACKUP_DESTINATION_NOT_EMPTY');
 }catch(error){
  if(error instanceof Refusal)throw error;
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
 }
 const previous=config.storage.backups.dedupe?await latestBackupFolder(parent,config.project.id,config.dataDirectory).catch(()=>undefined):undefined;
 const lines=await runPersonalBackup([installationFile,dated],{...options,linkFrom:previous});
 const copied=lines[0]?.startsWith('Backup em ')?lines[0].slice('Backup em '.length):'';
 const notify=options.notify??defaultNotify;
 const rsync=options.rsync??defaultRsync;
 const retention=`Retenção: ${keep} mais recentes${isDefault?' (destino padrão)':''}.`;
 try{
  const datedReal=await realpath(dated);
  const copiedReal=copied?await realpath(copied):'';
  if(!inside(datedReal,copiedReal)||copiedReal===datedReal)throw new Refusal('RESTORE_NOT_A_BACKUP');
  await runPersonalRestoreCheck([copiedReal],options);
 }catch(error){
  const status:BackupRotateStatus={copy:'check-failed',offsite:'skipped',retention:'skipped',removed:0,failed:0,degradedRounds:await previousDegradedRounds(config.dataDirectory)};
  await publishStatus(config.dataDirectory,at,status);
  try{await notify(config.dataDirectory,restoreCheckFailedNotice);}catch{/* nothing is deleted either way */}
  throw new RestoreCheckRefusal([...lines,`Destino: ${parent}`,retention,statusLine(status)],error instanceof Refusal?error.code:'RESTORE_CHECK_ERROR');
 }
 lines.push('Conferência do backup novo: ok.',`${isDefault?'Destino padrão':'Destino'}: ${parent}`,retention);
 let destination:string|null;
 try{destination=await readOffsite(config.dataDirectory);}
 catch(error){
  if(error instanceof Refusal&&error.code==='BACKUP_OFFSITE_INVALID')return failOffsite(lines,config.dataDirectory,notify,at);
  throw error;
 }
 if(destination){
  const paths=personalSshPaths(config.dataDirectory);
  const datedReal=await realpath(dated);
  let backupReal='';
  try{backupReal=copied?await realpath(copied):'';}
  catch{backupReal='';}
  const plan=inside(datedReal,backupReal)?personalOffsiteRsyncPlan(backupReal,destination,paths.identityFile,paths.knownHosts):null;
  const keys=await regularFile(paths.identityFile)&&await regularFile(paths.knownHosts);
  if(!plan||!keys)return failOffsite(lines,config.dataDirectory,notify,at);
  try{await rsync(plan);}
  catch{return failOffsite(lines,config.dataDirectory,notify,at);}
  lines.push('Cópia externa feita.');
 }
 const result=await pruneBackups(parent,keep,stamp,config.project.id,config.dataDirectory,options);
 if(isDefault){
  const loose=await pruneLooseBackups(parent,config.storage.backups.looseDays,at,config.project.id,config.dataDirectory).catch(()=>({removed:0,failed:1}));
  result.removed+=loose.removed;
  result.failed+=loose.failed;
 }
 const degradedRounds=result.failed>0?await previousDegradedRounds(config.dataDirectory)+1:0;
 const status:BackupRotateStatus={copy:'ok',offsite:destination?'ok':'not-configured',retention:result.failed>0?'degraded':'ok',removed:result.removed,failed:result.failed,degradedRounds};
 await publishStatus(config.dataDirectory,at,status);
 if(result.removed>0)lines.push(`Removidos: ${result.removed}`);
 lines.push(statusLine(status),`Mantidos: ${result.kept}`);
 if(result.failed>0){
  lines.push(`Alerta: ${result.failed} pasta(s) antigas não puderam ser apagadas; a próxima rodada tenta de novo. O backup novo está íntegro.`);
  try{await notify(config.dataDirectory,degradedRounds>1?retentionRepeatedNotice(degradedRounds):retentionDegradedNotice);}catch{/* the exit code reports it */}
  throw new RetentionDegradedRefusal(lines,result.failed);
 }
 return lines;
}
