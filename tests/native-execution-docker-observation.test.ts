import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {inspectNativeExecutionPair,dockerReadOnly} from '../src/native-execution-docker-observation.ts';
const id=(v:string)=>v.repeat(64), w=id('a'),t=id('b'),n=id('c'),provider=id('d'),launch=id('e'),jobId='b984d985-0170-4755-a7bf-02f0d56a2072';
function setup(){
 const workerMounts=[{source:'/private/account',destination:'/account',writable:true}],toolsMounts=[{source:'/private/job/work',destination:'/work',writable:false}];
 const image='sha256:'+id('f');
 function container(cid:string,mounts:typeof workerMounts,networks:Record<string,{NetworkID:string;IPAddress:string}>){return {Id:cid,Image:image,
  Config:{User:'1001:1001',Labels:{'agent-control.job':jobId,'agent-control.launch':launch},Entrypoint:['node','/worker'],Cmd:[],Env:['PATH=/usr/bin'],WorkingDir:'/planning'},
  State:{Status:'created',Running:false},HostConfig:{NetworkMode:n,PidMode:'',IpcMode:'private',Privileged:false,ReadonlyRootfs:true,CapDrop:['ALL'],CapAdd:null,Devices:[],SecurityOpt:['no-new-privileges:true'],PidsLimit:64,Memory:524288000,NanoCpus:1000000000,PortBindings:null},
  Mounts:mounts.map(m=>({Type:'bind',Source:m.source,Destination:m.destination,RW:m.writable})),NetworkSettings:{Networks:networks}};}
 const worker=container(w,workerMounts,{job:{NetworkID:n,IPAddress:'172.20.0.2'},provider:{NetworkID:provider,IPAddress:'172.21.0.2'}});
 const tools=container(t,toolsMounts,{job:{NetworkID:n,IPAddress:'172.20.0.3'}});
 const network={Id:n,Internal:true,Containers:{[w]:{IPv4Address:'172.20.0.2/16'},[t]:{IPv4Address:'172.20.0.3/16'}}};
 const expected={jobId,launchDigest:launch,workerImage:image,toolsImage:image,workerUser:'1001:1001',toolsUser:'1001:1001',providerNetwork:provider,networkId:n,toolsAddress:'172.20.0.3',workerMounts,toolsMounts,role:'reviewer'};
 const rules={workerEntrypoint:['node','/worker'],toolsEntrypoint:['node','/worker'],workerCmd:[],toolsCmd:[],workerEnv:['PATH=/usr/bin'],toolsEnv:['PATH=/usr/bin'],workerWorkingDir:'/planning',toolsWorkingDir:'/planning',workerMemory:524288000,toolsMemory:524288000,workerPids:64,toolsPids:64,workerNanoCpus:1000000000,toolsNanoCpus:1000000000};
 const read=async(path:string)=>path.includes(`/containers/${w}/`)?worker:path.includes(`/containers/${t}/`)?tools:network;
 return {worker,tools,network,expected,rules,read};
}
test('inspection binds created containers and isolated network to trusted expectations',async()=>{
 const f=setup(),ids={worker:w,tools:t,network:n};
 await assert.doesNotReject(()=>inspectNativeExecutionPair(f.read,ids,f.expected,f.rules));
 f.tools.Config.Entrypoint=['/bin/sh'];await assert.rejects(()=>inspectNativeExecutionPair(f.read,ids,f.expected,f.rules));
 f.tools.Config.Entrypoint=['node','/worker'];f.tools.HostConfig.PidMode='container:123';await assert.rejects(()=>inspectNativeExecutionPair(f.read,ids,f.expected,f.rules));
 f.tools.HostConfig.PidMode='';f.network.Internal=false;await assert.rejects(()=>inspectNativeExecutionPair(f.read,ids,f.expected,f.rules));
 await assert.rejects(()=>dockerReadOnly('/tmp/no-socket')('/v1.44/containers/x/stop'));
});
