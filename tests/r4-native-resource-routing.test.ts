import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {NativeResourceDockerDaemon,reconcileNativeResourceAdmissions} from '../src/native-resource-envelope.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('shared native resource root dispatches only owned pending jobs and drops released terminal history',{timeout:90000},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;assert(base);const isolated=await isolatedDatabase(base,'r4_resroute'),ledger=new Ledger(isolated.url),capacity=new Capacity(ledger);
 try{
  await ledger.migrate();const project=randomUUID(),principal='resource-routing',account=randomUUID(),profile=randomUUID();
  await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'routing fixture']);await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await capacity.configure(principal,{programmingLimit:4,evaluationLimit:2});await capacity.registerModel(principal,{provider:'routing-fixture',model:'worker',efforts:['medium'],roles:['programmer'],source:'synthetic://routing'});
  await capacity.addAccount(principal,project,{id:account,provider:'routing-fixture',label:'routing',resourceIdentity:account,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://routing',maxConcurrent:4});
  await capacity.addProfile(principal,project,{id:profile,accountId:account,model:'worker',effort:'medium',role:'programmer'});await capacity.observeQuota(principal,account,{status:'available',source:'synthetic://routing',ttlSeconds:3600});
  const revision=await capacity.publish(principal,project,0,{schemaVersion:1,maxProgrammersPerContext:4,maxEvaluatorsPerContext:2,roles:{programmer:{regular:[profile],emergency:[]}}});
  const context=await ledger.createContext(principal,project,randomUUID());await capacity.assignPolicy(principal,context,revision);const authority=await ledger.acquire(principal,context,randomUUID(),'routing',60);
  // This is a PostgreSQL ownership/routing proof. No host action is permitted.
  const docker=new NativeResourceDockerDaemon({stateRoot:'/tmp/r4-routing-shared',installationId:'routing-fixture',authorityEpoch:1,resourceAuthority:{authorityId:'ac-r3-resources-routing',anchorId:'a'.repeat(64),cpuQuotaMicros:50000,cpuPeriodMicros:100000,memoryBytes:16777216,pidsLimit:16,maxJobs:4}});
  docker.callResource=async()=>assert.fail('ROUTING_TEST_MUST_NOT_CALL_HOST');
  const jobs:string[]=[];
  for(let i=0;i<2;i++){
   const intent=await ledger.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:routing'}},authority,'api');
   const grant=await capacity.reserve(principal,{attemptId:randomUUID(),contextId:context,intentId:intent.id,role:'programmer'},authority),id=randomUUID();jobs.push(id);
   await ledger.pool.query(`INSERT INTO ac_native_resource_admissions(job_id,grant_id,context_id,manager_epoch,authority_id,names,state_root,admission_id,state,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'admitted','admitted')`,[id,grant.id,context,authority.epoch,docker.authorityId,JSON.stringify(['ac-native-worker-'+id,'ac-native-tools-'+id]),docker.stateRoot,randomUUID()]);
   await ledger.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,executor_digest,key_fingerprint,input_digest,base_id,role,account_id,profile_id,profile_digest,eligibility_revision,state) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$7,$8,'programmer',$9,$10,$7,1,$11)`,[id,grant.id,intent.id,context,authority.epoch,randomUUID(),'a'.repeat(64),'a'.repeat(40),account,profile,i?'completed':'uncertain']);
   await ledger.pool.query("UPDATE ac_capacity_grants SET state=$2 WHERE id=$1",[grant.id,i?'released':'uncertain']);await ledger.pool.query("UPDATE ac_intents SET state='failed' WHERE id=$1",[intent.id]);
  }
  for(const recoverSource of ['ac_native_planning_jobs','ac_native_qa_jobs'] as const)await reconcileNativeResourceAdmissions({docker,ledger,principal,authority,recoverSource,recoverJob:async()=>assert.fail('FOREIGN_JOB_DISPATCHED')});
  const called:string[]=[];await reconcileNativeResourceAdmissions({docker,ledger,principal,authority,recoverSource:'ac_native_execution_jobs',recoverJob:async id=>{called.push(id);}});
  assert.deepEqual(called,[jobs[0]]);
  const active=(await ledger.pool.query(`SELECT e.row_id FROM ac_reconciliation_visits v JOIN ac_reconciliation_entries e ON e.seq=v.seq WHERE v.context_id=$1 AND v.lane=$2 AND v.active`,[context,'native-resource:'+docker.authorityId+':'+docker.stateRoot+':ac_native_execution_jobs'])).rows.map(row=>row.row_id);
  assert.deepEqual(active,[jobs[0]],'terminal released admission must leave the active revisit set');
 }finally{await ledger.close();await isolated.close();}
});
