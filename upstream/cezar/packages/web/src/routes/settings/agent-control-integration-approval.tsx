import {useEffect,useRef,useState,useSyncExternalStore,type KeyboardEvent} from 'react'
import {useQuery,useQueryClient,type QueryClient} from '@tanstack/react-query'
import {z} from 'zod'
import {Button} from '@/components/ui/button'
import {agentControlCommandAttempt,agentControlFetch,agentControlPendingKey,integrationApprovalSemantic,subscribeControlSubmissions,type ControlSubmission} from './agent-control-fetch'
import {useProjectScope} from '@/api/project-scope-context'

/** Phone widths covered by the 360 and 390 checks. Wider viewports keep the desktop card. */
export const NARROW_APPROVAL_QUERY='(max-width: 390px)'
const truncatedMessage='A prévia está incompleta. A aprovação pelo painel fica bloqueada até revisão integral por um fluxo homologado.'

export const approvalSchema=z.object({id:z.string().uuid(),commit_id:z.string(),tree_id:z.string(),base_id:z.string(),identity_digest:z.string(),
 policy_revision:z.number(),target_ref:z.string(),approved:z.boolean(),canceled:z.boolean()})
const diffSchema=z.object({artifactId:z.string(),artifactDigest:z.string(),commit:z.string(),tree:z.string(),base:z.string(),diff:z.string(),truncated:z.boolean(),diffSha256:z.string()})
type ApprovalPayload={artifactId:string;artifactDigest:string;policyRevision:number;targetRef:string}
type Attempt={intentId:string;deliveryAttemptId:string}

function subscribeNarrow(onStoreChange:()=>void){
 if(typeof matchMedia!=='function')return ()=>{}
 const media=matchMedia(NARROW_APPROVAL_QUERY)
 media.addEventListener?.('change',onStoreChange)
 return ()=>media.removeEventListener?.('change',onStoreChange)
}
function narrowSnapshot(){
 return typeof matchMedia==='function'&&matchMedia(NARROW_APPROVAL_QUERY).matches
}
function isPromise(value:unknown):value is Promise<unknown>{
 return typeof value==='object'&&value!==null&&typeof (value as {then?:unknown}).then==='function'
}
function samePayload(payload:ApprovalPayload,value:unknown):boolean{
 if(value===null||typeof value!=='object')return false
 const candidate=value as Partial<ApprovalPayload>
 return candidate.artifactId===payload.artifactId&&candidate.artifactDigest===payload.artifactDigest&&candidate.policyRevision===payload.policyRevision&&candidate.targetRef===payload.targetRef
}
function commandVariables(value:unknown):{action?:string;payload?:unknown}|null{
 if(value===null||typeof value!=='object')return null
 return value as {action?:string;payload?:unknown}
}
/** Settings keeps one mutation cache. Each mutate() builds a new entry and returns void. */
function pendingApproval(client:QueryClient,payload:ApprovalPayload){
 return client.getMutationCache().getAll().find(mutation=>{
  const variables=commandVariables(mutation.state.variables)
  return mutation.state.status==='pending'&&variables?.action==='integration.approve'&&samePayload(payload,variables.payload)
 })
}
function mutationMessage(error:unknown){
 return error instanceof Error&&error.message?error.message:'APPROVAL_FAILED'
}
function waitUntilSettled(client:QueryClient,mutation:NonNullable<ReturnType<typeof pendingApproval>>):Promise<string|null>{
 const done=()=>mutation.state.status==='error'?mutationMessage(mutation.state.error):null
 if(mutation.state.status!=='pending')return Promise.resolve(done())
 return new Promise(resolve=>{
  const unsub=client.getMutationCache().subscribe(event=>{
   if(event.mutation!==mutation||event.mutation.state.status==='pending')return
   unsub()
   resolve(done())
  })
  if(mutation.state.status!=='pending'){unsub();resolve(done())}
 })
}
function onKeyActivate(event:KeyboardEvent<HTMLButtonElement>,action:()=>void){
 if(event.key!=='Enter'&&event.key!==' ')return
 if(event.repeat||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return
 event.preventDefault()
 action()
}

export function AgentControlIntegrationApproval({contextId,artifact,canApprove,busy,onApprove}:{contextId:string;artifact:z.infer<typeof approvalSchema>;
 canApprove:boolean;busy:boolean;onApprove:(payload:ApprovalPayload)=>void|Promise<unknown>}){
 const [opened,setOpened]=useState(false)
 const [failure,setFailure]=useState<string|null>(null)
 const [attempt,setAttempt]=useState<Attempt|null>(null)
 const sending=useRef(false)
 const approveRef=useRef<HTMLButtonElement>(null)
 const narrow=useSyncExternalStore(subscribeNarrow,narrowSnapshot,()=>false)
 const queryClient=useQueryClient()
 const {projectId}=useProjectScope()
 const diff=useQuery({queryKey:['ac-artifact-diff',contextId,artifact.id,artifact.identity_digest,projectId],enabled:opened,
  queryFn:async()=>{
   const response=await agentControlFetch(`/api/v1/ac/contexts/${contextId}/artifacts/${artifact.id}/diff`)
   if(!response.ok)throw Error(`DIFF_HTTP_${response.status}`)
   const value=diffSchema.parse(await response.json())
   if(value.artifactId!==artifact.id||value.artifactDigest!==artifact.identity_digest||value.commit!==artifact.commit_id||value.tree!==artifact.tree_id||value.base!==artifact.base_id)throw Error('APPROVAL_ARTIFACT_MISMATCH')
   return value
  }})
 const payload:ApprovalPayload={artifactId:artifact.id,artifactDigest:artifact.identity_digest,policyRevision:artifact.policy_revision,targetRef:artifact.target_ref}
 const truncated=diff.data?.truncated===true
 const blocked=!diff.data||truncated
 const retry=failure==='MANAGER_UNAVAILABLE'
 const approveLabel=retry?'Tentar novamente a aprovação':'Aprovar integração deste commit'
 const truncationId=`approval-preview-truncated-${artifact.id}`
 const errorId=`approval-error-${artifact.id}`
 const status=artifact.canceled?'Plano cancelado; integração bloqueada.':artifact.approved?'Aprovação registrada para este artefato.':'Aguardando aprovação humana para este artefato.'
 useEffect(()=>{
  if(failure==='MANAGER_UNAVAILABLE'&&!busy&&!blocked)approveRef.current?.focus()
 },[failure,attempt?.deliveryAttemptId,busy,blocked])
 function openPreview(){setOpened(true)}
 async function approve(){
  if(sending.current||busy||!canApprove||artifact.approved||artifact.canceled||blocked)return
  sending.current=true
  let submission:ControlSubmission|null=null
  const unsubscribe=subscribeControlSubmissions(command=>{
   if(command.action==='integration.approve'&&samePayload(payload,command.payload))submission=command
  })
  try{
   const reserved=agentControlCommandAttempt(agentControlPendingKey(contextId),integrationApprovalSemantic(payload))
   const result=onApprove(payload)
   if(isPromise(result))await result
   else{
    const pending=pendingApproval(queryClient,payload)
    const transportError=pending?await waitUntilSettled(queryClient,pending):null
    if(transportError)throw Error(transportError)
   }
   setAttempt(submission??reserved)
   setFailure(null)
  }catch(error){
   if(submission)setAttempt(submission)
   const message=mutationMessage(error)
   setFailure(message)
  }finally{
   unsubscribe()
   sending.current=false
  }
 }
 const touch=narrow?{className:'min-h-11 w-full',style:{minHeight:44,minWidth:44}}:{className:undefined,style:undefined}
 const preview=<Button type="button" variant="outline" className={touch.className} style={touch.style}
  aria-label="Ver alterações deste artefato" disabled={diff.isFetching} onClick={openPreview} onKeyDown={event=>onKeyActivate(event,openPreview)}>Ver alterações deste artefato</Button>
 const approveButton=canApprove&&!artifact.approved&&!artifact.canceled?<Button ref={approveRef} type="button" className={touch.className} style={touch.style}
  aria-label={approveLabel} aria-describedby={truncated?truncationId:failure?errorId:undefined} disabled={busy||blocked}
  onClick={()=>void approve()} onKeyDown={event=>onKeyActivate(event,()=>void approve())}>{approveLabel}</Button>:null
 const previewBody=<>
  {diff.error&&<p role="alert">{diff.error.message}</p>}
  {diff.data&&<>
   <pre aria-label="Prévia das alterações" className={`${narrow?'max-h-48':'max-h-80'} overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 text-xs`}>{diff.data.diff||'Nenhuma alteração textual.'}</pre>
   {truncated&&<p id={truncationId} role="alert">{truncatedMessage}</p>}
  </>}
  {failure&&<p id={errorId} role="alert">{failure==='MANAGER_UNAVAILABLE'?'MANAGER_UNAVAILABLE. A tentativa seguinte reutiliza a mesma intenção.':failure}</p>}
 </>
 const attemptMark=attempt?<span className="sr-only" data-approval-intent={attempt.intentId} data-approval-delivery={attempt.deliveryAttemptId}>Intenção registrada para nova tentativa.</span>:null
 if(!narrow)return <div className="flex min-w-0 flex-col gap-2 rounded-md border p-3" data-viewport="desktop">
  <p className="break-all text-sm">Commit {artifact.commit_id} → {artifact.target_ref}</p>
  <p className="break-all text-xs text-muted-foreground">Base {artifact.base_id} · árvore {artifact.tree_id} · política {artifact.policy_revision}</p>
  <p>{status}</p>
  {preview}
  {previewBody}
  {approveButton}
  {attemptMark}
 </div>
 return <section aria-label="Aprovação de integração" className="flex min-w-0 flex-col gap-3 rounded-md border p-3" data-viewport="narrow">
  <p className="break-all text-sm">Commit {artifact.commit_id}</p>
  <dl className="flex flex-col gap-2 text-sm">
   <div><dt>Digest</dt><dd className="break-all">{artifact.identity_digest}</dd></div>
   <div><dt>Política</dt><dd>{artifact.policy_revision}</dd></div>
   <div><dt>Destino</dt><dd className="break-all">{artifact.target_ref}</dd></div>
  </dl>
  <p className="break-all text-xs text-muted-foreground">Base {artifact.base_id} · árvore {artifact.tree_id}</p>
  <p>{status}</p>
  {preview}
  {previewBody}
  {approveButton}
  {attemptMark}
 </section>
}
