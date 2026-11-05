import {constants} from 'node:fs';
import {waitForNativeLaunch} from './native-worker-gate.ts';
import {open,lstat} from 'node:fs/promises';
import {z} from 'zod';
import {initializeNativeWorkerEnvironment,readPrivateWorkerFile,readSignedWorkerLaunch,assertCodexSubscriptionIdentity,prepareNativeExternalAuth} from './native-worker-security.ts';
import {startToolForwarder,isPrivateToolAddress} from './native-tool-forwarder.ts';
import {collectSecretValues} from '../upstream/cezar/packages/cezar/dist/core/secret-redaction.js';
import {CodexExecutionAdapter,CodexExecutionFailure} from './codex-execution-adapter.ts';
import {CodexAppServerRunner} from '../upstream/cezar/packages/cezar/dist/core/codex-app-server-runner.js';
const UUID=z.uuid(),Hash=z.string().regex(/^[a-f0-9]{64}$/);
const Launch=z.object({schemaVersion:z.literal(1),jobId:UUID,contextId:UUID,intentId:UUID,grantId:UUID,accountId:UUID,profileId:UUID,sessionId:UUID,
 epoch:z.number().int().positive(),providerSubjectDigest:Hash,credentialSnapshotTag:Hash,executorDigest:Hash,inputDigest:Hash,proxyUrl:z.literal('http://provider-egress:8080'),
 model:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),effort:z.enum(['low','medium','high']),
 role:z.enum(['programmer','qa','reviewer','judge','specialist']),task:z.string().min(1).max(100000),writePaths:z.array(z.string().max(240)).max(64),
 artifactCommit:z.string().regex(/^[a-f0-9]{40}$/).optional(),outputSchema:z.record(z.string(),z.unknown()).optional(),
 environmentId:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),toolsAddress:z.string().refine(isPrivateToolAddress),timeoutMs:z.number().int().min(1000).max(1800000),expiresAt:z.number().int().positive()}).strict();
/** Fixed worker only: the broker must create a separately isolated exec-server,
 * enforce read-only evaluators and verify both physical exit and Git artifacts.
 * This file alone does not authorize, schedule, approve or integrate anything. */
async function main(){
 if(process.argv.length!==2)throw Error('INVALID_WORKER_ARGUMENTS');
 initializeNativeWorkerEnvironment();
 await waitForNativeLaunch();
 const input=await readSignedWorkerLaunch(Launch,'agent-control:native-execution-launch:v1','/input/launch.json','/runner/execution-public-key.pem');
 if(input.expiresAt<Date.now()||input.expiresAt>Date.now()+60000)throw Error('INVALID_WORKER_SCOPE');
 initializeNativeWorkerEnvironment(input.proxyUrl);const account=await assertCodexSubscriptionIdentity(input.providerSubjectDigest);
 const planning=await lstat('/planning');if(!planning.isDirectory()||planning.isSymbolicLink())throw Error('INVALID_WORKER_DIRECTORY');
 const capability=await readPrivateWorkerFile('/runner/exec-token',512);let token:string;
 try{token=capability.toString('utf8').trim();if(!/^[A-Za-z0-9._~-]{32,512}$/.test(token))throw Error('INVALID_TOOL_CAPABILITY');}finally{capability.fill(0);}
 process.env.CODEX_HOME=await prepareNativeExternalAuth(account.secrets,token,input.credentialSnapshotTag);
 const forwarder=await startToolForwarder(input.toolsAddress);
 const abort=new AbortController();const stop=()=>abort.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop);
 let result:Awaited<ReturnType<CodexExecutionAdapter['run']>>|undefined,failure:string|null=null,failedUsage:CodexExecutionFailure|undefined;
 try{
  const adapter=new CodexExecutionAdapter(new CodexAppServerRunner({bin:'/usr/local/bin/codex',timeoutMs:input.timeoutMs}));
  result=await adapter.run({sessionId:input.sessionId,model:input.model,effort:input.effort,role:input.role,task:input.task,writePaths:input.writePaths,
   artifactCommit:input.artifactCommit,outputSchema:input.outputSchema,timeoutMs:input.timeoutMs,
   environment:{id:input.environmentId,url:'ws://127.0.0.1:19492',authBearerToken:token,cwd:'/work'}},async()=>{if(abort.signal.aborted)throw Error('WORKER_STOPPED');},abort.signal,[...account.secrets,...collectSecretValues(process.env)],{accessToken:account.accessToken,accountId:account.accountId,planType:null});
 }catch(error){if(error instanceof CodexExecutionFailure){failedUsage=error;failure=error.code;}else failure='EXECUTION_FAILED';}
 finally{forwarder.close();}
 const usage=result?.usageWindows??failedUsage?.usageWindows??null,safeUsage=Buffer.byteLength(JSON.stringify(usage))<=32768?usage:null;
 const output=await open('/output/execution-result.json',constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await output.writeFile(JSON.stringify({schemaVersion:1,jobId:input.jobId,output:result?.output??'',normalizedTokensUsed:result?.tokensUsed??failedUsage?.tokensUsed??null,
  usageWindows:safeUsage,nativeSessionId:result?.nativeSessionId??null,failureCode:failure,exitCode:failure?1:0}));await output.sync();}finally{await output.close();}
 process.exitCode=failure?1:0;
}
main().catch(()=>{console.error('NATIVE_EXECUTION_WORKER_FAILED');process.exitCode=1;});
