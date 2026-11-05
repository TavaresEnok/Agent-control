import pg from 'pg';
import {Authority,Refusal,digest} from './contracts.ts';
import {Ledger} from './ledger.ts';
import {Capacity} from './capacity.ts';
import {requireProjectEnvironment,requireProjectEnvironmentLaunch} from './project-environments.ts';
import {remoteImplementationWritePaths} from './remote-write-paths.ts';

type Input={workspaceId:string;operationId:string;contextId:string;intentId:string;taskId:string};
/** A no-effect receipt is local controller evidence, never a remote terminal log.
 * This function can only settle a pending emission and a still-reserved grant.
 */
async function rejectBeforeEmission(c:pg.PoolClient,ledger:Ledger,principal:string,input:Input,authority:Authority,reason:string){
 const rejected=await c.query(`UPDATE ac_remote_implementation_emissions e SET phase='no_effect',reason=$4
  FROM ac_remote_development_implementations i,ac_capacity_grants g
  WHERE e.operation_id=$1 AND e.workspace_id=$2 AND e.manager_epoch=$3 AND e.phase='pending'
   AND i.workspace_id=e.workspace_id AND i.operation_id=e.operation_id AND i.grant_id=e.grant_id
   AND g.id=e.grant_id AND g.state='reserved' AND g.context_id=$5 AND g.intent_id=$6 AND g.manager_epoch=$3
  RETURNING e.grant_id`,[input.operationId,input.workspaceId,authority.epoch,reason,input.contextId,input.intentId]);
 if(!rejected.rowCount)throw new Refusal('REMOTE_IMPLEMENTATION_EMISSION_UNCERTAIN');
 const grantId=rejected.rows[0].grant_id;
 await new Capacity(ledger,c).transition(principal,grantId,authority,'released',{processId:input.operationId,state:'not_started'});
 const receipt={schemaVersion:1,kind:'no_effect',source:'controller-preflight',operationId:input.operationId,workspaceId:input.workspaceId,grantId,managerEpoch:authority.epoch,reason,exitCode:1};
 await c.query("UPDATE ac_operations SET state='completed',receipt=$2 WHERE id=$1 AND grant_id=$3 AND manager_epoch=$4",[input.operationId,receipt,grantId,authority.epoch]);
 // This admission was never emitted. Keep its immutable binding and no-effect
 // journal, while removing only the un-emitted remote transport reservation.
 const removed=await c.query("DELETE FROM ac_remote_operations WHERE id=$1 AND context_id=$2 AND intent_id=$3 AND state='uncertain' AND remote_receipt IS NULL",[input.operationId,input.contextId,input.intentId]);
 if(removed.rowCount!==1)throw new Refusal('REMOTE_IMPLEMENTATION_EMISSION_UNCERTAIN');
 await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'remote.implementation.no_effect',$2)",[input.contextId,receipt]);
 return {blocked:reason} as const;
}

export async function beginRemoteImplementationEmission(c:pg.PoolClient,ledger:Ledger,principal:string,input:Input,authority:Authority){
 const locked=await c.query(`SELECT a.id FROM ac_remote_development_implementations i JOIN ac_capacity_grants g ON g.id=i.grant_id JOIN ac_accounts a ON a.id=g.account_id
  WHERE i.workspace_id=$1 AND i.operation_id=$2 FOR SHARE OF a`,[input.workspaceId,input.operationId]);
 if(!locked.rowCount)throw new Refusal('REMOTE_IMPLEMENTATION_BINDING_REQUIRED');
 const eligible=await c.query(`SELECT g.id FROM ac_remote_development_implementations i JOIN ac_capacity_grants g ON g.id=i.grant_id JOIN ac_profiles p ON p.id=g.profile_id JOIN ac_accounts a ON a.id=g.account_id
  JOIN ac_account_access access ON access.account_id=a.id AND access.project_id=g.project_id
  WHERE i.workspace_id=$1 AND i.operation_id=$2 AND i.task_id=$3 AND g.context_id=$4 AND g.intent_id=$5 AND g.manager_epoch=$6
   AND g.state='reserved' AND g.role='programmer' AND p.role='programmer' AND p.enabled AND a.enabled AND a.mode='synthetic'
   AND a.eligibility='documented_supported' AND ac_profile_quota_status(a.id,p.model)='available' FOR SHARE OF p`,
  [input.workspaceId,input.operationId,input.taskId,input.contextId,input.intentId,authority.epoch]);
 if(!eligible.rowCount)return rejectBeforeEmission(c,ledger,principal,input,authority,'REMOTE_IMPLEMENTATION_START_NOT_ELIGIBLE');
 // Recheck environment/source/path authority at the final emission fence, not
 // only at reservation. Any deterministic preflight refusal remains no-effect.
 try{
  const bound=(await c.query(`SELECT w.*,i.input_snapshot,i.input_digest,g.profile_id FROM ac_remote_development_workspaces w
   JOIN ac_remote_development_implementations i ON i.workspace_id=w.id JOIN ac_capacity_grants g ON g.id=i.grant_id
   WHERE w.id=$1 AND i.operation_id=$2`,[input.workspaceId,input.operationId])).rows[0];
  if(!bound||digest(bound.input_snapshot)!==bound.input_digest)throw new Refusal('REMOTE_IMPLEMENTATION_BINDING_REQUIRED');
  if(bound.input_snapshot.profileId&&bound.input_snapshot.profileId!==bound.profile_id)throw new Refusal('REMOTE_IMPLEMENTATION_BINDING_CONFLICT');
  const paths=remoteImplementationWritePaths(bound.input_snapshot.writePaths,bound.input_snapshot.profileWritePaths);
  const scope=(await c.query('SELECT snapshot,digest FROM ac_project_environment_write_scopes WHERE intent_id=$1',[input.intentId])).rows[0];
  if(scope){
   if(digest(scope.snapshot)!==scope.digest||scope.snapshot.source!=='remote-fixed-task'||scope.snapshot.hostId!==bound.host_id||scope.snapshot.taskId!==input.taskId)throw new Refusal('REMOTE_IMPLEMENTATION_BINDING_CONFLICT');
   remoteImplementationWritePaths(paths,scope.snapshot.writePaths);
  }
  await requireProjectEnvironment(c,{projectId:bound.project_id,contextId:input.contextId,intentId:input.intentId,hostId:bound.host_id,destinationRef:bound.input_snapshot.targetRef,purpose:'remote-development'});
  await requireProjectEnvironmentLaunch(c,{intentId:input.intentId,base:bound.source_commit,targetRef:bound.input_snapshot.targetRef});
 }catch(error){if(error instanceof Refusal)return rejectBeforeEmission(c,ledger,principal,input,authority,error.code);throw error;}
 // The row and its FK parents were committed during implementation binding;
 // this independent autocommit does not depend on uncommitted outer writes.
 // The outer transaction still holds authority, intent and physical-account
 // locks. An error after this point is uncertain, including a controller crash
 // before the SSH call; a retry may reconcile, never blindly start again.
 const marker=new pg.Client({...ledger.pool.options,connectionTimeoutMillis:3000,query_timeout:5000,statement_timeout:5000,application_name:'ac-remote-emission'});
 let entered:pg.QueryResult;
 try{
  await marker.connect();
  entered=await marker.query(`UPDATE ac_remote_implementation_emissions SET phase='emitting',entered_at=clock_timestamp()
   WHERE operation_id=$1 AND workspace_id=$2 AND manager_epoch=$3 AND phase='pending' RETURNING grant_id`,[input.operationId,input.workspaceId,authority.epoch]);
 }finally{await marker.end();}
 if(entered.rowCount!==1)throw new Refusal('REMOTE_IMPLEMENTATION_EMISSION_UNCERTAIN');
 await c.query("UPDATE ac_capacity_grants SET state='running' WHERE id=$1 AND state='reserved'",[eligible.rows[0].id]);
 await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'remote.implementation.emitting',$2)",[input.contextId,{operationId:input.operationId,workspaceId:input.workspaceId,grantId:eligible.rows[0].id,requestIdentity:digest(input)}]);
 return {blocked:undefined};
}
