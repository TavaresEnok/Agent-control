import {useState} from 'react'
import {z} from 'zod'
import {Button} from '@/components/ui/button'
import {Input} from '@/components/ui/input'
import {SettingsField} from './settings-field'

const statuses=z.enum(['documented_supported','requires_clarification','unsupported_for_mode','not_assessed'])
const mode=z.enum(['synthetic','subscription_cli','api'])
const adapter=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/)
const httpsSource=z.string().max(2048).url().refine(value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash}catch{return false}})
export const providerEligibilityViewSchema=z.object({assessments:z.array(z.object({accountId:z.string().uuid(),revision:z.number().int().positive(),provider:z.string(),accountMode:mode,
 plan:z.string(),adapterId:z.string(),adapterVersion:z.string(),authenticationMode:z.enum(['subscription_oauth','api_key','synthetic']),executionMode:z.enum(['central_isolated_cli','api','synthetic']),
 sourceURL:z.string(),status:statuses,effectiveStatus:statuses,reason:z.string(),reviewedAt:z.string(),validForSeconds:z.number(),expiresAt:z.string(),fresh:z.boolean()})),truncated:z.boolean()})
const labels={documented_supported:'Suporte documentado',requires_clarification:'Requer esclarecimento',unsupported_for_mode:'Não suportado neste modo',not_assessed:'Não avaliado'}
const modes={synthetic:{authenticationMode:'synthetic',executionMode:'synthetic'},subscription_cli:{authenticationMode:'subscription_oauth',executionMode:'central_isolated_cli'},api:{authenticationMode:'api_key',executionMode:'api'}} as const
export type ProviderEligibilityPayload={accountId:string;expectedRevision:number;plan:string;adapterId:string;adapterVersion:string;authenticationMode:'subscription_oauth'|'api_key'|'synthetic';executionMode:'central_isolated_cli'|'api'|'synthetic';sourceURL:string;status:z.infer<typeof statuses>;reason:string;reviewedAt:string;validForSeconds:number}
type Props={contextId:string;principalId:string;installationId:string;accounts:{id:string;label:string;mode:string;can_manage:boolean}[];view:z.infer<typeof providerEligibilityViewSchema>;busy:boolean;onPublish:(payload:ProviderEligibilityPayload)=>void}
export function AgentControlProviderEligibility({contextId,principalId,installationId,accounts,view,busy,onPublish}:Props){
 const [accountId,setAccountId]=useState(''),[plan,setPlan]=useState(''),[adapterId,setAdapterId]=useState(''),[adapterVersion,setAdapterVersion]=useState('')
 const [sourceURL,setSourceURL]=useState(''),[status,setStatus]=useState<z.infer<typeof statuses>>('not_assessed'),[reason,setReason]=useState(''),[validForSeconds,setValidForSeconds]=useState(2592000)
 const [draftError,setDraftError]=useState(false),[page,setPage]=useState(0)
 const eligible=accounts.filter(account=>account.can_manage&&mode.safeParse(account.mode).success),selected=eligible.find(account=>account.id===accountId)
 const parsedMode=mode.safeParse(selected?.mode),latest=view.assessments.find(item=>item.accountId===accountId)
 const revisionKnown=!!latest||!view.truncated
 const valid=!!selected&&parsedMode.success&&revisionKnown&&!!plan.trim()&&plan.trim().length<=200&&adapter.safeParse(adapterId).success&&adapter.safeParse(adapterVersion).success&&httpsSource.safeParse(sourceURL).success&&!!reason.trim()&&reason.trim().length<=2000&&Number.isInteger(validForSeconds)&&validForSeconds>=1&&validForSeconds<=2592000
 const lastPage=Math.max(0,Math.ceil(view.assessments.length/10)-1),currentPage=Math.min(page,lastPage)
 const style='h-9 min-w-0 max-w-full rounded-md border border-input bg-card px-2 text-sm'
 const submit=()=>{
  if(!valid||!selected||!parsedMode.success||busy)return
  const fields={accountId:selected.id,expectedRevision:latest?.revision??0,plan:plan.trim(),adapterId,adapterVersion,...modes[parsedMode.data],sourceURL,status,reason:reason.trim(),validForSeconds}
  // Preserve the review instant for an identical retry, including after a page refresh.
  const semantic=JSON.stringify(fields),key=`ac-eligibility-review:${encodeURIComponent(principalId)}:${installationId}:${contextId}:${selected.id}`
  let raw:unknown;try{raw=JSON.parse(sessionStorage.getItem(key)||'null')}catch{throw Error('PENDING_REVIEW_INVALID')}
  const saved=z.object({semantic:z.string(),reviewedAt:z.string().datetime({offset:true})}).safeParse(raw)
  if(raw!==null&&!saved.success)throw Error('PENDING_REVIEW_INVALID')
  const reviewedAt=saved.success&&saved.data.semantic===semantic?saved.data.reviewedAt:new Date().toISOString()
  sessionStorage.setItem(key,JSON.stringify({semantic,reviewedAt}))
  onPublish({...fields,reviewedAt})
 }
 return <SettingsField title="Avaliação de elegibilidade" hint="Registre uma avaliação e sua fonte. O registro não ativa assinatura, CLI ou API e não homologa automaticamente o provedor.">
  <p className="text-sm">Não informe tokens, senhas ou outras credenciais. A fonte HTTPS é registrada, sem ser consultada por esta tela.</p>
  {view.truncated&&<p role="status">A lista de avaliações está limitada; contas ausentes não podem receber nova revisão até a lista estar completa.</p>}
  {view.assessments.length>0&&<><ul className="flex min-w-0 flex-col gap-2">{view.assessments.slice(currentPage*10,(currentPage+1)*10).map(item=><li key={item.accountId} className="min-w-0 break-words rounded-md border p-3 text-sm">
   <strong>{accounts.find(account=>account.id===item.accountId)?.label??item.accountId}</strong> · {item.provider}<br/>
   Situação efetiva: {labels[item.fresh?item.effectiveStatus:'not_assessed']}{!item.fresh?' · avaliação fora da validade':''}<br/>
   Revisão {item.revision} · válida até {new Date(item.expiresAt).toLocaleString()}<br/>
   Plano: {item.plan} · adaptador: {item.adapterId} {item.adapterVersion}<br/>
   <span className="break-all">Fonte: {item.sourceURL}</span><p>{item.reason}</p>
  </li>)}</ul>{lastPage>0&&<div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>Anteriores</Button><span>Página {currentPage+1} de {lastPage+1}</span><Button type="button" variant="outline" disabled={currentPage===lastPage} onClick={()=>setPage(currentPage+1)}>Próximas</Button></div>}</>}
  {eligible.length===0?<p>Nenhuma conta administrável disponível para avaliação.</p>:<form className="flex min-w-0 flex-col gap-2" onSubmit={event=>{event.preventDefault();setDraftError(false);try{submit()}catch{setDraftError(true)}}}>
   <label className="flex flex-col gap-1">Conta para avaliação<select aria-label="Conta para avaliação" className={style} value={accountId} onChange={event=>{setAccountId(event.target.value);setDraftError(false)}} required>
    <option value="">Selecione a conta</option>{eligible.map(account=><option key={account.id} value={account.id}>{account.label}</option>)}
   </select></label>
   {selected&&parsedMode.success&&<p className="text-sm">Autenticação: {modes[parsedMode.data].authenticationMode} · execução: {modes[parsedMode.data].executionMode}.</p>}
   {selected&&!revisionKnown&&<p role="alert">A revisão atual desta conta não está disponível na lista limitada.</p>}
   <label className="flex flex-col gap-1">Plano do provedor<Input value={plan} onChange={event=>setPlan(event.target.value)} maxLength={200} required/></label>
   <label className="flex flex-col gap-1">Identificador do adaptador<Input value={adapterId} onChange={event=>setAdapterId(event.target.value)} maxLength={100} required/></label>
   <label className="flex flex-col gap-1">Versão do adaptador<Input value={adapterVersion} onChange={event=>setAdapterVersion(event.target.value)} maxLength={100} required/></label>
   <label className="flex flex-col gap-1">Fonte HTTPS da avaliação<Input type="url" value={sourceURL} onChange={event=>setSourceURL(event.target.value)} maxLength={2048} required/></label>
   <label className="flex flex-col gap-1">Resultado da avaliação<select aria-label="Resultado da avaliação" className={style} value={status} onChange={event=>setStatus(statuses.parse(event.target.value))}>
    {statuses.options.map(option=><option key={option} value={option}>{labels[option]}</option>)}
   </select></label>
   <label className="flex flex-col gap-1">Justificativa<textarea className="min-h-20 min-w-0 rounded-md border border-input bg-card p-2 text-sm" value={reason} onChange={event=>setReason(event.target.value)} maxLength={2000} required/></label>
   <label className="flex flex-col gap-1">Validade em segundos<Input type="number" min={1} max={2592000} value={validForSeconds} onChange={event=>setValidForSeconds(Number(event.target.value))} required/></label>
   {draftError&&<p role="alert">Não foi possível preservar o rascunho de revisão neste navegador.</p>}
   <Button type="submit" disabled={busy||!valid}>Registrar avaliação assinada</Button>
  </form>}
 </SettingsField>
}
