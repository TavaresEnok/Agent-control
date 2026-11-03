import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {CodexExecutionAdapter,CodexExecutionFailure} from '../src/codex-execution-adapter.ts';
import type {AgentRunner,AgentEvent,AgentRunSpec} from '../upstream/cezar/packages/cezar/dist/core/agent-runner.js';
function fixture(events:AgentEvent[],capture:(spec:AgentRunSpec)=>void):AgentRunner{
 return {backend:'codex',run:async()=>{throw Error('UNUSED');},interrupt:async()=>{},startSession(spec,onEvent){capture(spec);
  const result=Promise.resolve().then(()=>{events.forEach(event=>onEvent?.(event));return {text:'synthetic final output',tokensUsed:33,toolCalls:[{id:'tool',name:'shell',input:{}}]};});
  return {result,open:false,sendMessage:()=>false,end:()=>{},interrupt:()=>{},hardStop:()=>{}};}};
}
const input=()=>({sessionId:randomUUID(),model:'fixture-model',effort:'medium' as const,role:'programmer' as const,task:'synthetic scoped request',writePaths:['src/feature.ts'],
 environment:{id:'job_tools',url:'ws://127.0.0.1:8765',authBearerToken:'a'.repeat(48),cwd:'/work' as const},timeoutMs:1000});
test('programmer pins profile and isolated environment without exposing its capability in the prompt',async()=>{
 const value=input();let verified=0;
 const adapter=new CodexExecutionAdapter(fixture([{type:'token-usage',tokensUsed:33},{type:'turn-end'}],spec=>{
  assert.equal(spec.model,value.model);assert.equal(spec.reasoningEffort,'medium');assert.equal(spec.isolatedAppServer,true);
  assert.deepEqual(spec.executionEnvironment,value.environment);assert(!String(spec.userPrompt).includes(value.environment.authBearerToken));
 }));
 const result=await adapter.run(value,async()=>{verified++;});assert.equal(verified,1);assert.equal(result.tokensUsed,33);
 await assert.rejects(adapter.run({...value,writePaths:['.git/config']},async()=>{}));
 await assert.rejects(adapter.run({...value,role:'reviewer',writePaths:['src/feature.ts'],artifactCommit:'a'.repeat(40)},async()=>{}));
 await assert.rejects(adapter.run({...value,role:'reviewer',writePaths:[],artifactCommit:'a'.repeat(40)},async()=>{}));
 const schema={type:'object',properties:{approved:{type:'boolean'}},required:['approved'],additionalProperties:false};
 const reviewer=new CodexExecutionAdapter(fixture([{type:'turn-end'}],spec=>{assert.deepEqual(spec.structuredOutputSchema,schema);assert(String(spec.userPrompt).includes('a'.repeat(40)));}));
 assert.equal((await reviewer.run({...value,role:'reviewer',writePaths:[],artifactCommit:'a'.repeat(40),outputSchema:schema},async()=>{})).tokensUsed,null);
});
test('a failed or incomplete native turn cannot be presented as successful work',async()=>{
 for(const events of [[{type:'error',message:'PRIVATE_PROVIDER_ERROR'},{type:'turn-end'}],[],[{type:'turn-end',reason:'context-compaction'}]] as AgentEvent[][]){
  const adapter=new CodexExecutionAdapter(fixture(events,()=>{}));
  await assert.rejects(adapter.run(input(),async()=>{}),error=>{assert(error instanceof CodexExecutionFailure);assert.equal(error.code,'EXECUTION_NATIVE_TURN_FAILED');assert(!error.message.includes('PRIVATE_PROVIDER_ERROR'));return true;});
 }
});
