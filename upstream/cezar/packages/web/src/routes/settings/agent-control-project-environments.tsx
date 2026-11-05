import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query'
import {useState} from 'react'
import {z} from 'zod'
import {Button} from '@/components/ui/button'
import {Input} from '@/components/ui/input'
import {signControl} from './agent-control-operator'
import {agentControlFetch} from './agent-control-fetch'

const keySchema=z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/)
const labelSchema=z.string().trim().min(1).max(100).refine(value=>!/[\x00-\x1f\x7f]/.test(value))
const refSchema=z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/).refine(value=>!value.includes('..')&&!value.includes('//')&&!value.endsWith('/')&&!value.endsWith('.')&&!value.endsWith('.lock'))
const directorySchema=z.string().min(1).max(256).refine(value=>!value.startsWith('/')&&!value.includes('\\')&&!/[\x00-\x1f\x7f]/.test(value)&&value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'&&part!=='.git'&&part!=='.ai'))
const purposes=['remote-development','remote-return'] as const
const destinationSchema=z.discriminatedUnion('kind',[z.object({id:keySchema,label:labelSchema,kind:z.literal('local_repository')}),z.object({id:keySchema,label:labelSchema,kind:z.literal('remote'),hostId:z.string().uuid(),allowedPurposes:z.array(z.enum(purposes)).min(1).max(2).refine(values=>new Set(values).size===values.length)})])
export const projectEnvironmentConfigSchema=z.object({sourceBranch:refSchema,environments:z.array(z.object({id:keySchema,label:labelSchema,targetRef:refSchema,authorizedDirectories:z.array(directorySchema).min(1).max(32).refine(values=>new Set(values).size===values.length),destinations:z.array(destinationSchema).min(1).max(16).refine(values=>new Set(values.map(item=>item.id)).size===values.length)})).min(1).max(8)}).refine(config=>new Set(config.environments.map(item=>item.id)).size===config.environments.length&&new Set(config.environments.map(item=>item.targetRef)).size===config.environments.length)
type Config=z.infer<typeof projectEnvironmentConfigSchema>
type Environment=Config['environments'][number]
type Destination=Environment['destinations'][number]
const payloadSchema=z.object({projectId:z.string().uuid(),expectedRevision:z.number().int().nonnegative(),config:projectEnvironmentConfigSchema})
const pendingSchema=z.object({payload:payloadSchema,intentId:z.string().uuid(),definitiveRefusal:z.boolean().optional()}).strict()
const viewSchema=z.object({projectId:z.string().uuid(),revision:z.number().int().nonnegative(),config:projectEnvironmentConfigSchema.nullable(),canConfigure:z.boolean(),pathScope:z.literal('existing_repository_relative_directories'),remoteHosts:z.array(z.object({id:z.string().uuid(),label:z.string(),allowedPurposes:z.array(z.enum(purposes))})).optional()})
const newDestination=():Destination=>({id:`destination-${crypto.randomUUID().slice(0,8)}`,label:'Destino local',kind:'local_repository'})
const newEnvironment=():Environment=>({id:`environment-${crypto.randomUUID().slice(0,8)}`,label:'Novo ambiente',targetRef:'refs/heads/protected',authorizedDirectories:[],destinations:[newDestination()]})
async function json(response:Response){const value:unknown=await response.json();if(!response.ok){const parsed=z.object({error:z.string()}).safeParse(value);throw Error(parsed.success?parsed.data.error:`HTTP_${response.status}`)}return value}

export function AgentControlProjectEnvironments({projectId,principalId,installationId}:{projectId:string;principalId:string;installationId:string}){
 const cache=useQueryClient(),[draft,setDraft]=useState<Config>({sourceBranch:'refs/heads/main',environments:[]}),[base,setBase]=useState<number|null>(null),[refused,setRefused]=useState(false)
 const storageKey=`ac-project-environments:${installationId}:${encodeURIComponent(principalId)}:${projectId}`
 const view=useQuery({queryKey:['ac-project-environments',projectId],retry:false,queryFn:async()=>{const value=viewSchema.parse(await json(await agentControlFetch(`/api/v1/ac/project-admin/environments?projectId=${projectId}`)));if(value.projectId!==projectId)throw Error('PROJECT_RESPONSE_MISMATCH');return value}})
 const normalizedDraft={...draft,environments:draft.environments.map(environment=>({...environment,authorizedDirectories:environment.authorizedDirectories.map(item=>item.trim()).filter(Boolean)}))}
 const pending=!!sessionStorage.getItem(storageKey)
 let persistedRefusal=false;try{const saved=pendingSchema.safeParse(JSON.parse(sessionStorage.getItem(storageKey)||'null'));persistedRefusal=saved.success&&saved.data.definitiveRefusal===true}catch{/* Invalid storage is reported by the resume mutation. */}
 function editEnvironment(index:number,patch:Partial<Environment>){setDraft(current=>({...current,environments:current.environments.map((environment,i)=>i===index?{...environment,...patch}:environment)}))}
 function editDestination(environmentIndex:number,index:number,value:Destination){const environment=draft.environments[environmentIndex];if(environment)editEnvironment(environmentIndex,{destinations:environment.destinations.map((item,i)=>i===index?value:item)})}
 const send=useMutation({mutationFn:async(mode:'publish'|'resume')=>{
  if(!view.data?.canConfigure)throw Error('PROJECT_ENVIRONMENT_FORBIDDEN')
  const raw:unknown=JSON.parse(sessionStorage.getItem(storageKey)||'null'),saved=raw===null?null:pendingSchema.parse(raw)
  if(saved&&mode!=='resume')throw Error('PENDING_COMMAND_DIFFERENT')
  if(!saved&&mode==='resume')throw Error('PENDING_COMMAND_REQUIRED')
  const payload=saved?.payload??payloadSchema.parse({projectId,expectedRevision:base??view.data.revision,config:normalizedDraft})
  if(payload.projectId!==projectId)throw Error('PROJECT_RESPONSE_MISMATCH')
  const command={schemaVersion:1,intentId:saved?.intentId??crypto.randomUUID(),deliveryAttemptId:crypto.randomUUID(),action:'project.environments.configure',payload}
  const proof=await signControl(principalId,command,installationId)
  sessionStorage.setItem(storageKey,JSON.stringify({payload,intentId:command.intentId,...(saved?.definitiveRefusal?{definitiveRefusal:true}:{})}));setRefused(false)
  const response=await agentControlFetch('/api/v1/ac/project-admin/environments',{method:'POST',headers:{'content-type':'application/json','x-ac-operator-proof':proof},body:JSON.stringify(command)})
  if(!saved&&[400,403,409].includes(response.status)){sessionStorage.setItem(storageKey,JSON.stringify({payload,intentId:command.intentId,definitiveRefusal:true}));setRefused(true)}
  const result=z.object({state:z.literal('applied'),projectId:z.string().uuid(),revision:z.number().int().positive()}).parse(await json(response))
  if(result.projectId!==projectId||result.revision!==payload.expectedRevision+1)throw Error('COMMAND_RESPONSE_MISMATCH')
  sessionStorage.removeItem(storageKey);setBase(result.revision)
 },onSuccess:()=>{void cache.invalidateQueries({queryKey:['ac-project-environments',projectId]})}})
 const locked=send.isPending||pending
 return <div className="flex min-w-0 flex-col gap-3">
  <h3 className="text-sm font-semibold">Ambientes e destinos do projeto</h3>
  <p>Configure branches existentes, diretórios relativos já existentes e destinos autorizados. A publicação cria uma revisão e não inicia execução.</p>
  {view.error&&<p role="alert">Não foi possível consultar os ambientes deste projeto.</p>}
  {view.data&&<>
   <p>Revisão publicada: {view.data.revision}.</p>
   {!view.data.canConfigure&&<p>Somente o titular do projeto configura ambientes e destinos.</p>}
   {view.data.canConfigure&&<>
    <Button type="button" variant="outline" className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal py-2" disabled={locked} onClick={()=>{setDraft(view.data!.config??{sourceBranch:'refs/heads/main',environments:[newEnvironment()]});setBase(view.data!.revision)}}>Carregar configuração de ambientes</Button>
    <form className="flex min-w-0 flex-col gap-3" onSubmit={event=>{event.preventDefault();send.mutate('publish')}}>
     <label>Branch de origem<Input aria-label="Branch de origem" value={draft.sourceBranch} disabled={locked} onChange={event=>setDraft(current=>({...current,sourceBranch:event.target.value}))} required/></label>
     {draft.environments.map((environment,index)=><fieldset key={environment.id} className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
      <legend>Ambiente {index+1}</legend>
      <label>Nome do ambiente<Input aria-label={`Nome do ambiente ${index+1}`} value={environment.label} disabled={locked} onChange={event=>editEnvironment(index,{label:event.target.value})} maxLength={100} required/></label>
      <label>Branch de destino<Input aria-label={`Branch de destino ${index+1}`} value={environment.targetRef} disabled={locked} onChange={event=>editEnvironment(index,{targetRef:event.target.value})} required/></label>
      <label>Diretórios autorizados, um por linha<textarea aria-label={`Diretórios autorizados ${index+1}`} className="min-h-24 w-full min-w-0 rounded-md border p-2" value={environment.authorizedDirectories.join('\n')} disabled={locked} onChange={event=>editEnvironment(index,{authorizedDirectories:event.target.value.split('\n')})} required/></label>
      <p className="text-xs">Use caminhos relativos ao repositório, por exemplo src e tests. O servidor verifica existência e identidade dos diretórios.</p>
      {environment.destinations.map((destination,destinationIndex)=><fieldset key={destination.id} className="flex min-w-0 flex-col gap-2 rounded-md border p-2">
       <legend>Destino {destinationIndex+1}</legend>
       <label>Nome do destino<Input aria-label={`Nome do destino ${index+1}.${destinationIndex+1}`} value={destination.label} disabled={locked} onChange={event=>editDestination(index,destinationIndex,{...destination,label:event.target.value})} maxLength={100} required/></label>
       <label className="flex flex-col gap-1">Tipo de destino<select aria-label={`Tipo de destino ${index+1}.${destinationIndex+1}`} className="min-h-11 min-w-0 rounded-md border px-2" disabled={locked} value={destination.kind} onChange={event=>editDestination(index,destinationIndex,event.target.value==='remote'?{id:destination.id,label:destination.label,kind:'remote',hostId:'',allowedPurposes:view.data!.remoteHosts?[]:['remote-development']}:{id:destination.id,label:destination.label,kind:'local_repository'})}><option value="local_repository">Repositório local</option><option value="remote">Host remoto autorizado</option></select></label>
       {destination.kind==='remote'&&<>
        {view.data!.remoteHosts?<label className="flex flex-col gap-1">Host remoto<select aria-label={`Host remoto ${index+1}.${destinationIndex+1}`} className="min-h-11 min-w-0 max-w-full rounded-md border px-2" disabled={locked} value={destination.hostId} onChange={event=>{const host=view.data!.remoteHosts!.find(item=>item.id===event.target.value);editDestination(index,destinationIndex,{...destination,hostId:event.target.value,allowedPurposes:destination.allowedPurposes.filter(purpose=>host?.allowedPurposes.includes(purpose))})}} required><option value="">Selecione um host</option>{view.data!.remoteHosts.map(host=><option key={host.id} value={host.id}>{host.label}</option>)}</select></label>:<label>Identificador do host autorizado<Input aria-label={`Host remoto ${index+1}.${destinationIndex+1}`} value={destination.hostId} disabled={locked} onChange={event=>editDestination(index,destinationIndex,{...destination,hostId:event.target.value})} required/></label>}
        {view.data!.remoteHosts&&<p className="text-xs">Marque somente as operações autorizadas para o host selecionado.</p>}
        {purposes.map(purpose=><label key={purpose} className="flex min-h-11 items-center gap-2"><input type="checkbox" aria-label={`${purpose} ${index+1}.${destinationIndex+1}`} checked={destination.allowedPurposes.includes(purpose)} disabled={locked||!!view.data!.remoteHosts&&!view.data!.remoteHosts.find(host=>host.id===destination.hostId)?.allowedPurposes.includes(purpose)} onChange={event=>editDestination(index,destinationIndex,{...destination,allowedPurposes:event.target.checked?[...destination.allowedPurposes,purpose]:destination.allowedPurposes.filter(item=>item!==purpose)})}/>{purpose==='remote-development'?'Desenvolvimento remoto':'Devolução de artefatos'}</label>)}
       </>}
       <Button type="button" className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal py-2" variant="outline" disabled={locked||environment.destinations.length<=1} onClick={()=>editEnvironment(index,{destinations:environment.destinations.filter((_,i)=>i!==destinationIndex)})}>Remover destino {destinationIndex+1}</Button>
      </fieldset>)}
      <Button type="button" className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal py-2" variant="outline" disabled={locked||environment.destinations.length>=16} onClick={()=>editEnvironment(index,{destinations:[...environment.destinations,newDestination()]})}>Adicionar destino ao ambiente {index+1}</Button>
      <Button type="button" className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal py-2" variant="outline" disabled={locked||draft.environments.length<=1} onClick={()=>setDraft(current=>({...current,environments:current.environments.filter((_,i)=>i!==index)}))}>Remover ambiente {index+1}</Button>
     </fieldset>)}
     <Button type="button" className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal py-2" variant="outline" disabled={locked||draft.environments.length>=8} onClick={()=>{setBase(current=>current??view.data!.revision);setDraft(current=>({...current,environments:[...current.environments,newEnvironment()]}))}}>Adicionar ambiente</Button>
     {draft.environments.length>0&&!projectEnvironmentConfigSchema.safeParse(normalizedDraft).success&&<p role="status">Confira as branches de destino diferentes, os diretórios relativos e ao menos um destino válido por ambiente.</p>}
     <Button type="submit" className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal py-2" disabled={locked||!projectEnvironmentConfigSchema.safeParse(normalizedDraft).success}>Publicar ambientes e destinos</Button>
    </form>
   </>}
  </>}
  {pending&&<><p role="status">Publicação pendente. Confirme a mesma operação antes de editar outra configuração.</p><Button className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal py-2" disabled={send.isPending||!view.data?.canConfigure} onClick={()=>send.mutate('resume')}>Confirmar configuração de ambientes pendente</Button></>}
  {(refused||persistedRefusal)&&<Button className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal py-2" variant="outline" onClick={()=>{sessionStorage.removeItem(storageKey);setRefused(false);send.reset();void cache.invalidateQueries({queryKey:['ac-project-environments',projectId]})}}>Descartar publicação recusada</Button>}
  {send.error&&<p role="alert">{send.error.message}</p>}
  {send.isSuccess&&<p role="status">Ambientes e destinos publicados e persistidos.</p>}
 </div>
}
