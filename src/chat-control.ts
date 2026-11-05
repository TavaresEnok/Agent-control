import {z} from 'zod';
import {ControlCommand,type Control,type ControlSessionBinding} from './control.ts';
import {OperatorProof} from './operator.ts';

/** The chat carries a human-signed control command; text/model output cannot mint it. */
export const ChatConfigurationRequest=z.object({command:z.lazy(()=>ControlCommand),proof:OperatorProof}).strict();
export function chatConfigurationHandler(control:Control,binding:ControlSessionBinding){
 return async(raw:unknown)=>{
  const request=ChatConfigurationRequest.parse(raw);
  return control.execute(binding.principal,request.command,request.proof,binding);
 };
}
