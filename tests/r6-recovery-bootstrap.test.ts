import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {bootstrapRecoveryInventory} from '../src/recovery-bootstrap.ts';
import {requireRecoveryInventory} from '../src/recovery-inventory.ts';
import type {Ledger} from '../src/ledger.ts';

test('bootstrap requires an exact pre-provisioned catalog and attaches its capability',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ac-r6-bootstrap-')),source=randomUUID();
 try{
  const init=await promisify(execFile)('/usr/bin/python3',['-c',`import importlib.util,sys,json\ns=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nprint(json.dumps(m.initialize(sys.argv[2],sys.argv[3],[{'kind':'native','id':'fixture','identity':{'fixture':'synthetic'}}])))`,resolve('services/recovery/catalog.py'),directory,source]);
  const catalogId=JSON.parse(init.stdout).catalogId,manifestHash=createHash('sha256').update(await readFile(join(directory,'manifest.json'))).digest('hex');
  const policy={required:true,source_installation_id:source,catalog_id:catalogId,manifest_hash:manifestHash};
  const query=async()=>({rows:[policy]});const ledger={pool:{query}} as unknown as Ledger;
  const config={directory,installationId:source,catalogId,manifestHash,epoch:1};
  await assert.rejects(bootstrapRecoveryInventory(ledger),/RECOVERY_INVENTORY_REQUIRED/);
  await assert.rejects(bootstrapRecoveryInventory(ledger,{...config,epoch:2}),/CATALOG_UNCERTAIN/);
  await assert.rejects(bootstrapRecoveryInventory(ledger,{...config,manifestHash:'0'.repeat(64)}),/CATALOG_UNCERTAIN/);
  assert.equal(await requireRecoveryInventory({query} as never,ledger).catch(e=>e.code), 'RECOVERY_INVENTORY_REQUIRED');
  await bootstrapRecoveryInventory(ledger,config);
  assert.equal((await requireRecoveryInventory({query} as never,ledger))?.config.catalogId,catalogId);
 }finally{await rm(directory,{recursive:true,force:true});}
});
