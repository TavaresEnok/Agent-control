import {test} from 'node:test';
import assert from 'node:assert/strict';
import {usageCountersFromEvent} from '../src/native-usage.ts';

test('native usage preserves reported counters and leaves incomplete cache unknown',()=>{
 assert.deepEqual(usageCountersFromEvent({input:100,output:12,cacheRead:20,cacheWrite:4,reasoning:3}),{input:100,output:12,cache:24,reasoning:3});
 assert.deepEqual(usageCountersFromEvent({input:5,output:0,cacheRead:2}),{input:5,output:0,cache:null,reasoning:null});
 assert.equal(usageCountersFromEvent({input:5,output:0,cacheRead:2},true).cache,2);
});

test('Claude exam captures result usage without replacing absent fields with zero',async()=>{
 const {readModuleExamClaudeUsage}=await import('../src/module-exam-worker.ts');
 const line=JSON.stringify({type:'result',usage:{input_tokens:25,output_tokens:7,cache_read_input_tokens:9,cache_creation_input_tokens:3}});
 assert.deepEqual(readModuleExamClaudeUsage(line),{input:25,output:7,cache:12,reasoning:null});
 assert.deepEqual(readModuleExamClaudeUsage(JSON.stringify({type:'result',usage:{input_tokens:2}})),{input:2,output:null,cache:null,reasoning:null});
 assert.equal(readModuleExamClaudeUsage('{}'),null);
});
