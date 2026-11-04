import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query'
import {useState} from 'react'
import {z} from 'zod'
import {Button} from '@/components/ui/button'
import {Input} from '@/components/ui/input'
import {SettingsField} from './settings-field'
import {signControl} from './agent-control-operator'
import {agentControlFetch} from './agent-control-fetch'
import {useProjectScope} from '@/api/project-scope-context'
import {AgentControlRemoteSourceImport} from './agent-control-remote-source-import'

const RemoteSource=z.object({projectId:z.string().uuid(),hostId:z.string().uuid(),commit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
 tree:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),state:z.literal('materialized'),reviewStatus:z.literal('not_reviewed')})
const RemoteCandidate=z.object({projectId:z.string().uuid(),contextId:z.string().uuid(),operationId:z.string().uuid(),hostId:z.string().uuid(),
 label:z.string().min(1).max(200),commit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),tree:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
 sha256:z.string().regex(/^[a-f0-9]{64}$/),state:z.literal('exported'),reviewStatus:z.literal('not_reviewed')}).refine(value=>value.commit.length===value.tree.length)
const View=z.object({principalId:z.string(),installationId:z.string().uuid(),operatorDeviceIds:z.array(z.string().uuid()),canRegister:z.boolean(),
 server:z.object({kind:z.literal('local'),remoteManagement:z.literal(false)}),roots:z.array(z.object({id:z.string(),label:z.string()})),
 remoteSources:z.array(RemoteSource).max(100).optional(),remoteSourceCandidates:z.array(RemoteCandidate).max(100).optional()})
const Result=z.object({state:z.literal('applied'),projectId:z.string().uuid()})
async function json(response:Response){
 const value:unknown=await response.json()
 if(!response.ok){const error=z.object({error:z.string()}).safeParse(value);throw Error(error.success?error.data.error:`HTTP_${response.status}`)}
 return value
}
export function AgentControlProjectAdmin(){
 const {projectId}=useProjectScope()
 const cache=useQueryClient(),[label,setLabel]=useState(''),[rootId,setRootId]=useState(''),[relativePath,setRelativePath]=useState(''),[refusedKey,setRefusedKey]=useState<string|null>(null)
 const view=useQuery({queryKey:['ac-project-admin',projectId],retry:false,queryFn:async()=>View.parse(await json(await agentControlFetch('/api/v1/ac/project-admin')))})
 const register=useMutation({mutationFn:async()=>{
  if(!view.data?.canRegister)throw Error('CONTROL_ADMIN_REQUIRED')
  const semantic=JSON.stringify({label,rootId,relativePath}),key=`ac-project-register:${encodeURIComponent(view.data.principalId)}:${view.data.installationId}`
  let saved:unknown;try{saved=JSON.parse(sessionStorage.getItem(key)||'null')}catch{throw Error('PENDING_COMMAND_INVALID')}
  const record=z.object({semantic:z.string(),intentId:z.string().uuid(),projectId:z.string().uuid(),uncertain:z.boolean().default(false)}).safeParse(saved)
  if(saved!==null&&!record.success)throw Error('PENDING_COMMAND_INVALID')
  if(record.success&&record.data.semantic!==semantic)throw Error('PENDING_COMMAND_DIFFERENT')
  const pending=record.success?record.data:{semantic,intentId:crypto.randomUUID(),projectId:crypto.randomUUID(),uncertain:false}
  sessionStorage.setItem(key,JSON.stringify(pending))
  const command={schemaVersion:1,intentId:pending.intentId,deliveryAttemptId:crypto.randomUUID(),action:'project.register',payload:{projectId:pending.projectId,label,rootId,relativePath}}
  let proof:string
  try{proof=await signControl(view.data.principalId,command,view.data.installationId)}
  catch(error){if(!pending.uncertain)setRefusedKey(key);throw error}
  setRefusedKey(null)
  sessionStorage.setItem(key,JSON.stringify({...pending,uncertain:true}))
  const response=await agentControlFetch('/api/v1/ac/project-admin',{method:'POST',headers:{'content-type':'application/json','x-ac-operator-proof':proof},body:JSON.stringify(command)})
  if(!pending.uncertain&&[400,403,413,415].includes(response.status))setRefusedKey(key)
  const result=Result.parse(await json(response))
  if(result.projectId!==pending.projectId)throw Error('COMMAND_RESPONSE_MISMATCH')
  sessionStorage.removeItem(key);setRefusedKey(null);return result
 },onSuccess:()=>{setLabel('');setRelativePath('');void cache.invalidateQueries({queryKey:['projects']});void cache.invalidateQueries({queryKey:['workspace','projects']})}})
 const sources=(view.data?.remoteSources??[]).filter(source=>!projectId||source.projectId===projectId)
 const candidates=(view.data?.remoteSourceCandidates??[]).filter(candidate=>!projectId||candidate.projectId===projectId)
 return <SettingsField title="Projetos e servidor" hint="Cadastre um repositório Git existente dentro de uma raiz autorizada na inicialização.">
  <p>Servidor local. Administração remota de servidores ainda não está disponível.</p>
  {sources.length>0&&<div>
   <p>Origem SSH somente leitura. O snapshot permanece não revisado e não autoriza integração.</p>
   {sources.map(source=><p key={`${source.projectId}:${source.commit}`}>Host {source.hostId}; commit {source.commit}; tree {source.tree}; estado materializado; revisão não revisada.</p>)}
  </div>}
  {view.data?.remoteSourceCandidates&&<AgentControlRemoteSourceImport principalId={view.data.principalId} installationId={view.data.installationId} candidates={candidates}/>}
  {view.isPending&&<p role="status">Carregando permissões…</p>}
  {view.error&&<p role="alert">Não foi possível carregar a administração de projetos.</p>}
  {view.data&&!view.data.canRegister&&<p>O cadastro de projetos exige administrador global.</p>}
  {view.data?.canRegister&&view.data.roots.length===0&&<p role="status">Nenhuma raiz de projetos foi autorizada na inicialização.</p>}
  {view.data?.canRegister&&view.data.roots.length>0&&<form className="flex min-w-0 flex-col gap-2" onSubmit={event=>{event.preventDefault();register.mutate()}}>
   <label className="flex flex-col gap-1">Nome do projeto<Input value={label} onChange={event=>setLabel(event.target.value)} maxLength={200} required/></label>
   <label className="flex flex-col gap-1">Raiz autorizada<select aria-label="Raiz autorizada" className="h-9 min-w-0 max-w-full rounded-md border border-input bg-card px-2 text-sm" value={rootId} onChange={event=>setRootId(event.target.value)} required>
    <option value="">Selecione uma raiz</option>{view.data.roots.map(root=><option key={root.id} value={root.id}>{root.label}</option>)}
   </select></label>
   <label className="flex flex-col gap-1">Caminho relativo do repositório<Input value={relativePath} onChange={event=>setRelativePath(event.target.value)} maxLength={512} required/></label>
   <p className="text-xs text-muted-foreground">O repositório deve existir; esta ação não cria ou altera seus arquivos.</p>
   <Button type="submit" disabled={register.isPending||!rootId||!label.trim()||!relativePath}>Cadastrar projeto</Button>
   {register.error&&<p role="alert">{register.error.message}</p>}
   {refusedKey&&<Button type="button" variant="outline" onClick={()=>{sessionStorage.removeItem(refusedKey);setRefusedKey(null);register.reset()}}>Descartar rascunho recusado</Button>}
   {register.isSuccess&&<p role="status">Projeto cadastrado.</p>}
  </form>}
 </SettingsField>
}
