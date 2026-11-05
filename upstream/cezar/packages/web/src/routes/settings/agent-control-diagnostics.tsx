import {useQuery} from '@tanstack/react-query'
import {z} from 'zod'
import {Input} from '@/components/ui/input'
import {EXCLUSION_TEXT} from './agent-control-capacity-waits'
import {useState} from 'react'
import {agentControlDiagnosticsSchema, type AgentControlDiagnosticFinding} from '@open-mercato/cezar-api-client'
import {useProjectScope} from '@/api/project-scope-context'
import {Button} from '@/components/ui/button'
import {SettingsField} from './settings-field'
import {agentControlFetch} from './agent-control-fetch'

const PAGE_SIZE=10
const capacityReason:Record<NonNullable<AgentControlDiagnosticFinding['capacityWait']>['reason'],string>={NO_ELIGIBLE_CAPACITY:'Nenhum perfil elegível',ORIGINAL_RESERVE_NOT_NEEDED:'Reserva original ainda não necessária',CAPACITY_BUSY:'Capacidade ocupada',CAPACITY_QUEUED:'Aguardando na fila',GLOBAL_CAPACITY_LIMIT:'Limite global atingido',CONTEXT_CAPACITY_LIMIT:'Limite da conversa atingido',ACCOUNT_CAPACITY_LIMIT:'Limite da conta atingido',unknown:'Motivo desconhecido'}
function nativeFailureCause(cause:NonNullable<AgentControlDiagnosticFinding['nativeFailure']>['cause']){
 switch(cause){
  case 'worker_exited_without_result':return 'O controlador registrou trabalhador encerrado sem resultado.';
  case 'finalizer_exited_without_result':return 'O finalizador encerrou sem resultado armazenado.';
  case 'invalid_scope':return 'O finalizador registrou escopo inválido.';
  case 'no_changes':return 'O finalizador registrou ausência de alterações.';
  case 'finalization_failed':return 'O finalizador registrou falha de finalização.';
  case 'execution_failed':return 'O controlador registrou falha de execução.';
  case 'execution_timeout':return 'O controlador registrou o limite de tempo da execução.';
  case 'execution_canceled':return 'O controlador registrou cancelamento da execução.';
  case 'execution_native_turn_failed':return 'O controlador registrou turno nativo sem conclusão.';
  case 'execution_output_too_large':return 'O controlador registrou saída acima do limite fixo.';
  case 'execution_native_failed':return 'O controlador registrou falha nativa sem código mais específico.';
  case 'unknown':return 'Motivo desconhecido, ausente ou divergente.';
 }
}
function nativeFailureOrigin(origin:NonNullable<AgentControlDiagnosticFinding['nativeFailure']>['origin']){
 return origin==='stored_agreement'
  ?'Registros ligados concordam nesta leitura. Assinatura e recibo não foram verificados.'
  :'Vínculo ou motivo não reconciliado.';
}
export function AgentControlDiagnostics({contextId}:{contextId:string}){
 const {projectId}=useProjectScope()
 const [page,setPage]=useState(0),[intentDraft,setIntentDraft]=useState(''),[intentId,setIntentId]=useState('')
 const catalog=useQuery({queryKey:['ac-diagnostic-tasks',projectId,contextId],enabled:!!contextId,retry:false,queryFn:async()=>{const response=await agentControlFetch(`/api/v1/ac/contexts/${encodeURIComponent(contextId)}`);if(!response.ok)throw Error('TASK_CATALOG_UNAVAILABLE');const value=z.object({id:z.string().uuid(),intents:z.array(z.object({id:z.string().uuid(),state:z.string(),plan_revision:z.number().int()}))}).parse(await response.json());if(value.id!==contextId)throw Error('DIAGNOSTIC_CONTEXT_MISMATCH');return value.intents}})
 const diagnostics=useQuery({queryKey:['ac-context-diagnostics',projectId,contextId,intentId],enabled:!!contextId,refetchInterval:15000,queryFn:async()=>{
  const response=await agentControlFetch(`/api/v1/ac/contexts/${encodeURIComponent(contextId)}/diagnostics${intentId?'?intentId='+encodeURIComponent(intentId):''}`)
  if(!response.ok)throw Error(`Diagnóstico indisponível (HTTP ${response.status}).`)
  const value=agentControlDiagnosticsSchema.parse(await response.json())
  if(value.contextId!==contextId||value.intentId!==(intentId||undefined))throw Error('DIAGNOSTIC_CONTEXT_MISMATCH')
  return value
 }})
 const findings=diagnostics.data?.findings??[],lastPage=Math.max(0,Math.ceil(findings.length/PAGE_SIZE)-1),currentPage=Math.min(page,lastPage)
 return <SettingsField title="Diagnóstico da conversa" hint="Situação registrada e condições para continuar.">
  {catalog.data&&catalog.data.length>0&&<label className="flex min-w-0 flex-col gap-1">Tarefa registrada para diagnóstico<select aria-label="Tarefa registrada para diagnóstico" className="min-h-11 min-w-0 max-w-full rounded-md border px-2" value={catalog.data.some(item=>item.id===intentId)?intentId:''} onChange={event=>{setIntentId(event.target.value);setIntentDraft(event.target.value);setPage(0)}}><option value="">Diagnóstico geral da conversa</option>{catalog.data.slice(-200).reverse().map(task=><option key={task.id} value={task.id}>Revisão {task.plan_revision} · {task.state} · {task.id}</option>)}</select></label>}
  {catalog.data&&catalog.data.length>200&&<p role="status">A seleção mostra as 200 tarefas mais recentes. Consulte tarefas anteriores pelo identificador.</p>}
  {catalog.error&&<p role="status">A lista de tarefas está indisponível; ainda é possível consultar uma tarefa pelo identificador.</p>}
  <form className="flex min-w-0 flex-col gap-2" onSubmit={event=>{event.preventDefault();setIntentId(intentDraft);setPage(0)}}>
   <label>Identificador da tarefa<Input aria-label="Identificador da tarefa para diagnóstico" value={intentDraft} onChange={event=>setIntentDraft(event.target.value)}/></label>
   <Button type="submit" className="min-h-11" disabled={!z.string().uuid().safeParse(intentDraft).success||diagnostics.isFetching}>Consultar diagnóstico da tarefa</Button>
   {intentId&&<><p className="break-all" role="status">Diagnóstico direcionado à tarefa {intentId} e seus filhos neste contexto.</p><Button type="button" className="min-h-11" variant="outline" onClick={()=>{setIntentId('');setIntentDraft('');setPage(0)}}>Voltar ao diagnóstico da conversa</Button></>}
  </form>
  <Button type="button" variant="outline" disabled={diagnostics.isFetching} onClick={()=>{void diagnostics.refetch()}}>Atualizar diagnóstico</Button>
  {diagnostics.isPending&&<p role="status">Carregando diagnóstico…</p>}
  {diagnostics.error&&<p role="alert">{diagnostics.error.message}</p>}
  {diagnostics.data&&<>
   {diagnostics.data.assessment==='unknown'&&<p role="status">{diagnostics.data.explanation??'Nenhuma causa foi comprovada nos registros consultados; o estado é desconhecido.'}</p>}
   {diagnostics.data.truncated&&<p role="status">A lista foi limitada; outros registros podem não estar exibidos.</p>}
   {findings.length>0&&<>
    <ul className="flex min-w-0 flex-col gap-2">{findings.slice(currentPage*PAGE_SIZE,(currentPage+1)*PAGE_SIZE).map((finding,index)=><li key={`${currentPage*PAGE_SIZE+index}-${finding.code}`} className="min-w-0 break-words rounded-md border p-3 text-sm">
     <p>{finding.meaning}</p><p>Responsável: {finding.owner}</p><p>Próxima condição: {finding.nextCondition}</p>
     {finding.capacityWait&&<><p>Espera de capacidade: {capacityReason[finding.capacityWait.reason]}</p><ul>{finding.capacityWait.exclusions.map((item,i)=><li key={`${item.profileId}:${i}`} className="break-all">Perfil {item.profileId}: {Object.hasOwn(EXCLUSION_TEXT,item.reason)?EXCLUSION_TEXT[item.reason as keyof typeof EXCLUSION_TEXT]:'Motivo de exclusão desconhecido'}</li>)}</ul></>}
     {finding.nativeFailure&&<><p>Motivo seguro: {nativeFailureCause(finding.nativeFailure.cause)}</p><p>Observação: {nativeFailureOrigin(finding.nativeFailure.origin)}</p></>}
     {finding.evidence.length>0&&<details><summary>Referências ({finding.evidence.length})</summary><ul>{finding.evidence.map((item,i)=><li key={`${item.kind}-${item.id}-${i}`} className="break-all">{item.kind}: {item.id}</li>)}</ul></details>}
    </li>)}</ul>
    {lastPage>0&&<div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>Anteriores</Button>
     <span>Página {currentPage+1} de {lastPage+1}</span><Button type="button" variant="outline" disabled={currentPage===lastPage} onClick={()=>setPage(currentPage+1)}>Próximos</Button></div>}
   </>}
  </>}
 </SettingsField>
}
