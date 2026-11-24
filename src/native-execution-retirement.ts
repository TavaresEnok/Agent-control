/** Physical retirement of terminal managed writers and terminal jobs. */
import {redactNativeLogsOrWithhold} from './native-execution-redaction.ts';
import {readNativeSecretSnapshot,quarantineNativeLegacyLog} from './native-execution-secret-snapshot.ts';
import {verifiedWorktreeWriterContinuation} from './worktree-lease.ts';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {join} from 'node:path';
import {createPublicKey,sign,createHash,verify} from 'node:crypto';
import pg from 'pg';
import {Authority,canonical,digest,Refusal} from './contracts.ts';
import {Id,retireNativePrivateNetwork} from './native-execution-shared.ts';
import {fenceInstallationContext} from './installation-authority-fence.ts';
import {NativeExecutionReconciler} from './native-execution-reconcile.ts';
export abstract class NativeExecutionRetirement extends NativeExecutionReconciler{
 /**
  * The tools companion of a job whose worker already exited (an exam run that stopped mid-way leaves it up). Returns its id
  * only when the worker is confirmed stopped and the companion is bound to this job by name, recorded id, labels (job, contract,
  * launch) and pinned image; anything else returns undefined and the normal checks decide.
  */
 protected async idleRunningCompanion(row:Record<string,any>):Promise<string|undefined>{
  if(!row.worker_id||!row.tools_id||row.executor_digest!==this.executorDigest)return undefined;
  try{
   const [worker,tools,toolsByName]=await Promise.all([this.docker.inspect(row.worker_id),this.docker.inspect(row.tools_id),this.docker.inspect('ac-native-tools-'+row.id)]);
   if(!worker||!tools||!toolsByName||tools.Id!==row.tools_id||toolsByName.Id!==row.tools_id)return undefined;
   if(worker.State.Running||worker.Name!=='/ac-native-worker-'+row.id||worker.Config.Labels['agent-control.job']!==row.id)return undefined;
   const labels=tools.Config.Labels;
   if(!tools.State.Running||tools.Name!=='/ac-native-tools-'+row.id||tools.Image!==this.config.toolsImage||labels['agent-control.job']!==row.id||
    labels['agent-control.contract']!=='native-execution-v1'||labels['agent-control.launch']!==row.input_digest)return undefined;
   return row.tools_id;
  }catch{
   return undefined;
  }
 }
 protected async stoppedNativeContainers(row:Record<string,any>,refusal:string){
  try{
   const ids:string[]=[];
   const expected=[['worker',row.worker_id,this.config.workerImage],['tools',row.tools_id,this.config.toolsImage]] as const;
   for(const [role,id,image] of expected){
    const name='ac-native-'+role+'-'+row.id;
    const [byName,byIdRecorded]=await Promise.all([this.docker.inspect(name),id?this.docker.inspect(id):null]);
    if(!byName&&!byIdRecorded)continue;
    // A launch that died between creating the container and recording its id leaves a container that never ran
    // (status created, pid 0). Its name, labels (job and launch digest) and image still bind it to this job.
    const neverStarted=!id&&byName?.State.Status==='created';
    const containerId=neverStarted?byName!.Id:id;
    const byId=neverStarted?byName:byIdRecorded;
    if(!byName||!byId||!containerId||row.executor_digest!==this.executorDigest)throw new Refusal(refusal);
    for(const item of [byName,byId]){
     const labels=item.Config.Labels,state=item.State;
     if(item.Id!==containerId||item.Name!=='/'+name||item.Image!==image||labels['agent-control.job']!==row.id||
      labels['agent-control.contract']!=='native-execution-v1'||labels['agent-control.launch']!==row.input_digest||
      state.Running||state.Pid!==0||!['exited','dead','created'].includes(state.Status))throw new Refusal(refusal);
    }
    ids.push(containerId);
   }
   const labeled=await this.docker.nativeJobContainerIds(row.id);
   if(labeled.length!==ids.length||labeled.some(id=>!ids.includes(id)))throw new Refusal(refusal);
   return ids;
  }catch(error){
   if(error instanceof Refusal)throw error;
   throw new Refusal('DOCKER_UNCERTAIN');
  }
 }
 protected async removeStoppedNativeContainers(row:Record<string,any>,ids:string[],refusal:string){
  const confirmed=await this.stoppedNativeContainers(row,refusal);
  if(confirmed.length!==ids.length||confirmed.some((id,index)=>id!==ids[index]))throw new Refusal(refusal);
  await this.removeRetiredContainerIds(ids);
  if((await this.stoppedNativeContainers(row,refusal)).length)throw new Refusal(refusal);
 }
 protected async removeRetiredContainerIds(ids:readonly string[]){
  // Docker rejects deletion of a running container when force is omitted.
  for(const id of ids)await this.docker.remove(id);
 }
 /** Reclaim a stopped pair still present despite a signed terminal retirement. */
 async reclaimRetiredContainers(principal:string,jobId:string,apply:boolean,scope:{contextId:string;projectId:string}){
  Id.parse(jobId);
  return this.serialEffect(jobId,()=>this.ledger.tx(async c=>{
   const context=await this.ledger.authorize(c,principal,scope.contextId);
   if(context.role!=='owner'||context.project_id!==scope.projectId)throw new Refusal('NATIVE_RETIREMENT_SCOPE_MISMATCH');
   await fenceInstallationContext(c,scope.contextId,this.ledger.installationAuthority,true);
   const row=(await c.query(`SELECT j.*,g.state grant_state,r.state retirement_state,r.binding,r.proof
    FROM ac_native_execution_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id
    JOIN ac_native_terminal_retirements r ON r.job_id=j.id
    WHERE j.id=$1 AND j.context_id=$2 FOR UPDATE OF j,g,r`,[jobId,scope.contextId])).rows[0];
   const refusal='NATIVE_RETIREMENT_UNCONFIRMED',binding=row?.binding;
   if(!row||!binding||!row.receipt||!['completed','failed'].includes(row.state)||row.grant_state!=='released'||
    row.key_fingerprint!==this.fingerprint||row.executor_digest!==this.executorDigest||!this.supportsAccount(row.account_id)||
    binding.schemaVersion!==1||binding.jobId!==jobId||binding.contextId!==row.context_id||binding.intentId!==row.intent_id||
    binding.grantId!==row.grant_id||binding.sessionId!==row.session_id||binding.epoch!==Number(row.manager_epoch)||
    binding.role!==row.role||binding.inputDigest!==row.input_digest||binding.terminalDigest!==digest(row.receipt)||
    binding.workerId!==row.worker_id||binding.toolsId!==row.tools_id||binding.networkId!==row.network_id)
    throw new Refusal(refusal);
   this.verifyUnstartedRetirement({state:row.retirement_state,binding,proof:row.proof},binding);
   const ids=await this.stoppedNativeContainers(row,refusal);
   if(!ids.length)return 'absent' as const;
   if(!apply)return 'eligible' as const;
   await this.removeStoppedNativeContainers(row,ids,refusal);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'native.terminal_containers_reclaimed',$2)",
    [scope.contextId,{jobId,containerIds:ids,proofDigest:digest(row.proof)}]);
   return 'removed' as const;
  }));
 }
 /** Retire a terminal managed programmer pair. Both physical containers
  * must be absent before the permanently bound copy is marked neutralized. */
 async retireManagedWriter(principal:string,authority:Authority,jobId:string){
  const input=await this.registeredInput(principal,authority,jobId);
  if(input.role!=='programmer')throw new Refusal('NATIVE_RETIREMENT_SCOPE_MISMATCH');
  const parent=(await this.ledger.pool.query('SELECT parent_intent_id FROM ac_intents WHERE id=$1 AND context_id=$2',[input.intentId,authority.contextId])).rows[0];
  if(!parent)throw new Refusal('NATIVE_RETIREMENT_SCOPE_MISMATCH');
  if(!parent.parent_intent_id)return {state:'not_managed' as const};
  const outcome=await this.reconcile(principal,authority,input);
  if((outcome.state!=='completed'&&outcome.state!=='failed')||!('receipt' in outcome))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
  const p=this.paths(jobId);await this.directory(this.config.hostRoot);await this.directory(p.root);
  const logs=[join(p.root,'worker-terminal.log'),join(p.root,'tools-terminal.log')];
  const readLog=async(path:string)=>{
   try{await readNativeSecretSnapshot(p.secretSnapshot,jobId,this.key);}catch{return quarantineNativeLegacyLog(path,jobId,this.key);}
   const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(error=>{
    if(['ENOENT','ELOOP'].includes(String((error as NodeJS.ErrnoException).code)))throw new Refusal('NATIVE_RETIREMENT_LOG_INVALID');throw error;
   });
   try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>1048576)throw new Refusal('NATIVE_RETIREMENT_LOG_INVALID');
    return createHash('sha256').update(await file.readFile()).digest('hex');}finally{await file.close();}
  };
  const archive=async(path:string,raw:Buffer)=>{
   const bytes=await redactNativeLogsOrWithhold(raw,()=>readNativeSecretSnapshot(p.secretSnapshot,jobId,this.key));
   const hash=createHash('sha256').update(bytes).digest('hex');
   try{const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}}
   catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
   if(await readLog(path)!==hash)throw new Refusal('NATIVE_RETIREMENT_LOG_INVALID');return hash;
  };
  const locked=async(c:pg.PoolClient)=>{
   await this.scope(c,principal,authority,input,true);
   const row=(await c.query(`SELECT i.id intent_id,i.context_id intent_context,i.parent_intent_id,i.run_id,
    o.state operation_state,o.receipt operation_receipt,o.grant_id operation_grant,o.execution_attempt_id,o.manager_epoch operation_epoch,
    j.*,g.state grant_state,g.physical_receipt,g.intent_id grant_intent,g.context_id grant_context,g.manager_epoch grant_epoch,g.role grant_role,g.attempt_id grant_attempt,
    g.account_id grant_account,g.profile_id grant_profile,g.resource_kind grant_resource_kind,
    w.holder_intent_id,w.manager_epoch writer_epoch,w.state writer_state,w.proof_digest,w.revocation_job_id,w.revocation_proof,
    EXISTS(SELECT 1 FROM ac_plan_cancellations x WHERE x.intent_id=i.id AND x.context_id=i.context_id) cancellation_requested
    FROM ac_native_execution_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id JOIN ac_operations o ON o.id=j.id AND o.intent_id=j.intent_id
    JOIN ac_intents i ON i.id=j.intent_id JOIN ac_worktree_writers w ON w.parent_intent_id=i.parent_intent_id AND w.run_id=i.run_id
    WHERE j.id=$1 AND j.context_id=$2 AND j.grant_id=$3 FOR UPDATE OF j,g,o,w`,[jobId,authority.contextId,input.grantId])).rows[0];
   const continuationDigest=row&&Number(row.writer_epoch)!==Number(row.manager_epoch)?await verifiedWorktreeWriterContinuation(c,{parentIntentId:row.parent_intent_id,runId:row.run_id,intentId:row.intent_id,writerEpoch:Number(row.writer_epoch),epoch:Number(row.manager_epoch)}):undefined;
   if(row)row.writer_continuation_digest=continuationDigest;
   const receipt=row?.receipt,payload=receipt?.payload,physical=row?.physical_receipt;
   if(!row||row.role!=='programmer'||!['completed','failed'].includes(row.state)||row.grant_state!=='released'||row.operation_state!=='completed'||
    row.intent_id!==input.intentId||row.intent_context!==authority.contextId||row.grant_context!==authority.contextId||row.grant_intent!==row.intent_id||
    row.grant_role!=='programmer'||row.grant_resource_kind!=='model'||row.grant_account!==row.account_id||row.grant_profile!==row.profile_id||
    row.operation_grant!==row.grant_id||row.grant_attempt!==row.execution_attempt_id||
    Number(row.grant_epoch)!==Number(row.manager_epoch)||(Number(row.writer_epoch)!==Number(row.manager_epoch)&&!continuationDigest)||Number(row.operation_epoch)>authority.epoch||
    row.holder_intent_id!==row.intent_id||row.executor_digest!==this.executorDigest||row.key_fingerprint!==this.fingerprint||row.input_digest!==digest(input)||
    row.session_id!==input.sessionId||!payload||typeof receipt.signature!=='string'||!/^[a-f0-9]{128}$/.test(receipt.signature)||
    !verify(null,Buffer.from('agent-control:native-execution-receipt:v1\n'+canonical(payload)),createPublicKey(this.key),Buffer.from(receipt.signature,'hex'))||
    payload.jobId!==jobId||payload.intentId!==row.intent_id||payload.contextId!==authority.contextId||payload.grantId!==row.grant_id||payload.sessionId!==row.session_id||
    payload.epoch!==Number(row.manager_epoch)||payload.inputDigest!==row.input_digest||payload.executorDigest!==this.executorDigest||
    ((payload.exitCode===0)!==(row.state==='completed'))||
    payload.accountId!==row.account_id||payload.profileId!==row.profile_id||payload.profileDigest!==row.profile_digest||
    !physical||physical.exitCode!==payload.exitCode||physical.workerExitCode!==payload.workerExitCode||payload.physicalDigest!==digest(physical)||
    !row.operation_receipt?.nativeExecution||digest(row.operation_receipt.nativeExecution)!==digest(receipt)||
    !/^[a-f0-9]{64}$/.test(String(row.worker_id??''))||!/^[a-f0-9]{64}$/.test(String(row.tools_id??''))||row.worker_id===row.tools_id||
    physical.containerId!==row.worker_id||physical.toolsContainerId!==row.tools_id||physical.networkId!==row.network_id||
    !/^[a-f0-9]{64}$/.test(String(row.network_id??''))||row.network_id===this.config.providerNetworkId||
    (row.operation_receipt.cancellation===true?!row.cancellation_requested:
     (row.operation_receipt.exitCode!==payload.exitCode||(row.state==='completed'&&(!payload.artifact||
      row.operation_receipt.commit!==payload.artifact.commit||row.operation_receipt.tree!==payload.artifact.tree||row.operation_receipt.base!==payload.artifact.base||payload.artifact.base!==input.base))))||
    !Number.isFinite(Date.parse(physical.finishedAt))||!Number.isFinite(Date.parse(physical.toolsFinishedAt))||
    String(physical.finishedAt).startsWith('0001-')||String(physical.toolsFinishedAt).startsWith('0001-'))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   return row;
  };
  const pair=async(row:Record<string,any>,allowMissing:boolean)=>{
   const worker=await this.docker.inspect('ac-native-worker-'+jobId),tools=await this.docker.inspect('ac-native-tools-'+jobId);
   for(const [container,id,image,finished] of [[worker,row.worker_id,this.config.workerImage,row.physical_receipt.finishedAt],
    [tools,row.tools_id,this.config.toolsImage,row.physical_receipt.toolsFinishedAt]] as const){
    if(!container){if(!allowMissing)throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');continue;}
    if(container.Id!==id||container.Image!==image||container.Config.Labels['agent-control.job']!==jobId||container.Config.Labels['agent-control.launch']!==row.input_digest||
     container.Config.Labels['agent-control.contract']!=='native-execution-v1'||container.State.Running||container.State.Status!=='exited'||container.State.FinishedAt!==finished||
     (id===row.worker_id&&container.State.ExitCode!==row.physical_receipt.workerExitCode))
     throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   }
   return [worker,tools] as const;
  };
  const payloadFor=(row:Record<string,any>,saved:Record<string,any>)=>({schemaVersion:1,kind:'native-container-pair-removed',jobId,
   contextId:row.context_id,grantId:row.grant_id,attemptId:row.grant_attempt,parentIntentId:row.parent_intent_id,runId:row.run_id,
   holderIntentId:row.intent_id,writerEpoch:Number(row.writer_epoch),...(row.writer_continuation_digest?{writerContinuationDigest:row.writer_continuation_digest}:{}),workerId:saved.worker_id,toolsId:saved.tools_id,terminalDigest:saved.terminal_digest,
   workerLogSha256:saved.worker_log_sha256,toolsLogSha256:saved.tools_log_sha256});
  const checked=async(row:Record<string,any>,saved:Record<string,any>|undefined)=>{
   if(!saved||saved.parent_intent_id!==row.parent_intent_id||saved.run_id!==row.run_id||saved.holder_intent_id!==row.intent_id||
    Number(saved.writer_epoch)!==Number(row.writer_epoch)||saved.worker_id!==row.worker_id||saved.tools_id!==row.tools_id||saved.terminal_digest!==digest(row.receipt)||
    await readLog(logs[0]!)!==saved.worker_log_sha256||await readLog(logs[1]!)!==saved.tools_log_sha256)throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
  };
  const removeNetwork=async(row:Record<string,any>)=>retireNativePrivateNetwork(this.docker,{networkId:row.network_id,
   providerNetworkId:this.config.providerNetworkId,jobId,inputDigest:row.input_digest});
  const revoked=async(row:Record<string,any>,saved:Record<string,any>|undefined)=>{
   await checked(row,saved);const proof=saved!.proof;
   if(saved!.state!=='revoked'||row.revocation_job_id!==jobId||!proof?.payload||digest(proof.payload)!==digest(payloadFor(row,saved!))||
    typeof proof.signature!=='string'||!/^[a-f0-9]{128}$/.test(proof.signature)||
    !verify(null,Buffer.from('agent-control:native-writer-retirement:v1\n'+canonical(proof.payload)),createPublicKey(this.key),Buffer.from(proof.signature,'hex'))||
    digest(proof)!==row.proof_digest||digest(proof)!==digest(row.revocation_proof))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   if(await this.docker.inspect(saved!.worker_id)||await this.docker.inspect(saved!.tools_id)||
    await this.docker.inspect('ac-native-worker-'+jobId)||await this.docker.inspect('ac-native-tools-'+jobId))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   await removeNetwork(row);
  };
  const prepared=await this.ledger.tx(async c=>{
   const row=await locked(c),saved=(await c.query('SELECT * FROM ac_native_writer_retirements WHERE job_id=$1 FOR UPDATE',[jobId])).rows[0];
   if(row.writer_state==='neutralized'){await revoked(row,saved);return true;}
   if(row.writer_state!=='held')throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   await pair(row,Boolean(saved));
   if(!saved){
    const workerHash=await archive(logs[0]!,await this.docker.logs(row.worker_id)),toolsHash=await archive(logs[1]!,await this.docker.logs(row.tools_id));
    await c.query(`INSERT INTO ac_native_writer_retirements(job_id,parent_intent_id,run_id,holder_intent_id,writer_epoch,worker_id,tools_id,terminal_digest,worker_log_sha256,tools_log_sha256,state)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'prepared')`,[jobId,row.parent_intent_id,row.run_id,row.intent_id,row.writer_epoch,row.worker_id,row.tools_id,digest(row.receipt),workerHash,toolsHash]);
   }else{if(saved.state!=='prepared')throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');await checked(row,saved);}
   return false;
  });
  if(prepared){await this.removeLaunchFiles(jobId);return {state:'neutralized' as const};}
  const neutralized=await this.ledger.tx(async c=>{
   const row=await locked(c),saved=(await c.query('SELECT * FROM ac_native_writer_retirements WHERE job_id=$1 FOR UPDATE',[jobId])).rows[0];
   if(row.writer_state==='neutralized'){await revoked(row,saved);return {state:'neutralized' as const};}
   if(row.writer_state!=='held'||saved?.state!=='prepared')throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   await checked(row,saved);const observed=await pair(row,true);
   await this.removeRetiredContainerIds(observed.flatMap(container=>container?[container.Id]:[]));
   if(await this.docker.inspect(saved.worker_id)||await this.docker.inspect(saved.tools_id)||
    await this.docker.inspect('ac-native-worker-'+jobId)||await this.docker.inspect('ac-native-tools-'+jobId))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   await removeNetwork(row);
   const payload=payloadFor(row,saved),proof={payload,signature:sign(null,Buffer.from('agent-control:native-writer-retirement:v1\n'+canonical(payload)),this.key).toString('hex')};
   await c.query("UPDATE ac_native_writer_retirements SET state='revoked',proof=$2 WHERE job_id=$1 AND state='prepared'",[jobId,proof]);
   const changed=await c.query(`UPDATE ac_worktree_writers SET state='neutralized',proof_digest=$5,revocation_job_id=$6,revocation_proof=$7
    WHERE parent_intent_id=$1 AND run_id=$2 AND holder_intent_id=$3 AND manager_epoch=$4 AND state='held'`,
    [row.parent_intent_id,row.run_id,row.intent_id,row.writer_epoch,digest(proof),jobId,proof]);
   if(!changed.rowCount)throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'worktree.native_writer_revoked',$2)",[authority.contextId,{jobId,parentIntentId:row.parent_intent_id,runId:row.run_id,proofDigest:digest(proof)}]);
   return {state:'neutralized' as const};
  });
  await this.removeLaunchFiles(jobId);
  return neutralized;
 }
 /** Retire terminal resources only after their execution and downstream evidence are durable.
  * Managed writers use their separate worktree-neutralization protocol. */
 async retireTerminal(principal:string,authority:Authority,jobId:string){
  const input=await this.registeredInput(principal,authority,jobId);
  const outcome=await this.reconcile(principal,authority,input);
  if((outcome.state!=='completed'&&outcome.state!=='failed')||!('receipt' in outcome))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
  const p=this.paths(jobId);await this.directory(this.config.hostRoot);await this.directory(p.root);
  const paths=[join(p.root,'worker-terminal.log'),join(p.root,'tools-terminal.log')];
  const readLog=async(path:string)=>{
   try{await readNativeSecretSnapshot(p.secretSnapshot,jobId,this.key);}catch{return quarantineNativeLegacyLog(path,jobId,this.key);}
   const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(error=>{if(['ENOENT','ELOOP'].includes(String((error as NodeJS.ErrnoException).code)))throw new Refusal('NATIVE_RETIREMENT_LOG_INVALID');throw error;});
   try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>1048576)throw new Refusal('NATIVE_RETIREMENT_LOG_INVALID');return createHash('sha256').update(await file.readFile()).digest('hex');}finally{await file.close();}
  };
  const archive=async(path:string,raw:Buffer)=>{
   const bytes=await redactNativeLogsOrWithhold(raw,()=>readNativeSecretSnapshot(p.secretSnapshot,jobId,this.key));
   if(bytes.length>1048576)throw new Refusal('NATIVE_RETIREMENT_LOG_INVALID');
   const hash=createHash('sha256').update(bytes).digest('hex');
   try{const f=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}}
   catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
   if(await readLog(path)!==hash)throw new Refusal('NATIVE_RETIREMENT_LOG_INVALID');return hash;
  };
  const locked=async(c:pg.PoolClient)=>{
   await this.scope(c,principal,authority,input,true);
   const row=(await c.query(`SELECT j.*,g.state grant_state,g.physical_receipt,g.manager_epoch grant_epoch,g.intent_id grant_intent,g.context_id grant_context,g.account_id grant_account,g.profile_id grant_profile,g.role grant_role,g.resource_kind,
    i.parent_intent_id FROM ac_native_execution_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id JOIN ac_intents i ON i.id=j.intent_id AND i.context_id=j.context_id
    WHERE j.id=$1 AND j.context_id=$2 FOR UPDATE OF j,g`,[jobId,authority.contextId])).rows[0];
   const physical=row?.physical_receipt,receipt=row?.receipt,payload=receipt?.payload;
   if(!row||row.role!==input.role||(input.role==='programmer'&&row.parent_intent_id)||row.grant_state!=='released'||!['completed','failed'].includes(row.state)||
    row.input_digest!==digest(input)||row.executor_digest!==this.executorDigest||row.key_fingerprint!==this.fingerprint||row.intent_id!==input.intentId||row.grant_id!==input.grantId||row.session_id!==input.sessionId||
    row.grant_intent!==row.intent_id||row.grant_context!==row.context_id||row.grant_account!==row.account_id||row.grant_profile!==row.profile_id||row.grant_role!==row.role||row.resource_kind!=='model'||Number(row.grant_epoch)!==Number(row.manager_epoch)||Number(row.manager_epoch)>authority.epoch||
    digest(receipt)!==digest(outcome.receipt)||!payload||typeof receipt.signature!=='string'||!/^[a-f0-9]{128}$/.test(receipt.signature)||!verify(null,Buffer.from('agent-control:native-execution-receipt:v1\n'+canonical(payload)),createPublicKey(this.key),Buffer.from(receipt.signature,'hex'))||
    payload.jobId!==jobId||payload.contextId!==row.context_id||payload.intentId!==row.intent_id||payload.grantId!==row.grant_id||payload.sessionId!==row.session_id||payload.epoch!==Number(row.manager_epoch)||payload.inputDigest!==row.input_digest||payload.executorDigest!==this.executorDigest||
    !physical||payload.physicalDigest!==digest(physical)||physical.jobId!==jobId||physical.containerId!==row.worker_id||physical.toolsContainerId!==row.tools_id||physical.networkId!==row.network_id||physical.exitCode!==payload.exitCode||physical.workerExitCode!==payload.workerExitCode||((payload.exitCode===0)!==(row.state==='completed'))||
    !/^[a-f0-9]{64}$/.test(String(row.worker_id))||!/^[a-f0-9]{64}$/.test(String(row.tools_id))||row.worker_id===row.tools_id||!/^[a-f0-9]{64}$/.test(String(row.network_id))||row.network_id===this.config.providerNetworkId||
    !Number.isFinite(Date.parse(physical.finishedAt))||!Number.isFinite(Date.parse(physical.toolsFinishedAt))||String(physical.finishedAt).startsWith('0001-')||String(physical.toolsFinishedAt).startsWith('0001-'))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   if((input.role==='specialist'||input.role==='reviewer')&&['completed','failed'].includes(row.state)&&await this.personalReadonlyExam(c,input.intentId,input.role))return row;
   // Cancellation is terminal only once its independently persisted stage receipt is bound.
   const cancellation=(await c.query("SELECT 1 FROM ac_plan_cancellations WHERE intent_id=$1 AND context_id=$2",[input.intentId,authority.contextId])).rowCount;
   if(cancellation&&input.role!=='programmer'){
    const stage=(await c.query('SELECT * FROM ac_stage_operations WHERE id=$1 AND intent_id=$2 FOR UPDATE',[jobId,input.intentId])).rows[0];
    if(stage?.state!=='completed'||stage.grant_id!==input.grantId||stage.session_id!==input.sessionId||stage.receipt?.cancellation!==true||digest(stage.receipt.nativeExecution)!==digest(receipt))throw new Refusal('NATIVE_RETIREMENT_EVIDENCE_MISSING');
   }else if(row.state==='completed'&&['reviewer','judge'].includes(input.role)){
    const stage=(await c.query('SELECT * FROM ac_stage_operations WHERE id=$1 AND intent_id=$2 FOR UPDATE',[jobId,input.intentId])).rows[0];
    const evidence=stage?.receipt?.verification;
    // A reviewer that returned no usable verdict leaves no evidence; its closed stage is the terminal proof.
    if(stage?.state==='completed'&&stage.receipt?.invalidVerdict===true&&stage.grant_id===input.grantId&&stage.session_id===input.sessionId&&digest(stage.receipt.nativeExecution)===digest(receipt))return row;
    const stored=evidence&&(await c.query('SELECT receipt,receipt_digest FROM ac_verification_evidence WHERE id=$1 AND grant_id=$2 AND session_id=$3',[evidence.id,input.grantId,input.sessionId])).rows[0];
    if(stage?.state!=='completed'||stage.grant_id!==input.grantId||stage.session_id!==input.sessionId||digest(stage.receipt.nativeExecution)!==digest(receipt)||!stored||digest(stored.receipt)!==digest(evidence)||stored.receipt_digest!==digest(evidence))throw new Refusal('NATIVE_RETIREMENT_EVIDENCE_MISSING');
   }else if(input.role==='programmer'){
    const op=(await c.query('SELECT state,receipt FROM ac_operations WHERE id=$1 AND intent_id=$2 FOR UPDATE',[jobId,input.intentId])).rows[0];
    if(op?.state!=='completed'||digest(op.receipt?.nativeExecution)!==digest(receipt))throw new Refusal('NATIVE_RETIREMENT_EVIDENCE_MISSING');
   }else if(input.role==='qa'&&row.state==='completed'){
    const stage=(await c.query('SELECT * FROM ac_stage_operations WHERE id=$1 AND intent_id=$2 FOR UPDATE',[jobId,input.intentId])).rows[0];
    const verdict=stage?.receipt?.qaModel?.verdict;
    if(stage?.state!=='completed'||stage.grant_id!==input.grantId||stage.session_id!==input.sessionId||stage.node_id!=='qa'||(verdict!=='pass'&&verdict!=='reject')||digest(stage.receipt?.nativeExecution)!==digest(receipt))throw new Refusal('NATIVE_RETIREMENT_EVIDENCE_MISSING');
   }else if(row.state==='completed')throw new Refusal('NATIVE_RETIREMENT_EVIDENCE_MISSING');
   return row;
  };
  const pair=async(row:Record<string,any>,allowMissing:boolean)=>{
   const worker=await this.docker.inspect('ac-native-worker-'+jobId),tools=await this.docker.inspect('ac-native-tools-'+jobId);
   for(const [item,id,image,finished] of [[worker,row.worker_id,this.config.workerImage,row.physical_receipt.finishedAt],[tools,row.tools_id,this.config.toolsImage,row.physical_receipt.toolsFinishedAt]] as const){
    if(!item){if(!allowMissing)throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');continue;}
    if(item.Id!==id||item.Image!==image||item.Config.Labels['agent-control.job']!==jobId||item.Config.Labels['agent-control.launch']!==row.input_digest||item.Config.Labels['agent-control.contract']!=='native-execution-v1'||item.State.Running||item.State.Status!=='exited'||item.State.FinishedAt!==finished||(id===row.worker_id&&item.State.ExitCode!==row.physical_receipt.workerExitCode))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   }return [worker,tools] as const;
  };
  const binding=(row:Record<string,any>,hashes:string[])=>({schemaVersion:1,jobId,contextId:row.context_id,intentId:row.intent_id,grantId:row.grant_id,sessionId:row.session_id,epoch:Number(row.manager_epoch),role:row.role,inputDigest:row.input_digest,terminalDigest:digest(row.receipt),workerId:row.worker_id,toolsId:row.tools_id,networkId:row.network_id,workerLogSha256:hashes[0],toolsLogSha256:hashes[1]});
  const check=async(row:Record<string,any>,saved:Record<string,any>)=>{
   if(!saved||digest(saved.binding)!==digest(binding(row,[await readLog(paths[0]!),await readLog(paths[1]!)])))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   if(saved.state==='removed'&&(!saved.proof?.payload||digest(saved.proof.payload)!==digest(saved.binding)||typeof saved.proof.signature!=='string'||!/^[a-f0-9]{128}$/.test(saved.proof.signature)||!verify(null,Buffer.from('agent-control:native-terminal-retirement:v1\n'+canonical(saved.proof.payload)),createPublicKey(this.key),Buffer.from(saved.proof.signature,'hex'))))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
  };
  await this.ledger.tx(async c=>{
   const row=await locked(c),saved=(await c.query('SELECT * FROM ac_native_terminal_retirements WHERE job_id=$1 FOR UPDATE',[jobId])).rows[0];
   await pair(row,Boolean(saved));
   if(saved){await check(row,saved);return;}
   const hashes=[await archive(paths[0]!,await this.docker.logs(row.worker_id)),await archive(paths[1]!,await this.docker.logs(row.tools_id))];
   // Persist directory entries before committing the prepared journal.
   const dir=await open(p.root,constants.O_RDONLY);try{await dir.sync();}finally{await dir.close();}
   await c.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[jobId,binding(row,hashes)]);
  });
  const retired=await this.ledger.tx(async c=>{
   const row=await locked(c),saved=(await c.query('SELECT * FROM ac_native_terminal_retirements WHERE job_id=$1 FOR UPDATE',[jobId])).rows[0];await check(row,saved);
   const items=await pair(row,true);if(saved.state==='removed'&&items.some(Boolean))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   await this.removeRetiredContainerIds(items.flatMap(item=>item?[item.Id]:[]));
   if(await this.docker.inspect(row.worker_id)||await this.docker.inspect(row.tools_id)||await this.docker.inspect('ac-native-worker-'+jobId)||await this.docker.inspect('ac-native-tools-'+jobId))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   await retireNativePrivateNetwork(this.docker,{networkId:row.network_id,providerNetworkId:this.config.providerNetworkId,jobId,inputDigest:row.input_digest});
   if(saved.state==='prepared'){
    const proof={payload:saved.binding,signature:sign(null,Buffer.from('agent-control:native-terminal-retirement:v1\n'+canonical(saved.binding)),this.key).toString('hex')};
    await c.query("UPDATE ac_native_terminal_retirements SET state='removed',proof=$2 WHERE job_id=$1 AND state='prepared'",[jobId,proof]);
    await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'native.terminal_retired',$2)",[authority.contextId,{jobId,proofDigest:digest(proof)}]);
   }else if(saved.state!=='removed')throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   return {state:'removed' as const};
  });
  await this.removeLaunchFiles(jobId);
  return retired;
 }
}
