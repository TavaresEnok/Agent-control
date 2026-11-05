import {constants} from 'node:fs';
import {open,rename,unlink,mkdir,type FileHandle} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join,relative,resolve,sep} from 'node:path';
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
/** Anchored descriptors prevent traversal through replaced/symlinked children. */
export async function reconcileWorkflowFile(repo:string,identity:unknown,name:string,oldDigest:string|null,desiredDigest:string,bytes:Buffer){
 const handles:FileHandle[]=[];let temp:string|undefined;
 try{
  if(digest(await projectRepositoryIdentity(repo))!==digest(identity))throw Error('identity');
  let dir=await open(repo,constants.O_RDONLY|constants.O_DIRECTORY|nofollow);handles.push(dir);
  const rootStat=await dir.stat({bigint:true});const actual=identity as {repoDev:string;repoIno:string};
  if(String(rootStat.dev)!==actual.repoDev||String(rootStat.ino)!==actual.repoIno)throw Error('identity');
  for(const part of ['.ai','cezar','workflows']){
   const path=`/proc/self/fd/${dir.fd}/${part}`;
   try{await mkdir(path,{mode:0o700});await dir.sync();}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
   dir=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|nofollow);handles.push(dir);
   const s=await dir.stat();if(s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw Error('unsafe directory');
  }
  const base=`/proc/self/fd/${dir.fd}`,leaf=join(base,`${name}.yaml`);
  const read=async()=>{let f:FileHandle;try{f=await open(leaf,constants.O_RDONLY|nofollow|constants.O_NONBLOCK);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
   try{const s=await f.stat();if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size>256*1024)throw Error('unsafe file');return hash(await f.readFile());}finally{await f.close();}};
  let current=await read();if(current===desiredDigest)return;
  if(current!==oldDigest)throw new Refusal('WORKFLOW_FILE_CONFLICT',409);
  temp=join(base,`.ac-${randomUUID()}.tmp`);
  const staged=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|nofollow,0o600);
  try{await staged.writeFile(bytes);await staged.sync();}finally{await staged.close();}
  current=await read();if(current!==oldDigest)throw new Refusal('WORKFLOW_FILE_CONFLICT',409);
  await rename(temp,leaf);temp=undefined;await dir.sync();
 }catch(e){if(e instanceof Refusal)throw e;throw new Refusal('WORKFLOW_FILESYSTEM_UNAVAILABLE',409);}
 finally{if(temp)await unlink(temp).catch(()=>{});for(const h of handles.reverse())await h.close().catch(()=>{});}
}
