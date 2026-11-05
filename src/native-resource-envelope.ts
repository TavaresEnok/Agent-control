import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {z} from 'zod';
import {DockerDaemon} from './sandbox-broker.ts';
import {Refusal} from './contracts.ts';
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
 get stateRoot(){return this.envelope.stateRoot;}
 get authorityId(){return this.envelope.resourceAuthority.authorityId;}
 constructor(raw:NativeResourceEnvelope){super();this.envelope=NativeResourceEnvelope.parse(raw);}
 private callResource(action:string,value:Record<string,unknown>):Promise<any>{
  return new Promise((resolve,reject)=>{
   const child=spawn('/usr/bin/python3',[bridge],{env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'},stdio:['pipe','pipe','pipe']});let bytes=0,output='',failed=false;
   const timer=setTimeout(()=>{failed=true;child.kill('SIGKILL');},25000);
   child.stdout.on('data',(data:Buffer)=>{bytes+=data.length;if(bytes>1048576){failed=true;child.kill('SIGKILL');}else output+=data.toString('utf8');});
   child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});child.once('error',()=>{failed=true;});
   child.once('close',code=>{clearTimeout(timer);if(failed)return reject(new Refusal('NATIVE_RESOURCE_UNCERTAIN'));let result:any;try{result=JSON.parse(output);}catch{return reject(new Refusal('NATIVE_RESOURCE_UNCERTAIN'));}
    if(code!==0||result.error)return reject(new Refusal(typeof result.error==='string'&&/^[A-Z][A-Z0-9_]{1,100}$/.test(result.error)?result.error:'NATIVE_RESOURCE_UNCERTAIN'));resolve(result);});
   const {stateRoot,...authority}=this.envelope;child.stdin.end(JSON.stringify({action,authority,stateRoot,...value}));
  });
 }
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

/** Reserve every native group together before the native launch journal is advanced.
 * Only definite physical-capacity refusal retries; uncertain ACKs retain both ledgers. */
export async function admitNativeResources(input:{docker:DockerDaemon;ledger:import('./ledger.ts').Ledger;principal:string;
 authority:import('./contracts.ts').Authority;intentId:string;grantId:string;jobId:string;names:string[];isCanceled?:()=>boolean}){
 if(!(input.docker instanceof NativeResourceDockerDaemon))return;
 const docker=input.docker;
 const allowed=async()=>input.ledger.tx(async c=>{
  if(input.isCanceled?.())throw new Refusal('STAGE_CANCELED');
  const context=await input.ledger.authorize(c,input.principal,input.authority.contextId);await input.ledger.fence(c,input.authority,true);await input.ledger.assertIntentActive(c,input.authority.contextId,input.intentId);
  const grant=(await c.query('SELECT * FROM ac_capacity_grants WHERE id=$1 FOR UPDATE',[input.grantId])).rows[0];
  if(!grant||grant.context_id!==input.authority.contextId||grant.intent_id!==input.intentId||Number(grant.manager_epoch)!==input.authority.epoch||grant.state!=='reserved')throw new Refusal('NATIVE_RESOURCE_GRANT_MISMATCH');
  const prior=(await c.query('SELECT state,names,grant_id,authority_id,admission_id,state_root FROM ac_native_resource_admissions WHERE job_id=$1 FOR UPDATE',[input.jobId])).rows[0];
  if(prior&&(prior.grant_id!==input.grantId||JSON.stringify(prior.names)!==JSON.stringify(input.names)||prior.authority_id!==docker.authorityId||prior.state_root!==docker.stateRoot||prior.state==='uncertain'))throw new Refusal('NATIVE_RESOURCE_ADMISSION_UNCERTAIN');
  await c.query(`INSERT INTO ac_native_resource_admissions(job_id,grant_id,context_id,manager_epoch,authority_id,names,state_root,state,reason) VALUES($1,$2,$3,$4,$5,$6,$8,'waiting',$7)
   ON CONFLICT(job_id) DO UPDATE SET manager_epoch=$4,reason=$7,updated_at=clock_timestamp()`,[input.jobId,input.grantId,input.authority.contextId,input.authority.epoch,docker.authorityId,JSON.stringify(input.names),context.paused?'human_pause':'physical_capacity',docker.stateRoot]);
  return !context.paused;
 });
 try{
  const existing=(await input.ledger.pool.query('SELECT admission_id FROM ac_native_resource_admissions WHERE job_id=$1',[input.jobId])).rows[0]?.admission_id;
  await docker.admit(input.names,allowed,async token=>{await allowed();await input.ledger.tx(async c=>{await input.ledger.fence(c,input.authority,true);await c.query(`INSERT INTO ac_native_resource_admissions(job_id,grant_id,context_id,manager_epoch,authority_id,names,state_root,admission_id,state,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'waiting','physical_capacity')
   ON CONFLICT(job_id) DO UPDATE SET admission_id=$8 WHERE ac_native_resource_admissions.manager_epoch=$4`,[input.jobId,input.grantId,input.authority.contextId,input.authority.epoch,docker.authorityId,JSON.stringify(input.names),docker.stateRoot,token]);});},existing);
  await input.ledger.tx(async c=>{await input.ledger.fence(c,input.authority);await input.ledger.assertIntentActive(c,input.authority.contextId,input.intentId);await c.query("UPDATE ac_native_resource_admissions SET state='admitted',reason='admitted',updated_at=clock_timestamp() WHERE job_id=$1",[input.jobId]);});
 }catch(error){
  let proof:{state:'not_started';source:'native-resource-host-absence'}|undefined;
  try{proof=await docker.cancelAdmission(input.names);}catch{}
  try{await input.ledger.tx(async c=>{
   await input.ledger.fence(c,input.authority,true);
   await c.query("UPDATE ac_native_resource_admissions SET state=$2,reason=$3,proof=$4,updated_at=clock_timestamp() WHERE job_id=$1 AND manager_epoch=$5 AND grant_id=$6 AND context_id=$7",[input.jobId,proof?'canceled':'uncertain',proof?'canceled':'uncertain',proof??null,input.authority.epoch,input.grantId,input.authority.contextId]);
   if(proof)await c.query(`UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1 AND state='reserved' AND manager_epoch=$3 AND context_id=$4 AND intent_id=$5
    AND NOT EXISTS(SELECT 1 FROM ac_native_execution_jobs WHERE grant_id=$1)
    AND NOT EXISTS(SELECT 1 FROM ac_native_planning_jobs WHERE grant_id=$1)
    AND NOT EXISTS(SELECT 1 FROM ac_native_qa_jobs WHERE grant_id=$1)`,[input.grantId,proof,input.authority.epoch,input.authority.contextId,input.intentId]);
   else await c.query("UPDATE ac_capacity_grants SET state='uncertain' WHERE id=$1 AND state='reserved' AND manager_epoch=$2 AND context_id=$3 AND intent_id=$4",[input.grantId,input.authority.epoch,input.authority.contextId,input.intentId]);
  });}catch{}
  throw error;
 }
}

/** Successor cancellation recovery for waits that have no native job journal yet. */
export async function reconcileNativeResourceAdmissions(input:{docker:DockerDaemon;ledger:import('./ledger.ts').Ledger;principal:string;authority:import('./contracts.ts').Authority}){
 if(!(input.docker instanceof NativeResourceDockerDaemon))return;
 const docker=input.docker;
 const rows=await input.ledger.tx(async c=>{await input.ledger.authorize(c,input.principal,input.authority.contextId);await input.ledger.fence(c,input.authority,true);return (await c.query(`SELECT r.*,g.intent_id FROM ac_native_resource_admissions r JOIN ac_capacity_grants g ON g.id=r.grant_id JOIN ac_intents i ON i.id=g.intent_id
  WHERE r.context_id=$1 AND r.authority_id=$2 AND r.state_root=$3 AND r.state<>'canceled'
   AND (i.state IN ('failed','canceled','cancelled') OR EXISTS(SELECT 1 FROM ac_plan_cancellations k WHERE k.intent_id IN(i.id,i.parent_intent_id)))
   AND NOT EXISTS(SELECT 1 FROM ac_native_execution_jobs WHERE grant_id=g.id)
   AND NOT EXISTS(SELECT 1 FROM ac_native_planning_jobs WHERE grant_id=g.id)
   AND NOT EXISTS(SELECT 1 FROM ac_native_qa_jobs WHERE grant_id=g.id) ORDER BY r.created_at,r.job_id`,[input.authority.contextId,docker.authorityId,docker.stateRoot])).rows;});
 const errors:unknown[]=[];
 for(const row of rows){try{
  if(!row.admission_id)throw new Refusal('NATIVE_RESOURCE_ADMISSION_UNCERTAIN');
  const proof=await docker.cancelAdmission(row.names,row.admission_id);
  await input.ledger.tx(async c=>{await input.ledger.fence(c,input.authority,true);const owned=(await c.query('SELECT g.id FROM ac_capacity_grants g JOIN ac_native_resource_admissions r ON r.grant_id=g.id WHERE r.job_id=$1 AND r.admission_id=$2 AND g.context_id=$3 FOR UPDATE OF g,r',[row.job_id,row.admission_id,input.authority.contextId])).rowCount;if(!owned)throw new Refusal('NATIVE_RESOURCE_ADMISSION_UNCERTAIN');
   await c.query("UPDATE ac_native_resource_admissions SET state='canceled',reason='canceled',proof=$2,manager_epoch=$3,updated_at=clock_timestamp() WHERE job_id=$1",[row.job_id,proof,input.authority.epoch]);
   await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2,manager_epoch=$3 WHERE id=$1 AND state IN ('reserved','uncertain')",[row.grant_id,proof,input.authority.epoch]);
  });
 }catch(error){errors.push(error);}}
 if(errors.length)throw new AggregateError(errors,'NATIVE_RESOURCE_RECONCILIATION_UNCERTAIN');
}
