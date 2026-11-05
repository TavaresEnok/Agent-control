import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {requireRecoveryInventory} from '../src/recovery-inventory.ts';
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
