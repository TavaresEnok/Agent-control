import {useQuery} from '@tanstack/react-query'
import {z} from 'zod'
import {useProjectScope} from '@/api/project-scope-context'
import {SettingsField} from './settings-field'
import {agentControlFetch} from './agent-control-fetch'
const schema=z.object({contextId:z.string().uuid(),state:z.enum(['unavailable','stopped','starting','running','stopping','disconnected','revoked']),
 executionEnabled:z.boolean().optional(),semanticManagerEnabled:z.boolean().optional()})
const labels={unavailable:'Conexão não configurada',stopped:'Parado',starting:'Conectando',running:'Conectado',stopping:'Encerrando',disconnected:'Desconectado',revoked:'Autorização revogada'}
export function AgentControlManagerStatus({contextId}:{contextId:string}){
 const {projectId}=useProjectScope()
 const query=useQuery({queryKey:['ac-manager-status',projectId,contextId],enabled:!!contextId,refetchInterval:15000,retry:false,queryFn:async({signal})=>{
  const response=await agentControlFetch(`/api/v1/ac/contexts/${encodeURIComponent(contextId)}/manager`,{signal})
  if(!response.ok)throw Error('MANAGER_STATUS_UNAVAILABLE')
  const value=schema.parse(await response.json());if(value.contextId!==contextId)throw Error('MANAGER_CONTEXT_MISMATCH');return value
 }})
 return <SettingsField title="Conexão do gerente" hint="Estado da conexão desta conversa.">
  {query.isPending&&<p role="status">Consultando conexão…</p>}
  {query.isError&&<p role="status">Não foi possível confirmar a conexão.</p>}
  {query.data&&<><p role="status">{labels[query.data.state]}</p>
   {query.data.executionEnabled===false&&<p>Execução de tarefas desabilitada nesta instalação.</p>}
   {query.data.semanticManagerEnabled===false&&<p>O gerente de IA ainda não está habilitado.</p>}
  </>}
 </SettingsField>
}
