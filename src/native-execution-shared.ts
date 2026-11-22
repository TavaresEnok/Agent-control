/** Schemas, constants, launch locks and pure predicates shared by the native execution supervisor modules. */
import {UsageCounters} from './usage.ts';
import {DesignPurpose} from './design-types.ts';
import {type NativeResourceEnvelope} from './native-resource-envelope.ts';
import {type FileHandle} from 'node:fs/promises';
import {verify} from 'node:crypto';
import {z} from 'zod';
import pg from 'pg';
import {Authority,Refusal} from './contracts.ts';
import {DockerDaemon} from './sandbox-broker.ts';
import {type NativeSyntheticFixture} from './native-synthetic-fixture.ts';
import {NativeArtifactIdentity} from './native-artifact-finalizer.ts';
import {usageWindowsObservationSchema} from '../upstream/cezar/packages/contract/src/usage-windows.ts';
export const Id=z.uuid(),Hash=z.string().regex(/^[a-f0-9]{64}$/),GitId=z.string().regex(/^[a-f0-9]{40}$/);
export const PreLaunchExamReason=z.enum(['exam_login_stale','exam_login_busy','exam_login_restore_failed']);
export const PreLaunchExamPhysicalReceipt=z.object({executionStarted:z.literal(false),jobId:Id,containerId:z.null(),networkId:z.null(),synthetic:z.boolean(),modelInference:z.literal(false),reason:PreLaunchExamReason}).strict();
/** Receipt of a passive module-exam attempt whose first tools-container create lost its Docker response and was
 * later proven never started. It names the removed container and network; it never claims a worker existed. */
export const ModuleExamNeverStartedReceipt=z.object({executionStarted:z.literal(false),jobId:Id,containerId:z.null(),toolsContainerId:Hash,networkId:Hash,synthetic:z.literal(false),modelInference:z.literal(false),moduleExam:z.literal(true),reason:z.literal('module_exam_tools_create_lost')}).strict();
/** Verification modules 2 to 9 only. The security module (verify) and design are never recovered here. */
export const PassiveExamModules=new Set(['qa','arquitetura','dependencias','banco','prontidao','desempenho','documentacao','conformidade']);
export type ModuleExamRecoveryReason='supervisor_identity'|'docker_uncertain'|'intent_open'|'sibling_unresolved'|'job_state'|'journal_started'|'request_unproven'|'launch_present'|'spool_touched'|'worker_present'|'tools_absent'|'tools_mismatch'|'tools_started'|'tools_registered'|'removal_unproven'|'network_unproven'|'network_mismatch'|'network_attached'|'grant_state'|'retirement_conflict'|'residual_resources';
/** Docker's zero time for a container that was never started. Nothing else (empty, another 0001 date, any real date) is accepted. */
export const DockerZeroTime='0001-01-01T00:00:00Z';
/** Signature domain of the passive module-exam `tools_removed` journal stage; distinct from every other signed record. */
export const ModuleExamRemovalDomain='agent-control:native-module-exam-tools-removed:v1\n';
export type NativeModuleExamRecovery={state:'retired'|'preserved';reason:'proven_never_started'|ModuleExamRecoveryReason;grant:'released'|'preserved';removed:string[];replayed:boolean;receipt?:unknown};
/** Thrown by callers that need a refusal: the grant was kept because the evidence did not prove the attempt never started. */
export class ModuleExamRecoveryPreserved extends Refusal {
 constructor(readonly reason:ModuleExamRecoveryReason,readonly removed:string[]=[]){super('NATIVE_MODULE_EXAM_RECOVERY_PRESERVED',409);}
}
export type ModuleExamWorkRefusal='not_found'|'not_passive_exam'|'job_state'|'grant_state'|'supervisor_identity'|'receipt'|'output_missing'|'retirement'|'directory_unsafe'|'work_unsafe'|'busy';
export type ModuleExamWorkRelease={jobId:string;state:'eligible'|'released'|'absent';bytes?:number}|{jobId:string;state:'refused';reason:ModuleExamWorkRefusal};
/** What a terminal job's `work` copy was for: a passive exam answer, a read-only evaluation of a snapshot, or a programmer's checkout (artifact). */
export type TerminalWorkCategory='passive-exam'|'readonly-evaluator'|'programmer-artifact';
/** `unclassified`: workflow and role are not in the explicit read-only or programmer classification. `mode_unproven`: the signed request does not
 * prove the mount mode (or the job never launched). `unregistered_change`: the checkout holds something the project repository does not keep.
 * `session_lost`: the session holding the job lock went away; nothing more is removed. */
export type TerminalWorkRefusal=ModuleExamWorkRefusal|'base_unpreserved'|'artifact_unpreserved'|'unclassified'|'mode_unproven'|'unregistered_change'|'session_lost';
export type TerminalWorkRelease={jobId:string;state:'eligible'|'released'|'absent';bytes?:number;category?:TerminalWorkCategory}|{jobId:string;state:'refused';reason:TerminalWorkRefusal};
/** Test and diagnostics hook: called with the job lock held, after the plan is recorded, and just before the tree is removed. */
export type TerminalWorkObserver=(step:'locked'|'prepared'|'removing')=>Promise<void>;
export type TerminalWorkOptions={principal:string;contextId:string;projectId?:string;repository?:string;categories:readonly TerminalWorkCategory[];failed:boolean;lease?:Authority;automatic?:boolean;observe?:TerminalWorkObserver};
export type TerminalWorkJudgment={category:TerminalWorkCategory;terminalDigest:string;checkOutput:(output:FileHandle)=>Promise<void>;checkWork?:(signal:AbortSignal)=>Promise<boolean>};
/** Explicit classification for automatic work retention. Read-only: the role never receives a writable `/work` (the physical launch inspection
 * refuses it) and the workflow is one that runs such evaluators. Programmer: the workflows whose programmer finalizes a registered artifact.
 * Anything else (for instance a specialist advising an engineering run) is unclassified and keeps its copy. */
export const readonlyTerminalWork:Readonly<Record<string,readonly string[]>>=Object.freeze({
 'baseline-synthetic-v1':['qa','reviewer','judge'],
 'engineering-synthetic-v1':['qa','reviewer','judge'],
 'engineering-native-v1':['qa','reviewer','judge'],
 'managed-synthetic-v1':['qa','reviewer','judge'],
 'design-readonly-v1':['specialist','reviewer'],
 'security-verify-readonly-v1':['specialist','reviewer'],
});
export const programmerTerminalWork:ReadonlySet<string>=new Set(['baseline-synthetic-v1','engineering-synthetic-v1','engineering-native-v1','managed-synthetic-v1']);
export function terminalWorkClass(workflow:unknown,role:unknown):'readonly'|'programmer'|undefined{
 if(typeof workflow!=='string'||typeof role!=='string'||!Object.hasOwn(readonlyTerminalWork,workflow)&&!programmerTerminalWork.has(workflow))return undefined;
 if(role==='programmer')return programmerTerminalWork.has(workflow)?'programmer':undefined;
 return readonlyTerminalWork[workflow]?.includes(role)?'readonly':undefined;
}
/** One advisory lock per job, shared by every path that reads or frees its `work`: manual and automatic retention and artifact registration. */
export function terminalWorkLockKey(jobId:string){Id.parse(jobId);return 'agent-control:terminal-work:'+jobId;}
/**
 * Exclusion between a launch in preparation and every recovery that could free the same reservation (the periodic sweep of dead
 * grants and the supervisor's own recovery). One advisory lock per job grant, held on a dedicated session: it exists exactly as long
 * as the launching process is alive, so a crashed launch releases it by itself and a live one can never be reclaimed.
 * The grant (1:1 with the job) is the key because it is known before the job row exists.
 */
export function grantLaunchLockKey(grantId:string){Id.parse(grantId);return 'agent-control:grant-launch:'+grantId;}
/** Dedicated connection outside the ledger pool. Null when the ledger has no connection string to open one from. */
export async function openGrantLaunchLockSession(ledger:{pool:{options?:{connectionString?:string}}}){
 const connectionString=ledger.pool.options?.connectionString;
 if(!connectionString)return null;
 const client=new pg.Client({connectionString});
 client.on('error',()=>undefined); // A lost session only drops the lock it held; a late error never crashes the process.
 await client.connect();
 return client;
}
export async function tryGrantLaunchLock(session:pg.Client,grantId:string){
 return Boolean((await session.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok',[grantLaunchLockKey(grantId)])).rows[0]?.ok);
}
export async function releaseGrantLaunchLock(session:pg.Client,grantId:string){
 await session.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[grantLaunchLockKey(grantId)]).catch(()=>undefined/* the lock dies with the session ended next */);
}
/** Runs `effect` holding the grant's launch lock. The sweep only ever tries the lock, so a short wait here is enough. */
export async function withGrantLaunchLock<T>(ledger:{pool:{options?:{connectionString?:string}}},grantId:string,effect:()=>Promise<T>,waitMs=30000):Promise<T>{
 const session=await openGrantLaunchLockSession(ledger);
 if(!session)return effect();
 let locked=false;
 try{
  const deadline=Date.now()+waitMs;
  for(;;){
   if(await tryGrantLaunchLock(session,grantId)){locked=true;break;}
   if(Date.now()>=deadline)throw new Refusal('NATIVE_EXECUTION_BUSY',409);
   await new Promise(done=>setTimeout(done,50));
  }
  return await effect();
 }finally{
  if(locked)await releaseGrantLaunchLock(session,grantId);
  await session.end().catch(()=>undefined/* closing a lock session that may already be gone */);
 }
}
export class UnstartedExamRetirementPending extends Refusal {
 constructor(readonly jobId:string){super('NATIVE_PRELAUNCH_SETTLEMENT_PENDING',409);Id.parse(jobId);}
}
/** Specialist or reviewer of the readonly design exam. Programmer, qa and judge never match. */
export function readonlyDesignExam(workflow: unknown, role: unknown): boolean {
  return workflow === 'design-readonly-v1' && (role === 'specialist' || role === 'reviewer');
}
export const Path=z.string().min(1).max(240).refine(p=>!p.startsWith('/')&&!p.includes('\\')&&!/[\x00-\x1f*?\[\]{}]/.test(p)&&!p.split('/').some(s=>!s||['.','..','.git','.ai'].includes(s)));
export const NativeExecutionRequest=z.object({jobId:Id,intentId:Id,grantId:Id,sessionId:Id,base:GitId,
 role:z.enum(['programmer','qa','reviewer','judge','specialist']),task:z.string().min(1).max(100000),writePaths:z.array(Path).max(64),
 artifactId:Id.optional(),outputSchema:z.record(z.string(),z.unknown()).optional(),timeoutMs:z.number().int().min(1000).max(1800000).default(900000),
 designPurpose:DesignPurpose.optional(),
 moduleExam:z.object({accountId:Id,profileId:Id,model:z.string().min(1).max(100)}).strict().optional(),
 model:z.string().min(1).max(100).optional(),effort:z.enum(['low','medium','high','xhigh','max']).optional()}).strict().superRefine((v,c)=>{
 if(v.moduleExam&&(v.role!=='specialist'||v.model!==undefined||v.effort!==undefined))c.addIssue({code:'custom',message:'MODULE_EXAM_SCOPE_MISMATCH'});
 if((v.model===undefined)!==(v.effort===undefined))c.addIssue({code:'custom',message:'DESIGN_CREATE_MODEL_UNAVAILABLE'});
 if(v.model!==undefined&&(v.model!=='claude-opus-5-5'||(v.effort!=='high'&&v.effort!=='medium')))c.addIssue({code:'custom',message:'DESIGN_CREATE_MODEL_UNAVAILABLE'});
 if(v.role==='programmer'&&!v.writePaths.length)c.addIssue({code:'custom',message:'PROGRAMMER_SCOPE_REQUIRED'});
 if(v.role!=='programmer'&&(!v.artifactId||!v.outputSchema||v.writePaths.length))c.addIssue({code:'custom',message:'READONLY_ARTIFACT_REQUIRED'});
});
export type Input=z.infer<typeof NativeExecutionRequest>;
export type PersonalExamRecoveryScope={projectId:string;repository:string;explicitDesignWithdrawal:boolean};
export type ModuleExamRecoveryScope={projectId:string;repository:string};
export type NativeExecutionSupervisorConfig={id:string;workerImage:string;toolsImage:string;hostRoot:string;accountRoot:string;repository?:string;
 protectedRepositories:readonly string[];signingKeyPem:string;providerNetworkId:string;provider?:'codex'|'claude'|'grok';socketPath?:string;resourceEnvelope?:NativeResourceEnvelope;accountSubjects:readonly {accountId:string;subjectDigest:string}[];
 workerEnv:readonly string[];toolsEnv:readonly string[];syntheticFixture?:NativeSyntheticFixture;dataDirectory?:string;
 /** Writable-account renewal used before a Claude exam copy. Tests inject this and never spawn a real CLI. */
 examLoginRenew?:(accountDir:string)=>Promise<void>;
 /** false: kept only to reconcile and retire jobs started under a replaced image pair; it never launches. */
 active?:boolean; disabledMeasurementProjects?:readonly string[]};
export type NativeExecutionOutcome={state:'running'|'uncertain'}|{state:'completed'|'failed';receipt:{payload:Record<string,any>;signature:string};output:string;artifact:z.infer<typeof NativeArtifactIdentity>|null;failureCode:string|null};
export const Result=z.object({schemaVersion:z.literal(1),jobId:Id,output:z.string().max(262144),normalizedTokensUsed:z.number().int().safe().nonnegative().nullable(),usageCounters:UsageCounters.nullable().optional(),usageWindows:usageWindowsObservationSchema.nullable(),nativeSessionId:z.string().nullable(),failureCode:z.string().nullable(),exitCode:z.number().int()}).strict();
export const toolsEntrypoint=['node','/opt/agent-control/dist/src/native-tools-worker.mjs'];
export const moduleExamCompanion=['node','-e','setInterval(() => {}, 60_000)'];
export const workerEntrypoint=['node','/opt/agent-control/dist/src/native-execution-worker.mjs'];
/** Remove only the private network identified by the signed terminal receipt.
 * Caller must hold the fenced job lock and have confirmed both containers absent. */
export async function retireNativePrivateNetwork(docker:Pick<DockerDaemon,'inspectPrivateNetwork'|'removePrivateNetwork'>,
 identity:{networkId:string;providerNetworkId:string;jobId:string;inputDigest:string},apply=true){
 const {networkId,providerNetworkId,jobId,inputDigest}=identity;
 if(!/^[a-f0-9]{64}$/.test(networkId)||networkId===providerNetworkId||!Id.safeParse(jobId).success||!Hash.safeParse(inputDigest).success)
  throw new Refusal('NATIVE_RETIREMENT_NETWORK_UNCONFIRMED');
 const network=await docker.inspectPrivateNetwork(networkId);
 if(network){
  const labels=network.Labels,containers=network.Containers;
  if(network.Id!==networkId||network.Name!=='ac-native-exec-'+jobId||network.Internal!==true||
   !labels||labels['agent-control.contract']!=='native-execution-v1'||labels['agent-control.job']!==jobId||labels['agent-control.launch']!==inputDigest||
   !containers||typeof containers!=='object'||Array.isArray(containers)||Object.keys(containers).length!==0)
   throw new Refusal('NATIVE_RETIREMENT_NETWORK_UNCONFIRMED');
  if(apply)await docker.removePrivateNetwork(networkId);
 }
 if(apply&&await docker.inspectPrivateNetwork(networkId))throw new Refusal('NATIVE_RETIREMENT_NETWORK_UNCONFIRMED');
}

/** Candidate filter shared by maintenance and the generic grant sweep. Full scope is checked under lock. */
export const orphanedExamIntentSql=`(j.role IN ('specialist','reviewer') AND
 (i.command->'payload'->>'workflow'='security-verify-readonly-v1' OR
  (i.command->'payload'->>'workflow'='design-readonly-v1' AND i.command->'payload'->>'messageRef' LIKE 'design-exam:%')))`;
/** Specialist or reviewer of the readonly security exam. Programmer, qa and judge never match. */
export function readonlySecurityExam(workflow:unknown,role:unknown):boolean{
 return workflow==='security-verify-readonly-v1'&&(role==='specialist'||role==='reviewer');
}
/** Personal design or security exam. Programmer, qa, judge and locked mode never match. */
export function readonlyExamIsolation(personal:unknown,workflow:unknown,role:unknown):boolean{
 return Boolean(personal)&&(readonlyDesignExam(workflow,role)||readonlySecurityExam(workflow,role));
}
/** Personal design exam only. Security exams, other roles and locked mode do not stage captures. */
export function stageDesignExamCaptures(personal:unknown,workflow:unknown,role:unknown):boolean{
 return Boolean(personal)&&readonlyDesignExam(workflow,role);
}
export function dockerUncertain(error:unknown){return error instanceof Refusal&&error.code.startsWith('DOCKER_')&&error.code!=='DOCKER_CREATE_REFUSED';}
export type NativeExecutionRecovery={state:'uncertain'|'released_unstarted'|'acknowledged';interval:'docker_response_lost'|'before_terminal_evidence'|'network_or_container_remains'|'supervisor_identity'|'proven_not_started'|'terminal_evidence_missing'|'ack_lost'|'network_unproven';grant:'preserved'|'released';removed:string[];replayed:false;receipt?:unknown};
