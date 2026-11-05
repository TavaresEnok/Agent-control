import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query'
import {useState} from 'react'
import {z} from 'zod'
import {Button} from '@/components/ui/button'
import {Input} from '@/components/ui/input'
import {useProjectScope} from '@/api/project-scope-context'
import {SettingsField} from './settings-field'
import {agentControlFetch} from './agent-control-fetch'
import {signControl} from './agent-control-operator'

const viewSchema=z.object({mode:z.literal('synthetic-laboratory'),operationalActivation:z.literal('blocked'),domain:z.object({id:z.string().uuid(),holder_installation_id:z.string().uuid(),epoch:z.number().int().positive(),paused:z.boolean()}),installations:z.array(z.object({id:z.string().uuid(),label:z.string()}))})
async function json(response:Response){const value:unknown=await response.json();if(!response.ok){const error=z.object({error:z.string()}).safeParse(value);throw Error(error.success?error.data.error:`HTTP_${response.status}`)}return value}
export function AgentControlInstallationAuthority(){
 const {projectId}=useProjectScope(),cache=useQueryClient()
 const [draft,setDraft]=useState(''),[domainId,setDomainId]=useState(''),[target,setTarget]=useState('')
 const view=useQuery({queryKey:['ac-installation-authority',projectId,domainId],enabled:!!domainId,retry:false,queryFn:async()=>viewSchema.parse(await json(await agentControlFetch(`/api/v1/ac/installation-authority?domainId=${encodeURIComponent(domainId)}`)))})
 const identity=useQuery({queryKey:['ac-authority-signer',projectId],enabled:!!domainId,retry:false,queryFn:async()=>z.object({principalId:z.string(),installationId:z.string().uuid()}).parse(await json(await agentControlFetch('/api/v1/ac/operator/identity')))})
 const key=identity.data?`ac-authority:${identity.data.installationId}:${encodeURIComponent(identity.data.principalId)}:${domainId}`:''
 const pending=!!key&&!!sessionStorage.getItem(key)
 const change=useMutation({mutationFn:async(action:'installation.pause'|'installation.transfer'|'installation.rollback'|null)=>{
  if(!view.data)throw Error('AUTHORITY_NOT_LOADED')
  const signer=identity.data;if(!signer)throw Error('SIGNER_NOT_READY')
  let payload=action==='installation.pause'?{expectedEpoch:view.data.domain.epoch,paused:!view.data.domain.paused}:{expectedEpoch:view.data.domain.epoch,targetInstallationId:target}
  let semantic=JSON.stringify({domainId,action,payload})
  const saved=z.object({semantic:z.string(),intentId:z.string().uuid(),expectedHolder:z.string().uuid()}).nullable().parse(JSON.parse(sessionStorage.getItem(key)||'null'))
  if(saved){
   if(action!==null)throw Error('PENDING_COMMAND_DIFFERENT')
   const prior=z.object({domainId:z.string().uuid(),action:z.enum(['installation.pause','installation.transfer','installation.rollback']),payload:z.union([z.object({expectedEpoch:z.number().int().positive(),paused:z.boolean()}).strict(),z.object({expectedEpoch:z.number().int().positive(),targetInstallationId:z.string().uuid()}).strict()])}).strict().parse(JSON.parse(saved.semantic))
   if(prior.domainId!==domainId)throw Error('PENDING_COMMAND_DIFFERENT')
   action=prior.action;payload=prior.payload;semantic=saved.semantic
  }else if(action===null)throw Error('PENDING_COMMAND_REQUIRED')
  const expectedHolder=saved?.expectedHolder??view.data.domain.holder_installation_id
  const command={schemaVersion:1,intentId:saved?.intentId??crypto.randomUUID(),deliveryAttemptId:crypto.randomUUID(),domainId,action,payload}
  const proof=await signControl(signer.principalId,command,signer.installationId)
  sessionStorage.setItem(key,JSON.stringify({semantic,intentId:command.intentId,expectedHolder}))
  const result=z.object({state:z.literal('applied'),token:z.object({domainId:z.string().uuid(),installationId:z.string().uuid(),epoch:z.number().int().positive()}),paused:z.boolean()}).parse(await json(await agentControlFetch('/api/v1/ac/installation-authority',{method:'POST',headers:{'content-type':'application/json','x-ac-operator-proof':proof},body:JSON.stringify(command)})))
  if(result.token.domainId!==domainId||result.token.epoch!==payload.expectedEpoch+('paused' in payload?0:1)||result.token.installationId!==('paused' in payload?expectedHolder:payload.targetInstallationId)||result.paused!==('paused' in payload?payload.paused:true))throw Error('COMMAND_RESPONSE_MISMATCH')
  sessionStorage.removeItem(key)
 },onSuccess:()=>{void cache.invalidateQueries({queryKey:['ac-installation-authority']})},onError:()=>{void cache.invalidateQueries({queryKey:['ac-installation-authority']})}})
 return <SettingsField title="Autoridade de instalação — laboratório" hint="Somente domínios sintéticos previamente cadastrados. A ativação operacional continua bloqueada.">
  <form className="flex min-w-0 flex-col gap-2" onSubmit={event=>{event.preventDefault();setDomainId(draft);setTarget('');change.reset()}}>
   <label>Domínio de laboratório<Input aria-label="Domínio de laboratório" value={draft} onChange={event=>setDraft(event.target.value)}/></label>
   <Button type="submit" disabled={!z.string().uuid().safeParse(draft).success||change.isPending}>Consultar autoridade</Button>
  </form>
  {view.error&&<p role="alert">{view.error.message}</p>}
  {view.data&&<><p className="break-all" role="status">Autoridade: {view.data.installations.find(item=>item.id===view.data.domain.holder_installation_id)?.label??view.data.domain.holder_installation_id}; época {view.data.domain.epoch}; {view.data.domain.paused?'pausada':'ativa'}.</p>
   <Button disabled={change.isPending||pending||!identity.data} onClick={()=>change.mutate('installation.pause')}>{view.data.domain.paused?'Retomar autoridade de laboratório':'Pausar autoridade de laboratório'}</Button>
   <label className="flex min-w-0 flex-col gap-1">Instalação de destino<select aria-label="Instalação de destino" className="min-h-11 min-w-0 max-w-full rounded-md border px-2" value={target} onChange={event=>setTarget(event.target.value)}><option value="">Selecione</option>{view.data.installations.filter(item=>item.id!==view.data!.domain.holder_installation_id).map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
   <Button disabled={change.isPending||pending||!target||!identity.data} onClick={()=>change.mutate('installation.transfer')}>Transferir autoridade de laboratório</Button>
   <Button variant="outline" disabled={change.isPending||pending||!target||!identity.data} onClick={()=>change.mutate('installation.rollback')}>Reverter autoridade ao destino</Button>
  </>}
  {pending&&<><p role="status">Alteração anterior pendente de confirmação. Retome a mesma operação antes de outra alteração.</p><Button disabled={change.isPending} onClick={()=>change.mutate(null)}>Confirmar alteração de autoridade pendente</Button></>}
  {change.error&&<p role="alert">{change.error.message}</p>}
  {change.isSuccess&&<p role="status">Alteração de autoridade confirmada.</p>}
 </SettingsField>
}
