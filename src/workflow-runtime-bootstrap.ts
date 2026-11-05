import {z} from 'zod';
import {createLocalWorkflowRuntime,verifyLocalWorkflowRuntime,type LocalWorkflowRuntime} from './local-workflow-runtime.ts';
import {WorkflowGenerations} from './workflow-generations.ts';
import type {Ledger} from './ledger.ts';

/** Registration is deliberately separate from selecting a default or handing
 * off a running graph. Configuration cannot assert a build identity. */
export const WorkflowRuntimeRegistrationConfig=z.object({state:z.literal('registered-inactive')}).strict();
export async function prepareWorkflowRuntimeRegistration(config:z.infer<typeof WorkflowRuntimeRegistrationConfig>|undefined){
 if(!config)return undefined;
 WorkflowRuntimeRegistrationConfig.parse(config);
 return createLocalWorkflowRuntime();
}
export async function startWorkflowRuntimeRegistration(ledger:Ledger,capability:LocalWorkflowRuntime,
 projects:readonly {id:string;owner:string}[],onFailure:()=>void=()=>{}){
 if(!ledger.runtimeIdentity||ledger.runtimeIdentity.instanceId!==capability.identity.instanceId||ledger.runtimeIdentity.buildId!==capability.identity.buildId)
  throw Error('WORKFLOW_RUNTIME_BOOTSTRAP_IDENTITY_MISMATCH');
 await verifyLocalWorkflowRuntime(capability);
 const service=new WorkflowGenerations(ledger);
 const owned=new Map<string,string>();let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
 let pending:Promise<void>=Promise.resolve();
 const announce=async()=>{for(const [id,owner] of owned)await service.announce(owner,id,capability,30);};
 // A revoked project must not starve leases for unrelated authorized projects.
 // Startup remains atomic/fail-closed; recurring renewals isolate each failure.
 const renew=async()=>{let failed=false;for(const [id,owner] of owned){try{await service.announce(owner,id,capability,30);}catch{failed=true;}}
  if(failed){try{onFailure();}catch{/* Reporting cannot abort future renewals. */}}};
 const schedule=()=>{if(stopped)return;timer=setTimeout(()=>{pending=renew().finally(schedule);},10000);timer.unref();};
 try{
  for(const project of projects){if(owned.has(project.id))throw Error('DUPLICATE_RUNTIME_PROJECT');owned.set(project.id,project.owner);}
  await announce();schedule();
 }catch(error){
  await ledger.pool.query('UPDATE ac_workflow_runtime_instances SET lease_until=clock_timestamp() WHERE instance_id=$1 AND build_id=$2',[capability.identity.instanceId,capability.identity.buildId]);
  throw error;
 }
 return {
  report:{state:'registered-inactive' as const,buildId:capability.identity.buildId,automaticSelection:false as const,automaticDispatch:false as const},
  async close(){if(stopped)return;stopped=true;clearTimeout(timer);await pending;
   await ledger.pool.query('UPDATE ac_workflow_runtime_instances SET lease_until=clock_timestamp() WHERE instance_id=$1 AND build_id=$2',[capability.identity.instanceId,capability.identity.buildId]);},
 };
}
