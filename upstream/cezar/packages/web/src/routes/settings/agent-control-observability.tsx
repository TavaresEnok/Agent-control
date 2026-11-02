import {useQuery} from '@tanstack/react-query'
import {agentControlOperationalSnapshotSchema,type AgentControlOperationalSnapshot} from '@open-mercato/cezar-api-client'
import {Button} from '@/components/ui/button'
import {SettingsField} from './settings-field'
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
export function AgentControlObservability({enabled}:{enabled:boolean}){
 const observed=useQuery({queryKey:['ac-operational-observability'],enabled,refetchInterval:15000,queryFn:async()=>{
  const response=await fetch('/api/v1/ac/observability',{credentials:'include'})
  if(!response.ok)throw Error(`Métricas indisponíveis (HTTP ${response.status}).`)
  return agentControlOperationalSnapshotSchema.parse(await response.json())
 }})
 if(!enabled)return null
 return <SettingsField title="Operação da central" hint="Leitura de estados confirmados no PostgreSQL e medições de disco configuradas. Somente administradores podem consultar este agregado.">
  <Button type="button" variant="outline" disabled={observed.isFetching} onClick={()=>{void observed.refetch()}}>Atualizar métricas</Button>
  {observed.isPending&&<p role="status">Carregando métricas…</p>}{observed.error&&<p role="alert">{observed.error.message}</p>}
  {observed.data&&<OperationalReadout data={observed.data}/>}
 </SettingsField>
}
