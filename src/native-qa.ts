import {constants} from 'node:fs';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {mkdir,lstat,realpath,open,rename} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {z} from 'zod';
import {Ledger,type Intent} from './ledger.ts';
import {Authority,canonical,digest,Refusal} from './contracts.ts';
import {DockerDaemon} from './sandbox-broker.ts';
import {GitArtifacts} from './git.ts';
import {Quality,VerificationReceipt,type ArtifactRow} from './quality.ts';
import {QualityPolicy} from './quality-policy.ts';
import {diskGuardFromEnvironment,type DiskGuard} from './disk-admission.ts';
export const NativeQaContract=z.object({schemaVersion:z.literal(1),id:z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/),
 image:z.string().regex(/^sha256:[a-f0-9]{64}$/),argv:z.array(z.string().max(4096).refine(v=>!v.includes('\0'))).min(1).max(64),
 environment:z.array(z.string().max(4096).regex(/^[A-Z_][A-Z0-9_]*=[^\x00\r\n]*$/)).max(32),
 timeoutMs:z.number().int().min(1000).max(1800000),memoryBytes:z.number().int().min(67108864).max(4294967296),pids:z.number().int().min(16).max(256),nanoCpus:z.number().int().min(100000000).max(4000000000)}).strict().refine(v=>v.argv[0]!.startsWith('/'),'ABSOLUTE_TEST_EXECUTABLE_REQUIRED').superRefine((v,c)=>{
 const allowed=new Set(['PATH','HOME','TMPDIR','CI','NODE_VERSION','YARN_VERSION','LANG','LC_ALL','NODE_ENV','NO_COLOR']);
 const names=v.environment.map(value=>value.slice(0,value.indexOf('=')));
 if(names.some(name=>!allowed.has(name))||new Set(names).size!==names.length)c.addIssue({code:'custom',message:'QA_ENVIRONMENT_NOT_ALLOWED'});
});
export type NativeQaContract=z.infer<typeof NativeQaContract>;
export const nativeQaContractDigest=(value:NativeQaContract)=>digest({contract:'native-qa-v1',definition:NativeQaContract.parse(value)});
function evidenceId(id:string){const h=digest({domain:'native-qa-evidence-v1',id});return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
/** Executes only a trusted, policy-pinned command in a credential-free Docker
 * sandbox. Docker exit status is authoritative; test stdout cannot mint QA.
 * No model, account home, shell supplied by an agent or second scheduler. */
export class NativeQa{
 readonly contract:NativeQaContract;readonly verifierDigest:string;private readonly key:Buffer;private readonly docker:DockerDaemon;
 constructor(readonly ledger:Ledger,readonly quality:Quality,readonly repository:string,private readonly root:string,contract:NativeQaContract,key:Uint8Array,
  socketPath?:string,private readonly diskGuard:DiskGuard|undefined=diskGuardFromEnvironment()){
  if(quality.ledger!==ledger||key.byteLength<32||resolve(root)!==root||resolve(repository)!==repository||root===repository||root.startsWith(repository+sep)||repository.startsWith(root+sep))throw new Refusal('NATIVE_QA_CONFIGURATION_INVALID');
  this.contract=Object.freeze(NativeQaContract.parse(structuredClone(contract)));Object.freeze(this.contract.argv);Object.freeze(this.contract.environment);
  this.verifierDigest=nativeQaContractDigest(this.contract);this.key=Buffer.from(key);this.docker=new DockerDaemon(socketPath);
 }
 private paths(id:string){z.uuid().parse(id);const area=join(this.root,id);return {area,work:join(area,'work')};}
 private async authorize(c:import('pg').PoolClient,principal:string,authority:Authority,intentId:string,paused:boolean){
  const context=await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,paused);if(!paused)await this.ledger.assertIntentActive(c,authority.contextId,intentId);
  const source=(await c.query('SELECT i.principal_id,r.repo FROM ac_intents i JOIN ac_project_repositories r ON r.project_id=$3 WHERE i.id=$1 AND i.context_id=$2',[intentId,authority.contextId,context.project_id])).rows[0];
  if(source?.principal_id!==principal||source.repo!==this.repository)throw new Refusal('NATIVE_QA_SCOPE_MISMATCH');return context;
 }
 private async policy(c:import('pg').PoolClient,artifact:ArtifactRow){
  const row=(await c.query('SELECT snapshot,digest FROM ac_quality_policies WHERE project_id=$1 AND revision=$2',[artifact.project_id,artifact.policy_revision])).rows[0];
  const policy=QualityPolicy.parse(row?.snapshot);if(digest(policy)!==row.digest||(policy.qaVerifierDigest??policy.verifierDigest)!==this.verifierDigest)throw new Refusal('NATIVE_QA_CONTRACT_MISMATCH');
 }
 async run(principal:string,intent:Intent,authority:Authority,stage:{id:string;session_id:string},grantId:string,artifact:ArtifactRow,isCanceled:()=>boolean){
  if(isCanceled())throw new Refusal('STAGE_CANCELED');
  let status=await this.start(principal,authority,intent.id,stage,grantId,artifact);
  while(status.state!=='completed'&&status.state!=='failed'){
   if(isCanceled()){await this.stop(principal,authority,stage.id,'canceled');throw new Refusal('STAGE_CANCELED');}
   await new Promise(resolve=>setTimeout(resolve,1000));status=await this.reconcile(principal,authority,stage.id);
  }
  return this.record(principal,authority,stage.id);
 }
 async start(principal:string,authority:Authority,intentId:string,stage:{id:string;session_id:string},grantId:string,artifact:ArtifactRow){
  z.uuid().parse(stage.id);z.uuid().parse(stage.session_id);z.uuid().parse(grantId);
  const hash=digest({stageId:stage.id,intentId,contextId:authority.contextId,grantId,sessionId:stage.session_id,artifactId:artifact.id,commit:artifact.commit_id,tree:artifact.tree_id,base:artifact.base_id,policyRevision:artifact.policy_revision,contractDigest:this.verifierDigest});
  const previous=await this.ledger.tx(async c=>{
   const context=await this.authorize(c,principal,authority,intentId,true);
   if(artifact.intent_id!==intentId||artifact.context_id!==authority.contextId||artifact.project_id!==context.project_id||artifact.implementation_grant_id===grantId||artifact.implementation_session_id===stage.session_id)throw new Refusal('NATIVE_QA_NOT_INDEPENDENT');
   const saved=(await c.query('SELECT * FROM ac_native_qa_jobs WHERE id=$1 FOR UPDATE',[stage.id])).rows[0];
   if(saved){if(saved.request_digest!==hash||saved.contract_digest!==this.verifierDigest)throw new Refusal('NATIVE_QA_REQUEST_CONFLICT');return true;}
   await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intentId);await this.policy(c,artifact);
   const registered=(await c.query('SELECT * FROM ac_artifacts WHERE id=$1 AND context_id=$2',[artifact.id,authority.contextId])).rows[0];
   if(!registered||registered.identity_digest!==artifact.identity_digest||registered.intent_id!==intentId||registered.commit_id!==artifact.commit_id||registered.tree_id!==artifact.tree_id||registered.base_id!==artifact.base_id||registered.policy_revision!==artifact.policy_revision||registered.implementation_session_id!==artifact.implementation_session_id||registered.implementation_grant_id!==artifact.implementation_grant_id)throw new Refusal('NATIVE_QA_ARTIFACT_MISMATCH');
   const eligible=(await c.query(`SELECT s.id FROM ac_stage_operations s JOIN ac_capacity_grants g ON g.id=$2
    WHERE s.id=$1 AND s.intent_id=$3 AND s.session_id=$4 AND s.node_id='qa' AND s.state='registered' AND s.manager_epoch=$5
     AND (s.grant_id IS NULL OR s.grant_id=g.id) AND g.attempt_id=s.attempt_id AND g.state='reserved' AND g.role='qa' AND g.resource_kind='model'
     AND g.context_id=$6 AND g.intent_id=$3 AND g.project_id=$7 AND g.manager_epoch=$5 FOR UPDATE OF s,g`,[stage.id,grantId,intentId,stage.session_id,authority.epoch,authority.contextId,context.project_id])).rowCount;
   if(!eligible)throw new Refusal('NATIVE_QA_GRANT_MISMATCH');return false;
  });
  if(previous)return this.reconcile(principal,authority,stage.id);
  await this.diskGuard?.assertAdmission();const root=await lstat(this.root);if(!root.isDirectory()||root.isSymbolicLink()||root.uid!==process.getuid?.()||(root.mode&0o7777)!==0o700||await realpath(this.root)!==this.root)throw new Refusal('NATIVE_QA_ROOT_UNSAFE');
  await this.ledger.tx(async c=>{
   await this.authorize(c,principal,authority,intentId,false);await this.policy(c,artifact);
   const s=(await c.query('SELECT state,attempt_id,manager_epoch FROM ac_stage_operations WHERE id=$1 FOR UPDATE',[stage.id])).rows[0];
   const g=(await c.query('SELECT * FROM ac_capacity_grants WHERE id=$1 FOR UPDATE',[grantId])).rows[0];
   if(s?.state!=='registered'||Number(s.manager_epoch)!==authority.epoch||g?.state!=='reserved'||g.attempt_id!==s.attempt_id||g.intent_id!==intentId||g.role!=='qa'||Number(g.manager_epoch)!==authority.epoch)throw new Refusal('NATIVE_QA_GRANT_MISMATCH');
   await c.query(`INSERT INTO ac_native_qa_jobs(id,context_id,intent_id,artifact_id,grant_id,session_id,manager_epoch,request_digest,contract_digest,state,deadline_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'uncertain',clock_timestamp()+$10::int*interval '1 millisecond')`,[stage.id,authority.contextId,intentId,artifact.id,grantId,stage.session_id,authority.epoch,hash,this.verifierDigest,this.contract.timeoutMs]);
   await c.query("UPDATE ac_stage_operations SET state='uncertain',grant_id=$2 WHERE id=$1",[stage.id,grantId]);await c.query("UPDATE ac_capacity_grants SET state='uncertain' WHERE id=$1",[grantId]);
  });
  const p=this.paths(stage.id);
  try{await mkdir(p.area,{mode:0o700});await new GitArtifacts(this.repository).snapshot(artifact.commit_id,artifact.base_id,p.work);}
  catch(error){
   // This catch covers only preparation, before the first Docker request.
   // A later create/start failure remains uncertain and is never freed here.
   const diagnostic=Buffer.from(JSON.stringify({source:'controller',error:'QA_PREPARATION_FAILED'}));
   const receipt={schemaVersion:1,jobId:stage.id,artifactId:artifact.id,grantId,sessionId:stage.session_id,contractDigest:this.verifierDigest,executionStarted:false,exitCode:-1,status:'missing_result',logSha256:createHash('sha256').update(diagnostic).digest('hex'),logsAvailable:false,synthetic:false,modelInference:false,failureCode:error instanceof Refusal?error.code:'QA_PREPARATION_FAILED'};
   await this.ledger.tx(async c=>{await this.authorize(c,principal,authority,intentId,true);
    const row=(await c.query("SELECT state,container_id FROM ac_native_qa_jobs WHERE id=$1 FOR UPDATE",[stage.id])).rows[0];
    const grant=(await c.query('SELECT state FROM ac_capacity_grants WHERE id=$1 FOR UPDATE',[grantId])).rows[0];
    if(row?.state!=='uncertain'||row.container_id||grant?.state!=='uncertain')throw new Refusal('NATIVE_QA_RECONCILIATION_REQUIRED');
    await c.query("UPDATE ac_native_qa_jobs SET state='failed',receipt=$2 WHERE id=$1",[stage.id,receipt]);await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1",[grantId,receipt]);
   });return {state:'failed' as const,receipt};
  }
  const image=this.contract.image;
  const id=await this.ledger.tx(async c=>{
   await this.authorize(c,principal,authority,intentId,false);await this.policy(c,artifact);
   const job=(await c.query("SELECT * FROM ac_native_qa_jobs WHERE id=$1 AND state='uncertain' FOR UPDATE",[stage.id])).rows[0];if(!job||Number(job.manager_epoch)!==authority.epoch||job.request_digest!==hash)throw new Refusal('NATIVE_QA_RECONCILIATION_REQUIRED');
   const id=await this.docker.create('ac-native-qa-'+stage.id,{Image:image,User:'10001:10001',WorkingDir:'/work',Entrypoint:[this.contract.argv[0]],Cmd:this.contract.argv.slice(1),Env:[...this.contract.environment],Labels:{'agent-control.contract':'native-qa-v1','agent-control.job':stage.id,'agent-control.request':hash},
    HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:this.contract.pids,Memory:this.contract.memoryBytes,NanoCpus:this.contract.nanoCpus,Tmpfs:{'/tmp':'rw,nosuid,nodev,mode=1777,size=128m'},Binds:[p.work+':/work:ro']}});
   await this.docker.start(id);return id;
  });
  await this.ledger.tx(async c=>{await this.authorize(c,principal,authority,intentId,true);await c.query("UPDATE ac_native_qa_jobs SET container_id=$2,state='running' WHERE id=$1 AND state='uncertain'",[stage.id,id]);await c.query("UPDATE ac_capacity_grants SET state='running' WHERE id=$1 AND state='uncertain'",[grantId]);});
  return {state:'running' as const};
 }
 private inspect(physical:NonNullable<Awaited<ReturnType<DockerDaemon['inspect']>>>,job:Record<string,any>){
  const h=physical.HostConfig,m=physical.Mounts;
  const namespaces=z.object({CapAdd:z.array(z.string()).nullish(),Devices:z.array(z.unknown()).nullish(),PidMode:z.string().optional(),IpcMode:z.string().optional()}).parse(h);
  const binds=m.filter(x=>x.Type!=='tmpfs');
  if((job.container_id&&job.container_id!==physical.Id)||physical.Image!==this.contract.image||physical.Config.User!=='10001:10001'||physical.Config.WorkingDir!=='/work'||
   JSON.stringify(physical.Config.Entrypoint)!==JSON.stringify([this.contract.argv[0]])||JSON.stringify(physical.Config.Cmd??[])!==JSON.stringify(this.contract.argv.slice(1))||
   JSON.stringify(physical.Config.Env??[])!==JSON.stringify(this.contract.environment)||physical.Config.Labels['agent-control.contract']!=='native-qa-v1'||physical.Config.Labels['agent-control.job']!==job.id||physical.Config.Labels['agent-control.request']!==job.request_digest||
   h.NetworkMode!=='none'||!h.ReadonlyRootfs||h.Privileged||!h.CapDrop?.includes('ALL')||!h.SecurityOpt?.some(s=>s==='no-new-privileges'||s==='no-new-privileges:true')||
   (namespaces.CapAdd?.length??0)>0||(namespaces.Devices?.length??0)>0||!['','private',undefined].includes(namespaces.PidMode)||!['','private',undefined].includes(namespaces.IpcMode)||
   h.Memory!==this.contract.memoryBytes||h.PidsLimit!==this.contract.pids||h.NanoCpus!==this.contract.nanoCpus||
   binds.length!==1||binds[0].Source!==this.paths(job.id).work||binds[0].Destination!=='/work'||binds[0].RW||m.some(x=>x.Type==='tmpfs'&&x.Destination!=='/tmp'))throw new Refusal('NATIVE_QA_CONTAINER_MISMATCH');
 }
 async stop(principal:string,authority:Authority,id:string,reason:'canceled'|'timeout'){
  z.uuid().parse(id);return this.ledger.tx(async c=>{
   let job=(await c.query('SELECT * FROM ac_native_qa_jobs WHERE id=$1 AND context_id=$2',[id,authority.contextId])).rows[0];if(!job)throw new Refusal('NATIVE_QA_JOB_NOT_FOUND',404);
   await this.authorize(c,principal,authority,job.intent_id,true);job=(await c.query('SELECT * FROM ac_native_qa_jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(['completed','failed'].includes(job.state))return;
   await c.query('UPDATE ac_native_qa_jobs SET stop_reason=$2 WHERE id=$1 AND stop_reason IS NULL',[id,reason]);
   const physical=await this.docker.inspect('ac-native-qa-'+id);if(!physical)return;this.inspect(physical,job);if(physical.State.Running)await this.docker.stop(physical.Id);
  });
 }
 async reconcile(principal:string,authority:Authority,id:string){
  z.uuid().parse(id);const job=await this.ledger.tx(async c=>{
   const row=(await c.query('SELECT *,deadline_at<=clock_timestamp() deadline_elapsed FROM ac_native_qa_jobs WHERE id=$1 AND context_id=$2',[id,authority.contextId])).rows[0];if(!row)throw new Refusal('NATIVE_QA_JOB_NOT_FOUND',404);
   await this.authorize(c,principal,authority,row.intent_id,true);if(row.contract_digest!==this.verifierDigest||Number(row.manager_epoch)>authority.epoch)throw new Refusal('NATIVE_QA_CONTRACT_MISMATCH');return row;
  });
  if(['completed','failed'].includes(job.state))return {state:job.state as 'completed'|'failed',receipt:job.receipt};
  const physical=await this.docker.inspect('ac-native-qa-'+id);if(!physical)return {state:'uncertain' as const};this.inspect(physical,job);
  if(physical.State.Running){if(job.deadline_elapsed)await this.stop(principal,authority,id,'timeout');return {state:'running' as const};}
  if(physical.State.Status!=='exited'||!Number.isFinite(Date.parse(physical.State.FinishedAt))||physical.State.FinishedAt.startsWith('0001-'))return {state:'uncertain' as const};
  let logs:Buffer,logsAvailable=true;
  try{logs=await this.docker.logs(physical.Id);}catch{logsAvailable=false;logs=Buffer.from(JSON.stringify({source:'controller',error:'QA_LOG_COLLECTION_UNAVAILABLE'}));}
  const logSha256=createHash('sha256').update(logs).digest('hex');
  const pending=join(this.paths(id).area,'qa-logs-'+randomUUID()+'.pending');
  const file=await open(pending,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await file.writeFile(logs);await file.sync();}finally{await file.close();}
  await rename(pending,join(this.paths(id).area,'qa-logs.bin'));
  const directory=await open(this.paths(id).area,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}

  const status=job.stop_reason==='canceled'?'canceled':!logsAvailable||job.stop_reason==='timeout'||Date.parse(physical.State.FinishedAt)>new Date(job.deadline_at).getTime()||physical.State.OOMKilled===true||[126,127,137,143].includes(physical.State.ExitCode)?'missing_result':physical.State.ExitCode===0?'passed':'failed';
  const receipt={schemaVersion:1,jobId:id,artifactId:job.artifact_id,grantId:job.grant_id,sessionId:job.session_id,contractDigest:this.verifierDigest,containerId:physical.Id,exitCode:physical.State.ExitCode,finishedAt:physical.State.FinishedAt,status,logSha256,logsAvailable,synthetic:false,modelInference:false};
  await this.ledger.tx(async c=>{
   await this.authorize(c,principal,authority,job.intent_id,true);const saved=(await c.query('SELECT * FROM ac_native_qa_jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(['completed','failed'].includes(saved.state)){if(digest(saved.receipt)!==digest(receipt))throw new Refusal('NATIVE_QA_RECEIPT_CONFLICT');return;}
   const grant=(await c.query('SELECT * FROM ac_capacity_grants WHERE id=$1 FOR UPDATE',[job.grant_id])).rows[0];
   if(!grant||grant.intent_id!==job.intent_id||grant.context_id!==authority.contextId||Number(grant.manager_epoch)!==Number(job.manager_epoch)||grant.role!=='qa'||!['uncertain','running'].includes(grant.state))throw new Refusal('NATIVE_QA_GRANT_MISMATCH');
   await c.query('UPDATE ac_native_qa_jobs SET state=$2,container_id=$3,receipt=$4 WHERE id=$1',[id,status==='passed'?'completed':'failed',physical.Id,receipt]);
   await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1",[job.grant_id,receipt]);
  });
  return {state:status==='passed'?'completed' as const:'failed' as const,receipt};
 }
 async reconcileContext(principal:string,authority:Authority){
  const jobs=await this.ledger.tx(async c=>{await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,true);
   return (await c.query(`SELECT j.*,x.state cancellation_state,s.state stage_state FROM ac_native_qa_jobs j JOIN ac_stage_operations s ON s.id=j.id
    LEFT JOIN ac_plan_cancellations x ON x.intent_id=j.intent_id WHERE j.context_id=$1 AND
    (j.state IN ('uncertain','running') OR s.state<>'completed') ORDER BY j.created_at,j.id LIMIT 32`,[authority.contextId])).rows;
  });
  for(const job of jobs){
   if(job.contract_digest!==this.verifierDigest)throw new Refusal('NATIVE_QA_CONTRACT_MISMATCH');
   await this.ledger.heartbeat(authority);
   if(job.cancellation_state==='requested')await this.stop(principal,authority,job.id,'canceled');
   const result=await this.reconcile(principal,authority,job.id);
   if(result.state==='completed'||result.state==='failed'){
    if(job.cancellation_state==='requested'){
     await this.ledger.tx(async c=>{await this.authorize(c,principal,authority,job.intent_id,true);
      await c.query("UPDATE ac_stage_operations SET state='completed',receipt=$2,finished_at=clock_timestamp() WHERE id=$1 AND grant_id=$3 AND state IN ('uncertain','running')",[job.id,{cancellation:true,nativeQa:result.receipt},job.grant_id]);});
    }else await this.record(principal,authority,job.id);
   }
  }
 }
 async record(principal:string,authority:Authority,id:string){
  const observed=await this.reconcile(principal,authority,id);if(observed.state!=='completed'&&observed.state!=='failed')throw new Refusal('NATIVE_QA_RESULT_UNCONFIRMED');
  const job=(await this.ledger.pool.query('SELECT j.*,a.* FROM ac_native_qa_jobs j JOIN ac_artifacts a ON a.id=j.artifact_id WHERE j.id=$1',[id])).rows[0];
  if(!job)throw new Refusal('NATIVE_QA_ARTIFACT_MISMATCH');
  const machine=observed.receipt;const receipt=VerificationReceipt.parse({schemaVersion:1,id:evidenceId(id),artifactId:job.artifact_id,kind:'qa',sessionId:job.session_id,grantId:job.grant_id,policyRevision:job.policy_revision,commit:job.commit_id,tree:job.tree_id,base:job.base_id,status:machine.status,exitCode:machine.exitCode,verifierDigest:this.verifierDigest,logSha256:machine.logSha256,commandDigest:digest({argv:this.contract.argv,image:this.contract.image}),verifierVersion:'native-qa-v1'});
  const signature=createHmac('sha256',this.key).update(canonical(receipt)).digest('hex');
  await this.ledger.tx(async c=>{
   await this.authorize(c,principal,authority,job.intent_id,true);await this.ledger.assertIntentActive(c,authority.contextId,job.intent_id);await this.policy(c,job);
   const row=(await c.query('SELECT s.*,g.state grant_state,g.physical_receipt FROM ac_stage_operations s JOIN ac_capacity_grants g ON g.id=s.grant_id WHERE s.id=$1 FOR UPDATE OF s,g',[id])).rows[0];
   if(!row||row.intent_id!==job.intent_id||row.session_id!==job.session_id||row.grant_id!==job.grant_id||row.node_id!=='qa'||row.grant_state!=='released'||digest(row.physical_receipt)!==digest(machine))throw new Refusal('NATIVE_QA_STAGE_MISMATCH');
   if(row.state==='completed'){if(digest(row.receipt?.verification)!==digest(receipt))throw new Refusal('NATIVE_QA_RESULT_CONFLICT');return;}
   if(!['uncertain','running'].includes(row.state))throw new Refusal('NATIVE_QA_STAGE_MISMATCH');
   await c.query("UPDATE ac_stage_operations SET state='completed',receipt=$2,finished_at=clock_timestamp() WHERE id=$1",[id,{verification:receipt,signature,nativeQa:machine}]);
  });
  await this.quality.record(principal,receipt,signature,authority);return receipt;
 }
}
