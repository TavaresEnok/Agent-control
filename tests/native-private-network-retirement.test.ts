import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {retireNativePrivateNetwork} from '../src/native-execution-supervisor.ts';

const identity=()=>({networkId:'a'.repeat(64),providerNetworkId:'b'.repeat(64),jobId:randomUUID(),inputDigest:'c'.repeat(64)});
function fixture(){
 const input=identity();let network:Record<string,any>|null={Id:input.networkId,Name:'ac-native-exec-'+input.jobId,Internal:true,
  Labels:{'agent-control.contract':'native-execution-v1','agent-control.job':input.jobId,'agent-control.launch':input.inputDigest},Containers:{}};
 let calls=0,loseAck=false,retain=false;
 const docker={inspectPrivateNetwork:async(id:string)=>{assert.equal(id,input.networkId);return network;},removePrivateNetwork:async(id:string)=>{
  assert.equal(id,input.networkId);calls++;if(!retain)network=null;if(loseAck)throw Error('LOST_ACK');
 }};
 return {input,docker,network:()=>network!,setNetwork:(value:Record<string,any>|null)=>{network=value;},calls:()=>calls,loseAck:()=>{loseAck=true;},restoreAck:()=>{loseAck=false;},retain:()=>{retain=true;}};
}
test('private network removal verifies absence and retries a lost acknowledgement',async()=>{
 const f=fixture();f.loseAck();await assert.rejects(retireNativePrivateNetwork(f.docker,f.input),/LOST_ACK/);
 assert.equal(f.calls(),1);assert.equal(f.network(),null);f.restoreAck();await retireNativePrivateNetwork(f.docker,f.input);assert.equal(f.calls(),1);
});
test('private network remains when identity, isolation or endpoints are unproven',async()=>{
 for(const mutate of [
  (f:ReturnType<typeof fixture>)=>{f.input.networkId=f.input.providerNetworkId;},
  (f:ReturnType<typeof fixture>)=>{f.network().Id='d'.repeat(64);},
  (f:ReturnType<typeof fixture>)=>{f.network().Name='different';},
  (f:ReturnType<typeof fixture>)=>{f.network().Internal=false;},
  (f:ReturnType<typeof fixture>)=>{f.network().Labels['agent-control.contract']='other';},
  (f:ReturnType<typeof fixture>)=>{f.network().Labels['agent-control.job']=randomUUID();},
  (f:ReturnType<typeof fixture>)=>{f.network().Labels['agent-control.launch']='e'.repeat(64);},
  (f:ReturnType<typeof fixture>)=>{f.network().Containers={['f'.repeat(64)]:{Name:'unrelated'}};},
  (f:ReturnType<typeof fixture>)=>{f.network().Containers=null;},
 ]){
  const f=fixture();mutate(f);await assert.rejects(retireNativePrivateNetwork(f.docker,f.input),/NATIVE_RETIREMENT_NETWORK_UNCONFIRMED/);assert.equal(f.calls(),0);
 }
});
test('success acknowledgement without physical absence is uncertain',async()=>{
 const f=fixture();f.retain();await assert.rejects(retireNativePrivateNetwork(f.docker,f.input),/NATIVE_RETIREMENT_NETWORK_UNCONFIRMED/);assert.equal(f.calls(),1);
});
