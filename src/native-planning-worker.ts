import {constants} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {z} from 'zod';
import {initializeNativeWorkerEnvironment,readSignedWorkerLaunch,assertCodexSubscriptionIdentity} from './native-worker-security.ts';
import {CodexPlanningAdapter,CodexPlanningFailure} from './codex-planning-adapter.ts';
import {CodexAppServerRunner} from '../upstream/cezar/packages/cezar/dist/core/codex-app-server-runner.js';
const UUID=z.uuid();
const Launch=z.object({schemaVersion:z.literal(1),callId:UUID,contextId:UUID,intentId:UUID,grantId:UUID,accountId:UUID,profileId:UUID,sessionId:UUID,
 epoch:z.number().int().positive(),proxyUrl:z.literal('http://provider-egress:8080').optional(),providerSubjectDigest:z.string().regex(/^[a-f0-9]{64}$/),executorDigest:z.string().regex(/^[a-f0-9]{64}$/),inputDigest:z.string().regex(/^[a-f0-9]{64}$/),
 model:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),effort:z.enum(['low','medium','high']),sourceMessageRef:z.string().min(1).max(240),text:z.string().min(1).max(100000),
 constraints:z.object({contextId:UUID,qualityRevision:z.number().int().positive(),targetRef:z.string().max(240),knownReferences:z.array(z.string().max(240)).max(257)}).strict(),
 outputSchema:z.record(z.string(),z.unknown()),expiresAt:z.number().int().positive()}).strict();
/** Worker-side only: the broker keeps the signing key and physical-operation
 * authority. This entrypoint cannot publish, approve, release grants or schedule. */
async function main(){
 if(process.argv.length!==2)throw Error('INVALID_WORKER_ARGUMENTS');
 initializeNativeWorkerEnvironment();
 const input=await readSignedWorkerLaunch(Launch,'agent-control:native-planning-launch:v1');
 if(input.proxyUrl)initializeNativeWorkerEnvironment(input.proxyUrl);
 if(input.constraints.contextId!==input.contextId||input.expiresAt<Date.now()||input.expiresAt>Date.now()+60000)throw Error('INVALID_WORKER_SCOPE');
 await assertCodexSubscriptionIdentity(input.providerSubjectDigest);
 const planning=await lstat('/planning');if(!planning.isDirectory()||planning.isSymbolicLink())throw Error('INVALID_PLANNING_DIRECTORY');
 const abort=new AbortController();const stop=()=>abort.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop);
 let result:Awaited<ReturnType<CodexPlanningAdapter['generate']>>|undefined,failure:string|null=null;let failedUsage:CodexPlanningFailure|undefined;
 try{
  const adapter=new CodexPlanningAdapter(new CodexAppServerRunner({bin:'/usr/local/bin/codex',timeoutMs:120000}));
  result=await adapter.generate({sessionId:input.sessionId,model:input.model,effort:input.effort,sourceMessageRef:input.sourceMessageRef,text:input.text,
   constraints:input.constraints,outputSchema:input.outputSchema,timeoutMs:120000},async()=>{if(abort.signal.aborted)throw Error('WORKER_STOPPED');},abort.signal);
 }catch(error){if(error instanceof CodexPlanningFailure){failedUsage=error;failure=error.code;}else failure='PLANNING_EXECUTION_FAILED';}
 const output=await open('/output/planning-result.json',constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 const usage=result?.usageWindows??failedUsage?.usageWindows??null;
 const safeUsage=Buffer.byteLength(JSON.stringify(usage))<=32768?usage:null;
 try{await output.writeFile(JSON.stringify({schemaVersion:1,callId:input.callId,output:result?.output??'',normalizedTokensUsed:result?.tokensUsed??failedUsage?.tokensUsed??null,usageWindows:safeUsage,nativeSessionId:result?.sessionId??null,failureCode:failure,exitCode:failure?1:0}));await output.sync();}finally{await output.close();}
 process.exitCode=failure?1:0;
}
main().catch(()=>{console.error('NATIVE_PLANNING_WORKER_FAILED');process.exitCode=1;});
