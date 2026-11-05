import {lstat,realpath} from 'node:fs/promises';
import {join,relative,resolve,sep} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import type pg from 'pg';
import {Id,Refusal,digest} from './contracts.ts';
import type {Ledger} from './ledger.ts';
import {Operators,type OperatorProof} from './operator.ts';
import {projectRepositoryIdentity,validateTrustedProjectPath} from './project-repository.ts';

const Key=z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
const Label=z.string().min(1).max(100).refine(v=>v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v));
const Directory=z.string().min(1).max(256).refine(v=>!v.startsWith('/')&&!v.includes('\\')&&!/[\x00-\x1f\x7f]/.test(v)&&v.split('/').every(p=>p!==''&&p!=='.'&&p!=='..'&&p!=='.git'&&p!=='.ai'));
const Branch=z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/).refine(v=>!v.includes('..')&&!v.includes('//')&&!v.endsWith('/')&&!v.endsWith('.')&&!v.endsWith('.lock'));
const Purpose=z.enum(['remote-development','remote-return']);
const Destination=z.discriminatedUnion('kind',[
 z.object({id:Key,label:Label,kind:z.literal('local_repository')}).strict(),
 z.object({id:Key,label:Label,kind:z.literal('remote'),hostId:Id,allowedPurposes:z.array(Purpose).min(1).max(2).refine(v=>new Set(v).size===v.length)}).strict(),
]);
export const ProjectEnvironmentConfig=z.object({sourceBranch:Branch,environments:z.array(z.object({id:Key,label:Label,targetRef:Branch,
 authorizedDirectories:z.array(Directory).min(1).max(32).refine(v=>new Set(v).size===v.length),destinations:z.array(Destination).min(1).max(16).refine(v=>new Set(v.map(d=>d.id)).size===v.length)}).strict()).min(1).max(8)}).strict().superRefine((v,ctx)=>{
 if(new Set(v.environments.map(e=>e.id)).size!==v.environments.length||new Set(v.environments.map(e=>e.targetRef)).size!==v.environments.length)ctx.addIssue({code:'custom',message:'Environment identities and target refs must be unique'});
});
export type ProjectEnvironmentConfig=z.infer<typeof ProjectEnvironmentConfig>;
export const ProjectEnvironmentCommand=z.object({schemaVersion:z.literal(1),intentId:Id,deliveryAttemptId:Id,action:z.literal('project.environments.configure'),
 payload:z.object({projectId:Id,expectedRevision:z.number().int().min(0).max(2147483646),config:ProjectEnvironmentConfig}).strict()}).strict();
export type EnvironmentFilesystem={repo:string;root:{id:string;path:string;relative:string};repository:Awaited<ReturnType<typeof projectRepositoryIdentity>>;directories:{path:string;dev:string;ino:string}[];remoteHosts:{id:string;fingerprint:string;registrationDigest:string}[]};
const exec=promisify(execFile);
async function git(repo:string,args:string[]){
 const r=await exec('/usr/bin/git',['--no-optional-locks','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',repo,...args],{timeout:5000,maxBuffer:200000,
  env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0'}});return r.stdout.trim();
}
async function branchCommit(repo:string,branch:string){
 Branch.parse(branch);try{await git(repo,['check-ref-format',branch]);const value=await git(repo,['rev-parse','--verify','--end-of-options',branch+'^{commit}']);if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))throw Error('invalid');return value;}
 catch{throw new Refusal('PROJECT_ENVIRONMENT_BRANCH_UNAVAILABLE',409);}
}
async function checkFilesystem(fs:EnvironmentFilesystem){
 try{
  if(await validateTrustedProjectPath(fs.root.path,fs.root.relative)!==fs.repo||await realpath(fs.repo)!==fs.repo||digest(await projectRepositoryIdentity(fs.repo))!==digest(fs.repository))throw Error('repository changed');
  for(const directory of fs.directories){const path=await validateTrustedProjectPath(fs.repo,directory.path),s=await lstat(path,{bigint:true});if(String(s.dev)!==directory.dev||String(s.ino)!==directory.ino)throw Error('directory changed');}
 }catch{throw new Refusal('PROJECT_ENVIRONMENT_FILESYSTEM_CHANGED',409);}
}
export const environmentRefusal=(error:unknown):Refusal|null=>{
 const codes=['PROJECT_ENVIRONMENT_TARGET_FORBIDDEN','PROJECT_ENVIRONMENT_WRITE_SCOPE_REQUIRED','PROJECT_ENVIRONMENT_DIRECTORY_FORBIDDEN','PROJECT_ENVIRONMENT_BINDING_REQUIRED','PROJECT_ENVIRONMENT_DESTINATION_FORBIDDEN'];
 return error&&typeof error==='object'&&'message'in error&&typeof error.message==='string'&&codes.includes(error.message)?new Refusal(error.message,403):null;
};

export class ProjectEnvironments{
 constructor(readonly ledger:Ledger,readonly roots:readonly {id:string;path:string}[],readonly privateDirectory:string){}
 private async authorize(c:pg.PoolClient,principal:string,projectId:string,write=false){
  const row=(await c.query('SELECT role FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 FOR SHARE',[projectId,principal])).rows[0];
  if(!row||(write&&row.role!=='owner'))throw new Refusal('PROJECT_ENVIRONMENT_FORBIDDEN',403);
 }
 async view(principal:string,projectId:string){
  Id.parse(projectId);return this.ledger.tx(async c=>{await this.authorize(c,principal,projectId);
   const head=(await c.query(`SELECT r.revision,r.snapshot FROM ac_project_environment_heads h JOIN ac_project_environment_revisions r USING(project_id,revision) WHERE h.project_id=$1`,[projectId])).rows[0];
   const role=(await c.query('SELECT role FROM ac_memberships WHERE project_id=$1 AND principal_id=$2',[projectId,principal])).rows[0].role;
   const hosts=(await c.query('SELECT id,label,allowed_tasks FROM ac_remote_hosts WHERE project_id=$1 AND enabled ORDER BY label,id',[projectId])).rows.map(host=>({id:host.id,label:host.label,allowedPurposes:([...(host.allowed_tasks.includes('git-workspace')?['remote-development']:[]),...(host.allowed_tasks.includes('git-return')?['remote-return']:[])] as ('remote-development'|'remote-return')[])})).filter(host=>host.allowedPurposes.length);
   return {projectId,revision:head?.revision??0,config:head?.snapshot??null,canConfigure:role==='owner',remoteHosts:hosts,pathScope:'existing_repository_relative_directories' as const};
  });
 }
 async configure(principal:string,raw:unknown,proof:OperatorProof){
  const command=ProjectEnvironmentCommand.parse(raw),{projectId,expectedRevision,config}=command.payload;
  const {deliveryAttemptId,...semantic}=command,hash=digest({principal,...semantic});
  const authenticate=async(c:pg.PoolClient)=>{await this.authorize(c,principal,projectId,true);await new Operators(this.ledger).verify(c,principal,command,proof);};
  const replay=async(c:pg.PoolClient)=>{
   const prior=(await c.query('SELECT principal_id,payload_digest,result FROM ac_project_environment_intents WHERE id=$1',[command.intentId])).rows[0];
   if(prior&&(prior.principal_id!==principal||prior.payload_digest!==hash))throw new Refusal('PROJECT_ENVIRONMENT_INTENT_CONFLICT',409);
   return prior?.result;
  };
  const delivery=async(c:pg.PoolClient)=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,79))',[deliveryAttemptId]);
   const prior=(await c.query('SELECT intent_id FROM ac_project_environment_deliveries WHERE id=$1',[deliveryAttemptId])).rows[0];
   if(prior&&prior.intent_id!==command.intentId)throw new Refusal('PROJECT_ENVIRONMENT_DELIVERY_CONFLICT',409);
   if(!prior)await c.query('INSERT INTO ac_project_environment_deliveries VALUES($1,$2)',[deliveryAttemptId,command.intentId]);
  };
  const prior=await this.ledger.tx(async c=>{await authenticate(c);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,78))',[command.intentId]);const saved=await replay(c);if(saved)await delivery(c);return saved;});
  if(prior)return prior;
  const registered=(await this.ledger.pool.query('SELECT repo FROM ac_project_repositories WHERE project_id=$1',[projectId])).rows[0];
  if(!registered)throw new Refusal('PROJECT_ENVIRONMENT_REPOSITORY_REQUIRED',409);
  const repo=registered.repo as string,root=this.roots.find(r=>repo.startsWith(r.path+sep));
  if(!root||resolve(root.path)!==root.path)throw new Refusal('PROJECT_ENVIRONMENT_ROOT_FORBIDDEN',403);
  const privatePath=resolve(this.privateDirectory);if(privatePath!==this.privateDirectory||repo===privatePath||repo.startsWith(privatePath+sep)||privatePath.startsWith(repo+sep))throw new Refusal('PROJECT_ENVIRONMENT_PRIVATE_DIRECTORY_CONFLICT',403);
  let repository:Awaited<ReturnType<typeof projectRepositoryIdentity>>;try{repository=await projectRepositoryIdentity(repo);}catch{throw new Refusal('PROJECT_ENVIRONMENT_REPOSITORY_UNAVAILABLE',409);}
  const filesystem:EnvironmentFilesystem={repo,root:{id:root.id,path:root.path,relative:relative(root.path,repo)},repository,directories:[],remoteHosts:[]};
  try{await validateTrustedProjectPath(root.path,filesystem.root.relative);}catch{throw new Refusal('PROJECT_ENVIRONMENT_ROOT_UNAVAILABLE',409);}
  await branchCommit(repo,config.sourceBranch);
  for(const env of config.environments){await branchCommit(repo,env.targetRef);
   for(const path of env.authorizedDirectories){
    try{const directory=await validateTrustedProjectPath(repo,path),s=await lstat(directory,{bigint:true});if(await git(repo,['cat-file','-t',config.sourceBranch+':'+path])!=='tree')throw Error('not source tree');
     if(!filesystem.directories.some(d=>d.path===path))filesystem.directories.push({path,dev:String(s.dev),ino:String(s.ino)});
    }catch{throw new Refusal('PROJECT_ENVIRONMENT_DIRECTORY_FORBIDDEN',403);}
   }
  }
  return this.ledger.tx(async c=>{
   await authenticate(c);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,78))',[command.intentId]);
   const saved=await replay(c);if(saved){await delivery(c);return saved;}
   // A project-scoped mutex also covers first publication where no head exists.
   await c.query('SELECT id FROM ac_projects WHERE id=$1 FOR UPDATE',[projectId]);
   const head=(await c.query('SELECT revision FROM ac_project_environment_heads WHERE project_id=$1 FOR UPDATE',[projectId])).rows[0];
   if((head?.revision??0)!==expectedRevision)throw new Refusal('PROJECT_ENVIRONMENT_REVISION_CONFLICT',409);
   const busy=(await c.query(`SELECT EXISTS(SELECT 1 FROM ac_capacity_grants WHERE project_id=$1 AND state<>'released') OR
    EXISTS(SELECT 1 FROM ac_execution_contracts b JOIN ac_intents i ON i.id=b.intent_id WHERE b.project_id=$1 AND i.state NOT IN ('done','failed','canceled')) OR
    EXISTS(SELECT 1 FROM ac_integration_intents t JOIN ac_artifacts a ON a.id=t.artifact_id WHERE a.project_id=$1 AND t.state IN ('registered','uncertain')) OR
    EXISTS(SELECT 1 FROM ac_remote_operations o JOIN ac_contexts x ON x.id=o.context_id WHERE x.project_id=$1 AND o.state NOT IN ('completed','failed','canceled_confirmed')) OR
    EXISTS(SELECT 1 FROM ac_remote_development_workspaces w WHERE w.project_id=$1 AND w.state='uncertain') busy`,[projectId])).rows[0].busy;
   if(busy)throw new Refusal('PROJECT_ENVIRONMENT_IN_USE',409);
   for(const env of config.environments)for(const dest of env.destinations)if(dest.kind==='remote'){
    const host=(await c.query('SELECT allowed_tasks,fingerprint,registration_digest FROM ac_remote_hosts WHERE id=$1 AND project_id=$2 AND enabled FOR SHARE',[dest.hostId,projectId])).rows[0];
    if(!host||dest.allowedPurposes.some(p=>!host.allowed_tasks.includes(p==='remote-return'?'git-return':'git-workspace')))throw new Refusal('PROJECT_ENVIRONMENT_DESTINATION_FORBIDDEN',403);
    if(!filesystem.remoteHosts.some(h=>h.id===dest.hostId))filesystem.remoteHosts.push({id:dest.hostId,fingerprint:host.fingerprint,registrationDigest:host.registration_digest});
   }
   await checkFilesystem(filesystem);for(const env of config.environments)await branchCommit(repo,env.targetRef);await branchCommit(repo,config.sourceBranch);
   const revision=expectedRevision+1;
   await c.query('INSERT INTO ac_project_environment_revisions(project_id,revision,snapshot,filesystem,digest,published_by) VALUES($1,$2,$3,$4,$5,$6)',[projectId,revision,config,filesystem,digest({config,filesystem}),principal]);
   await c.query('INSERT INTO ac_project_environment_heads VALUES($1,$2) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision',[projectId,revision]);
   const result={state:'applied',projectId,revision};await c.query('INSERT INTO ac_project_environment_intents VALUES($1,$2,$3,$4)',[command.intentId,principal,hash,result]);await delivery(c);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES(NULL,'project.environments.configure',$1)",[{projectId,revision,intentId:command.intentId,principal}]);return result;
  });
 }
}

/** Exact current immutable environment for real remote effects. Remote filesystem
 * paths remain governed by the remote host's existing root/workspace authority. */
export async function requireProjectEnvironment(c:pg.PoolClient,input:{projectId:string;contextId?:string;intentId?:string;hostId?:string;destinationRef?:string;purpose:'remote-development'|'remote-return'}){
 Id.parse(input.projectId);if(input.hostId)Id.parse(input.hostId);
 // Match publication and SQL admission order: project before environment head.
 await c.query('SELECT id FROM ac_projects WHERE id=$1 FOR SHARE',[input.projectId]);
 if(input.contextId){const row=(await c.query('SELECT project_id FROM ac_contexts WHERE id=$1',[input.contextId])).rows[0];if(row?.project_id!==input.projectId)throw new Refusal('PROJECT_ENVIRONMENT_FORBIDDEN',403);}
 const row=(await c.query(`SELECT r.* FROM ac_project_environment_heads h JOIN ac_project_environment_revisions r USING(project_id,revision) WHERE h.project_id=$1 FOR SHARE OF h`,[input.projectId])).rows[0];
 if(!row)throw new Refusal('PROJECT_ENVIRONMENT_REQUIRED',403);
 const config=ProjectEnvironmentConfig.parse(row.snapshot);if(digest({config,filesystem:row.filesystem})!==row.digest)throw new Refusal('PROJECT_ENVIRONMENT_DIGEST_MISMATCH',409);
 let binding:{environment_id:string;target_ref:string}|undefined;
 if(input.intentId){
  Id.parse(input.intentId);
  binding=(await c.query(`SELECT b.environment_id,x.target_ref FROM ac_project_environment_bindings b
   JOIN ac_execution_contracts x ON x.intent_id=b.intent_id AND x.digest=b.contract_digest
   JOIN ac_intents i ON i.id=b.intent_id JOIN ac_contexts ctx ON ctx.id=i.context_id
   WHERE b.intent_id=$1 AND b.project_id=$2 AND b.revision=$3 AND ctx.project_id=$2
    AND ($4::uuid IS NULL OR i.context_id=$4)`,[input.intentId,input.projectId,row.revision,input.contextId??null])).rows[0];
  if(!binding)throw new Refusal('PROJECT_ENVIRONMENT_BINDING_REQUIRED',403);
 }
 const candidates=config.environments.filter(env=>(!binding||(env.id===binding.environment_id&&env.targetRef===binding.target_ref))&&(!input.destinationRef||env.targetRef===input.destinationRef)&&env.destinations.some(d=>d.kind==='remote'&&d.hostId===input.hostId&&d.allowedPurposes.includes(input.purpose)));
 const env=candidates.length===1?candidates[0]:undefined;
 const host=input.hostId?(await c.query('SELECT allowed_tasks,fingerprint,registration_digest FROM ac_remote_hosts WHERE id=$1 AND project_id=$2 AND enabled FOR SHARE',[input.hostId,input.projectId])).rows[0]:undefined;
 const pinnedHost=row.filesystem.remoteHosts?.find((h:{id:string})=>h.id===input.hostId);
 if(!env||!host||!pinnedHost||pinnedHost.fingerprint!==host.fingerprint||pinnedHost.registrationDigest!==host.registration_digest||!host.allowed_tasks.includes(input.purpose==='remote-return'?'git-return':'git-workspace'))throw new Refusal('PROJECT_ENVIRONMENT_DESTINATION_FORBIDDEN',403);
 await checkFilesystem(row.filesystem);return {revision:row.revision,environmentId:env.id,targetRef:env.targetRef,sourceBranch:config.sourceBranch};
}

/** Called before first physical programmer launch (and new local integration).
 * The first child pins the parent's branch commit; later children/recovery use
 * that immutable base even after the branch moves. No-config legacy stays intact. */
export async function requireProjectEnvironmentLaunch(c:pg.PoolClient,input:{intentId:string;base:string;targetRef?:string;integration?:boolean}){
 Id.parse(input.intentId);if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.base))throw new Refusal('PROJECT_ENVIRONMENT_SOURCE_BASE_MISMATCH',403);
 const owner=(await c.query('SELECT i.context_id,x.project_id,coalesce(i.parent_intent_id,i.id) parent_id FROM ac_intents i JOIN ac_contexts x ON x.id=i.context_id WHERE i.id=$1',[input.intentId])).rows[0];
 if(!owner)throw new Refusal('PROJECT_ENVIRONMENT_BINDING_REQUIRED',403);
 await c.query('SELECT id FROM ac_projects WHERE id=$1 FOR SHARE',[owner.project_id]);
 const row=(await c.query(`SELECT r.*,b.environment_id,b.contract_digest,x.digest current_contract_digest,x.target_ref FROM ac_project_environment_heads h
  JOIN ac_project_environment_revisions r USING(project_id,revision)
  LEFT JOIN ac_project_environment_bindings b ON b.intent_id=$2 AND b.project_id=h.project_id AND b.revision=h.revision
  LEFT JOIN ac_execution_contracts x ON x.intent_id=b.intent_id WHERE h.project_id=$1 FOR SHARE OF h`,[owner.project_id,input.intentId])).rows[0];
 if(!row)return;
 if(!row.environment_id||row.contract_digest!==row.current_contract_digest)throw new Refusal('PROJECT_ENVIRONMENT_BINDING_REQUIRED',403);
 const config=ProjectEnvironmentConfig.parse(row.snapshot),env=config.environments.find(e=>e.id===row.environment_id);
 if(digest({config,filesystem:row.filesystem})!==row.digest)throw new Refusal('PROJECT_ENVIRONMENT_DIGEST_MISMATCH',409);
 if(!env||env.targetRef!==row.target_ref||(input.targetRef&&input.targetRef!==env.targetRef))throw new Refusal('PROJECT_ENVIRONMENT_TARGET_FORBIDDEN',403);
 if(input.integration&&!env.destinations.some(d=>d.kind==='local_repository'))throw new Refusal('PROJECT_ENVIRONMENT_DESTINATION_FORBIDDEN',403);
 await checkFilesystem(row.filesystem);
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,80))',[owner.parent_id]);
 const pinned=(await c.query('SELECT * FROM ac_project_environment_sources WHERE parent_intent_id=$1',[owner.parent_id])).rows[0];
 if(pinned){if(pinned.project_id!==owner.project_id||pinned.revision!==row.revision)throw new Refusal('PROJECT_ENVIRONMENT_SOURCE_BASE_MISMATCH',403);
  if(pinned.source_commit!==input.base&&!await authorizedCompositionBase(c,owner.parent_id,input.intentId,input.base,pinned.source_commit))throw new Refusal('PROJECT_ENVIRONMENT_SOURCE_BASE_MISMATCH',403);}
 else{
  if(await branchCommit(row.filesystem.repo,config.sourceBranch)!==input.base)throw new Refusal('PROJECT_ENVIRONMENT_SOURCE_BASE_MISMATCH',403);
  await c.query('INSERT INTO ac_project_environment_sources VALUES($1,$2,$3,$4)',[owner.parent_id,owner.project_id,row.revision,input.base]);
 }
 return {revision:row.revision,environmentId:env.id,sourceCommit:pinned?.source_commit??input.base,base:input.base};
}

/** A later batch may start from a completed composition of this same frozen
 * parent plan. An arbitrary descendant/branch tip is never sufficient. */
async function authorizedCompositionBase(c:pg.PoolClient,parentId:string,intentId:string,base:string,original:string){
 const frozen=(await c.query('SELECT base_id,snapshot,digest FROM ac_managed_delivery_inputs WHERE intent_id=$1',[intentId])).rows[0];
 const recipe=(await c.query('SELECT recipe,recipe_digest FROM ac_managed_executions WHERE parent_intent_id=$1',[parentId])).rows[0];
 if(!recipe||digest(recipe.recipe)!==recipe.recipe_digest||!Array.isArray(recipe.recipe.units))return false;
 if(!frozen||frozen.base_id!==base||frozen.snapshot?.base!==base||frozen.snapshot?.parentIntentId!==parentId||digest(frozen.snapshot)!==frozen.digest)return false;
 let cursor=base;const visited=new Set<string>();
 for(let depth=0;depth<32&&cursor!==original;depth++){
  if(visited.has(cursor))return false;visited.add(cursor);
  const candidates=(await c.query(`SELECT a.intent_id,a.base_id,a.tree_id,o.receipt,f.snapshot input_snapshot,f.digest input_digest,s.snapshot sources,s.digest sources_digest
   FROM ac_artifacts a JOIN ac_intents i ON i.id=a.intent_id JOIN ac_operations o ON o.intent_id=i.id AND o.state='completed'
   JOIN ac_managed_delivery_inputs f ON f.intent_id=i.id JOIN ac_managed_composition_sources s ON s.intent_id=i.id
   WHERE i.parent_intent_id=$1 AND a.commit_id=$2`,[parentId,cursor])).rows;
  if(candidates.length!==1)return false;const row=candidates[0];
  const unit=recipe.recipe.units.find((unit:{intentId:string;kind:string})=>unit.intentId===row.intent_id&&unit.kind==='composition');
  if(!unit||unit.id!==row.input_snapshot?.unitId||!Array.isArray(unit.sources)||!Array.isArray(row.input_snapshot?.sources)||!Array.isArray(row.sources)||
   unit.sources.length!==row.input_snapshot.sources.length||digest(row.input_snapshot.sources)!==digest(row.sources.map((source:{unitId:string})=>source.unitId)))return false;
  for(const [index,logicalId] of unit.sources.entries()){
   const selectedId=row.input_snapshot.sources[index];if(logicalId===selectedId)continue;
   const logical=recipe.recipe.units.find((u:{id:string})=>u.id===logicalId),selected=recipe.recipe.units.find((u:{id:string})=>u.id===selectedId);
   if(recipe.recipe.schemaVersion===1||!logical?.taskId||selected?.kind!=='task'||selected.taskId!==logical.taskId)return false;
   const selection=(await c.query('SELECT * FROM ac_managed_task_selections WHERE parent_intent_id=$1 AND task_id=$2',[parentId,logical.taskId])).rows[0];
   if(!selection||selection.selected_intent_id!==selected.intentId||selection.artifact_id!==row.sources[index].artifactId||
    selection.selection_digest!==digest({parentIntentId:parentId,contextId:selection.context_id,taskId:selection.task_id,selectedIntentId:selection.selected_intent_id,artifactId:selection.artifact_id,managerEpoch:Number(selection.manager_epoch)}))return false;
  }
  if(row.input_snapshot?.kind!=='composition'||row.input_snapshot?.parentIntentId!==parentId||row.input_snapshot?.base!==row.base_id||digest(row.input_snapshot)!==row.input_digest||
   digest(row.sources)!==row.sources_digest||!Array.isArray(row.sources)||!row.sources.length||row.receipt?.commit!==cursor||row.receipt?.base!==row.base_id||row.receipt?.tree!==row.tree_id)return false;
  // Composition snapshots bind every declared source to a registered artifact
  // of this same parent. This is the existing immutable composition authority.
  for(const source of row.sources){
   const sourceArtifact=(await c.query(`SELECT a.commit_id,a.tree_id,a.base_id,i.parent_unit_id FROM ac_artifacts a JOIN ac_intents i ON i.id=a.intent_id WHERE a.id=$1 AND i.parent_intent_id=$2`,[source.artifactId,parentId])).rows[0];
   if(!sourceArtifact||sourceArtifact.parent_unit_id!==source.unitId||sourceArtifact.commit_id!==source.commit||sourceArtifact.tree_id!==source.tree||sourceArtifact.base_id!==source.base||source.base!==row.base_id)return false;
  }
  cursor=row.base_id;
 }
 return cursor===original;
}
