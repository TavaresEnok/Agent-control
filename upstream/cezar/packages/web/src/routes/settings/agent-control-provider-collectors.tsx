import {useEffect,useState} from 'react'
import {type AgentControlProviderBinding,type AgentControlProviderAdapter,type AgentControlProviderBindInput,
 agentControlProviderBindInputSchema} from '@open-mercato/cezar-api-client'
import {Button} from '@/components/ui/button'
import {Input} from '@/components/ui/input'
import {SettingsField} from './settings-field'

type Account={id:string;label:string;provider:string;mode:string;eligibility:string;can_manage:boolean}
type Props={accounts:Account[];bindings:AgentControlProviderBinding[];adapters:AgentControlProviderAdapter[];
 canConfigure:boolean;busy:boolean;onBind:(input:AgentControlProviderBindInput)=>void}
const statuses:Record<string,string>={available:'Disponível',exhausted:'Cota esgotada',rate_limited:'Limite temporário',auth_required:'Login necessário',
 unknown:'Saldo desconhecido',unreachable:'Coletor indisponível',disabled:'Desabilitada',configuration_error:'Configuração inválida'}
const date=(value:string|null)=>value?new Date(value).toLocaleString():'não informado'
export function AgentControlProviderCollectors({accounts,bindings,adapters,canConfigure,busy,onBind}:Props){
 const [accountId,setAccountId]=useState(''),[adapterId,setAdapterId]=useState(''),[interval,setIntervalSeconds]=useState(60),[now,setNow]=useState(Date.now),[expectedRevision,setExpectedRevision]=useState<number|null>(null)
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[])
 const account=accounts.find(account=>account.id===accountId&&account.can_manage)
 const options=adapters.filter(adapter=>!!account&&adapter.provider===account.provider&&adapter.mode===account.mode)
 const existing=bindings.find(binding=>binding.account_id===accountId)
 const revisionChanged=expectedRevision!==null&&expectedRevision!==(existing?.revision??0)
 const valid=expectedRevision!==null&&!revisionChanged&&!!account&&account.eligibility==='documented_supported'&&options.some(adapter=>adapter.id===adapterId)&&interval>=1&&interval<=3600
 const style='h-9 min-w-0 max-w-full rounded-md border bg-card px-2 text-sm'
 return <SettingsField title="Coletas de cota" hint="O saldo só é exibido quando uma observação válida o informa. Tokens registrados e créditos da assinatura são medidas diferentes.">
  {bindings.length===0&&<p>Nenhum coletor vinculado às contas deste projeto.</p>}
  <ul className="flex min-w-0 flex-col gap-2">{bindings.map(binding=>{
   const fresh=binding.fresh&&binding.expires_at!==null&&Date.parse(binding.expires_at)>now
   const observation=fresh?binding.snapshot:null
   const reported=observation?.subscriptionBalance==='reported'&&observation.remainingPercent!==null
   return <li key={binding.account_id} className="min-w-0 break-words rounded-md border p-3 text-sm">
    <strong>{accounts.find(account=>account.id===binding.account_id)?.label??'Conta vinculada'}</strong>
    <p>{statuses[observation?.status??'unknown']} · {reported?`${observation!.remainingPercent}% restante`:'Percentual restante desconhecido'}</p>
    <p>{binding.adapter_id} · versão {binding.adapter_version} · revisão {binding.revision}</p>
    <p>Última coleta: {date(binding.completed_at)} · validade: {date(binding.expires_at)}</p>
    {fresh&&observation?.resetAt&&<p>Renovação informada: {date(observation.resetAt)}</p>}
    {!fresh&&binding.snapshot&&<p role="status">Observação expirada. O saldo anterior foi ocultado.</p>}
    {binding.probe_uncertain?<p role="status">Coleta com resultado incerto; reconciliação necessária antes de repetir.</p>:
     binding.probe_pending&&<p role="status">Coleta em andamento; aguardando resultado.</p>}
   </li>
  })}</ul>
  {canConfigure&&<form className="flex min-w-0 flex-col gap-2" onSubmit={event=>{
   event.preventDefault();if(!valid||!account||existing?.probe_pending||existing?.probe_uncertain)return
   onBind(agentControlProviderBindInputSchema.parse({accountId:account.id,adapterId,expectedRevision:expectedRevision!,minimumIntervalSeconds:interval}))
  }}>
   <label className="flex flex-col gap-1">Conta para coleta<select aria-label="Conta para coleta" className={style} value={accountId} disabled={busy}
    onChange={event=>{setAccountId(event.target.value);setAdapterId('');setExpectedRevision(bindings.find(binding=>binding.account_id===event.target.value)?.revision??0);setIntervalSeconds(bindings.find(binding=>binding.account_id===event.target.value)?.minimum_interval_seconds??60)}}>
    <option value="">Selecione a conta</option>{accounts.filter(account=>account.can_manage).map(account=><option key={account.id} value={account.id}>{account.label}</option>)}
   </select></label>
   <label className="flex flex-col gap-1">Coletor homologado<select aria-label="Coletor homologado" className={style} value={adapterId} disabled={busy||!account}
    onChange={event=>setAdapterId(event.target.value)}><option value="">Selecione o coletor</option>{options.map(adapter=><option key={adapter.id} value={adapter.id}>{adapter.id} · {adapter.version}</option>)}</select></label>
   {account&&!options.length&&<p>Nenhum coletor homologado está disponível para o provedor e modo desta conta.</p>}
   {account&&account.eligibility!=='documented_supported'&&<p>A elegibilidade desta conta ainda não permite vincular um coletor.</p>}
   <label className="flex flex-col gap-1">Intervalo mínimo entre coletas (segundos)<Input type="number" min={1} max={3600} value={interval}
    aria-label="Intervalo mínimo entre coletas" disabled={busy} onChange={event=>setIntervalSeconds(Number(event.target.value))}/></label>
   {revisionChanged&&<div><p role="status">A configuração mudou durante a edição. Recarregue antes de salvar.</p>
    <Button type="button" variant="outline" disabled={busy} onClick={()=>{setExpectedRevision(existing?.revision??0);setAdapterId(existing?.adapter_id??'');setIntervalSeconds(existing?.minimum_interval_seconds??60)}}>Recarregar coletor</Button></div>}
   <Button type="submit" disabled={busy||!valid||!!existing?.probe_pending||!!existing?.probe_uncertain}>Vincular coletor de cota</Button>
   <p className="text-xs text-muted-foreground">Vincular não realiza login nem inicia chamadas de IA. Trocar o coletor invalida o saldo anterior até uma nova observação.</p>
  </form>}
 </SettingsField>
}
