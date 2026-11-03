import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {assertNativeExecutionIsolation} from '../src/native-execution-isolation.ts';
const id=(s:string)=>s.repeat(64),jobId='b984d985-0170-4755-a7bf-02f0d56a2072';
function fixture(){
 const a=id('a'),b=id('b'),network=id('c'),digest=id('d'),wi='sha256:'+id('e'),ti='sha256:'+id('f');
 const labels={'agent-control.job':jobId,'agent-control.launch':digest};
 const workerMounts=[{source:'/private/account',destination:'/account',writable:true}];
 const toolsMounts=[{source:'/private/job/work',destination:'/work',writable:false}];
 const common={user:'1001:1001',running:false,privileged:false,readOnlyRoot:true,capDropAll:true,noNewPrivileges:true,hostNetwork:false,hostPid:false,hostIpc:false,labels};
 return {facts:{worker:{...common,id:a,image:wi,mounts:workerMounts,networks:[network,'provider']},tools:{...common,id:b,image:ti,mounts:toolsMounts,networks:[network]},
  network:{id:network,internal:true,endpoints:[{containerId:a,address:'172.20.0.2'},{containerId:b,address:'172.20.0.3'}]}},
  expected:{jobId,launchDigest:digest,workerImage:wi,toolsImage:ti,workerUser:'1001:1001',toolsUser:'1001:1001',providerNetwork:'provider',networkId:network,toolsAddress:'172.20.0.3',workerMounts,toolsMounts,role:'reviewer'}};
}
test('accepts only the expected isolated pair and rejects drift',()=>{
 const {facts,expected}=fixture();assert.doesNotThrow(()=>assertNativeExecutionIsolation(facts,expected));
 for(const change of [
  (f:any)=>{f.tools.running=true},(f:any)=>{f.network.internal=false},(f:any)=>{f.tools.networks.push('provider')},
  (f:any)=>{f.network.endpoints[1].containerId=id('9')},(f:any)=>{f.tools.mounts[0].writable=true},
  (f:any)=>{f.tools.mounts.push({source:'/private/job/other',destination:'/work/nested',writable:true})},
  (f:any)=>{f.tools.mounts.push({source:'/private/account',destination:'/stolen',writable:false})},
  (f:any)=>{f.worker.privileged=true},(f:any)=>{f.tools.hostPid=true}
 ]){const copy=structuredClone(facts);change(copy);assert.throws(()=>assertNativeExecutionIsolation(copy,expected));}
});
