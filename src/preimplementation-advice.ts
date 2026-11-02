import {createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {canonical,Id,Refusal} from './contracts.ts';
import {digest,type Authority} from './contracts.ts';
import type pg from 'pg';
import {QualityPolicy} from './quality-policy.ts';
import {ManagedExecutionInput,ManagedRecipe} from './managed-plan.ts';

const Sha256=z.string().regex(/^[a-f0-9]{64}$/);
/** Advice describes the frozen input before implementation; it is not QA. */
export const PreimplementationAdviceReceipt=z.object({schemaVersion:z.literal(1),kind:z.literal('preimplementation_advice'),
 adviceId:Id,contextId:Id,intentId:Id,operationId:Id,unitId:z.string().min(1).max(100),policyRevision:z.number().int().positive(),
 policyDigest:Sha256,sourceBase:z.string().regex(/^[a-f0-9]{40}$/),scopeDigest:Sha256,inputDigest:Sha256,
 sessionId:Id,grantId:Id,status:z.enum(['approved','rejected']),exitCode:z.number().int(),verifierDigest:Sha256}).strict();
export type PreimplementationAdviceReceipt=z.infer<typeof PreimplementationAdviceReceipt>;
const message=(receipt:PreimplementationAdviceReceipt)=>canonical({domain:'agent-control-preimplementation-advice-v1',receipt});
export function signPreimplementationAdvice(key:Uint8Array,raw:unknown){
 if(key.byteLength<32)throw Error('VERIFIER_KEY_TOO_SHORT');
 const receipt=PreimplementationAdviceReceipt.parse(raw);
 return createHmac('sha256',key).update(message(receipt)).digest('hex');
}
export function verifyPreimplementationAdvice(key:Uint8Array,raw:unknown,signature:unknown){
 const receipt=PreimplementationAdviceReceipt.parse(raw);
 if(key.byteLength<32||typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature))throw new Refusal('UNTRUSTED_PREIMPLEMENTATION_ADVICE',403);
 const expected=createHmac('sha256',key).update(message(receipt)).digest(),actual=Buffer.from(signature,'hex');
 if(!timingSafeEqual(expected,actual))throw new Refusal('UNTRUSTED_PREIMPLEMENTATION_ADVICE',403);
 return receipt;
}

/** Call inside the fenced writer transaction, before any physical launch. */
export async function assertPreimplementationAdvice(c:pg.PoolClient,key:Uint8Array,intentId:string,authority:Authority,writer?:{sessionId:string;grantId:string},mode:'writer'|'record'='writer'){
 const row=(await c.query(`SELECT i.id,i.context_id,i.operation_id,i.parent_intent_id,i.parent_unit_id,m.recipe,m.recipe_digest,x.quality_revision,p.snapshot policy,p.digest policy_digest,
  d.snapshot input,d.digest input_digest,d.base_id,a.id advice_id,a.unit_id,a.operation_id advice_operation,a.policy_revision,a.base_id advice_base,
  a.scope_digest,a.input_digest advice_input_digest,a.policy_digest advice_policy_digest,a.session_id,a.attempt_id,a.grant_id,a.manager_epoch,
  a.state advice_state,a.receipt advice_receipt,a.signature,g.role,g.resource_kind,g.intent_id grant_intent,g.context_id grant_context,
  g.attempt_id grant_attempt,g.state grant_state,g.manager_epoch grant_epoch,g.physical_receipt,j.state job_state,j.receipt job_receipt,
  j.context_id job_context,j.grant_id job_grant,j.manager_epoch job_epoch,j.profile job_profile,j.container_id,
  l.context_id launch_context,l.manager_epoch launch_epoch,l.snapshot launch,l.digest launch_digest
  FROM ac_intents i JOIN ac_execution_contracts x ON x.intent_id=i.id JOIN ac_quality_policies p ON p.project_id=x.project_id AND p.revision=x.quality_revision
  LEFT JOIN ac_managed_executions m ON m.parent_intent_id=i.parent_intent_id
  LEFT JOIN ac_managed_delivery_inputs d ON d.intent_id=i.id LEFT JOIN ac_specialist_advice a ON a.intent_id=i.id
  LEFT JOIN ac_capacity_grants g ON g.id=a.grant_id LEFT JOIN ac_sandbox_jobs j ON j.id=a.id
  LEFT JOIN ac_specialist_execution_launches l ON l.advice_id=a.id WHERE i.id=$1 AND i.context_id=$2`,[Id.parse(intentId),authority.contextId])).rows[0];
 if(!row)throw new Refusal('INTENT_SCOPE_MISMATCH',403);
 const policy=QualityPolicy.parse(row.policy);
 if(digest(policy)!==row.policy_digest)throw new Refusal('QUALITY_POLICY_DIGEST_MISMATCH');
 if(!policy.requireSpecialistBeforeImplementation)return;
 const parsed=ManagedExecutionInput.safeParse(row.input);
 if(!parsed.success||digest(parsed.data)!==row.input_digest||parsed.data.base!==row.base_id)throw new Refusal('SPECIALIST_INPUT_MISMATCH');
 const input=parsed.data,scopeDigest=digest({writePaths:input.writePaths,acceptanceRefs:input.acceptanceRefs});
 const recipe=ManagedRecipe.safeParse(row.recipe),unit=recipe.success?recipe.data.units.find(value=>value.id===input.unitId):undefined;
 if(!recipe.success||digest(recipe.data)!==row.recipe_digest||recipe.data.parentIntentId!==row.parent_intent_id||input.parentIntentId!==row.parent_intent_id||
  !unit||unit.intentId!==intentId||unit.operationId!==row.operation_id||unit.kind!=='task'||unit.qualityRevision!==row.quality_revision||
  digest(unit.writePaths)!==digest(input.writePaths)||digest(unit.acceptanceRefs)!==digest(input.acceptanceRefs))throw new Refusal('SPECIALIST_INPUT_MISMATCH');
 if(row.advice_state!=='completed'||!row.advice_receipt)throw new Refusal('PREIMPLEMENTATION_ADVICE_REQUIRED');
 const receipt=verifyPreimplementationAdvice(key,row.advice_receipt,row.signature),physical=row.physical_receipt,advice=physical?.advice;
 if((mode==='writer'&&receipt.status!=='approved')||receipt.exitCode!==0||!policy.specialistVerifierDigest||receipt.verifierDigest!==policy.specialistVerifierDigest||receipt.adviceId!==row.advice_id||receipt.contextId!==authority.contextId||
  receipt.intentId!==intentId||receipt.operationId!==row.operation_id||row.advice_operation!==row.operation_id||receipt.unitId!==input.unitId||
  row.unit_id!==input.unitId||row.parent_unit_id!==input.unitId||receipt.policyRevision!==row.quality_revision||row.policy_revision!==row.quality_revision||
  receipt.policyDigest!==row.policy_digest||row.advice_policy_digest!==row.policy_digest||receipt.sourceBase!==input.base||row.advice_base!==input.base||
  receipt.scopeDigest!==scopeDigest||row.scope_digest!==scopeDigest||receipt.inputDigest!==row.input_digest||row.advice_input_digest!==row.input_digest||
  receipt.sessionId!==row.session_id||receipt.grantId!==row.grant_id||row.role!=='specialist'||row.resource_kind!=='model'||
  row.grant_intent!==intentId||row.grant_context!==authority.contextId||row.grant_attempt!==row.attempt_id||row.grant_state!=='released'||
  Number(row.grant_epoch)!==Number(row.manager_epoch)||Number(row.manager_epoch)>authority.epoch||row.job_state!=='completed'||!physical||!row.job_receipt||
  digest(physical)!==digest(row.job_receipt)||row.job_context!==authority.contextId||row.job_grant!==row.grant_id||
  Number(row.job_epoch)!==Number(row.manager_epoch)||row.job_profile!=='synthetic-specialist-v1'||physical.jobId!==row.advice_id||
  !/^[a-f0-9]{64}$/.test(physical.containerId??'')||physical.containerId!==row.container_id||typeof physical.finishedAt!=='string'||
  !physical.finishedAt||physical.finishedAt.startsWith('0001-')||physical.exitCode!==0||physical.synthetic!==true||
  physical.adviceIsolation?.readOnlySnapshot!==true||physical.adviceIsolation?.uid!==10001||!Array.isArray(physical.adviceIsolation?.visible)||physical.adviceIsolation.visible.length!==0||
  !row.launch||row.launch_context!==authority.contextId||Number(row.launch_epoch)!==Number(row.manager_epoch)||digest(row.launch)!==row.launch_digest||
  row.launch.profile!=='synthetic-specialist-v1'||row.launch.source?.base!==input.base||
  !advice||advice.verdict!==(receipt.status==='approved'?'proceed':'reject')||advice.adviceId!==row.advice_id||advice.intentId!==intentId||advice.operationId!==row.operation_id||
  advice.unitId!==input.unitId||advice.policyRevision!==row.quality_revision||advice.scopeDigest!==scopeDigest||advice.inputDigest!==row.input_digest||
  advice.policyDigest!==row.policy_digest||advice.sourceBase!==input.base||advice.verifierDigest!==receipt.verifierDigest||
  (writer&&(writer.sessionId===receipt.sessionId||writer.grantId===receipt.grantId)))throw new Refusal('PREIMPLEMENTATION_ADVICE_INVALID');
 return receipt;
}
