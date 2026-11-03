import {z} from 'zod';
import {isAbsolute,resolve,sep} from 'node:path';
import {isPrivateToolAddress} from './native-tool-forwarder.ts';
import {Refusal} from './contracts.ts';

// Facts must be collected by the supervisor directly from Docker inspection,
// after creation and before any agent can run. They are never model input.
const Id=z.string().regex(/^[a-f0-9]{64}$/), Image=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Mount=z.object({source:z.string().min(1),destination:z.string().startsWith('/'),writable:z.boolean()}).strict();
const Container=z.object({id:Id,image:Image,user:z.string().regex(/^[1-9][0-9]*:[1-9][0-9]*$/),running:z.boolean(),
 privileged:z.boolean(),readOnlyRoot:z.boolean(),capDropAll:z.boolean(),noNewPrivileges:z.boolean(),
 hostNetwork:z.boolean(),hostPid:z.boolean(),hostIpc:z.boolean(),mounts:z.array(Mount).max(20),
 networks:z.array(z.string().min(1)).min(1).max(2),labels:z.record(z.string(),z.string())}).strict();
const Facts=z.object({worker:Container,tools:Container,network:z.object({id:Id,internal:z.boolean(),
 endpoints:z.array(z.object({containerId:Id,address:z.string()}).strict()).length(2)}).strict()}).strict();
const Expected=z.object({jobId:z.uuid(),launchDigest:z.string().regex(/^[a-f0-9]{64}$/),workerImage:Image,toolsImage:Image,
 workerUser:z.string().regex(/^[1-9][0-9]*:[1-9][0-9]*$/),toolsUser:z.string().regex(/^[1-9][0-9]*:[1-9][0-9]*$/),
 providerNetwork:z.string().min(1),networkId:Id,toolsAddress:z.string().refine(isPrivateToolAddress),
 workerMounts:z.array(Mount).min(1).max(20),toolsMounts:z.array(Mount).min(1).max(20),role:z.enum(['programmer','qa','reviewer','judge','specialist']),phase:z.enum(['created','gated-running']).default('created')}).strict();
/** Docker proves the process never started only with an explicit created state.
 * A missing pid or start time is not proof and must not release a grant. */
export function nativeContainerNeverStarted(state:{Status?:unknown;Running?:unknown;Pid?:unknown;StartedAt?:unknown}):boolean{
 return state.Status==='created'&&state.Running===false&&state.Pid===0&&(state.StartedAt===''||(typeof state.StartedAt==='string'&&state.StartedAt.startsWith('0001-')));
}
function sameStrings(a:string[],b:string[]){return a.length===b.length&&new Set(a).size===a.length&&a.every(x=>b.includes(x));}
function mountsEqual(a:z.infer<typeof Mount>[],b:z.infer<typeof Mount>[]){
 const key=(m:z.infer<typeof Mount>)=>JSON.stringify([m.source,m.destination,m.writable]);
 return sameStrings(a.map(key),b.map(key))&&new Set(a.map(m=>m.destination)).size===a.length;
}
/** Fail closed on a cross-job connection, unexpected mount or container drift.
 * This is a verification primitive, not a Docker supervisor or a sandbox:
 * the caller must use fresh trusted observations, fence scheduling and verify
 * no process ran before verification; future network changes must be prevented. */
export function assertNativeExecutionIsolation(rawFacts:unknown,rawExpected:unknown):void{
 const f=Facts.parse(rawFacts),e=Expected.parse(rawExpected),w=f.worker,t=f.tools;
 const refuse=()=>{throw new Refusal('NATIVE_EXECUTION_ISOLATION_MISMATCH');};
 if(w.id===t.id||w.image!==e.workerImage||t.image!==e.toolsImage||w.user!==e.workerUser||t.user!==e.toolsUser||
  f.network.id!==e.networkId||!f.network.internal||e.providerNetwork===e.networkId||
  (e.phase==='created'?(w.running||t.running):(!w.running||!t.running)))refuse();
 for(const c of [w,t]){
  if(c.privileged||!c.readOnlyRoot||!c.capDropAll||!c.noNewPrivileges||c.hostNetwork||c.hostPid||c.hostIpc||
    c.labels['agent-control.job']!==e.jobId||c.labels['agent-control.launch']!==e.launchDigest)refuse();
 }
 if(!sameStrings(w.networks,[e.networkId,e.providerNetwork])||!sameStrings(t.networks,[e.networkId])||
  !mountsEqual(w.mounts,e.workerMounts)||!mountsEqual(t.mounts,e.toolsMounts))refuse();
 const endpoints=f.network.endpoints;
 if(!sameStrings(endpoints.map(x=>x.containerId),[w.id,t.id])||
  endpoints.find(x=>x.containerId===t.id)?.address!==e.toolsAddress||
  endpoints.some(x=>!isPrivateToolAddress(x.address))||endpoints[0]!.address===endpoints[1]!.address)refuse();
 // Worktree mount is mandatory and physically read-only for independent roles.
 const work=t.mounts.find(m=>m.destination==='/work');
 if(!work||(e.role!=='programmer'&&t.mounts.some(m=>m.writable&&(m.destination==='/work'||m.destination.startsWith('/work/')))))refuse();
 // A tools container cannot receive the worker's provider home or its input,
 // output, credential or signing-key mounts, even under an unexpected path.
 const overlap=(a:string,b:string)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep);
 if([...w.mounts,...t.mounts].some(m=>!isAbsolute(m.source)||m.source===sep||resolve(m.source)!==m.source||resolve(m.destination)!==m.destination)||
  t.mounts.some(m=>w.mounts.some(n=>overlap(m.source,n.source))||m.source==='/var/run/docker.sock'||m.destination==='/var/run/docker.sock'))refuse();
}
