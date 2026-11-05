import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
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
