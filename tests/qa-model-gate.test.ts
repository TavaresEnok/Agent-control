import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {nativeReviewOutputSchema} from '../src/native-review-contract.ts';
import {QA_MODEL_INSTRUCTION,continueAfterScriptQa,parseQaModelVerdict,qaLogTail,qaModelExecutionRequest,qaModelShouldRun} from '../src/qa-model.ts';

test('the QA model runs only after the script passes and the combo names one',()=>{
 assert.equal(qaModelShouldRun('passed',true),true);
 assert.equal(qaModelShouldRun('failed',true),false);
 assert.equal(qaModelShouldRun('canceled',true),false);
 assert.equal(qaModelShouldRun('missing_result',true),false);
 assert.equal(qaModelShouldRun('passed',false),false);
 assert.equal(qaModelShouldRun('passed',undefined),false);
 assert.equal(qaModelShouldRun(undefined,true),false);
});

test('evaluator is skipped when the script fails or the combo has no QA model',async()=>{
 const calls:string[]=[];
 const evaluate=async()=>{calls.push('evaluate');};
 const record=async()=>{calls.push('record');return 'recorded';};
 await continueAfterScriptQa({scriptState:'failed',scriptStatus:'failed',qaModel:true,evaluate,record});
 await continueAfterScriptQa({scriptState:'completed',scriptStatus:'passed',qaModel:false,evaluate,record});
 await continueAfterScriptQa({scriptState:'completed',scriptStatus:'passed',qaModel:undefined,evaluate,record});
 await continueAfterScriptQa({scriptState:'completed',scriptStatus:'canceled',qaModel:true,evaluate,record});
 assert.deepEqual(calls,['record','record','record','record']);
 calls.length=0;
 await continueAfterScriptQa({scriptState:'completed',scriptStatus:'passed',qaModel:true,evaluate,record});
 assert.deepEqual(calls,['evaluate','record']);
});

test('a model rejection does not record the script result',async()=>{
 await assert.rejects(continueAfterScriptQa({scriptState:'completed',scriptStatus:'passed',qaModel:true,evaluate:async()=>{throw new Refusal('QA_MODEL_REJECTED');},record:async()=>{throw new Error('recorded');}}),(error:unknown)=>error instanceof Refusal&&error.code==='QA_MODEL_REJECTED');
});

test('fail maps to the reviewer reject verdict and kind defaults to review',()=>{
 const base={schemaVersion:1 as const,artifactId:randomUUID(),policyRevision:1,commit:'a'.repeat(40),tree:'b'.repeat(40),base:'c'.repeat(40),findings:[{severity:'high' as const,summary:'the test does not exercise the change'}]};
 const failed=parseQaModelVerdict({...base,verdict:'fail'});
 assert.equal(failed.verdict,'reject');
 assert.equal(failed.kind,'review');
 const passed=parseQaModelVerdict({...base,kind:'review',verdict:'pass',findings:[]});
 assert.equal(passed.verdict,'pass');
 assert.deepEqual((nativeReviewOutputSchema.properties as {verdict:{enum:string[]}}).verdict.enum,['pass','reject']);
});

test('the QA model request carries the diff, the owner request and the test tail',()=>{
 const artifact={id:randomUUID(),policy_revision:2,commit_id:'d'.repeat(40),tree_id:'e'.repeat(40),base_id:'f'.repeat(40)};
 const request=qaModelExecutionRequest({stageId:randomUUID(),sessionId:randomUUID(),intentId:randomUUID(),grantId:randomUUID(),artifact,diff:'diff --git a/src/a.ts',truncated:false,ownerRequest:'add a real test',testTail:'1 passing'});
 assert.equal(request.role,'qa');
 const task=JSON.parse(request.task);
 assert.equal(task.instruction,QA_MODEL_INSTRUCTION);
 assert.match(task.instruction,/should have a test/);
 assert.match(task.instruction,/does not really test/);
 assert.equal(task.diff,'diff --git a/src/a.ts');
 assert.equal(task.ownerRequest,'add a real test');
 assert.equal(task.testTail,'1 passing');
 assert.equal(task.kind,'review');
 const header=Buffer.alloc(8);header[0]=1;const payload=Buffer.from('line-1\nline-2\n');header.writeUInt32BE(payload.length,4);
 assert.equal(qaLogTail(Buffer.concat([header,payload])), 'line-1\nline-2\n');
});
