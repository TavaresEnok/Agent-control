import {constants} from 'node:fs';
import {open,link,unlink,mkdir,type FileHandle} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {relative,resolve,sep} from 'node:path';
import {Refusal,digest} from './contracts.ts';
import {projectRepositoryIdentity,validateTrustedProjectPath} from './project-repository.ts';

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
