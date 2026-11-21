/** Retention of the `work` copy of terminal jobs: judgment, checkout identity and guarded removal. */
import {examineWorkTree,pinRetainedArtifact,repositoryHasCommit,repositoryTreeOf,retainedArtifact,workHoldsNoUnregisteredChange,type WorkIdentity,type WorkOperation} from './native-work-retention.ts';
import {fenceInstallationContext} from './installation-authority-fence.ts';
import {lstat,writeFile,type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {createPublicKey,sign,verify} from 'node:crypto';
import pg from 'pg';
import {Authority,canonical,digest,Refusal} from './contracts.ts';
import {readPrivateWorkerFile} from './native-worker-security.ts';
import {Id,type ModuleExamWorkRelease,type TerminalWorkCategory,type TerminalWorkRefusal,type TerminalWorkRelease,type TerminalWorkObserver,type TerminalWorkOptions,type TerminalWorkJudgment,terminalWorkClass,terminalWorkLockKey,readonlyDesignExam,NativeExecutionRequest,type Input,Result,readonlySecurityExam} from './native-execution-shared.ts';
import {NativeExecutionRetirement} from './native-execution-retirement.ts';
export abstract class NativeExecutionTerminalWork extends NativeExecutionRetirement{
 /** Frees only the `work` checkout copy of one finished passive security/module exam (specialist, `security-verify-readonly-v1`).
  * The answer lives in output/execution-result.json and nothing reads `work` once the job is completed, its grant released and its
  * terminal retirement signed as removed (containers and network gone). review-artifact, proofs, logs and sibling jobs are never touched.
  * Runs under the context lease and the job row lock, so it serializes with reconcile and retirement. Idempotent: no `work` is `absent`.
  * `apply=false` only inspects. Programmer, design and any job without the full proof are refused. */
 async releaseModuleExamWork(principal:string,authority:Authority,jobId:string,apply:boolean):Promise<ModuleExamWorkRelease>{
  return await this.terminalWork(jobId,apply,{principal,contextId:authority.contextId,categories:['passive-exam'],failed:false,lease:authority}) as ModuleExamWorkRelease;
 }
 /** Automatic retention of the `work` copy of one terminal job, with no context lease and no stopped gateway.
  * Safe because nothing here depends on the manager: a terminal job row is immutable (trigger), its grant is released, its receipt and
  * physical retirement proof are signed, and replay reads only `output/`, `request.json` and the project repository. Mutual exclusion is a
  * per-job advisory lock on a dedicated session, shared with the manual path and with `registerArtifact`. One abort signal, created before
  * the lock is requested, follows that session: if it is lost during preparation or removal, nothing more is removed.
  * Only jobs the explicit classification (`terminalWorkClass`) names are candidates, and each needs its own proof:
  * - read-only roles: the signed request proves a read-only mount mode, and the base commit is still in the project repository;
  * - programmers: the registered artifact is pinned by a private, never-moved ref of this job, and the checkout holds no change the
  *   repository does not keep. A failed programmer is freed only when its checkout equals its base exactly.
  * Managed children are judged like any other job, with the physical proof of their own protocol (the signed writer revocation).
  * A job that never started has no proven checkout and is kept. */
 async retireTerminalWork(principal:string,jobId:string,apply:boolean,scope:{contextId:string;projectId:string;repository:string;observe?:TerminalWorkObserver}):Promise<TerminalWorkRelease>{
  return this.terminalWork(jobId,apply,{principal,contextId:scope.contextId,projectId:scope.projectId,repository:scope.repository,categories:['passive-exam','readonly-evaluator','programmer-artifact'],failed:true,automatic:true,observe:scope.observe});
 }
 /** The signed request is the mode proof: it is bound to the job row and receipt by its digest, and the launch only happened after the physical
  * inspection refused any writable `/work` for a role other than programmer (native-execution-isolation). */
 /** Signed at launch, right after the snapshot: which directory the evaluator's checkout is, and the tree it must hold. */
 protected async writeCheckoutIdentity(repository:string,jobId:string,base:string,work:string){
  const tree=await repositoryTreeOf(repository,base);
  if(!tree)return;
  const st=await lstat(work,{bigint:true});
  const payload={jobId,base,tree,dev:String(st.dev),ino:String(st.ino)};
  const signature=sign(null,Buffer.from('agent-control:native-checkout-identity:v1\n'+canonical(payload)),this.key).toString('hex');
  await writeFile(join(this.paths(jobId).root,'checkout-identity.json'),JSON.stringify({payload,signature}),{mode:0o600,flag:'wx'});
 }
 /** The tree an evaluator checkout must hold, or undefined when the identity is missing, forged, for another job/base, or the directory was replaced. */
 protected async checkoutIdentityTree(repository:string,jobId:string,base:string,work:string):Promise<string|undefined>{
  try{
   const bytes=await readPrivateWorkerFile(join(this.paths(jobId).root,'checkout-identity.json'),64*1024);
   let saved:any;try{saved=JSON.parse(bytes.toString('utf8'));}finally{bytes.fill(0);}
   const payload=saved?.payload;
   if(!payload||typeof saved.signature!=='string'||!/^[a-f0-9]{128}$/.test(saved.signature))return undefined;
   if(!verify(null,Buffer.from('agent-control:native-checkout-identity:v1\n'+canonical(payload)),createPublicKey(this.key),Buffer.from(saved.signature,'hex')))return undefined;
   if(payload.jobId!==jobId||payload.base!==base||!/^[a-f0-9]{40}$/.test(String(payload.tree)))return undefined;
   if(await repositoryTreeOf(repository,base)!==payload.tree)return undefined;
   const st=await lstat(work,{bigint:true});
   if(!st.isDirectory()||String(st.dev)!==payload.dev||String(st.ino)!==payload.ino)return undefined;
   return payload.tree as string;
  }catch{return undefined;}
 }
 protected async requestProvesMode(jobId:string,row:Record<string,any>){
  try{
   const p=this.paths(jobId);await this.directory(p.root);
   const bytes=await readPrivateWorkerFile(join(p.root,'request.json'),512*1024);
   let input:Input;try{input=NativeExecutionRequest.parse(JSON.parse(bytes.toString('utf8')));}finally{bytes.fill(0);}
   const writes=row.role==='programmer';
   return input.jobId===jobId&&input.intentId===row.intent_id&&input.grantId===row.grant_id&&input.sessionId===row.session_id&&input.role===row.role&&input.base===row.base_id&&
    digest(input)===row.input_digest&&(writes?input.writePaths.length>0:input.writePaths.length===0)&&
    /^[a-f0-9]{64}$/.test(String(row.launch_digest))&&/^[a-f0-9]{64}$/.test(String(row.worker_id))&&/^[a-f0-9]{64}$/.test(String(row.tools_id))&&row.worker_id!==row.tools_id;
  }catch{return false;}
 }
 /** Physical terminality of a managed writer: its own signed revocation, bound to this receipt and containers, and the neutralized writer row. */
 protected async managedWriterRetired(c:pg.PoolClient,jobId:string,row:Record<string,any>){
  const saved=(await c.query(`SELECT r.*,w.state writer_state,w.revocation_job_id,w.proof_digest FROM ac_native_writer_retirements r
   JOIN ac_worktree_writers w ON w.parent_intent_id=r.parent_intent_id AND w.run_id=r.run_id AND w.holder_intent_id=r.holder_intent_id WHERE r.job_id=$1`,[jobId])).rows[0];
  try{
   const proof=saved?.proof,payload=proof?.payload;
   return Boolean(saved)&&saved.state==='revoked'&&saved.parent_intent_id===row.parent_intent_id&&saved.holder_intent_id===row.intent_id&&
    saved.writer_state==='neutralized'&&saved.revocation_job_id===jobId&&saved.proof_digest===digest(proof)&&
    payload?.kind==='native-container-pair-removed'&&payload.jobId===jobId&&payload.contextId===row.context_id&&payload.grantId===row.grant_id&&payload.holderIntentId===row.intent_id&&
    payload.terminalDigest===digest(row.receipt)&&payload.workerId===row.worker_id&&payload.toolsId===row.tools_id&&saved.terminal_digest===digest(row.receipt)&&
    typeof proof.signature==='string'&&/^[a-f0-9]{128}$/.test(proof.signature)&&
    verify(null,Buffer.from('agent-control:native-writer-retirement:v1\n'+canonical(payload)),createPublicKey(this.key),Buffer.from(proof.signature,'hex'));
  }catch{return false;}
 }
 /** `artifacts`: 'preview' accepts an artifact the repository holds that a later prepare would pin; 'pin' creates the private ref by CAS;
  * 'strict' requires the ref to exist already (release phase and the judgment that records the outcome). */
 protected async judgeTerminalWork(c:pg.PoolClient,jobId:string,o:TerminalWorkOptions,artifacts:'preview'|'pin'|'strict'):Promise<{refusal:TerminalWorkRefusal}|TerminalWorkJudgment>{
  const refuse=(refusal:TerminalWorkRefusal)=>({refusal});
  const owner=await c.query("SELECT 1 FROM ac_memberships m JOIN ac_contexts x ON x.project_id=m.project_id WHERE x.id=$1 AND m.principal_id=$2 AND m.role='owner' FOR SHARE OF m",[o.contextId,o.principal]);
  if(!owner.rowCount)return refuse('not_passive_exam');
  const row=(await c.query(`SELECT j.*,x.project_id,g.state grant_state,g.physical_receipt,g.selection->>'designPurpose' design_purpose,g.manager_epoch grant_epoch,g.intent_id grant_intent,g.context_id grant_context,g.account_id grant_account,g.profile_id grant_profile,g.role grant_role,g.resource_kind,
   i.parent_intent_id,i.principal_id,i.command->'payload'->>'workflow' workflow,r.state retirement_state,r.binding,r.proof,ac_activation_personal() personal
   FROM ac_native_execution_jobs j JOIN ac_contexts x ON x.id=j.context_id JOIN ac_capacity_grants g ON g.id=j.grant_id JOIN ac_intents i ON i.id=j.intent_id AND i.context_id=j.context_id
   LEFT JOIN ac_native_terminal_retirements r ON r.job_id=j.id
   WHERE j.id=$1 AND j.context_id=$2 FOR ${o.lease?'UPDATE':'SHARE'} OF j,g`,[jobId,o.contextId])).rows[0];
  if(!row)return refuse('not_found');
  if(o.projectId&&row.project_id!==o.projectId)return refuse('not_found');
  const passive=row.role==='specialist'&&(readonlySecurityExam(row.workflow,row.role)||(readonlyDesignExam(row.workflow,row.role)&&['examiner','reviewer','visual'].includes(row.design_purpose)));
  const kind=terminalWorkClass(row.workflow,row.role);
  const category:TerminalWorkCategory=passive?'passive-exam':row.role==='programmer'?'programmer-artifact':'readonly-evaluator';
  if(!row.personal||row.principal_id!==o.principal||!o.categories.includes(category))return refuse('not_passive_exam');
  // The manual path keeps its historical scope (top-level passive exams). The automatic one has no generic parent rule: children need the same proofs.
  if(!o.automatic&&row.parent_intent_id!==null)return refuse('not_passive_exam');
  if(o.automatic&&!passive&&kind!==(category==='programmer-artifact'?'programmer':'readonly'))return refuse('unclassified');
  if(row.state!=='completed'&&!(o.failed&&row.state==='failed'))return refuse('job_state');
  if(row.grant_state!=='released'||row.grant_intent!==row.intent_id||row.grant_context!==row.context_id||row.grant_account!==row.account_id||row.grant_profile!==row.profile_id||row.grant_role!==row.role||row.resource_kind!=='model'||Number(row.grant_epoch)!==Number(row.manager_epoch))return refuse('grant_state');
  if(row.key_fingerprint!==this.fingerprint)return refuse('supervisor_identity');
  const receipt=row.receipt,payload=receipt?.payload,physical=row.physical_receipt,binding=row.binding,proof=row.proof;
  const receiptProven=this.receiptSignedByThisExecutor(receipt)&&payload.jobId===jobId&&payload.contextId===row.context_id&&payload.intentId===row.intent_id&&payload.grantId===row.grant_id&&payload.sessionId===row.session_id&&
   payload.epoch===Number(row.manager_epoch)&&payload.inputDigest===row.input_digest&&payload.executorDigest===row.executor_digest&&(payload.exitCode===0)===(row.state==='completed')&&payload.executionStarted!==false&&
   Boolean(physical)&&payload.physicalDigest===digest(physical)&&physical.jobId===jobId&&physical.containerId===row.worker_id&&physical.toolsContainerId===row.tools_id&&physical.networkId===row.network_id;
  if(!receiptProven)return refuse('receipt');
  if(o.automatic){try{await this.directory(this.config.hostRoot);await this.directory(this.paths(jobId).root);}catch{return refuse('directory_unsafe');}}
  // A job that never launched has no checkout proven by a signed launch: it is kept.
  if(o.automatic&&!await this.requestProvesMode(jobId,row))return refuse('mode_unproven');
  // Physical terminality: the signed removal of containers and network, or, for a managed writer, its signed revocation.
  const managedWriter=category==='programmer-artifact'&&row.parent_intent_id!==null;
  if(managedWriter){
   if(!await this.managedWriterRetired(c,jobId,row))return refuse('retirement');
  }else{
   let retirementProven=false;
   try{
    retirementProven=row.retirement_state==='removed'&&Boolean(binding)&&digest(proof?.payload)===digest(binding)&&typeof proof.signature==='string'&&/^[a-f0-9]{128}$/.test(proof.signature)&&
     verify(null,Buffer.from('agent-control:native-terminal-retirement:v1\n'+canonical(proof.payload)),createPublicKey(this.key),Buffer.from(proof.signature,'hex'))&&
     binding.jobId===jobId&&binding.contextId===row.context_id&&binding.intentId===row.intent_id&&binding.grantId===row.grant_id&&binding.sessionId===row.session_id&&binding.inputDigest===row.input_digest&&
     binding.terminalDigest===digest(receipt)&&binding.workerId===row.worker_id&&binding.toolsId===row.tools_id&&binding.networkId===row.network_id&&(!o.automatic||binding.role===row.role);
   }catch{retirementProven=false;}
   if(!retirementProven)return refuse('retirement');
  }
  let checkWork:TerminalWorkJudgment['checkWork'];
  if(category!=='passive-exam'){
   if(!o.repository)return refuse(category==='programmer-artifact'?'artifact_unpreserved':'base_unpreserved');
   if(category==='readonly-evaluator'&&!await repositoryHasCommit(o.repository,row.base_id))return refuse('base_unpreserved');
   if(category==='programmer-artifact'){
    const artifact=payload.artifact,repository=o.repository;
    let expected:string|undefined;
    if(row.state==='completed'){
     if(!artifact||artifact.base!==row.base_id)return refuse('artifact_unpreserved');
     const registered=await c.query('SELECT 1 FROM ac_artifacts WHERE intent_id=$1 AND implementation_grant_id=$2 AND implementation_session_id=$3 AND commit_id=$4 AND tree_id=$5 AND base_id=$6 LIMIT 1',
      [row.intent_id,row.grant_id,row.session_id,artifact.commit,artifact.tree,artifact.base]);
     if(!registered.rowCount)return refuse('artifact_unpreserved');
     const pinned=await retainedArtifact(repository,jobId);
     if(pinned===undefined&&artifacts==='pin'){
      if(!['created','kept'].includes(await pinRetainedArtifact(repository,jobId,artifact.commit,artifact.tree)))return refuse('artifact_unpreserved');
     }else if(pinned===undefined&&artifacts==='preview'){
      if(await repositoryTreeOf(repository,artifact.commit)!==artifact.tree)return refuse('artifact_unpreserved');
     }else if(pinned!==artifact.commit)return refuse('artifact_unpreserved');
     if(artifacts!=='preview'&&(await retainedArtifact(repository,jobId)!==artifact.commit||await repositoryTreeOf(repository,artifact.commit)!==artifact.tree))return refuse('artifact_unpreserved');
     expected=artifact.tree;
    }else{
     // A failed run has no registered artifact: its checkout may go only when it is exactly its base.
     const finalized=await c.query("SELECT 1 FROM ac_native_artifact_finalizations WHERE job_id=$1 AND state<>'failed'",[jobId]);
     if(artifact||finalized.rowCount)return refuse('artifact_unpreserved');
     expected=await repositoryTreeOf(repository,row.base_id);
     if(!expected)return refuse('base_unpreserved');
    }
    if(!expected)return refuse('artifact_unpreserved');
    const tree=expected,work=this.paths(jobId).work;
    checkWork=signal=>workHoldsNoUnregisteredChange(repository,work,tree,signal);
   }
   else if(category==='readonly-evaluator'){
    // An evaluator's checkout is the snapshot made at launch: the same directory (signed identity) holding exactly the base tree, nothing the host added.
    const repository=o.repository,work=this.paths(jobId).work,base=row.base_id as string;
    checkWork=async signal=>{
     const tree=await this.checkoutIdentityTree(repository,jobId,base,work);
     return tree!==undefined&&await workHoldsNoUnregisteredChange(repository,work,tree,signal);
    };
   }
  }
  const state=row.state as 'completed'|'failed';
  const checkOutput=async(output:FileHandle)=>{
   try{
    const bytes=await readPrivateWorkerFile(join('/proc/self/fd',String(output.fd),'execution-result.json'),2*1024*1024);
    const result=Result.parse(JSON.parse(bytes.toString('utf8')));
    const good=state==='completed'?result.exitCode===0&&result.failureCode===null:result.exitCode===payload.workerExitCode;
    if(result.jobId!==jobId||!good||digest(result.output)!==payload.outputDigest)throw Error();
   }catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Refusal('NATIVE_EXECUTION_OUTPUT_MISSING');
    throw new Refusal('NATIVE_EXECUTION_OUTPUT_INVALID');
   }
  };
  return {category,terminalDigest:digest(receipt),checkOutput,...(checkWork?{checkWork}:{})};
 }
 protected async terminalWork(jobId:string,apply:boolean,o:TerminalWorkOptions):Promise<TerminalWorkRelease>{
  Id.parse(jobId);Id.parse(o.contextId);
  const refuse=(reason:TerminalWorkRefusal)=>({jobId,state:'refused' as const,reason});
  const planned='native.exam_work_release_planned',released='native.exam_work_released',unattributed='native.exam_work_absent_after_plan';
  const lockKey=terminalWorkLockKey(jobId);
  // One abort signal for the whole retirement, created before any lock is requested. Every session that holds the job lock feeds it;
  // once aborted it stays aborted, so no later phase and no removal can run unprotected.
  const canceled=new AbortController();
  const lost=()=>canceled.abort(new Refusal('NATIVE_WORK_SESSION_LOST'));
  const follow=(session:pg.ClientBase)=>{session.on('error',lost);session.on('end',lost);return ()=>{session.off('error',lost);session.off('end',lost);};};
  type Phase='preview'|'prepare'|'release';
  // Everything one phase needs from the database, read under the caller's transaction.
  type Seen={judged:TerminalWorkJudgment;previous?:Record<string,any>;completed?:Record<string,any>;snapshot?:WorkIdentity};
  const read=async(c:pg.PoolClient,phase:Phase,artifacts:'preview'|'pin'|'strict'):Promise<{refusal:TerminalWorkRefusal}|Seen>=>{
   const judged=await this.judgeTerminalWork(c,jobId,o,artifacts);
   if('refusal' in judged)return judged;
   try{await this.directory(this.config.hostRoot);await this.directory(this.paths(jobId).root);}catch{return {refusal:'directory_unsafe'};}
   const audit=async(kind:string)=>(await c.query("SELECT detail FROM ac_audit WHERE context_id=$1 AND kind=$2 AND detail->>'jobId'=$3 LIMIT 1",[o.contextId,kind,jobId])).rows[0]?.detail;
   const previous=await audit(planned),completed=await audit(released)??await audit(unattributed);
   const snapshot=previous?.snapshot as WorkIdentity|undefined;
   if(previous&&(previous.terminalDigest!==judged.terminalDigest||!snapshot||!/^\d+:\d+$/.test(snapshot.job)||!/^\d+:\d+$/.test(snapshot.work)||!Number.isSafeInteger(snapshot.bytes)))return {refusal:'retirement'};
   if(phase==='release'&&(!snapshot||completed))return {refusal:'work_unsafe'};
   return {judged,previous,completed,snapshot};
  };
  // The checkout proof runs on the very directory that was (or is about to be) planned: same device and inode.
  const workUnchanged=async(seen:Seen,identity:string|undefined)=>{
   if(!seen.judged.checkWork)return true;
   const current=await lstat(this.paths(jobId).work,{bigint:true}).catch(()=>undefined/* absent work dir is a valid state, judged below */);
   if(!current)return true; // Nothing left to protect; the removal step reports `absent`.
   if(!current.isDirectory()||(identity&&current.dev+':'+current.ino!==identity))return false;
   return seen.judged.checkWork(canceled.signal);
  };
  const examine=async(seen:Seen,phase:Phase):Promise<WorkOperation|{refusal:TerminalWorkRefusal}>=>{
   if(canceled.signal.aborted)return {refusal:'session_lost'};
   try{
    if(phase==='release'&&!await workUnchanged(seen,seen.snapshot?.work))return {refusal:canceled.signal.aborted?'session_lost':'unregistered_change'};
    if(phase==='release')await o.observe?.('removing');
    if(canceled.signal.aborted)return {refusal:'session_lost'};
    const operation=await examineWorkTree(this.config.hostRoot,jobId,seen.judged.checkOutput,phase==='release'?seen.snapshot:undefined,canceled.signal);
    if(operation.state==='present'&&!await workUnchanged(seen,operation.snapshot.work))return {refusal:canceled.signal.aborted?'session_lost':'unregistered_change'};
    return operation;
   }
   catch(error){return {refusal:canceled.signal.aborted?'session_lost':error instanceof Refusal&&error.code==='NATIVE_EXECUTION_OUTPUT_MISSING'?'output_missing':error instanceof Refusal&&error.code==='NATIVE_EXECUTION_OUTPUT_INVALID'?'receipt':'work_unsafe'};}
  };
  const conclude=async(c:pg.PoolClient,seen:Seen,phase:Phase,operation:WorkOperation):Promise<TerminalWorkRelease>=>{
   const {previous,completed,snapshot,judged}=seen;
   const record=async(kind:string,identity:WorkIdentity)=>c.query('INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,$2,$3)',[o.contextId,kind,{jobId,snapshot:identity,terminalDigest:judged.terminalDigest}]);
   const category=judged.category;
   if(phase==='release'&&snapshot){
    if(operation.state==='present')return refuse('work_unsafe');
    await record(operation.state==='released'?released:unattributed,snapshot);
    return {jobId,state:operation.state,bytes:operation.state==='released'?snapshot.bytes:0,category};
   }
   if(operation.state==='absent'){
    if(phase==='prepare'&&snapshot&&!completed)return {jobId,state:'eligible' as const,bytes:snapshot.bytes,category};
    return {jobId,state:'absent' as const};
   }
   if(operation.state!=='present'||completed)return refuse('work_unsafe');
   if(snapshot&&(snapshot.job!==operation.snapshot.job||snapshot.work!==operation.snapshot.work))return refuse('work_unsafe');
   if(phase==='prepare'&&!previous){
    if(canceled.signal.aborted)return refuse('session_lost');
    await record(planned,operation.snapshot);
   }
   return {jobId,state:'eligible' as const,bytes:operation.snapshot.bytes,category};
  };
  if(o.lease){
   const leased=async(phase:Phase)=>this.ledger.tx(async c=>{
    const unfollow=follow(c);
    try{
     await this.ledger.authorize(c,o.principal,o.contextId);await this.ledger.fence(c,o.lease!,true);
     if(!(await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) ok',[lockKey])).rows[0].ok)return refuse('busy');
     const seen=await read(c,phase,phase==='preview'?'preview':phase==='prepare'?'pin':'strict');
     if('refusal' in seen)return refuse(seen.refusal);
     const operation=await examine(seen,phase);
     if('refusal' in operation)return refuse(operation.refusal);
     return conclude(c,seen,phase,operation);
    }finally{unfollow();}
   });
   const first=await leased(apply?'prepare':'preview');
   return apply&&first.state==='eligible'?leased('release'):first;
  }
  // Lease-free: one dedicated session holds the per-job lock for the whole retirement; the database work is in short transactions around it.
  // Created after the abort controller, before the lock is requested; it is followed from the first instant.
  let session:pg.Client;
  try{session=await this.workLockSession();}catch{return refuse('session_lost');}
  const unfollow=follow(session);
  let locked=false,heartbeat:ReturnType<typeof setInterval>|undefined;
  // The lock must still be held by this very session; any failure aborts.
  const protectedNow=async()=>{
   if(canceled.signal.aborted)return false;
   try{
    const held=(await session.query(`SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND granted AND pid=pg_backend_pid()
     AND ((classid::bigint<<32)|objid::bigint)=hashtextextended($1,0) AND objsubid=1`,[lockKey])).rows[0].n===1;
    if(!held)lost();
   }catch{lost();}
   return !canceled.signal.aborted;
  };
  try{
   if(canceled.signal.aborted)return refuse('session_lost');
   if(!(await session.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok',[lockKey])).rows[0].ok)return refuse('busy');
   locked=true;
   await o.observe?.('locked');
   const phase=async(name:Phase)=>{
    if(!await protectedNow())return refuse('session_lost');
    const seen=await this.ledger.tx(async c=>{
     await fenceInstallationContext(c,o.contextId,this.ledger.installationAuthority,true);
     return read(c,name,name==='preview'?'preview':name==='prepare'?'pin':'strict');
    });
    if('refusal' in seen)return refuse(seen.refusal);
    if(name==='release'){
     if(!await protectedNow())return refuse('session_lost');
     // While the tree is removed the session is probed; a lost or released lock kills the helper.
     heartbeat=setInterval(()=>{void protectedNow();},500);
    }
    let operation;
    try{operation=await examine(seen,name);}finally{if(heartbeat){clearInterval(heartbeat);heartbeat=undefined;}}
    if('refusal' in operation)return refuse(operation.refusal);
    // Re-judge in the transaction that records the outcome: the proof must still hold when the audit row is written.
    const result=await this.ledger.tx(async c=>{
     await fenceInstallationContext(c,o.contextId,this.ledger.installationAuthority,true);
     const again=await read(c,name==='release'?'prepare':name,name==='preview'?'preview':'strict');
     if('refusal' in again||again.judged.terminalDigest!==seen.judged.terminalDigest)return refuse('retirement');
     if(name!=='release'&&!await protectedNow())return refuse('session_lost');
     return conclude(c,{...again,snapshot:seen.snapshot,previous:again.previous,completed:again.completed},name,operation);
    });
    if(name==='prepare'&&result.state==='eligible')await o.observe?.('prepared');
    return result;
   };
   const first=await phase(apply?'prepare':'preview');
   return apply&&first.state==='eligible'?await phase('release'):first;
  }finally{
   if(heartbeat)clearInterval(heartbeat);
   if(locked&&!canceled.signal.aborted)await session.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lockKey]).catch(()=>undefined/* the lock dies with the session ended next */);
   unfollow();
   // Closing the dedicated connection releases whatever it still holds; it is never reused.
   await session.end().catch(()=>undefined);
  }
 }
}
