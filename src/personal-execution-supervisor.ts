import {execFile} from 'node:child_process';
import {randomUUID,sign} from 'node:crypto';
import {lstat,mkdir,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {z} from 'zod';
import {AccountHomes} from './account-homes.ts';
import {canonical,digest,Refusal,type Authority} from './contracts.ts';
import {NativeExecutionSupervisor,NativeExecutionRequest} from './native-execution-supervisor.ts';
import {withGrantLaunchLock,type NativeExecutionOutcome,type NativeExecutionRecovery} from './native-execution-shared.ts';
import {NativeArtifactIdentity} from './native-artifact-finalizer.ts';
import {assertDiskSpaceForLaunch} from './personal-disk.ts';
import {assertModelAllowed} from './model-policy.ts';
import {requireProjectEnvironmentLaunch} from './project-environments.ts';
import {removeSimpleWorktree,releaseIdleSharedWorktrees} from './simple-worktree.ts';
import {Usage} from './usage.ts';

const exec=promisify(execFile);
export const hostLaunchDigest=digest('personal-host-systemd-v1');
const unit=(id:string)=>'ac-simple-'+z.uuid().parse(id)+'.service';
const worker=fileURLToPath(new URL('./simple-execution-worker.'+(import.meta.url.endsWith('.ts')?'ts':'js'),import.meta.url));
async function activeUnit(id:string){
 const {stdout}=await exec('systemctl',['--user','show',unit(id),'--property=ActiveState','--value']);
 return !['inactive','failed'].includes(stdout.trim());
}

/** The user service owns the whole CLI process group across gateway restarts.
 * The grant lock serializes start/observe/stop, including the interval between
 * recording a host job and systemd accepting it. */
export class PersonalExecutionSupervisor extends NativeExecutionSupervisor{
 private async hostRow(id:string){
  return (await this.ledger.pool.query('SELECT * FROM ac_native_execution_jobs WHERE id=$1 AND launch_digest=$2',[id,hostLaunchDigest])).rows[0];
 }
 override async start(principal:string,authority:Authority,raw:z.input<typeof NativeExecutionRequest>,signal?:AbortSignal){
  const input=NativeExecutionRequest.parse(raw);
  // Replays use the recorded mode even after the installation toggles isolation.
  // A host reconciliation takes its own grant lock.
  const prior=(await this.ledger.pool.query('SELECT launch_digest FROM ac_native_execution_jobs WHERE id=$1',[input.jobId])).rows[0];
  if(prior)return this.reconcile(principal,authority,input);
  if(!this.config.simple||input.designPurpose)return super.start(principal,authority,input,signal);
  const workflow=(await this.ledger.pool.query("SELECT command->'payload'->>'workflow' workflow FROM ac_intents WHERE id=$1",[input.intentId])).rows[0]?.workflow;
  if(workflow==='design-readonly-v1')return super.start(principal,authority,input,signal);
  return withGrantLaunchLock(this.ledger,input.grantId,async()=>{
   const concurrent=await this.hostRow(input.jobId);
   if(concurrent){await this.validateReplay(principal,authority,input,concurrent);return {state:'running' as const};}
   if(!this.active||!this.config.provider||input.model||input.effort)throw new Refusal('NATIVE_EXECUTION_NOT_ELIGIBLE');
   await assertDiskSpaceForLaunch([...(this.ledger.launchVolumes??[]),this.config.hostRoot]);
   await this.diskGuard?.assertAdmission();
   signal?.throwIfAborted();
   const p=this.paths(input.jobId);
   const g=await this.ledger.tx(async c=>{
    const grant=await this.identity(c,principal,authority,input);
    if(!(await c.query('SELECT 1 WHERE ac_activation_personal()')).rowCount)throw new Refusal('PERSONAL_ACTIVATION_REQUIRED');
    assertModelAllowed(grant.model);
    if(input.role==='programmer')await requireProjectEnvironmentLaunch(c,{intentId:input.intentId,base:input.base});
    return grant;
   });
   await new AccountHomes(this.ledger,this.config.accountRoot,this.config.protectedRepositories).inspectGranted(principal,input.grantId,authority);
   const repo=await this.jobRepository(this.ledger.pool,g.project_id);
   const reviewBase=input.artifactId&&!input.moduleExam&&input.role!=='programmer'
    ?(await this.ledger.pool.query('SELECT base_id FROM ac_artifacts WHERE id=$1 AND commit_id=$2',[input.artifactId,input.base])).rows[0]?.base_id:undefined;
   await this.directory(this.config.hostRoot);
   await mkdir(p.root,{mode:0o700});
   try{
    await mkdir(p.output,{mode:0o700});
    await writeFile(join(p.root,'request.json'),JSON.stringify(input),{mode:0o600,flag:'wx'});
    const home=join(this.config.accountRoot,g.account_id);
    await writeFile(join(p.root,'host-job.json'),JSON.stringify({input,repo,home,reviewBase,provider:this.config.provider,model:g.model,effort:g.effort,dataDirectory:this.config.dataDirectory}),{mode:0o600,flag:'wx'});
    await this.ledger.tx(async c=>{
     const current=await this.identity(c,principal,authority,input);
     if(this.profileDigest(current)!==this.profileDigest(g))throw new Refusal('NATIVE_EXECUTION_GRANT_MISMATCH');
     await c.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,executor_digest,key_fingerprint,input_digest,base_id,role,account_id,profile_id,profile_digest,eligibility_revision,state,launch_digest)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,'running',$15)`,[input.jobId,input.grantId,input.intentId,authority.contextId,authority.epoch,input.sessionId,this.executorDigest,this.fingerprint,digest(input),input.base,input.role,g.account_id,g.profile_id,this.profileDigest(g),hostLaunchDigest]);
     await c.query("UPDATE ac_capacity_grants SET state='running' WHERE id=$1",[input.grantId]);
     if(input.role==='programmer')await c.query("UPDATE ac_operations SET state='running',native_session_id=$2 WHERE id=$1",[input.jobId,input.sessionId]);
     else await c.query("UPDATE ac_stage_operations SET state='running' WHERE id=$1",[input.jobId]);
    });
   }catch(error){if(!await this.hostRow(input.jobId))await rm(p.root,{recursive:true,force:true});throw error;}
   try{
    signal?.throwIfAborted();
    await exec('systemd-run',['--user','--quiet','--collect','--unit',unit(input.jobId),'--property=Type=exec','--property=KillMode=control-group','--property=TimeoutStopSec=5',
     '--property=RuntimeMaxSec='+Math.ceil(input.timeoutMs/1000+60),'--property=UMask=0077','--property=StandardOutput=null','--property=StandardError=null',
     '--setenv=PATH='+process.env.PATH,'--working-directory='+process.cwd(),'--',process.execPath,'--import',import.meta.resolve('tsx'),worker,join(p.root,'host-job.json')],{timeout:30000});
   }catch{/* A lost start acknowledgement is observed by unit name before settlement. */}
   return {state:'running' as const};
  });
 }

 override async reconcile(principal:string,authority:Authority,raw:z.input<typeof NativeExecutionRequest>):Promise<NativeExecutionOutcome>{
  const input=NativeExecutionRequest.parse(raw);
  const job=await this.hostRow(input.jobId);
  if(!job||['completed','failed'].includes(job.state))return super.reconcile(principal,authority,input);
  await this.validateReplay(principal,authority,input,job);
  await withGrantLaunchLock(this.ledger,input.grantId,async()=>{
   if(await activeUnit(input.jobId))return;
   const row=await this.hostRow(input.jobId);
   if(row.state!=='running')return;
   const p=this.paths(input.jobId);
   const result=await this.readResult(input,1);
   if(await lstat(join(p.root,'stop-requested')).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;})){
    result.exitCode=1;result.failureCode='EXECUTION_NATIVE_STOPPED';result.output='';
    const pending=join(p.output,'result.stopped');
    await writeFile(pending,JSON.stringify(result),{mode:0o600});
    await rename(pending,join(p.output,'execution-result.json'));
   }
   if(result.jobId!==input.jobId)throw new Refusal('NATIVE_EXECUTION_OUTPUT_INVALID');
   const artifact=result.exitCode===0&&input.role==='programmer'?NativeArtifactIdentity.parse(JSON.parse(await readFile(join(p.output,'artifact.json'),'utf8'))):null;
   if(await lstat(p.work).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;})){
    const ctx=(await this.ledger.pool.query('SELECT project_id FROM ac_contexts WHERE id=$1',[authority.contextId])).rows[0];
    await removeSimpleWorktree(await this.jobRepository(this.ledger.pool,ctx.project_id),p.work);
   }
   if(input.role!=='programmer'&&this.config.dataDirectory){
    const ctx=(await this.ledger.pool.query('SELECT project_id FROM ac_contexts WHERE id=$1',[authority.contextId])).rows[0];
    await releaseIdleSharedWorktrees(this.config.dataDirectory,await this.jobRepository(this.ledger.pool,ctx.project_id),true,input.base);
   }
   await rm(join(p.root,'cli-tmp'),{recursive:true,force:true});
   await rm(join(p.root,'host-job.json'),{force:true});
   await writeFile(join(p.root,'worker-terminal.log'),(result.failureCode??'completed')+'\n',{mode:0o600});
   const physical={isolation:'simple',jobId:input.jobId,unit:unit(input.jobId),state:'exited',exitCode:result.exitCode,workerExitCode:result.exitCode,normalizedTokensUsed:result.normalizedTokensUsed,failureCode:result.failureCode};
   const payload={schemaVersion:1,isolation:'simple',jobId:input.jobId,intentId:input.intentId,grantId:input.grantId,contextId:authority.contextId,
    sessionId:input.sessionId,accountId:row.account_id,profileId:row.profile_id,profileDigest:row.profile_digest,epoch:Number(row.manager_epoch),
    inputDigest:row.input_digest,executorDigest:this.executorDigest,outputDigest:digest(result.output),physicalDigest:digest(physical),exitCode:result.exitCode,workerExitCode:result.exitCode,artifact};
   // The quality gate and independent exam session still consume this terminal result.
   const receipt={payload,signature:sign(null,Buffer.from('agent-control:native-execution-receipt:v1\n'+canonical(payload)),this.key).toString('hex')};
   await this.ledger.tx(async c=>{
    const ctx=await this.scope(c,principal,authority,input,true);
    if(!this.config.disabledMeasurementProjects?.includes(ctx.project_id))await new Usage(this.ledger).recordInTransaction(c,principal,authority,{grantId:input.grantId,eventId:input.jobId,seq:1,counters:result.usageCounters??{input:null,output:null,cache:null,reasoning:null}},input.jobId);
    await c.query("UPDATE ac_native_execution_jobs SET state=$2,receipt=$3 WHERE id=$1",[input.jobId,result.exitCode===0?'completed':'failed',receipt]);
    await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1",[input.grantId,physical]);
    if(input.role==='programmer')await c.query("UPDATE ac_operations SET state='completed',receipt=$2 WHERE id=$1",[input.jobId,{operationId:input.jobId,...artifact,exitCode:result.exitCode,synthetic:false,nativeExecution:receipt,failureCode:result.failureCode}]);
   });
  });
  const updated=await this.hostRow(input.jobId);
  return updated.state==='running'?{state:'running'}:super.reconcile(principal,authority,input);
 }

 override async stop(principal:string,authority:Authority,raw:z.input<typeof NativeExecutionRequest>){
  const input=NativeExecutionRequest.parse(raw),row=await this.hostRow(input.jobId);
  if(!row)return super.stop(principal,authority,input);
  await this.validateReplay(principal,authority,input,row);
  await withGrantLaunchLock(this.ledger,input.grantId,async()=>{
   if(await activeUnit(input.jobId)){
    await writeFile(join(this.paths(input.jobId).root,'stop-requested'),'stop\n',{mode:0o600});
    await exec('systemctl',['--user','stop',unit(input.jobId)]);
   }
  });
  await this.reconcile(principal,authority,input);
  return {state:'stop_requested' as const};
 }

 override async recover(principal:string,authority:Authority,id:string){
  if(!await this.hostRow(id))return super.recover(principal,authority,id);
  const status=await this.reconcileRegistered(principal,authority,id);
  if(status.state==='completed'||status.state==='failed')return {state:'acknowledged',interval:'ack_lost',grant:'released',removed:[],replayed:false,receipt:status.receipt} satisfies NativeExecutionRecovery;
  return {state:'uncertain',interval:'before_terminal_evidence',grant:'preserved',removed:[],replayed:false} satisfies NativeExecutionRecovery;
 }

 override async recoverOrphanedExam(principal:string,id:string,scope:{contextId:string;projectId:string;repository:string},apply:boolean){
  const row=await this.hostRow(id);
  if(!row)return super.recoverOrphanedExam(principal,id,scope,apply);
  const context=await this.ledger.tx(c=>this.ledger.authorize(c,principal,scope.contextId));
  if(context.role!=='owner'||context.project_id!==scope.projectId||row.context_id!==scope.contextId||
     await this.jobRepository(this.ledger.pool,scope.projectId)!==await realpath(scope.repository))
   throw new Refusal('NATIVE_EXECUTION_SCOPE_MISMATCH');
  const exam=await this.ledger.pool.query(`SELECT 1 FROM ac_intents i WHERE id=$1 AND command->'payload'->>'workflow'='security-verify-readonly-v1'`,[row.intent_id]);
  if(!exam.rowCount||row.role!=='specialist')throw new Refusal('NATIVE_EXECUTION_NOT_ELIGIBLE');
  if(await activeUnit(id))throw new Refusal('NATIVE_EXECUTION_BUSY');
  if(!apply)return 'eligible' as const;
  const authority=await this.ledger.acquire(principal,scope.contextId,randomUUID(),'personal-host-recovery',60);
  try{
   await this.retireTerminal(principal,authority,id);
   return 'recovered' as const;
  }finally{await this.ledger.releaseLease(authority);}
 }

 override async retireTerminal(principal:string,authority:Authority,id:string){
  if(!await this.hostRow(id))return super.retireTerminal(principal,authority,id);
  const outcome=await this.reconcileRegistered(principal,authority,id);
  if(outcome.state!=='completed'&&outcome.state!=='failed')throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
  const proof={isolation:'simple',jobId:id,unit:unit(id),state:'exited',terminalDigest:digest(outcome.receipt)};
  await this.ledger.pool.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state,proof) VALUES($1,$2,'removed',$2) ON CONFLICT(job_id) DO NOTHING",[id,proof]);
  return {state:'removed' as const};
 }
 override async retireManagedWriter(principal:string,authority:Authority,id:string){
  const row=await this.hostRow(id);
  if(!row)return super.retireManagedWriter(principal,authority,id);
  await this.retireTerminal(principal,authority,id);
  const proof={isolation:'simple',jobId:id,state:'exited',unit:unit(id)};
  await this.ledger.tx(async c=>{
   await this.ledger.fence(c,authority,true);
   const updated=await c.query(`UPDATE ac_worktree_writers w SET state='neutralized',proof_digest=$2,revocation_job_id=$1,revocation_proof=$3
    FROM ac_intents i WHERE i.id=$4 AND i.context_id=$5 AND w.parent_intent_id=i.parent_intent_id AND w.run_id=i.run_id AND w.holder_intent_id=i.id AND w.state='held' AND w.manager_epoch=$6`,[id,digest(proof),proof,row.intent_id,authority.contextId,row.manager_epoch]);
   if(!updated.rowCount&&!(await c.query("SELECT 1 FROM ac_worktree_writers WHERE revocation_job_id=$1 AND proof_digest=$2 AND state='neutralized'",[id,digest(proof)])).rowCount)
    throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
  });
  return {state:'neutralized' as const};
 }
}
