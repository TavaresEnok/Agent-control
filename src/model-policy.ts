import {Refusal} from './contracts.ts';
/** Explicit historical aliases, with any provider prefix, tag, version or suffix. */
export function modelDisabledByPolicy(model:string):boolean{
 const aliases=['astra','gpt-6-astra','gpt-6.1-astra'];
 return model.trim().toLowerCase().split(/[/:@]/).some(segment=>aliases.some(alias=>segment.trim()===alias||segment.trim().startsWith(alias+'-')));
}
export function assertModelAllowed(model:string){
 if(modelDisabledByPolicy(model))throw new Refusal('ModelDisabledByPolicy',403);
}
