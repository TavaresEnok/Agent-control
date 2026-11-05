import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {chmod,copyFile,lstat,mkdir,mkdtemp,readFile,readdir,rm,symlink,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {once} from 'node:events';
import pg from 'pg';
import {Ledger} from '../src/ledger.ts';
import {Admission} from '../src/admission.ts';
import {NativeResourceDockerDaemon} from '../src/native-resource-envelope.ts';
import {RemoteOperations,OpenSshTransport,type RemoteHost} from '../src/remote.ts';
import {configureRecoveryInventory} from '../src/recovery-inventory.ts';
import {releaseRestoredPhysicalHolds,sweepRestoredPhysicalInventory} from '../src/recovery-physical-sweep.ts';
import {backupLaboratoryDatabase,restoreLaboratoryDatabase} from '../src/laboratory-recovery.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {provisionFlowResources,retireFlowResources,type FlowResourceEnvelope} from './fixtures/r3-flow-resources.ts';

const exec=promisify(execFile),sha=(s:string)=>createHash('sha256').update(s).digest('hex');
async function command(binary:string,args:string[]){return (await exec(binary,args,{timeout:30000,maxBuffer:1048576})).stdout.trim();}
async function until<T>(fn:()=>Promise<T|undefined>,ms=15000):Promise<T>{const end=Date.now()+ms;while(Date.now()<end){const x=await fn();if(x!==undefined)return x;await new Promise(r=>setTimeout(r,100));}throw Error('T30_LAB_TIMEOUT');}
async function ownCatalogHelper(){const matches:number[]=[];for(const name of await readdir('/proc')){if(!/^\d+$/.test(name))continue;try{const status=await readFile('/proc/'+name+'/status','utf8'),argv=await readFile('/proc/'+name+'/cmdline','utf8');if(Number(/^PPid:\s*(\d+)/m.exec(status)?.[1])===process.pid&&argv.split('\0').some(x=>x.endsWith('/services/recovery/catalog_reconcile.py')))matches.push(Number(name));}catch{}}
 if(matches.length!==1)throw Error('T30_HELPER_IDENTITY_UNCERTAIN');return matches[0]!;}
async function waitForAdmissionLock(db:Ledger){return until(async()=>{const q=await db.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM ac_admission_control WHERE id=1 FOR UPDATE%' AND pid<>pg_backend_pid()");return q.rowCount?true:undefined;});}

test('T30 post-backup physical native and SSH writers are fenced and retired before reopening',{timeout:180000},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL,pgContainer=process.env.AC_R3_MIGRATION_CONTAINER_ID;if(!base||!pgContainer)throw Error('T30_ISOLATED_LAB_REQUIRED');
 const fixture=await isolatedDatabase(base,'r3t30'),db=new Ledger(fixture.url),area=await mkdtemp(join(tmpdir(),'ac-r5-t30-'));
 let native:FlowResourceEnvelope|undefined,remoteAuthority:FlowResourceEnvelope|undefined,sshContainer:string|undefined,child:ReturnType<typeof spawn>|undefined,holdLocker:ReturnType<typeof spawn>|undefined,restored:Ledger|undefined,targetDatabase:string|undefined;
 let recoveryId:string|undefined;
 const nativeArea=join(area,'native'),sshArea=join(area,'ssh');
 const scope='ac-r5-t30-'+randomUUID(),image='agent-control-ssh-lab:0.1.0';
 try{
  const project=join(area,'project'),installed=join(area,'installed');
  for(const path of [project,installed,nativeArea,sshArea])await mkdir(path,{mode:path===project?0o777:0o700});await chmod(project,0o777);
  native=await provisionFlowResources(nativeArea,image);remoteAuthority=await provisionFlowResources(sshArea,image);
  const projectId=randomUUID(),hostId=randomUUID(),credentialId=randomUUID(),principal='t30-'+randomUUID();
  await command('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(area,'client')]);await command('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(area,'host')]);
  await writeFile(join(area,'authorized_keys'),await readFile(join(area,'client.pub')),{mode:0o600});
  for(const file of ['worker.py','remote_supervisor.py','resource_authority.py'])await copyFile(resolve('services/remote-worker',file),join(installed,file));
  const configBase={stateDirectory:remoteAuthority.stateRoot,projects:{[projectId]:project},tasks:{slow:['/usr/bin/python3','-c',"import pathlib,time; p=pathlib.Path('/project/ssh-writes');\nwhile True:\n p.open('a').write('x\\n');time.sleep(.03)"]},maxConcurrent:2,maxSeconds:600,maxLogBytes:4096,executionBackend:'docker',dockerImage:image,recoveryInventoryRequired:true,...remoteAuthority};
  await writeFile(join(area,'worker-1.json'),JSON.stringify(configBase),{mode:0o600});await writeFile(join(area,'worker-2.json'),JSON.stringify({...configBase,authorityEpoch:2}),{mode:0o600});
  await symlink(join(area,'worker-1.json'),join(area,'current-worker'));
  const wrapper=join(area,'rpc.sh');await writeFile(wrapper,`#!/bin/sh\nexec /usr/bin/python3 /usr/local/lib/agent-control/worker.py --config "$(readlink -f '${join(area,'current-worker')}')"\n`,{mode:0o755});
  const sshd=join(area,'sshd.conf');await writeFile(sshd,`Port 2222\nListenAddress 0.0.0.0\nHostKey /fixtures/host\nPidFile /tmp/sshd-t30.pid\nAuthorizedKeysFile /fixtures/authorized_keys\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nStrictModes yes\nAllowUsers node\nAllowTcpForwarding no\nPermitTTY no\nForceCommand ${wrapper}\nLogLevel ERROR\n`);
  const ledgerDir='/var/tmp/ac-resource-authority-'+process.getuid!(),installDir='/var/tmp/ac-resource-installation-'+sha(remoteAuthority.installationId),socketGid=await command('stat',['-c','%g','/var/run/docker.sock']);
  sshContainer=await command('docker',['run','-d','--name',scope+'-ssh','--label','ac.r3.disposable=t30','--label','ac.t30.scope='+scope,'--pid','host','--cgroupns','host','-p','127.0.0.1::2222','-v',area+':'+area,'-v',area+':/fixtures','-v',installed+':/usr/local/lib/agent-control:ro','-v','/var/run/docker.sock:/var/run/docker.sock','-v','/sys/fs/cgroup:/sys/fs/cgroup:ro','-v',ledgerDir+':'+ledgerDir,'-v',installDir+':'+installDir,'--entrypoint','/bin/sh','ac-r3-remote-ssh:20261105','-ec',`addgroup -g ${socketGid} acdocker; addgroup node acdocker; exec /usr/sbin/sshd -D -e -f ${sshd}`]);
  const port=Number((await command('docker',['port',sshContainer,'2222/tcp'])).split(':').at(-1)),publicKey=(await readFile(join(area,'host.pub'),'utf8')).trim(),fingerprint=(await command('ssh-keygen',['-lf',join(area,'host.pub'),'-E','sha256'])).split(/\s+/)[1]!;
  const host:RemoteHost={id:hostId,hostname:'127.0.0.1',port,username:'node',public_key:publicKey,fingerprint,credential_ref:credentialId,remote_root:project};
  const ssh=new OpenSshTransport(async id=>{assert.equal(id,credentialId);return join(area,'client');},new Set(['127.0.0.1']));
  try{await until(async()=>{try{return await ssh.exchange(host,{schemaVersion:1,action:'authority-status',operationId:randomUUID()});}catch{return undefined;}},20000);}
  catch(error){
   const logs=await exec('docker',['logs',sshContainer],{timeout:5000,maxBuffer:65536}).catch(e=>({stdout:e.stdout,stderr:e.stderr}));
   const state=await command('docker',['inspect','--format','{{.State.Status}} {{.State.ExitCode}}',sshContainer]).catch(e=>String(e));
   const debug=await new Promise<string>(resolve=>{const proc=spawn('/usr/bin/ssh',['-vvv','-i',join(area,'client'),'-p',String(port),'-o','BatchMode=yes','-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=/dev/null','node@127.0.0.1']);let output='';proc.stdout.on('data',b=>{output+=String(b);});proc.stderr.on('data',b=>{output+=String(b);});proc.once('close',()=>resolve(output));proc.stdin.end(JSON.stringify({schemaVersion:1,action:'authority-status',operationId:randomUUID()}));setTimeout(()=>proc.kill('SIGKILL'),5000).unref();});
   console.error('T30_SSH_FIXTURE_LOG '+state+' '+String(logs?.stdout??'').slice(-5000)+' '+String(logs?.stderr??'').slice(-5000)+' '+debug.slice(-5000));throw error;
  }
  await db.migrate();await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[projectId,'t30 disposable']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[projectId,principal]);await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  const context=await db.createContext(principal,projectId,randomUUID());await db.pause(principal,context,true);
  await new RemoteOperations(db,ssh).registerHost(principal,projectId,{id:hostId,label:'T30 synthetic SSH',hostname:host.hostname,port,username:host.username,publicKey,fingerprint,credentialRef:credentialId,remoteRoot:project,allowedTasks:['slow'],maxConcurrent:2});
  const sourceInstallation=(await db.pool.query('SELECT id FROM ac_installation_identity')).rows[0].id,catalogDir=join(area,'catalog');await mkdir(catalogDir,{mode:0o700});
  const nativeIdentity={installationId:native.installationId,authorityId:native.resourceAuthority.authorityId,anchorId:native.resourceAuthority.anchorId,stateRoot:native.stateRoot},sshIdentity={hostId,hostFingerprint:fingerprint,authorityId:remoteAuthority.resourceAuthority.authorityId,anchorId:remoteAuthority.resourceAuthority.anchorId,installationId:remoteAuthority.installationId,stateRoot:remoteAuthority.stateRoot};
  const authorities=[{kind:'native',id:native.resourceAuthority.authorityId+':'+native.stateRoot,identity:nativeIdentity},{kind:'ssh',id:hostId,identity:sshIdentity}];
  const module=resolve('services/recovery/catalog.py'),init=await command('/usr/bin/python3',['-c',"import importlib.util,json,sys;s=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps(m.initialize(sys.argv[2],sys.argv[3],json.loads(sys.argv[4]))))",module,catalogDir,sourceInstallation,JSON.stringify(authorities)]);
  const catalogId=JSON.parse(init).catalogId,manifestHash=createHash('sha256').update(await readFile(join(catalogDir,'manifest.json'))).digest('hex'),catalog={directory:catalogDir,installationId:sourceInstallation,catalogId,manifestHash,epoch:1};
  await db.pool.query('UPDATE ac_recovery_inventory_policy SET required=true,source_installation_id=$1,catalog_id=$2,manifest_hash=$3',[sourceInstallation,catalogId,manifestHash]);await configureRecoveryInventory(db,catalog);
  const admission=new Admission(db),revision=(await db.pool.query('SELECT revision FROM ac_admission_control WHERE id=1')).rows[0].revision,closed=await admission.set(principal,{enabled:false,expectedRevision:revision,reason:'t30-backup'});
  const history=join(area,'history.json'),vault=join(area,'vault.archive');await writeFile(history,'{}',{mode:0o600});await writeFile(vault,'synthetic vault',{mode:0o600});
  const backup=await backupLaboratoryDatabase({containerId:pgContainer,sourceUrl:fixture.url,directory:area,canonicalHistoryFile:history,vaultArchiveFile:vault,recoveryInventory:catalog});
  await admission.set(principal,{enabled:true,expectedRevision:closed.revision,reason:'t30-after-cut'});
  const ready=join(area,'controller-ready.json'),controllerConfig=join(area,'controller.json');await writeFile(controllerConfig,JSON.stringify({url:fixture.url,catalog,principal,context,hostId,credentialId,credential:join(area,'client'),native,project,image,ready}),{mode:0o600});
  child=spawn(process.execPath,['--import','tsx','tests/fixtures/r5-recovery-controller.ts',controllerConfig],{cwd:process.cwd(),stdio:['ignore','ignore','pipe']});let childError='';child.stderr!.on('data',b=>{childError+=String(b);});
  const started=await until(async()=>{if(child!.exitCode!==null)throw Error('T30_CONTROLLER_FAILED '+childError);try{return JSON.parse(await readFile(ready,'utf8'));}catch{return undefined;}},30000);
  const inspect={schemaVersion:1,action:'inspect',operationId:started.remoteId};const sshRun=await until(async()=>{try{const r=await ssh.exchange(host,inspect) as any;return r.stableGroup?.id?r:undefined;}catch{return undefined;}},20000);
  await until(async()=>{try{const a=await lstat(join(project,'native-writes')),b=await lstat(join(project,'ssh-writes'));return a.size>0&&b.size>0?true:undefined;}catch{return undefined;}},20000);
  child.kill('SIGKILL');await once(child,'exit');child=undefined;
  const sizeBefore=(await lstat(join(project,'native-writes'))).size;await new Promise(r=>setTimeout(r,200));assert.ok((await lstat(join(project,'native-writes'))).size>sizeBefore);
  const recovery=await restoreLaboratoryDatabase({containerId:pgContainer,sourceUrl:fixture.url,...backup,directory:area});targetDatabase=recovery.database;restored=new Ledger(recovery.url);
  assert.ok(recovery.catalogCheckpoint);assert.equal((await restored.pool.query('SELECT paused FROM ac_contexts WHERE id=$1',[context])).rows[0].paused,true);assert.equal((await restored.pool.query('SELECT enabled FROM ac_admission_control WHERE id=1')).rows[0].enabled,false);
  await unlink(join(area,'current-worker'));await symlink(join(area,'worker-2.json'),join(area,'current-worker'));
  recoveryId=randomUUID();const nativeNext=new NativeResourceDockerDaemon({...native,authorityEpoch:2}),args={ledger:restored,principal,config:catalog,recoveryId,native:new Map([[authorities[0]!.id,nativeNext]]),ssh:new Map([[hostId,{host,transport:ssh}]])};
  await assert.rejects(sweepRestoredPhysicalInventory({...args,ssh:new Map()}),/RECOVERY_PHYSICAL_SCOPE_INCOMPLETE/);assert.equal((await restored.pool.query('SELECT enabled FROM ac_admission_control WHERE id=1')).rows[0].enabled,false);
  await ssh.exchange(host,{schemaVersion:1,action:'recovery-authority',operationId:randomUUID(),recoveryToken:recoveryId});await new Promise(r=>setTimeout(r,1000));
  // Hold the actual PG gate so both host holds/sweeps complete but CAS waits.
  const blocker=await restored.pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT id FROM ac_admission_control WHERE id=1 FOR UPDATE');
  let firstFinished=false;const first=sweepRestoredPhysicalInventory(args).then(value=>{firstFinished=true;return {value};},error=>{firstFinished=true;return {error};});
  try{
   await until(async()=>{if(firstFinished)throw Error('T30_SWEEP_ENDED_BEFORE_CAS');const q=await restored!.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM ac_admission_control WHERE id=1 FOR UPDATE%' AND pid<>pg_backend_pid()");return q.rowCount?true:undefined;},30000);
   const helper=await ownCatalogHelper();process.kill(helper,'SIGKILL');await until(async()=>{try{await lstat('/proc/'+helper);return undefined;}catch{return true;}},5000);
   await assert.rejects(nativeNext.inspect(started.nativeId),/RECOVERY_RESOURCE_HOLD/);
   await assert.rejects(ssh.exchange(host,{schemaVersion:1,action:'authority-status',operationId:randomUUID()}));
  }finally{await blocker.query('ROLLBACK');blocker.release();}
  assert.ok('error' in await first);assert.equal((await restored.pool.query('SELECT enabled FROM ac_admission_control WHERE id=1')).rows[0].enabled,false);
  // Repeat with a host lock held after sweep, then kill helper after CAS.
  const secondBlocker=await restored.pool.connect();await secondBlocker.query('BEGIN');await secondBlocker.query('SELECT id FROM ac_admission_control WHERE id=1 FOR UPDATE');
  let secondFinished=false;const second=sweepRestoredPhysicalInventory(args).then(value=>{secondFinished=true;return {value};},error=>{secondFinished=true;return {error};});
  try{
   await until(async()=>{if(secondFinished)throw Error('T30_SWEEP_ENDED_BEFORE_CAS');const q=await restored!.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM ac_admission_control WHERE id=1 FOR UPDATE%' AND pid<>pg_backend_pid()");return q.rowCount?true:undefined;},30000);
   const lockPath=join('/var/tmp/ac-resource-authority-'+process.getuid!(),sha(native.resourceAuthority.authorityId)+'.json');
   holdLocker=spawn('/usr/bin/python3',['-c',"import fcntl,sys; f=open(sys.argv[1],'r+'); fcntl.flock(f,fcntl.LOCK_EX); print('READY',flush=True); sys.stdin.buffer.read()",lockPath],{stdio:['pipe','pipe','pipe']});
   await until(async()=>{if(holdLocker!.exitCode!==null)throw Error('T30_LOCKER_FAILED');return await new Promise<true|undefined>(resolve=>{holdLocker!.stdout!.once('data',()=>resolve(true));setTimeout(()=>resolve(undefined),200).unref();});},5000);
  }finally{await secondBlocker.query('ROLLBACK');secondBlocker.release();}
  await until(async()=>{const row=(await restored!.pool.query('SELECT enabled FROM ac_admission_control WHERE id=1')).rows[0];return row.enabled?true:undefined;},10000);
  process.kill(await ownCatalogHelper(),'SIGKILL');
  const secondResult=await second;if('error' in secondResult)throw secondResult.error;assert.equal(secondResult.value.state,'reconciled-host-release-pending');
  assert.ok(secondResult.value.pending.includes('native:'+authorities[0]!.id));
  holdLocker.stdin!.end();await once(holdLocker,'exit');holdLocker=undefined;
  await assert.rejects(nativeNext.inspect(started.nativeId),/RECOVERY_RESOURCE_HOLD/);
  assert.equal((await releaseRestoredPhysicalHolds(args)).state,'released');
  const outcome=secondResult.value;assert.equal((await restored.pool.query('SELECT paused FROM ac_contexts WHERE id=$1',[context])).rows[0].paused,true);
  assert.equal((await restored.pool.query('SELECT count(*)::integer n FROM ac_remote_operations')).rows[0].n,0);
  await assert.rejects(new NativeResourceDockerDaemon(native).inspect(started.nativeId));
  await assert.rejects(ssh.exchange(host,{schemaVersion:1,action:'start',operationId:randomUUID(),projectId,taskId:'slow',root:project,epoch:1,recoveryEpoch:1}));
  await assert.rejects(exec('docker',['inspect',started.nativeId]));await assert.rejects(exec('docker',['inspect',sshRun.stableGroup.id]));
  const n=(await lstat(join(project,'native-writes'))).size,s=(await lstat(join(project,'ssh-writes'))).size;await new Promise(r=>setTimeout(r,250));assert.equal((await lstat(join(project,'native-writes'))).size,n);assert.equal((await lstat(join(project,'ssh-writes'))).size,s);
  const resumed=await restored.acquire(principal,context,randomUUID(),'t30-restored',60),intentId=randomUUID(),attempt=randomUUID();
  const admissionCommand={schemaVersion:1 as const,intentId,deliveryAttemptId:attempt,contextId:context,policyRevision:1,action:'plan.start' as const,payload:{workflow:'baseline-synthetic-v1' as const,messageRef:'encrypted:t30-new'}};
  await assert.rejects(restored.accept(principal,admissionCommand,resumed,'api'),/HUMAN_PAUSED/);await restored.pause(principal,context,false);
  await restored.accept(principal,admissionCommand,resumed,'api');await restored.accept(principal,admissionCommand,resumed,'api');
  assert.equal((await restored.pool.query('SELECT count(*)::integer n FROM ac_intents WHERE id=$1',[intentId])).rows[0].n,1);
  console.log('T30_PHYSICAL '+JSON.stringify({scope,sourceInstallation,recoveryInstallation:recovery.installationId,nativeId:started.nativeId,sshId:sshRun.stableGroup.id,epoch:outcome.epoch,paused:true,admission:'open',postCutLedgerRows:0}));
 }finally{
  if(child&&child.exitCode===null){child.kill('SIGKILL');await once(child,'exit').catch(()=>{});}
  if(holdLocker&&holdLocker.exitCode===null){holdLocker.kill('SIGKILL');await once(holdLocker,'exit').catch(()=>{});}
  await restored?.close();if(targetDatabase){const admin=new pg.Client({connectionString:base});await admin.connect();try{await admin.query(`DROP DATABASE "${targetDatabase}"`);}finally{await admin.end();}}
  await db.close();await fixture.close();
  if(sshContainer){const info=JSON.parse(await command('docker',['inspect',sshContainer]))[0];assert.equal(info.Config.Labels['ac.t30.scope'],scope);await command('docker',['rm','-f',sshContainer]);}
  for(const [envelope,root] of [[native,nativeArea],[remoteAuthority,sshArea]] as const)if(envelope){
   await retireFlowResources(envelope,root);
   if(recoveryId){const path=join('/var/tmp/ac-resource-authority-'+process.getuid!(),'recovery-sweep-'+sha(envelope.resourceAuthority.authorityId+'\0'+recoveryId)+'.json');try{const info=await lstat(path);assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.uid===process.getuid!()&&info.nlink===1);await rm(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  }
  await rm(area,{recursive:true,force:true});
 }
});
