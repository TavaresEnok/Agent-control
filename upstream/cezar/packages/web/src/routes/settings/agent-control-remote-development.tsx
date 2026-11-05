import {useMutation,useQueryClient} from '@tanstack/react-query'
import {useState} from 'react'
import {z} from 'zod'
import {Button} from '@/components/ui/button'
import {signControl} from './agent-control-operator'
import {agentControlFetch} from './agent-control-fetch'
import {remoteDevelopmentActionSchema as Semantic,remoteDevelopmentViewSchema,remoteDevelopmentResultSchema as Result} from '../../../../contract/src/agent-control-remote-development'
export {remoteDevelopmentViewSchema}
type Semantic=z.infer<typeof Semantic>
const Pending=z.object({semantic:Semantic,intentId:z.string().uuid(),uncertain:z.boolean()}).strict()
function readPending(key:string){
 let value:unknown;try{value=JSON.parse(sessionStorage.getItem(key)||'null')}catch{throw Error('PENDING_COMMAND_INVALID')}
 return value===null?null:Pending.parse(value)
}
export function AgentControlRemoteDevelopment({principalId,installationId,projectId,view}:{principalId:string;installationId:string;projectId:string;view:z.infer<typeof remoteDevelopmentViewSchema>}){
 const cache=useQueryClient(),[revision,setRevision]=useState(0),[discardable,setDiscardable]=useState(false)
 const key=`ac-remote-development:${encodeURIComponent(principalId)}:${installationId}:${projectId}`
 let pending:z.infer<typeof Pending>|null=null,storageError=false
 try{pending=readPending(key)}catch{storageError=true}
 const execute=useMutation({mutationFn:async(requested?:Semantic)=>{
  const saved=readPending(key),semantic=saved?.semantic??requested
  if(!semantic||semantic.payload.projectId!==projectId)throw Error('REMOTE_DEVELOPMENT_SCOPE_MISMATCH')
  if(saved&&requested&&JSON.stringify(saved.semantic)!==JSON.stringify(requested))throw Error('PENDING_COMMAND_DIFFERENT')
  const record={semantic,intentId:saved?.intentId??crypto.randomUUID(),uncertain:saved?.uncertain??false}
  sessionStorage.setItem(key,JSON.stringify(record));setRevision(value=>value+1)
  const command={schemaVersion:1,intentId:record.intentId,deliveryAttemptId:crypto.randomUUID(),...semantic}
  let proof:string
  try{proof=await signControl(principalId,command,installationId)}catch(error){if(!record.uncertain)setDiscardable(true);throw error}
  setDiscardable(false);sessionStorage.setItem(key,JSON.stringify({...record,uncertain:true}));setRevision(value=>value+1)
  const response=await agentControlFetch('/api/v1/ac/project-admin/remote-development',{method:'POST',headers:{'content-type':'application/json','x-ac-operator-proof':proof},body:JSON.stringify(command)})
  const value:unknown=await response.json().catch(()=>null)
  if(!response.ok){if(!record.uncertain&&[400,403,413,415].includes(response.status))setDiscardable(true);const error=z.object({error:z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/)}).safeParse(value);throw Error(error.success?error.data.error:`HTTP_${response.status}`)}
  const result=Result.safeParse(value),expected=semantic.action==='project.prepareRemoteDevelopment'?'prepared':semantic.action==='project.launchRemoteDevelopment'?'launched':'registered'
  if(!result.success||result.data.state!==expected||result.data.projectId!==projectId||result.data.contextId!==semantic.payload.contextId||result.data.workspaceId!==semantic.payload.workspaceId||expected==='registered'&&result.data.state!=='registered')throw Error('COMMAND_RESPONSE_MISMATCH')
  sessionStorage.removeItem(key);setDiscardable(false);setRevision(value=>value+1)
  return result.data
 },onSuccess:()=>{void cache.invalidateQueries({queryKey:['ac-project-admin']})}})
 const disabled=execute.isPending||pending!==null||storageError
 return <div className="flex min-w-0 flex-col gap-2" data-testid="ac-remote-development" data-revision={revision}>
  <p>Desenvolvimento remoto. A execução usa a tarefa configurada e o gerente ativo do contexto. O artefato permanece não revisado; QA, revisão e aprovação são etapas posteriores.</p>
  {!view.configured&&<p role="status">Desenvolvimento remoto não configurado neste servidor.</p>}
  {storageError&&<p role="alert">PENDING_COMMAND_INVALID</p>}
  {pending&&<div><p role="status">{pending.uncertain?'Envio anterior incerto. Confirme o mesmo pedido para recuperar seu resultado.':'Pedido preparado para assinatura.'}</p><Button disabled={execute.isPending} onClick={()=>execute.mutate(undefined)}>Confirmar pedido remoto pendente</Button></div>}
  {discardable&&<Button variant="outline" onClick={()=>{sessionStorage.removeItem(key);setDiscardable(false);setRevision(value=>value+1);execute.reset()}}>Descartar pedido remoto recusado</Button>}
  {view.configured&&view.candidates.filter(item=>item.projectId===projectId).map(candidate=><div key={`${candidate.contextId}:${candidate.sourceOperationId}`} className="min-w-0 break-words">
   <p>{candidate.label}; contexto {candidate.contextId}; origem {candidate.commit}; não revisada.</p>
   <Button disabled={disabled} onClick={()=>execute.mutate({action:'project.prepareRemoteDevelopment',payload:{projectId,contextId:candidate.contextId,workspaceId:crypto.randomUUID(),hostId:candidate.hostId,sourceOperationId:candidate.sourceOperationId}})}>Preparar workspace remoto</Button>
  </div>)}
  {view.workspaces.filter(item=>item.projectId===projectId).map(workspace=><div key={workspace.workspaceId} className="min-w-0 break-words" data-testid="ac-remote-workspace">
   <p>Workspace {workspace.workspaceId}; contexto {workspace.contextId}; {workspace.state}; execução {workspace.implementationState??'não iniciada'}; emissão {workspace.emissionPhase??'não iniciada'}; {workspace.artifactId?'artefato registrado, não revisado':'sem artefato registrado'}.</p>
   {view.configured&&workspace.state==='prepared'&&!workspace.implementationState&&!workspace.artifactId&&<Button disabled={disabled} onClick={()=>execute.mutate({action:'project.launchRemoteDevelopment',payload:{projectId,contextId:workspace.contextId,workspaceId:workspace.workspaceId}})}>Executar tarefa remota configurada</Button>}
   {view.configured&&workspace.implementationState&&!workspace.artifactId&&workspace.emissionPhase!=='no_effect'&&<Button disabled={disabled} onClick={()=>execute.mutate({action:'project.registerRemoteArtifact',payload:{projectId,contextId:workspace.contextId,workspaceId:workspace.workspaceId}})}>Registrar artefato remoto</Button>}
  </div>)}
  <Button variant="outline" disabled={execute.isPending} onClick={()=>void cache.invalidateQueries({queryKey:['ac-project-admin']})}>Atualizar desenvolvimento remoto</Button>
  {execute.error&&<p role="alert">{execute.error.message}</p>}
  {execute.isSuccess&&<p role="status">Pedido remoto confirmado. O artefato continua não revisado.</p>}
 </div>
}
