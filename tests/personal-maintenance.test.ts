import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {nativeExecutionExecutorDigest} from '../src/native-execution-contract.ts';
import {retiredPlan} from '../src/personal-maintenance.ts';
import {newestBackup} from '../src/personal-restore-proof.ts';

const image=(c:string)=>'sha256:'+c.repeat(64);

test('a retired image leaves only when no job needs it and nothing current uses it',()=>{
 const boot={planning:{imageId:image('a'),retiredImageIds:[image('b'),image('c')]},
  execution:{workerImage:image('d'),toolsImage:image('e'),retiredImages:[{workerImage:image('f'),toolsImage:image('e')},{workerImage:image('1'),toolsImage:image('2')}]},qa:{image:image('e')}};
 const open=new Map([[nativeExecutionExecutorDigest(image('f'),image('e')),0],[nativeExecutionExecutorDigest(image('1'),image('2')),3]]);
 const plan=retiredPlan(boot,open,0);
 assert.deepEqual(plan.dropPairs,[{workerImage:image('f'),toolsImage:image('e')}]);
 assert.deepEqual(plan.keepPairs,[{workerImage:image('1'),toolsImage:image('2')}]);
 assert.deepEqual(plan.dropPlanning,[image('b'),image('c')]);
 // The shared tools image is still current, so only the old worker goes.
 assert.deepEqual(plan.removable.sort(),[image('b'),image('c'),image('f')].sort());
 const busy=retiredPlan(boot,new Map(),2);
 assert.deepEqual(busy.dropPairs,[]);assert.deepEqual(busy.dropPlanning,[]);assert.deepEqual(busy.removable,[]);
});

test('the restore proof picks the newest dated backup',async()=>{
 const root=await mkdtemp(join(tmpdir(),'restore-proof-'));
 try{
  for(const day of ['20261114-033007','20261116-033007','20261115-033007']){
   await mkdir(join(root,day,`agent-control-ispagent-${day.slice(0,13)}`),{recursive:true});
  }
  await mkdir(join(root,'not-a-backup'));await writeFile(join(root,'20991231-000000'),'file');
  assert.equal(await newestBackup(root),join(root,'20261116-033007','agent-control-ispagent-20261116-0330'));
 }finally{await rm(root,{recursive:true,force:true});}
});
