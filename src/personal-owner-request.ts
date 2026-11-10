/**
 * Personal mode only. A managed task carries references, not the owner's words, so the programmer
 * and the reviewer would otherwise work from a task id and a file list. The personal conversation
 * binds a resolver here; outside personal mode nothing is bound and every lookup is undefined.
 * The text is the owner's own request, already sent to the planning model for the same purpose.
 */
type Resolver=(intentId:string)=>Promise<string|undefined>;
const resolvers=new Map<string,Resolver>();
export function bindOwnerRequest(contextId:string,resolver:Resolver){
 resolvers.set(contextId,resolver);
 return ()=>{if(resolvers.get(contextId)===resolver)resolvers.delete(contextId);};
}
export async function ownerRequest(contextId:string,intentId:string):Promise<string|undefined>{
 try{const text=await resolvers.get(contextId)?.(intentId);return text?text.slice(0,20000):undefined;}catch{return undefined;}
}
