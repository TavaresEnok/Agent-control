import {request} from 'node:http';
import {z} from 'zod';
import {Refusal} from './contracts.ts';
import {assertNativeExecutionIsolation} from './native-execution-isolation.ts';

const Id=z.string().regex(/^[a-f0-9]{64}$/);
const Container=z.object({Id,Image:z.string(),Config:z.object({User:z.string(),Labels:z.record(z.string(),z.string()),Entrypoint:z.array(z.string()).nullable(),Cmd:z.array(z.string()).nullable(),Env:z.array(z.string()).nullable(),WorkingDir:z.string()}),
 State:z.object({Status:z.string(),Running:z.boolean()}),HostConfig:z.object({NetworkMode:z.string(),PidMode:z.string(),IpcMode:z.string(),
 Privileged:z.boolean(),ReadonlyRootfs:z.boolean(),CapDrop:z.array(z.string()).nullable(),CapAdd:z.array(z.string()).nullable(),SecurityOpt:z.array(z.string()).nullable(),
 Devices:z.array(z.unknown()).nullable(),
 PidsLimit:z.number().nullable(),Memory:z.number(),NanoCpus:z.number(),PortBindings:z.record(z.string(),z.unknown()).nullable()}),
 Mounts:z.array(z.object({Type:z.string(),Source:z.string(),Destination:z.string(),RW:z.boolean()})),
 NetworkSettings:z.object({Networks:z.record(z.string(),z.object({NetworkID:Id,IPAddress:z.string()}))})});
const Network=z.object({Id,Internal:z.boolean(),Containers:z.record(z.string(),z.object({IPv4Address:z.string()})).nullable()});
type Container=z.infer<typeof Container>;
const Rules=z.object({workerEntrypoint:z.array(z.string()).min(1),toolsEntrypoint:z.array(z.string()).min(1),
 workerCmd:z.array(z.string()),toolsCmd:z.array(z.string()),workerEnv:z.array(z.string()),toolsEnv:z.array(z.string()),workerWorkingDir:z.string().startsWith('/'),toolsWorkingDir:z.string().startsWith('/'),
 workerMemory:z.number().int().positive(),toolsMemory:z.number().int().positive(),workerPids:z.number().int().positive(),toolsPids:z.number().int().positive(),
 workerNanoCpus:z.number().int().positive(),toolsNanoCpus:z.number().int().positive()}).strict();
function exact(a:string[]|null,b:string[]){return JSON.stringify(a??[])===JSON.stringify(b);}
function convert(c:Container){
 const h=c.HostConfig;
 return {id:c.Id,image:c.Image,user:c.Config.User,running:c.State.Running,privileged:h.Privileged,readOnlyRoot:h.ReadonlyRootfs,
  capDropAll:h.CapDrop?.includes('ALL')===true,noNewPrivileges:h.SecurityOpt?.some(s=>s==='no-new-privileges'||s==='no-new-privileges:true')===true,
  hostNetwork:h.NetworkMode==='host',hostPid:h.PidMode==='host',hostIpc:h.IpcMode==='host',
  mounts:c.Mounts.map(m=>({source:m.Source,destination:m.Destination,writable:m.RW})),
  networks:Object.values(c.NetworkSettings.Networks).map(n=>n.NetworkID),labels:c.Config.Labels};
}
/** Read only. Expected ids, mount paths, commands and limits must originate in
 * the trusted broker configuration and journal, never in an agent request. */
export async function inspectNativeExecutionPair(read:(path:string)=>Promise<unknown>,ids:{worker:string;tools:string;network:string},expected:unknown,rulesInput:unknown){
 const wId=Id.parse(ids.worker),tId=Id.parse(ids.tools),nId=Id.parse(ids.network),rules=Rules.parse(rulesInput);
 const [worker,tools,network]=await Promise.all([
  read(`/v1.44/containers/${wId}/json`).then(v=>Container.parse(v)),
  read(`/v1.44/containers/${tId}/json`).then(v=>Container.parse(v)),
  read(`/v1.44/networks/${nId}`).then(v=>Network.parse(v))]);
 if(worker.Id!==wId||tools.Id!==tId||network.Id!==nId)throw new Refusal('NATIVE_EXECUTION_INSPECTION_MISMATCH');
 for(const [c,entry,cmd,env,cwd,memory,pids,cpu] of [
  [worker,rules.workerEntrypoint,rules.workerCmd,rules.workerEnv,rules.workerWorkingDir,rules.workerMemory,rules.workerPids,rules.workerNanoCpus],
  [tools,rules.toolsEntrypoint,rules.toolsCmd,rules.toolsEnv,rules.toolsWorkingDir,rules.toolsMemory,rules.toolsPids,rules.toolsNanoCpus]
 ] as const){
  const h=c.HostConfig;
  if(c.State.Status!=='created'||c.State.Running||!exact(c.Config.Entrypoint,entry)||!exact(c.Config.Cmd,cmd)||!exact(c.Config.Env,env)||c.Config.WorkingDir!==cwd||
   h.Memory!==memory||h.PidsLimit!==pids||h.NanoCpus!==cpu||Object.keys(h.PortBindings??{}).length!==0||
   c.Mounts.some(m=>m.Type!=='bind')||(h.CapAdd?.length??0)>0||(h.Devices?.length??0)>0||
   !['','private'].includes(h.PidMode)||!['','private'].includes(h.IpcMode)||h.SecurityOpt?.some(s=>s.startsWith('seccomp=unconfined')||s.startsWith('apparmor=unconfined'))||
   h.NetworkMode==='host'||h.NetworkMode.startsWith('container:'))throw new Refusal('NATIVE_EXECUTION_INSPECTION_MISMATCH');
 }
 const endpoints=Object.entries(network.Containers??{}).map(([containerId,value])=>({containerId,address:value.IPv4Address.split('/')[0]}));
 for(const c of [worker,tools]){
  const address=Object.values(c.NetworkSettings.Networks).find(x=>x.NetworkID===nId)?.IPAddress;
  if(!address||endpoints.find(x=>x.containerId===c.Id)?.address!==address)throw new Refusal('NATIVE_EXECUTION_INSPECTION_MISMATCH');
 }
 const facts={worker:convert(worker),tools:convert(tools),network:{id:network.Id,internal:network.Internal,endpoints}};
 assertNativeExecutionIsolation(facts,expected);
 return facts;
}
/** Unix socket access is read-only and limited to fixed Docker GET routes. */
export function dockerReadOnly(socketPath:string){
 if(!socketPath.startsWith('/')||socketPath.includes('\0'))throw new Refusal('DOCKER_SOCKET_INVALID');
 return (path:string)=>new Promise<unknown>((ok,fail)=>{
  if(!/^\/v1\.44\/(?:containers\/[a-f0-9]{64}\/json|networks\/[a-f0-9]{64})$/.test(path)){fail(new Refusal('DOCKER_READ_FORBIDDEN'));return;}
  const req=request({socketPath,method:'GET',path,timeout:5000},res=>{
   const chunks:Buffer[]=[];let size=0;
   res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1048576){req.destroy();fail(new Refusal('DOCKER_RESPONSE_TOO_LARGE'));}else chunks.push(chunk);});
   res.on('end',()=>{if(res.statusCode!==200){fail(new Refusal('DOCKER_UNCERTAIN'));return;}try{ok(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{fail(new Refusal('DOCKER_RESPONSE_INVALID'));}});
   res.on('error',()=>fail(new Refusal('DOCKER_UNCERTAIN')));
  });
  req.on('timeout',()=>req.destroy());req.on('error',()=>fail(new Refusal('DOCKER_UNCERTAIN')));req.end();
 });
}
