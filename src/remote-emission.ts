import type pg from 'pg';
import {Authority,Refusal,digest} from './contracts.ts';
import {Ledger} from './ledger.ts';
import {Capacity} from './capacity.ts';

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
 // The row and its FK parents were committed during implementation binding;
 // this independent autocommit does not depend on uncommitted outer writes.
 // The outer transaction still holds authority, intent and physical-account
 // locks. An error after this point is uncertain, including a controller crash
 // before the SSH call; a retry may reconcile, never blindly start again.
 const entered=await ledger.pool.query(`UPDATE ac_remote_implementation_emissions SET phase='emitting',entered_at=clock_timestamp()
  WHERE operation_id=$1 AND workspace_id=$2 AND manager_epoch=$3 AND phase='pending' RETURNING grant_id`,[input.operationId,input.workspaceId,authority.epoch]);
 if(entered.rowCount!==1)throw new Refusal('REMOTE_IMPLEMENTATION_EMISSION_UNCERTAIN');
 await c.query("UPDATE ac_capacity_grants SET state='running' WHERE id=$1 AND state='reserved'",[eligible.rows[0].id]);
 await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'remote.implementation.emitting',$2)",[input.contextId,{operationId:input.operationId,workspaceId:input.workspaceId,grantId:eligible.rows[0].id,requestIdentity:digest(input)}]);
 return {blocked:undefined};
}
