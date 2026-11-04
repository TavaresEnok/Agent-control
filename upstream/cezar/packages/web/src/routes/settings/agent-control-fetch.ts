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

/** Viewports 360 and 390. Desktop widths do not match. */
export const narrowManagerPlanQuery='(max-width: 390px)'
/** WCAG 2.5.5 / platform touch minimum used by the narrow plan path. */
export const managerPlanTouchMinPx=44
const proposalDigestPattern=/^[a-f0-9]{64}$/

export type DisplayedProposalIdentity={
 revision:number
 digest:string
 objectiveRef:string
 sourceMessageRef:string
}

/** Returns the digest unchanged. A prefix, ellipsis or other shortening is rejected. */
export function displayedProposalDigest(digest:string):string{
 if(!proposalDigestPattern.test(digest))throw Error('PROPOSAL_DIGEST_AMBIGUOUS')
 return digest
}

export function displayedProposalIdentity(preview:{revision:number;digest:string;plan:{objectiveRef:string;sourceMessageRef:string}}):DisplayedProposalIdentity{
 return {revision:preview.revision,digest:displayedProposalDigest(preview.digest),objectiveRef:preview.plan.objectiveRef,sourceMessageRef:preview.plan.sourceMessageRef}
}

export function proposalMatchesSummary(identity:DisplayedProposalIdentity,summary:{revision:number;digest:string}):boolean{
 return identity.revision===summary.revision&&identity.digest===summary.digest
}

/** Payload for plan.start, taken only from the identity that is on screen. */
export function planStartPayload(identity:DisplayedProposalIdentity){
 return {workflow:'managed-synthetic-v1' as const,messageRef:identity.sourceMessageRef,proposalRevision:identity.revision,proposalDigest:displayedProposalDigest(identity.digest)}
}

/** The preview parsed, but its revision or digest is not the one listed. */
export class ProposalIdentityMismatch extends Error{
 constructor(){
  super('PROPOSAL_IDENTITY_MISMATCH')
  this.name='ProposalIdentityMismatch'
 }
}
export type SettledProposalIdentity=
 | {status:'ready';identity:DisplayedProposalIdentity}
 | {status:'mismatch'}
 | {status:'failed'}

/**
 * Settles every preview on its own. A rejection, including invalid data, stays on that row.
 * The returned rows never include the rejection reason, so a response body cannot surface here.
 */
export async function settleDisplayedProposalIdentities(loads:ReadonlyArray<() => Promise<DisplayedProposalIdentity>>):Promise<SettledProposalIdentity[]>{
 const settled=await Promise.allSettled(loads.map(load=>load()))
 return settled.map(result=>{
  if(result.status==='fulfilled')return {status:'ready',identity:result.value}
  if(result.reason instanceof ProposalIdentityMismatch)return {status:'mismatch'}
  return {status:'failed'}
 })
}

/** Shown when plan.start fails for a reason this screen does not recognize. */
export const planStartGenericError='Não foi possível solicitar a execução desta proposta.'

/**
 * Exact codes this screen may show. The value is a fixed string, never the raw server text.
 * A token glued to a known code does not match and falls back to the generic message.
 */
const planStartRecognizedErrors:Readonly<Record<string,string>>={
 MANAGER_UNAVAILABLE:'MANAGER_UNAVAILABLE',
 AUTH_REQUIRED:'AUTH_REQUIRED',
 REQUEST_BODY_TOO_LARGE:'REQUEST_BODY_TOO_LARGE',
 INVALID_CONTRACT:'INVALID_CONTRACT',
 INTERNAL_ERROR:'INTERNAL_ERROR',
 PROJECT_RUNTIME_MISMATCH:'PROJECT_RUNTIME_MISMATCH',
 PROPOSAL_NOT_READY:'PROPOSAL_NOT_READY',
 PENDING_COMMAND_INVALID:'PENDING_COMMAND_INVALID',
 COMMAND_RESPONSE_MISMATCH:'COMMAND_RESPONSE_MISMATCH',
}

/** Safe text for a plan.start failure. Unrecognized input is not copied into the result. */
export function planStartErrorMessage(code:string):string{
 if(Object.prototype.hasOwnProperty.call(planStartRecognizedErrors,code))return planStartRecognizedErrors[code]!
 if(/^HTTP_[1-5]\d{2}$/.test(code))return code
 return planStartGenericError
}
