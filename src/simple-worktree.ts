import {execFile,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod,lstat,mkdir,open,readdir,realpath} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {promisify} from 'node:util';
import {isScannerSuppressionName,stripScannerSuppressions} from './git-archive-snapshot.ts';
import {withInstallationImageLock} from './personal-image-lock.ts';

const exec=promisify(execFile);
export async function worktreeGit(repository:string,args:string[]){
 const {stdout}=await exec('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',repository,...args],{
  env:{PATH:'/usr/bin:/bin',LC_ALL:'C',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',
   GIT_AUTHOR_NAME:'Agent Control',GIT_AUTHOR_EMAIL:'agent-control@localhost',GIT_COMMITTER_NAME:'Agent Control',GIT_COMMITTER_EMAIL:'agent-control@localhost'},
  timeout:600000,maxBuffer:16*1024*1024});
 return stdout;
}

export async function addSimpleWorktree(repo:string,commit:string,path:string){
 if(!/^[a-f0-9]{40}$/.test(commit))throw Error('VERIFY_COMMIT_INVALID');
 await worktreeGit(repo,['worktree','add','--quiet','--detach','--',path,commit]);
}

export const removeSimpleWorktree=(repo:string,path:string)=>worktreeGit(repo,['worktree','remove','--force','--',path]);

// A private parent protects the host path. Only the bound subtree needs
// directory traversal and read permissions for the collector uid.
export async function readableCheckout(path:string){
 await chmod(path,0o755);
 for(const entry of await readdir(path,{withFileTypes:true})){
  const child=join(path,entry.name);
  if(entry.isDirectory())await readableCheckout(child);
  else if(entry.isFile()){const mode=(await lstat(child)).mode;await chmod(child,(mode&0o100)?0o755:0o644);}
 }
}

/** Independent CLI processes share the checkout. flock releases the reader's
 * reference on exit, even when the process never runs its finally block. */
export async function sharedSimpleWorktree(dataDirectory:string,repository:string,commit:string,security=false){
 if(!/^[a-f0-9]{40}$/.test(commit))throw Error('VERIFY_COMMIT_INVALID');
 const repo=await realpath(repository);
 const root=join(dataDirectory,'native','shared-worktrees');
 await mkdir(root,{recursive:true,mode:0o700});
 if(await realpath(root)!==root)throw Error('NON_CANONICAL_WORKTREE_ROOT');
 const suppressed=security?(await worktreeGit(repo,['ls-tree','--name-only','-rz',commit])).split('\0').filter(name=>isScannerSuppressionName(basename(name))):[];
 const path=join(root,createHash('sha256').update(repo).digest('hex')+'-'+commit+(suppressed.length?'-security':''));
 const reader=await withInstallationImageLock(root,false,async()=>{
  let exists=await lstat(path).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
  if(exists){
   const previous=await open(path,constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_RDONLY);
   try{
    const lock=spawnSync('/usr/bin/flock',['--exclusive','--nonblock','3'],{stdio:['ignore','ignore','ignore',previous.fd]}).status;
    if(lock===0){
     // No live reader. A process may have died mid-checkout or mid-permission change.
     await removeSimpleWorktree(repo,path);
     exists=undefined;
    }else if(lock!==1)throw Error('WORKTREE_LOCK_FAILED');
   }finally{await previous.close();}
  }
  if(!exists){
   await addSimpleWorktree(repo,commit,path);
   try{
    if(suppressed.length)await stripScannerSuppressions(path);
    await readableCheckout(path);
   }catch(error){await removeSimpleWorktree(repo,path);throw error;}
  }
  if(await realpath(path)!==path)throw Error('NON_CANONICAL_WORKTREE');
  const handle=await open(path,constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_RDONLY);
  if(spawnSync('/usr/bin/flock',['--shared','--nonblock','3'],{stdio:['ignore','ignore','ignore',handle.fd]}).status!==0){
   await handle.close();throw Error('WORKTREE_LOCK_FAILED');
  }
  return handle;
 },600);
 let released=false;
 return {path,suppressed,release:()=>withInstallationImageLock(root,false,async()=>{
  if(released)return;
  // Upgrade the open file description. A competing shared lock belongs to
  // another reader, whose release then performs the removal.
  const status=spawnSync('/usr/bin/flock',['--exclusive','--nonblock','3'],{stdio:['ignore','ignore','ignore',reader.fd]}).status;
  try{
   if(status===0)await removeSimpleWorktree(repo,path);
   else if(status!==1)throw Error('WORKTREE_LOCK_FAILED');
  }finally{released=true;await reader.close();}
 },600)};
}

/** Reap a detached checkout left by a killed reader. Other processes' live
 * leases use the same directory inode and prevent removal. */
export async function releaseIdleSharedWorktrees(dataDirectory:string,repo:string,apply:boolean,commit?:string){
 const root=join(dataDirectory,'native','shared-worktrees');
 const listed=await readdir(root).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e;});
 if(!listed.length)return [];
 const repository=await realpath(repo).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
 if(!repository)return [];
 const prefix=createHash('sha256').update(repository).digest('hex')+'-';
 return withInstallationImageLock(root,false,async()=>{
  const lines:string[]=[];
  for(const name of listed){
   if(!name.startsWith(prefix)||!/^([a-f0-9]{40})(-security)?$/.test(name.slice(prefix.length))||commit&&!name.startsWith(prefix+commit))continue;
   const path=join(root,name);
   const dir=await open(path,constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_RDONLY).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
   if(!dir)continue;
   try{
    const locked=spawnSync('/usr/bin/flock',['--exclusive','--nonblock','3'],{stdio:['ignore','ignore','ignore',dir.fd]}).status;
    if(locked===1)continue;
    if(locked!==0)throw Error('WORKTREE_LOCK_FAILED');
    if(apply)await removeSimpleWorktree(repo,path);
    lines.push((apply?'Worktree compartilhado removido ':'Worktree compartilhado elegível ')+path);
   }finally{await dir.close();}
  }
  return lines;
 },600);
}
