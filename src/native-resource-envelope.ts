import {ReconciliationHistory} from './reconciliation-history.ts';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {z} from 'zod';
import {DockerDaemon} from './sandbox-broker.ts';
import {digest,Refusal} from './contracts.ts';
import {requireRecoveryInventory,type RecoveryInventoryCapability} from './recovery-inventory.ts';
import pg from 'pg';
/** Trusted injection only. Provisioning is a separate disposable-lab action.
 * Every group shares the same kernel parent across controllers/state roots. */
export const NativeResourceEnvelope=z.object({stateRoot:z.string().refine(p=>resolve(p)===p),
 installationId:z.string().min(1).max(128),authorityEpoch:z.number().int().positive(),resourceAuthority:z.object({
 authorityId:z.string().regex(/^ac-r3-resources-[a-zA-Z0-9_.:-]{1,100}$/),anchorId:z.string().regex(/^[a-f0-9]{64}$/),
 cpuQuotaMicros:z.number().int().min(1000).max(1e9),cpuPeriodMicros:z.number().int().min(1000).max(1e6),
 memoryBytes:z.number().int().min(16777216).max(1099511627776),pidsLimit:z.number().int().min(4).max(1e6),maxJobs:z.number().int().min(1).max(10000)}).strict()}).strict();
export type NativeResourceEnvelope=z.infer<typeof NativeResourceEnvelope>;
const bridge=fileURLToPath(new URL('../services/remote-worker/native_resource_bridge.py',import.meta.url));
export class NativeResourceDockerDaemon extends DockerDaemon{
 private readonly envelope:NativeResourceEnvelope;private readonly admissions=new Map<string,string>();private readonly admissionAttempts=new Map<string,string>();
 private inventory?:RecoveryInventoryCapability;
 private inventoryLedger?:import('./ledger.ts').Ledger;
 get stateRoot(){return this.envelope.stateRoot;}
 get authorityId(){return this.envelope.resourceAuthority.authorityId;}
 constructor(raw:NativeResourceEnvelope){super();this.envelope=NativeResourceEnvelope.parse(raw);}
 bindRecoveryInventory(inventory:RecoveryInventoryCapability){if(this.envelope.authorityEpoch!==inventory.config.epoch)throw new Refusal('RECOVERY_PHYSICAL_EPOCH_MISMATCH');this.inventory=inventory;}
 bindRecoveryLedger(ledger:import('./ledger.ts').Ledger){if(this.inventoryLedger&&this.inventoryLedger!==ledger)throw new Refusal('RECOVERY_INVENTORY_POLICY_MISMATCH');this.inventoryLedger=ledger;}
 async callResource(action:string,value:Record<string,unknown>):Promise<any>{
  if(this.inventoryLedger&&['admit','create','start'].includes(action)){
   const ledger=this.inventoryLedger;
   // Dedicated client avoids exhausting the Ledger pool when every outer
   // domain transaction concurrently waits for a nested physical operation.
   const c=new pg.Client(ledger.pool.options);await c.connect();
   try{await c.query('BEGIN');const inventory=await requireRecoveryInventory(c,ledger);if(inventory)this.bindRecoveryInventory(inventory);else this.inventory=undefined;const result=await this.callResourceFenced(action,value);await c.query('COMMIT');return result;}
   catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{await c.end();}
  }
  return this.callResourceFenced(action,value);
 }
 private async callResourceFenced(action:string,value:Record<string,unknown>):Promise<any>{
  const identity={installationId:this.envelope.installationId,authorityId:this.envelope.resourceAuthority.authorityId,anchorId:this.envelope.resourceAuthority.anchorId,stateRoot:this.envelope.stateRoot};
  const lease=this.inventory&&['admit','create','start'].includes(action)?await this.inventory.lease('native',this.authorityId+':'+this.stateRoot,identity,digest({action,value})):undefined;
  try{
  return await new Promise((resolve,reject)=>{
   const child=spawn('/usr/bin/python3',[bridge],{env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'},stdio:['pipe','pipe','pipe']});let bytes=0,output='',failed=false;
   const timer=setTimeout(()=>{failed=true;child.kill('SIGKILL');},25000);
   child.stdout.on('data',(data:Buffer)=>{bytes+=data.length;if(bytes>1048576){failed=true;child.kill('SIGKILL');}else output+=data.toString('utf8');});
   child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});child.once('error',()=>{failed=true;});
   child.once('close',code=>{clearTimeout(timer);if(failed)return reject(new Refusal('NATIVE_RESOURCE_UNCERTAIN'));let result:any;try{result=JSON.parse(output);}catch{return reject(new Refusal('NATIVE_RESOURCE_UNCERTAIN'));}
    if(code!==0||result.error)return reject(new Refusal(typeof result.error==='string'&&/^[A-Z][A-Z0-9_]{1,100}$/.test(result.error)?result.error:'NATIVE_RESOURCE_UNCERTAIN'));resolve(result);});
   const {stateRoot,...authority}=this.envelope;child.stdin.end(JSON.stringify({action,authority,stateRoot,...value}));
  });
  }finally{await lease?.release();}
 }
 bindAdmission(names:string[],token:string){for(const name of names){this.admissions.set(name,token);this.admissionAttempts.set(name,token);}}
 async admit(names:string[],allowed:()=>Promise<boolean>,persist?:(token:string)=>Promise<void>,token?:string){
  const admissionId=token??randomUUID();for(const name of names)this.admissionAttempts.set(name,admissionId);if(persist)await persist(admissionId);
  for(;;){if(!await allowed()){await new Promise(r=>setTimeout(r,100));continue;}
   try{await this.callResource('admit',{names,admissionId});for(const name of names)this.admissions.set(name,admissionId);break;}catch(error){if(!(error instanceof Refusal)||error.code!=='RESOURCE_CAPACITY_EXHAUSTED')throw error;await new Promise(r=>setTimeout(r,100));}}
  while(!await allowed())await new Promise(r=>setTimeout(r,100));
 }
 async cancelAdmission(names:string[],token?:string){const admissionId=token??this.admissionAttempts.get(names[0]);if(!admissionId)throw new Refusal('NATIVE_RESOURCE_ADMISSION_UNCERTAIN');const result=await this.callResource('cancel_admission',{names,admissionId});if(result.proof!=='no_groups_no_create_claims')throw new Refusal('NATIVE_RESOURCE_ADMISSION_UNCERTAIN');for(const name of names)this.admissions.delete(name);return {state:'not_started' as const,source:'native-resource-host-absence' as const};}
 override async create(name:string,configuration:object){return z.string().regex(/^[a-f0-9]{64}$/).parse((await this.callResource('create',{name,configuration,admissionId:this.admissions.get(name)})).id);}
 override async start(id:string){await this.callResource('start',{id});}
 override async stop(id:string){await this.callResource('stop',{id});}
 override async remove(id:string){await this.callResource('remove',{id});}
 override async inspect(id:string){const result=await this.callResource('inspect',{id});return result.absent?null:result.physical as NonNullable<Awaited<ReturnType<DockerDaemon['inspect']>>>;}
}
export function nativeDockerDaemon(socketPath?:string,envelope?:NativeResourceEnvelope):DockerDaemon{
 if(!envelope)return new DockerDaemon(socketPath);
 if(socketPath&&socketPath!=='/var/run/docker.sock')throw new Refusal('NATIVE_RESOURCE_SOCKET_MISMATCH');
 return new NativeResourceDockerDaemon(envelope);
}

/** Nonce is committed before any host reservation. Every physical attempt runs
 * while the context fence is locked, so takeover cannot race a stale cleanup. */
export async function admitNativeResources(input:{docker:DockerDaemon;ledger:import('./ledger.ts').Ledger;principal:string;
 authority:import('./contracts.ts').Authority;intentId:string;grantId:string;jobId:string;names:string[];isCanceled?:()=>boolean}){
 const inventory=await input.ledger.tx(c=>requireRecoveryInventory(c,input.ledger));
 if(!(input.docker instanceof NativeResourceDockerDaemon)){if(inventory)throw new Refusal('RECOVERY_PHYSICAL_AUTHORITY_REQUIRED');return;}
 const docker=input.docker;
 docker.bindRecoveryLedger(input.ledger);
 if(inventory)docker.bindRecoveryInventory(inventory);
 const validate=async(c:import('pg').PoolClient,active:boolean)=>{
  const context=await input.ledger.authorize(c,input.principal,input.authority.contextId);
  await input.ledger.fence(c,input.authority,true);
  const grant=(await c.query('SELECT * FROM ac_capacity_grants WHERE id=$1 FOR UPDATE',[input.grantId])).rows[0];
  if(!grant||grant.context_id!==input.authority.contextId||grant.intent_id!==input.intentId||Number(grant.manager_epoch)!==input.authority.epoch||grant.state!=='reserved')throw new Refusal('NATIVE_RESOURCE_GRANT_MISMATCH');
  if(active){if(input.isCanceled?.())throw new Refusal('STAGE_CANCELED');await input.ledger.assertIntentActive(c,input.authority.contextId,input.intentId);}
  return context;
 };
 // Validation errors before ownership is established must never touch a foreign
 // admission or grant, even when a local cancellation is already requested.
 const token=await input.ledger.tx(async c=>{
  await validate(c,false);
  const prior=(await c.query('SELECT * FROM ac_native_resource_admissions WHERE job_id=$1 FOR UPDATE',[input.jobId])).rows[0];
  const reusable=prior?.state==='canceled'&&prior.proof?.source==='native-resource-host-absence'&&Boolean((await c.query("SELECT 1 FROM ac_capacity_grants WHERE id=$1 AND context_id=$2 AND intent_id=$3 AND state='released'",[prior.grant_id,input.authority.contextId,input.intentId])).rowCount);
  if(prior&&(prior.context_id!==input.authority.contextId||JSON.stringify(prior.names)!==JSON.stringify(input.names)||prior.authority_id!==docker.authorityId||prior.state_root!==docker.stateRoot||(!reusable&&(prior.grant_id!==input.grantId||Number(prior.manager_epoch)!==input.authority.epoch||!['waiting','admitted'].includes(prior.state)))))throw new Refusal('NATIVE_RESOURCE_ADMISSION_UNCERTAIN');
  if(prior&&!reusable)return prior.admission_id as string;
  const nonce=randomUUID();
  await c.query(`INSERT INTO ac_native_resource_admissions(job_id,grant_id,context_id,manager_epoch,authority_id,names,state_root,admission_id,state,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'waiting','physical_capacity') ON CONFLICT(job_id) DO UPDATE SET grant_id=$2,manager_epoch=$4,admission_id=$8,state='waiting',reason='physical_capacity',proof=NULL,updated_at=clock_timestamp()`,[input.jobId,input.grantId,input.authority.contextId,input.authority.epoch,docker.authorityId,JSON.stringify(input.names),docker.stateRoot,nonce]);
  return nonce;
 });
 try{
  for(;;){
   const admitted=await input.ledger.tx(async c=>{
    const context=await validate(c,true);
    if(context.paused){await c.query("UPDATE ac_native_resource_admissions SET reason='human_pause',updated_at=clock_timestamp() WHERE job_id=$1",[input.jobId]);return false;}
    try{await docker.callResource('admit',{names:input.names,admissionId:token});}
    catch(error){if(error instanceof Refusal&&error.code==='RESOURCE_CAPACITY_EXHAUSTED'){await c.query("UPDATE ac_native_resource_admissions SET reason='physical_capacity',updated_at=clock_timestamp() WHERE job_id=$1",[input.jobId]);return false;}throw error;}
    await c.query("UPDATE ac_native_resource_admissions SET state='admitted',reason='admitted',updated_at=clock_timestamp() WHERE job_id=$1",[input.jobId]);return true;
   });
   if(admitted){docker.bindAdmission(input.names,token);return;}
   await new Promise(r=>setTimeout(r,100));
  }
 }catch(error){
  try{await input.ledger.tx(async c=>{
   await validate(c,false);
   const row=(await c.query('SELECT * FROM ac_native_resource_admissions WHERE job_id=$1 AND grant_id=$2 AND context_id=$3 AND manager_epoch=$4 AND admission_id=$5 FOR UPDATE',[input.jobId,input.grantId,input.authority.contextId,input.authority.epoch,token])).rows[0];
   if(!row)throw new Refusal('NATIVE_RESOURCE_ADMISSION_UNCERTAIN');
   let proof;try{proof=await docker.cancelAdmission(input.names,token);}catch{}
   await c.query("UPDATE ac_native_resource_admissions SET state=$2,reason=$2,proof=$3,updated_at=clock_timestamp() WHERE job_id=$1",[input.jobId,proof?'canceled':'uncertain',proof??null]);
   if(proof)await recoverNeverCreatedManagedWriter(c,{jobId:input.jobId,grantId:input.grantId,authority:input.authority,admission:row,proof});
   await c.query("UPDATE ac_capacity_grants SET state=$2,physical_receipt=$3 WHERE id=$1",[input.grantId,proof?'released':'uncertain',proof??null]);
  });}catch{}
  throw error;
 }
}

/** One finite history page per tick. A successor neutralizes an abandoned
 * pre-journal batch only with host absence proof; normal operation replay then
 * reserves a new attempt. Healthy current-epoch waits remain active. */
export async function reconcileNativeResourceAdmissions(input:{docker:DockerDaemon;ledger:import('./ledger.ts').Ledger;principal:string;authority:import('./contracts.ts').Authority;recoverJob?:(jobId:string)=>Promise<unknown>;recoverSource?:'ac_native_planning_jobs'|'ac_native_execution_jobs'|'ac_native_qa_jobs'}){
 if(!(input.docker instanceof NativeResourceDockerDaemon))return;
 const docker=input.docker,errors:unknown[]=[];
 await new ReconciliationHistory(input.ledger).run(input.authority,'native-resource:'+docker.authorityId+':'+docker.stateRoot+':'+(input.recoverSource??'prejournal'),'ac_native_resource_admissions',async(ids,retain)=>{
  const rows=await input.ledger.tx(async c=>{await input.ledger.authorize(c,input.principal,input.authority.contextId);await input.ledger.fence(c,input.authority,true);return (await c.query(`SELECT r.*,g.intent_id FROM ac_native_resource_admissions r JOIN ac_capacity_grants g ON g.id=r.grant_id JOIN ac_intents i ON i.id=g.intent_id
   WHERE r.context_id=$1 AND r.authority_id=$2 AND r.state_root=$3 AND ((r.state<>'canceled' AND g.state<>'released') OR (r.state='canceled' AND g.state='released' AND EXISTS(
     SELECT 1 FROM ac_operations o JOIN ac_intents child ON child.id=o.intent_id
      JOIN ac_worktree_writers w ON w.parent_intent_id=child.parent_intent_id AND w.run_id=child.run_id AND w.holder_intent_id=child.id
     WHERE o.id=r.job_id AND child.id=g.intent_id AND o.state='registered' AND w.state='held')))
    AND r.job_id=ANY($4::uuid[])
    AND ((NOT EXISTS(SELECT 1 FROM ac_native_execution_jobs WHERE grant_id=g.id)
    AND NOT EXISTS(SELECT 1 FROM ac_native_planning_jobs WHERE grant_id=g.id)
    AND NOT EXISTS(SELECT 1 FROM ac_native_qa_jobs WHERE grant_id=g.id))
    OR ($5='ac_native_execution_jobs' AND EXISTS(SELECT 1 FROM ac_native_execution_jobs j WHERE j.id=r.job_id AND j.grant_id=g.id AND j.state='uncertain' AND j.worker_id IS NULL AND j.tools_id IS NULL))
    OR ($5='ac_native_planning_jobs' AND EXISTS(SELECT 1 FROM ac_native_planning_jobs j WHERE j.id=r.job_id AND j.grant_id=g.id AND j.state='uncertain' AND j.container_id IS NULL))
    OR ($5='ac_native_qa_jobs' AND EXISTS(SELECT 1 FROM ac_native_qa_jobs j WHERE j.id=r.job_id AND j.grant_id=g.id AND j.state='uncertain' AND j.container_id IS NULL))) ORDER BY r.created_at,r.job_id`,[input.authority.contextId,docker.authorityId,docker.stateRoot,ids,input.recoverJob?(input.recoverSource??null):null])).rows;});
  retain(rows.map(row=>row.job_id));
  for(const row of rows){try{const recoverJob=await input.ledger.tx(async c=>{
   await input.ledger.authorize(c,input.principal,input.authority.contextId);await input.ledger.fence(c,input.authority,true);
   const current=(await c.query(`SELECT r.*,g.intent_id,g.state grant_state FROM ac_native_resource_admissions r JOIN ac_capacity_grants g ON g.id=r.grant_id
    WHERE r.job_id=$1 AND r.admission_id=$2 AND r.context_id=$3 AND r.authority_id=$4 AND r.state_root=$5 FOR UPDATE OF g,r`,[row.job_id,row.admission_id,input.authority.contextId,docker.authorityId,docker.stateRoot])).rows[0];
   if(!current)return;
   const job=(await c.query('SELECT 1 FROM ac_native_execution_jobs WHERE grant_id=$1 UNION ALL SELECT 1 FROM ac_native_planning_jobs WHERE grant_id=$1 UNION ALL SELECT 1 FROM ac_native_qa_jobs WHERE grant_id=$1',[row.grant_id])).rowCount;
   const terminal=(await c.query(`SELECT 1 FROM ac_intents i WHERE i.id=$1 AND (i.state IN ('failed','canceled','cancelled') OR EXISTS(SELECT 1 FROM ac_plan_cancellations k WHERE k.intent_id IN(i.id,i.parent_intent_id)))`,[current.intent_id])).rowCount;
   if(Number(current.manager_epoch)===input.authority.epoch&&!terminal)return;
   if(job)return true;
   if(!current.admission_id)throw new Refusal('NATIVE_RESOURCE_ADMISSION_UNCERTAIN');
   const proof=await docker.cancelAdmission(current.names,current.admission_id);
   await recoverNeverCreatedManagedWriter(c,{jobId:row.job_id,grantId:row.grant_id,authority:input.authority,admission:current,proof});
   await c.query("UPDATE ac_native_resource_admissions SET state='canceled',reason='canceled',proof=$2,manager_epoch=$3,updated_at=clock_timestamp() WHERE job_id=$1",[row.job_id,proof,input.authority.epoch]);
   await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2,manager_epoch=$3 WHERE id=$1 AND state IN ('reserved','uncertain')",[row.grant_id,proof,input.authority.epoch]);
  });if(recoverJob&&input.recoverJob)await input.recoverJob(row.job_id);}catch(error){errors.push(error);}}
 });
 if(errors.length)throw new AggregateError(errors,'NATIVE_RESOURCE_RECONCILIATION_UNCERTAIN');
}

/** Definite preparation failure: caller holds the fenced job/grant transaction.
 * Host slots are retired before the grant is released. A claim or group makes
 * this fail closed, leaving both records occupied. */
export async function cancelPreparedNativeResources(c:import('pg').PoolClient,docker:DockerDaemon,jobId:string,grantId:string,authority:import('./contracts.ts').Authority){
 if(!(docker instanceof NativeResourceDockerDaemon))return;
 const row=(await c.query('SELECT * FROM ac_native_resource_admissions WHERE job_id=$1 AND grant_id=$2 AND context_id=$3 AND authority_id=$4 AND state_root=$5 FOR UPDATE',[jobId,grantId,authority.contextId,docker.authorityId,docker.stateRoot])).rows[0];
 if(!row?.admission_id||Number(row.manager_epoch)>authority.epoch)throw new Refusal('NATIVE_RESOURCE_ADMISSION_UNCERTAIN');
 const proof=await docker.cancelAdmission(row.names,row.admission_id);
 await c.query("UPDATE ac_native_resource_admissions SET state='canceled',reason='canceled',proof=$2,updated_at=clock_timestamp() WHERE job_id=$1",[jobId,proof]);
}

/** Return proof only for this durable admission. Existing groups/claims are
 * normal uncertainty and remain in the established job-recovery path. */
export async function proveUncreatedNativeResources(c:import('pg').PoolClient,docker:DockerDaemon,jobId:string,grantId:string,authority:import('./contracts.ts').Authority){
 if(!(docker instanceof NativeResourceDockerDaemon))return undefined;
 const row=(await c.query('SELECT * FROM ac_native_resource_admissions WHERE job_id=$1 AND grant_id=$2 AND context_id=$3 AND authority_id=$4 AND state_root=$5 FOR UPDATE',[jobId,grantId,authority.contextId,docker.authorityId,docker.stateRoot])).rows[0];
 if(!row?.admission_id||Number(row.manager_epoch)>authority.epoch)return undefined;
 try{await cancelPreparedNativeResources(c,docker,jobId,grantId,authority);}catch{return undefined;}
 return {state:'not_started' as const,executionStarted:false,source:'native-resource-host-absence' as const,jobId,containerId:null,proof:'no_groups_no_create_claims'};
}

/** No native job/claim ever existed, so this managed writer never received the
 * copy through a container. Host absence is still required; SQL alone cannot
 * neutralize it. Healthy takeover delegates the exact original identity through
 * an append-only continuation; it never rewrites the writer epoch. */
async function recoverNeverCreatedManagedWriter(c:import('pg').PoolClient,input:{jobId:string;grantId:string;authority:import('./contracts.ts').Authority;admission:Record<string,any>;proof:unknown}){
 const expected=['ac-native-tools-'+input.jobId,'ac-native-worker-'+input.jobId].sort();
 if(!Array.isArray(input.admission.names)||JSON.stringify([...input.admission.names].sort())!==JSON.stringify(expected))return;
 const held=(await c.query(`SELECT i.id,i.parent_intent_id,i.run_id,w.manager_epoch,(i.state IN ('failed','canceled','cancelled') OR EXISTS(SELECT 1 FROM ac_plan_cancellations k WHERE k.intent_id IN(i.id,i.parent_intent_id))) terminal FROM ac_intents i
  JOIN ac_operations o ON o.id=i.operation_id AND o.id=$1 AND o.state='registered'
  JOIN ac_capacity_grants previous ON previous.id=$2 AND previous.intent_id=i.id AND previous.context_id=i.context_id
  JOIN ac_worktree_writers w ON w.parent_intent_id=i.parent_intent_id AND w.run_id=i.run_id AND w.holder_intent_id=i.id AND w.state='held'
  WHERE i.context_id=$3 AND (w.manager_epoch=$4 OR EXISTS(SELECT 1 FROM ac_worktree_writer_continuations t WHERE t.parent_intent_id=w.parent_intent_id AND t.run_id=w.run_id AND t.holder_intent_id=w.holder_intent_id AND t.writer_epoch=w.manager_epoch AND t.manager_epoch=$4))
   AND NOT EXISTS(SELECT 1 FROM ac_native_execution_jobs WHERE grant_id=$2)
   AND NOT EXISTS(SELECT 1 FROM ac_execution_launches WHERE operation_id=$1)
   AND NOT EXISTS(SELECT 1 FROM ac_sandbox_jobs WHERE id=$1)
   AND NOT EXISTS(SELECT 1 FROM ac_remote_operations r WHERE r.intent_id=i.id)
  FOR UPDATE OF i,o,w`,[input.jobId,input.grantId,input.authority.contextId,input.admission.manager_epoch])).rows[0];
 if(!held)return;
 const proof={schemaVersion:1,source:held.terminal?'native-resource-never-created-writer':'native-resource-never-created-continuation',jobId:input.jobId,grantId:input.grantId,admissionId:input.admission.admission_id,
  contextId:input.authority.contextId,parentIntentId:held.parent_intent_id,runId:held.run_id,intentId:held.id,writerEpoch:Number(held.manager_epoch),reconcilerEpoch:input.authority.epoch,
  authorityId:input.admission.authority_id,stateRoot:input.admission.state_root,hostProof:input.proof};
 if(!held.terminal){
  if(Number(held.manager_epoch)>=input.authority.epoch)return;
  await c.query(`INSERT INTO ac_worktree_writer_continuations(parent_intent_id,run_id,holder_intent_id,writer_epoch,manager_epoch,job_id,grant_id,admission_id,proof_digest,proof)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(parent_intent_id,run_id,manager_epoch) DO NOTHING`,[held.parent_intent_id,held.run_id,held.id,held.manager_epoch,input.authority.epoch,input.jobId,input.grantId,input.admission.admission_id,digest(proof),proof]);
  const saved=(await c.query('SELECT proof_digest FROM ac_worktree_writer_continuations WHERE parent_intent_id=$1 AND run_id=$2 AND manager_epoch=$3',[held.parent_intent_id,held.run_id,input.authority.epoch])).rows[0];
  if(saved?.proof_digest!==digest(proof))throw new Refusal('WORKTREE_CONTINUATION_CONFLICT');
  return;
 }
 await c.query(`UPDATE ac_worktree_writers SET state='neutralized',proof_digest=$4,revocation_job_id=$5,revocation_proof=$6
  WHERE parent_intent_id=$1 AND run_id=$2 AND holder_intent_id=$3 AND state='held'`,[held.parent_intent_id,held.run_id,held.id,digest(proof),input.jobId,proof]);
 await c.query("UPDATE ac_operations SET state='completed',receipt=$2 WHERE id=$1 AND state='registered' AND grant_id=$3",[input.jobId,{cancellation:true,executionStarted:false,physical:proof},input.grantId]);
 await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'worktree.native_never_created_revoked',$2)",[input.authority.contextId,{jobId:input.jobId,proofDigest:digest(proof)}]);
}
