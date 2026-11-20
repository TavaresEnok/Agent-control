import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertDiskSpaceForLaunch, usedDiskPercent} from '../src/personal-disk.ts';
import {diskNotice} from '../src/personal-health.ts';

test('limites do volume consideram os blocos reservados e permitem retomar assim que há espaço', async () => {
  assert.equal(usedDiskPercent({blocks:1100,bfree:150,bavail:50}),95);
  assert.equal(diskNotice(89.99),null);
  assert.ok(diskNotice(90));
  assert.match(diskNotice(95)!.text,/bloqueados/);
  await assert.rejects(assertDiskSpaceForLaunch('/',async()=>95),{code:'PERSONAL_DISK_FULL'});
  await assert.rejects(assertDiskSpaceForLaunch('/',async()=>100),{code:'PERSONAL_DISK_FULL'});
  await assertDiskSpaceForLaunch('/',async()=>94.99);
  assert.throws(()=>usedDiskPercent({blocks:0,bfree:0,bavail:0}),{code:'PERSONAL_DISK_UNAVAILABLE'});
});
