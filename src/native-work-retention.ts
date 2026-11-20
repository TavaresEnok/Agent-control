import {execFile, spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat, mkdtemp, open, readFile, readdir, rename, rm, rmdir, unlink, writeFile, type FileHandle} from 'node:fs/promises';
import {tmpdir} from 'node:os';
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

const gitEnvironment={PATH:'/usr/bin:/bin',HOME:'/nonexistent',LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_OPTIONAL_LOCKS:'0'};
// Hooks (reference-transaction included) and fsmonitor never run, whatever the repository says.
const gitOptions=['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','protocol.ext.allow=never'];
function git(repository:string,args:string[],extra:Record<string,string>={},signal?:AbortSignal):Promise<{code:number;stdout:string}> {
  return new Promise(done=>{
    execFile('/usr/bin/git',[...gitOptions,...(repository?['-C',repository]:[]),...args],{env:{...gitEnvironment,...extra},timeout:120000,maxBuffer:1024*1024,signal,killSignal:'SIGKILL'},(error,stdout)=>{
      done({code:error?(typeof (error as {code?:unknown}).code==='number'?(error as {code:number}).code:1):0,stdout:String(stdout)});
    });
  });
}
const gitId=/^[a-f0-9]{40}$/;
const zeroId='0'.repeat(40);

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

/** Tree of a commit in the project repository, or `undefined` when the commit is absent. */
export async function repositoryTreeOf(repository:string,commit:string):Promise<string|undefined> {
  if(!gitId.test(commit))return undefined;
  const found=await git(repository,['rev-parse','--verify','--quiet',commit+'^{tree}']);
  const tree=found.stdout.trim();
  return found.code===0&&gitId.test(tree)?tree:undefined;
}

/** Private ref that keeps one job's artifact alive in the project repository. It lives outside `refs/heads` and
 * `refs/tags`, so integration (which only moves the target branch) never updates it, and it is never rewritten. */
export function retainedArtifactRef(jobId:string):string {
  Id.parse(jobId);
  return 'refs/agent-control/retained/'+jobId;
}

/** Commit the job's private ref points to, `undefined` when it does not exist, `false` when it is unreadable or not a commit. */
export async function retainedArtifact(repository:string,jobId:string):Promise<string|undefined|false> {
  const ref=retainedArtifactRef(jobId);
  const listed=await git(repository,['for-each-ref','--format=%(objectname) %(objecttype)',ref]);
  if(listed.code!==0)return false;
  const line=listed.stdout.trim();
  if(!line)return undefined;
  const [id,type]=line.split(' ');
  return id&&gitId.test(id)&&type==='commit'?id:false;
}

/** Creates the job's private ref with compare-and-swap against "no ref": it is created once and never moved.
 * Replay with the same commit is accepted; any other existing value is a conflict and nothing is written. */
export async function pinRetainedArtifact(repository:string,jobId:string,commit:string,tree:string):Promise<'created'|'kept'|'conflict'|'missing'> {
  if(!gitId.test(commit)||!gitId.test(tree))return 'missing';
  const found=await git(repository,['rev-parse','--verify','--quiet',commit+'^{tree}']);
  if(found.code!==0||found.stdout.trim()!==tree)return 'missing';
  const before=await retainedArtifact(repository,jobId);
  if(before===commit)return 'kept';
  if(before!==undefined)return 'conflict';
  const created=await git(repository,['update-ref','--no-deref','-m','agent-control: retain artifact of job '+jobId,retainedArtifactRef(jobId),commit,zeroId]);
  if(created.code===0)return 'created';
  // Lost a race: only the same value is acceptable.
  return await retainedArtifact(repository,jobId)===commit?'kept':'conflict';
}

/** Proof that a programmer's checkout holds nothing the project repository does not already keep:
 * the working tree equals `tree` exactly (no modified, deleted or untracked file, ignored ones included), and every
 * object in the checkout's own object store (commits, stashes, staged blobs, reflog targets) exists in the project repository.
 * The checkout's Git configuration, hooks and attributes drivers are never used: both checks run against private,
 * empty Git directories that only borrow objects through alternates. Any doubt (missing `.git`, odd layout, error) is `false`. */
export async function workHoldsNoUnregisteredChange(repository:string,work:string,tree:string,signal?:AbortSignal):Promise<boolean> {
  if(!gitId.test(tree)||resolve(work)!==work)return false;
  const dotGit=await lstat(join(work,'.git')).catch(()=>undefined);
  if(!dotGit?.isDirectory())return false;
  const objects=await lstat(join(work,'.git','objects')).catch(()=>undefined);
  if(!objects?.isDirectory())return false;
  const common=await git(repository,['rev-parse','--path-format=absolute','--git-common-dir'],{},signal);
  const repositoryObjects=join(common.stdout.trim(),'objects');
  if(common.code!==0||!(await lstat(repositoryObjects).catch(()=>undefined))?.isDirectory())return false;
  const area=await mkdtemp(join(tmpdir(),'ac-workproof-'));
  try {
    const trusted=join(area,'trusted.git'),scan=join(area,'scan.git');
    for(const dir of [trusted,scan])if((await git('',['init','--bare','-q',dir],{},signal)).code!==0)return false;
    await writeFile(join(trusted,'objects','info','alternates'),repositoryObjects+'\n',{mode:0o600});
    await writeFile(join(scan,'objects','info','alternates'),join(work,'.git','objects')+'\n',{mode:0o600});
    const inTree={GIT_DIR:trusted,GIT_WORK_TREE:work,GIT_INDEX_FILE:join(area,'index')};
    if((await git('',['read-tree',tree],inTree,signal)).code!==0)return false;
    await git('',['update-index','-q','--refresh'],inTree,signal);
    if((await git('',['diff-files','--quiet','--ignore-submodules=none'],inTree,signal)).code!==0)return false;
    const untracked=await git('',['ls-files','--others','-z'],inTree,signal);
    if(untracked.code!==0||untracked.stdout.length)return false;
    return await objectsAllKnown(scan,trusted,signal);
  } catch {return false;}
  finally {await rm(area,{recursive:true,force:true});}
}

/** Streams every object id of `scan` (its alternates: the checkout) into a lookup against `trusted` (the project). */
function objectsAllKnown(scan:string,trusted:string,signal?:AbortSignal):Promise<boolean> {
  return new Promise(done=>{
    const options={env:gitEnvironment,signal,killSignal:'SIGKILL' as const};
    const list=spawn('/usr/bin/git',[...gitOptions,'--git-dir',scan,'cat-file','--batch-all-objects','--batch-check=%(objectname)'],{...options,stdio:['ignore','pipe','ignore']});
    const check=spawn('/usr/bin/git',[...gitOptions,'--git-dir',trusted,'cat-file','--batch-check=%(objectname) %(objecttype)'],{...options,stdio:['pipe','pipe','ignore']});
    let settled=false,missing=false,seen=0,pending='';
    const finish=(value:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);list.kill('SIGKILL');check.kill('SIGKILL');done(value);};
    const timer=setTimeout(()=>finish(false),300000);
    list.on('error',()=>finish(false));check.on('error',()=>finish(false));
    check.stdin!.on('error',()=>finish(false));
    list.stdout!.pipe(check.stdin!);
    check.stdout!.setEncoding('utf8').on('data',(chunk:string)=>{
      pending+=chunk;
      const lines=pending.split('\n');pending=lines.pop()!;
      for(const line of lines){seen++;if(!/^[a-f0-9]{40} (commit|tree|blob|tag)$/.test(line)){missing=true;finish(false);return;}}
    });
    const codes:{list?:number|null;check?:number|null}={};
    // An empty object store is not a checkout: refuse rather than call it clean.
    const closed=()=>{if('list' in codes&&'check' in codes)finish(codes.list===0&&codes.check===0&&!missing&&!pending&&seen>0);};
    list.on('close',code=>{codes.list=code;closed();});
    check.on('close',code=>{codes.check=code;closed();});
  });
}
