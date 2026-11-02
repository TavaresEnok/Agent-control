import {z} from 'zod';
import {createHash,createPublicKey,verify} from 'node:crypto';
import type pg from 'pg';
import {Authority,Id,Refusal,digest,canonical} from './contracts.ts';
import {Ledger} from './ledger.ts';
import {inspectAdministrativeCapability} from './managers.ts';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const name=z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/);
const policyEntry=z.object({id:name,version:z.number().int().positive(),executorDigest:hash,receiptKeyFingerprint:hash,managerProfileIds:z.array(z.string().min(1).max(100)).min(1).max(50)}).strict();
export const AdministrativePolicy=z.object({operations:z.array(policyEntry).max(100)}).strict().superRefine((value,ctx)=>{
 if(new Set(value.operations.map(x=>`${x.id}\0${x.version}`)).size!==value.operations.length)ctx.addIssue({code:'custom',message:'DUPLICATE_ADMIN_OPERATION'});
});
const Request=z.object({operationId:Id,intentId:Id,id:name,version:z.number().int().positive(),policyRevision:z.number().int().positive(),parameters:z.unknown()}).strict();
const Receipt=z.object({payload:z.object({operationId:Id,intentId:Id,contextId:Id,epoch:z.number().int().positive(),policyRevision:z.number().int().positive(),id:name,version:z.number().int().positive(),executorDigest:hash,parametersDigest:hash,state:z.literal('exited'),exitCode:z.literal(0),resultDigest:hash}).strict(),signature:z.string().regex(/^[a-f0-9]{128}$/)}).strict();
type Receipt=z.infer<typeof Receipt>;
type Invocation={operationId:string;contextId:string;intentId:string;parameters:unknown;authority:Authority;executionEpoch:number;policyRevision:number;parametersDigest:string;assertAuthorized:()=>Promise<void>};
export const administrativeReceiptMessage=(payload:Receipt['payload'])=>Buffer.from('agent-control:administrative-receipt:v1\n'+canonical(payload));
export type RegisteredAdministrativeOperation={id:string;version:number;digest:string;parametersSchema:z.ZodType;
 receiptPublicKey:string;execute:(input:Invocation)=>Promise<unknown>;reconcile:(input:Invocation)=>Promise<unknown|null>};
export type AdministrativeCapability=object;
type CapabilityData=NonNullable<ReturnType<typeof inspectAdministrativeCapability>>;
function freezeJson(value:unknown):unknown{
 if(value&&typeof value==='object'){for(const child of Object.values(value))freezeJson(child);Object.freeze(value);}
 return value;
}

/** Registered callbacks are trusted controller code; never expose this service or its issuer to workers. */
export class AdministrativeOperations{
 private readonly operations=new Map<string,RegisteredAdministrativeOperation>();
 constructor(readonly ledger:Ledger,registered:readonly RegisteredAdministrativeOperation[]){
  for(const item of registered){name.parse(item.id);z.number().int().positive().parse(item.version);hash.parse(item.digest);
   const publicKey=createPublicKey({key:Buffer.from(item.receiptPublicKey,'base64'),format:'der',type:'spki'});if(publicKey.asymmetricKeyType!=='ed25519')throw new Refusal('ADMIN_RECEIPT_KEY_INVALID');
   const key=`${item.id}\0${item.version}`;if(this.operations.has(key))throw new Refusal('ADMIN_OPERATION_DUPLICATE');
   this.operations.set(key,Object.freeze({...item}));}
 }
 catalog(){
  return [...this.operations.values()].map(entry=>({id:entry.id,version:entry.version,executorDigest:entry.digest,
   receiptKeyFingerprint:createHash('sha256').update(Buffer.from(entry.receiptPublicKey,'base64')).digest('hex')}));
 }
 async publish(c:pg.PoolClient,principal:string,contextId:string,expectedRevision:number,raw:z.input<typeof AdministrativePolicy>){
  const policy=AdministrativePolicy.parse(raw);Id.parse(contextId);z.number().int().nonnegative().parse(expectedRevision);
  const context=await this.ledger.authorize(c,principal,contextId);if(context.role!=='owner')throw new Refusal('PROJECT_OWNER_REQUIRED',403);
  const latest=Number((await c.query('SELECT COALESCE(max(revision),0) revision FROM ac_administrative_policies WHERE context_id=$1',[contextId])).rows[0].revision);
  if(latest!==expectedRevision)throw new Refusal('ADMIN_POLICY_REVISION_CONFLICT');
  const revision=latest+1;await c.query('INSERT INTO ac_administrative_policies(context_id,revision,digest,snapshot,published_by) VALUES($1,$2,$3,$4,$5)',[contextId,revision,digest(policy),policy,principal]);
  return {revision};
 }
 private async validate(c:pg.PoolClient,cap:CapabilityData,request:z.infer<typeof Request>,entry:RegisteredAdministrativeOperation,mode:'effect'|'observe'){
  if(!cap.live())throw new Refusal('ADMIN_CAPABILITY_REVOKED',403);
  const context=await this.ledger.authorize(c,cap.principal,cap.authority.contextId);if(context.role!=='owner')throw new Refusal('PROJECT_OWNER_REQUIRED',403);
  await this.ledger.fence(c,cap.authority,mode==='observe');
  const manager=(await c.query('SELECT profile_id FROM ac_managers WHERE context_id=$1',[cap.authority.contextId])).rows[0];
  if(manager?.profile_id!==cap.profileId)throw new Refusal('ADMIN_PROFILE_MISMATCH',403);
  const policy=(await c.query('SELECT revision,digest,snapshot FROM ac_administrative_policies WHERE context_id=$1 AND revision=$2',[cap.authority.contextId,request.policyRevision])).rows[0];
  if(!policy)throw new Refusal('ADMIN_POLICY_REVISION_CONFLICT');
  if(mode==='effect'&&(await c.query('SELECT max(revision) revision FROM ac_administrative_policies WHERE context_id=$1',[cap.authority.contextId])).rows[0].revision!==request.policyRevision)throw new Refusal('ADMIN_POLICY_REVISION_CONFLICT');
  const snapshot=AdministrativePolicy.parse(policy.snapshot);if(digest(snapshot)!==policy.digest)throw new Refusal('ADMIN_POLICY_DIGEST_MISMATCH');
  const allowed=snapshot.operations.find(x=>x.id===request.id&&x.version===request.version);
  const fingerprint=createHash('sha256').update(Buffer.from(entry.receiptPublicKey,'base64')).digest('hex');
  if(!allowed||allowed.executorDigest!==entry.digest||allowed.receiptKeyFingerprint!==fingerprint||(mode==='effect'&&!allowed.managerProfileIds.includes(cap.profileId)))throw new Refusal('ADMIN_OPERATION_FORBIDDEN',403);
  if(mode==='effect')await this.ledger.assertIntentActive(c,cap.authority.contextId,request.intentId);
 }
 async execute(token:AdministrativeCapability,raw:unknown){
  const cap=inspectAdministrativeCapability(token);if(!cap||cap.service!==this)throw new Refusal('ADMIN_CAPABILITY_REQUIRED',403);
  const request=Request.parse(raw),entry=this.operations.get(`${request.id}\0${request.version}`);if(!entry)throw new Refusal('ADMIN_OPERATION_UNKNOWN',403);
  const encoded=canonical(entry.parametersSchema.parse(request.parameters));if(Buffer.byteLength(encoded)>65536)throw new Refusal('ADMIN_PARAMETERS_TOO_LARGE',400);
  const parameters=freezeJson(JSON.parse(encoded)),parameterDigest=digest(parameters);
  const identity={contextId:cap.authority.contextId,intentId:request.intentId,principal:cap.principal,id:request.id,version:request.version,
   executorDigest:entry.digest,parameterDigest,policyRevision:request.policyRevision,profileId:cap.profileId};
  const decision=await this.ledger.tx(async c=>{
   await this.validate(c,cap,request,entry,'observe');
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7))',[request.operationId]);
   let row=(await c.query('SELECT * FROM ac_administrative_operations WHERE id=$1 FOR UPDATE',[request.operationId])).rows[0];
   if(row){
    if(row.context_id!==identity.contextId||row.intent_id!==identity.intentId||row.principal_id!==identity.principal||row.operation_name!==identity.id||row.operation_version!==identity.version||row.executor_digest!==identity.executorDigest||row.parameter_digest!==identity.parameterDigest||row.policy_revision!==identity.policyRevision)throw new Refusal('ADMIN_OPERATION_ID_CONFLICT');
    if(row.state==='completed')return {kind:'completed' as const,receipt:row.receipt,epoch:Number(row.manager_epoch)};
    if(row.state==='uncertain'||row.state==='running')return {kind:'reconcile' as const,epoch:Number(row.manager_epoch)};
   }
   await this.validate(c,cap,request,entry,'effect');
   if(!row){
    await c.query(`INSERT INTO ac_administrative_operations(id,context_id,intent_id,principal_id,operation_name,operation_version,executor_digest,parameter_digest,policy_revision,manager_profile_id,manager_epoch,state)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'registered')`,[request.operationId,identity.contextId,identity.intentId,identity.principal,identity.id,identity.version,identity.executorDigest,identity.parameterDigest,identity.policyRevision,identity.profileId,cap.authority.epoch]);
   }
   await c.query('SELECT pg_advisory_xact_lock(189234,47)');
   if((await c.query("SELECT 1 FROM ac_administrative_operations WHERE state IN ('running','uncertain')")).rowCount)return {kind:'busy' as const};
   await c.query("UPDATE ac_administrative_operations SET state='uncertain',manager_epoch=$2,manager_profile_id=$3 WHERE id=$1",[request.operationId,cap.authority.epoch,cap.profileId]);
   return {kind:'execute' as const,epoch:cap.authority.epoch};
  });
  if(decision.kind==='busy')throw new Refusal('ADMIN_CAPACITY_BUSY');
  const checkReceipt=(raw:unknown):Receipt=>{
   const parsed=Receipt.safeParse(raw);if(!parsed.success)throw new Refusal('ADMIN_OPERATION_UNCERTAIN');
   const p=parsed.data.payload;
   if(p.operationId!==request.operationId||p.intentId!==request.intentId||p.contextId!==identity.contextId||p.epoch!==decision.epoch||p.policyRevision!==request.policyRevision||p.id!==request.id||p.version!==request.version||p.executorDigest!==entry.digest||p.parametersDigest!==parameterDigest)throw new Refusal('ADMIN_OPERATION_UNCERTAIN');
   const key=createPublicKey({key:Buffer.from(entry.receiptPublicKey,'base64'),format:'der',type:'spki'});
   if(!verify(null,administrativeReceiptMessage(p),key,Buffer.from(parsed.data.signature,'hex')))throw new Refusal('ADMIN_OPERATION_UNCERTAIN');
   return parsed.data;
  };
  if(decision.kind==='completed')return {state:'completed' as const,receipt:checkReceipt(decision.receipt)};
  const assertAuthorized=async()=>this.ledger.tx(c=>this.validate(c,cap,request,entry,decision.kind==='reconcile'?'observe':'effect'));
  const invocation:Invocation={operationId:request.operationId,contextId:identity.contextId,intentId:request.intentId,parameters,authority:{...cap.authority},executionEpoch:decision.epoch,policyRevision:request.policyRevision,parametersDigest:parameterDigest,assertAuthorized};
  let result:unknown;
  try{result=decision.kind==='execute'?await entry.execute(invocation):await entry.reconcile(invocation);}
  catch{throw new Refusal('ADMIN_OPERATION_UNCERTAIN');}
  const receipt=checkReceipt(result);
  await this.ledger.tx(async c=>{
   await this.validate(c,cap,request,entry,'observe');
   const row=(await c.query('SELECT state,receipt FROM ac_administrative_operations WHERE id=$1 FOR UPDATE',[request.operationId])).rows[0];
   if(row?.state==='completed'){if(digest(row.receipt)!==digest(receipt))throw new Refusal('ADMIN_RECEIPT_CONFLICT');return;}
   if(!row||!['uncertain','running'].includes(row.state))throw new Refusal('ADMIN_OPERATION_STATE_CONFLICT');
   await c.query("UPDATE ac_administrative_operations SET state='completed',receipt=$2 WHERE id=$1",[request.operationId,receipt]);
  });
  return {state:'completed' as const,receipt};
 }
}
