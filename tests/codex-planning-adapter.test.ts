import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {CodexPlanningAdapter,CodexPlanningFailure} from '../src/codex-planning-adapter.ts';
import type {AgentRunner,AgentEvent,AgentRunResult} from '../upstream/cezar/packages/cezar/dist/core/agent-runner.js';
const request=()=>({sessionId:randomUUID(),model:'fixture-model',effort:'medium' as const,sourceMessageRef:'message:fixture',text:'Synthetic input',
 constraints:{contextId:randomUUID(),qualityRevision:1,targetRef:'refs/heads/test',knownReferences:[]},outputSchema:{type:'object'},timeoutMs:1000});
function runner(events:AgentEvent[],toolCalls:AgentRunResult['toolCalls']=[]){
 const fake:AgentRunner={backend:'codex',run:async()=>{throw Error('UNUSED');},interrupt:async()=>{},
  startSession(spec,onEvent){assert.equal(spec.readOnlyPlanning,true);assert.equal(spec.reasoningEffort,'medium');assert.deepEqual(spec.allowedTools,[]);
   const result=Promise.resolve().then(()=>{for(const event of events)onEvent?.(event);return {text:'{"apparently":"valid partial output"}',toolCalls,tokensUsed:123};});
   return {result,open:false,sendMessage:()=>false,end:()=>{},interrupt:()=>{},hardStop:()=>{}};}};return fake;
}
test('clean native planning completion preserves unknown telemetry and refuses failed or incomplete valid-looking text',async()=>{
 const input=request();let authorized=0;
 const valid=await new CodexPlanningAdapter(runner([{type:'turn-end'}])).generate(input,async()=>{authorized++;});
 assert.equal(authorized,1);assert.equal(valid.tokensUsed,null);assert.equal(valid.usageWindows,null);
 for(const events of [[{type:'error',message:'private upstream diagnostic'},{type:'turn-end'}],[],[{type:'turn-end',reason:'context-compaction'}]] as AgentEvent[][])
  await assert.rejects(new CodexPlanningAdapter(runner(events)).generate(request(),async()=>{}),/PLANNING_NATIVE_TURN_FAILED/);
 await assert.rejects(new CodexPlanningAdapter(runner([{type:'token-usage',tokensUsed:99},{type:'error',message:'PRIVATE_DIAGNOSTIC'},{type:'turn-end'}])).generate(request(),async()=>{}),error=>{assert(error instanceof CodexPlanningFailure);assert.equal(error.tokensUsed,99);assert(!error.message.includes('PRIVATE_DIAGNOSTIC'));return true;});
 const observed=await new CodexPlanningAdapter(runner([{type:'token-usage',tokensUsed:123},{type:'turn-end'}])).generate(request(),async()=>{});assert.equal(observed.tokensUsed,123);
 await assert.rejects(new CodexPlanningAdapter(runner([{type:'turn-end'}],[{id:'fixture',name:'shell',input:{}}])).generate(request(),async()=>{}),/PLANNING_NATIVE_TURN_FAILED/);
});
test('an unexpected tool event is refused and does not become a successful planning result',async()=>{
 await assert.rejects(new CodexPlanningAdapter(runner([{type:'tool-call',id:'fixture',tool:'shell',input:{synthetic:true}},{type:'turn-end'}])).generate(request(),async()=>{}),/PLANNING_UNEXPECTED_TOOL_EVENT/);
});
