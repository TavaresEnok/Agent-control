import {useEffect,useState} from 'react'
import {useQuery} from '@tanstack/react-query'
import {agentControlOperationalSnapshotSchema,agentControlSloReportSchema,type AgentControlOperationalSnapshot,type AgentControlSloReport} from '@open-mercato/cezar-api-client'
import {Button} from '@/components/ui/button'
import {SettingsField} from './settings-field'
import {agentControlFetch,narrowManagerPlanQuery} from './agent-control-fetch'
import {useProjectScope} from '@/api/project-scope-context'
function samples(data:AgentControlOperationalSnapshot,name:string){return data.metrics.find(metric=>metric.name===`agent_control_${name}`)?.samples??[]}
function value(data:AgentControlOperationalSnapshot,name:string,state?:string){const rows=samples(data,name);return state===undefined?rows[0]?.value:rows.find(row=>row.labels.state===state)?.value}
function bytes(value:string){const tenths=BigInt(value)*10n/1073741824n;return `${tenths/10n},${tenths%10n} GiB`}
function OperationalReadout({data}:{data:AgentControlOperationalSnapshot}){
 const volumes=samples(data,'disk_observation_available')
 const waitMetric=data.metrics.find(metric=>metric.name==='agent_control_capacity_waits')
 const wait=waitMetric?String(waitMetric.samples.reduce((sum,row)=>sum+BigInt(row.value),0n)):'não informado'
 return <div className="flex min-w-0 flex-col gap-3">
  <p className="text-xs text-muted-foreground">Observado em {new Date(data.observedAt).toLocaleString()}. Agregado da central; estados podem se sobrepor.</p>
  <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
   {[['Admissão de novas execuções',value(data,'admission_enabled')==='1'?'Aberta':value(data,'admission_enabled')==='0'?'Fechada':'não informado'],
    ['Concessões em execução',value(data,'grants','running')??'não informado'],['Concessões com efeito incerto',value(data,'grants','uncertain')??'não informado'],
    ['Concessões reservadas',value(data,'grants','reserved')??'não informado'],['Aguardando capacidade',wait],
    ['Gerentes com lease válida',value(data,'managers','leased')??'não informado'],['Gerentes com lease vencida',value(data,'managers','stale')??'não informado']].map(([label,observed])=>
    <div key={label} className="rounded-md border p-3"><dt className="text-muted-foreground">{label}</dt><dd className="font-medium">{observed}</dd></div>)}
  </dl>
  <div className="rounded-md border p-3 text-sm">
   <strong>Disco</strong>
   {data.diskObservation==='not_configured'?<p>Medição de disco não configurada. Nenhum saldo de espaço foi estimado.</p>:
    volumes.length===0?<p>Medição de disco indisponível.</p>:volumes.map((volume,index)=>{
     const available=samples(data,'disk_available_bytes').find(row=>row.labels.volume===volume.labels.volume)?.value
     const total=samples(data,'disk_total_bytes').find(row=>row.labels.volume===volume.labels.volume)?.value
     const below=samples(data,'disk_below_admission_floor').find(row=>row.labels.volume===volume.labels.volume)?.value==='1'
     return <div key={volume.labels.volume} className="mt-2"><p>Volume {index+1}: {volume.value!=='1'||available===undefined?'medição indisponível':`${bytes(available)} disponíveis${total===undefined?'':` de ${bytes(total)}`}`}</p>
      {below&&<p role="status">Espaço abaixo do piso de admissão configurado.</p>}</div>
    })}
  </div>
 </div>
}
const SLO_ORDER=['manager_availability','dispatch_latency','queue_backlog','pending_receipt_age','infrastructure_failure_rate'] as const
const SLO_LABEL:Record<(typeof SLO_ORDER)[number],string>={
 manager_availability:'Disponibilidade dos gerentes',
 dispatch_latency:'Latência de despacho',
 queue_backlog:'Fila aguardando capacidade',
 pending_receipt_age:'Idade do recibo pendente',
 infrastructure_failure_rate:'Taxa de falha de infraestrutura',
}
const STATUS_LABEL={ok:'dentro do objetivo',violated:'violado',unknown:'desconhecido'} as const
const REASON_LABEL:Record<string,string>={
 within_objective:'A medição ficou dentro do objetivo da bancada.',
 objective_missed:'A medição ficou fora do objetivo da bancada.',
 snapshot_absent:'Não há snapshot. Isso não confirma o objetivo.',
 snapshot_incomplete:'Snapshot incompleto. Isso não confirma o objetivo.',
 snapshot_stale:'Snapshot além do limite de frescor. Isso não confirma o objetivo.',
 snapshot_clock_ahead:'O snapshot está no futuro. Isso não confirma o objetivo.',
 snapshot_timestamp_invalid:'Instante do snapshot inválido. Isso não confirma o objetivo.',
 evaluation_clock_invalid:'Relógio de avaliação inválido. Isso não confirma o objetivo.',
 required_signal_absent:'Sinal necessário ausente. Ausência não é cumprimento.',
 signal_incomplete:'Sinal incompleto. Isso não confirma o objetivo.',
 unclassified_samples:'Amostras fora do catálogo. Isso não confirma o objetivo.',
 no_population:'Sem população para a conta. Isso não é cumprimento.',
 value_invalid:'Valor inválido. Isso não confirma o objetivo.',
}
const UNKNOWN_REASON:Record<string,string>={
 snapshot_absent:'Não há snapshot. Desconhecido não é cumprimento do objetivo.',
 snapshot_incomplete:'Snapshot incompleto. Desconhecido não é cumprimento do objetivo.',
 snapshot_stale:'Snapshot além do limite de frescor. Desconhecido não é cumprimento do objetivo.',
 snapshot_clock_ahead:'O snapshot está no futuro. Desconhecido não é cumprimento do objetivo.',
 snapshot_timestamp_invalid:'Instante do snapshot inválido. Desconhecido não é cumprimento do objetivo.',
 evaluation_clock_invalid:'Relógio de avaliação inválido. Desconhecido não é cumprimento do objetivo.',
 required_signal_absent:'Sinal necessário ausente. Ausência não é cumprimento. Desconhecido não é cumprimento do objetivo.',
 signal_incomplete:'Sinal incompleto. Desconhecido não é cumprimento do objetivo.',
 unclassified_samples:'Amostras fora do catálogo. Desconhecido não é cumprimento do objetivo.',
 no_population:'Sem população para a conta. Desconhecido não é cumprimento do objetivo.',
 value_invalid:'Valor inválido. Desconhecido não é cumprimento do objetivo.',
 objective_missed:'O objetivo não foi confirmado. Desconhecido não é cumprimento do objetivo.',
 within_objective:'O relatório não confirmou cumprimento. Desconhecido não é cumprimento do objetivo.',
}
export const sloUnavailableMessage='Níveis de serviço indisponíveis. Nenhum indicador foi confirmado como dentro do objetivo.'
function grouped(headroom:string){
 const negative=headroom.startsWith('-')
 const digits=(negative?headroom.slice(1):headroom).replace(/\B(?=(\d{3})+(?!\d))/g,'.')
 return {negative,digits}
}
function formatMargin(margin:AgentControlSloReport['results'][number]['margin']){
 if(!margin)return 'Sem margem. Nada foi apresentado como folga.'
 const value=grouped(margin.headroom)
 const relation=value.negative?'abaixo do objetivo':'de folga'
 const unit=margin.unit==='ppm'?'ppm':margin.unit==='count'?'itens':'segundos'
 return `${value.digits} ${unit} ${relation}`
}
function reasonText(status:keyof typeof STATUS_LABEL,reason:string){
 if(status==='unknown')return UNKNOWN_REASON[reason]??`Motivo não catalogado nesta tela: ${reason}. Desconhecido não é cumprimento do objetivo.`
 return REASON_LABEL[reason]??`Motivo não catalogado nesta tela: ${reason}.`
}
function formatWindow(window:AgentControlSloReport['results'][number]['window']){
 if(window.ageSeconds===null)return `Frescor máximo ${window.freshnessLimitSeconds} segundos. Sem idade de observação confirmada.`
 const value=grouped(window.ageSeconds)
 const signed=`${value.negative?'-':''}${value.digits}`
 return `Frescor máximo ${window.freshnessLimitSeconds} segundos. Idade da observação: ${signed} segundos.`
}
function useNarrowSloLayout(){
 const [narrow,setNarrow]=useState(()=>typeof window!=='undefined'&&typeof window.matchMedia==='function'&&window.matchMedia(narrowManagerPlanQuery).matches)
 useEffect(()=>{
  if(typeof window.matchMedia!=='function')return
  const media=window.matchMedia(narrowManagerPlanQuery)
  const apply=()=>setNarrow(media.matches)
  apply()
  media.addEventListener('change',apply)
  return ()=>media.removeEventListener('change',apply)
 },[])
 return narrow
}
function SloReadout({report,narrow}:{report:AgentControlSloReport;narrow:boolean}){
 const byId=new Map(report.results.map(result=>[result.id,result]))
 return <div data-slo-panel="report" data-slo-layout={narrow?'stack':'wide'} className="flex min-w-0 flex-col gap-2">
  <p className="break-words text-xs text-muted-foreground">Catálogo {report.catalogVersion}, agregado da central, janela pontual. Desconhecido não é cumprimento do objetivo.</p>
  <div className="grid min-w-0 grid-cols-1 gap-2">
   {SLO_ORDER.map(id=>{
    const result=byId.get(id)
    if(!result)return null
    const violated=result.status==='violated'
    return <article key={id} data-slo={id} className={`min-w-0 break-words rounded-md border p-3 text-sm ${violated?'border-2 border-destructive bg-destructive/10':'border-border'}`}>
     <h3 className="font-medium">{SLO_LABEL[id]}</h3>
     <p><span className="text-muted-foreground">Estado: </span><strong data-slo-status={result.status}>{STATUS_LABEL[result.status]}</strong></p>
     {violated&&<p role="alert">Objetivo violado. O destaque não depende só da cor.</p>}
     {result.status==='unknown'&&<p role="status">Desconhecido não é cumprimento do objetivo.</p>}
     <p>Motivo: {reasonText(result.status,result.reason)}</p>
     <p>Margem: {formatMargin(result.margin)}</p>
     <p>Janela: {formatWindow(result.window)}</p>
    </article>
   })}
  </div>
 </div>
}
export function AgentControlObservability({enabled}:{enabled:boolean}){
 const {projectId}=useProjectScope()
 const narrow=useNarrowSloLayout()
 const observed=useQuery({queryKey:['ac-operational-observability',projectId],enabled,refetchInterval:15000,queryFn:async()=>{
  const response=await agentControlFetch('/api/v1/ac/observability')
  if(!response.ok)throw Error(`Métricas indisponíveis (HTTP ${response.status}).`)
  return agentControlOperationalSnapshotSchema.parse(await response.json())
 }})
 const sloEnabled=enabled&&projectId!==null
 const slo=useQuery({queryKey:['ac-operational-slo',projectId],enabled:sloEnabled,retry:false,refetchInterval:15000,queryFn:async()=>{
  let response:Response
  try{response=await agentControlFetch('/api/v1/ac/observability/slo')}catch{throw Error(sloUnavailableMessage)}
  if(!response.ok)throw Error(sloUnavailableMessage)
  let body:unknown
  try{body=await response.json()}catch{throw Error(sloUnavailableMessage)}
  const parsed=agentControlSloReportSchema.safeParse(body)
  if(!parsed.success)throw Error(sloUnavailableMessage)
  return parsed.data
 }})
 if(!enabled)return null
 const retryClass=narrow?'min-h-11 h-auto w-full whitespace-normal':'min-h-11 h-auto whitespace-normal'
 return <>
  <SettingsField title="Operação da central" hint="Leitura de estados confirmados no PostgreSQL e medições de disco configuradas. Somente administradores podem consultar este agregado.">
   <Button type="button" variant="outline" disabled={observed.isFetching} onClick={()=>{void observed.refetch()}}>Atualizar métricas</Button>
   {observed.isPending&&<p role="status">Carregando métricas…</p>}{observed.error&&<p role="alert">{observed.error.message}</p>}
   {observed.data&&<OperationalReadout data={observed.data}/>}
  </SettingsField>
  <SettingsField title="Níveis de serviço" hint="Leitura do catálogo versionado no agregado da central. Somente administradores podem consultar. Um estado desconhecido não cumpre o objetivo.">
   {sloEnabled&&!slo.isError&&<Button type="button" variant="outline" className={retryClass} disabled={slo.isFetching} onClick={()=>{void slo.refetch()}}>Atualizar níveis de serviço</Button>}
   {slo.isLoading&&<p role="status">Carregando níveis de serviço…</p>}
   {enabled&&!sloEnabled&&<p role="status">{sloUnavailableMessage}</p>}
   {slo.isError&&<div role="alert" data-slo-panel="unavailable" className="flex min-w-0 flex-col gap-2 break-words">
    <p>{sloUnavailableMessage}</p>
    <Button type="button" variant="outline" className={retryClass} disabled={slo.isFetching} onClick={()=>{void slo.refetch()}}>Tentar novamente</Button>
   </div>}
   {slo.isSuccess&&slo.data&&<SloReadout report={slo.data} narrow={narrow}/>}
  </SettingsField>
 </>
}
