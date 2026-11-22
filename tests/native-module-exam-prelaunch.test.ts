import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {chmod,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {AccountHomes} from '../src/account-homes.ts';
import {NativeExecutionRequest,NativeExecutionSupervisor} from '../src/native-execution-supervisor.ts';
import {Refusal,digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

// Módulos 2 a 9 usam um intent só para todos os jobs e messageRef '<módulo>:<projeto>:<commit>'.
// A recusa do login Claude antes do lançamento não pode virar NATIVE_PRELAUNCH_SETTLEMENT_PENDING.
test('exame de módulo recusado pelo login antes do lançamento devolve o código do login e o reconcile fecha só o job',{skip:!process.env.AC_TEST_DATABASE_URL},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'modexampre');
 const db=new Ledger(fixture.url),area=await mkdtemp(join(tmpdir(),'ac-modexam-pre-'));
 const errors=mock.method(console,'error',()=>undefined);
 try{
  await db.migrate();
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  const project=randomUUID(),owner='app-'+randomUUID(),account=randomUUID(),profile=randomUUID(),commit='e'.repeat(40);
  const repo=join(area,'repo'),spool=join(area,'exec-host'),accounts=join(area,'accounts');
  for(const dir of [repo,spool,accounts,join(accounts,account)]){await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700);}
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Pre-launch module exam fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,owner]);
  await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
  const subject=digest({provider:'claude',subject:'module-exam-prelaunch'});
  const capacity=new Capacity(db);
  await capacity.addAccount(owner,project,{id:account,provider:'claude',label:'module exam fixture',resourceIdentity:'claude:'+subject,mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/fixture',maxConcurrent:2});
  await capacity.observeQuota(owner,account,{status:'available',source:'https://example.invalid/fixture',ttlSeconds:3600});
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'claude-sonnet-5-5','medium','specialist',true)",[profile,account]);
  await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),owner]);
  const contextId=await db.createContext(owner,project,randomUUID());
  await db.pool.query("INSERT INTO ac_exam_contexts(project_id,module,context_id) VALUES($1,'documentacao',$2)",[project,contextId]);
  const authority=await db.acquire(owner,contextId,randomUUID(),'module-exam',60);
  const intentId=randomUUID();
  const command={schemaVersion:1 as const,intentId,deliveryAttemptId:randomUUID(),contextId,policyRevision:1,action:'plan.start' as const,
   payload:{workflow:'security-verify-readonly-v1',messageRef:`documentacao:${project}:${commit}`,projectId:project,commit}};
  await db.pool.query(`INSERT INTO ac_intents (id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision)
   SELECT $1,id,$3,$4,$5::jsonb,$6,$7,$8,plan_revision FROM ac_contexts WHERE id=$2`,
   [intentId,contextId,owner,digest(command),JSON.stringify(command),randomUUID(),randomUUID(),authority.epoch]);
  await db.pool.query(`INSERT INTO ac_verify_runs (id,project_id,context_id,intent_id,principal_id,commit_id,status,report_dir,module) VALUES ($1,$2,$3,$4,$5,$6,'running','pending','documentacao')`,
   [randomUUID(),project,contextId,intentId,owner,commit]);
  const grantId=randomUUID();
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,'specialist',$8,1,1,$9,false,'reserved')`,[grantId,randomUUID(),intentId,contextId,authority.epoch,account,profile,project,digest({grant:grantId})]);

  const keys=generateKeyPairSync('ed25519'),image='sha256:'+'0'.repeat(64);
  const supervisor=new NativeExecutionSupervisor(db,{id:'claude-native-execution',provider:'claude',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],
   signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:'d'.repeat(64),socketPath:join(area,'docker.sock'),
   accountSubjects:[{accountId:account,subjectDigest:subject}],workerEnv:[],toolsEnv:[],examLoginRenew:async()=>{throw new Error('EXAM_LOGIN_RENEW_UNEXPECTED');}},{assertAdmission:async()=>{}});
  const mutations:string[]=[];
  Object.defineProperty(supervisor,'doc'+'ker',{value:{
   imagePresent:async()=>true,inspect:async()=>null,inspectNamedPrivateNetwork:async()=>null,inspectPrivateNetwork:async()=>null,
   stop:async()=>{mutations.push('stop');},remove:async()=>{mutations.push('remove');},start:async()=>{mutations.push('start');},
   createPrivateNetwork:async()=>{mutations.push('network');return 'a'.repeat(64);},create:async()=>{mutations.push('create');return 'c'.repeat(64);},
  }});
  const homes=mock.method(AccountHomes.prototype,'inspectGranted',async()=>({accountId:account,projectId:project,ownerId:owner,uid:'1',device:'1',inode:'1'}));
  try{
   const request=NativeExecutionRequest.parse({jobId:randomUUID(),intentId,grantId,sessionId:randomUUID(),base:commit,role:'specialist',task:'Examine a documentação.',
    writePaths:[],artifactId:randomUUID(),outputSchema:{type:'object'},moduleExam:{accountId:account,profileId:profile,model:'claude-sonnet-5-5'},timeoutMs:120000});
   // Sem .credentials.json o login está vencido: a preparação recusa antes de qualquer contêiner.
   await assert.rejects(()=>supervisor.start(owner,authority,request),(error:unknown)=>error instanceof Refusal&&error.code==='EXAM_LOGIN_STALE');
   assert.deepEqual(mutations,[]);
   const physical={executionStarted:false,jobId:request.jobId,containerId:null,networkId:null,synthetic:false,modelInference:false,reason:'exam_login_stale'};
   const grant=(await db.pool.query('SELECT state,physical_receipt FROM ac_capacity_grants WHERE id=$1',[grantId])).rows[0];
   assert.equal(grant.state,'released');assert.deepEqual(grant.physical_receipt,physical);
   const job=(await db.pool.query('SELECT state,receipt FROM ac_native_execution_jobs WHERE id=$1',[request.jobId])).rows[0];
   assert.equal(job.state,'uncertain');assert.equal(job.receipt,null);
   // O intent é do módulo inteiro: continua aberto para os outros jobs.
   assert.equal((await db.pool.query('SELECT state FROM ac_intents WHERE id=$1',[intentId])).rows[0].state,'accepted');

   const sealed=await supervisor.reconcile(owner,authority,request);
   assert.equal(sealed.state,'failed');
   assert.ok(sealed.state==='failed');assert.equal(sealed.failureCode,'exam_login_stale');assert.equal(sealed.output,'');
   assert.equal(sealed.receipt.payload.executionStarted,false);assert.equal(sealed.receipt.payload.physicalDigest,digest(physical));
   const after=(await db.pool.query('SELECT state,receipt FROM ac_native_execution_jobs WHERE id=$1',[request.jobId])).rows[0];
   assert.equal(after.state,'failed');assert.deepEqual(after.receipt,sealed.receipt);
   // A repetição lê o recibo assinado e não muda nada.
   assert.deepEqual(await supervisor.reconcile(owner,authority,request),sealed);
   assert.equal((await db.pool.query('SELECT state FROM ac_intents WHERE id=$1',[intentId])).rows[0].state,'accepted');
   assert.deepEqual(mutations,[]);
   assert.equal(errors.mock.calls.some(call=>String(call.arguments[0]).includes('NATIVE_PRELAUNCH_SETTLEMENT_PENDING')),false);
  }finally{homes.mock.restore();}
 }finally{
  errors.mock.restore();
  await db.pool.end();await fixture.close();await rm(area,{recursive:true,force:true});
 }
});
