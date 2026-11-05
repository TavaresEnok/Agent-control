import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Ledger} from '../src/ledger.ts';
import {NativeProtocolCompatibility,pinNativeProtocolForNewAttempt} from '../src/native-protocol-compatibility.ts';
import {nativeExecutionExecutorDigest} from '../src/native-execution-contract.ts';
import {nativePlanningExecutorDigest} from '../src/native-planning-contract.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
const run=promisify(execFile);
test('trusted Docker protocol confirmation gates new images and preserves exact pinned attempts after revocation',{timeout:180000},async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url?.endsWith('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(url,'r4nativeprotocol'),db=new Ledger(isolated.url),label='ac-r4-protocol-'+randomUUID();
 const images=new Map<string,string>(),tags:string[]=[];
 try{
  await db.migrate();const principal='protocol-admin-'+randomUUID();await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  const service=new NativeProtocolCompatibility(db);
  for(const mode of ['old','new','incompatible','auth','timeout']){
   const tag=label+':'+mode;tags.push(tag);await run('docker',['build','--pull=false','--network=none','--label','agent-control.protocol-fixture='+label,'--build-arg','fixture_mode='+mode,'-t',tag,'tests/fixtures/r4-protocol'],{timeout:30000,maxBuffer:1024*1024});
   const result=await run('docker',['image','inspect','--format','{{.Id}}',tag]);images.set(mode,result.stdout.trim());
  }
  const spec=(mode:string)=>{const workerImage=images.get(mode)!,toolsImage=images.get('old')!;return {kind:'execution' as const,workerImage,toolsImage,executorDigest:nativeExecutionExecutorDigest(workerImage,toolsImage)};};
  const pin=(mode:string,jobId=randomUUID(),model=mode==='new'?'fixed-worker-v2':'fixed-worker-v1')=>db.tx(c=>pinNativeProtocolForNewAttempt(c,{kind:'execution',jobId,executorDigest:spec(mode).executorDigest,model,effort:'medium'}));
  await assert.rejects(pin('old'),/NATIVE_PROTOCOL_UNCONFIRMED/);
  await assert.rejects(service.promote(principal,randomUUID(),0),/NATIVE_PROTOCOL_RECEIPT_REQUIRED/);
  await assert.rejects(service.verify('not-admin',spec('old')),/CONTROL_ADMIN_REQUIRED/);
  await assert.rejects(service.verify(principal,{...spec('old'),passed:true} as any));
  const old=await service.verify(principal,spec('old'));assert.equal(old.cliVersion,'codex-cli 1.0.0');assert.deepEqual(old.models,[{model:'fixed-worker-v1',efforts:['medium']}]);
  await assert.rejects(pin('old'),/NATIVE_PROTOCOL_UNCONFIRMED/); // observation alone is not promotion
  await service.promote(principal,old.id,0);const oldJob=randomUUID(),oldPin=await pin('old',oldJob);assert.equal(oldPin.receiptId,old.id);
  await assert.rejects(pin('new'),/NATIVE_PROTOCOL_UNCONFIRMED/);
  await assert.rejects(pin('old',randomUUID(),'fixed-worker-v2'),/NATIVE_PROTOCOL_UNCONFIRMED/);
  await assert.rejects(db.tx(c=>pinNativeProtocolForNewAttempt(c,{kind:'execution',jobId:oldJob,executorDigest:spec('old').executorDigest,model:'fixed-worker-v1',effort:'high'})),/NATIVE_PROTOCOL_PIN_CONFLICT/);
  for(const mode of ['incompatible','auth','timeout']){await assert.rejects(service.verify(principal,spec(mode)),/NATIVE_PROTOCOL_(?:OUTPUT_INVALID|REJECTED|TIMEOUT)/);await assert.rejects(pin(mode),/NATIVE_PROTOCOL_UNCONFIRMED/);}
  const newer=await service.verify(principal,spec('new'));assert.equal(newer.cliVersion,'codex-cli 2.0.0');await service.promote(principal,newer.id,0);assert.equal((await pin('new')).receiptId,newer.id);
  await service.revoke(principal,spec('old').executorDigest,1);await assert.rejects(pin('old'),/NATIVE_PROTOCOL_UNCONFIRMED/);assert.deepEqual(await pin('old',oldJob),oldPin);
  await assert.rejects(db.pool.query("UPDATE ac_native_protocol_receipts SET cli_version='forged' WHERE id=$1",[old.id]),/NATIVE_PROTOCOL_RECEIPT_IMMUTABLE/);
  await assert.rejects(db.pool.query('DELETE FROM ac_native_protocol_attempt_pins WHERE job_id=$1',[oldJob]),/NATIVE_PROTOCOL_RECEIPT_IMMUTABLE/);
  const planImage=images.get('new')!,planning={kind:'planning' as const,workerImage:planImage,executorDigest:nativePlanningExecutorDigest(planImage)};
  const planReceipt=await service.verify(principal,planning);await service.promote(principal,planReceipt.id,0);
  assert.equal((await db.tx(c=>pinNativeProtocolForNewAttempt(c,{kind:'planning',jobId:randomUUID(),executorDigest:planning.executorDigest,model:'fixed-worker-v2',effort:'medium'}))).receiptId,planReceipt.id);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_native_protocol_receipts')).rows[0].n,3);
  for(const table of ['ac_native_execution_jobs','ac_native_planning_jobs'])assert.equal((await db.pool.query('SELECT count(*)::int n FROM '+table)).rows[0].n,0);
  const containers=await run('docker',['ps','-a','--filter','label=agent-control.protocol-check=true','--format','{{.Names}}']);assert.equal(containers.stdout.trim(),'');
  console.log(JSON.stringify({trustedVerifier:'fixed credentialless network-none Docker CLI version/initialize/model-list',images:5,protocolFailuresRejected:3,immutableReceipts:3,oldPinnedReceiptSurvivesRevocation:true,callerPassedRejected:true,inference:false,officialEligibility:false}));
 }finally{
  for(const tag of tags){const found=await run('docker',['image','inspect','--format','{{index .Config.Labels "agent-control.protocol-fixture"}}',tag]).catch(()=>null);if(found?.stdout.trim()===label)await run('docker',['image','rm',tag],{timeout:15000,maxBuffer:65536});}
  await db.close();await isolated.close();
 }
});
