import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {digest} from '../src/contracts.ts';
import {ManagerPlans,type ManagerPlan} from '../src/planning.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const quality={schemaVersion:1 as const,requiredReviews:1,allowLowRiskQaWaiver:false,requireJudge:false,requireHumanIntegration:false,verifierDigest:'a'.repeat(64)};

test('local compositor capacity remains fenced and bounded without model quota',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const database=await isolatedDatabase(base,'localcomp'),db=new Ledger(database.url),capacity=new Capacity(db);
 try{
  await db.migrate();const project=randomUUID(),principal='synthetic-local-'+randomUUID(),account=randomUUID(),profile=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'synthetic capacity']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await capacity.configure(principal,{programmingLimit:1,evaluationLimit:1});
  await capacity.registerModel(principal,{provider:'synthetic',model:'fixture',efforts:['medium'],roles:['programmer'],source:'synthetic://fixture'});
  await capacity.addAccount(principal,project,{id:account,provider:'synthetic',label:'fixture',resourceIdentity:randomUUID(),mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://fixture',maxConcurrent:2});
  await capacity.addProfile(principal,project,{id:profile,accountId:account,model:'fixture',effort:'medium',role:'programmer'});
  await capacity.observeQuota(principal,account,{status:'exhausted',source:'synthetic://fixture',ttlSeconds:300});
  const revision=await capacity.publish(principal,project,0,{schemaVersion:1,maxProgrammersPerContext:1,maxEvaluatorsPerContext:1,roles:{programmer:{regular:[profile],emergency:[]}}});
  await db.pool.query('INSERT INTO ac_quality_policies VALUES($1,1,$2,$3)',[project,quality,digest(quality)]);
  const contextA=await db.createContext(principal,project,randomUUID()),contextB=await db.createContext(principal,project,randomUUID());
  const authA=await db.acquire(principal,contextA,randomUUID(),'fixture-manager',60),authB=await db.acquire(principal,contextB,randomUUID(),'fixture-manager',60);
  await capacity.assignPolicy(principal,contextA,revision);await capacity.assignPolicy(principal,contextB,revision);
  const publish=async(contextId:string,authority:typeof authA)=>{
   const task=(id:string)=>({id,objectiveRef:`message:${id}`,acceptanceRefs:['acceptance:synthetic-effect-v1'],inputRefs:[],outputRefs:[`output:${id}`],dependsOn:[],writePaths:[`src/${id}.txt`],qualityRevision:1,targetRef:'refs/heads/main',maxCorrections:0});
   const plan:ManagerPlan={schemaVersion:1,contextId,objectiveRef:'message:goal',sourceMessageRef:'message:request',constraintRefs:[],tasks:[task('one'),task('two')]};
   return new ManagerPlans(db).publish(principal,authority,0,plan);
  };
  const proposalA=await publish(contextA,authA),proposalB=await publish(contextB,authB);
  const create=async(contextId:string,authority:typeof authA,proposal:typeof proposalA)=>{
   const parent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,action:'plan.start',
    payload:{workflow:'managed-synthetic-v1',messageRef:'message:request',proposalRevision:proposal.revision,proposalDigest:proposal.digest}},authority,'api');
   const rows=(await db.pool.query(`SELECT i.id,i.parent_unit_id,o.execution_attempt_id FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id
    WHERE i.parent_intent_id=$1`,[parent.id])).rows;
   const local=rows.find(r=>r.parent_unit_id==='compose-0'),task=rows.find(r=>r.parent_unit_id==='task-one');assert(local&&task);
   return {local:{attemptId:local.execution_attempt_id,intentId:local.id,contextId},task:{attemptId:task.execution_attempt_id,intentId:task.id,contextId}};
  };
  const a=await create(contextA,authA,proposalA),anotherA=await create(contextA,authA,proposalA),b=await create(contextB,authB,proposalB);
  await assert.rejects(capacity.reserve(principal,{...a.task,role:'programmer'},authA),/NO_ELIGIBLE_CAPACITY/);
  const grant=await capacity.reserveLocalCompositor(principal,a.local,authA);
  assert.equal(grant.resource_kind,'local_compositor');assert.equal(grant.account_id,null);assert.equal(grant.profile_id,null);
  assert.equal((await capacity.reserveLocalCompositor(principal,a.local,authA)).id,grant.id);
  await assert.rejects(capacity.reserve(principal,{...a.local,role:'programmer'},authA),/ATTEMPT_PAYLOAD_CONFLICT/);
  await assert.rejects(capacity.reserveLocalCompositor(principal,a.task,authA),/LOCAL_COMPOSITOR_BINDING_INVALID/);
  await capacity.transition(principal,grant.id,authA,'uncertain');
  await assert.rejects(capacity.reserveLocalCompositor(principal,b.local,authB),/CAPACITY_BUSY/);
  await capacity.cancelWait(principal,b.local.attemptId,authB);
  await capacity.configure(principal,{programmingLimit:2,evaluationLimit:1});
  await assert.rejects(capacity.reserveLocalCompositor(principal,anotherA.local,authA),/CAPACITY_BUSY/);
  // A is the oldest waiter but its context is full; B must use the other
  // global slot rather than waiting behind an ineligible queue head.
  const next=await capacity.reserveLocalCompositor(principal,b.local,authB);assert.equal(next.resource_kind,'local_compositor');
  assert.equal((await db.pool.query('SELECT reason FROM ac_capacity_waits WHERE attempt_id=$1',[anotherA.local.attemptId])).rows[0].reason,'CAPACITY_BUSY');
  await assert.rejects(db.pool.query("UPDATE ac_capacity_grants SET resource_kind='model' WHERE id=$1",[grant.id]),/CAPACITY_RESOURCE_KIND_IMMUTABLE/);
  await assert.rejects(db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state,resource_kind)
   SELECT $1,$2,$3,context_id,manager_epoch,NULL,NULL,role,project_id,policy_revision,config_revision,'forged',false,'reserved','local_compositor'
   FROM ac_capacity_grants WHERE id=$4`,[randomUUID(),a.task.attemptId,a.task.intentId,grant.id]),/LOCAL_COMPOSITOR_BINDING_INVALID/);
  await capacity.transition(principal,grant.id,authA,'released',{processId:'synthetic-physical-exit',state:'exited'});
  const resumed=await capacity.reserveLocalCompositor(principal,anotherA.local,authA);assert.equal(resumed.resource_kind,'local_compositor');
 }finally{await db.close();await database.close();}
});
