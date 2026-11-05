import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,mkdir,readFile,readdir,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {DockerDaemon} from '../../src/sandbox-broker.ts';
const exec=promisify(execFile);
export type FlowResourceEnvelope={stateRoot:string;installationId:string;authorityEpoch:number;resourceAuthority:{authorityId:string;anchorId:string;cpuQuotaMicros:number;cpuPeriodMicros:number;memoryBytes:number;pidsLimit:number;maxJobs:number}};
/** The entire helper is disposable fixture provisioning, never operational setup. */
export async function provisionFlowResources(area:string,image:string){
 const provisioningImage=JSON.parse((await exec('docker',['image','inspect','agent-control-ssh-lab:0.1.0'])).stdout)[0].Id as string;assert(/^sha256:[a-f0-9]{64}$/.test(provisioningImage));
 const authorityId='ac-r3-resources-flow-'+randomUUID(),file=join(area,'resources.json'),stateRoot=join(area,'resource-journal');await mkdir(stateRoot,{mode:0o700});
 await exec('/usr/bin/python3',['scripts/r3-provision-resource-authority.py','--lab-provision','--authority',authorityId,'--image',provisioningImage,'--output',file,'--cpu-quota','200000','--memory','1073741824','--pids','256','--jobs','5'],{timeout:45000,maxBuffer:1048576,env:{PATH:process.env.PATH!,HOME:area}});
 const envelope={...JSON.parse(await readFile(file,'utf8')),stateRoot} as FlowResourceEnvelope;
 assert.equal(envelope.resourceAuthority.authorityId,authorityId);return envelope;
}
export function flowResourceParent(envelope:FlowResourceEnvelope){return 'acr'+createHash('sha256').update(envelope.resourceAuthority.authorityId).digest('hex').slice(0,24)+'.slice';}
export async function assertFlowResourceLimits(envelope:FlowResourceEnvelope){
 const root='/sys/fs/cgroup/'+flowResourceParent(envelope),authority=envelope.resourceAuthority;
 assert.equal((await readFile(join(root,'cpu.max'),'utf8')).trim(),authority.cpuQuotaMicros+' '+authority.cpuPeriodMicros);
 assert.equal((await readFile(join(root,'memory.max'),'utf8')).trim(),String(authority.memoryBytes));assert.equal((await readFile(join(root,'pids.max'),'utf8')).trim(),String(authority.pidsLimit));
 return {cpuMax:(await readFile(join(root,'cpu.max'),'utf8')).trim(),memoryMax:Number((await readFile(join(root,'memory.max'),'utf8')).trim()),pidsMax:Number((await readFile(join(root,'pids.max'),'utf8')).trim())};
}
export async function assertFlowResourceMembers(envelope:FlowResourceEnvelope,ids:string[]){
 const docker=new DockerDaemon(),parent=flowResourceParent(envelope);const members=[];
 for(const id of ids){const physical=await docker.inspect(id);assert(physical?.State.Running);assert.equal(physical.HostConfig.CgroupParent,parent);assert.equal(physical.Config.Labels['ac.resources.authority'],envelope.resourceAuthority.authorityId);
  const membersText=await readFile('/sys/fs/cgroup/'+parent+'/docker-'+id+'.scope/cgroup.procs','utf8');assert(membersText.trim().split('\n').includes(String(physical.State.Pid)));members.push(id);
 }
 return members;
}
/** Retire only this freshly generated authority after every native job is absent.
 * Permanent claims are kept until this explicit, owned lab retirement. */
export async function retireFlowResources(envelope:FlowResourceEnvelope,area:string){
 const docker=new DockerDaemon(),authorityId=envelope.resourceAuthority.authorityId;
 assert(authorityId.startsWith('ac-r3-resources-flow-'));const ids=(await exec('docker',['ps','-aq','--no-trunc','--filter','label=ac.resources.authority='+authorityId],{timeout:15000})).stdout.trim().split('\n').filter(Boolean);
 for(const id of ids){const physical=await docker.inspect(id);if(!physical)continue;assert.equal(physical.Config.Labels['ac.resources.authority'],authorityId);assert.equal(physical.HostConfig.CgroupParent,flowResourceParent(envelope));if(physical.State.Running)await docker.stop(id);await docker.remove(id);assert.equal(await docker.inspect(id),null);}
 assert.equal((await exec('docker',['ps','-aq','--filter','label=ac.resources.authority='+authorityId],{timeout:15000})).stdout.trim(),'');
 const directory='/var/tmp/ac-resource-authority-'+process.geteuid!(),digest=createHash('sha256').update(authorityId).digest('hex'),prefix=digest.slice(0,24);
 const pendingSlots=(await readdir(directory)).filter(name=>name.startsWith('reservation-'+prefix+'-'));
 const root='/sys/fs/cgroup/'+flowResourceParent(envelope);let emptyParentRetained=false;const deadline=performance.now()+5000;
 for(;;){try{const events=await readFile(join(root,'cgroup.events'),'utf8');if(/populated 0/.test(events)){emptyParentRetained=true;break;}if(performance.now()>=deadline)throw Error('OWNED_RESOURCE_GROUP_NOT_EMPTY');await new Promise(resolve=>setTimeout(resolve,50));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')break;throw error;}}
 for(const name of await readdir(directory)){
  const path=join(directory,name);const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.geteuid!()||info.nlink!==1||(info.mode&0o777)!==0o600)continue;
  if(name===digest+'.json'||name.startsWith('reservation-'+prefix+'-')){await rm(path);continue;}
  if(/^operation-[a-f0-9]{64}\.json$/.test(name)){const claim=JSON.parse(await readFile(path,'utf8'));if(claim.installationId!==envelope.installationId)continue;assert(typeof claim.stateRoot==='string'&&resolve(claim.stateRoot).startsWith(resolve(area)+sep));await rm(path);}
 }

 const installationDirectory='/var/tmp/ac-resource-installation-'+createHash('sha256').update(envelope.installationId).digest('hex');
 const installationInfo=await lstat(installationDirectory);assert(installationInfo.isDirectory()&&!installationInfo.isSymbolicLink()&&installationInfo.uid===process.geteuid!()&&(installationInfo.mode&0o777)===0o700);
 const binding=JSON.parse(await readFile(join(installationDirectory,'binding.json'),'utf8'));assert.equal(binding.installationId,envelope.installationId);assert.equal(binding.authorityId,authorityId);assert.equal(binding.anchorId,envelope.resourceAuthority.anchorId);
 assert.deepEqual((await readdir(installationDirectory)).sort(),['authority.lock','binding.json']);
 for(const name of ['binding.json','authority.lock']){const path=join(installationDirectory,name),info=await lstat(path);assert(info.isFile()&&!info.isSymbolicLink()&&info.uid===process.geteuid!()&&info.nlink===1&&(info.mode&0o777)===0o600);await rm(path);}await rm(installationDirectory,{recursive:true});
 assert.equal(pendingSlots.length,0,'native terminal cleanup must release every host reservation before lab retirement');
 return {containersRemaining:0,pendingHostReservations:0,ownedAuthorityFilesRetired:true,ownedInstallationBindingRetired:true,emptyParentRetained};
}

/** Bounded diagnostics from this fixture authority only; no commands/config/env. */
export async function snapshotFlowResources(envelope:FlowResourceEnvelope){
 const authorityId=envelope.resourceAuthority.authorityId;assert(authorityId.startsWith('ac-r3-resources-flow-'));
 const ids=(await exec('docker',['ps','-aq','--no-trunc','--filter','label=ac.resources.authority='+authorityId],{timeout:15000})).stdout.trim().split('\n').filter(Boolean);assert(ids.length<=32);
 const docker=new DockerDaemon(),containers=[];for(const id of ids){assert(/^[a-f0-9]{64}$/.test(id));const value=await docker.inspect(id);if(!value)continue;assert.equal(value.Config.Labels['ac.resources.authority'],authorityId);const name=value.Name.replace(/^\//,'');assert(/^[a-z0-9-]{1,160}$/.test(name));containers.push({id,name,status:value.State.Status,running:value.State.Running});}
 const prefix=createHash('sha256').update(authorityId).digest('hex').slice(0,24);const pendingHostReservations=(await readdir('/var/tmp/ac-resource-authority-'+process.geteuid!())).filter(name=>name.startsWith('reservation-'+prefix+'-')).length;
 return {containers,pendingHostReservations};
}
