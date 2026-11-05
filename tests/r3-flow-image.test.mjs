import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildFlowImage} from '../scripts/r3-flow-build-image.mjs';

test('flow image builder refuses missing pins, mismatched ELF bytes and symlinks before running build tools',async()=>{
 const area=await mkdtemp(join(tmpdir(),'ac-r3-flow-image-refusal-'));let commands=0;
 const input={root:area,scratch:area,project:'ac-r3-flow-image-refusal',run:()=>{commands++;throw Error('UNAUTHORIZED_BUILD');}};
 try{
  await assert.rejects(buildFlowImage(input),/R3_FLOW_PINNED_PUBLIC_CODEX_REQUIRED/);
  const binary=join(area,'public-elf-fixture');await writeFile(binary,Buffer.from([127,69,76,70,0,1,2,3]),{mode:0o555});
  await assert.rejects(buildFlowImage({...input,publicBinary:binary,expectedSha256:'0'.repeat(64)}),/R3_FLOW_PUBLIC_CODEX_DIGEST_MISMATCH/);
  const link=join(area,'linked-elf');await symlink(binary,link);
  await assert.rejects(buildFlowImage({...input,publicBinary:link,expectedSha256:'0'.repeat(64)}),/R3_FLOW_PUBLIC_CODEX_INVALID/);
  assert.equal(commands,0);
 }finally{await rm(area,{recursive:true,force:true});}
});
