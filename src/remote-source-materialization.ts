import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {requireRecoveryInventory} from './recovery-inventory.ts';
import {constants} from 'node:fs';
import {lstat,mkdir,open,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve,sep} from 'node:path';
import {promisify} from 'node:util';
import type pg from 'pg';
import {z} from 'zod';
import {digest,Id,Refusal} from './contracts.ts';
import {GitObjectId,RemoteGitMaterializer} from './remote-git.ts';
import {requireRemoteSource} from './remote-source-authorizations.ts';
import {projectRepositoryIdentity} from './project-repository.ts';
import type {ProjectAdmin,ProjectRoot} from './project-admin.ts';

const BundleText=z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).max(90000);
/** The request names an exported snapshot. The directory is derived from the project, never from the caller. */
export const RemoteSourceMaterializationPayload=z.object({
 projectId:Id,contextId:Id,operationId:Id,hostId:Id,commit:GitObjectId,tree:GitObjectId,bundle:BundleText,
}).strict().refine(value=>value.commit.length===value.tree.length);
export type RemoteSourceMaterializationPayload=z.infer<typeof RemoteSourceMaterializationPayload>;
type Command={schemaVersion:1;intentId:string;deliveryAttemptId:string;action:'project.materializeRemoteSource';payload:RemoteSourceMaterializationPayload};
const gitEnv={PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'};
const git=(args:string[])=>promisify(execFile)('git',args,{encoding:'utf8',timeout:15000,env:gitEnv}).then(result=>result.stdout.trim());
type Owner={intentId:string;pid:number;token:string};

function alive(pid:number){
 if(!Number.isInteger(pid)||pid<=0)return false;
 try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code==='EPERM';}
}
function parseOwner(raw:string):Owner|undefined{
 try{
  const value=JSON.parse(raw) as {intentId?:unknown;pid?:unknown;token?:unknown};
  if(typeof value.intentId!=='string'||!Number.isInteger(value.pid)||Number(value.pid)<=0||typeof value.token!=='string'||value.token.length<16)return undefined;
  return {intentId:value.intentId,pid:Number(value.pid),token:value.token};
 }catch{return undefined;}
}
/** Lexicographically first configured root. The signed request cannot choose a path. */
export function derivedMaterializationRoot(roots:readonly ProjectRoot[]){
 const root=[...roots].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)[0];
 if(!root)throw new Refusal('PROJECT_ROOT_FORBIDDEN',403);
 return root;
}
export function derivedMaterializationRelative(projectId:string){
 Id.parse(projectId);
 return `remote-sources/${projectId}`;
}

async function assertUsableRoot(root:ProjectRoot){
 if(resolve(root.path)!==root.path||await realpath(root.path)!==root.path)throw new Refusal('PROJECT_ROOT_UNAVAILABLE');
 const info=await lstat(root.path),uid=process.getuid?.();
 if(uid===undefined||info.uid!==uid||(info.mode&0o022)!==0||!info.isDirectory()||info.isSymbolicLink())throw new Refusal('PROJECT_ROOT_UNAVAILABLE');
 return uid;
}
/** lstat only. A symlink, a foreign owner, or group/other write is refused with no chmod and no delete. */
async function classify(path:string,uid:number):Promise<'ok'|'missing'>{
 let info;
 try{info=await lstat(path);}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 'missing';throw error;}
 if(info.isSymbolicLink()||!info.isDirectory()||info.uid!==uid||(info.mode&0o022)!==0)throw new Refusal('PROJECT_PATH_FORBIDDEN',403);
 let canonical:string;
 try{canonical=await realpath(path);}catch{throw new Refusal('PROJECT_PATH_FORBIDDEN',403);}
 if(canonical!==path)throw new Refusal('PROJECT_PATH_FORBIDDEN',403);
 return 'ok';
}
/**
 * Inspect every lock, staging, and publication component before any rm, write, clone, chmod, or rename.
 * Missing parents are created non-recursively. Existing insecure directories are left unchanged.
 */
async function secureLayout(root:string,uid:number,projectId:string,intentId:string){
 const parents:{path:string;mode:number}[]=[
  {path:join(root,'.remote-source-locks'),mode:0o700},
  {path:join(root,'.remote-source-staging'),mode:0o700},
  {path:join(root,'remote-sources'),mode:0o755},
 ];
 const leaves=[
  join(root,'.remote-source-locks',projectId),
  join(root,'.remote-source-staging',intentId),
  join(root,'remote-sources',projectId),
 ];
 const missing:typeof parents=[];
 for(const parent of parents){
  if(await classify(parent.path,uid)==='missing')missing.push(parent);
 }
 for(const leaf of leaves)await classify(leaf,uid);
 for(const parent of missing){
  try{await mkdir(parent.path,{mode:parent.mode});}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  if(await classify(parent.path,uid)!=='ok')throw new Refusal('PROJECT_PATH_FORBIDDEN',403);
 }
}
function conflictsPrivate(privateDirectory:string,candidate:string){
 const privatePath=resolve(privateDirectory);
 return privatePath!==privateDirectory||candidate===privatePath||candidate.startsWith(privatePath+sep)||privatePath.startsWith(candidate+sep);
}
async function publishedState(destination:string,commit:string,tree:string):Promise<'missing'|'match'|'conflict'> {
 try{const info=await lstat(destination);if(info.isSymbolicLink()||!info.isDirectory())return 'conflict';}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 'missing';throw error;}
 try{
  if(await git(['-C',destination,'rev-parse','HEAD'])!==commit||await git(['-C',destination,'rev-parse','HEAD^{tree}'])!==tree)return 'conflict';
  if((await git(['-C',destination,'status','--porcelain']))!=='')return 'conflict';
  return 'match';
 }catch{return 'conflict';}
}
async function publishedOwner(directory:string,uid:number):Promise<Owner|'missing'|'invalid'>{
 const ownerPath=join(directory,'owner');
 let info;
 try{info=await lstat(ownerPath);}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 'missing';throw error;}
 if(info.isSymbolicLink()||!info.isFile()||info.uid!==uid||(info.mode&0o022)!==0)throw new Refusal('PROJECT_PATH_FORBIDDEN',403);
 return parseOwner(await readFile(ownerPath,'utf8'))??'invalid';
}
/** Remove a directory only after its parent and itself have been classified as real and owned. */
async function removeSecureDirectory(path:string,uid:number){
 if(await classify(dirname(path),uid)!=='ok'||await classify(path,uid)==='missing'){
  if(await classify(dirname(path),uid)!=='ok')throw new Refusal('PROJECT_PATH_FORBIDDEN',403);
  return;
 }
 await rm(path,{recursive:true,force:true});
}
async function claimLockDirectory(directory:string,uid:number,intentId:string){
 const token=randomUUID();
 if(await classify(directory,uid)==='ok'){
  const owner=await publishedOwner(directory,uid);
  if(owner!=='missing'&&owner!=='invalid'&&(owner.intentId!==intentId||alive(owner.pid)))throw new Refusal('REMOTE_SOURCE_MATERIALIZATION_BUSY');
  await removeSecureDirectory(directory,uid);
 }
 if(await classify(dirname(directory),uid)!=='ok')throw new Refusal('PROJECT_PATH_FORBIDDEN',403);
 try{await mkdir(directory,{mode:0o700});}
 catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Refusal('PROJECT_PATH_FORBIDDEN',403);throw error;}
 if(await classify(directory,uid)!=='ok')throw new Refusal('PROJECT_PATH_FORBIDDEN',403);
 const body=JSON.stringify({intentId,pid:process.pid,token});
 const ownerPath=join(directory,'owner'),temporary=join(directory,`.owner-${token}`);
 try{
  await writeFile(temporary,body,{mode:0o600,flag:'wx'});
  await rename(temporary,ownerPath);
  const info=await lstat(ownerPath);
  if(info.isSymbolicLink()||!info.isFile()||await readFile(ownerPath,'utf8')!==body)throw new Refusal('REMOTE_SOURCE_MATERIALIZATION_BUSY');
 }catch(error){
  await removeSecureDirectory(directory,uid).catch(()=>{});
  throw error;
 }
 return token;
}
/**
 * Session advisory lock is the atomic exclusion. PostgreSQL drops it when the session dies, including SIGKILL.
 * The owner file is published by rename. Only the matching token deletes the lock directory.
 * A missing or truncated owner is an interrupted create and is rebuilt under this lock.
 * A dead pid for the same intent can be resumed. Any other intent stays busy and keeps its owner file.
 */
async function acquireProjectLock(pool:pg.Pool,root:string,uid:number,projectId:string,intentId:string){
 const directory=join(root,'.remote-source-locks',projectId),ownerPath=join(directory,'owner');
 const client=await pool.connect();
 let held=false,token:string|undefined,settled=false;
 const release=async()=>{
  if(settled)return;
  settled=true;
  try{
   if(token){
    try{
     const dirInfo=await lstat(directory);
     if(!dirInfo.isSymbolicLink()&&dirInfo.isDirectory()&&dirInfo.uid===uid&&(dirInfo.mode&0o022)===0&&await realpath(directory)===directory){
      const info=await lstat(ownerPath);
      if(!info.isSymbolicLink()&&info.isFile()&&parseOwner(await readFile(ownerPath,'utf8'))?.token===token)await rm(directory,{recursive:true,force:true});
     }
    }catch{/* a refused path stays; the session lock still drops */}
   }
  }finally{
   try{if(held)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,59))',[projectId]);}finally{client.release();}
  }
 };
 try{
  const locked=await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,59)) AS ok',[projectId]);
  const acquired=locked.rows[0]?.ok;
  if(acquired!==true&&acquired!=='t')throw new Refusal('REMOTE_SOURCE_MATERIALIZATION_BUSY');
  held=true;
  token=await claimLockDirectory(directory,uid,intentId);
  return release;
 }catch(error){await release();throw error;}
}
async function tmpfsRoot(configured:string|undefined){
 const requested=configured??'/dev/shm/agent-control-remote-source',parent=dirname(requested),uid=process.getuid?.();
 const parentInfo=await lstat(parent);
 if(uid===undefined||parentInfo.isSymbolicLink()||!parentInfo.isDirectory()||await realpath(parent)!==parent)throw new Refusal('REMOTE_GIT_ROOT_UNSAFE');
 try{await lstat(requested);}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await mkdir(requested,{mode:0o700});}
 const info=await lstat(requested);
 if(info.isSymbolicLink()||!info.isDirectory()||info.uid!==uid||(info.mode&0o077)!==0||await realpath(requested)!==requested)throw new Refusal('REMOTE_GIT_ROOT_UNSAFE');
 return requested;
}
async function fchmodDirectory(path:string,mode:number){
 let handle;
 try{handle=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);}
 catch(error){
  const code=(error as NodeJS.ErrnoException).code;
  if(code==='ELOOP'||code==='ENOTDIR')throw new Refusal('PROJECT_PATH_FORBIDDEN',403);
  throw error;
 }
 try{await handle.chmod(mode);}finally{await handle.close();}
}

type Loaded={sha256:string;authorizationId:string};
async function loadAuthorized(c:pg.PoolClient,principal:string,payload:RemoteSourceMaterializationPayload,bundle:Buffer):Promise<Loaded>{
 if(!(await c.query("SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner'",[payload.projectId,principal])).rowCount)
  throw new Refusal('PROJECT_OWNER_REQUIRED',403);
 const context=(await c.query('SELECT project_id FROM ac_contexts WHERE id=$1 AND NOT archived',[payload.contextId])).rows[0];
 const operation=(await c.query('SELECT * FROM ac_remote_operations WHERE id=$1',[payload.operationId])).rows[0];
 const receipt=operation?.remote_receipt??{};
 const sha256=createHash('sha256').update(bundle).digest('hex');
 if(!context||!operation||operation.task_id!=='git-export'||operation.state!=='completed'||operation.context_id!==payload.contextId||operation.host_id!==payload.hostId||
  context.project_id!==payload.projectId||receipt.commit!==payload.commit||receipt.tree!==payload.tree||receipt.bundleSha256!==sha256||
  operation.request_digest!==digest({action:'git-export',operationId:payload.operationId,intentId:operation.intent_id,contextId:payload.contextId,hostId:payload.hostId,commit:payload.commit,tree:payload.tree}))
  throw new Refusal('REMOTE_SOURCE_IDENTITY_MISMATCH');
 const host=(await c.query('SELECT project_id FROM ac_remote_hosts WHERE id=$1 AND project_id=$2',[payload.hostId,payload.projectId])).rows[0];
 if(!host)throw new Refusal('REMOTE_SOURCE_IDENTITY_MISMATCH');
 const authorization=await requireRemoteSource(c,{contextId:payload.contextId,projectId:payload.projectId,intentId:operation.intent_id,hostId:payload.hostId,commit:payload.commit,tree:payload.tree});
 return {sha256,authorizationId:authorization.authorizationId};
}

async function checkout(bare:string,staging:string,commit:string,tree:string,uid:number){
 await removeSecureDirectory(staging,uid);
 if(await classify(dirname(staging),uid)!=='ok')throw new Refusal('PROJECT_PATH_FORBIDDEN',403);
 try{
  await git(['clone','--no-hardlinks','-b','agent-control-export',bare,staging]);
  if(await git(['-C',staging,'rev-parse','HEAD'])!==commit||await git(['-C',staging,'rev-parse','HEAD^{tree}'])!==tree)throw new Refusal('REMOTE_GIT_IDENTITY_MISMATCH');
  await fchmodDirectory(staging,0o700);
  await fchmodDirectory(join(staging,'.git'),0o700);
 }catch(error){
  await removeSecureDirectory(staging,uid).catch(()=>{});
  if(error instanceof Refusal)throw error;
  throw new Refusal('REMOTE_GIT_MATERIALIZATION_FAILED');
 }
}
async function publishTree(staging:string,destination:string,uid:number,commit:string,tree:string){
 if(await classify(dirname(destination),uid)!=='ok'||await classify(staging,uid)!=='ok')throw new Refusal('PROJECT_PATH_FORBIDDEN',403);
 const existing=await classify(destination,uid);
 if(existing==='ok'){
  await removeSecureDirectory(staging,uid);
  if(await publishedState(destination,commit,tree)!=='match')throw new Refusal('REMOTE_SOURCE_DESTINATION_CONFLICT');
  return;
 }
 try{await rename(staging,destination);}
 catch(error){
  await removeSecureDirectory(staging,uid).catch(()=>{});
  if((error as NodeJS.ErrnoException).code!=='EEXIST'&&(error as NodeJS.ErrnoException).code!=='ENOTEMPTY')throw error;
  if(await classify(destination,uid)!=='ok'||await publishedState(destination,commit,tree)!=='match')throw new Refusal('REMOTE_SOURCE_DESTINATION_CONFLICT');
 }
}

/**
 * The working tree is published before the database transaction.
 * Repository, identity, and provenance commit together. A retry of the same intent
 * adopts a tree with the same commit and does not replace a different one.
 * Lock exclusion is the session advisory lock. Its owner token is the only deleter.
 * Process death releases the advisory lock without a finally; the same intent can resume.
 */
export async function materializeRemoteProjectSource(admin:ProjectAdmin,principal:string,command:Command,hash:string,
 authorize:(c:pg.PoolClient)=>Promise<void>,delivery:(c:pg.PoolClient)=>Promise<void>){
 const payload=command.payload,bundle=Buffer.from(payload.bundle,'base64');
 const root=derivedMaterializationRoot(admin.roots);
 const relative=derivedMaterializationRelative(payload.projectId);
 const destination=join(root.path,relative);
 const staging=join(root.path,'.remote-source-staging',command.intentId);
 if(conflictsPrivate(admin.privateDirectory,destination)||conflictsPrivate(admin.privateDirectory,staging))throw new Refusal('PROJECT_PRIVATE_DIRECTORY_CONFLICT',403);
 await admin.ledger.tx(async c=>{
  await authorize(c);
  if(await requireRecoveryInventory(c,admin.ledger))throw new Refusal('RECOVERY_EFFECT_NOT_INSTRUMENTED');
  if(bundle.length>65536)throw new Refusal('REMOTE_SOURCE_BUNDLE_TOO_LARGE');
  await loadAuthorized(c,principal,payload,bundle);
  if((await c.query(`SELECT 1 FROM ac_project_repositories WHERE project_id=$1 UNION ALL SELECT 1 FROM ac_project_repository_identity WHERE project_id=$1`,[payload.projectId])).rowCount)
   throw new Refusal('PROJECT_REPOSITORY_ALREADY_BOUND');
 });
 const uid=await assertUsableRoot(root);
 await secureLayout(root.path,uid,payload.projectId,command.intentId);
 let state=await publishedState(destination,payload.commit,payload.tree);
 if(state==='conflict')throw new Refusal('REMOTE_SOURCE_DESTINATION_CONFLICT');
 const release=await acquireProjectLock(admin.ledger.pool,root.path,uid,payload.projectId,command.intentId);
 try{
  state=await publishedState(destination,payload.commit,payload.tree);
  if(state==='conflict')throw new Refusal('REMOTE_SOURCE_DESTINATION_CONFLICT');
  if(state==='missing'){
   const scratch=await tmpfsRoot(admin.options.remoteSourceTmpfs);
   const bare=await new RemoteGitMaterializer(scratch).materialize(payload.operationId,payload.commit,payload.tree,bundle);
   await checkout(bare.repository,staging,payload.commit,payload.tree,uid);
   await publishTree(staging,destination,uid,payload.commit,payload.tree);
  }
  const checked=await bindable(root,relative,destination);
  if(JSON.stringify(checked)!==JSON.stringify(await projectRepositoryIdentity(destination)))throw new Refusal('PROJECT_REPOSITORY_UNAVAILABLE');
  if(admin.options.beforeRemoteSourceRegister)await admin.options.beforeRemoteSourceRegister();
  return await admin.ledger.tx(async c=>{
   await authorize(c);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,2))',[command.intentId]);
   await c.query('SELECT pg_advisory_xact_lock(189234,37)');
   const prior=(await c.query('SELECT payload_digest,result FROM ac_project_admin_intents WHERE id=$1',[command.intentId])).rows[0];
   if(prior){if(prior.payload_digest!==hash)throw new Refusal('PROJECT_ADMIN_INTENT_CONFLICT');await delivery(c);return prior.result;}
   if(!(await c.query('SELECT enabled FROM ac_admission_control WHERE id=1 FOR SHARE')).rows[0]?.enabled)throw new Refusal('ADMISSION_CLOSED');
   const loaded=await loadAuthorized(c,principal,payload,bundle);
   if((await c.query(`SELECT 1 FROM ac_project_repositories WHERE project_id=$1 UNION ALL SELECT 1 FROM ac_project_repository_identity WHERE project_id=$1`,[payload.projectId])).rowCount)
    throw new Refusal('PROJECT_REPOSITORY_ALREADY_BOUND');
   if((await c.query('SELECT 1 FROM ac_project_repositories WHERE repo=$1 AND project_id<>$2',[destination,payload.projectId])).rowCount)throw new Refusal('INSTALLATION_PROJECT_CONFLICT');
   if(await publishedState(destination,payload.commit,payload.tree)!=='match')throw new Refusal('REMOTE_SOURCE_DESTINATION_CONFLICT');
   await c.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[payload.projectId,destination]);
   await c.query('INSERT INTO ac_project_repository_identity(project_id,repo_dev,repo_ino,git_dev,git_ino,root_id,root_path,relative_path) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [payload.projectId,checked.repoDev,checked.repoIno,checked.gitDev,checked.gitIno,root.id,root.path,relative]);
   const result={state:'applied' as const,projectId:payload.projectId,hostId:payload.hostId,operationId:payload.operationId,commit:payload.commit,tree:payload.tree,reviewStatus:'not_reviewed' as const,source:'ssh' as const};
   await c.query('INSERT INTO ac_project_admin_intents(id,principal_id,payload_digest,action,result) VALUES($1,$2,$3,$4,$5)',[command.intentId,principal,hash,command.action,result]);
   await c.query(`INSERT INTO ac_remote_source_materializations(id,project_id,context_id,host_id,operation_id,commit_id,tree_id,bundle_sha256,authorization_id,principal_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[command.intentId,payload.projectId,payload.contextId,payload.hostId,payload.operationId,payload.commit,payload.tree,loaded.sha256,loaded.authorizationId,principal]);
   await delivery(c);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'project.remote_source.materialized',$2)",[payload.contextId,{projectId:payload.projectId,principal,hostId:payload.hostId,operationId:payload.operationId,commit:payload.commit,tree:payload.tree,bundleSha256:loaded.sha256,authorizationId:loaded.authorizationId,intentId:command.intentId,reviewStatus:'not_reviewed'}]);
   return result;
  });
 }finally{await release();}
}

async function bindable(root:ProjectRoot,relative:string,destination:string){
 const uid=await assertUsableRoot(root);
 let target=root.path;
 for(const component of relative.split('/')){
  target=join(target,component);
  if(await classify(target,uid)!=='ok')throw new Refusal('PROJECT_PATH_FORBIDDEN',403);
 }
 const canonical=await realpath(target);
 if(canonical!==destination||canonical!==target||!canonical.startsWith(root.path+sep))throw new Refusal('PROJECT_PATH_FORBIDDEN',403);
 const identity=await projectRepositoryIdentity(canonical);
 if((await git(['--no-optional-locks','-C',canonical,'rev-parse','--show-toplevel']))!==canonical)throw new Refusal('PROJECT_REPOSITORY_ROOT_REQUIRED');
 return identity;
}
