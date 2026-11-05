import {z} from 'zod';
import type pg from 'pg';
import {Authority,Command,Id,Refusal,digest} from './contracts.ts';
import {GitObjectId,RemoteGitMaterializer,verifyGitExport} from './remote-git.ts';
import {requireRemoteSource} from './remote-source-authorizations.ts';
import {Ledger} from './ledger.ts';
import {Capacity} from './capacity.ts';
import {GitArtifacts} from './git.ts';
import {expectedArtifactRisk,refuseCurrentProtectedGate,type Quality} from './quality.ts';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {projectRepositoryIdentity} from './project-repository.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Template} from './templates.ts';
import {remoteImplementationWritePaths} from './remote-write-paths.ts';
import {RemoteOperations,type RemoteTransport} from './remote.ts';

const Prepare=z.object({workspaceId:Id,contextId:Id,intentId:Id,hostId:Id,sourceOperationId:Id}).strict();
const Prepared=z.object({schemaVersion:z.literal(1),operationId:Id,projectId:Id,state:z.literal('prepared'),commit:GitObjectId,tree:GitObjectId,
 repository:z.string().startsWith('/').max(500)}).strict();
const Snapshot=z.object({schemaVersion:z.literal(1),operationId:Id,projectId:Id,commit:GitObjectId,tree:GitObjectId,
 bundleSha256:z.string().regex(/^[a-f0-9]{64}$/),bundle:z.string().max(87384),workspaceId:Id,executionOperationId:Id,base:GitObjectId,reviewStatus:z.literal('not_reviewed')}).strict();

/** Executable remote development adapter. The caller supplies identifiers only;
 * configured worker task IDs select the executable and resource authority.
 * Snapshot is unreviewed implementation output, never an approved return token.
 */
export class RemoteDevelopment{
 constructor(readonly ledger:Ledger,readonly transport:RemoteTransport,readonly options:{implementationProfiles?:ReadonlyMap<string,{hostId:string;taskId:string;writePaths?:readonly string[]}>}={}){}
 private async context(c:pg.PoolClient,principal:string,contextId:string,authority:Authority){
  if(contextId!==authority.contextId)throw new Refusal('AUTHORITY_SCOPE_MISMATCH',403);
  const context=await this.ledger.authorize(c,principal,contextId);await this.ledger.fence(c,authority);
  if(context.role!=='owner')throw new Refusal('PROJECT_OWNER_REQUIRED',403);
  return context;
 }
 async prepare(principal:string,raw:z.input<typeof Prepare>,authority:Authority){
  const input=Prepare.parse(raw),hash=digest(input);
  await this.ledger.tx(async c=>{
   const context=await this.context(c,principal,input.contextId,authority);
   await this.ledger.assertIntentActive(c,input.contextId,input.intentId);
   const source=(await c.query("SELECT * FROM ac_remote_operations WHERE id=$1 AND context_id=$2 AND host_id=$3 AND intent_id=$4 AND task_id='git-export' AND state='completed'",[input.sourceOperationId,input.contextId,input.hostId,input.intentId])).rows[0];
   if(!source)throw new Refusal('REMOTE_WORKSPACE_SOURCE_REQUIRED');
   const {commit,tree}=source.remote_receipt??{};GitObjectId.parse(commit);GitObjectId.parse(tree);
   if(source.request_digest!==digest({action:'git-export',operationId:source.id,intentId:source.intent_id,contextId:input.contextId,hostId:input.hostId,commit,tree}))throw new Refusal('REMOTE_WORKSPACE_SOURCE_MISMATCH');
   const authorization=await requireRemoteSource(c,{contextId:input.contextId,projectId:context.project_id,intentId:input.intentId,hostId:input.hostId,commit,tree});
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,76))',[input.workspaceId]);
   const prior=(await c.query('SELECT request_digest FROM ac_remote_development_workspaces WHERE id=$1',[input.workspaceId])).rows[0];
   if(prior){if(prior.request_digest!==hash)throw new Refusal('REMOTE_WORKSPACE_ID_CONFLICT');return;}
   await c.query(`INSERT INTO ac_remote_development_workspaces(id,project_id,context_id,intent_id,host_id,source_operation_id,source_authorization_id,source_commit,source_tree,request_digest,manager_epoch,state)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'uncertain')`,[input.workspaceId,context.project_id,input.contextId,input.intentId,input.hostId,input.sourceOperationId,authorization.authorizationId,commit,tree,hash,authority.epoch]);
  });
  return this.ledger.tx(async c=>{
   await this.context(c,principal,input.contextId,authority);await this.ledger.assertIntentActive(c,input.contextId,input.intentId);
   const workspace=(await c.query('SELECT * FROM ac_remote_development_workspaces WHERE id=$1 FOR UPDATE',[input.workspaceId])).rows[0];
   if(workspace.request_digest!==hash)throw new Refusal('REMOTE_WORKSPACE_ID_CONFLICT');
   if(workspace.state==='prepared')return Prepared.parse(workspace.remote_receipt);
   const host=(await c.query("SELECT * FROM ac_remote_hosts WHERE id=$1 AND project_id=$2 AND enabled AND 'git-workspace'=ANY(allowed_tasks) FOR SHARE",[input.hostId,workspace.project_id])).rows[0];
   if(!host)throw new Refusal('REMOTE_TASK_FORBIDDEN',403);
   await this.ledger.assertIntentActive(c,input.contextId,input.intentId);
   await c.query("UPDATE ac_managers SET lease_until=clock_timestamp()+interval '30 seconds' WHERE context_id=$1",[input.contextId]);
   const reply=Prepared.parse(await this.transport.exchange(host,{schemaVersion:1,action:'git-workspace-prepare',operationId:input.workspaceId,projectId:workspace.project_id,commit:workspace.source_commit,tree:workspace.source_tree}));
   if(reply.operationId!==input.workspaceId||reply.projectId!==workspace.project_id||reply.commit!==workspace.source_commit||reply.tree!==workspace.source_tree)throw new Refusal('REMOTE_WORKSPACE_RECEIPT_MISMATCH');
   await c.query("UPDATE ac_remote_development_workspaces SET state='prepared',remote_receipt=$2,manager_epoch=$3 WHERE id=$1",[input.workspaceId,reply,authority.epoch]);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'remote.workspace.prepared',$2)",[input.contextId,{workspaceId:input.workspaceId,sourceOperationId:input.sourceOperationId,hostId:input.hostId,commit:reply.commit,tree:reply.tree}]);
   return reply;
  });
 }
 async start(principal:string,input:{workspaceId:string;operationId:string;contextId:string;intentId:string;hostId:string;taskId:string},authority:Authority){
  return new RemoteOperations(this.ledger,this.transport).start(principal,input,authority);
 }
 /** Bind a real capacity reservation to a fixed configured remote executable.
  * No account is activated here; Capacity retains its synthetic-only guard.
  */
 async launchImplementation(principal:string,input:{workspaceId:string;taskId:string;sessionId:string},authority:Authority){
  const value=z.object({workspaceId:Id,taskId:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),sessionId:Id}).strict().parse(input);
  const bound=await this.ledger.tx(async c=>{
   await this.context(c,principal,authority.contextId,authority);
   const workspace=(await c.query("SELECT * FROM ac_remote_development_workspaces WHERE id=$1 AND context_id=$2 AND state='prepared' FOR SHARE",[value.workspaceId,authority.contextId])).rows[0];
   if(!workspace)throw new Refusal('REMOTE_WORKSPACE_REQUIRED');
   await this.ledger.assertIntentActive(c,authority.contextId,workspace.intent_id);
   const intent=(await c.query('SELECT * FROM ac_intents WHERE id=$1',[workspace.intent_id])).rows[0];
   const operation=(await c.query('SELECT * FROM ac_operations WHERE id=$1 AND intent_id=$2 FOR UPDATE',[intent.operation_id,intent.id])).rows[0];
   const payload=Command.parse(intent.command).payload;
   if(!['engineering-native-v1','engineering-synthetic-v1'].includes(payload.workflow)||intent.principal_id!==principal||!operation||Number(operation.manager_epoch)!==authority.epoch)throw new Refusal('REMOTE_IMPLEMENTATION_SCOPE_MISMATCH');
   if(payload.workflow!=='engineering-native-v1'&&payload.workflow!=='engineering-synthetic-v1')throw new Refusal('REMOTE_IMPLEMENTATION_SCOPE_MISMATCH');
   let contract=(await c.query('SELECT * FROM ac_execution_contracts WHERE intent_id=$1',[intent.id])).rows[0];
   if(!contract&&payload.workflow==='engineering-synthetic-v1'){
    const selected=(await c.query('SELECT snapshot,digest FROM ac_intent_templates WHERE intent_id=$1',[intent.id])).rows[0];
    const template=Template.parse(selected?.snapshot);
    if(!selected||digest(template)!==selected.digest||template.workflow!=='engineering-synthetic-v1')throw new Refusal('TEMPLATE_DIGEST_MISMATCH');
    const frozen={qualityRevision:template.qualityRevision,targetRef:template.targetRef};
    await c.query('INSERT INTO ac_execution_contracts VALUES($1,$2,$3,$4,$5) ON CONFLICT(intent_id) DO NOTHING',[intent.id,workspace.project_id,frozen.qualityRevision,frozen.targetRef,digest(frozen)]);
    contract=(await c.query('SELECT * FROM ac_execution_contracts WHERE intent_id=$1',[intent.id])).rows[0];
   }
   if(!contract||contract.digest!==digest({qualityRevision:Number(contract.quality_revision),targetRef:contract.target_ref})||(payload.workflow==='engineering-native-v1'&&(Number(contract.quality_revision)!==payload.qualityRevision||contract.target_ref!==payload.targetRef)))throw new Refusal('EXECUTION_CONTRACT_MISMATCH');
   return {workspace,intent,operation,payload,contract};
  });
  const capacity=new Capacity(this.ledger),grant=await capacity.reserve(principal,{attemptId:bound.operation.execution_attempt_id,intentId:bound.intent.id,contextId:authority.contextId,role:'programmer'},authority);
  if(grant.state==='released')throw new Refusal('REMOTE_IMPLEMENTATION_NEW_ATTEMPT_REQUIRED');
  const configured=this.options.implementationProfiles?.get(grant.profile_id);
  if(!configured||configured.hostId!==bound.workspace.host_id||configured.taskId!==value.taskId){
   if(grant.state==='reserved')await capacity.transition(principal,grant.id,authority,'released',{processId:bound.intent.operation_id,state:'not_started'});
   throw new Refusal('REMOTE_IMPLEMENTATION_PROFILE_NOT_CONFIGURED');
  }
  let writePaths:string[];
  try{
   writePaths=remoteImplementationWritePaths(bound.payload.workflow==='engineering-native-v1'?bound.payload.writePaths:configured.writePaths??[],configured.writePaths);
  }catch(error){
   if(grant.state==='reserved')await capacity.transition(principal,grant.id,authority,'released',{processId:bound.intent.operation_id,state:'not_started'});
   throw error;
  }
  await this.ledger.tx(async c=>{
   await this.context(c,principal,authority.contextId,authority);await this.ledger.assertIntentActive(c,authority.contextId,bound.intent.id);
   await refuseCurrentProtectedGate(c,bound.workspace.project_id,writePaths);
   const prior=(await c.query('SELECT * FROM ac_remote_development_implementations WHERE workspace_id=$1',[value.workspaceId])).rows[0];
   const frozen={workspaceId:value.workspaceId,taskId:value.taskId,sourceCommit:bound.workspace.source_commit,writePaths,targetRef:bound.contract.target_ref,qualityRevision:Number(bound.contract.quality_revision),messageDigest:bound.payload.workflow==='engineering-native-v1'?bound.payload.messageDigest:digest({fixedTask:value.taskId,writePaths})};
   if(prior){if(prior.operation_id!==bound.operation.id||prior.grant_id!==grant.id||prior.session_id!==value.sessionId||prior.input_digest!==digest(frozen))throw new Refusal('REMOTE_IMPLEMENTATION_BINDING_CONFLICT');return;}
   const operation=(await c.query('SELECT * FROM ac_operations WHERE id=$1 FOR UPDATE',[bound.operation.id])).rows[0];
   if(operation.state!=='registered'||operation.handle||operation.native_session_id||operation.grant_id&&operation.grant_id!==grant.id)throw new Refusal('REMOTE_IMPLEMENTATION_ALREADY_STARTED');
   await c.query(`INSERT INTO ac_remote_development_implementations(workspace_id,operation_id,grant_id,session_id,task_id,policy_revision,input_snapshot,input_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[value.workspaceId,operation.id,grant.id,value.sessionId,value.taskId,Number(bound.contract.quality_revision),frozen,digest(frozen)]);
   await c.query("INSERT INTO ac_remote_implementation_emissions(operation_id,workspace_id,grant_id,manager_epoch,phase) VALUES($1,$2,$3,$4,'pending')",[operation.id,value.workspaceId,grant.id,authority.epoch]);
   await c.query("UPDATE ac_operations SET state='uncertain',grant_id=$2,native_session_id=$3,handle=$4 WHERE id=$1",[operation.id,grant.id,value.sessionId,{source:'remote-development',workspaceId:value.workspaceId,operationId:operation.id}]);
  });
  return this.start(principal,{workspaceId:value.workspaceId,operationId:bound.operation.id,contextId:authority.contextId,intentId:bound.intent.id,hostId:bound.workspace.host_id,taskId:value.taskId},authority);
 }
 /** Import only the sealed committed artifact, then use the existing Quality
  * registration. This creates no QA/review/approval evidence and never moves HEAD.
  */
 async registerArtifact(principal:string,input:{workspaceId:string;artifactId:string},authority:Authority,quality:Quality,tmpfsRoot:string){
  const value=z.object({workspaceId:Id,artifactId:Id}).strict().parse(input);
  if(quality.ledger!==this.ledger)throw new Refusal('REMOTE_QUALITY_SCOPE_MISMATCH');
  const bound=await this.ledger.tx(async c=>{
   const context=await this.context(c,principal,authority.contextId,authority);
   const row=(await c.query(`SELECT w.*,i.operation_id,i.grant_id,i.session_id,i.policy_revision,i.input_snapshot,i.input_digest,r.repo,
    d.repo_dev,d.repo_ino,d.git_dev,d.git_ino FROM ac_remote_development_workspaces w JOIN ac_remote_development_implementations i ON i.workspace_id=w.id
    JOIN ac_project_repositories r ON r.project_id=w.project_id JOIN ac_project_repository_identity d ON d.project_id=w.project_id
    WHERE w.id=$1 AND w.context_id=$2 AND w.project_id=$3`,[value.workspaceId,authority.contextId,context.project_id])).rows[0];
   if(!row||digest(row.input_snapshot)!==row.input_digest)throw new Refusal('REMOTE_IMPLEMENTATION_REQUIRED');
   await this.ledger.assertIntentActive(c,authority.contextId,row.intent_id);
   return row;
  });
  const remote=new RemoteOperations(this.ledger,this.transport),execution=await remote.reconcile(principal,bound.operation_id,authority);
  if(execution?.state!=='completed'||execution.exitCode!==0||execution.groupRemovalConfirmed!==true||execution.workspaceId!==value.workspaceId)throw new Refusal('REMOTE_IMPLEMENTATION_NOT_COMPLETED');
  const snapshot=await this.snapshot(principal,{workspaceId:value.workspaceId,executionOperationId:bound.operation_id,contextId:authority.contextId},authority);
  const identity=await projectRepositoryIdentity(bound.repo);
  if(identity.repoDev!==bound.repo_dev||identity.repoIno!==bound.repo_ino||identity.gitDev!==bound.git_dev||identity.gitIno!==bound.git_ino)throw new Refusal('PROJECT_REPOSITORY_IDENTITY_CHANGED');
  const bare=await new RemoteGitMaterializer(tmpfsRoot).materialize(value.workspaceId,snapshot.commit,snapshot.tree,snapshot.bundle);
  const temporary=await mkdtemp(join(tmpfsRoot,'.remote-import-'));
  try{
   const clone=join(temporary,'repo');
   await promisify(execFile)('/usr/bin/git',['-c','core.hooksPath=/dev/null','clone','--no-checkout','--no-hardlinks',bare.repository,clone],{timeout:15000,maxBuffer:65536,env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'}});
   const imported=await new GitArtifacts(bound.repo).import(clone,snapshot.commit,snapshot.base);
   if(imported.tree!==snapshot.tree)throw new Refusal('REMOTE_IMPLEMENTATION_ARTIFACT_MISMATCH');
  }finally{await rm(temporary,{recursive:true,force:true});}
  const changed=(await promisify(execFile)('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',bound.repo,'diff','--name-only','-z','--no-renames',snapshot.base,snapshot.commit],{
   encoding:'utf8',timeout:10000,maxBuffer:65536,env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'}})).stdout.split('\0').filter(Boolean);
  const allowed=z.array(z.string()).parse(bound.input_snapshot.writePaths);
  if(changed.some(path=>!allowed.some(item=>path===item||item.endsWith('/')&&path.startsWith(item))))throw new Refusal('REMOTE_IMPLEMENTATION_WRITE_PATH_FORBIDDEN');
  const risk=await this.ledger.tx(async c=>{
   await this.context(c,principal,authority.contextId,authority);await this.ledger.assertIntentActive(c,authority.contextId,bound.intent_id);
   const operation=(await c.query('SELECT * FROM ac_operations WHERE id=$1 AND intent_id=$2 FOR UPDATE',[bound.operation_id,bound.intent_id])).rows[0];
   if(!operation||operation.grant_id!==bound.grant_id||operation.native_session_id!==bound.session_id||operation.handle?.workspaceId!==value.workspaceId||operation.handle?.operationId!==bound.operation_id)throw new Refusal('REMOTE_IMPLEMENTATION_BINDING_CONFLICT');
   const receipt={source:'remote-development',operationId:bound.operation_id,workspaceId:value.workspaceId,commit:snapshot.commit,tree:snapshot.tree,base:snapshot.base,exitCode:0,synthetic:false,remoteReceipt:execution};
   if(operation.state==='completed'&&digest(operation.receipt)!==digest(receipt))throw new Refusal('REMOTE_IMPLEMENTATION_RECEIPT_CONFLICT');
   await new Capacity(this.ledger,c).transition(principal,bound.grant_id,authority,'released',{processId:bound.operation_id,state:'exited'});
   await c.query("UPDATE ac_operations SET state='completed',receipt=$2 WHERE id=$1",[bound.operation_id,receipt]);
   return expectedArtifactRisk(c,bound.intent_id,authority.contextId,Number(bound.policy_revision));
  });
  return quality.register(principal,{id:value.artifactId,contextId:authority.contextId,intentId:bound.intent_id,implementationGrantId:bound.grant_id,implementationSessionId:bound.session_id,
   policyRevision:Number(bound.policy_revision),commit:snapshot.commit,tree:snapshot.tree,base:snapshot.base,risk},authority);
 }
 async snapshot(principal:string,input:{workspaceId:string;executionOperationId:string;contextId:string},authority:Authority){
  const value=z.object({workspaceId:Id,executionOperationId:Id,contextId:Id}).strict().parse(input);
  return this.ledger.tx(async c=>{
   await this.context(c,principal,value.contextId,authority);
   const workspace=(await c.query("SELECT * FROM ac_remote_development_workspaces WHERE id=$1 AND context_id=$2 AND state='prepared' FOR SHARE",[value.workspaceId,value.contextId])).rows[0];
   if(!workspace)throw new Refusal('REMOTE_WORKSPACE_REQUIRED');
   const execution=(await c.query("SELECT * FROM ac_remote_operations WHERE id=$1 AND context_id=$2 AND host_id=$3 AND intent_id=$4 AND state='completed'",[value.executionOperationId,value.contextId,workspace.host_id,workspace.intent_id])).rows[0];
   if(!execution||execution.remote_receipt?.workspaceId!==value.workspaceId||execution.remote_receipt?.root!==workspace.remote_receipt.repository||execution.remote_receipt?.exitCode!==0)throw new Refusal('REMOTE_WORKSPACE_EXECUTION_UNPROVEN');
   const host=(await c.query("SELECT * FROM ac_remote_hosts WHERE id=$1 AND enabled AND 'git-workspace'=ANY(allowed_tasks) FOR SHARE",[workspace.host_id])).rows[0];
   if(!host)throw new Refusal('REMOTE_TASK_FORBIDDEN',403);
   const reply=Snapshot.parse(await this.transport.exchange(host,{schemaVersion:1,action:'git-workspace-snapshot',operationId:value.workspaceId,projectId:workspace.project_id,executionOperationId:value.executionOperationId}));
   if(reply.workspaceId!==value.workspaceId||reply.operationId!==value.workspaceId||reply.executionOperationId!==value.executionOperationId||reply.base!==workspace.source_commit)throw new Refusal('REMOTE_WORKSPACE_SNAPSHOT_MISMATCH');
   const exported=verifyGitExport({schemaVersion:reply.schemaVersion,operationId:reply.operationId,projectId:reply.projectId,commit:reply.commit,tree:reply.tree,bundle:reply.bundle,bundleSha256:reply.bundleSha256},
    {operationId:value.workspaceId,projectId:workspace.project_id,commit:reply.commit,tree:reply.tree});
   const existing=(await c.query('SELECT * FROM ac_remote_development_snapshots WHERE workspace_id=$1',[value.workspaceId])).rows[0];
   if(existing&&(existing.execution_operation_id!==value.executionOperationId||existing.commit_id!==reply.commit||existing.tree_id!==reply.tree||existing.bundle_sha256!==reply.bundleSha256))throw new Refusal('REMOTE_WORKSPACE_SNAPSHOT_CONFLICT');
   if(!existing)await c.query(`INSERT INTO ac_remote_development_snapshots(workspace_id,execution_operation_id,commit_id,tree_id,base_id,bundle_sha256,receipt) VALUES($1,$2,$3,$4,$5,$6,$7)`,[value.workspaceId,value.executionOperationId,reply.commit,reply.tree,reply.base,reply.bundleSha256,{...reply,bundle:undefined}]);
   return {...reply,bundle:exported.bundle};
  });
 }
}
