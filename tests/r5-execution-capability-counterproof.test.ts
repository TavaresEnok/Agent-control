import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {CodexExecutionAdapter} from '../src/codex-execution-adapter.ts';
import type {AgentRunner} from '../upstream/cezar/packages/cezar/dist/core/agent-runner.js';

test('successful native adapter redacts known capability in model output',async()=>{
 const capability='synthetic-tools-'+randomBytes(24).toString('hex'),credential='synthetic-credential-'+randomBytes(24).toString('hex');
 const runner:AgentRunner={backend:'codex',run:async()=>{throw Error('UNUSED');},interrupt:async()=>{},startSession(spec,onEvent){
  assert.equal(spec.executionEnvironment?.authBearerToken,capability);assert(!String(spec.userPrompt).includes(capability));assert(!String(spec.userPrompt).includes(credential));assert(String(spec.userPrompt).includes('[REDACTED]'));assert(!String(spec.systemPrompt).includes(capability));
  const result=Promise.resolve().then(()=>{onEvent?.({type:'turn-end'});return {text:'safe '+capability+' '+credential+' end',tokensUsed:0,toolCalls:[]};});
  return {result,open:false,sendMessage:()=>false,end:()=>{},interrupt:()=>{},hardStop:()=>{}};
 }};
 const result=await new CodexExecutionAdapter(runner).run({sessionId:randomUUID(),model:'fixture',effort:'medium',role:'programmer',task:'safe task '+capability+' '+credential,writePaths:['src/safe.ts'],environment:{id:'tools',url:'ws://127.0.0.1:19492',authBearerToken:capability,cwd:'/work'},timeoutMs:1000},async()=>{},undefined,[credential]);
 assert.equal(result.output,'safe [REDACTED] [REDACTED] end');assert(!result.output.includes(capability));assert(!result.output.includes(credential));
 assert.throws(()=>assert(!('safe '+capability+' end').includes(capability)),'negative control detects unredacted output');
 console.log(JSON.stringify({proof:'known-tool-capability-in-successful-result',leakObserved:false,runner:'deterministic injected AgentRunner',promptContainedCapability:false,physicalContainer:false,providerInference:false}));
});
