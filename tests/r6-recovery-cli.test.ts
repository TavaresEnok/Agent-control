import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm,readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {bootstrapRecoveryInventory} from '../src/recovery-bootstrap.ts';
import {executeRecoveryCommand,RecoveryCommandDescriptor} from '../src/recovery-cli.ts';
import type {Installation} from '../src/installation.ts';
import type {Ledger} from '../src/ledger.ts';

test('recovery CLI requires explicit private descriptor, catalog and local admin before physical work',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ac-r6-cli-')),file=join(dir,'request.json');
 const request={operation:'sweep',principal:'fixture',recoveryId:randomUUID(),native:[],ssh:[]};
 const config={databaseUrl:'postgresql://localhost/fixture',recoveryInventory:{directory:dir,installationId:randomUUID(),catalogId:randomUUID(),manifestHash:'a'.repeat(64),epoch:1}} as Installation;
 let calls=0;const ledger={pool:{query:async()=>{calls++;return {rowCount:0};}}} as unknown as Ledger;
 try{
  await writeFile(file,JSON.stringify(request),{mode:0o600});
  await assert.rejects(executeRecoveryCommand({...config,recoveryInventory:undefined},ledger,file),/RECOVERY_INVENTORY_REQUIRED/);assert.equal(calls,0);
  await assert.rejects(executeRecoveryCommand(config,ledger,file),/CONTROL_ADMIN_REQUIRED/);assert.equal(calls,1);
  await chmod(file,0o644);await assert.rejects(executeRecoveryCommand(config,ledger,file),/UNSAFE_PRIVATE_FILE/);assert.equal(calls,1);
  assert.equal(RecoveryCommandDescriptor.safeParse({...request,operation:'restore'}).success,false);
  assert.equal(RecoveryCommandDescriptor.safeParse({...request,extra:true}).success,false);
  assert.equal(RecoveryCommandDescriptor.safeParse({operation:'backup-laboratory',containerId:'x',directory:dir,canonicalHistoryFile:'/history',vaultArchiveFile:'/vault'}).success,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('recovery CLI consults the actual admin table before accepting adapters',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const {isolatedDatabase}=await import('./fixtures/isolated-database.ts');const {Ledger}=await import('../src/ledger.ts');
 const fixture=await isolatedDatabase(base,'r6cli'),ledger=new Ledger(fixture.url),dir=await mkdtemp(join(tmpdir(),'ac-r6-cli-pg-')),file=join(dir,'request.json');
 const principal='synthetic-'+randomUUID(),request={operation:'sweep',principal,recoveryId:randomUUID(),native:[{stateRoot:'/fixture',installationId:'fixture',authorityEpoch:3,resourceAuthority:{authorityId:'ac-r3-resources-fixture',anchorId:'a'.repeat(64),cpuQuotaMicros:1000,cpuPeriodMicros:1000,memoryBytes:16777216,pidsLimit:4,maxJobs:1}}],ssh:[]};
 const config={databaseUrl:fixture.url,recoveryInventory:{directory:dir,installationId:randomUUID(),catalogId:randomUUID(),manifestHash:'a'.repeat(64),epoch:1}} as Installation;
 try{
  await ledger.migrate();await writeFile(file,JSON.stringify(request),{mode:0o600});
  const init=await promisify(execFile)('/usr/bin/python3',['-c',`import importlib.util,sys,json\ns=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nprint(json.dumps(m.initialize(sys.argv[2],sys.argv[3],[{'kind':'native','id':'fixture','identity':{'fixture':'synthetic'}}])))`,resolve('services/recovery/catalog.py'),dir,config.recoveryInventory!.installationId]);
  config.recoveryInventory!.catalogId=JSON.parse(init.stdout).catalogId;
  config.recoveryInventory!.manifestHash=createHash('sha256').update(await readFile(join(dir,'manifest.json'))).digest('hex');
  await ledger.pool.query('UPDATE ac_recovery_inventory_policy SET required=true,source_installation_id=$1,catalog_id=$2,manifest_hash=$3',[config.recoveryInventory!.installationId,config.recoveryInventory!.catalogId,config.recoveryInventory!.manifestHash]);
  await assert.rejects(bootstrapRecoveryInventory(ledger,{...config.recoveryInventory!,manifestHash:'0'.repeat(64)}),/CATALOG_UNCERTAIN/);
  await bootstrapRecoveryInventory(ledger,config.recoveryInventory);

  await assert.rejects(executeRecoveryCommand(config,ledger,file),/CONTROL_ADMIN_REQUIRED/);
  const installFile=join(dir,'installation.json');
  await writeFile(installFile,JSON.stringify({...config,schemaVersion:1,mode:'administration-only',dataDirectory:join(dir,'state'),project:{id:randomUUID(),label:'fixture',repo:join(dir,'repo'),owner:principal},http:{listen:'127.0.0.1',port:18405,publicOrigin:'http://127.0.0.1:18405'},happier:{upstreamOrigin:'http://127.0.0.1:18401',webOrigin:'http://127.0.0.1:18400',publicServerOrigin:'http://127.0.0.1:18401'}}),{mode:0o600});
  const cli=()=>promisify(execFile)(process.execPath,['--import','tsx','src/server-main.ts','recovery',installFile,file]);
  await assert.rejects(cli(),(error:any)=>error.code===1&&error.stderr.includes('INSTALLATION_COMMAND_FAILED'));
  await ledger.pool.query('INSERT INTO ac_control_admins(principal_id) VALUES($1)',[principal]);
  await assert.rejects(executeRecoveryCommand(config,ledger,file),/RECOVERY_PHYSICAL_EPOCH_MISMATCH/);
  await assert.rejects(cli(),(error:any)=>error.code===1&&error.stderr.includes('INSTALLATION_COMMAND_FAILED'));
  assert.equal((await ledger.pool.query('SELECT count(*)::int AS n FROM ac_recovery_inventory_restores')).rows[0].n,0);
 }finally{await ledger.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
