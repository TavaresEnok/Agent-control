import {getApiScope} from '@open-mercato/cezar-api-client'
import {z} from 'zod'

/** Project scope is selected by the native route and verified by the gateway. */
export function agentControlFetch(path:string,init:RequestInit={}):Promise<Response>{
 const headers=new Headers(init.headers)
 const projectId=getApiScope()
 if(projectId)headers.set('X-Agent-Control-Project',projectId)
 const response=fetch(path,{...init,headers,credentials:'include'})
 if(isControlPost(path,init))publishControlSubmission(init)
 return response
}

const pendingCommandSchema=z.object({semantic:z.string(),intentId:z.string().uuid()})
const controlSubmissionSchema=z.object({intentId:z.string().min(1),deliveryAttemptId:z.string().min(1),action:z.string().min(1),payload:z.unknown()})

/** Same session key the settings section uses for a signed control command. */
export function agentControlPendingKey(contextId:string){
 return `ac-control-pending:${contextId}`
}

export function integrationApprovalSemantic(payload:{artifactId:string;artifactDigest:string;policyRevision:number;targetRef:string}){
 return JSON.stringify({action:'integration.approve',payload})
}

/**
 * Reuses the intent when the semantic command is unchanged and mints a new delivery id.
 * Corrupt or conflicting storage blocks the resend. The stored record is only the semantic
 * JSON and the intent id — never a proof, header, or credential.
 */
export function agentControlCommandAttempt(storageKey:string,semantic:string):{intentId:string;deliveryAttemptId:string}{
 let raw:unknown=null
 try{raw=JSON.parse(sessionStorage.getItem(storageKey)||'null')}catch{throw Error('PENDING_COMMAND_INVALID')}
 const saved=pendingCommandSchema.safeParse(raw)
 if(raw!==null&&(!saved.success||saved.data.semantic!==semantic))throw Error('PENDING_COMMAND_INVALID')
 const intentId=saved.success&&saved.data.semantic===semantic?saved.data.intentId:crypto.randomUUID()
 sessionStorage.setItem(storageKey,JSON.stringify({semantic,intentId}))
 return {intentId,deliveryAttemptId:crypto.randomUUID()}
}

/** Ids taken from a control POST body. Not persisted and never a proof or credential. */
export type ControlSubmission={intentId:string;deliveryAttemptId:string;action:string;payload:unknown}
const controlListeners=new Set<(submission:ControlSubmission)=>void>()

/** Fires for the body Settings actually posts. Listeners must not read or keep secrets. */
export function subscribeControlSubmissions(listener:(submission:ControlSubmission)=>void){
 controlListeners.add(listener)
 return ()=>{controlListeners.delete(listener)}
}

function isControlPost(path:string,init:RequestInit){
 if((init.method??'GET').toUpperCase()!=='POST')return false
 const pathname=path.startsWith('http')?new URL(path).pathname:path.split('?')[0]
 return pathname==='/api/v1/ac/control'
}

function publishControlSubmission(init:RequestInit){
 if(typeof init.body!=='string')return
 let raw:unknown
 try{raw=JSON.parse(init.body)}catch{return}
 const command=controlSubmissionSchema.safeParse(raw)
 if(!command.success)return
 for(const listener of controlListeners)listener(command.data)
}
