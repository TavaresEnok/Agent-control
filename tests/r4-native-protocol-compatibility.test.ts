import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
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
 const images=new Map<string,string>(),tags:string[]=[];const privateFolder=await mkdtemp(join(tmpdir(),'ac-r4-protocol-controller-'));let controller:ReturnType<typeof spawn>|undefined;
 try{
  await db.migrate();const principal='protocol-admin-'+randomUUID();await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  const service=new NativeProtocolCompatibility(db);
  for(const mode of ['old','new','incompatible','auth','timeout','early-exit','hang-descendant']){
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
  for(const mode of ['incompatible','auth','timeout','early-exit']){await assert.rejects(service.verify(principal,spec(mode)),/NATIVE_PROTOCOL_(?:OUTPUT_INVALID|REJECTED|TIMEOUT|PROCESS_EXITED|PROCESS_FAILED)/);await assert.rejects(pin(mode),/NATIVE_PROTOCOL_UNCONFIRMED/);}
  const newer=await service.verify(principal,spec('new'));assert.equal(newer.cliVersion,'codex-cli 2.0.0');await service.promote(principal,newer.id,0);assert.equal((await pin('new')).receiptId,newer.id);
  await service.revoke(principal,spec('old').executorDigest,1);await assert.rejects(pin('old'),/NATIVE_PROTOCOL_UNCONFIRMED/);assert.deepEqual(await pin('old',oldJob),oldPin);
  await assert.rejects(db.pool.query("UPDATE ac_native_protocol_receipts SET cli_version='forged' WHERE id=$1",[old.id]),/NATIVE_PROTOCOL_RECEIPT_IMMUTABLE/);
  await assert.rejects(db.pool.query('DELETE FROM ac_native_protocol_attempt_pins WHERE job_id=$1',[oldJob]),/NATIVE_PROTOCOL_RECEIPT_IMMUTABLE/);
  // A controller SIGKILL cannot stop the independently running watchdog.
  const descriptor=join(privateFolder,'controller.json');await writeFile(descriptor,JSON.stringify({url:isolated.url,principal,spec:spec('hang-descendant')}),{mode:0o600});
  controller=spawn(process.execPath,['--import','tsx','tests/fixtures/r4-protocol-controller.ts',descriptor],{cwd:process.cwd(),env:{HOME:privateFolder,PATH:'/tmp/node-v22.23.3-linux-x64/bin:/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC'},stdio:'ignore'});
  let probe:any,physical:any,logs='';const readyDeadline=Date.now()+12000;
  while(Date.now()<readyDeadline){
   probe=(await db.pool.query("SELECT * FROM ac_native_protocol_probe_operations WHERE executor_digest=$1 AND phase='rpc' AND NOT retired ORDER BY created_at DESC LIMIT 1",[spec('hang-descendant').executorDigest])).rows[0];
   if(probe){try{physical=JSON.parse((await run('docker',['inspect',probe.container_name])).stdout)[0];logs=(await run('docker',['logs',physical.Id])).stderr;if(logs.includes('SYNTHETIC_PULSE'))break;}catch{}}
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(probe&&physical&&logs.includes('SYNTHETIC_PULSE'),'DETACHED_PROBE_DID_NOT_START');
  const marker=logs.split('\n').find(line=>line.startsWith('{"probeDetached"'));assert.ok(marker);const detached=JSON.parse(marker!);assert.equal(detached.pid,detached.sid,'fixture really started a separate session');
  assert.equal(physical.HostConfig.NetworkMode,'none');assert.ok(physical.Mounts.every((mount:any)=>mount.Type==='tmpfs'&&mount.Destination==='/tmp'));
  const controllerExit=once(controller,'exit');controller.kill('SIGKILL');assert.equal((await controllerExit)[1],'SIGKILL');controller=undefined;
  while(Date.now()<Number(probe.deadline_ms)+1500){physical=JSON.parse((await run('docker',['inspect',physical.Id])).stdout)[0];if(!physical.State.Running)break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(physical.State.Running,false,'independent watchdog stops setsid descendants after controller death');
  const stoppedLogs=(await run('docker',['logs',physical.Id])).stderr;await new Promise(resolve=>setTimeout(resolve,300));assert.equal((await run('docker',['logs',physical.Id])).stderr,stoppedLogs,'descendant stopped writing');
  const stoppedCmd=physical.Config.Cmd; // command body came from the trusted verifier
  await service.reconcile(principal);await assert.rejects(run('docker',['inspect',physical.Id]));
  assert.equal((await db.pool.query('SELECT container_id,retired FROM ac_native_protocol_probe_operations WHERE id=$1',[probe.id])).rows[0].container_id,physical.Id);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_native_protocol_receipts WHERE executor_digest=$1',[spec('hang-descendant').executorDigest])).rows[0].n,0);
  // A create delayed past an absent reconciliation cannot start the CLI, and
  // a later sweep still removes that stopped residue by its exact identity.
  const delayedId=randomUUID(),delayedName='ac-protocol-delayed-'+delayedId,deadline=Date.now()-100;
  await db.pool.query("INSERT INTO ac_native_protocol_probe_operations(id,executor_digest,worker_image,phase,container_name,deadline_ms) VALUES($1,$2,$3,'rpc',$4,$5)",[delayedId,spec('hang-descendant').executorDigest,images.get('hang-descendant'),delayedName,deadline]);
  await service.reconcile(principal);assert.equal((await db.pool.query('SELECT retired FROM ac_native_protocol_probe_operations WHERE id=$1',[delayedId])).rows[0].retired,true);
  const lateCmd=[...stoppedCmd];lateCmd[lateCmd.length-1]=String(deadline);
  await run('docker',['create','--name',delayedName,'--label','agent-control.protocol-operation='+delayedId,'--label','agent-control.protocol-deadline='+deadline,'--label','agent-control.protocol-image='+images.get('hang-descendant'),'--network','none','--read-only','--user','65534:65534','--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--entrypoint','/usr/local/bin/node',images.get('hang-descendant')!,...lateCmd]);
  await run('docker',['start','-a',delayedName]);const late=JSON.parse((await run('docker',['inspect',delayedName])).stdout)[0];assert.equal(late.State.Running,false);assert.equal(late.State.ExitCode,124);assert.equal((await run('docker',['logs',late.Id])).stderr,'');
  await service.reconcile(principal);await assert.rejects(run('docker',['inspect',late.Id]));
  const planImage=images.get('new')!,planning={kind:'planning' as const,workerImage:planImage,executorDigest:nativePlanningExecutorDigest(planImage)};
  const planReceipt=await service.verify(principal,planning);await service.promote(principal,planReceipt.id,0);
  assert.equal((await db.tx(c=>pinNativeProtocolForNewAttempt(c,{kind:'planning',jobId:randomUUID(),executorDigest:planning.executorDigest,model:'fixed-worker-v2',effort:'medium'}))).receiptId,planReceipt.id);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_native_protocol_receipts')).rows[0].n,3);
  for(const table of ['ac_native_execution_jobs','ac_native_planning_jobs'])assert.equal((await db.pool.query('SELECT count(*)::int n FROM '+table)).rows[0].n,0);
  for(const image of images.values()){const containers=await run('docker',['ps','-a','--filter','label=agent-control.protocol-image='+image,'--format','{{.Names}}']);assert.equal(containers.stdout.trim(),'');}
  console.log(JSON.stringify({trustedVerifier:'fixed credentialless network-none Docker CLI version/initialize/model-list',images:7,protocolFailuresRejected:4,controllerSigkillWatchdog:true,setsidDescendantStopped:true,delayedCreateDenied:true,immutableReceipts:3,oldPinnedReceiptSurvivesRevocation:true,callerPassedRejected:true,inference:false,officialEligibility:false}));
 }finally{
  controller?.kill('SIGKILL');await rm(privateFolder,{recursive:true,force:true});
  for(const tag of tags){const found=await run('docker',['image','inspect','--format','{{index .Config.Labels "agent-control.protocol-fixture"}}',tag]).catch(()=>null);if(found?.stdout.trim()===label)await run('docker',['image','rm',tag],{timeout:15000,maxBuffer:65536});}
  await db.close();await isolated.close();
 }
});
