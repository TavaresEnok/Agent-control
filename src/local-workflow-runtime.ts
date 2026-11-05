import {randomUUID,createHash} from 'node:crypto';
import {readFile,realpath,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {extname,join} from 'node:path';
import {workflowVersionRegistry,resolveFrozenWorkflow} from './workflow-versions.ts';
import {digest,Refusal} from './contracts.ts';

/** Exact snapshot compatibility only; this protocol never upgrades a workflow
 * definition or translates Cezar graph state between schema versions. */
export const GENERATION_COMPATIBILITY='cezar-frozen-graph-generation-v1';
const root=fileURLToPath(new URL('../',import.meta.url)),extension=extname(fileURLToPath(import.meta.url));
async function packageFiles(folder:string,suffix:string):Promise<string[]>{
 const result:string[]=[];for(const entry of await readdir(join(root,folder),{withFileTypes:true})){
  const name=folder+'/'+entry.name;if(entry.isDirectory())result.push(...await packageFiles(name,suffix));else if(entry.isFile()&&name.endsWith(suffix))result.push(name);
 }return result.sort();
}
let executableHash:Promise<string>|undefined;
const capabilities=new WeakMap<object,LocalRuntimeEvidence>();
export type LocalRuntimeEvidence={identity:{instanceId:string;buildId:string};executableDigest:string;runtimeDigest:string;processId:number;processStart:string;protocol:typeof GENERATION_COMPATIBILITY;workflowDigests:string[]};
export type LocalWorkflowRuntime={readonly identity:{readonly instanceId:string;readonly buildId:string}};
async function measured(){
 const executable=await realpath(process.execPath),observed=await realpath('/proc/self/exe');if(executable!==observed)throw new Refusal('RUNTIME_EXECUTABLE_IDENTITY_MISMATCH');
 const executableDigest=await (executableHash??=readFile(executable).then(bytes=>createHash('sha256').update(bytes).digest('hex')));
 const files=[...await packageFiles('src',extension),...await packageFiles('upstream/cezar/packages/cezar/dist','.js')].sort();
 const hashes=[];for(const name of files)hashes.push([name,createHash('sha256').update(await readFile(join(root,name))).digest('hex')]);
 const runtimeDigest=digest({protocol:GENERATION_COMPATIBILITY,executableDigest,files:hashes});
 const stat=await readFile('/proc/self/stat','utf8'),processStart=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19];
 if(!processStart||!/^\d+$/.test(processStart))throw new Refusal('RUNTIME_PROCESS_IDENTITY_UNAVAILABLE');
 return {executableDigest,runtimeDigest,processStart};
}
let loadedMeasurement:ReturnType<typeof measured>|undefined;
/** Local bootstrap only. No caller-supplied build, workflow list, PID or
 * executable declaration is accepted. The capability cannot cross HTTP/JSON. */
export async function createLocalWorkflowRuntime(instanceId=randomUUID(),frozen:readonly Parameters<typeof resolveFrozenWorkflow>[0][]=[]):Promise<LocalWorkflowRuntime>{
 if(frozen.length>256)throw new Refusal('RUNTIME_SNAPSHOT_COMPATIBILITY_LIMIT');
 const compatible=[];for(const input of frozen){const decision=resolveFrozenWorkflow(input);if(!decision.ok)throw new Refusal('RUNTIME_SNAPSHOT_INCOMPATIBLE');compatible.push(decision.digest);}
 const evidence=await (loadedMeasurement??=measured()),identity=Object.freeze({instanceId,buildId:'cezar-'+evidence.runtimeDigest.slice(0,32)});
 const value=Object.freeze({identity});capabilities.set(value,{...evidence,identity,processId:process.pid,protocol:GENERATION_COMPATIBILITY,workflowDigests:[...new Set([...workflowVersionRegistry.map(x=>x.digest),...compatible])].sort()});return value;
}
export async function verifyLocalWorkflowRuntime(value:LocalWorkflowRuntime):Promise<LocalRuntimeEvidence>{
 const known=capabilities.get(value);if(!known)throw new Refusal('LOCAL_RUNTIME_CAPABILITY_REQUIRED');
 const current=await measured();if(current.runtimeDigest!==known.runtimeDigest||current.processStart!==known.processStart)throw new Refusal('LOCAL_RUNTIME_BYTES_CHANGED');
 return known;
}
/** Guards use the bytes of this loaded package, not an arbitrary build label. */
export async function assertLoadedRuntime(buildId:string,processId:number,processStart:string){
 const current=await (loadedMeasurement??=measured());if(buildId!=='cezar-'+current.runtimeDigest.slice(0,32)||processId!==process.pid||processStart!==current.processStart)throw new Refusal('WORKFLOW_RUNTIME_PROCESS_MISMATCH');
}
export async function registeredProcessAlive(processId:number,processStart:string){
 try{const stat=await readFile('/proc/'+processId+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);return fields[19]===processStart&&!['Z','X'].includes(fields[0]);}catch{return false;}
}
export async function assertCurrentRuntimeBuild(buildId:string){
 const current=await (loadedMeasurement??=measured());if(buildId!=='cezar-'+current.runtimeDigest.slice(0,32))throw new Refusal('CEZAR_RUNTIME_PACKAGE_MISMATCH');
}
