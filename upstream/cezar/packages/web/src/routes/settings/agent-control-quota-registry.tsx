import {useQuery} from '@tanstack/react-query'
import {z} from 'zod'
import {useProjectScope} from '@/api/project-scope-context'
import {SettingsField} from './settings-field'
import {agentControlFetch} from './agent-control-fetch'

const report=z.object({state:z.enum(['disabled','configured-inactive','lab-synthetic']),realActivation:z.literal('blocked'),inferenceEnabled:z.literal(false),registered:z.number().int().nonnegative()})
const labels={'disabled':'Desabilitada','configured-inactive':'Configurada e inativa','lab-synthetic':'Laboratório sintético'}
export function AgentControlQuotaRegistry(){
 const {projectId}=useProjectScope()
 const registry=useQuery({queryKey:['ac-quota-registry',projectId],retry:false,refetchInterval:10000,queryFn:async()=>{
  const response=await agentControlFetch('/api/v1/ac/quota-registry')
  if(!response.ok)throw Error('QUOTA_REGISTRY_UNAVAILABLE')
  return report.parse(await response.json())
 }})
 return <SettingsField title="Fonte de quota Codex" hint="O registro da fonte e o saldo disponível são informações distintas.">
  {registry.isPending&&<p role="status">Carregando estado da fonte…</p>}
  {registry.error&&<p role="status">Estado da fonte indisponível. O saldo permanece desconhecido; isto não indica esgotamento.</p>}
  {registry.data&&<><p role="status">{labels[registry.data.state]}; fontes registradas: {registry.data.registered}.</p><p>Ativação de contas reais bloqueada. Inferência desabilitada.</p></>}
 </SettingsField>
}
