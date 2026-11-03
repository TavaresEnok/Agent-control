import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,statfs,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DiskAdmissionGuard,diskPolicyFromEnvironment,explainDiskAdmission,requiredFreeBytes} from '../src/disk-admission.ts';
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

test('low space returns an explicit refusal and does not delete the marker',async()=>{
 const path=await mkdtemp(join(tmpdir(),'ac-disk-reason-'));
 const marker=join(path,'keep.txt');
 await writeFile(marker,'retain');
 try{
  const measured=await statfs(path,{bigint:true}),free=measured.bavail*measured.bsize;
  const guard=new DiskAdmissionGuard({schemaVersion:1,paths:[path],minFreeBytes:1024,estimatedWriteBytes:1024});
  const refused=await guard.assess(free);
  const expected=explainDiskAdmission(refused.availableBytes,requiredFreeBytes(1024,1024,free));
  assert.equal(refused.admitted,false);
  assert.equal(refused.code,'STORAGE_LOW_SPACE');
  assert.equal(refused.reason,expected.reason);
  assert.match(refused.reason,/New work is refused/);
  assert.match(refused.reason,/does not delete/);
  await assert.rejects(guard.assertAdmission(free),/STORAGE_LOW_SPACE/);
  assert.equal(await readFile(marker,'utf8'),'retain');
  const open=await new DiskAdmissionGuard({schemaVersion:1,paths:[path],minFreeBytes:1,estimatedWriteBytes:1}).assess(0n);
  assert.equal(open.admitted,open.availableBytes>=open.requiredBytes);
  assert.equal(open.reason,explainDiskAdmission(open.availableBytes,open.requiredBytes).reason);
  assert.equal(requiredFreeBytes(5,7,3n),15n);
  assert.throws(()=>requiredFreeBytes(1,1,-1n),/DISK_RESERVATION_INVALID/);
  assert.throws(()=>explainDiskAdmission(-1n,1n),/DISK_OBSERVATION_UNAVAILABLE/);
 }finally{await rm(path,{recursive:true,force:true});}
});
