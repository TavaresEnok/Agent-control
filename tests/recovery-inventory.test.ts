import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Ledger} from '../src/ledger.ts';
import {requireRecoveryInventory,configureRecoveryInventory,beginRestoredPhysicalRecovery} from '../src/recovery-inventory.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {sweepRestoredPhysicalInventory} from '../src/recovery-physical-sweep.ts';
import {OpenSshTransport,type RemoteHost} from '../src/remote.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('enforced recovery policy requires a bootstrap capability before any guarded effect',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'inventory'),db=new Ledger(fixture.url);
 try{
  await db.migrate();assert.equal(await db.tx(c=>requireRecoveryInventory(c,db)),undefined);
  await db.pool.query('UPDATE ac_recovery_inventory_policy SET required=true,source_installation_id=$1,catalog_id=$2,manifest_hash=$3',[randomUUID(),randomUUID(),'a'.repeat(64)]);
  await assert.rejects(db.tx(c=>requireRecoveryInventory(c,db)),/RECOVERY_INVENTORY_REQUIRED/);
 }finally{await db.close();await fixture.close();}
});

test('restored recovery records request before an idempotent epoch advance',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'inventoryresume'),db=new Ledger(fixture.url),directory=await mkdtemp(join(tmpdir(),'ac-t30-restore-'));
 const source=randomUUID(),recoveryId=randomUUID(),module=resolve('services/recovery/catalog.py');
 try{
  const init=await promisify(execFile)('/usr/bin/python3',['-c',`import importlib.util,sys,json\ns=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nx=m.initialize(sys.argv[2],sys.argv[3],[{'kind':'ssh','id':'fixture','identity':{'hostKey':'fixture'}}])\nwith m.Catalog(sys.argv[2],sys.argv[3],x['catalogId']) as c: print(json.dumps(c.checkpoint()))`,module,directory,source]);
  const checkpoint=JSON.parse(init.stdout),manifestHash=createHash('sha256').update(await readFile(join(directory,'manifest.json'))).digest('hex');
  await db.migrate();const installation=(await db.pool.query('SELECT id FROM ac_installation_identity')).rows[0].id;
  await db.pool.query('UPDATE ac_recovery_inventory_policy SET required=true,source_installation_id=$1,catalog_id=$2,manifest_hash=$3',[source,checkpoint.catalogId,manifestHash]);
  await db.pool.query("UPDATE ac_admission_control SET enabled=false,reason='r3-restored-awaiting-reconciliation' WHERE id=1");
  await db.pool.query("INSERT INTO ac_recovery_inventory_restores(installation_id,source_installation_id,checkpoint,state) VALUES($1,$2,$3,'physical-reconciliation-required')",[installation,source,checkpoint]);
  const config={directory,installationId:source,catalogId:checkpoint.catalogId,manifestHash,epoch:1};
  await configureRecoveryInventory(db,config);
  const runtime=new CezarRuntime(db,directory,randomUUID());
  try{await assert.rejects(runtime.start('execution'),/RECOVERY_EFFECT_NOT_INSTRUMENTED/);}finally{await runtime.close();}
  assert.equal((await beginRestoredPhysicalRecovery(db,config,recoveryId)).epoch,2);
  await assert.rejects(sweepRestoredPhysicalInventory({ledger:db,principal:'synthetic-admin',config,recoveryId,native:new Map(),ssh:new Map()}),/RECOVERY_PHYSICAL_SCOPE_INCOMPLETE/);
  const forged=Object.create(OpenSshTransport.prototype) as OpenSshTransport;
  await assert.rejects(sweepRestoredPhysicalInventory({ledger:db,principal:'synthetic-admin',config,recoveryId,native:new Map(),ssh:new Map([['fixture',{host:{id:'fixture'} as RemoteHost,transport:forged}]])}),/RECOVERY_PHYSICAL_IDENTITY_MISMATCH/);
  assert.equal((await db.pool.query('SELECT enabled FROM ac_admission_control WHERE id=1')).rows[0].enabled,false);
  assert.equal((await beginRestoredPhysicalRecovery(db,config,recoveryId)).epoch,2);
  await assert.rejects(beginRestoredPhysicalRecovery(db,config,randomUUID()),/CATALOG_RECOVERY_CONFLICT/);
  const state=(await db.pool.query('SELECT recovery_id,source_epoch,recovery_epoch FROM ac_recovery_inventory_restores WHERE installation_id=$1',[installation])).rows[0];
  assert.deepEqual(state,{recovery_id:recoveryId,source_epoch:1,recovery_epoch:2});
 }finally{await db.close();await fixture.close();await rm(directory,{recursive:true,force:true});}
});
