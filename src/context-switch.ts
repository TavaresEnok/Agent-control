import {Refusal} from './contracts.ts';
import {SemanticPlanning} from './semantic-planning.ts';
import {NativePlanningSupervisor,type NativePlanningSupervisorConfig} from './native-planning-supervisor.ts';
import {assertNativeSyntheticFixture,type NativeSyntheticFixture} from './native-synthetic-fixture.ts';
import type {Ledger} from './ledger.ts';

/** Injection-only lab composition. The capability is issued after Docker image
 * and internal-network inspection and cannot be reconstructed from JSON. Old
 * supervisors remain registered for reconciliation; only one accepts new work. */
export function composeSyntheticContextPlanning(ledger:Ledger,scope:{projectId:string;contextId:string},
 entries:readonly {config:NativePlanningSupervisorConfig;fixture:NativeSyntheticFixture;active:boolean}[]){
 if(!entries.length||entries.length>32||entries.filter(entry=>entry.active).length!==1)throw new Refusal('SYNTHETIC_PLANNING_ROUTE_INVALID');
 const supervisors=entries.map(({config,fixture})=>{
  if(config.syntheticFixture!==fixture)throw new Refusal('SYNTHETIC_FIXTURE_CAPABILITY_INVALID',403);
  assertNativeSyntheticFixture(fixture,{workerImage:config.imageId,toolsImage:config.imageId,providerNetworkId:config.providerNetwork},scope);
  return new NativePlanningSupervisor(ledger,config);
 });
 const planning=new SemanticPlanning(ledger,supervisors.map((supervisor,index)=>({...supervisor.executor,active:entries[index].active})));
 return {planning,supervisors:Object.freeze(supervisors)};
}
