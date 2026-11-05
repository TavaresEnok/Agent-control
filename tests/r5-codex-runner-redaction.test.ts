import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {CodexAppServerRunner} from '../upstream/cezar/packages/cezar/dist/core/codex-app-server-runner.js';
import {CodexExecutionAdapter} from '../src/codex-execution-adapter.ts';
import type {AgentRunner} from '../upstream/cezar/packages/cezar/dist/core/agent-runner.js';

test('successful real Codex runner and scripted app-server redact a fragmented known capability',{timeout:15000},async()=>{
 const dir=await mkdtemp('/tmp/ac-codex-redact-'),bin=join(dir,'codex'),capability='synthetic-'+randomBytes(24).toString('hex');
 try{
  let source=await readFile(resolve('upstream/cezar/packages/cezar/src/core/__fixtures__/codex/mock-codex-app-server.mjs'),'utf8');
  assert(source.includes("} else if (msg.method === 'environment/add') {"));
  source=source.replace("let scenario = '';","let capability='';\nlet scenario = '';").replaceAll("process.env.MOCK_CODEX_EXPECT_REMOTE==='1'",'true')
   .replace("} else if (msg.method === 'environment/add') {","} else if (msg.method === 'environment/add') {\n    capability=msg.params.authBearerToken;")
   .replace("delta: 'Checking the working tree.'", "delta: 'safe '+capability.slice(0,12)")
   .replace("    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_m1', text: 'Checking the working tree.' } } });", "    emit({method:'item/agentMessage/delta',params:{threadId:'th_mock_1',turnId:'turn_mock_1',itemId:'item_m1',delta:capability.slice(12)+' end'}});\n    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_m1', text: 'safe '+capability+' end' } } });");
  await writeFile(bin,source,{mode:0o755});const actual=new CodexAppServerRunner({bin,timeoutMs:10000});
  // Adapter pins /planning in Docker; this test substitutes only the host cwd.
  const runner:AgentRunner={backend:'codex',run:actual.run.bind(actual),interrupt:actual.interrupt.bind(actual),startSession:(spec,onEvent,options)=>actual.startSession({...spec,cwd:dir},onEvent,options)};
  const result=await new CodexExecutionAdapter(runner).run({sessionId:randomUUID(),model:'fixed-model',effort:'medium',role:'programmer',task:'safe request',writePaths:['src/safe.ts'],environment:{id:'job_tools',url:'ws://127.0.0.1:19492',authBearerToken:capability,cwd:'/work'},timeoutMs:10000},async()=>{});
  assert.equal(result.output,'safe [REDACTED] end');assert(!result.output.includes(capability));console.log(JSON.stringify({runner:'actual CodexAppServerRunner',cli:'scripted app-server process',splitDelta:true,redacted:true,providerInference:false,container:false}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
