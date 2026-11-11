import {chmod,lstat,readFile,realpath,rename,stat,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename,dirname,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Installation,loadInstallation} from './installation.ts';

/**
 * Records the directories the personal panel may browse.
 * The gateway reads projectRoots only at startup, so the command asks for a restart.
 */
export async function listPersonalRoots(installationPath:string){
 const config=await loadInstallation(installationPath);
 return config.projectRoots;
}

export async function addPersonalRoot(installationPath:string,folder:string,label?:string){
 const config=await loadInstallation(installationPath);
 const real=await canonicalDirectory(folder);
 const data=await canonicalIfPresent(config.dataDirectory);
 if(data&&overlaps(real,data))throw new Error('DATA_DIRECTORY_PATH_FORBIDDEN');
 if(config.projectRoots.some(root=>root.path===real))throw new Error('PROJECT_ROOT_ALREADY_PRESENT');
 const name=(label??basename(real)).trim();
 if(name.length<1||name.length>100||/[\u0000-\u001f\u007f]/.test(name))throw new Error('PROJECT_ROOT_LABEL_INVALID');
 const id=projectRootId(label??basename(real));
 if(config.projectRoots.some(root=>root.id===id))throw new Error('PROJECT_ROOT_ID_EXISTS');
 const raw=JSON.parse(await readFile(installationPath,'utf8')) as {projectRoots?:unknown};
 raw.projectRoots=[...config.projectRoots,{id,label:name,path:real}];
 const parsed=Installation.safeParse(raw);
 if(!parsed.success)throw new Error('INVALID_INSTALLATION');
 await backupRoots(installationPath);
 await writePrivate(installationPath,JSON.stringify(raw,null,2)+'\n');
 return {id,label:name,path:real,restart:restartLine(config.dataDirectory)};
}

export async function removePersonalRoot(installationPath:string,id:string){
 const config=await loadInstallation(installationPath);
 if(!config.projectRoots.some(root=>root.id===id))throw new Error('PROJECT_ROOT_NOT_FOUND');
 const raw=JSON.parse(await readFile(installationPath,'utf8')) as {projectRoots?:unknown};
 raw.projectRoots=config.projectRoots.filter(root=>root.id!==id);
 const parsed=Installation.safeParse(raw);
 if(!parsed.success)throw new Error('INVALID_INSTALLATION');
 await backupRoots(installationPath);
 await writePrivate(installationPath,JSON.stringify(raw,null,2)+'\n');
 return {id,restart:restartLine(config.dataDirectory)};
}

/** Stable id for a folder name. The schema allows a short lowercase token. */
export function projectRootId(name:string){
 let id=name.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'');
 if(!/^[a-z]/.test(id))id='r'+(id?'-'+id:'');
 id=id.slice(0,64).replace(/-+$/g,'');
 if(!/^[a-z][a-z0-9_-]{0,63}$/.test(id))throw new Error('PROJECT_ROOT_ID_INVALID');
 return id;
}

async function canonicalDirectory(input:string){
 const absolute=resolve(input);
 if(absolute===sep)throw new Error('PROJECT_ROOT_FORBIDDEN');
 const parts=absolute.split(sep).filter(Boolean);
 let cursor:string=sep;
 for(let index=0;index<parts.length;index++){
  cursor=join(cursor,parts[index]!);
  let info;try{info=await lstat(cursor);}catch{throw new Error('PROJECT_ROOT_UNAVAILABLE');}
  const last=index===parts.length-1;
  if(info.isSymbolicLink()&&!last)throw new Error('PROJECT_ROOT_SYMLINK_FORBIDDEN');
  if(last&&!info.isSymbolicLink()&&!info.isDirectory())throw new Error('PROJECT_ROOT_UNAVAILABLE');
 }
 const real=await realpath(absolute);
 if(real===sep)throw new Error('PROJECT_ROOT_FORBIDDEN');
 if(!(await stat(real)).isDirectory())throw new Error('PROJECT_ROOT_UNAVAILABLE');
 if(real===(await realpath(homedir())))throw new Error('PROJECT_ROOT_HOME_FORBIDDEN');
 return real;
}
async function canonicalIfPresent(path:string){try{return await realpath(path);}catch{return resolve(path);}}
function overlaps(left:string,right:string){return left===right||left.startsWith(right+sep)||right.startsWith(left+sep);}
function restartLine(dataDirectory:string){
 const service=basename(dataDirectory).replace(/[^A-Za-z0-9_-]/g,'-')||'gateway';
 return 'systemctl --user restart agent-control-gateway-'+service;
}
async function backupRoots(installationPath:string){
 const target=join(dirname(installationPath),'installation.json.before-roots');
 try{await writeFile(target,await readFile(installationPath),{mode:0o600,flag:'wx'});}
 catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 await chmod(target,0o600);
}
async function writePrivate(path:string,content:string){
 const temporary=path+'.'+randomUUID()+'.tmp';
 await writeFile(temporary,content,{mode:0o600,flag:'wx'});await chmod(temporary,0o600);await rename(temporary,path);
}

async function main(){
 const [file,action,...rest]=process.argv.slice(2);
 const usage='Uso: npm run personal:roots -- <instalação.json> list|add <pasta> [--label nome]|remove <id>';
 if(!file||!action){console.log(usage);process.exit(file||action?1:0);}
 try{
  if(action==='list'&&rest.length===0){
   const roots=await listPersonalRoots(file);
   if(!roots.length)console.log('Nenhuma raiz.');
   for(const root of roots)console.log(root.id+'\t'+root.label+'\t'+root.path);
   return;
  }
  if(action==='add'){
   const labelAt=rest.indexOf('--label'),label=labelAt<0?undefined:rest[labelAt+1];
   const positionals=rest.filter((arg,index)=>arg!=='--label'&&index!==labelAt+1);
   const folder=positionals[0];
   if(!folder||positionals.length!==1||(labelAt>=0&&!label)){console.log(usage);process.exit(1);}
   const result=await addPersonalRoot(file,folder,label);
   console.log('Raiz gravada: '+result.id+' ('+result.path+').');
   console.log('Reinicie o gateway:');
   console.log(result.restart);
   return;
  }
  if(action==='remove'&&rest.length===1&&rest[0]&&!rest[0].startsWith('--')){
   const result=await removePersonalRoot(file,rest[0]);
   console.log('Raiz removida: '+result.id+'.');
   console.log('Reinicie o gateway:');
   console.log(result.restart);
   return;
  }
  console.log(usage);process.exit(1);
 }catch(error){
  const message=error instanceof Error?error.message:String(error);
  console.log(/^[A-Z][A-Z0-9_]{2,80}$/.test(message)?message:'INVALID_INSTALLATION');
  process.exit(1);
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main();
