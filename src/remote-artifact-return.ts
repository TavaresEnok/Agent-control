import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type pg from 'pg';
import {z} from 'zod';
import {requireRecoveryInventory} from './recovery-inventory.ts';
import {Id,Refusal,digest} from './contracts.ts';
import {GitObjectId} from './remote-git.ts';
import {projectRepositoryIdentity} from './project-repository.ts';
import type {RemoteHost} from './remote.ts';
import {requireProjectEnvironment} from './project-environments.ts';
import type {ProjectAdmin} from './project-admin.ts';

export const RemoteArtifactReturnPayload=z.object({projectId:Id,contextId:Id,hostId:Id,artifactId:Id,
 destinationRef:z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9/_-]*$/)}).strict();
type Payload=z.infer<typeof RemoteArtifactReturnPayload>;
type Command={schemaVersion:1;intentId:string;deliveryAttemptId:string;action:'project.returnRemoteArtifact';payload:Payload};
export const RemoteArtifactReturnReceipt=z.object({schemaVersion:z.literal(1),state:z.literal('returned'),operationId:Id,projectId:Id,artifactId:Id,
 commit:GitObjectId,tree:GitObjectId,expectedCommit:GitObjectId,destinationRef:z.string(),bundleSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const git=async(args:string[])=> (await promisify(execFile)('/usr/bin/python3',[new URL('../services/remote-git/limited_git.py',import.meta.url).pathname,...args],{
 encoding:'utf8',timeout:15000,maxBuffer:131072,env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'}})).stdout.trim();

/** Eligibility is deliberately stricter than optional human integration approval:
 * export back to a remote host always needs an exact human approval and a completed
 * integration. The separate signed admin command grants the remote effect itself.
 */
async function authorized(c:pg.PoolClient,principal:string,p:Payload){
 if(!(await c.query("SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner' FOR SHARE",[p.projectId,principal])).rowCount)throw new Refusal('PROJECT_OWNER_REQUIRED',403);
 const row=(await c.query(`SELECT a.*,s.id source_id,s.commit_id source_commit,s.host_id source_host,r.repo,
  i.repo_dev,i.repo_ino,i.git_dev,i.git_ino,h.hostname,h.port,h.username,h.public_key,h.fingerprint,h.credential_ref,h.remote_root
  FROM ac_artifacts a JOIN ac_contexts x ON x.id=a.context_id AND x.project_id=a.project_id AND NOT x.archived
  JOIN ac_remote_source_materializations s ON s.project_id=a.project_id AND s.context_id=a.context_id AND s.host_id=$4
  JOIN ac_project_repositories r ON r.project_id=a.project_id
  JOIN ac_project_repository_identity i ON i.project_id=a.project_id
  JOIN ac_remote_hosts h ON h.id=s.host_id AND h.project_id=a.project_id AND h.enabled AND 'git-return'=ANY(h.allowed_tasks)
  JOIN ac_integration_intents t ON t.artifact_id=a.id AND t.context_id=a.context_id AND t.state='integrated' AND t.target_ref=$5
  JOIN ac_integration_approvals ap ON ap.artifact_id=a.id AND ap.target_ref=t.target_ref
    AND ap.artifact_digest=a.identity_digest AND ap.policy_revision=a.policy_revision
  WHERE a.id=$1 AND a.project_id=$2 AND a.context_id=$3
    AND t.receipt->>'commit'=a.commit_id AND t.receipt->>'tree'=a.tree_id`,[p.artifactId,p.projectId,p.contextId,p.hostId,p.destinationRef])).rows[0];
 if(!row)throw new Refusal('REMOTE_RETURN_APPROVED_ARTIFACT_REQUIRED',403);
 if(row.identity_digest!==digest({commit:row.commit_id,tree:row.tree_id,base:row.base_id}))throw new Refusal('REMOTE_RETURN_ARTIFACT_MISMATCH');
 return row;
}

export async function returnRemoteArtifact(admin:ProjectAdmin,principal:string,command:Command,hash:string,
 authorize:(c:pg.PoolClient)=>Promise<void>,delivery:(c:pg.PoolClient)=>Promise<void>){
 const transport=admin.options.remoteReturnTransport;
 if(!transport)throw new Refusal('REMOTE_RETURN_NOT_CONFIGURED');
 // Authenticate and retain membership/key row locks through the bounded remote
 // effect. Concurrent revocation waits; the effect is authorized at its CAS.
 return admin.ledger.tx(async c=>{
  await authorize(c);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,2))',[command.intentId]);
  const prior=(await c.query('SELECT payload_digest,result FROM ac_project_admin_intents WHERE id=$1',[command.intentId])).rows[0];
  if(prior){if(prior.payload_digest!==hash)throw new Refusal('PROJECT_ADMIN_INTENT_CONFLICT');await delivery(c);return prior.result;}
  if(!(await c.query('SELECT enabled FROM ac_admission_control WHERE id=1 FOR SHARE')).rows[0]?.enabled)throw new Refusal('ADMISSION_CLOSED');
  const p=command.payload,row=await authorized(c,principal,p);
  // Lock host and project registration through transport so disable/rebinding
  // cannot race authorization. Immutable provenance selects the only host/base.
  await c.query('SELECT id FROM ac_remote_hosts WHERE id=$1 FOR SHARE',[p.hostId]);
  await c.query('SELECT project_id FROM ac_project_repositories WHERE project_id=$1 FOR SHARE',[p.projectId]);
  await c.query('SELECT project_id FROM ac_project_repository_identity WHERE project_id=$1 FOR SHARE',[p.projectId]);
  const current=await authorized(c,principal,p);
  if(current.repo!==row.repo||current.source_id!==row.source_id)throw new Refusal('REMOTE_RETURN_PROVENANCE_MISMATCH');
  await requireProjectEnvironment(c,{projectId:p.projectId,contextId:p.contextId,intentId:row.intent_id,hostId:p.hostId,destinationRef:p.destinationRef,purpose:'remote-return'});
  const identity=await projectRepositoryIdentity(row.repo);
  if(identity.repoDev!==row.repo_dev||identity.repoIno!==row.repo_ino||identity.gitDev!==row.git_dev||identity.gitIno!==row.git_ino)throw new Refusal('PROJECT_REPOSITORY_IDENTITY_CHANGED');
  {
   if(await git(['-C',row.repo,'rev-parse',row.commit_id+'^{tree}'])!==row.tree_id)throw new Refusal('REMOTE_RETURN_ARTIFACT_MISMATCH');
   await git(['-C',row.repo,'merge-base','--is-ancestor',row.source_commit,row.commit_id]);
   // The bounded read-only helper exports the immutable artifact history.
   const script=`import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('helper',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nr=m.export({'projects':{sys.argv[2]:sys.argv[3]},'gitExportProjects':[sys.argv[2]]},{'schemaVersion':1,'action':'git-export','operationId':sys.argv[4],'projectId':sys.argv[2],'commit':sys.argv[5],'tree':sys.argv[6]})\nprint(json.dumps(r))`;
   const output=await promisify(execFile)('/usr/bin/python3',['-c',script,new URL('../services/remote-git/helper.py',import.meta.url).pathname,p.projectId,row.repo,command.intentId,row.commit_id,row.tree_id],{encoding:'utf8',timeout:18000,maxBuffer:100000,env:{PATH:'/usr/bin:/bin'}});
   const exported=JSON.parse(output.stdout) as {bundle:string;bundleSha256:string};
   const bytes=Buffer.from(exported.bundle,'base64');
   if(bytes.length>65536||createHash('sha256').update(bytes).digest('hex')!==exported.bundleSha256)throw new Refusal('REMOTE_RETURN_BUNDLE_MISMATCH');
   const request={schemaVersion:1,action:'git-return',operationId:command.intentId,projectId:p.projectId,artifactId:p.artifactId,commit:row.commit_id,tree:row.tree_id,
    expectedCommit:row.source_commit,destinationRef:p.destinationRef,bundle:exported.bundle,bundleSha256:exported.bundleSha256};
   if(await requireRecoveryInventory(c,admin.ledger))throw new Refusal('RECOVERY_EFFECT_NOT_INSTRUMENTED');
   const receipt=RemoteArtifactReturnReceipt.parse(await transport.exchange({id:p.hostId,hostname:row.hostname,port:row.port,username:row.username,public_key:row.public_key,fingerprint:row.fingerprint,credential_ref:row.credential_ref,remote_root:row.remote_root} satisfies RemoteHost,request));
   for(const key of ['operationId','projectId','artifactId','commit','tree','expectedCommit','destinationRef','bundleSha256'] as const)
    if(receipt[key]!==request[key])throw new Refusal('REMOTE_RETURN_RECEIPT_MISMATCH');
   const result={...receipt,hostId:p.hostId,contextId:p.contextId,sourceMaterializationId:row.source_id};
   await c.query('INSERT INTO ac_project_admin_intents(id,principal_id,payload_digest,action,result) VALUES($1,$2,$3,$4,$5)',[command.intentId,principal,hash,command.action,result]);
   await c.query(`INSERT INTO ac_remote_artifact_returns(id,project_id,context_id,host_id,artifact_id,source_materialization_id,request_digest,receipt,principal_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[command.intentId,p.projectId,p.contextId,p.hostId,p.artifactId,row.source_id,digest(request),receipt,principal]);
   await delivery(c);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'remote.artifact.returned',$2)",[p.contextId,result]);
   return result;
  }
 });
}
