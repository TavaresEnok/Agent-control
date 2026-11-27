import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,lstat,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {addSimpleWorktree,worktreeGit} from '../src/simple-worktree.ts';
import {NativeQa} from '../src/native-qa.ts';

test('two reconciles of one QA job never run at the same time; other jobs are not held up',async()=>{
 const qa=Object.create(NativeQa.prototype) as any;
 Object.defineProperty(qa,'reconciling',{value:new Map()});
 let active=0,peak=0;const order:string[]=[];
 qa.reconcileOnce=async(_p:string,_a:unknown,id:string)=>{
  active++;peak=Math.max(peak,active);order.push('start:'+id);
  await new Promise(resolve=>setTimeout(resolve,20));
  active--;order.push('end:'+id);
  if(id==='bad')throw Error('boom');
  return {state:'running'};
 };
 const authority={} as any;
 const results=await Promise.allSettled([qa.reconcile('p',authority,'job'),qa.reconcile('p',authority,'job'),qa.reconcile('p',authority,'job')]);
 assert.equal(peak,1);
 assert.deepEqual(results.map(r=>r.status),['fulfilled','fulfilled','fulfilled']);
 assert.equal(qa.reconciling.size,0);
 // A failure is reported to its caller and does not block the next reconcile of that job.
 await assert.rejects(qa.reconcile('p',authority,'bad'));
 assert.deepEqual(await qa.reconcile('p',authority,'job'),{state:'running'});
 // Different jobs may overlap.
 active=0;peak=0;
 await Promise.all([qa.reconcile('p',authority,'x'),qa.reconcile('p',authority,'y')]);
 assert.equal(peak,2);
});

test('eight terminal reconciliations remove one QA worktree and replay after its removal',async()=>{
 const area=await mkdtemp(join(tmpdir(),'ac-qa-serial-')),id=randomUUID(),repo=join(area,'repo'),work=join(area,id,'work');
 const ledger=new Ledger(process.env.AC_TEST_DATABASE_URL!);
 try{
  await mkdir(repo);await mkdir(join(area,id));
  await worktreeGit(repo,['init','-q']);await writeFile(join(repo,'base'),'fixture');
  await worktreeGit(repo,['add','.']);await worktreeGit(repo,['commit','-qm','base']);
  await addSimpleWorktree(repo,(await worktreeGit(repo,['rev-parse','HEAD'])).trim(),work);
  const runners=Array.from({length:2},()=>Object.assign(Object.create(NativeQa.prototype),{
   simple:true,ledger,root:area,repository:repo,reconciling:new Map(),reconcileOnce:async()=>({state:'completed'}),
  }));
  const results=await Promise.all(Array.from({length:8},(_,i)=>runners[i%2].reconcile('owner',{},id)));
  for(const result of results)assert.equal(result.state,'completed');
  await assert.rejects(lstat(work),{code:'ENOENT'});
  assert.deepEqual(await runners[0].reconcile('owner',{},id),{state:'completed'});
  assert.equal((await worktreeGit(repo,['worktree','list','--porcelain'])).match(/^worktree /gm)?.length,1);
 }finally{await ledger.close();await rm(area,{recursive:true,force:true});}
});
