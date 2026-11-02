import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,generateKeyPairSync,createHash,sign} from 'node:crypto';
import {z} from 'zod';
import {Ledger} from '../src/ledger.ts';
import {ContextKeys,keyFingerprint} from '../src/context-keys.ts';
import {ManagerRegistry} from '../src/managers.ts';
import {AdministrativeOperations,administrativeReceiptMessage} from '../src/administrative-operations.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('administrative capability journals uncertain effects and reconciles without repeating',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(url,'adminops'),db=new Ledger(isolated.url);let registry:ManagerRegistry|undefined,successor:ManagerRegistry|undefined;
 try{
  await db.migrate();const project=randomUUID(),principal='admin-fixture-'+randomUUID(),key=randomBytes(32),executorDigest='a'.repeat(64);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Synthetic administrative fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const contextId=await db.createContext(principal,project,randomUUID());
  const sessionId=(await db.pool.query('SELECT session_id FROM ac_session_links WHERE context_id=$1',[contextId])).rows[0].session_id;
  await new ContextKeys(db).authorize(principal,contextId,1,'legacy',keyFingerprint(key));
  registry=new ManagerRegistry(db,project,()=>({async start(){},close(){}}));
  const authority=await registry.start({principal,contextId,sessionId,profileId:'synthetic-manager',keyVersion:1,encryptionVariant:'legacy',key});
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:synthetic'}},authority,'api');
  let executions=0,reconciliations=0,terminal=false,forge=false;const keys=generateKeyPairSync('ed25519'),publicBytes=keys.publicKey.export({type:'spki',format:'der'}),receiptKeyFingerprint=createHash('sha256').update(publicBytes).digest('hex');
  const service=new AdministrativeOperations(db,[{id:'fixture.observe',version:1,digest:executorDigest,receiptPublicKey:publicBytes.toString('base64'),parametersSchema:z.object({value:z.string().max(10)}).strict(),
   async execute(input){await input.assertAuthorized();executions++;throw Error('SYNTHETIC_RECEIPT_LOST');},
   async reconcile(input){reconciliations++;if(!terminal)return null;const payload={operationId:input.operationId,intentId:input.intentId,contextId:input.contextId,epoch:input.executionEpoch,policyRevision:input.policyRevision,id:'fixture.observe',version:1,executorDigest,parametersDigest:input.parametersDigest,state:'exited' as const,exitCode:0 as const,resultDigest:'b'.repeat(64)};return {payload,signature:forge?'0'.repeat(128):sign(null,administrativeReceiptMessage(payload),keys.privateKey).toString('hex')};}}]);
  await db.tx(c=>service.publish(c,principal,contextId,0,{operations:[{id:'fixture.observe',version:1,executorDigest,receiptKeyFingerprint,managerProfileIds:['synthetic-manager']}]}));
  const capability=await registry.administrativeCapability(contextId,service),op={operationId:randomUUID(),intentId:intent.id,id:'fixture.observe',version:1,policyRevision:1,parameters:{value:'test'}};
  await assert.rejects(service.execute(JSON.parse(JSON.stringify(capability)),op),/ADMIN_CAPABILITY_REQUIRED/);
  await assert.rejects(service.execute(capability,op),/ADMIN_OPERATION_UNCERTAIN/);assert.equal(executions,1);
  await assert.rejects(service.execute(capability,op),/ADMIN_OPERATION_UNCERTAIN/);assert.equal(executions,1);assert.equal(reconciliations,1);
  const second={...op,operationId:randomUUID()};await assert.rejects(service.execute(capability,second),/ADMIN_CAPACITY_BUSY/);
  assert.equal((await db.pool.query('SELECT state FROM ac_administrative_operations WHERE id=$1',[second.operationId])).rows[0].state,'registered');
  await registry.stop(contextId);successor=new ManagerRegistry(db,project,()=>({async start(){},close(){}}));
  await successor.start({principal,contextId,sessionId,profileId:'fallback-manager',keyVersion:1,encryptionVariant:'legacy',key});
  const fallback=await successor.administrativeCapability(contextId,service);
  await db.pause(principal,contextId,true);await db.tx(c=>service.publish(c,principal,contextId,1,{operations:[]}));
  terminal=true;forge=true;await assert.rejects(service.execute(fallback,op),/ADMIN_OPERATION_UNCERTAIN/);
  assert.equal((await db.pool.query('SELECT state FROM ac_administrative_operations WHERE id=$1',[op.operationId])).rows[0].state,'uncertain');
  forge=false;assert.equal((await service.execute(fallback,op)).state,'completed');assert.equal(executions,1);
  assert.equal((await service.execute(fallback,op)).state,'completed');assert.equal(reconciliations,3);
  await assert.rejects(service.execute(fallback,second),/HUMAN_PAUSED/);
  await successor.stop(contextId);await assert.rejects(service.execute(fallback,second),/ADMIN_CAPABILITY_REVOKED/);
 }finally{await registry?.close();await successor?.close();await db.close();await isolated.close();}
});
