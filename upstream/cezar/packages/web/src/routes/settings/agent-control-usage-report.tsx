import {useMutation} from '@tanstack/react-query'
import {useState} from 'react'
import {z} from 'zod'
import {Button} from '@/components/ui/button'
import {Input} from '@/components/ui/input'
import {SettingsField} from './settings-field'
import {agentControlFetch} from './agent-control-fetch'

const exact=z.string().regex(/^-?\d+$/)
const counters=z.object({input:exact.nullable(),output:exact.nullable(),cache:exact.nullable(),reasoning:exact.nullable()})
const summaryCounter=z.object({knownSubtotal:exact,completeTotal:exact.nullable(),knownAttempts:z.number().int().nonnegative(),unknownAttempts:z.number().int().nonnegative()})
const summary=z.object({wallMilliseconds:summaryCounter.optional(),attempts:z.number().int().nonnegative(),counters:z.record(z.string(),z.object({knownSubtotal:exact,completeTotal:exact.nullable(),knownAttempts:z.number().int().nonnegative(),unknownAttempts:z.number().int().nonnegative()}))})
const reportSchema=z.object({schemaVersion:z.literal(1),scope:z.literal('reported_attempt_usage_deltas'),subscriptionBalance:z.literal('unknown'),monetaryCost:z.literal('unknown'),overlappingCounters:z.literal(true),profileMetadata:z.literal('current'),reworkDefinition:z.literal('recorded_correction_decision'),timeDefinition:z.literal('completed_stage_lifecycle_wall_including_reconciliation_delay').optional(),consistency:z.literal('per_request_snapshot').optional(),contextId:z.string().uuid(),periods:z.object({current:z.object({from:z.string(),to:z.string()}),previous:z.object({from:z.string(),to:z.string()})}),attempts:z.array(z.object({grantId:z.string().uuid(),model:z.string(),effort:z.string(),rework:z.boolean(),time:z.object({wallMilliseconds:exact.nullable(),source:z.enum(['stage_lifecycle_timestamps','unknown']),activeModelMilliseconds:z.null()}).optional(),baseline:z.string(),counters})),comparison:z.array(z.object({profileId:z.string().uuid(),model:z.string(),effort:z.string(),rework:z.boolean(),current:summary,previous:summary,delta:counters,deltaWallMilliseconds:exact.nullable().optional()})),nextCursor:z.string().nullable(),page:z.object({limit:z.number().int().positive(),complete:z.boolean()})})
type Filters={from:string;to:string;profileId:string;rework:string}
type Page={filters:Filters;cursor:string|null;report:z.infer<typeof reportSchema>}
const names={input:'Entrada',output:'Saída',cache:'Cache',reasoning:'Raciocínio'}
export function usageReportParams(filters:Filters,cursor:string|null){const query=new URLSearchParams({from:filters.from,to:filters.to,rework:filters.rework,limit:'100'});if(filters.profileId)query.set('profileId',filters.profileId);if(cursor)query.set('cursor',cursor);return query.toString()}
export function AgentControlUsageReport({contextId,profiles}:{contextId:string;profiles:{id:string;model:string;effort:string}[]}){
 const [from,setFrom]=useState(()=>new Date(Date.now()-7*86400000).toISOString().slice(0,16)),[to,setTo]=useState(()=>new Date().toISOString().slice(0,16)),[profileId,setProfileId]=useState(''),[rework,setRework]=useState('all'),[stored,setCurrent]=useState<Page|null>(null)
 const current=stored?.report.contextId===contextId?stored:null
 const load=useMutation({mutationFn:async(input:{filters:Filters;cursor:string|null})=>{
  const start=Date.parse(input.filters.from),end=Date.parse(input.filters.to)
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>93*86400000)throw Error('Selecione um período positivo de até 93 dias.')
  const filters={...input.filters,from:new Date(start).toISOString(),to:new Date(end).toISOString()}
  const response=await agentControlFetch(`/api/v1/ac/contexts/${contextId}/usage/report?${usageReportParams(filters,input.cursor)}`)
  if(!response.ok)throw Error(`Não foi possível consultar o relatório (${response.status}).`)
  const report=reportSchema.parse(await response.json());if(report.contextId!==contextId)throw Error('REPORT_CONTEXT_MISMATCH')
  return {...input,filters,report}
 },onSuccess:setCurrent})
 const download=useMutation({mutationFn:async()=>{
  if(!current)throw Error('REPORT_REQUIRED')
  const response=await agentControlFetch(`/api/v1/ac/contexts/${contextId}/usage/report.csv?${usageReportParams(current.filters,current.cursor)}`)
  if(!response.ok)throw Error(`Não foi possível baixar a página (${response.status}).`)
  const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download='uso-pagina.csv';document.body.append(link);try{link.click()}finally{link.remove();URL.revokeObjectURL(url)}
 }})
 return <SettingsField title="Relatório de uso por período" hint="Contadores relatados por tentativa; saldo e custo monetário continuam desconhecidos. Contadores podem se sobrepor.">
  <form className="flex min-w-0 flex-col gap-2" onSubmit={event=>{event.preventDefault();load.mutate({filters:{from:from+':00Z',to:to+':00Z',profileId,rework},cursor:null})}}>
   <label>Início UTC<Input aria-label="Início UTC" type="datetime-local" value={from} onChange={event=>setFrom(event.target.value)} required/></label>
   <label>Fim UTC<Input aria-label="Fim UTC" type="datetime-local" value={to} onChange={event=>setTo(event.target.value)} required/></label>
   <label className="flex min-w-0 flex-col gap-1">Perfil do relatório<select aria-label="Perfil do relatório" className="min-h-11 min-w-0 max-w-full rounded-md border px-2" value={profileId} onChange={event=>setProfileId(event.target.value)}><option value="">Todos os perfis</option>{profiles.map(profile=><option key={profile.id} value={profile.id}>{profile.model} · {profile.effort}</option>)}</select></label>
   <label className="flex min-w-0 flex-col gap-1">Retrabalho registrado<select aria-label="Retrabalho registrado" className="min-h-11 rounded-md border px-2" value={rework} onChange={event=>setRework(event.target.value)}><option value="all">Todas as tentativas</option><option value="only">Apenas correções registradas</option><option value="exclude">Excluir correções registradas</option></select></label>
   <Button type="submit" disabled={load.isPending}>Consultar relatório de uso</Button>
  </form>
  {load.error&&<p role="alert">{load.error.message}</p>}
  {current&&<div className="flex min-w-0 flex-col gap-2 break-words">
   <p>Período UTC: {current.report.periods.current.from} a {current.report.periods.current.to}. Comparação: {current.report.periods.previous.from} a {current.report.periods.previous.to}.</p>
   <p>Modelo e esforço são metadados atuais. Retrabalho significa decisão de correção registrada. Tempo de ciclo inclui atraso de reconciliação; tempo ativo do modelo é desconhecido. Cada página é uma leitura própria, sem snapshot entre páginas.</p>
   {current.report.comparison.map(row=><div key={`${row.profileId}:${row.rework}`} className="min-w-0 rounded-md border p-2"><p>{row.model} · {row.effort} · {row.rework?'correção registrada':'demais tentativas'}</p><p>Tempo de ciclo (ms): {row.current.wallMilliseconds?.completeTotal??'desconhecido'}; subtotal conhecido {row.current.wallMilliseconds?.knownSubtotal??'desconhecido'}; diferença {row.deltaWallMilliseconds??'desconhecida'}.</p>{Object.entries(names).map(([key,label])=><p key={key}>{label}: {row.current.counters[key]?.completeTotal??'desconhecido'}; subtotal conhecido {row.current.counters[key]?.knownSubtotal??'desconhecido'}; tentativas sem contador {row.current.counters[key]?.unknownAttempts??'desconhecido'}; diferença {row.delta[key as keyof typeof names]??'desconhecida'}.</p>)}</div>)}
   <p role="status">Esta página contém {current.report.attempts.length} tentativas. {current.report.page.complete?'Última página.':'Há páginas seguintes.'}</p>
   {current.report.attempts.map(attempt=><div key={attempt.grantId} className="min-w-0 rounded-md border p-2"><p>{attempt.model} · {attempt.effort} · {attempt.rework?'correção registrada':'tentativa'}</p><p>Tempo de ciclo (ms): {attempt.time?.wallMilliseconds??'desconhecido'}; tempo ativo do modelo: desconhecido.</p>{Object.entries(names).map(([key,label])=><p key={key}>{label}: {attempt.counters[key as keyof typeof names]??'desconhecido'}</p>)}</div>)}
   <Button variant="outline" disabled={!current.report.nextCursor||load.isPending} onClick={()=>load.mutate({filters:current.filters,cursor:current.report.nextCursor})}>Próxima página de tentativas</Button>
   <Button variant="outline" disabled={download.isPending} onClick={()=>download.mutate()}>Baixar CSV desta página</Button>
   <p className="text-xs">O CSV contém uma página, com sua continuação explícita; não é uma exportação integral. Contadores desconhecidos permanecem vazios no CSV.</p>
  </div>}
  {download.error&&<p role="alert">{download.error.message}</p>}
 </SettingsField>
}
