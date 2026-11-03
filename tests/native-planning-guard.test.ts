import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {NativePlanningSupervisor,nativePlanningExecutorDigest} from '../src/native-planning-supervisor.ts';
import {digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('a dormant real-account grant cannot reach Docker, read account credentials, or generate native planning output',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(base,'nativeguard'),db=new Ledger(isolated.url),capacity=new Capacity(db);
 try{
  await db.migrate();const principal='native-guard-'+randomUUID(),project=randomUUID(),account=randomUUID(),profile=randomUUID();
  const imageId='sha256:'+'c'.repeat(64),executorDigest=nativePlanningExecutorDigest(imageId),subjectDigest='a'.repeat(64),key=generateKeyPairSync('ed25519');
  const supervisor=new NativePlanningSupervisor(db,{id:'codex-native-planning',executorDigest,imageId,hostRoot:'/private-synthetic-nonexistent/spool',accountRoot:'/private-synthetic-nonexistent/accounts',protectedRepositories:[],
   signingKeyPem:key.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetwork:'ac-native-provider',accountSubjects:[{accountId:account,subjectDigest}],socketPath:'/nonexistent-synthetic-docker-socket'});
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Dormant native account guard']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await capacity.addAccount(principal,project,{id:account,provider:'codex',label:'Dormant synthetic metadata',resourceIdentity:'codex:'+subjectDigest,mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/synthetic-evidence',maxConcurrent:1});
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'fixture-model','high','manager',false)",[profile,account]);
  const contextId=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,contextId,randomUUID(),'guard-manager',60);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:guard'}},authority,'api');
  await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),principal]);
  const grantId=randomUUID(),callId=randomUUID(),sessionId=randomUUID(),inputDigest=digest({synthetic:'guard'});
  // Intentionally forged reserved grant in the disposable database: enabled and
  // eligibility checks must still protect the physical effect boundary.
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,'manager',$8,1,1,$9,false,'reserved')`,[grantId,randomUUID(),intent.id,contextId,authority.epoch,account,profile,project,inputDigest]);
  await db.pool.query(`INSERT INTO ac_semantic_planning_calls(id,context_id,intent_id,principal_id,input_digest,executor_id,executor_digest,expected_revision,attempt_id,session_id,grant_id,profile_id,execution_epoch,state,selected_executor_id,selected_executor_digest,selected_key_fingerprint)
   VALUES($1,$2,$3,$4,$5,'semantic-planning-v1',$6,0,$7,$8,$9,$10,$11,'uncertain',$12,$13,$14)`,[callId,contextId,intent.id,principal,inputDigest,digest({contract:'semantic-planning-v1'}),randomUUID(),sessionId,grantId,profile,authority.epoch,supervisor.executor.id,executorDigest,'e'.repeat(64)]);
  await assert.rejects(supervisor.executor.execute({callId,intentId:intent.id,contextId,grantId,sessionId,executionEpoch:authority.epoch,inputDigest,
   profile:{id:profile,accountId:account,provider:'codex',mode:'subscription_cli',model:'fixture-model',effort:'high'},sourceMessageRef:'message:fixture',text:'No account or model may be used',constraints:{qualityRevision:1,targetRef:'refs/heads/test',knownReferences:[]},outputSchema:{},assertAuthorized:async()=>{}}),/NATIVE_PLANNING_NOT_ELIGIBLE/);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_native_planning_jobs')).rows[0].n,0);
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[grantId])).rows[0].state,'reserved');
 }finally{await db.close();await isolated.close();}
});
