import {it,expect} from 'vitest';
import {fileURLToPath} from 'node:url';
import {CodexAppServerRunner} from './codex-app-server-runner.js';
it('sends explicit high effort through native turn/start and refuses an unsupported ceiling before spawning',async()=>{
 const runner=new CodexAppServerRunner({bin:fileURLToPath(new URL('./__fixtures__/codex/mock-codex-app-server.mjs',import.meta.url)),timeoutMs:5000});
 expect(()=>runner.startSession({cwd:process.cwd(),userPrompt:'offline fixture',reasoningEffort:'ultra' as 'high'})).toThrow('MODEL_EFFORT_NOT_ALLOWED');
 const result=await runner.run({cwd:process.cwd(),userPrompt:'offline fixture',reasoningEffort:'high',env:{MOCK_CODEX_EXPECT_EFFORT:'high'}});
 expect(typeof result.text).toBe('string');expect(result.text.length).toBeGreaterThan(0);
},10000);
it('uses a fresh read-only tools-disabled planning thread with structured output and pins the returned profile',async()=>{
 const runner=new CodexAppServerRunner({bin:fileURLToPath(new URL('./__fixtures__/codex/mock-codex-app-server.mjs',import.meta.url)),timeoutMs:5000});
 const result=await runner.run({cwd:process.cwd(),userPrompt:'offline planning fixture',model:'fixture-sol',reasoningEffort:'medium',readOnlyPlanning:true,
  structuredOutputSchema:{type:'object',additionalProperties:false,properties:{ok:{type:'boolean'}},required:['ok']},env:{MOCK_CODEX_EXPECT_EFFORT:'medium',MOCK_CODEX_EXPECT_PLANNING:'1'}});
 expect(result.text.length).toBeGreaterThan(0);
 expect(()=>runner.startSession({cwd:process.cwd(),userPrompt:'x',readOnlyPlanning:true,model:'fixture-sol',reasoningEffort:'medium',resume:true})).toThrow('PLANNING_FRESH_PROFILE_REQUIRED');
},10000);
it('pins remote tools before the first turn and refuses disconnected or substituted environments without local fallback',async()=>{
 const runner=new CodexAppServerRunner({bin:fileURLToPath(new URL('./__fixtures__/codex/mock-codex-app-server.mjs',import.meta.url)),timeoutMs:5000});
 const spec={cwd:process.cwd(),userPrompt:'offline tools fixture',isolatedAppServer:true,model:'fixture-sol',reasoningEffort:'medium' as const,
  executionEnvironment:{id:'job_tools',url:'ws://127.0.0.1:8765',cwd:'/work',authBearerToken:'a'.repeat(48)},env:{MOCK_CODEX_EXPECT_REMOTE:'1'}};
 expect((await runner.run(spec)).text.length).toBeGreaterThan(0);
 for(const env of [{MOCK_CODEX_REMOTE_STATE:'disconnected'},{MOCK_CODEX_REMOTE_WRONG:'1'}]){
  await expect(runner.run({...spec,env:{...spec.env,...env}})).rejects.toThrow(/EXECUTION_ENVIRONMENT_(NOT_READY|PROFILE_MISMATCH)/);
 }
 expect(()=>runner.startSession({...spec,executionEnvironment:{...spec.executionEnvironment,url:'ws://provider:8765'}})).toThrow('EXECUTION_ENVIRONMENT_INVALID');
 expect(()=>runner.startSession({...spec,isolatedAppServer:false})).toThrow('EXECUTION_ENVIRONMENT_INVALID');
},20000);

it('refuses native interactive requests in an isolated worker without surfacing an approval prompt',async()=>{
 const runner=new CodexAppServerRunner({bin:fileURLToPath(new URL('./__fixtures__/codex/mock-codex-app-server.mjs',import.meta.url)),timeoutMs:5000});
 const events:string[]=[],ui:string[]=[];
 const session=runner.startSession({cwd:process.cwd(),userPrompt:'mock:native-codex-ask',isolatedAppServer:true,model:'fixture-sol',reasoningEffort:'medium',
  executionEnvironment:{id:'job_tools',url:'ws://127.0.0.1:8765',cwd:'/work',authBearerToken:'a'.repeat(48)},env:{MOCK_CODEX_EXPECT_REMOTE:'1'}},
  event=>events.push(event.type),{autoEndAfterFirstTurn:true,onUiEvent:event=>ui.push(event.type)});
 await session.result;expect(events).toContain('error');expect(ui).not.toContain('ask.requested');
},10000);
