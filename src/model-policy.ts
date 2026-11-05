import {Refusal} from './contracts.ts';
/** Explicit historical aliases only. A provider prefix may use ':' or '/'. */
export function modelDisabledByPolicy(model:string):boolean{
 const normalized=model.trim().toLowerCase().split(/[/:]/).at(-1)?.trim()??'';
 return normalized==='astra'||normalized==='gpt-6-astra'||normalized==='gpt-6.1-astra';
}
export function assertModelAllowed(model:string){
 if(modelDisabledByPolicy(model))throw new Refusal('ModelDisabledByPolicy',403);
}
