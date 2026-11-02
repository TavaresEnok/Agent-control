import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {chmod,lstat,mkdir,mkdtemp,realpath,rename,rm,statfs,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {z} from 'zod';
import {Id,Refusal} from './contracts.ts';

export const GitObjectId=z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const GitExportRequest=z.object({operationId:Id,intentId:Id,contextId:Id,hostId:Id,commit:GitObjectId,tree:GitObjectId}).strict()
 .refine(v=>v.commit.length===v.tree.length);
export const GitExportReply=z.object({schemaVersion:z.literal(1),operationId:Id,projectId:Id,commit:GitObjectId,tree:GitObjectId,
 bundleSha256:z.string().regex(/^[a-f0-9]{64}$/),bundle:z.string().max(87384).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)}).strict();
export function verifyGitExport(raw:unknown,expected:{operationId:string;projectId:string;commit:string;tree:string}){
 const reply=GitExportReply.parse(raw);
 if(reply.operationId!==expected.operationId||reply.projectId!==expected.projectId||reply.commit!==expected.commit||reply.tree!==expected.tree)
  throw new Refusal('REMOTE_GIT_IDENTITY_MISMATCH');
 const bundle=Buffer.from(reply.bundle,'base64');
 if(bundle.length>65536||createHash('sha256').update(bundle).digest('hex')!==reply.bundleSha256)throw new Refusal('REMOTE_GIT_BUNDLE_MISMATCH');
 return {bundle,sha256:reply.bundleSha256};
}
/** Metadata describes a read-only source, not review or intent-payload approval. */
export function sourceSnapshot(row:unknown,expected:{operationId:string;contextId:string;intentId:string;hostId:string;projectId:string;commit:string;tree:string;requestDigest:string;bundleSha256:string}){
 const saved=z.object({id:Id,context_id:Id,intent_id:Id,host_id:Id,request_digest:z.string(),task_id:z.literal('git-export'),
  state:z.literal('completed'),remote_receipt:z.object({commit:GitObjectId,tree:GitObjectId,bundleSha256:z.string().regex(/^[a-f0-9]{64}$/)}).passthrough()}).passthrough().safeParse(row);
 if(!saved.success)throw new Refusal('REMOTE_GIT_REPLAY_MISMATCH');
 const value=saved.data,receipt=value.remote_receipt;
 if(value.id!==expected.operationId||value.context_id!==expected.contextId||value.intent_id!==expected.intentId||value.host_id!==expected.hostId||
  value.request_digest!==expected.requestDigest||receipt.commit!==expected.commit||receipt.tree!==expected.tree||receipt.bundleSha256!==expected.bundleSha256)
  throw new Refusal('REMOTE_GIT_REPLAY_MISMATCH');
 return {schemaVersion:1 as const,kind:'source_snapshot' as const,reviewStatus:'not_reviewed' as const,...expected};
}
function git(args:string[]):Promise<string>{return new Promise((resolvePromise,reject)=>{
 const child=spawn('/usr/bin/python3',[new URL('../services/remote-git/limited_git.py',import.meta.url).pathname,...args],{env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0'},stdio:['ignore','pipe','ignore'],detached:true});
 const kill=()=>{try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
 let output='';const timer=setTimeout(kill,15000);
 child.stdout.on('data',chunk=>{output+=String(chunk);if(output.length>65536)kill();});
 child.on('error',()=>{clearTimeout(timer);reject(new Refusal('REMOTE_GIT_MATERIALIZATION_FAILED'));});
 child.on('close',code=>{clearTimeout(timer);code===0?resolvePromise(output.trim()):reject(new Refusal('REMOTE_GIT_MATERIALIZATION_FAILED'));});
 });}
/** Destination is controller configuration; operationId selects a fresh bare repo. */
export class RemoteGitMaterializer{
 constructor(private readonly root:string){}
 async materialize(operationId:string,commit:string,tree:string,bundle:Buffer){
  Id.parse(operationId);GitObjectId.parse(commit);GitObjectId.parse(tree);
  if(commit.length!==tree.length||bundle.length>65536)throw new Refusal('REMOTE_GIT_BUNDLE_MISMATCH');
  const root=resolve(this.root),info=await lstat(root),filesystem=await statfs(root);
  if(!info.isDirectory()||info.isSymbolicLink()||await realpath(root)!==root||info.uid!==process.getuid?.()||(info.mode&0o077)!==0||
   filesystem.type!==0x01021994||Number(filesystem.blocks)*Number(filesystem.bsize)>128*1024*1024)throw new Refusal('REMOTE_GIT_ROOT_UNSAFE');
  const destination=join(root,operationId),lock=join(root,'.'+operationId+'.lock');
  try{await mkdir(lock,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Refusal('REMOTE_GIT_OPERATION_BUSY');throw error;}
  let temporary:string|undefined;
  try{
   let existing=false;
   try{const entry=await lstat(destination);if(!entry.isDirectory()||entry.isSymbolicLink()||entry.uid!==info.uid||(entry.mode&0o077)!==0||await realpath(destination)!==destination)throw new Refusal('REMOTE_GIT_DESTINATION_UNSAFE');existing=true;}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   if(existing){
    if(await git(['-C',destination,'rev-parse','refs/heads/agent-control-export^{commit}'])!==commit||await git(['-C',destination,'rev-parse',commit+'^{tree}'])!==tree)throw new Refusal('REMOTE_GIT_IDENTITY_MISMATCH');
    return {repository:destination,commit,tree};
   }
   temporary=await mkdtemp(join(root,'.remote-git-'));
   const repo=join(temporary,'repo'),file=join(temporary,'input.bundle');await writeFile(file,bundle,{mode:0o600});
   await git(['init','--bare',...(commit.length===64?['--object-format=sha256']:[]),repo]);
   await git(['-C',repo,'bundle','verify',file]);
   await git(['-C',repo,'fetch','--no-tags',file,'refs/heads/agent-control-export:refs/heads/agent-control-export']);
   if(await git(['-C',repo,'rev-parse','refs/heads/agent-control-export^{commit}'])!==commit||await git(['-C',repo,'rev-parse',commit+'^{tree}'])!==tree)
    throw new Refusal('REMOTE_GIT_IDENTITY_MISMATCH');
   // The private root and per-operation lock exclude other publishers.
   await chmod(repo,0o700);await rename(repo,destination);
   return {repository:destination,commit,tree};
  }finally{if(temporary)await rm(temporary,{recursive:true,force:true});await rm(lock,{recursive:true,force:true});}
 }
}
