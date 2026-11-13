import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {lstat,chmod,mkdir,readdir,readFile,realpath,rm} from 'node:fs/promises';
import {join,relative,resolve,sep} from 'node:path';
import {promisify} from 'node:util';
import {Refusal} from './contracts.ts';
import {loadInstallation} from './installation.ts';
import {assertPersonalBackupDestination,runPersonalBackup,type PersonalBackupOptions} from './personal-backup.ts';
import {deliverPersonalPush} from './personal-push.ts';
import {personalSshPaths,shellSingleQuote,sshOptionArgs} from './personal-ssh.ts';

const exec=promisify(execFile);
const stampName=/^\d{8}-\d{6}$/;
const offsiteLine=/^([A-Za-z_][A-Za-z0-9._-]{0,31})@([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):(\/[A-Za-z0-9._~/-]+)$/;

export const offsiteFailedNotice='Cópia do backup para fora do servidor falhou.';

export class OffsiteCopyRefusal extends Refusal{
 constructor(readonly lines:string[]){super('BACKUP_OFFSITE_FAILED');}
}

export type OffsiteDestination={user:string;host:string;path:string};
export type RsyncPlan={command:'rsync';args:string[]};
export type PersonalBackupRotateOptions=PersonalBackupOptions&{
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
async function deletableChild(root:string,name:string){
 if(!stampName.test(name))return null;
 const literal=join(root,name);
 let info;
 try{info=await lstat(literal);}catch{return null;}
 if(!info.isDirectory()||info.isSymbolicLink())return null;
 let real:string;
 try{real=await realpath(literal);}catch{return null;}
 if(real!==literal||relative(root,real)!==name)return null;
 return literal;
}

async function pruneOldest(parent:string,keep:number){
 const root=await realpath(parent);
 const names:string[]=[];
 for(const entry of await readdir(root,{withFileTypes:true})){
  if(await deletableChild(root,entry.name))names.push(entry.name);
 }
 names.sort();
 const extra=names.slice(0,Math.max(0,names.length-keep));
 for(const name of extra){
  const literal=await deletableChild(root,name);
  if(literal)await rm(literal,{recursive:true,force:false});
 }
 return names.length-extra.length;
}

async function failOffsite(lines:string[],dataDirectory:string,notify:(dataDirectory:string,body:string)=>Promise<void>):Promise<never>{
 try{await notify(dataDirectory,offsiteFailedNotice);}catch{/* pruning stays off either way */}
 throw new OffsiteCopyRefusal(lines);
}

/** Same backup as personal:backup, in a dated folder. Keeps 7. A failed offsite copy deletes nothing. */
export async function runPersonalBackupRotate(argv:string[],options:PersonalBackupRotateOptions={}){
 const [installationArg,destinationArg]=argv;
 if(!installationArg||!destinationArg||installationArg.startsWith('--')||destinationArg.startsWith('--')||argv.length!==2)throw new Refusal('BACKUP_ROTATE_USAGE');
 const installationFile=resolve(installationArg);
 const config=await loadInstallation(installationFile);
 const requested=resolve(destinationArg);
 try{
  const info=await lstat(requested);
  if(info.isSymbolicLink()||!info.isDirectory())throw new Refusal('BACKUP_ROTATE_NOT_A_DIRECTORY');
 }catch(error){
  if(error instanceof Refusal)throw error;
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
 }
 const parent=await assertPersonalBackupDestination(config,destinationArg);
 await mkdir(parent,{recursive:true,mode:0o700});
 await chmod(parent,0o700);
 const dated=join(parent,personalBackupRotateStamp(options.now??new Date()));
 try{
  const info=await lstat(dated);
  if(info)throw new Refusal('BACKUP_DESTINATION_NOT_EMPTY');
 }catch(error){
  if(error instanceof Refusal)throw error;
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
 }
 const lines=await runPersonalBackup([installationFile,dated],options);
 const copied=lines[0]?.startsWith('Backup em ')?lines[0].slice('Backup em '.length):'';
 const notify=options.notify??defaultNotify;
 const rsync=options.rsync??defaultRsync;
 let destination:string|null;
 try{destination=await readOffsite(config.dataDirectory);}
 catch(error){
  if(error instanceof Refusal&&error.code==='BACKUP_OFFSITE_INVALID')return failOffsite(lines,config.dataDirectory,notify);
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
  if(!plan||!keys)return failOffsite(lines,config.dataDirectory,notify);
  try{await rsync(plan);}
  catch{return failOffsite(lines,config.dataDirectory,notify);}
  const kept=await pruneOldest(parent,7);
  return [...lines,'Cópia externa feita.',`Mantidos: ${kept}`];
 }
 const kept=await pruneOldest(parent,7);
 return [...lines,`Mantidos: ${kept}`];
}
