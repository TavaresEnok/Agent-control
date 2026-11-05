import {constants} from 'node:fs';
import {open,link,unlink,mkdir,readdir,type FileHandle} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {relative,resolve,sep} from 'node:path';
import {Refusal,digest} from './contracts.ts';
import {projectRepositoryIdentity,validateTrustedProjectPath} from './project-repository.ts';
import {createRequire} from 'node:module';
import {QUICK_TASK_WORKFLOW} from '../upstream/cezar/packages/cezar/dist/workflows/types.js';
import {BUILT_IN_GRAPH_WORKFLOWS} from '../upstream/cezar/packages/cezar/dist/workflows/templates.js';
const parseYaml=(createRequire(new URL('../upstream/cezar/packages/cezar/dist/workflows/load.js',import.meta.url))('yaml') as {parse:(value:string)=>unknown}).parse;

const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const nofollow=constants.O_NOFOLLOW;
export async function workflowRepository(repo:string,roots:readonly {id:string;path:string}[],privateDirectory:string){
 const root=roots.find(r=>repo.startsWith(r.path+sep));
 if(!root||resolve(root.path)!==root.path||resolve(privateDirectory)!==privateDirectory||repo===privateDirectory||repo.startsWith(privateDirectory+sep)||privateDirectory.startsWith(repo+sep))throw new Refusal('WORKFLOW_REPOSITORY_FORBIDDEN',403);
 try{if(await validateTrustedProjectPath(root.path,relative(root.path,repo))!==repo)throw Error();return {repo,root,identity:await projectRepositoryIdentity(repo)};}
 catch{throw new Refusal('WORKFLOW_REPOSITORY_UNAVAILABLE',409);}
}
async function withDirectory<T>(repo:string,identity:unknown,name:string,create:boolean,fn:(dir:FileHandle)=>Promise<T>):Promise<T>{
 const handles:FileHandle[]=[];
 try{
  if(digest(await projectRepositoryIdentity(repo))!==digest(identity))throw Error('identity');
  let dir=await open(repo,constants.O_RDONLY|constants.O_DIRECTORY|nofollow);handles.push(dir);
  const rootStat=await dir.stat({bigint:true});const actual=identity as {repoDev:string;repoIno:string};
  if(String(rootStat.dev)!==actual.repoDev||String(rootStat.ino)!==actual.repoIno)throw Error('identity');
  for(const part of ['.ai','cezar','workflows','.managed',name]){
   const path=`/proc/self/fd/${dir.fd}/${part}`;
   if(create)try{await mkdir(path,{mode:0o700});await dir.sync();}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
   dir=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|nofollow);handles.push(dir);
   const s=await dir.stat();if(s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw Error('unsafe directory');
  }
  return await fn(dir);
 }catch(e){if(e instanceof Refusal)throw e;throw new Refusal('WORKFLOW_FILESYSTEM_UNAVAILABLE',409);}
 finally{for(const h of handles.reverse())await h.close().catch(()=>{});}
}
/** Inspect only bounded regular legacy leaves before invoking the native parser. */
export async function legacyWorkflowNames(repo:string,identity:unknown){
 const handles:FileHandle[]=[];
 try{
  if(digest(await projectRepositoryIdentity(repo))!==digest(identity))throw Error('identity');
  let dir=await open(repo,constants.O_RDONLY|constants.O_DIRECTORY|nofollow);handles.push(dir);
  for(const part of ['.ai','cezar','workflows']){
   try{dir=await open(`/proc/self/fd/${dir.fd}/${part}`,constants.O_RDONLY|constants.O_DIRECTORY|nofollow);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return new Set([QUICK_TASK_WORKFLOW,...BUILT_IN_GRAPH_WORKFLOWS].map(w=>w.name));throw e;}
   handles.push(dir);const stat=await dir.stat();if(stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)throw Error('unsafe directory');
  }
  const base=`/proc/self/fd/${dir.fd}`,entries=await readdir(base);if(entries.length>1024)throw Error('too many files');
  const names=new Set([QUICK_TASK_WORKFLOW,...BUILT_IN_GRAPH_WORKFLOWS].map(w=>w.name));
  for(const entry of entries){if(!/\.(?:yaml|yml)$/i.test(entry))continue;
   const file=await open(`${base}/${entry}`,constants.O_RDONLY|nofollow|constants.O_NONBLOCK);
   try{const stat=await file.stat();if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o022)!==0||stat.size>256*1024)throw Error('unsafe legacy file');
    const bytes=await file.readFile();if(bytes.length>256*1024)throw Error('unsafe legacy file');
    const parsed=parseYaml(bytes.toString('utf8'));if(parsed&&typeof parsed==='object'&&'name' in parsed&&typeof parsed.name==='string')names.add(parsed.name);
   }finally{await file.close();}names.add(entry.replace(/\.(?:yaml|yml)$/i,''));
  }
  return names;
 }catch(e){if(e instanceof Refusal)throw e;throw new Refusal('WORKFLOW_LEGACY_CATALOG_UNAVAILABLE',409);}
 finally{for(const handle of handles.reverse())await handle.close().catch(()=>{});}
}
const leaf=(dir:FileHandle,revision:number,fileDigest:string)=>`/proc/self/fd/${dir.fd}/${revision}-${fileDigest}.yaml`;
async function readLeaf(path:string){
 let f:FileHandle;try{f=await open(path,constants.O_RDONLY|nofollow|constants.O_NONBLOCK);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
 try{const s=await f.stat();if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size>256*1024)throw Error('unsafe file');return await f.readFile();}finally{await f.close();}
}
export async function readWorkflowFile(repo:string,identity:unknown,name:string,revision:number,fileDigest:string){
 return withDirectory(repo,identity,name,false,async dir=>{const data=await readLeaf(leaf(dir,revision,fileDigest));if(!data||hash(data)!==fileDigest)throw new Refusal('WORKFLOW_FILE_CONFLICT',409);return data;});
}
/** Immutable revision publication. The final hard link is created only if absent. */
export async function reconcileWorkflowFile(repo:string,identity:unknown,name:string,revision:number,desiredDigest:string,bytes:Buffer){
 if(hash(bytes)!==desiredDigest)throw new Refusal('WORKFLOW_FILE_CONFLICT',409);
 return withDirectory(repo,identity,name,true,async dir=>{
  const base=`/proc/self/fd/${dir.fd}`,target=leaf(dir,revision,desiredDigest),existing=await readLeaf(target);
  if(existing){if(!existing.equals(bytes))throw new Refusal('WORKFLOW_FILE_CONFLICT',409);return;}
  const temp=`${base}/.ac-${randomUUID()}.tmp`;
  try{
   const file=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|nofollow,0o600);
   try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
   try{await link(temp,target);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const other=await readLeaf(target);if(!other||!other.equals(bytes))throw new Refusal('WORKFLOW_FILE_CONFLICT',409);}
   await unlink(temp);await dir.sync();
  }finally{await unlink(temp).catch(()=>{});}
 });
}
