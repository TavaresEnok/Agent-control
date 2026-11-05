import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import {Refusal} from './contracts.ts';
const run=promisify(execFile);
const Spec=z.object({contract:z.literal('native-synthetic-fixture-v1'),projectId:z.uuid(),contextId:z.uuid(),
 provider:z.literal('synthetic-engineering'),label:z.string().regex(/^ac-r3-flow-[a-z0-9-]+$/),
 workerImage:z.string().regex(/^sha256:[a-f0-9]{64}$/),toolsImage:z.string().regex(/^sha256:[a-f0-9]{64}$/),providerNetworkId:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type NativeSyntheticFixture=Readonly<z.infer<typeof Spec>>;
const issued=new WeakSet<object>();
/** Injection-only capability. JSON configuration cannot issue one. Images and
 * the internal, disposable network must carry the same explicit fixture label.
 * Account mode, eligibility, capacity and HOME are still checked by the broker. */
export async function authorizeNativeSyntheticFixture(raw:z.input<typeof Spec>):Promise<NativeSyntheticFixture>{
 const spec=Spec.parse(raw);
 for(const id of new Set([spec.workerImage,spec.toolsImage])){
  const {stdout}=await run('docker',['image','inspect',id],{maxBuffer:1024*1024,timeout:15000});const image=JSON.parse(stdout)[0];
  if(image.Id!==id||image.Config?.Labels?.['agent-control.synthetic-fixture']!==spec.label)throw new Refusal('SYNTHETIC_FIXTURE_IMAGE_REQUIRED');
 }
 const {stdout}=await run('docker',['network','inspect',spec.providerNetworkId],{maxBuffer:1024*1024,timeout:15000});const network=JSON.parse(stdout)[0];
 if(network.Id!==spec.providerNetworkId||network.Internal!==true||network.Labels?.['agent-control.synthetic-fixture']!==spec.label)throw new Refusal('SYNTHETIC_FIXTURE_NETWORK_REQUIRED');
 const capability=Object.freeze(spec);issued.add(capability);return capability;
}
export function assertNativeSyntheticFixture(value:NativeSyntheticFixture,config:{workerImage:string;toolsImage:string;providerNetworkId:string},scope?:{projectId:string;contextId:string}){
 if(!issued.has(value)||value.workerImage!==config.workerImage||value.toolsImage!==config.toolsImage||value.providerNetworkId!==config.providerNetworkId||
  (scope&&(value.projectId!==scope.projectId||value.contextId!==scope.contextId)))throw new Refusal('SYNTHETIC_FIXTURE_CAPABILITY_INVALID',403);
}
