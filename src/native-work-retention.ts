import {execFile, spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat, open, readFile, readdir, rename, rmdir, unlink, writeFile, type FileHandle} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Id} from './contracts.ts';

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const anchored = (dir: FileHandle, name: string) => join('/proc/self/fd', String(dir.fd), name);
const helper = fileURLToPath(new URL('../scripts/release-exam-work.py', import.meta.url));

async function openRoot(path: string) {
  if (resolve(path) !== path || path === '/') throw Error('Invalid host root');
  let dir = await open('/', directoryFlags);
  try {
    for (const name of path.slice(1).split('/')) {
      const next = await open(anchored(dir, name), directoryFlags);
      await dir.close();
      dir = next;
    }
    return dir;
  } catch (error) {
    await dir.close();
    throw error;
  }
}

async function assertPrivate(dir: FileHandle) {
  const stat = await dir.stat();
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700) throw Error('Unsafe job directory');
}

async function mountId(dir: FileHandle) {
  const info = await readFile('/proc/self/fdinfo/' + dir.fd, 'utf8');
  const id = /^mnt_id:\s*(\d+)$/m.exec(info)?.[1];
  if (!id) throw Error('Unknown mount');
  return id;
}

async function identity(dir: FileHandle) {
  const stat = await dir.stat({bigint:true});
  return stat.dev + ':' + stat.ino;
}

async function treeSize(dir: FileHandle, mount: string): Promise<number> {
  let bytes = 0;
  for (const name of await readdir(anchored(dir, '.'))) {
    const path = anchored(dir, name);
    const entry = await lstat(path);
    if (!entry.isDirectory()) {
      bytes += entry.size;
      continue;
    }
    const child = await open(path, directoryFlags);
    try {
      if (await mountId(child) !== mount) throw Error('Unexpected nested mount');
      bytes += await treeSize(child, mount);
    } finally {
      await child.close();
    }
  }
  return bytes;
}

export type WorkIdentity = {job: string; work: string; bytes: number};
export type WorkOperation = {state:'absent'|'released'} | {state:'present'; snapshot:WorkIdentity};

async function release(root:FileHandle,job:FileHandle,work:FileHandle,jobId:string,planned:WorkIdentity,signal?:AbortSignal):Promise<WorkOperation> {
  signal?.throwIfAborted();
  const child=spawn('/usr/bin/python3',['-I',helper,String(process.pid),jobId,planned.job,planned.work],{
    stdio:['ignore','pipe','ignore',root.fd,job.fd,work.fd],env:{PATH:'/usr/bin:/bin'},signal,killSignal:'SIGKILL'
  });
  let output='';
  child.stdout!.setEncoding('utf8').on('data', data=>{output+=data;});
  await new Promise<void>((done,fail)=>{
    child.on('error',fail);
    child.on('close',code=>code===0?done():fail(Error('Incomplete work retirement')));
  });
  if(output.trim()!=='emptied')throw Error('Invalid work retirement result');
  signal?.throwIfAborted();
  const path=anchored(job,'work');
  const current=await lstat(path,{bigint:true});
  if(!current.isDirectory()||current.dev+':'+current.ino!==planned.work)throw Error('Checkout changed');
  await rmdir(path); // Requires the literal job child to be an empty directory.
  return {state:'released'};
}

export async function examineWorkTree(hostRoot:string,jobId:string,checkOutput:(dir:FileHandle)=>Promise<void>,planned?:WorkIdentity,signal?:AbortSignal):Promise<WorkOperation> {
  Id.parse(jobId);
  const root=await openRoot(hostRoot);
  try {
    await assertPrivate(root);
    const job=await open(anchored(root,jobId),directoryFlags);
    try {
      await assertPrivate(job);
      const mount=await mountId(job);
      if(mount!==await mountId(root))throw Error('Unexpected job mount');
      const output=await open(anchored(job,'output'),directoryFlags);
      try {await assertPrivate(output);if(await mountId(output)!==mount)throw Error('Unexpected output mount');await checkOutput(output);} finally {await output.close();}
      if(planned&&await identity(job)!==planned.job)throw Error('Job changed');
      let work:FileHandle;
      try {work=await open(anchored(job,'work'),directoryFlags);}
      catch(error){
        if((error as NodeJS.ErrnoException).code==='ENOENT')return {state:'absent'};
        throw error;
      }
      try {
        const stat=await work.stat();
        if(stat.uid!==process.getuid?.()||await mountId(work)!==mount)throw Error('Unsafe work directory');
        if(planned){
          if(await identity(work)!==planned.work)throw Error('Checkout changed');
          return await release(root,job,work,jobId,planned,signal);
        }
        return {state:'present',snapshot:{job:await identity(job),work:await identity(work),bytes:await treeSize(work,mount)}};
      } finally {await work.close();}
    } finally {await job.close();}
  } finally {await root.close();}
}

/** Job directories that still have a `work` entry, in id order. One readdir of the host root plus one lstat per
 * job: no database scan and no tree walk, so the cost follows the number of jobs, not the size of their copies.
 * Only directory entries named like job ids are considered; whatever else lives in the root is ignored. */
export async function inventoryJobWork(hostRoot:string):Promise<{ids:string[];scanned:number}> {
  const root=await openRoot(hostRoot);
  try {
    await assertPrivate(root);
    const names=(await readdir(anchored(root,'.'),{withFileTypes:true})).filter(entry=>entry.isDirectory()&&Id.safeParse(entry.name).success).map(entry=>entry.name).sort();
    const ids:string[]=[];
    for(let i=0;i<names.length;i+=32){
      const page=names.slice(i,i+32);
      const found=await Promise.all(page.map(name=>lstat(anchored(root,name+'/work')).then(()=>true,(error:NodeJS.ErrnoException)=>{
        if(error.code==='ENOENT'||error.code==='ENOTDIR')return false;
        throw error;
      })));
      page.forEach((name,index)=>{if(found[index])ids.push(name);});
    }
    return {ids,scanned:names.length};
  } finally {await root.close();}
}

/** Continues after `cursor` and wraps around, so a prefix of jobs that cost budget without being freed cannot starve the rest. */
export function rotateAfter<T extends string>(sorted:readonly T[],cursor:string|undefined):T[] {
  if(!cursor)return [...sorted];
  const at=sorted.findIndex(id=>id>cursor);
  return at<0?[...sorted]:[...sorted.slice(at),...sorted.slice(0,at)];
}

/** The cursor is advisory: a missing, damaged or foreign file means "start from the beginning". */
export async function readRetentionCursor(file:string):Promise<string|undefined> {
  try {
    const value=JSON.parse(await readFile(file,'utf8')) as {after?:unknown};
    return typeof value.after==='string'&&Id.safeParse(value.after).success?value.after:undefined;
  } catch {return undefined;}
}

export async function writeRetentionCursor(file:string,after:string|undefined):Promise<void> {
  if(!after){await unlink(file).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;});return;}
  const temporary=file+'.'+process.pid+'.tmp';
  await writeFile(temporary,JSON.stringify({after})+'\n',{mode:0o600});
  try {await rename(temporary,file);} catch (error) {await unlink(temporary).catch(()=>undefined);throw error;}
}

const gitEnvironment={PATH:'/usr/bin:/bin',HOME:'/nonexistent',LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
function git(repository:string,args:string[]):Promise<{code:number;stdout:string}> {
  return new Promise(done=>{
    execFile('/usr/bin/git',['--no-optional-locks','-C',repository,...args],{env:gitEnvironment,timeout:15000,maxBuffer:65536},(error,stdout)=>{
      done({code:error?(typeof (error as {code?:unknown}).code==='number'?(error as {code:number}).code:1):0,stdout:String(stdout)});
    });
  });
}
const gitId=/^[a-f0-9]{40}$/;

/** True only when the commit object exists in the project repository (a snapshot of it can be rebuilt). Plumbing only, no hooks. */
export async function repositoryHasCommit(repository:string,commit:string):Promise<boolean> {
  return gitId.test(commit)&&(await git(repository,['cat-file','-e',commit+'^{commit}'])).code===0;
}

/** True only when the commit is reachable from a real ref and has the given tree. An object that only a fetch left
 * unreferenced is not preserved: garbage collection may still drop it. */
export async function repositoryKeepsArtifact(repository:string,commit:string,tree:string):Promise<boolean> {
  if(!gitId.test(commit)||!gitId.test(tree))return false;
  const found=await git(repository,['rev-parse','--verify','--quiet',commit+'^{tree}']);
  if(found.code!==0||found.stdout.trim()!==tree)return false;
  const refs=await git(repository,['for-each-ref','--count=1','--contains',commit,'--format=%(refname)']);
  return refs.code===0&&refs.stdout.trim().length>0;
}
