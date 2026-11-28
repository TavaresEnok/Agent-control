import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,opendir,readFile,readdir,realpath,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,resolve,sep} from 'node:path';
import type {Installation} from './installation.ts';
import {releaseRegisteredDirectory} from './native-work-retention.ts';
import {defaultGit,defaultProcessInside,listWorktrees,mountedInside,type CommandResult} from './personal-artifact-retention.ts';
import {storageSettings} from './storage-config.ts';

/**
 * Retention of round temporaries under the system temporary directory (`ac-*`, `chatisp-*`) that nobody registered.
 * An entry goes only when it is older than `storage.tmpHours`, every file in it is too, no process, mount or container uses it,
 * and nothing in it looks like data (backups, dumps, database directories). A git checkout inside goes only when it is clean
 * and every commit it holds is on a branch of a repository that stays (a project of the installation or `storage.productRepo`).
 */

type Git=(cwd:string,args:string[])=>Promise<CommandResult>;
export type TempRetentionDeps={
 git?:Git;
 /** Whether any live process uses `path`. Throwing keeps the entry. */
 processInside?:(path:string)=>Promise<boolean>;
 /** Host paths mounted by any container, running or stopped. */
 containerMounts?:()=>Promise<string[]>;
 mountInfo?:()=>Promise<string>;
 tmpRoot?:string;
 now?:()=>number;
};
export type TempCheckout={git:'clone'|'worktree';path:string;repo?:string};

const execute=promisify(execFile);
const overlap=(a:string,b:string)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep);
/** Names that look like data. They protect a standalone temporary at any depth; inside a verified checkout they are tracked files. */
export const protectedTempName=(name:string)=>/backup|verifica[cç][oõ]es|^PG_VERSION$|^basebackup|\.(?:dump|sql|backup)(?:\.|$)/i.test(name);
const errno=(error:unknown,code:string)=>(error as NodeJS.ErrnoException)?.code===code;

async function defaultContainerMounts(){
 const docker=async(args:string[])=>(await execute('docker',args,{timeout:120000,maxBuffer:16*1024*1024})).stdout.trim();
 const ids=(await docker(['container','ls','-a','-q'])).split(/\s+/).filter(Boolean);
 if(!ids.length)return [];
 return (JSON.parse(await docker(['container','inspect',...ids])) as {Mounts?:{Source:string}[]}[]).flatMap(c=>(c.Mounts??[]).map(m=>m.Source));
}

/** True when `path` holds nothing that may be data and nothing newer than `cutoff`. A directory with `.git` is a checkout: it counts
 * only when `checkout` vouches for it (clean, every commit on a branch that stays); each vouched checkout is appended to `found`. */
export async function discardableTempContents(path:string,device:bigint,cutoff:number,checkout?:(dir:string)=>Promise<TempCheckout|undefined>,found:TempCheckout[]=[],tracked=false):Promise<boolean>{
 const git=await lstat(join(path,'.git')).catch((error:unknown)=>{if(errno(error,'ENOENT')||errno(error,'ENOTDIR'))return undefined;throw error;});
 let inCheckout=tracked;
 if(git){
  if(!checkout)return false;
  const verdict=await checkout(path).catch(()=>undefined/* git could not vouch: keep */);
  if(!verdict||verdict.git!==(git.isDirectory()?'clone':git.isFile()?'worktree':'')||verdict.path!==path)return false;
  found.push(verdict);
  inCheckout=true;
 }
 const entries=await opendir(path);
 for await(const entry of entries){
  const metadata=entry.name==='.git';
  if(!metadata&&!inCheckout&&protectedTempName(entry.name))return false;
  const child=join(path,entry.name),info=await lstat(child,{bigint:true});
  if(info.dev!==device||info.uid!==BigInt(process.getuid!())||Number(info.mtimeMs)>cutoff)return false;
  // The contents of `.git` keep the protected-name checks: only the checkout's own files are tracked.
  if(info.isDirectory()&&!await discardableTempContents(child,device,cutoff,metadata?undefined:checkout,found,metadata?false:inCheckout))return false;
 }
 return true;
}

/** Clean status: no change and no untracked file. Ignored entries are accepted only when they are symbolic links (removing a link never removes its target). */
async function clean(git:Git,dir:string){
 const index=await git(dir,['ls-files','-v','-z']);
 if(index.code!==0||index.stdout.split('\0').some(line=>line&&!line.startsWith('H ')))return false;
 const status=await git(dir,['status','--porcelain=v1','-z','--untracked-files=all','--ignored=matching','--ignore-submodules=none']);
 if(status.code!==0)return false;
 for(const line of status.stdout.split('\0')){
  if(!line)continue;
  const relative=line.slice(3);
  if(!line.startsWith('!! ')||relative.endsWith('/')||relative.split('/').some(part=>!part||part==='..'))return false;
  const target=await lstat(join(dir,relative)).catch((error:unknown)=>errno(error,'ENOENT')?null:undefined);
  if(target===undefined||target&&!target.isSymbolicLink())return false;
 }
 return true;
}

/** Commits named by `tips` that no branch of `repo` contains. Undefined when git cannot tell (for example, the objects are unknown there). */
async function outsideBranches(git:Git,repo:string,tips:string[]){
 const result=await git(repo,['rev-list','--max-count=1',...tips,'--not','--branches']);
 return result.code===0?result.stdout.trim():undefined;
}

/** Vouches for a checkout inside a temporary: clean and with every commit on a branch of a repository that stays. */
export async function vouchTempCheckout(git:Git,dir:string,repos:readonly string[]):Promise<TempCheckout|undefined>{
 const info=await lstat(join(dir,'.git'));
 if(!await clean(git,dir))return undefined;
 if(info.isDirectory()){
  // A standalone clone may own other worktrees, and its own branches go with it: its tips must be on a branch elsewhere.
  const listed=await git(dir,['worktree','list','--porcelain','-z']);
  if(listed.code!==0||listed.stdout.split('\0').filter(field=>field.startsWith('worktree ')).length!==1)return undefined;
  const tips=await git(dir,['rev-parse','HEAD','--all']);
  if(tips.code!==0)return undefined;
  const ids=tips.stdout.split(/\s+/).filter(id=>/^[a-f0-9]{40,64}$/.test(id));
  if(!ids.length)return undefined;
  for(const repo of repos)if(await outsideBranches(git,repo,[...new Set(ids)])==='')return {git:'clone',path:dir};
  return undefined;
 }
 if(!info.isFile())return undefined;
 const common=await git(dir,['rev-parse','--path-format=absolute','--git-common-dir']);
 if(common.code!==0)return undefined;
 for(const repo of repos){
  const own=await git(repo,['rev-parse','--path-format=absolute','--git-common-dir']);
  if(own.code!==0||own.stdout.trim()!==common.stdout.trim())continue;
  const record=(await listWorktrees(git,repo).catch(()=>[]/* worktree list unavailable: the directory is not a known worktree and stays */)).find(item=>item.path===dir);
  if(!record||record.main||record.locked||!record.head)return undefined;
  // Removing the worktree keeps its branch, so its own branch counts; a detached commit on no branch keeps it.
  return await outsideBranches(git,repo,[record.head])===''?{git:'worktree',path:dir,repo}:undefined;
 }
 return undefined;
}

type TempInstallation=Pick<Installation,'dataDirectory'|'project'|'projects'>&{storage?:unknown};

export async function simpleTempRetention(config:TempInstallation,apply:boolean,deps:TempRetentionDeps={}){
 const git=deps.git??defaultGit,processInside=deps.processInside??defaultProcessInside,now=deps.now??Date.now;
 const storage=storageSettings(config),age=storage.tmpHours*3600000;
 const root=await realpath(deps.tmpRoot??tmpdir()),mounts=await (deps.mountInfo??(()=>readFile('/proc/self/mountinfo','utf8')))();
 const repos=[...new Set([config.project,...config.projects].map(p=>p.repo).concat(storage.productRepo?[storage.productRepo]:[]))];
 const protectedPaths=[config.dataDirectory,...repos,...await (deps.containerMounts??defaultContainerMounts)()];
 const lines:string[]=[];
 for(const entry of await readdir(root,{withFileTypes:true})){
  if(!(entry.isDirectory()||entry.isFile())||!/^(?:ac-|chatisp-)[A-Za-z0-9._-]{1,120}$/.test(entry.name)||protectedTempName(entry.name))continue;
  const path=resolve(root,entry.name),info=await lstat(path,{bigint:true});
  if(info.uid!==BigInt(process.getuid!())||now()-Number(info.mtimeMs)<age||protectedPaths.some(p=>overlap(p,path))||mountedInside(mounts,path))continue;
  if(await processInside(path).catch(()=>true/* cannot prove: keep */))continue;
  if(entry.isDirectory()){
   const found:TempCheckout[]=[];
   if(!await discardableTempContents(path,info.dev,now()-age,dir=>vouchTempCheckout(git,dir,repos),found).catch(()=>false /* unreadable content must be preserved */))continue;
   if(apply){
    try{
     // Worktrees leave through git (their branch stays), deepest first; then the directory itself.
     for(const checkout of found.filter(item=>item.git==='worktree').sort((a,b)=>b.path.length-a.path.length)){
      const removed=await git(checkout.repo!,['worktree','remove','--force','--',checkout.path]);
      if(removed.code!==0)throw Error('worktree remove');
     }
     const current=await lstat(path,{bigint:true}).catch((error:unknown)=>{if(errno(error,'ENOENT'))return undefined;throw error;});
     if(current){
      if(current.dev!==info.dev||current.ino!==info.ino)continue;
      await releaseRegisteredDirectory(path,{dev:String(info.dev),ino:String(info.ino)});
     }
    }catch{lines.push('Temporário preservado (falha ao remover) '+basename(path));continue;}
   }
  }else{
   if(/\.(?:tar|gz|xz|zst|zip|7z|oci)(?:\.|$)/i.test(entry.name))continue;
   const current=await lstat(path,{bigint:true});
   if(current.dev!==info.dev||current.ino!==info.ino||current.mtimeNs!==info.mtimeNs)continue;
   if(apply)await unlink(path);
  }
  lines.push((apply?'Temporário removido ':'Temporário elegível ')+basename(path));
 }
 return lines;
}
