import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat, open, readFile, readdir, rmdir, type FileHandle} from 'node:fs/promises';
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
