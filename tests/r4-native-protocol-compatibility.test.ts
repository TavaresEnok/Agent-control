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
import {nativeProtocolHostSupervisor} from '../src/native-protocol-host-supervisor.ts';
import {NativeProtocolCompatibility,pinNativeProtocolForNewAttempt} from '../src/native-protocol-compatibility.ts';
import {nativeExecutionExecutorDigest} from '../src/native-execution-contract.ts';
import {nativePlanningExecutorDigest} from '../src/native-planning-contract.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
const run=promisify(execFile);
test('trusted Docker protocol confirmation gates new images and preserves exact pinned attempts after revocation',{timeout:180000},async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url?.endsWith('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(url,'r4nativeprotocol'),db=new Ledger(isolated.url),label='ac-r4-protocol-'+randomUUID();
 const images=new Map<string,string>(),tags:string[]=[];const privateFolder=await mkdtemp(join(tmpdir(),'ac-r4-protocol-controller-'));let controller:ReturnType<typeof spawn>|undefined;let primaryFailure:unknown;
 try{
  await db.migrate();const principal='protocol-admin-'+randomUUID();await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  const service=new NativeProtocolCompatibility(db);
  for(const mode of ['old','new','incompatible','auth','timeout','early-exit','hang-descendant','fake-node']){
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
  const deadPhysicalId=physical.Id;while(Date.now()<Number(probe.deadline_ms)+1500){try{physical=JSON.parse((await run('docker',['inspect',deadPhysicalId])).stdout)[0];if(!physical.State.Running)break;}catch{physical=undefined;break;}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(!physical||!physical.State.Running,'independent watchdog stops setsid descendants after controller death');
  if(physical){const stoppedLogs=(await run('docker',['logs',deadPhysicalId])).stderr;await new Promise(resolve=>setTimeout(resolve,300));assert.equal((await run('docker',['logs',deadPhysicalId])).stderr,stoppedLogs,'descendant stopped writing');}else await assert.rejects(run('docker',['top',deadPhysicalId]));
  await service.reconcile(principal);await assert.rejects(run('docker',['inspect',deadPhysicalId]));
  assert.equal((await db.pool.query('SELECT container_id,retired FROM ac_native_protocol_probe_operations WHERE id=$1',[probe.id])).rows[0].container_id,deadPhysicalId);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_native_protocol_receipts WHERE executor_digest=$1',[spec('hang-descendant').executorDigest])).rows[0].n,0);
  // A create delayed past an absent reconciliation cannot start the CLI, and
  // a later sweep still removes that stopped residue by its exact identity.
  const delayedId=randomUUID(),delayedName='ac-protocol-delayed-'+delayedId,deadline=Date.now()-100;
  await db.pool.query("INSERT INTO ac_native_protocol_probe_operations(id,executor_digest,worker_image,phase,container_name,deadline_ms) VALUES($1,$2,$3,'rpc',$4,$5)",[delayedId,spec('hang-descendant').executorDigest,images.get('hang-descendant'),delayedName,deadline]);
  await service.reconcile(principal);assert.equal((await db.pool.query('SELECT retired FROM ac_native_protocol_probe_operations WHERE id=$1',[delayedId])).rows[0].retired,true);
  const lateOperation=(await db.pool.query('SELECT * FROM ac_native_protocol_probe_operations WHERE id=$1',[delayedId])).rows[0];
  const lateSupervisor=spawn('/proc/'+process.pid+'/exe',['-e',nativeProtocolHostSupervisor,JSON.stringify(lateOperation)],{env:{PATH:'/usr/bin:/bin',HOME:privateFolder},stdio:['ignore','ignore','ignore','ipc']});assert.equal((await once(lateSupervisor,'exit'))[0],0);await assert.rejects(run('docker',['inspect',delayedName]));
  await run('docker',['create','--name',delayedName,'--label','agent-control.protocol-operation='+delayedId,'--label','agent-control.protocol-deadline='+deadline,'--label','agent-control.protocol-image='+images.get('hang-descendant'),'--network','none','--read-only','--user','65534:65534','--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--entrypoint','/usr/local/bin/codex',images.get('hang-descendant')!,'app-server']);
  const late=JSON.parse((await run('docker',['inspect',delayedName])).stdout)[0];assert.equal(late.State.Running,false);assert.equal(late.State.Status,'created');assert.equal((await run('docker',['logs',late.Id])).stderr,'');
  await service.reconcile(principal);await assert.rejects(run('docker',['inspect',late.Id]));
  // A candidate can replace node and ignore our former in-image -e guard.
  // The host supervisor owns lifetime even for this malicious interpreter.
  await writeFile(descriptor,JSON.stringify({url:isolated.url,principal,spec:spec('fake-node')}),{mode:0o600});
  controller=spawn(process.execPath,['--import','tsx','tests/fixtures/r4-protocol-controller.ts',descriptor],{cwd:process.cwd(),env:{HOME:privateFolder,PATH:'/tmp/node-v22.23.3-linux-x64/bin:/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC'},stdio:'ignore'});
  let fakeProbe:any,fakePhysical:any,fakeLogs='';const fakeReady=Date.now()+12000;
  while(Date.now()<fakeReady){fakeProbe=(await db.pool.query("SELECT * FROM ac_native_protocol_probe_operations WHERE executor_digest=$1 AND phase='version' AND NOT retired ORDER BY created_at DESC LIMIT 1",[spec('fake-node').executorDigest])).rows[0];
   if(fakeProbe){try{fakePhysical=JSON.parse((await run('docker',['inspect',fakeProbe.container_name])).stdout)[0];fakeLogs=(await run('docker',['logs',fakePhysical.Id])).stderr;if(fakeLogs.includes('SYNTHETIC_FAKE_NODE_PULSE'))break;}catch{}}
   await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(fakeProbe&&fakePhysical&&fakeLogs.includes('SYNTHETIC_FAKE_NODE_PULSE'),'FAKE_NODE_DID_NOT_RUN');
  const fakeExit=once(controller,'exit');controller.kill('SIGKILL');await fakeExit;controller=undefined;
  while(Date.now()<Number(fakeProbe.deadline_ms)+1500){try{fakePhysical=JSON.parse((await run('docker',['inspect',fakePhysical.Id])).stdout)[0];if(!fakePhysical.State.Running)break;}catch{fakePhysical=undefined;break;}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(!fakePhysical||!fakePhysical.State.Running,'candidate fake node cannot bypass host lifetime');
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_native_protocol_receipts WHERE executor_digest=$1',[spec('fake-node').executorDigest])).rows[0].n,0);
  const planImage=images.get('new')!,planning={kind:'planning' as const,workerImage:planImage,executorDigest:nativePlanningExecutorDigest(planImage)};
  const planReceipt=await service.verify(principal,planning);await service.promote(principal,planReceipt.id,0);
  assert.equal((await db.tx(c=>pinNativeProtocolForNewAttempt(c,{kind:'planning',jobId:randomUUID(),executorDigest:planning.executorDigest,model:'fixed-worker-v2',effort:'medium'}))).receiptId,planReceipt.id);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_native_protocol_receipts')).rows[0].n,3);
  for(const table of ['ac_native_execution_jobs','ac_native_planning_jobs'])assert.equal((await db.pool.query('SELECT count(*)::int n FROM '+table)).rows[0].n,0);
  for(const image of images.values()){const containers=await run('docker',['ps','-a','--filter','label=agent-control.protocol-image='+image,'--format','{{.Names}}']);assert.equal(containers.stdout.trim(),'');}
  console.log(JSON.stringify({trustedVerifier:'fixed credentialless network-none Docker CLI version/initialize/model-list',images:8,fakeCandidateInterpreterBounded:true,protocolFailuresRejected:4,controllerSigkillWatchdog:true,setsidDescendantStopped:true,delayedCreateDenied:true,immutableReceipts:3,oldPinnedReceiptSurvivesRevocation:true,callerPassedRejected:true,inference:false,officialEligibility:false}));
 }catch(error){primaryFailure=error;throw error;}finally{
  const cleanupErrors:unknown[]=[];
  if(controller&&controller.exitCode===null&&controller.signalCode===null){try{const exited=once(controller,'exit');controller.kill('SIGKILL');await exited;}catch(error){cleanupErrors.push(error);}}
  const operations=await db.pool.query('SELECT * FROM ac_native_protocol_probe_operations').catch(error=>{cleanupErrors.push(error);return {rows:[]};});
  for(const op of operations.rows){try{
   const found=await run('docker',['inspect',op.container_name]).catch(()=>null);if(!found)continue;
   const physical=JSON.parse(found.stdout)[0];
   if([...images.values()].includes(physical.Image)&&physical.Config?.Labels?.['agent-control.protocol-operation']===op.id&&(!op.container_id||physical.Id===op.container_id))await run('docker',['rm','-f',physical.Id],{timeout:15000,maxBuffer:65536});
  }catch(error){cleanupErrors.push(error);}}
  for(const tag of tags){try{const found=await run('docker',['image','inspect','--format','{{index .Config.Labels "agent-control.protocol-fixture"}}',tag]).catch(()=>null);if(found?.stdout.trim()===label)await run('docker',['image','rm',tag],{timeout:15000,maxBuffer:65536});}catch(error){cleanupErrors.push(error);}}
  await rm(privateFolder,{recursive:true,force:true}).catch(error=>cleanupErrors.push(error));await db.close().catch(error=>cleanupErrors.push(error));await isolated.close().catch(error=>cleanupErrors.push(error));
  if(cleanupErrors.length){if(primaryFailure)console.error('PROTOCOL_FIXTURE_CLEANUP_FAILURES',cleanupErrors.length);else throw new AggregateError(cleanupErrors,'PROTOCOL_FIXTURE_CLEANUP_FAILED');}
 }
});
