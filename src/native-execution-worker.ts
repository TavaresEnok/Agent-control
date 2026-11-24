import {runWithTransientRetry} from './provider-failure.ts';
import {personalEgressEnabled} from './personal-egress.ts';
import {runModuleExamWorker} from './module-exam-worker.ts';
import {constants} from 'node:fs';
import {waitForNativeLaunch} from './native-worker-gate.ts';
import {open,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {codexPersonalCommand,codexWorkerAssertsSubscriptionIdentity,runCodexExec} from './codex-personal.ts';
import {HARDENED_CLAUDE_BIN,hardenedClaudeMode} from './claude-hardening.ts';
import {EXAM_CLAUDE_WRAPPER_BIN,examCodexArgv,examLoginHomes,prepareExamClaudeHome,prepareExamLoginCopy} from './verify-exam-isolation.ts';
import {initializeNativeWorkerEnvironment,readPrivateWorkerFile,readSignedWorkerLaunch,assertCodexSubscriptionIdentity,prepareNativeExternalAuth,readMountedCredentialSecrets} from './native-worker-security.ts';
import {startToolForwarder,isPrivateToolAddress} from './native-tool-forwarder.ts';
import {collectSecretValues,redactSecrets} from '../upstream/cezar/packages/cezar/dist/core/secret-redaction.js';
import {CodexExecutionAdapter,CodexExecutionFailure} from './codex-execution-adapter.ts';
import {ClaudeExecutionAdapter,ClaudeExecutionFailure} from './claude-execution-adapter.ts';
import {GrokExecutionFailure,runGrokProgrammer} from './grok-execution-adapter.ts';
import {runWithVerdictRetry} from './evaluator-output.ts';
import {sumUsageAttempts} from './native-usage.ts';
import {CodexAppServerRunner} from '../upstream/cezar/packages/cezar/dist/core/codex-app-server-runner.js';
import {ClaudeCliRunner} from '../upstream/cezar/packages/cezar/dist/core/claude-cli-runner.js';
import {Effort} from './effort.ts';
import type {UsageCountersValue} from './native-usage.ts';
import type {UsageWindowsObservation} from '../upstream/cezar/packages/contract/src/usage-windows.ts';
const UUID=z.uuid(),Hash=z.string().regex(/^[a-f0-9]{64}$/);
const Launch=z.object({schemaVersion:z.literal(1),jobId:UUID,contextId:UUID,intentId:UUID,grantId:UUID,accountId:UUID,profileId:UUID,sessionId:UUID,
 epoch:z.number().int().positive(),providerSubjectDigest:Hash,credentialSnapshotTag:Hash,executorDigest:Hash,inputDigest:Hash,proxyUrl:z.literal('http://provider-egress:8080'),
 model:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),effort:Effort,
 role:z.enum(['programmer','qa','reviewer','judge','specialist']),task:z.string().min(1).max(100000),writePaths:z.array(z.string().max(240)).max(64),
 artifactCommit:z.string().regex(/^[a-f0-9]{40}$/).optional(),outputSchema:z.record(z.string(),z.unknown()).optional(),
 environmentId:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),toolsAddress:z.string().refine(isPrivateToolAddress),timeoutMs:z.number().int().min(1000).max(1800000),expiresAt:z.number().int().positive(),provider:z.enum(['codex','claude','grok']).optional(),
 synthetic:z.boolean().optional(),moduleExam:z.literal(true).optional(),
 oauthAccessToken:z.string().min(1).max(16384).optional()}).strict();

/** Coherent agreement with the supervisor: a synthetic fixture never runs the Claude exam token path. */
export function isClaudeExamWorker(input:{verifyExam:boolean;provider?:string;synthetic?:boolean}):boolean{
 return input.verifyExam&&input.provider==='claude'&&!input.synthetic;
}

/**
 * Configure a Claude exam worker with only the signed `CLAUDE_CODE_OAUTH_TOKEN` in env,
 * no `.credentials.json` on disk, no `CLAUDE_CONFIG_DIR`, and no `ANTHROPIC_API_KEY`,
 * `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, or `CLAUDE_CODE_USE_*`.
 */
export async function prepareClaudeExamWorkerEnv(input:{
 oauthAccessToken:string|undefined;
 credentialSnapshotTag:string;
 execToken:string;
 tmpRoot?:string;
}):Promise<{secrets:string[];claudeBin:string;examHome:string}>{
 if(!input.oauthAccessToken)throw Error('EXAM_OAUTH_TOKEN_MISSING');
 const secrets=[input.oauthAccessToken];
 const tmpRoot=input.tmpRoot??'/tmp';
 await prepareNativeExternalAuth(secrets,input.execToken,input.credentialSnapshotTag,tmpRoot);
 const examHome=await prepareExamClaudeHome(tmpRoot);
 process.env.HOME=examHome;
 delete process.env.CLAUDE_CONFIG_DIR;
 delete process.env.ANTHROPIC_API_KEY;
 delete process.env.ANTHROPIC_AUTH_TOKEN;
 delete process.env.ANTHROPIC_BASE_URL;
 for(const key of Object.keys(process.env)){
  if(key.startsWith('CLAUDE_CODE_USE_'))delete process.env[key];
 }
 process.env.CLAUDE_CODE_OAUTH_TOKEN=input.oauthAccessToken;
 return {secrets,claudeBin:EXAM_CLAUDE_WRAPPER_BIN,examHome};
}

export function createClaudeWorkerRunner(claudeBin:string,timeoutMs:number):ClaudeCliRunner{
 return new ClaudeCliRunner({bin:claudeBin,timeoutMs});
}

/** Fixed worker only: the broker must create a separately isolated exec-server,
 * enforce read-only evaluators and verify both physical exit and Git artifacts.
 * This file alone does not authorize, schedule, approve or integrate anything. */
async function main(){
 const verifyExam=process.env.AC_VERIFY_EXAM==='1';
 // Read the supervisor's decision before resetting the worker environment.
 const personalEgress=personalEgressEnabled();
 if(process.argv.length!==2)throw Error('INVALID_WORKER_ARGUMENTS');
 initializeNativeWorkerEnvironment();
 await waitForNativeLaunch();
 const input=await readSignedWorkerLaunch(Launch,'agent-control:native-execution-launch:v1','/input/launch.json','/runner/execution-public-key.pem');
 if(input.expiresAt<Date.now()||input.expiresAt>Date.now()+60000)throw Error('INVALID_WORKER_SCOPE');
 if(input.moduleExam){
  if((input.provider!=='codex'&&input.provider!=='claude'&&input.provider!=='grok')||input.synthetic||input.role!=='specialist'||input.writePaths.length)
   throw Error('MODULE_EXAM_SCOPE_MISMATCH');
  await runModuleExamWorker({...input,provider:input.provider});
  return;
 }
 const personalCli=input.provider==='claude'||input.provider==='grok'||input.provider==='codex';
 initializeNativeWorkerEnvironment(personalCli&&!personalEgress?undefined:input.proxyUrl);
 const claudeExam=isClaudeExamWorker({verifyExam,provider:input.provider,synthetic:input.synthetic});
 const planning=await lstat('/planning');if(!planning.isDirectory()||planning.isSymbolicLink())throw Error('INVALID_WORKER_DIRECTORY');
 const capability=await readPrivateWorkerFile('/runner/exec-token',512);let token:string;
 try{token=capability.toString('utf8').trim();if(!/^[A-Za-z0-9._~-]{32,512}$/.test(token))throw Error('INVALID_TOOL_CAPABILITY');}finally{capability.fill(0);}
 let account:{secrets:string[];accessToken:string;accountId:string};
 // A non-exam Claude never runs bare: project and account hooks and project MCP servers stay off (src/claude-hardening.ts).
 let claudeBin=HARDENED_CLAUDE_BIN[hardenedClaudeMode(input.role)];
 if(claudeExam){
  const prepared=await prepareClaudeExamWorkerEnv({oauthAccessToken:input.oauthAccessToken,credentialSnapshotTag:input.credentialSnapshotTag,execToken:token});
  account={secrets:prepared.secrets,accessToken:input.oauthAccessToken!,accountId:input.accountId};
  claudeBin=prepared.claudeBin;
 }else{
  const identified=codexWorkerAssertsSubscriptionIdentity(input.provider)?await assertCodexSubscriptionIdentity(input.providerSubjectDigest):null;
  const secrets=identified?.secrets??await readMountedCredentialSecrets(input.provider??'codex');
  account=identified??{secrets,accessToken:'',accountId:input.accountId};
  if(input.provider==='codex')process.env.CODEX_HOME='/account/.codex';
  else{
   const home=await prepareNativeExternalAuth(account.secrets,token,input.credentialSnapshotTag);
   if(input.provider==='claude')process.env.CLAUDE_CONFIG_DIR='/account';else if(input.provider!=='grok')process.env.CODEX_HOME=home;
  }
  if(verifyExam){
   const examLogin=await prepareExamLoginCopy('/account','/tmp');
   const homes=examLoginHomes(examLogin);
   process.env.CLAUDE_CONFIG_DIR=homes.claudeConfigDir;
   process.env.CODEX_HOME=homes.codexHome;
   process.env.HOME=homes.grokHome;
  }
 }
 const startedMs=Date.now();
 const forwarder=await startToolForwarder(input.toolsAddress);
 const abort=new AbortController();const stop=()=>abort.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop);
 let result:{output:string;tokensUsed:number|null;counters?:UsageCountersValue|null;usageWindows:UsageWindowsObservation|null;nativeSessionId:string|null}|undefined,failure:string|null=null,failedUsage:CodexExecutionFailure|ClaudeExecutionFailure|GrokExecutionFailure|undefined;
 try{
  const request={sessionId:input.sessionId,model:input.model,effort:input.effort,role:input.role,task:input.task,writePaths:input.writePaths,
   artifactCommit:input.artifactCommit,outputSchema:input.outputSchema,timeoutMs:input.timeoutMs,
   environment:{id:input.environmentId,url:'ws://127.0.0.1:19492' as const,authBearerToken:token,cwd:'/work' as const}};
  const runOnce=async():Promise<{result:NonNullable<typeof result>;failure:string|null}>=>{
  if(input.provider==='grok'){
   return {result:await runGrokProgrammer(request,abort.signal),failure:null};
  }else if(input.provider==='claude'){
   const adapter=new ClaudeExecutionAdapter(createClaudeWorkerRunner(claudeBin,input.timeoutMs));
   return {result:await adapter.run(request,async()=>{if(abort.signal.aborted)throw Error('WORKER_STOPPED');},abort.signal,[...account.secrets,...collectSecretValues(process.env)]),failure:null};
  }else if(input.provider==='codex'){
   const command=codexPersonalCommand({role:input.role,model:input.model,effort:input.effort,prompt:input.task,outputSchema:input.outputSchema});
   const args=verifyExam?examCodexArgv(command.args):command.args;
   const ran=await runCodexExec({args,timeoutMs:input.timeoutMs,signal:abort.signal,cwd:args.includes('-C')?String(args[args.indexOf('-C')+1]):'/work',kind:'execution',json:input.role!=='programmer'});
   const output=redactSecrets(ran.output,[...account.secrets,...collectSecretValues(process.env)]);
   if(ran.failureCode)return {result:{output:'',tokensUsed:null,usageWindows:ran.usageWindows,nativeSessionId:null},failure:ran.failureCode};
   return {result:{output,tokensUsed:null,usageWindows:ran.usageWindows,nativeSessionId:null},failure:null};
  }else{
   const adapter=new CodexExecutionAdapter(new CodexAppServerRunner({bin:'/usr/local/bin/codex',timeoutMs:input.timeoutMs}));
   return {result:await adapter.run(request,async()=>{if(abort.signal.aborted)throw Error('WORKER_STOPPED');},abort.signal,[...account.secrets,...collectSecretValues(process.env)],{accessToken:account.accessToken,accountId:account.accountId,planType:null}),failure:null};
  }
  };
  // An evaluator must return one JSON verdict. A model sometimes slips (a stray bracket); ask once more
  // instead of failing the whole plan on a typo.
  const evaluator=input.role!=='programmer'&&Boolean(input.outputSchema);
  let previous:UsageCountersValue|null|undefined;
  // A passing provider outage gets up to two more tries, evaluators only, inside the job's own time.
  const deadlineMs=startedMs+input.timeoutMs;
  const ran=await runWithVerdictRetry(evaluator,()=>abort.signal.aborted,async()=>{
   try {
    const current=await runWithTransientRetry({enabled:input.role!=='programmer',deadlineMs,aborted:()=>abort.signal.aborted,once:runOnce});
    if(previous!==undefined)current.result.counters=sumUsageAttempts(previous,current.result.counters??null);
    previous=current.result.counters??null;
    return current;
   } catch(error) {
    if(previous!==undefined&&(error instanceof CodexExecutionFailure||error instanceof ClaudeExecutionFailure||error instanceof GrokExecutionFailure))
     failedUsage={...error,counters:sumUsageAttempts(previous,error.counters)} as typeof error;
    throw error;
   }
  });result=ran.result;failure=ran.failure;
 }catch(error){if(error instanceof CodexExecutionFailure||error instanceof ClaudeExecutionFailure||error instanceof GrokExecutionFailure){failedUsage??=error;failure=error.code;}else failure='EXECUTION_FAILED';}
 finally{forwarder.close();}
 const usage=result?.usageWindows??failedUsage?.usageWindows??null,safeUsage=Buffer.byteLength(JSON.stringify(usage))<=32768?usage:null;
 const output=await open('/output/execution-result.json',constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await output.writeFile(JSON.stringify({schemaVersion:1,jobId:input.jobId,output:result?.output??'',normalizedTokensUsed:result?.tokensUsed??failedUsage?.tokensUsed??null,
  usageCounters:result?.counters??failedUsage?.counters??null,usageWindows:safeUsage,nativeSessionId:result?.nativeSessionId??null,failureCode:failure,exitCode:failure?1:0}));await output.sync();}finally{await output.close();}
 process.exit(failure?1:0);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main().catch(error=>{console.error('NATIVE_EXECUTION_WORKER_FAILED',error instanceof z.ZodError?'INVALID_LAUNCH_SHAPE':String((error as Error)?.message??'').replace(/[^A-Za-z0-9_ .:,/-]/g,'').slice(0,160));process.exitCode=1;});
}
