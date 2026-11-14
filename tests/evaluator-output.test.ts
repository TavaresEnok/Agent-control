import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isJsonObject,runWithVerdictRetry} from '../src/evaluator-output.ts';

const verdict='{"kind":"review","verdict":"pass","findings":[]}';
// The exact slip Opus made: a stray bracket after "base".
const slipped='{"kind":"review","base":"b846d86"],"verdict":"pass","findings":[]}';

test('an evaluator verdict with a typo is asked for once more',async()=>{
 assert.equal(isJsonObject(verdict),true);assert.equal(isJsonObject(slipped),false);assert.equal(isJsonObject('[1]'),false);
 const outputs=[slipped,verdict];let calls=0;
 const ran=await runWithVerdictRetry(true,()=>false,async()=>({result:{output:outputs[calls++]!},failure:null}));
 assert.equal(calls,2);assert.equal(ran.result.output,verdict);
});

test('the retry happens once, never for programmers, failures or a stopped job',async()=>{
 let calls=0;const bad=async()=>{calls++;return {result:{output:slipped},failure:null};};
 assert.equal((await runWithVerdictRetry(true,()=>false,bad)).result.output,slipped);assert.equal(calls,2);
 calls=0;await runWithVerdictRetry(false,()=>false,bad);assert.equal(calls,1);
 calls=0;await runWithVerdictRetry(true,()=>true,bad);assert.equal(calls,1);
 calls=0;await runWithVerdictRetry(true,()=>false,async()=>{calls++;return {result:{output:''},failure:'PROVIDER_USAGE_LIMIT'};});assert.equal(calls,1);
});
