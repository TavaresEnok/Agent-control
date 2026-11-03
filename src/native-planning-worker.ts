import {constants} from 'node:fs';
import {open,readFile,lstat,access} from 'node:fs/promises';
import {createPublicKey,verify} from 'node:crypto';
import {z} from 'zod';
import {canonical,digest} from './contracts.ts';
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
 // No inherited account keys, API keys, proxy credentials or provider routing.
 for(const name of Object.keys(process.env))delete process.env[name];
 Object.assign(process.env,{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/account',CODEX_HOME:'/account/.codex',TMPDIR:'/tmp',
  CEZ_TELEMETRY:'0',CEZ_AUTONAME:'0',CEZ_AUTOMATIONS:'0',CEZ_SKILLS_AUTO_UPDATE:'0',CEZ_NO_BANNER:'1',DO_NOT_TRACK:'1'});
 const file=await open('/input/launch.json',constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let bytes:Buffer;
 try{const info=await file.stat();if(!info.isFile()||info.size>512*1024||info.nlink!==1||(info.mode&0o077)!==0||info.uid!==process.getuid?.())throw Error('INVALID_WORKER_INPUT');bytes=await file.readFile();if(bytes.length>512*1024)throw Error('INVALID_WORKER_INPUT');}finally{await file.close();}
 const signed=z.object({payload:Launch,signature:z.string().regex(/^[a-f0-9]{128}$/)}).strict().parse(JSON.parse(bytes.toString('utf8')));bytes.fill(0);
 const publicBytes=await readFile('/runner/planning-public-key.pem');if(publicBytes.length>4096)throw Error('INVALID_WORKER_KEY');
 const key=createPublicKey(publicBytes);if(key.asymmetricKeyType!=='ed25519'||!verify(null,Buffer.from('agent-control:native-planning-launch:v1\n'+canonical(signed.payload)),key,Buffer.from(signed.signature,'hex')))throw Error('INVALID_WORKER_SIGNATURE');
 const input=signed.payload;
 if(input.proxyUrl)Object.assign(process.env,{HTTPS_PROXY:input.proxyUrl,HTTP_PROXY:input.proxyUrl,NO_PROXY:'127.0.0.1,localhost'});
 if(input.constraints.contextId!==input.contextId||input.expiresAt<Date.now()||input.expiresAt>Date.now()+60000)throw Error('INVALID_WORKER_SCOPE');
 // Prevent API/billing fallback and user-supplied MCP/plugin/config inheritance.
 try{await access('/account/.codex/config.toml');throw Error('CUSTOM_CODEX_CONFIG_FORBIDDEN');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const authFile=await open('/account/.codex/auth.json',constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const info=await authFile.stat();if(!info.isFile()||info.nlink!==1||info.size>65536||(info.mode&0o077)!==0||info.uid!==process.getuid?.())throw Error('INVALID_WORKER_AUTH');
  const authBytes=await authFile.readFile();try{if(authBytes.length>65536)throw Error('INVALID_WORKER_AUTH');
   const auth=z.object({auth_mode:z.literal('chatgpt'),OPENAI_API_KEY:z.null().optional(),tokens:z.object({account_id:z.string().min(1),access_token:z.string().min(1),refresh_token:z.string().min(1)}).passthrough()}).passthrough().parse(JSON.parse(authBytes.toString('utf8')));
   // Never put this object, token file or parent environment into the prompt.
   if(digest({provider:'codex',subject:auth.tokens.account_id})!==input.providerSubjectDigest)throw Error('WORKER_ACCOUNT_IDENTITY_MISMATCH');
  }finally{authBytes.fill(0);}
 }finally{await authFile.close();}
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
