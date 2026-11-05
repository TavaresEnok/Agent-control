import {z} from 'zod';
import pg from 'pg';
import {Authority,Id,Refusal,digest} from './contracts.ts';
import {RemoteDevelopment} from './remote-development.ts';
import type {Quality} from './quality.ts';
import type {ProjectAdmin} from './project-admin.ts';
const Base={schemaVersion:z.literal(1),intentId:Id,deliveryAttemptId:Id};
const Scope={projectId:Id,contextId:Id};
export const RemoteDevelopmentAdminCommands=[
 z.object({...Base,action:z.literal('project.prepareRemoteDevelopment'),payload:z.object({...Scope,hostId:Id,sourceOperationId:Id,workspaceId:Id}).strict()}).strict(),
 z.object({...Base,action:z.literal('project.launchRemoteDevelopment'),payload:z.object({...Scope,workspaceId:Id}).strict()}).strict(),
 z.object({...Base,action:z.literal('project.registerRemoteArtifact'),payload:z.object({...Scope,workspaceId:Id}).strict()}).strict(),
] as const;
const Command=z.discriminatedUnion('action',RemoteDevelopmentAdminCommands);
export type RemoteDevelopmentAdministration={supports?:(projectId:string,hostId:string)=>boolean;resolve(projectId:string,contextId:string):Promise<{development:RemoteDevelopment;authority:Authority;quality:Quality;tmpfsRoot:string}>};
function stableId(domain:string,value:string){const h=digest({domain,value});return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}

/** Distinct human-signed effects, under the existing authenticated global API.
 * The signature/key/membership locks remain held across the remote adapter.
 * Adapter transactions acquire their own live manager fence; this transaction
 * deliberately does not lock the context row and create a self-deadlock.
 */
export async function executeRemoteDevelopmentAdmin(admin:ProjectAdmin,principal:string,raw:unknown,hash:string,
 authorize:(c:pg.PoolClient)=>Promise<void>,delivery:(c:pg.PoolClient)=>Promise<void>){
 const command=Command.parse(raw),p=command.payload,provider=admin.options.remoteDevelopment;
 if(!provider)throw new Refusal('REMOTE_DEVELOPMENT_NOT_CONFIGURED');
 // Keep the human authority transaction off the shared adapter pool. Every
 // adapter step may acquire a shared client while these locks remain held.
 const pool=new pg.Pool({...admin.ledger.pool.options,max:1,connectionTimeoutMillis:3000,statement_timeout:10000,query_timeout:11000});
 try{
 const c=await pool.connect();
 try{
 await c.query('BEGIN');
 const result=await (async()=>{
  await authorize(c);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,2))',[command.intentId]);
  const prior=(await c.query('SELECT payload_digest,result FROM ac_project_admin_intents WHERE id=$1',[command.intentId])).rows[0];
  if(prior){if(prior.payload_digest!==hash)throw new Refusal('PROJECT_ADMIN_INTENT_CONFLICT');await delivery(c);return prior.result;}
  if(!(await c.query(`SELECT 1 FROM ac_memberships m JOIN ac_contexts x ON x.project_id=m.project_id
   WHERE m.project_id=$1 AND m.principal_id=$2 AND m.role='owner' AND x.id=$3 AND NOT x.archived FOR SHARE OF m`,[p.projectId,principal,p.contextId])).rowCount)throw new Refusal('PROJECT_OWNER_REQUIRED',403);
  const resolved=await provider.resolve(p.projectId,p.contextId);
  if(resolved.development.ledger!==admin.ledger||resolved.quality.ledger!==admin.ledger||resolved.authority.contextId!==p.contextId)throw new Refusal('REMOTE_DEVELOPMENT_SCOPE_MISMATCH');
  let result:Record<string,unknown>;
  if(command.action==='project.prepareRemoteDevelopment'){
   const preparedPayload=command.payload;
   const source=(await c.query("SELECT o.intent_id FROM ac_remote_operations o JOIN ac_contexts x ON x.id=o.context_id WHERE o.id=$1 AND o.context_id=$2 AND o.host_id=$3 AND x.project_id=$4 AND o.task_id='git-export' AND o.state='completed'",[preparedPayload.sourceOperationId,p.contextId,preparedPayload.hostId,p.projectId])).rows[0];
   if(!source)throw new Refusal('REMOTE_WORKSPACE_SOURCE_REQUIRED');
   const reply=await resolved.development.prepare(principal,{workspaceId:p.workspaceId,contextId:p.contextId,hostId:preparedPayload.hostId,sourceOperationId:preparedPayload.sourceOperationId,intentId:source.intent_id},resolved.authority);
   result={state:'prepared',projectId:p.projectId,contextId:p.contextId,workspaceId:p.workspaceId,commit:reply.commit,tree:reply.tree};
  }else{
   const workspace=(await c.query("SELECT w.host_id,w.intent_id,i.session_id FROM ac_remote_development_workspaces w LEFT JOIN ac_remote_development_implementations i ON i.workspace_id=w.id WHERE w.id=$1 AND w.project_id=$2 AND w.context_id=$3",[p.workspaceId,p.projectId,p.contextId])).rows[0];
   if(!workspace)throw new Refusal('REMOTE_WORKSPACE_REQUIRED');
   if(command.action==='project.launchRemoteDevelopment'){
    const taskIds=new Set([...resolved.development.options.implementationProfiles?.values()??[]].filter(item=>item.hostId===workspace.host_id).map(item=>item.taskId));
    if(taskIds.size!==1)throw new Refusal('REMOTE_IMPLEMENTATION_PROFILE_AMBIGUOUS');
    const taskId=[...taskIds][0]!;
    const reply=await resolved.development.launchImplementation(principal,{workspaceId:p.workspaceId,taskId,sessionId:workspace.session_id??stableId('remote-development-session-v1',p.workspaceId)},resolved.authority);
    result={state:'launched',projectId:p.projectId,contextId:p.contextId,workspaceId:p.workspaceId,implementationState:reply?.state??'uncertain'};
   }else{
    const artifact=await resolved.development.registerArtifact(principal,{workspaceId:p.workspaceId,artifactId:stableId('remote-development-artifact-v1',p.workspaceId)},resolved.authority,resolved.quality,resolved.tmpfsRoot);
    result={state:'registered',projectId:p.projectId,contextId:p.contextId,workspaceId:p.workspaceId,artifactId:artifact.id,commit:artifact.commit_id,tree:artifact.tree_id,reviewStatus:'not_reviewed'};
   }
  }
  await authorize(c);
  await c.query('INSERT INTO ac_project_admin_intents(id,principal_id,payload_digest,action,result) VALUES($1,$2,$3,$4,$5)',[command.intentId,principal,hash,command.action,result]);
  await delivery(c);
  await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'project.remote_development.admin',$2)",[p.contextId,{action:command.action,intentId:command.intentId,principal,...result}]);
  return result;
 })();
 await c.query('COMMIT');return result;
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 }finally{await pool.end();}
}

/** Closed display projection. Candidate rows grant no authority until rechecked. */
export async function remoteDevelopmentAdminView(admin:ProjectAdmin,principal:string,isAdmin:boolean){
 const configured=isAdmin&&!!admin.options.remoteDevelopment;
 if(!isAdmin)return {configured:false,candidates:[],workspaces:[]};
 const candidates=configured?(await admin.ledger.pool.query(`SELECT s.project_id AS "projectId",s.context_id AS "contextId",s.host_id AS "hostId",o.id AS "sourceOperationId",o.intent_id AS "intentId",s.commit_id AS commit,s.tree_id AS tree,p.label,o.request_digest AS "requestDigest"
  FROM ac_remote_source_materializations s JOIN ac_remote_operations o ON o.context_id=s.context_id AND o.host_id=s.host_id
   AND o.task_id='git-export' AND o.state='completed' AND o.remote_receipt->>'commit'=s.commit_id AND o.remote_receipt->>'tree'=s.tree_id
  JOIN ac_managers live ON live.context_id=s.context_id AND live.epoch=o.manager_epoch AND live.lease_until>clock_timestamp()
  JOIN ac_intents i ON i.id=o.intent_id AND i.context_id=s.context_id AND i.state NOT IN ('done','review','failed','canceled','cancelled','cancellation_requested')
  JOIN ac_operations implementation ON implementation.intent_id=i.id AND implementation.id=i.operation_id AND implementation.manager_epoch=live.epoch
  JOIN ac_projects p ON p.id=s.project_id JOIN ac_contexts x ON x.id=s.context_id AND NOT x.archived
  JOIN ac_memberships m ON m.project_id=s.project_id AND m.principal_id=$1 AND m.role='owner'
  JOIN ac_remote_hosts h ON h.id=s.host_id AND h.project_id=s.project_id AND h.enabled AND 'git-workspace'=ANY(h.allowed_tasks)
  WHERE EXISTS(SELECT 1 FROM ac_remote_source_authorizations a JOIN ac_control_intents control ON control.id=a.control_intent_id AND control.action='remote.source.authorize'
   WHERE a.project_id=s.project_id AND a.context_id=s.context_id AND a.intent_id=o.intent_id AND a.host_id=s.host_id AND a.commit_id=s.commit_id AND a.tree_id=s.tree_id)
   AND NOT EXISTS(SELECT 1 FROM ac_remote_development_workspaces w WHERE w.intent_id=o.intent_id)
   AND NOT EXISTS(SELECT 1 FROM ac_plan_cancellations cancel WHERE cancel.intent_id=i.id OR cancel.intent_id=i.parent_intent_id)
  ORDER BY o.created_at DESC,o.id LIMIT 100`,[principal])).rows.flatMap(({requestDigest,...row})=>requestDigest===digest({action:'git-export',operationId:row.sourceOperationId,intentId:row.intentId,contextId:row.contextId,hostId:row.hostId,commit:row.commit,tree:row.tree})&&(admin.options.remoteDevelopment?.supports?.(row.projectId,row.hostId)??true)?[row]:[]):[];
 const workspaces=(await admin.ledger.pool.query(`SELECT w.id AS "workspaceId",w.project_id AS "projectId",w.context_id AS "contextId",w.host_id AS "hostId",w.state,
  o.state AS "implementationState",e.phase AS "emissionPhase",s.commit_id AS commit,s.tree_id AS tree,a.id AS "artifactId"
  FROM ac_remote_development_workspaces w JOIN ac_memberships m ON m.project_id=w.project_id AND m.principal_id=$1 AND m.role='owner'
  LEFT JOIN ac_remote_development_implementations i ON i.workspace_id=w.id LEFT JOIN ac_operations o ON o.id=i.operation_id
  LEFT JOIN ac_remote_implementation_emissions e ON e.operation_id=i.operation_id LEFT JOIN ac_remote_development_snapshots s ON s.workspace_id=w.id
  LEFT JOIN LATERAL(SELECT id FROM ac_artifacts artifact WHERE artifact.implementation_grant_id=i.grant_id AND artifact.implementation_session_id=i.session_id ORDER BY id LIMIT 1) a ON true
  ORDER BY w.created_at DESC,w.id LIMIT 100`,[principal])).rows.map(row=>Object.fromEntries(Object.entries(row).filter(([,value])=>value!==null)));
 return {configured,candidates,workspaces};
}
