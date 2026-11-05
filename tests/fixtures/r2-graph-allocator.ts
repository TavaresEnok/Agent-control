import {execFileSync} from 'node:child_process';
import {randomInt} from 'node:crypto';
import {mock} from 'node:test';
import {DockerDaemon} from '../../src/sandbox-broker.ts';

// Fixture-only address allocation; Docker still creates and inspects real networks.
export function installGraphAllocator(){
 mock.method(DockerDaemon.prototype,'createPrivateNetwork',async function(name:string,labels:Record<string,string>){
  if(!/^ac-native-exec-[a-f0-9-]{36}$/.test(name)||labels['agent-control.job']!==name.slice('ac-native-exec-'.length))throw Error('GRAPH_ALLOCATOR_IDENTITY');
  const ids=execFileSync('docker',['network','ls','-q'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
  const networks=ids.length?JSON.parse(execFileSync('docker',['network','inspect',...ids],{encoding:'utf8'})):[];
  const ip=(s:string)=>s.split('.').reduce((n,x)=>(n*256+Number(x))>>>0,0);
  const ranges=networks.flatMap((n:any)=>(n.IPAM?.Config??[]).map((c:any)=>c.Subnet).filter((s:any)=>typeof s==='string'&&s.includes('.')).map((s:string)=>{const [addr,bits]=s.split('/');const mask=Number(bits)===0?0:(0xffffffff<<(32-Number(bits)))>>>0;const low=(ip(addr!)&mask)>>>0;return [low,(low|~mask)>>>0];}));
  const start=randomInt(4096);for(let offset=0;offset<4096;offset++){
   const index=(start+offset)%4096,third=Math.floor(index/16),fourth=(index%16)*16,low=ip(`10.252.${third}.${fourth}`);
   if(ranges.some(([a,b]:number[])=>low<=b!&&low+15>=a!))continue;
   const args=['network','create','--internal','--subnet',`10.252.${third}.${fourth}/28`];for(const [key,value] of Object.entries(labels))args.push('--label',`${key}=${value}`);args.push(name);
   const id=execFileSync('docker',args,{encoding:'utf8'}).trim();if(!/^[a-f0-9]{64}$/.test(id))throw Error('GRAPH_ALLOCATOR_INVALID_ID');return id;
  }throw Error('GRAPH_ALLOCATOR_NO_SUBNET');
 });
}
