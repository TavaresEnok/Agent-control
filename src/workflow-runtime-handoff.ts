import {realpath} from 'node:fs/promises';
import {Ledger,type Intent} from './ledger.ts';
import {CezarRuntime} from './cezar.ts';
import {WorkflowGenerations} from './workflow-generations.ts';
import {verifyLocalWorkflowRuntime,type LocalWorkflowRuntime} from './local-workflow-runtime.ts';
import {Authority,Refusal} from './contracts.ts';

export type RuntimeMode='administration-only'|'execution';
type RuntimeArguments=ConstructorParameters<typeof CezarRuntime>;
export type HandoffRequest={authority:Authority;intentId:string;expectedGeneration:number;requestId:string;successorManagerInstance:string};
export type HandoffOptions={mode?:RuntimeMode;recoveryAuthority?:Authority;
 /** Existing installation-owned physical reconcilers only. This callback does
  * not grant clearance: the durable quiescence guard still runs afterwards. */
 reconcile?:(runtime:CezarRuntime,authority:Authority)=>Promise<void>};
export type WorkflowRuntimeHandoffResult={runtime:CezarRuntime;authority:Authority;generation:number;requestId:string;mode:RuntimeMode};
export type PreparedWorkflowRuntime={readonly identity:{readonly instanceId:string;readonly buildId:string};readonly projectId:string;readonly repo:string;handoffFrom(source:CezarRuntime,request:HandoffRequest,options?:HandoffOptions):Promise<WorkflowRuntimeHandoffResult>};
const preparedPackages=new WeakMap<object,{capability:LocalWorkflowRuntime;ledger:Ledger;registry:WorkflowGenerations;principal:string;projectId:string;repo:string;
 argumentsFor:(mode:RuntimeMode)=>RuntimeArguments;allowExecution:boolean;completed:Map<string,WorkflowRuntimeHandoffResult>}>();

/** Must be called from the target installed package's own module. Every
 * activation constructs this package's actual Cezar class; callers cannot
 * return an imitation runtime. No worker/process is launched at preparation. */
export async function prepareWorkflowRuntime(input:{ledger:Ledger;capability:LocalWorkflowRuntime;principal:string;
 runtimeArguments:RuntimeArguments|((mode:RuntimeMode)=>RuntimeArguments);allowExecutionActivation?:boolean;leaseSeconds?:number}):Promise<PreparedWorkflowRuntime>{
 if(!(input.ledger instanceof Ledger))throw new Refusal('RUNTIME_PACKAGE_LEDGER_MISMATCH');
 const evidence=await verifyLocalWorkflowRuntime(input.capability),identity=input.ledger.runtimeIdentity;
 if(!identity||identity.instanceId!==evidence.identity.instanceId||identity.buildId!==evidence.identity.buildId)throw new Refusal('RUNTIME_PACKAGE_LEDGER_MISMATCH');
 const argumentsFor=typeof input.runtimeArguments==='function'?input.runtimeArguments:()=>input.runtimeArguments as RuntimeArguments;
 const args=argumentsFor('administration-only');if(args[0]!==input.ledger)throw new Refusal('RUNTIME_PACKAGE_LEDGER_MISMATCH');
 const repo=await realpath(args[1]),projectId=args[2],registry=new WorkflowGenerations(input.ledger);
 await registry.announce(input.principal,projectId,input.capability,input.leaseSeconds??30);
 const value:PreparedWorkflowRuntime={identity:Object.freeze({...identity}),projectId,repo,
  async handoffFrom(source:CezarRuntime,request:HandoffRequest,options:HandoffOptions={}){return handoffWorkflowRuntime(source,value,request,options);}};
 preparedPackages.set(value,{capability:input.capability,ledger:input.ledger,registry,principal:input.principal,projectId,repo,argumentsFor,allowExecution:input.allowExecutionActivation===true,completed:new Map()});
 return Object.freeze(value);
}

/** Explicit local lifecycle action, not an HTTP endpoint, scheduler or deploy.
 * The source is flushed while it still owns the Cezar lock; only the committed
 * epoch transfer can precede its close and the successor's actual lock acquire.
 * A lost local ACK returns the same live activated instance. A process restart
 * can replay the durable request and supply a newly acquired recoveryAuthority.
 */
export async function handoffWorkflowRuntime(source:CezarRuntime,target:PreparedWorkflowRuntime,request:HandoffRequest,options:HandoffOptions={}):Promise<WorkflowRuntimeHandoffResult>{
 const prepared=preparedPackages.get(target);if(!prepared)throw new Refusal('PREPARED_RUNTIME_PACKAGE_REQUIRED');
 const mode=options.mode??'administration-only';if(mode!=='administration-only'&&mode!=='execution')throw new Refusal('INVALID_RUNTIME_MODE');
 if(mode==='execution'&&!prepared.allowExecution)throw new Refusal('RUNTIME_EXECUTION_ACTIVATION_NOT_AUTHORIZED');
 await verifyLocalWorkflowRuntime(prepared.capability);
 await prepared.registry.announce(prepared.principal,prepared.projectId,prepared.capability,30);
 if(source.projectId!==prepared.projectId||await realpath(source.repo)!==prepared.repo)throw new Refusal('RUNTIME_HANDOFF_SCOPE_MISMATCH');
 Authority.parse(request.authority);
 const intent=(await prepared.ledger.pool.query<Intent>('SELECT * FROM ac_intents WHERE id=$1 AND context_id=$2',[request.intentId,request.authority.contextId])).rows[0];
 if(!intent)throw new Refusal('INTENT_SCOPE_MISMATCH',403);
 const previous=prepared.completed.get(request.requestId);
 if(previous?.runtime.ownsRuntimeLock){
  if(previous.mode!==mode)throw new Refusal('RUNTIME_HANDOFF_MODE_CONFLICT');
  await prepared.registry.rollover(prepared.principal,request.authority,{intentId:request.intentId,expectedGeneration:request.expectedGeneration,requestId:request.requestId,targetBuild:target.identity.buildId,successorManagerInstance:request.successorManagerInstance});
  return previous;
 }
 await prepared.registry.approveFrozen(prepared.principal,prepared.projectId,prepared.capability,intent.id);
 const construct=async(requested:RuntimeMode)=>{
  const args=prepared.argumentsFor(requested);
  if(args[0]!==prepared.ledger||args[2]!==prepared.projectId||await realpath(args[1])!==prepared.repo)throw new Refusal('RUNTIME_HANDOFF_SCOPE_MISMATCH');
  const runtime=new CezarRuntime(...args);
  try{await runtime.start(requested);return runtime;}catch(error){await runtime.close();throw error;}
 };
 let administration:CezarRuntime|undefined;
 try{
  const released=(await prepared.ledger.pool.query("SELECT 1 FROM ac_workflow_project_handoffs WHERE project_id=$1 AND request_id=$2 AND state='released'",[prepared.projectId,request.requestId])).rowCount;
  if(released){
   // Validate exact durable replay before touching the existing owner. A live
   // successor keeps the lock and this fresh caller fails without parking it.
   await prepared.registry.rollover(prepared.principal,request.authority,{intentId:request.intentId,expectedGeneration:request.expectedGeneration,requestId:request.requestId,targetBuild:target.identity.buildId,successorManagerInstance:request.successorManagerInstance});
   administration=await construct('administration-only');
  }
  // The project gate excludes fresh effects while quiescence is inspected.
  await prepared.registry.beginProjectHandoff(prepared.principal,prepared.projectId,prepared.capability,request,Boolean(released));
  await prepared.registry.assertProjectContextsQuiescent(prepared.principal,prepared.projectId);
  const replay=(await prepared.ledger.pool.query('SELECT 1 FROM ac_workflow_generations WHERE request_id=$1',[request.requestId])).rowCount;
  if(!replay)await source.flushForGenerationHandoff(intent,request.authority);
  const transfer=await prepared.registry.rollover(prepared.principal,request.authority,{intentId:request.intentId,expectedGeneration:request.expectedGeneration,requestId:request.requestId,targetBuild:target.identity.buildId,successorManagerInstance:request.successorManagerInstance});
  const authority=options.recoveryAuthority?Authority.parse(options.recoveryAuthority):transfer.authority;
  if(authority.contextId!==request.authority.contextId)throw new Refusal('AUTHORITY_SCOPE_MISMATCH',403);
  if(!administration){if(source.ownsRuntimeLock)await source.close();administration=await construct('administration-only');}
  await options.reconcile?.(administration,authority);
  await prepared.registry.reconciled(prepared.principal,authority,intent.id);
  await administration.close();administration=undefined;
  // close() disposes RunManager; create a fresh instance for the final mode.
  const runtime=await construct(mode),result={runtime,authority,generation:transfer.generation,requestId:request.requestId,mode};
  try{await prepared.registry.endProjectHandoff(prepared.principal,prepared.projectId,prepared.capability,request.requestId);}catch(error){await runtime.close();throw error;}
  prepared.completed.set(request.requestId,result);return result;
 }catch(error){await administration?.close();throw error;}
}
