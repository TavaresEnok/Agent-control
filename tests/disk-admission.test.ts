import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,statfs,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DiskAdmissionGuard,diskPolicyFromEnvironment} from '../src/disk-admission.ts';
import {IsolatedVerification} from '../src/isolated-verification.ts';
import {SandboxClient} from '../src/sandbox-client.ts';
import type {Ledger} from '../src/ledger.ts';

test('fresh disk pressure refuses a verification before any DB transition or broker command',async()=>{
 const path=await mkdtemp(join(tmpdir(),'ac-disk-'));let calls=0;
 class NoLaunch extends SandboxClient{override async perform(){calls++;throw Error('MUST_NOT_LAUNCH');}}
 const ledger={tx:async()=>{throw Error('MUST_NOT_MUTATE');}} as unknown as Ledger;
 try{
  const fs=await statfs(path,{bigint:true}),free=Number(fs.bavail*fs.bsize);
  const guard=new DiskAdmissionGuard({schemaVersion:1,paths:[path],minFreeBytes:free+1024**2,estimatedWriteBytes:1024**2});
  const verification=new IsolatedVerification(ledger,new NoLaunch(),guard),artifact={id:randomUUID(),commit:'a'.repeat(40),tree:'b'.repeat(40),base:'c'.repeat(40)};
  await assert.rejects(verification.run('synthetic',randomUUID(),randomUUID(),{contextId:randomUUID(),instanceId:randomUUID(),epoch:1},'/not-an-existing-project',artifact,randomUUID(),'qa','d'.repeat(64),()=>false),/STORAGE_LOW_SPACE/);
  assert.equal(calls,0);verification.close();
  const link=path+'-link';await symlink(path,link);
  try{await assert.rejects(new DiskAdmissionGuard({schemaVersion:1,paths:[link],minFreeBytes:0,estimatedWriteBytes:1}).assertAdmission(),/DISK_PATH_UNSAFE/);}finally{await rm(link);}
  assert.equal(diskPolicyFromEnvironment({}),undefined);
  assert.throws(()=>diskPolicyFromEnvironment({AC_DISK_ADMISSION_POLICY:'{"schemaVersion":1,"paths":["relative"],"minFreeBytes":0,"estimatedWriteBytes":1}'}),/DISK_POLICY_INVALID/);
 }finally{await rm(path,{recursive:true,force:true});}
});
