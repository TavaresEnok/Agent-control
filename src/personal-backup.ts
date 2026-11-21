import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants,createReadStream,createWriteStream} from 'node:fs';
import {chmod,copyFile,lstat,mkdir,readdir,readFile,realpath,rm,stat,writeFile} from 'node:fs/promises';
import {basename,dirname,join,relative,resolve,sep} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Refusal} from './contracts.ts';
import {loadInstallation,type Installation} from './installation.ts';

/** Top-level data directories that are large, disposable, or rebuilt by git clone. */
const excludedDirectories=new Set(['native','qa-cache','remote','verify-db']);
/** Vulnerability-database caches (Grype, Trivy) in their conventional places inside the data directory. Downloaded again by maintenance. */
const excludedCachePaths=new Set(['.cache/grype','.cache/trivy','cache/grype','cache/trivy']);

export type DatabaseEndpoint={user:string;password:string;host:string;port:string;database:string};
export type PersonalBackupOptions={
 now?:Date;
 /** Test double. Writes `database.dump` without Docker or pg_dump. */
 dump?:(file:string,db:DatabaseEndpoint)=>Promise<void>;
 dockerPs?:()=>Promise<string>;
};
export type PersonalRestoreOptions={
 /** Test double. Resolves when `database.dump` is a readable custom-format archive. */
 listDump?:(file:string)=>Promise<void>;
 dockerPs?:()=>Promise<string>;
};
export class CommandRefusal extends Refusal{
 constructor(code:string,readonly detail=''){super(code);}
}

export function databaseEndpoint(databaseUrl:string):DatabaseEndpoint{
 const url=new URL(databaseUrl);
 const user=decodeURIComponent(url.username);
 const password=decodeURIComponent(url.password);
 const host=url.hostname;
 const port=url.port||'5432';
 const database=decodeURIComponent(url.pathname.replace(/^\//,''));
 if(!/^\d+$/.test(port)||!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(user)||!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(database)||!/^[A-Za-z0-9_.:-]+$/.test(host))throw new Refusal('BACKUP_DATABASE_URL');
 return {user,password,host,port,database};
}

export function personalPgContainer(dockerPs:string,port:string):string|null{
 if(!/^\d+$/.test(port))return null;
 for(const line of dockerPs.split('\n')){
  if(!line.trim())continue;
  const [name,ports='']=line.split('\t');
  if(name!=='ac-personal-pg')continue;
  const published=ports.split(',').some(part=>part.match(/:(\d+)->/)?.[1]===port);
  if(published)return name;
 }
 return null;
}

/** Password stays in the child environment. `-e PGPASSWORD` copies it into the container without putting the value on the command line. */
export function databaseDumpPlan(container:string|null,db:DatabaseEndpoint){
 if(container)return {command:'docker',args:['exec','-e','PGPASSWORD',container,'pg_dump','-Fc','-w','-U',db.user,'-d',db.database]};
 return {command:'pg_dump',args:['-Fc','-w','-h',db.host,'-p',db.port,'-U',db.user,'-d',db.database]};
}

/** `pg_restore --list` reads the archive from stdin, so the dump path never becomes an argument. */
export function databaseListPlan(container:string|null){
 if(container)return {command:'docker',args:['exec','-i',container,'pg_restore','--list']};
 return {command:'pg_restore',args:['--list']};
}

export function dumpProcessEnv(base:NodeJS.ProcessEnv,db:DatabaseEndpoint):NodeJS.ProcessEnv{
 return {...base,PGPASSWORD:db.password};
}

function loopback(host:string){return host==='localhost'||host==='127.0.0.1'||host==='::1';}

/** The one place that decides which PostgreSQL instance a database address means.
 * A local container counts only when the address is loopback and the container publishes that port; any other host is reached over the network.
 * Dump, list, restore, validation and cleanup all take the answer from here. */
export async function resolvePgInstance(db:DatabaseEndpoint,dockerPs?:()=>Promise<string>):Promise<string|null>{
 if(!loopback(db.host))return null;
 return personalPgContainer(await dockerListing(dockerPs),db.port);
}

/** Loads a dump from stdin into an empty database of the same instance that `resolvePgInstance` named. */
export function databaseRestorePlan(container:string|null,db:DatabaseEndpoint,database:string){
 if(container)return {command:'docker',args:['exec','-i','-e','PGPASSWORD',container,'pg_restore','--no-owner','--exit-on-error','-w','-U',db.user,'-d',database]};
 return {command:'pg_restore',args:['--no-owner','--exit-on-error','-w','-h',db.host,'-p',db.port,'-U',db.user,'-d',database]};
}

function safeLabel(label:string){
 const clean=label.replace(/[^A-Za-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60);
 return clean||'instalacao';
}

function stampOf(now:Date){
 const part=(value:number)=>String(value).padStart(2,'0');
 return `${now.getFullYear()}${part(now.getMonth()+1)}${part(now.getDate())}-${part(now.getHours())}${part(now.getMinutes())}`;
}

function isInside(parent:string,child:string){
 const base=parent.endsWith(sep)?parent.slice(0,-1):parent;
 return child===base||child.startsWith(base+sep);
}

export async function canonicalPath(input:string){
 let current=resolve(input);
 const missing:string[]=[];
 for(;;){
  try{
   const real=await realpath(current);
   return missing.reduceRight((path,part)=>join(path,part),real);
  }catch(error){
   if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
   const parent=dirname(current);
   if(parent===current)return resolve(input);
   missing.push(basename(current));
   current=parent;
  }
 }
}

function redact(text:string,secret:string){
 const clipped=text.replace(/\s+/g,' ').trim().slice(0,400);
 return secret?clipped.split(secret).join('[redacted]'):clipped;
}

async function privateFile(path:string,bytes:Buffer|string){
 await writeFile(path,bytes,{mode:0o600,flag:'wx'});
 await chmod(path,0o600);
}

async function privateDir(path:string){
 await mkdir(path,{recursive:true,mode:0o700});
 await chmod(path,0o700);
}

async function fileSha256(path:string){
 const hash=createHash('sha256');
 for await(const chunk of createReadStream(path))hash.update(chunk);
 return hash.digest('hex');
}

async function regularFiles(root:string,includeManifest:boolean){
 const found:string[]=[];
 async function walk(directory:string){
  for(const entry of await readdir(directory,{withFileTypes:true})){
   if(entry.isSymbolicLink())throw new Refusal('RESTORE_MANIFEST_MISMATCH');
   const absolute=join(directory,entry.name);
   if(entry.isDirectory())await walk(absolute);
   else if(entry.isFile()){
    const rel=relative(root,absolute).split(sep).join('/');
    if(includeManifest||rel!=='MANIFEST.txt')found.push(rel);
   }else throw new Refusal('RESTORE_MANIFEST_MISMATCH');
  }
 }
 await walk(root);
 found.sort((a,b)=>a<b?-1:a>b?1:0);
 return found;
}

async function copyData(source:string,dest:string,depth:number,rel=''){
 await privateDir(dest);
 for(const entry of await readdir(source,{withFileTypes:true})){
  if(entry.isSymbolicLink())continue;
  if(depth===0&&entry.isDirectory()&&excludedDirectories.has(entry.name))continue;
  const from=join(source,entry.name),to=join(dest,entry.name);
  const entryRel=rel?`${rel}/${entry.name}`:entry.name;
  if(entry.isDirectory()&&excludedCachePaths.has(entryRel))continue;
  if(entry.isDirectory())await copyData(from,to,depth+1,entryRel);
  else if(entry.isFile()){
   await copyFile(from,to,constants.COPYFILE_EXCL);
   await chmod(to,0o600);
  }
 }
}

export function spawnCollected(command:string,args:string[],env:NodeJS.ProcessEnv,stdinFile:string|null,stdoutFile:string|null,timeoutMs:number){
 return new Promise<{code:number;stderr:string}>((resolvePromise,reject)=>{
  const child=spawn(command,args,{env,stdio:[stdinFile?'pipe':'ignore',stdoutFile?'pipe':'ignore','pipe']});
  const errors:Buffer[]=[];
  let settled=false;
  const timer=setTimeout(()=>child.kill(),timeoutMs);
  const finish=(error:Error|null,code=1)=>{
   if(settled)return;
   settled=true;
   clearTimeout(timer);
   if(error){child.kill();reject(error);}
   else resolvePromise({code,stderr:Buffer.concat(errors).toString('utf8')});
  };
  child.on('error',error=>finish(error));
  child.stderr?.on('data',(chunk:Buffer)=>{if(Buffer.concat(errors).length<8192)errors.push(chunk);});
  const waits:Promise<void>[]=[];
  if(stdoutFile&&child.stdout){
   const output=createWriteStream(stdoutFile,{flags:'w',mode:0o600});
   waits.push(pipeline(child.stdout,output));
  }
  if(stdinFile&&child.stdin)waits.push(pipeline(createReadStream(stdinFile),child.stdin).catch(error=>{
   if((error as NodeJS.ErrnoException).code!=='EPIPE')throw error;
  }));
  child.on('close',code=>{
   Promise.all(waits).then(()=>finish(null,code??1),error=>finish(error instanceof Error?error:new Error('BACKUP_IO')));
  });
 });
}

async function captureStdout(command:string,args:string[]){
 const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});
 const out:Buffer[]=[];
 const err:Buffer[]=[];
 const code=await new Promise<number>((resolvePromise,reject)=>{
  child.on('error',reject);
  child.stdout.on('data',(chunk:Buffer)=>out.push(chunk));
  child.stderr.on('data',(chunk:Buffer)=>err.push(chunk));
  child.on('close',status=>resolvePromise(status??1));
 });
 if(code!==0)throw new Error(Buffer.concat(err).toString('utf8').slice(0,200));
 return Buffer.concat(out).toString('utf8');
}

export async function dockerListing(dockerPs?:()=>Promise<string>){
 if(dockerPs)return dockerPs();
 try{return await captureStdout('docker',['ps','--format','{{.Names}}\t{{.Ports}}']);}
 catch{return '';}
}

async function writeDump(file:string,db:DatabaseEndpoint,options:PersonalBackupOptions){
 if(options.dump){
  await options.dump(file,db);
  const info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink())throw new Refusal('BACKUP_DUMP_FAILED');
  await chmod(file,0o600);
  return;
 }
 const container=await resolvePgInstance(db,options.dockerPs);
 const plan=databaseDumpPlan(container,db);
 if(db.password&&plan.args.some(arg=>arg.includes(db.password)||arg.includes(encodeURIComponent(db.password))))throw new Refusal('BACKUP_DUMP_FAILED');
 await writeFile(file,Buffer.alloc(0),{mode:0o600,flag:'wx'});
 const result=await spawnCollected(plan.command,plan.args,dumpProcessEnv(process.env,db),null,file,120_000);
 if(result.code!==0){
  await rm(file,{force:true});
  throw new CommandRefusal('BACKUP_DUMP_FAILED',redact(result.stderr,db.password));
 }
 await chmod(file,0o600);
}

const restoreSteps=`# Restaurar

Este backup contém segredos: a chave da conversa, os logins e a chave SSH. Guarde-o fora do servidor e fora de qualquer repositório.

1. Confira, sem restaurar nada: \`npm run personal:restore-check -- <esta-pasta>\`
2. Coloque \`installation.json\` no lugar e copie o conteúdo de \`data/\` para o diretório de dados. Pastas no modo 700 e arquivos no modo 600.
3. Crie um banco vazio e carregue \`database.dump\` com \`pg_restore\`. No contêiner: \`docker exec -i ac-personal-pg pg_restore --clean --if-exists -U USUARIO -d BANCO\`, com o arquivo na stdin.
4. Suba de novo o gateway desta instalação.

Ficaram de fora, de propósito: \`native/\`, \`qa-cache/\`, \`remote/\`, \`verify-db/\` e os caches do Grype e do Trivy. As cópias remotas se refazem com \`git clone\` e as bases de vulnerabilidades se baixam de novo na manutenção semanal.
`;

async function treeBytes(root:string){
 let total=0;
 for(const rel of await regularFiles(root,true))total+=(await stat(join(root,rel))).size;
 return total;
}

function reposOf(config:Installation){
 return [config.project,...config.projects].map(project=>project.repo);
}

/** Refuse a backup folder inside private data or a project repository. Returns the canonical path. */
export async function assertPersonalBackupDestination(config:Installation,destinationArg:string){
 const dataReal=await realpath(config.dataDirectory);
 const destination=await canonicalPath(destinationArg);
 if(isInside(dataReal,destination)||isInside(resolve(config.dataDirectory),destination))throw new Refusal('BACKUP_DESTINATION_INSIDE_DATA');
 for(const repo of reposOf(config)){
  if(isInside(await canonicalPath(repo),destination))throw new Refusal('BACKUP_DESTINATION_INSIDE_REPOSITORY');
 }
 return destination;
}

/** Copy the installation, its private data and a database dump. Does not restore anything. */
export async function runPersonalBackup(argv:string[],options:PersonalBackupOptions={}){
 const [installationArg,destinationArg]=argv;
 if(!installationArg||!destinationArg||installationArg.startsWith('--')||destinationArg.startsWith('--')||argv.length!==2)throw new Refusal('BACKUP_USAGE');
 const config=await loadInstallation(resolve(installationArg));
 const destination=await assertPersonalBackupDestination(config,destinationArg);
 const dataReal=await realpath(config.dataDirectory);
 let createdParent=false;
 try{
  const info=await lstat(destination);
  if(info.isSymbolicLink()||!info.isDirectory())throw new Refusal('BACKUP_DESTINATION_NOT_EMPTY');
  if((await readdir(destination)).length>0)throw new Refusal('BACKUP_DESTINATION_NOT_EMPTY');
 }catch(error){
  if(error instanceof Refusal)throw error;
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  createdParent=true;
 }
 const backup=join(destination,`agent-control-${safeLabel(config.project.label)}-${stampOf(options.now??new Date())}`);
 const db=databaseEndpoint(config.databaseUrl);
 try{
  await privateDir(destination);
  await privateDir(backup);
  await privateFile(join(backup,'installation.json'),await readFile(resolve(installationArg)));
  await copyData(dataReal,join(backup,'data'),0);
  await writeDump(join(backup,'database.dump'),db,options);
  await privateFile(join(backup,'RESTAURAR.md'),restoreSteps);
  const listed=await regularFiles(backup,false);
  const lines:string[]=[];
  for(const rel of listed)lines.push(`${await fileSha256(join(backup,rel))}  ${rel}`);
  await privateFile(join(backup,'MANIFEST.txt'),lines.join('\n')+'\n');
  const size=await treeBytes(backup);
  return [`Backup em ${backup}`,`Tamanho: ${size} bytes`,'O backup contém segredos (chave da conversa, logins e chave SSH). Guarde-o fora do servidor.'];
 }catch(error){
  await rm(backup,{recursive:true,force:true});
  if(createdParent)await rm(destination,{recursive:true,force:true});
  throw error;
 }
}

function safeRelative(rel:string){
 if(!rel||rel.includes('\\')||rel.includes('\0')||rel.startsWith('/'))return false;
 return rel.split('/').every(part=>part!==''&&part!=='.'&&part!=='..');
}

export async function verifyBackupManifest(backup:string){
 const root=await realpath(backup);
 let text:string;
 try{text=await readFile(join(root,'MANIFEST.txt'),'utf8');}
 catch{throw new Refusal('RESTORE_NOT_A_BACKUP');}
 if(!text.endsWith('\n'))throw new Refusal('RESTORE_MANIFEST_MISMATCH');
 const lines=text.slice(0,-1).split('\n');
 const listed=new Map<string,string>();
 for(const line of lines){
  if(!/^([a-f0-9]{64})  (.+)$/.test(line)||line.slice(64,66)!=='  ')throw new Refusal('RESTORE_MANIFEST_MISMATCH');
  const hash=line.slice(0,64),rel=line.slice(66);
  if(listed.has(rel)||!safeRelative(rel))throw new Refusal('RESTORE_MANIFEST_MISMATCH');
  listed.set(rel,hash);
 }
 let actual:string[];
 try{actual=await regularFiles(root,false);}
 catch{throw new Refusal('RESTORE_MANIFEST_MISMATCH');}
 if(actual.length!==listed.size||actual.some(rel=>!listed.has(rel)))throw new Refusal('RESTORE_MANIFEST_MISMATCH');
 for(const rel of actual){
  let hash='';
  try{hash=await fileSha256(join(root,rel));}
  catch{throw new Refusal('RESTORE_MANIFEST_MISMATCH');}
  if(hash!==listed.get(rel))throw new Refusal('RESTORE_MANIFEST_MISMATCH');
 }
 return actual.length;
}

async function listArchive(backup:string,dumpFile:string,options:PersonalRestoreOptions){
 if(options.listDump){
  try{await options.listDump(dumpFile);}
  catch(error){
   if(error instanceof Refusal)throw error;
   throw new CommandRefusal('RESTORE_DUMP_UNREADABLE',redact(error instanceof Error?error.message:'' ,''));
  }
  return;
 }
 let container:string|null=null;
 let secret='';
 try{
  const raw=JSON.parse(await readFile(join(backup,'installation.json'),'utf8')) as {databaseUrl?:unknown};
  if(typeof raw.databaseUrl==='string'){
   const db=databaseEndpoint(raw.databaseUrl);
   secret=db.password;
   container=await resolvePgInstance(db,options.dockerPs);
  }
 }catch(error){
  if(error instanceof Refusal&&error.code==='BACKUP_DATABASE_URL')throw error;
  container=null;
 }
 const plan=databaseListPlan(container);
 if(plan.args.some(arg=>arg.includes('database.dump')||(secret!==''&&arg.includes(secret))))throw new Refusal('RESTORE_DUMP_UNREADABLE');
 const result=await spawnCollected(plan.command,plan.args,process.env,dumpFile,null,60_000);
 if(result.code!==0)throw new CommandRefusal('RESTORE_DUMP_UNREADABLE',redact(result.stderr,secret));
}

/** Check a backup folder. Never writes to the database or the installation. */
export async function runPersonalRestoreCheck(argv:string[],options:PersonalRestoreOptions={}){
 const [backupArg]=argv;
 if(!backupArg||backupArg.startsWith('--')||argv.length!==1)throw new Refusal('RESTORE_USAGE');
 const requested=resolve(backupArg);
 try{
  const info=await lstat(requested);
  if(info.isSymbolicLink()||!info.isDirectory())throw new Refusal('RESTORE_NOT_A_BACKUP');
 }catch(error){
  if(error instanceof Refusal)throw error;
  throw new Refusal('RESTORE_NOT_A_BACKUP');
 }
 const backup=await realpath(requested);
 const count=await verifyBackupManifest(backup);
 const dumpFile=join(backup,'database.dump');
 try{
  const info=await lstat(dumpFile);
  if(!info.isFile()||info.isSymbolicLink())throw new Refusal('RESTORE_DUMP_UNREADABLE');
 }catch(error){
  if(error instanceof Refusal)throw error;
  throw new Refusal('RESTORE_DUMP_UNREADABLE');
 }
 await listArchive(backup,dumpFile,options);
 return [`MANIFEST.txt confere (${count} arquivos).`,'database.dump é legível.'];
}
