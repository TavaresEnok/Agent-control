import assert from 'node:assert/strict';
import {test} from 'node:test';
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
