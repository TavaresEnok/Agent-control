import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {ManagerPlans,type ManagerPlan} from '../src/planning.ts';
import {PortableExport} from '../src/portable-export.ts';
import {digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('portable metadata export is owner-scoped, bounded and excludes sensitive content',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const database=await isolatedDatabase(base,'portable'),db=new Ledger(database.url),capacity=new Capacity(db);
 try{
  await db.migrate();const project=randomUUID(),principal='owner-'+randomUUID(),account=randomUUID(),profile=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner'),($1,$3,'viewer')",[project,principal,'fixture-viewer']);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await capacity.configure(principal,{programmingLimit:1,evaluationLimit:1});
  await capacity.registerModel(principal,{provider:'fixture',model:'fixture',efforts:['medium'],roles:['programmer'],source:'synthetic://fixture'});
  await capacity.addAccount(principal,project,{id:account,provider:'fixture',label:'fixture',resourceIdentity:randomUUID(),mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://fixture',maxConcurrent:1});
  await capacity.addProfile(principal,project,{id:profile,accountId:account,model:'fixture',effort:'medium',role:'programmer'});
  await capacity.observeQuota(principal,account,{status:'available',source:'synthetic://fixture',ttlSeconds:60});
  const revision=await capacity.publish(principal,project,0,{schemaVersion:1,maxProgrammersPerContext:1,maxEvaluatorsPerContext:1,roles:{programmer:{regular:[profile],emergency:[]}}});
  const contextId=await db.createContext(principal,project,randomUUID()),other=await db.createContext(principal,project,randomUUID());
  const authority=await db.acquire(principal,contextId,randomUUID(),'fixture-manager',60);await capacity.assignPolicy(principal,contextId,revision);
  const quality={schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireJudge:false,requireHumanIntegration:false,verifierDigest:'a'.repeat(64)};
  await db.pool.query('INSERT INTO ac_quality_policies VALUES($1,1,$2,$3)',[project,quality,digest(quality)]);
  const plan:ManagerPlan={schemaVersion:1,contextId,objectiveRef:'message:DO_NOT_EXPORT_TRANSCRIPT',sourceMessageRef:'message:DO_NOT_EXPORT_SOURCE',constraintRefs:[],tasks:[{
   id:'one',objectiveRef:'message:DO_NOT_EXPORT_OBJECTIVE',acceptanceRefs:['acceptance:synthetic-effect-v1'],inputRefs:[],outputRefs:['output:one'],dependsOn:[],
   writePaths:['DO_NOT_EXPORT_PATH/file.txt'],qualityRevision:1,targetRef:'refs/heads/DO_NOT_EXPORT_BRANCH',maxCorrections:0}]};
  await new ManagerPlans(db).publish(principal,authority,0,plan);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,
   action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:DO_NOT_EXPORT_TEXT'}},authority,'api');
  const grant=await capacity.reserve(principal,{attemptId:randomUUID(),intentId:intent.id,contextId,role:'programmer'},authority);
  const artifact=randomUUID(),commit='a'.repeat(40),tree='b'.repeat(40),baseCommit='c'.repeat(40),artifactDigest=digest({commit,tree,base:baseCommit});
  await db.pool.query(`INSERT INTO ac_artifacts VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,'high')`,[artifact,contextId,intent.id,grant.id,randomUUID(),project,commit,tree,baseCommit,artifactDigest]);
  await db.pool.query(`INSERT INTO ac_verification_evidence(id,artifact_id,kind,session_id,grant_id,policy_revision,status,receipt,receipt_digest)
   VALUES($1,$2,'qa',$3,$4,1,'passed',$5,$6)`,[randomUUID(),artifact,randomUUID(),grant.id,{message:'DO_NOT_EXPORT_RECEIPT'},digest({message:'DO_NOT_EXPORT_RECEIPT'})]);
  await db.pool.query(`INSERT INTO ac_integration_intents(id,artifact_id,context_id,manager_epoch,target_ref,state,receipt)
   VALUES($1,$2,$3,$4,'refs/heads/DO_NOT_EXPORT_BRANCH','integrated',$5)`,[randomUUID(),artifact,contextId,authority.epoch,{path:'/DO_NOT_EXPORT_HOST_PATH'}]);
  await db.pool.query("INSERT INTO ac_audit(context_id,kind,detail) SELECT $1,'custom.event',$2 FROM generate_series(1,102)",[contextId,{path:'/DO_NOT_EXPORT_AUDIT'}]);
  const service=new PortableExport(db);
  await assert.rejects(service.export('fixture-viewer',project,contextId),/PORTABLE_EXPORT_FORBIDDEN/);
  await assert.rejects(service.export(principal,randomUUID(),contextId),/PORTABLE_EXPORT_FORBIDDEN/);
  const result=await service.export(principal,project,contextId),{digest:actual,...payload}=result;
  assert.equal(actual,digest(payload));assert.equal(result.restorable,false);assert.equal(result.conversationIncluded,false);
  assert.equal(result.counts.audit.truncated,true);assert.equal(result.counts.audit.exported,100);assert.equal(result.truncated,true);
  assert.equal(result.sections.managerPlans.length,1);assert.equal(result.sections.verification.length,1);assert.equal(result.sections.integration.length,1);
  assert(Buffer.byteLength(JSON.stringify(result),'utf8')<=256*1024);
  assert(!JSON.stringify(result).includes('DO_NOT_EXPORT'));assert(!JSON.stringify(result).includes(profile));assert(!JSON.stringify(result).includes(account));
  assert.equal((await service.export(principal,project,other)).sections.managerPlans.length,0);
 }finally{await db.close();await database.close();}
});
