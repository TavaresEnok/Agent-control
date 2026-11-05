import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {remoteDevelopmentLab,labGit} from './fixtures/r3-delivery-lab.ts';
import {remoteQualityReviewer} from './fixtures/r3-remote-quality.ts';
import {installGraphAllocator} from './fixtures/r2-graph-allocator.ts';
import {NativeQa} from '../src/native-qa.ts';
import {Control} from '../src/control.ts';
import {Integrator} from '../src/integration.ts';
import {ProjectAdmin} from '../src/project-admin.ts';
import {type RemoteTransport} from '../src/remote.ts';
import {DockerDaemon} from '../src/sandbox-broker.ts';

test('R3 real SSH artifact passes physical QA/review/judge then signed integration and exact remote CAS return',{timeout:180000},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');const lab=await remoteDevelopmentLab(base,{requireJudge:true});console.log('R3_REMOTE_QUALITY_LAB_READY');
 let review:Awaited<ReturnType<typeof remoteQualityReviewer>>|undefined,heartbeatError:unknown,beating=false;
 const heartbeat=setInterval(()=>{if(beating)return;beating=true;void lab.db.heartbeat(lab.authority).catch(error=>{heartbeatError=error;}).finally(()=>{beating=false;});},4000);
 const docker=new DockerDaemon(),qaJobs:string[]=[];let primary:unknown;
 try{
  installGraphAllocator();
  const workspaceId=randomUUID();await lab.development.prepare(lab.principal,{workspaceId,contextId:lab.contextId,intentId:lab.intent.id,hostId:lab.hostId,sourceOperationId:lab.sourceOperationId},lab.authority);
  console.log('R3_REMOTE_QUALITY_WORKSPACE_PREPARED');await lab.development.launchImplementation(lab.principal,{workspaceId,taskId:'implement',sessionId:randomUUID()},lab.authority);
  let terminal:any;for(let attempt=0;attempt<150;attempt++){terminal=await lab.remote.reconcile(lab.principal,lab.intent.operation_id,lab.authority);if(['completed','failed'].includes(terminal?.state))break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(terminal?.state,'completed');assert.equal(terminal.groupRemovalConfirmed,true);
  console.log('R3_REMOTE_QUALITY_REMOTE_COMPLETED');const artifact=await lab.development.registerArtifact(lab.principal,{workspaceId,artifactId:randomUUID()},lab.authority,lab.quality,lab.scratch);
  assert.equal(artifact.base_id,lab.source);assert.notEqual(artifact.commit_id,lab.source);assert.equal(labGit(lab.local,'show',artifact.commit_id+':src/example.ts'),'export const value = 2;');
  assert.equal((await lab.db.pool.query('SELECT count(*) n FROM ac_verification_evidence')).rows[0].n,'0');assert.equal((await lab.db.pool.query('SELECT count(*) n FROM ac_integration_approvals')).rows[0].n,'0');
  await assert.rejects(lab.db.tx(c=>lab.quality.assertReady(c,artifact.id,lab.authority)),/VERIFICATION_NOT_PASSED|QA_MISSING/);
  const target='refs/heads/agent-control-export';
  let sshCalls=0,loseAck=true;
  const returnTransport:RemoteTransport={async exchange(host,request){sshCalls++;const result=await lab.ssh.exchange(host,request);if(loseAck){loseAck=false;throw Error('R3_APPROVED_RETURN_ACK_LOST_AFTER_CAS');}return result;}};
  const admin=new ProjectAdmin(lab.db,[{id:'fixture',label:'Disposable root',path:lab.root}],join(lab.root,'private'),{remoteSourceTmpfs:lab.scratch,remoteReturnTransport:returnTransport});
  const returning={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.returnRemoteArtifact',payload:{projectId:lab.projectId,contextId:lab.contextId,hostId:lab.hostId,artifactId:artifact.id,destinationRef:target}};
  await assert.rejects(admin.execute(lab.principal,returning,lab.proof(returning)),/REMOTE_RETURN_APPROVED_ARTIFACT_REQUIRED/);assert.equal(sshCalls,0);
  review=await remoteQualityReviewer(lab);
  const prior=(await lab.db.pool.query('SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 AND revision=1',[lab.projectId])).rows[0].snapshot;
  const revision=await review.capacity.publish(lab.principal,lab.projectId,1,{...prior,roles:{...prior.roles,reviewer:{regular:[review.reviewer],emergency:[]},judge:{regular:[review.judge],emergency:[]}}});await review.capacity.assignPolicy(lab.principal,lab.contextId,revision);
  const stage=async(kind:'qa'|'review'|'judge')=>{
   await lab.db.heartbeat(lab.authority);const id=randomUUID(),session_id=randomUUID(),attemptId=randomUUID();
   // Scheduler input only: every outcome/evidence below is written by the actual executor.
   await lab.db.tx(async c=>{await lab.db.authorize(c,lab.principal,lab.contextId);await lab.db.fence(c,lab.authority);await c.query("INSERT INTO ac_stage_operations(id,intent_id,node_id,session_id,attempt_id,manager_epoch,state) VALUES($1,$2,$3,$4,$5,$6,'registered')",[id,lab.intent.id,kind,session_id,attemptId,lab.authority.epoch]);});
   const grant=await review!.capacity.reserve(lab.principal,{attemptId,intentId:lab.intent.id,contextId:lab.contextId,role:kind==='review'?'reviewer':kind},lab.authority);
   return {stage:{id,session_id},grant};
  };
  const qaRoot=join(lab.root,'qa');await mkdir(qaRoot,{mode:0o700});const qa=new NativeQa(lab.db,lab.quality,lab.local,qaRoot,lab.qaContract,lab.verifierKey);
  const qaInput=await stage('qa');qaJobs.push(qaInput.stage.id);const qaReceipt=await qa.run(lab.principal,lab.intent,lab.authority,qaInput.stage,qaInput.grant.id,artifact,()=>false);assert.equal(qaReceipt.status,'passed');assert.equal(qaReceipt.exitCode,0);
  assert.match(await readFile(join(qaRoot,qaInput.stage.id,'qa-logs.bin'),'utf8'),/independent functional value=2/);assert.equal(await docker.inspect('ac-native-qa-'+qaInput.stage.id),null);
  await assert.rejects(lab.db.tx(c=>lab.quality.assertReady(c,artifact.id,lab.authority)),/REVIEWS_MISSING/);
  const reviewInput=await stage('review'),reviewReceipt=await review.verification.run(lab.principal,lab.intent,lab.authority,reviewInput.stage,reviewInput.grant.id,artifact,'review',()=>false);assert.equal(reviewReceipt.status,'passed');
  const judgeInput=await stage('judge'),judgeReceipt=await review.verification.run(lab.principal,lab.intent,lab.authority,judgeInput.stage,judgeInput.grant.id,artifact,'judge',()=>false);assert.equal(judgeReceipt.status,'passed');
  assert.equal((await lab.db.pool.query('SELECT snapshot FROM ac_quality_policies WHERE project_id=$1 AND revision=$2',[lab.projectId,artifact.policy_revision])).rows[0].snapshot.requireJudge,true);
  const evidence=(await lab.db.pool.query('SELECT id,kind,status,receipt FROM ac_verification_evidence WHERE artifact_id=$1 ORDER BY kind',[artifact.id])).rows;
  assert.deepEqual(evidence.map(row=>[row.kind,row.status]),[['judge','passed'],['qa','passed'],['review','passed']]);assert.equal(new Set([qaReceipt.grantId,reviewReceipt.grantId,judgeReceipt.grantId,artifact.implementation_grant_id]).size,4);
  for(const job of (await lab.db.pool.query('SELECT id,worker_id,tools_id FROM ac_native_execution_jobs WHERE context_id=$1',[lab.contextId])).rows){assert.equal(await docker.inspect(job.worker_id),null);assert.equal(await docker.inspect(job.tools_id),null);assert.match(await readFile(join(review.spool,job.id,'worker-terminal.log'),'utf8'),/deterministic-independent-review/);}
  await lab.db.tx(c=>lab.quality.assertReady(c,artifact.id,lab.authority));
  await assert.rejects(lab.quality.prepareIntegration(lab.principal,artifact.id,lab.authority,target),/INTEGRATION_APPROVAL_REQUIRED/);
  const approval={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:lab.contextId,action:'integration.approve' as const,payload:{artifactId:artifact.id,artifactDigest:artifact.identity_digest,policyRevision:artifact.policy_revision,targetRef:target}};
  await assert.rejects(new Control(lab.db).execute(lab.principal,approval,{...lab.proof(approval),signature:'0'.repeat(128)}),/OPERATOR_SIGNATURE_INVALID/);
  await new Control(lab.db).execute(lab.principal,approval,lab.proof(approval));assert.equal((await lab.db.pool.query('SELECT count(*) n FROM ac_integration_approvals')).rows[0].n,'1');
  const integration=await lab.quality.prepareIntegration(lab.principal,artifact.id,lab.authority,target),integrator=new Integrator(lab.db,lab.quality,lab.git,lab.projectId,target),integrated=await integrator.integrate(lab.principal,integration.id,lab.authority);
  assert.equal(integrated.status,'integrated');assert.equal(integrated.commit,artifact.commit_id);assert.equal(integrated.tree,artifact.tree_id);assert.equal(labGit(lab.local,'rev-parse',target),artifact.commit_id);assert.equal(labGit(lab.bare,'rev-parse',target),lab.source);
  await assert.rejects(admin.execute(lab.principal,returning,lab.proof(returning)),/R3_APPROVED_RETURN_ACK_LOST_AFTER_CAS/);assert.equal(sshCalls,1);assert.equal(labGit(lab.bare,'rev-parse',target),artifact.commit_id);
  assert.equal((await lab.db.pool.query('SELECT count(*) n FROM ac_remote_artifact_returns')).rows[0].n,'0');
  const replay={...returning,deliveryAttemptId:randomUUID()},returned=await admin.execute(lab.principal,replay,lab.proof(replay));assert.equal(returned.commit,artifact.commit_id);assert.equal(returned.tree,artifact.tree_id);assert.equal(sshCalls,2);
  const savedReplay={...returning,deliveryAttemptId:randomUUID()};assert.deepEqual(await admin.execute(lab.principal,savedReplay,lab.proof(savedReplay)),returned);assert.equal(sshCalls,2);
  assert.equal((await lab.db.pool.query('SELECT count(*) n FROM ac_remote_artifact_returns')).rows[0].n,'1');assert.equal(labGit(lab.bare,'rev-parse',target+'^{tree}'),artifact.tree_id);assert.equal(labGit(lab.bare,'show',target+':src/example.ts'),'export const value = 2;');assert.equal(labGit(lab.bare,'ls-tree','-r','--name-only',target).includes('private-untracked-secret'),false);
  assert.equal((await lab.db.pool.query("SELECT count(*) n FROM ac_capacity_grants WHERE state<>'released'")).rows[0].n,'0');assert.equal(heartbeatError,undefined);
  console.log(JSON.stringify({proof:'remote-source-to-real-quality-and-return',source:lab.source,commit:artifact.commit_id,tree:artifact.tree_id,implementation:'actual SSH+Docker fixed executable',qa:'NativeQa actual Node assertion',review:'NativeVerification physical deterministic inference',tools:'actual native-tools-worker/public Codex exec-server read-only FS',signedHumanApproval:true,integrator:'real Quality+Git CAS',returnSshCalls:sshCalls,lostReturnAckRecovered:true,evidence:evidence.map(row=>({kind:row.kind,status:row.status})),seededApprovedGate:false,providerInference:false}));
 }catch(error){primary=error;throw error;}
 finally{
  clearInterval(heartbeat);while(beating)await new Promise(resolve=>setTimeout(resolve,10));const errors:unknown[]=[];
  if(review)try{await review.close();}catch(error){errors.push(error);}
  for(const id of qaJobs)try{const container=await docker.inspect('ac-native-qa-'+id);if(container){if(container.Config.Labels['agent-control.job']!==id)throw Error('QA_CLEANUP_IDENTITY');if(container.State.Running)await docker.stop(container.Id);await docker.remove(container.Id);}}catch(error){errors.push(error);}
  mock.restoreAll();try{await lab.close();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(primary?[primary,...errors]:errors,'REMOTE_QUALITY_CLEANUP_FAILED');
 }
});
