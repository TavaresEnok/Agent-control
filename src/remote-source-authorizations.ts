import {createPublicKey,verify} from 'node:crypto';
import type pg from 'pg';
import {z} from 'zod';
import {digest,Id,Refusal} from './contracts.ts';
import {GitObjectId} from './remote-git.ts';
import {operatorMessage,OperatorProof} from './operator.ts';

export const RemoteSourcePayload=z.object({schemaVersion:z.literal(1),intentId:Id,hostId:Id,commit:GitObjectId,tree:GitObjectId}).strict()
 .refine(value=>value.commit.length===value.tree.length);
const SignedCommand=z.object({schemaVersion:z.literal(1),intentId:Id,deliveryAttemptId:Id,contextId:Id,
 action:z.literal('remote.source.authorize'),payload:RemoteSourcePayload}).strict();
type Payload=z.infer<typeof RemoteSourcePayload>;
const commitment=(contextId:string,projectId:string,payload:Payload)=>digest({domain:'agent-control-remote-source-v1',contextId,projectId,...payload});

/** Must run in Control's transaction after operator proof and owner authorization. */
export async function authorizeRemoteSource(c:pg.PoolClient,principal:string,projectId:string,raw:unknown,rawProof:unknown){
 const command=SignedCommand.parse(raw),proof=OperatorProof.parse(rawProof),payload=command.payload;
 if(!(await c.query(`SELECT 1 FROM ac_contexts x JOIN ac_memberships m ON m.project_id=x.project_id
  WHERE x.id=$1 AND x.project_id=$2 AND m.principal_id=$3 AND m.role='owner' AND NOT x.archived`,[command.contextId,projectId,principal])).rowCount)
  throw new Refusal('PROJECT_OWNER_REQUIRED',403);
 const target=(await c.query('SELECT state,parent_intent_id FROM ac_intents WHERE id=$1 AND context_id=$2 FOR UPDATE',[payload.intentId,command.contextId])).rows[0];
 if(!target)throw new Refusal('INTENT_SCOPE_MISMATCH',403);
 if(['done','review','failed','canceled','cancelled','cancellation_requested'].includes(target.state)||
  (await c.query('SELECT 1 FROM ac_plan_cancellations WHERE intent_id=$1 OR intent_id=$2',[payload.intentId,target.parent_intent_id])).rowCount)throw new Refusal('PLAN_ALREADY_TERMINAL');
 const host=(await c.query('SELECT 1 FROM ac_remote_hosts WHERE id=$1 AND project_id=$2 AND enabled AND $3=ANY(allowed_tasks) FOR SHARE',
  [payload.hostId,projectId,'git-export'])).rowCount;
 if(!host)throw new Refusal('REMOTE_TASK_FORBIDDEN',403);
 const key=(await c.query("SELECT public_key FROM ac_operator_keys WHERE id=$1 AND principal_id=$2 AND state='active' FOR SHARE",[proof.deviceId,principal])).rows[0];
 const installation=(await c.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0];
 if(!key||!installation)throw new Refusal('OPERATOR_DEVICE_NOT_ENROLLED',403);
 const hash=commitment(command.contextId,projectId,payload);
 await c.query(`INSERT INTO ac_remote_source_authorizations(control_intent_id,context_id,project_id,intent_id,host_id,commit_id,tree_id,commitment_digest,
  principal_id,operator_command,operator_proof,operator_public_key,installation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
  [command.intentId,command.contextId,projectId,payload.intentId,payload.hostId,payload.commit,payload.tree,hash,principal,command,proof,key.public_key,installation.id]);
 return {authorizationId:command.intentId,kind:'source_read_authorization' as const,commitmentDigest:hash};
}

/** Revalidate durable, signed authorization on every export, including replay. */
export async function requireRemoteSource(c:pg.PoolClient,expected:{contextId:string;projectId:string;intentId:string;hostId:string;commit:string;tree:string}){
 const installation=(await c.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0];
 if(!installation)throw new Refusal('INSTALLATION_IDENTITY_MISSING');
 const rows=(await c.query(`SELECT s.*,i.payload_digest,i.action control_action,i.context_id control_context,i.principal_id control_principal
  FROM ac_remote_source_authorizations s JOIN ac_control_intents i ON i.id=s.control_intent_id
  WHERE s.context_id=$1 AND s.project_id=$2 AND s.intent_id=$3 AND s.host_id=$4 AND s.commit_id=$5 AND s.tree_id=$6 ORDER BY s.created_at,s.control_intent_id LIMIT 100`,
  [expected.contextId,expected.projectId,expected.intentId,expected.hostId,expected.commit,expected.tree])).rows;
 if(!rows.length)throw new Refusal('REMOTE_SOURCE_AUTHORIZATION_REQUIRED',403);
 for(const row of rows){
  const parsed=SignedCommand.safeParse(row.operator_command),proof=OperatorProof.safeParse(row.operator_proof);
  if(!parsed.success||!proof.success)continue;
  const command=parsed.data,{deliveryAttemptId,...semantic}=command;
  if(row.installation_id!==installation.id||row.control_action!=='remote.source.authorize'||row.control_context!==expected.contextId||row.control_principal!==row.principal_id||
   command.intentId!==row.control_intent_id||command.contextId!==expected.contextId||command.payload.intentId!==expected.intentId||
   command.payload.hostId!==expected.hostId||command.payload.commit!==expected.commit||command.payload.tree!==expected.tree||
   row.commitment_digest!==commitment(expected.contextId,expected.projectId,command.payload)||row.payload_digest!==digest({principal:row.principal_id,...semantic}))continue;
  try{
   const key=createPublicKey({key:Buffer.from(row.operator_public_key,'base64'),format:'der',type:'spki'});
   if(key.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(operatorMessage(row.principal_id,command,proof.data,row.installation_id)),key,Buffer.from(proof.data.signature,'hex')))
    return {authorizationId:row.control_intent_id as string,commitmentDigest:row.commitment_digest as string};
  }catch{/* malformed durable proof fails closed */}
 }
 throw new Refusal('REMOTE_SOURCE_AUTHORIZATION_INVALID',403);
}
