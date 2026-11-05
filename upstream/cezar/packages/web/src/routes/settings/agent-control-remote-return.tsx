import {useMutation,useQueryClient} from '@tanstack/react-query'
import {useState} from 'react'
import {z} from 'zod'
import {Button} from '@/components/ui/button'
import {agentControlFetch} from './agent-control-fetch'
import {signControl} from './agent-control-operator'

const hash=z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
export const remoteReturnCandidateSchema=z.object({projectId:z.string().uuid(),contextId:z.string().uuid(),hostId:z.string().uuid(),artifactId:z.string().uuid(),commit:hash,tree:hash,destinationRef:z.string().min(1).max(256),expectedCommit:hash})
export const remoteReturnReceiptSchema=z.object({projectId:z.string().uuid(),artifactId:z.string().uuid(),destinationRef:z.string(),state:z.string()}).passthrough()
const pendingSchema=z.object({semantic:z.string(),intentId:z.string().uuid()}).strict()
type Candidate=z.infer<typeof remoteReturnCandidateSchema>
export const remoteReturnCandidateKey=(candidate:Candidate)=>JSON.stringify(candidate)
/** Persist the exact signed operation across ambiguous responses and reloads. */
export function AgentControlRemoteReturn({principalId,installationId,candidates,receipts}:{principalId:string;installationId:string;candidates:Candidate[];receipts:z.infer<typeof remoteReturnReceiptSchema>[]}){
 const cache=useQueryClient(),[selection,setSelection]=useState('')
 const key=`ac-remote-return:${encodeURIComponent(principalId)}:${installationId}`
 const send=useMutation({mutationFn:async()=>{
  let raw:unknown
  try{raw=JSON.parse(sessionStorage.getItem(key)||'null')}catch{throw Error('PENDING_COMMAND_INVALID')}
  const parsed=pendingSchema.safeParse(raw)
  if(raw!==null&&!parsed.success)throw Error('PENDING_COMMAND_INVALID')
  const saved=parsed.success?parsed.data:null
  const selected=candidates.find(candidate=>remoteReturnCandidateKey(candidate)===selection)
  // A completed operation may disappear from candidates before its ACK arrives.
  const resumed=saved?remoteReturnCandidateSchema.parse(JSON.parse(saved.semantic)):null
  const target=selected??(saved&&(!selection||selection===saved.semantic)?resumed:null)
  if(!target)throw Error('ARTIFACT_REQUIRED')
  const semantic=remoteReturnCandidateKey(target)
  if(saved&&saved.semantic!==semantic)throw Error('PENDING_COMMAND_DIFFERENT')
  const intentId=saved?.intentId??crypto.randomUUID()
  const command={schemaVersion:1,intentId,deliveryAttemptId:crypto.randomUUID(),action:'project.returnRemoteArtifact',payload:{projectId:target.projectId,contextId:target.contextId,hostId:target.hostId,artifactId:target.artifactId,destinationRef:target.destinationRef}}
  const proof=await signControl(principalId,command,installationId)
  sessionStorage.setItem(key,JSON.stringify({semantic,intentId}))
  const response=await agentControlFetch('/api/v1/ac/project-admin/remote-return',{method:'POST',headers:{'content-type':'application/json','x-ac-operator-proof':proof},body:JSON.stringify(command)})
  const value:unknown=await response.json()
  if(!response.ok){const error=z.object({error:z.string()}).safeParse(value);throw Error(error.success?error.data.error:`HTTP_${response.status}`)}
  const result=z.object({state:z.literal('returned'),projectId:z.string().uuid(),artifactId:z.string().uuid(),operationId:z.string().uuid(),destinationRef:z.string()}).parse(value)
  if(result.projectId!==target.projectId||result.artifactId!==target.artifactId||result.operationId!==intentId||result.destinationRef!==target.destinationRef)throw Error('COMMAND_RESPONSE_MISMATCH')
  sessionStorage.removeItem(key)
 },onSuccess:()=>{setSelection('');void cache.invalidateQueries({queryKey:['ac-project-admin']})}})
 const pending=!!sessionStorage.getItem(key)
 return <div className="flex min-w-0 flex-col gap-2 break-words">
  <h3 className="text-sm font-semibold">Devolver artefato à origem SSH</h3>
  <p>Apenas artefatos integrados e aprovados aparecem aqui. A referência remota só avança se ainda apontar ao commit esperado.</p>
  {candidates.length===0&&!pending&&<p role="status">Nenhum artefato aprovado disponível para devolução.</p>}
  {(candidates.length>0||pending)&&<form className="flex min-w-0 flex-col gap-2" onSubmit={event=>{event.preventDefault();send.mutate()}}>
   <label className="flex min-w-0 flex-col gap-1">Artefato aprovado<select aria-label="Artefato aprovado" className="min-h-11 min-w-0 max-w-full rounded-md border px-2" value={selection} onChange={event=>setSelection(event.target.value)} disabled={send.isPending}>
    <option value="">{pending?'Retomar envio anterior':'Selecione um artefato'}</option>
    {candidates.map(candidate=><option key={remoteReturnCandidateKey(candidate)} value={remoteReturnCandidateKey(candidate)}>{candidate.artifactId} — {candidate.destinationRef}</option>)}
   </select></label>
   {candidates.filter(candidate=>remoteReturnCandidateKey(candidate)===selection).map(candidate=><p key={remoteReturnCandidateKey(candidate)} className="break-all text-xs">Commit {candidate.commit}; origem esperada {candidate.expectedCommit}; destino {candidate.destinationRef}</p>)}
   {pending&&<p role="status">Envio anterior pendente de confirmação. Retome a mesma operação; a devolução não pode ser descartada daqui.</p>}
   <Button className="min-h-11" type="submit" disabled={send.isPending||(!selection&&!pending)}>{pending?'Confirmar devolução pendente':'Devolver artefato aprovado'}</Button>
  </form>}
  {send.error&&<p role="alert">{send.error.message}</p>}
  {send.isSuccess&&<p role="status">Devolução confirmada e persistida.</p>}
  {receipts.map((receipt,index)=><p key={`${receipt.artifactId}:${index}`} className="break-all">Devolução {receipt.artifactId}: {receipt.state}; {receipt.destinationRef}</p>)}
 </div>
}
