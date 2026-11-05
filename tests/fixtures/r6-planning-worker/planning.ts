import {writeFile} from 'node:fs/promises';
import {CodexPlanningAdapter} from '../../../src/codex-planning-adapter.ts';
import {CodexAppServerRunner} from '../../../upstream/cezar/packages/cezar/dist/core/codex-app-server-runner.js';
// The broker verifies the signed, scoped launch and owns the physical receipt.
// @ts-ignore absolute path exists only inside the isolated fixture image.
import {verifiedLaunch} from '/opt/fixture/verify.mjs';
const p=await verifiedLaunch('planning');
const adapter=new CodexPlanningAdapter(new CodexAppServerRunner({bin:'/opt/fixture/r6-app-server.mjs',timeoutMs:30000}));
const result=await adapter.generate({sessionId:p.sessionId,model:p.model,effort:p.effort,sourceMessageRef:p.sourceMessageRef,text:p.text,constraints:p.constraints,outputSchema:p.outputSchema,timeoutMs:30000},async()=>{});
await writeFile('/output/planning-result.json',JSON.stringify({schemaVersion:1,callId:p.callId,output:result.output,normalizedTokensUsed:result.tokensUsed,usageWindows:result.usageWindows,nativeSessionId:result.sessionId,failureCode:null,exitCode:0}),{mode:0o600,flag:'wx'});
