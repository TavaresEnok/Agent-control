import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {Quality} from '../src/quality.ts';
import {Capacity} from '../src/capacity.ts';
import {GitArtifacts} from '../src/git.ts';
import {NativeQa,NativeQaContract,nativeQaContractDigest} from '../src/native-qa.ts';
import {DockerDaemon} from '../src/sandbox-broker.ts';
import {nativeReviewVerifierDigest} from '../src/native-verification.ts';
import {digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('real isolated QA uses Docker exit code, preserves the commit and rejects forged stdout approval',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_QA_CONTROLLER_REQUIRED');
 const root=await mkdtemp('/tmp/r2-qa-retirement-');
 const imageInfo=JSON.parse(execFileSync('docker',['image','inspect','node:22-alpine'],{encoding:'utf8'}))[0];
 const image={id:imageInfo.Id as string,environment:imageInfo.Config.Env as string[]};
 const contract=NativeQaContract.parse({schemaVersion:1,id:'node-functional-value',image:image.id,argv:['/usr/local/bin/node','--experimental-strip-types','--input-type=module','-e',"import assert from 'node:assert/strict'; const {value}=await import('/work/src/example.ts'); console.log(JSON.stringify({status:'passed',untrusted:true})); assert.equal(value,2);"],environment:[...image.environment,'HOME=/tmp','CI=1'],timeoutMs:15000,memoryBytes:268435456,pids:64,nanoCpus:1000000000});
 const fixture=await isolatedDatabase(base,'qaphysical'),db=new Ledger(fixture.url),area=await mkdtemp(join(root,'fixture-')),docker=new DockerDaemon();
 try{
  await db.migrate();const project=randomUUID(),principal='qa-'+randomUUID(),account=randomUUID(),programmer=randomUUID(),qaProfile=randomUUID(),repo=join(area,'repo'),spool=join(area,'qa');await mkdir(spool,{mode:0o700});
  execFileSync('git',['init',repo],{stdio:'ignore'});const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();git('config','user.name','Fixture');git('config','user.email','fixture@invalid');await mkdir(join(repo,'src'));await writeFile(join(repo,'src/example.ts'),'export const value = 1;\n');git('add','.');git('commit','-m','base');const sourceBase=git('rev-parse','HEAD');git('update-ref','refs/heads/protected',sourceBase);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'physical QA fixture']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
  await new Capacity(db).addAccount(principal,project,{id:account,provider:'synthetic',label:'fixture metadata',resourceIdentity:'fixture:'+randomUUID(),mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://fixture',maxConcurrent:4});
  for(const [id,role] of [[programmer,'programmer'],[qaProfile,'qa']])await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role) VALUES($1,$2,'fixture','medium',$3)",[id,account,role]);
  const context=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'a'.repeat(64),principal]);
  const key=randomBytes(32),gates=new Quality(db,key,new GitArtifacts(repo));
  await gates.publish(principal,project,0,{schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:true,verifierDigest:nativeReviewVerifierDigest,qaVerifierDigest:nativeQaContractDigest(contract)});
  const runner=new NativeQa(db,gates,repo,spool,contract,key);const results=[];
  for(const value of [2,3]){
   const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
   await writeFile(join(repo,'src/example.ts'),`export const value = ${value};\n`);git('add','.');git('commit','-m','fixture '+value);const commit=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}');
   const implementation=randomUUID(),writer=randomUUID(),qaGrant=randomUUID(),qaAttempt=randomUUID(),stageId=randomUUID(),session=randomUUID();
   for(const [id,attempt,profile,role,state,receipt] of [[implementation,randomUUID(),programmer,'programmer','released',{fixture:true}],[qaGrant,qaAttempt,qaProfile,'qa','reserved',null]])await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state,physical_receipt)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,1,$10,false,$11,$12)`,[id,attempt,intent.id,context,authority.epoch,account,profile,role,project,digest({fixture:id}),state,receipt]);
   await db.pool.query("UPDATE ac_operations SET state='completed',grant_id=$2,native_session_id=$3,receipt=$4 WHERE id=$1",[intent.operation_id,implementation,writer,{commit,tree,base:sourceBase,exitCode:0,synthetic:true}]);
   const artifact=await gates.register(principal,{id:randomUUID(),contextId:context,intentId:intent.id,implementationGrantId:implementation,implementationSessionId:writer,policyRevision:1,commit,tree,base:sourceBase,risk:'high'},authority);
   await db.pool.query("INSERT INTO ac_stage_operations(id,intent_id,node_id,session_id,attempt_id,manager_epoch,state) VALUES($1,$2,'qa',$3,$4,$5,'registered')",[stageId,intent.id,session,qaAttempt,authority.epoch]);
   let result;
   if(value===2){
    const daemon=(runner as any).docker as DockerDaemon,remove=daemon.remove.bind(daemon);
    daemon.remove=async()=>{throw Error('simulated delete failure');};
    await assert.rejects(runner.run(principal,intent,authority,{id:stageId,session_id:session},qaGrant,artifact,()=>false),/simulated delete failure/);
    const path=join(spool,stageId,'qa-logs.bin'),logs=await readFile(path);await writeFile(path,Buffer.from('tampered'));
    await assert.rejects(runner.retire(principal,authority,stageId),/NATIVE_QA_RETIREMENT_UNCONFIRMED/);
    const job=(await db.pool.query('SELECT container_id FROM ac_native_qa_jobs WHERE id=$1',[stageId])).rows[0];assert.ok(await docker.inspect(job.container_id));
    await writeFile(path,logs);
    daemon.remove=async id=>{await remove(id);throw Error('simulated lost acknowledgement');};
    await assert.rejects(runner.retire(principal,authority,stageId),/simulated lost acknowledgement/);
    daemon.remove=remove;
    result=await runner.record(principal,authority,stageId);
   }else result=await runner.run(principal,intent,authority,{id:stageId,session_id:session},qaGrant,artifact,()=>false);
   results.push(result.status);
   assert.equal(result.status,value===2?'passed':'failed');assert.equal(result.exitCode,value===2?0:1);
   if(value===3)assert.equal((await db.tx(c=>gates.assertCorrectionFailures(c,artifact.id,[result.id],authority))).id,artifact.id);
   assert.equal((await runner.record(principal,authority,stageId)).id,result.id);
   const job=(await db.pool.query('SELECT receipt,container_id FROM ac_native_qa_jobs WHERE id=$1',[stageId])).rows[0];assert.equal(job.receipt.modelInference,false);assert.equal(job.receipt.synthetic,false);
   const physical=await docker.inspect(job.container_id);assert.equal(physical,null);assert.equal(await docker.inspect('ac-native-qa-'+stageId),null);
   assert.ok((await readFile(join(spool,stageId,'qa-logs.bin'))).length>0);
   const retirement=(await db.pool.query('SELECT * FROM ac_native_qa_retirements WHERE job_id=$1',[stageId])).rows[0];assert.equal(retirement.state,'removed');assert.equal(retirement.identity.containerId,job.container_id);
   if(value===3){
    const ids:string[]=[];
    for(let i=0;i<40;i++){
     const jobId=randomUUID(),sessionId=randomUUID(),attempt=randomUUID(),grant=randomUUID();ids.push(jobId);
     await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,'qa',$8,1,1,$9,false,'uncertain')`,[grant,attempt,intent.id,context,authority.epoch,account,qaProfile,project,digest({grant})]);
     await db.pool.query("INSERT INTO ac_stage_operations(id,intent_id,node_id,session_id,attempt_id,manager_epoch,state,grant_id) VALUES($1,$2,'qa',$3,$4,$5,'uncertain',$6)",[jobId,intent.id,sessionId,attempt,authority.epoch,grant]);
     await db.pool.query(`INSERT INTO ac_native_qa_jobs(id,context_id,intent_id,artifact_id,grant_id,session_id,manager_epoch,request_digest,contract_digest,state,deadline_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'uncertain',clock_timestamp()+interval '1 hour','2024-01-01 00:00:00.123456+00')`,[jobId,context,intent.id,artifact.id,grant,sessionId,authority.epoch,digest({jobId}),runner.verifierDigest]);
    }
    const seen:string[]=[],original=runner.reconcile.bind(runner);
    runner.reconcile=async(_principal,_authority,id)=>{seen.push(id);if(seen.length===1)throw Error('fixture failure');return {state:'uncertain'};};
    await runner.reconcileContext(principal,authority);runner.reconcile=original;
    assert.equal(seen.length,40);assert.deepEqual(new Set(seen),new Set(ids));
   }
   assert.equal(git('rev-parse','refs/heads/protected'),sourceBase);await assert.rejects(db.tx(c=>gates.assertReady(c,artifact.id,authority)),value===2?/REVIEWS_MISSING/:/VERIFICATION_NOT_PASSED/);
  }
  assert.deepEqual(results,['passed','failed']);console.log(JSON.stringify({proof:'native-qa-real-docker',functionalCommands:2,outcomes:results,untrustedStdoutIgnored:true,network:'none',credentialsMounted:false,modelCalls:0,protectedBranchUnchanged:true}));
 }finally{
  const exists=(await db.pool.query("SELECT to_regclass('ac_native_qa_jobs') relation")).rows[0].relation;
  if(exists)for(const j of (await db.pool.query('SELECT id FROM ac_native_qa_jobs')).rows){const p=await docker.inspect('ac-native-qa-'+j.id);if(p&&p.Config.Labels['agent-control.job']===j.id){if(p.State.Running)await docker.stop(p.Id);await docker.remove(p.Id);}}
  await db.close();await fixture.close();await rm(area,{recursive:true,force:true});await rm(root,{recursive:true,force:true});
 }
});
