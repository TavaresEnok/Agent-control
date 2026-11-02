import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsField } from './settings-field'
import { operatorIdentity,signControl } from './agent-control-operator'
import {AgentControlPolicyEditor,policyEditorSchema} from './agent-control-policy-editor'
import {AgentControlCapacityEditor,capacityEditorSchema} from './agent-control-capacity-editor'

const contextsSchema=z.object({contexts:z.array(z.object({id:z.string().uuid(),paused:z.boolean(),pause_revision:z.number().int().nonnegative()}))})
const usageSchema=z.object({subscriptionBalance:z.literal('unknown'),overlappingCounters:z.literal(true),attempts:z.array(z.object({
 grant_id:z.string().uuid(),role:z.string(),account_id:z.string().uuid(),model:z.string(),effort:z.string(),state:z.string(),
 counters:z.object({input:z.number().nullable(),output:z.number().nullable(),cache:z.number().nullable(),reasoning:z.number().nullable()}).nullable(),
 observed_at:z.string().nullable()}))})
const resourcesSchema=z.object({installationId:z.string().uuid(),principalId:z.string(),verifierDigest:z.string().regex(/^[a-f0-9]{64}$/),contextId:z.string(),assignedPolicyRevision:z.number().nullable(),
 capacity:capacityEditorSchema.nullable(),canConfigureCapacity:z.boolean(),
 accounts:z.array(z.object({id:z.string(),label:z.string(),provider:z.string(),quota_status:z.string(),eligibility:z.string(),enabled:z.boolean(),revision:z.number().int().positive(),can_manage:z.boolean()})),
 profiles:z.array(z.object({id:z.string(),account_id:z.string(),model:z.string(),effort:z.string(),role:z.string(),enabled:z.boolean(),revision:z.number().int().positive(),can_manage:z.boolean()})),
 policies:z.array(z.object({revision:z.number(),snapshot:policyEditorSchema.optional()})),
 qualityPolicies:z.array(z.object({revision:z.number()})),
 templates:z.array(z.object({revision:z.number(),snapshot:z.object({workflow:z.string(),qualityRevision:z.number().optional(),targetRef:z.string().optional()})})),
 activeTemplateRevision:z.number().nullable(),
 waits:z.array(z.object({attempt_id:z.string(),role:z.string(),reason:z.string().nullable()})),
 grants:z.array(z.object({id:z.string(),role:z.string(),state:z.string(),profile_id:z.string(),emergency:z.boolean()}))})
async function request(path:string,body?:unknown,extraHeaders:Record<string,string>={}):Promise<unknown>{
 const response=await fetch(path,{method:body?'POST':'GET',credentials:'include',headers:{...(body?{'content-type':'application/json'}:{}),...extraHeaders},
  body:body?JSON.stringify(body):undefined})
 const value:unknown=await response.json()
 if(!response.ok){const parsed=z.object({error:z.string()}).safeParse(value);throw Error(parsed.success?parsed.data.error:`HTTP_${response.status}`)}
 return value
}
/** Uses the existing Settings shell; all state comes from the PG authority. */
export function AgentControlSection(){
 const cache=useQueryClient()
 const [selected,setSelected]=useState(''),[label,setLabel]=useState(''),[account,setAccount]=useState('')
 const [model,setModel]=useState(''),[role,setRole]=useState('programmer'),[effort,setEffort]=useState('medium')
 const [requiredReviews,setRequiredReviews]=useState(1),[requireHuman,setRequireHuman]=useState(false),[requireJudge,setRequireJudge]=useState(false)
 const [templateWorkflow,setTemplateWorkflow]=useState('baseline-synthetic-v1'),[qualityRevision,setQualityRevision]=useState(''),[targetRef,setTargetRef]=useState('refs/heads/protected')
 const [bootstrapToken,setBootstrapToken]=useState(''),[newDevice,setNewDevice]=useState(''),[newPublicKey,setNewPublicKey]=useState('')
 const identity=useQuery({queryKey:['ac-operator-device'],queryFn:operatorIdentity})
 const contexts=useQuery({queryKey:['ac-contexts'],queryFn:async()=>contextsSchema.parse(await request('/api/v1/ac/contexts'))})
 const contextId=selected||contexts.data?.contexts[0]?.id||''
 const resources=useQuery({queryKey:['ac-resources',contextId],enabled:!!contextId,
  queryFn:async()=>resourcesSchema.parse(await request(`/api/v1/ac/contexts/${contextId}/resources`))})
 const usage=useQuery({queryKey:['ac-usage',contextId],enabled:!!contextId,
  queryFn:async()=>usageSchema.parse(await request(`/api/v1/ac/contexts/${contextId}/usage`))})
 const mutate=useMutation({mutationFn:async(command:{action:string;payload:unknown})=>{
   const storageKey=`ac-control-pending:${contextId}`
   const semantic=JSON.stringify(command)
   const stored=z.object({semantic:z.string(),intentId:z.string().uuid()}).safeParse(JSON.parse(sessionStorage.getItem(storageKey)||'null'))
   const intentId=stored.success&&stored.data.semantic===semantic?stored.data.intentId:crypto.randomUUID()
   sessionStorage.setItem(storageKey,JSON.stringify({semantic,intentId}))
   if(!resources.data)throw Error('CONTEXT_NOT_READY')
   const body={schemaVersion:1,intentId,deliveryAttemptId:crypto.randomUUID(),contextId,...command}
   const proof=await signControl(resources.data.principalId,body,resources.data.installationId)
   const result=z.object({intentId:z.string(),state:z.literal('applied')}).passthrough().parse(await request('/api/v1/ac/control',body,{'x-ac-operator-proof':proof}))
   sessionStorage.removeItem(storageKey)
   return result
  },onSuccess:()=>{void cache.invalidateQueries({queryKey:['ac-resources',contextId]});void cache.invalidateQueries({queryKey:['ac-contexts']})},
  onError:error=>{if(['ACCOUNT_PROFILE_REVISION_CONFLICT','CAPACITY_CONFIG_CONFLICT','POLICY_CONFLICT'].includes(error.message))void cache.invalidateQueries({queryKey:['ac-resources',contextId]})}})
 const bootstrap=useMutation({mutationFn:async()=>{
  if(!identity.data)throw Error('DEVICE_KEY_UNAVAILABLE')
  return z.object({state:z.literal('active')}).parse(await request('/api/v1/ac/operator/bootstrap',
   {...identity.data,token:bootstrapToken}))
 },onSettled:()=>setBootstrapToken('')})
 const data=resources.data
 const selectedContext=contexts.data?.contexts.find(c=>c.id===contextId)
 const busy=mutate.isPending||bootstrap.isPending
 const selectStyle='h-9 min-w-0 max-w-full rounded-md border border-input bg-card px-2 text-sm'
 return <div className="flex min-w-0 flex-col gap-6">
  <SettingsField title="Agent Control" hint="Contas de laboratório, políticas publicadas e capacidade confirmada.">
   <label className="flex flex-col gap-1">Conversa
    <select aria-label="Conversa" className={selectStyle} value={contextId} onChange={e=>setSelected(e.target.value)}>
     {contexts.data?.contexts.map(c=><option key={c.id} value={c.id}>{c.id}{c.paused?' — pausada':''}</option>)}
    </select>
   </label>
   {selectedContext&&<div className="flex flex-wrap items-center gap-2">
    <span>{selectedContext.paused?'Pausada':'Ativa'}</span>
    <Button disabled={busy} onClick={()=>mutate.mutate({action:'context.pause',payload:{paused:!selectedContext.paused,expectedRevision:selectedContext.pause_revision}})}>
     {selectedContext.paused?'Retomar conversa':'Pausar conversa'}
    </Button>
   </div>}
  </SettingsField>
  {(contexts.error||resources.error||usage.error)&&<p role="alert">{(contexts.error||resources.error||usage.error)?.message}</p>}
  {mutate.error&&<p role="alert">{mutate.error.message}</p>}
  {mutate.isSuccess&&<p role="status">Alteração aplicada e persistida.</p>}
  {identity.error&&<p role="alert">{identity.error.message}</p>}
  {identity.data&&<SettingsField title="Dispositivo de administração" hint="A chave privada permanece neste navegador. O administrador precisa autorizar a chave pública antes da primeira alteração.">
   <p className="break-all text-xs">{identity.data.deviceId}</p>
   <p className="break-all font-mono text-xs">{identity.data.publicKey}</p>
   <form className="flex flex-col gap-2" onSubmit={e=>{e.preventDefault();bootstrap.mutate()}}>
    <Input type="password" aria-label="Código de ativação" autoComplete="one-time-code" pattern="[a-f0-9]{64}" maxLength={64}
     value={bootstrapToken} onChange={e=>setBootstrapToken(e.target.value)} required/>
    <Button type="submit" disabled={busy||bootstrapToken.length!==64}>Ativar este dispositivo</Button>
   </form>
   {bootstrap.error&&<p role="alert">{bootstrap.error.message}</p>}
   {bootstrap.isSuccess&&<p role="status">Dispositivo autorizado.</p>}
   <form className="flex flex-col gap-2" onSubmit={e=>{e.preventDefault();mutate.mutate({action:'device.enroll',payload:{deviceId:newDevice,publicKey:newPublicKey}})}}>
    <Input aria-label="Identificador do outro dispositivo" value={newDevice} onChange={e=>setNewDevice(e.target.value)} required/>
    <Input aria-label="Chave pública do outro dispositivo" value={newPublicKey} onChange={e=>setNewPublicKey(e.target.value)} required/>
    <Button type="submit" disabled={busy||!newDevice||!newPublicKey}>Autorizar outro dispositivo</Button>
   </form>
  </SettingsField>}
  {data&&<>
   <SettingsField title="Contas" hint="Cota sem observação válida aparece como unknown. Desabilitar impede novas concessões nos projetos que compartilham a conta; trabalhos já iniciados preservam seus recibos. Nenhuma assinatura real é utilizada.">
    <ul className="flex flex-col gap-2">{data.accounts.map(a=><li key={a.id} className="break-words rounded-md border p-3">
     <strong>{a.label}</strong> · {a.provider}<br/>{a.enabled?'Habilitada':'Desabilitada'} · {a.quota_status} · {a.eligibility}<br/>
     {a.can_manage?<Button type="button" disabled={busy} onClick={()=>mutate.mutate({action:'account.state',payload:{id:a.id,enabled:!a.enabled,expectedRevision:a.revision}})}>
      {a.enabled?'Desabilitar conta':'Habilitar conta'}
     </Button>:<span className="text-xs">Gerenciada pelo titular da conta.</span>}
    </li>)}</ul>
    <form className="flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();const id=crypto.randomUUID();mutate.mutate({action:'account.add',payload:{
     id,provider:'synthetic',label,resourceIdentity:`synthetic-${id}`,mode:'synthetic',eligibility:'not_assessed',
     eligibilitySource:'synthetic://manual-registration',maxConcurrent:1}})}}>
     <Input aria-label="Nome da conta simulada" value={label} onChange={e=>setLabel(e.target.value)} required maxLength={100}/>
     <Button disabled={busy||!label} type="submit">Adicionar conta simulada</Button>
    </form>
   </SettingsField>
   <SettingsField title="Perfis" hint="Modelo, esforço e função pertencem a um perfil de uma conta específica.">
    <ul className="flex flex-col gap-2">{data.profiles.map(p=><li key={p.id} className="break-words rounded-md border p-3">{p.model} · {p.effort} · {p.role} · {p.enabled?'Habilitado':'Desabilitado'}<br/>
     {p.can_manage?<Button type="button" disabled={busy} onClick={()=>mutate.mutate({action:'profile.state',payload:{id:p.id,enabled:!p.enabled,expectedRevision:p.revision}})}>
      {p.enabled?'Desabilitar perfil':'Habilitar perfil'}
     </Button>:<span className="text-xs">Gerenciado pelo titular da conta.</span>}
    </li>)}</ul>
    <form className="flex flex-col gap-2" onSubmit={e=>{e.preventDefault();mutate.mutate({action:'profile.add',payload:{id:crypto.randomUUID(),accountId:account,model,effort,role}})}}>
     <select aria-label="Conta do perfil" className={selectStyle} required value={account} onChange={e=>setAccount(e.target.value)}>
      <option value="">Selecione a conta</option>{data.accounts.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}
     </select>
     <Input aria-label="Modelo" required value={model} onChange={e=>setModel(e.target.value)} maxLength={100}/>
     <select aria-label="Função" className={selectStyle} value={role} onChange={e=>setRole(e.target.value)}>
      {['manager','programmer','reviewer','qa','specialist','judge'].map(r=><option key={r}>{r}</option>)}
     </select>
     <select aria-label="Esforço" className={selectStyle} value={effort} onChange={e=>setEffort(e.target.value)}>
      {['low','medium','high'].map(r=><option key={r}>{r}</option>)}
     </select>
     <Button disabled={busy||!account||!model} type="submit">Cadastrar perfil</Button>
    </form>
   </SettingsField>
   <SettingsField title="Capacidade global" hint="Alterações afetam todas as conversas e exigem administrador da central.">
    <AgentControlCapacityEditor key={data.principalId} config={data.capacity} canEdit={data.canConfigureCapacity} accounts={data.accounts} busy={busy}
     onSave={payload=>mutate.mutate({action:'capacity.configure',payload})}/>
   </SettingsField>
   <SettingsField title="Política" hint={`Revisão atribuída: ${data.assignedPolicyRevision??'nenhuma'}. Publicar não altera tentativas em andamento.`}>
    <AgentControlPolicyEditor key={contextId} profiles={data.profiles} accounts={data.accounts} policies={data.policies} busy={busy}
     onPublish={payload=>mutate.mutate({action:'policy.publish',payload})}/>
    <div className="flex flex-wrap gap-2">{data.policies.map(p=><Button key={p.revision} disabled={busy||data.assignedPolicyRevision===p.revision}
     onClick={()=>mutate.mutate({action:'policy.assign',payload:{revision:p.revision}})}>Usar revisão {p.revision}</Button>)}</div>
   </SettingsField>
   <SettingsField title="Revisão e QA" hint="Uma revisão aprovada deve referir-se ao mesmo código e usar uma sessão independente.">
    <form className="flex flex-col gap-2" onSubmit={e=>{e.preventDefault();mutate.mutate({action:'quality.publish',payload:{
     expectedRevision:data.qualityPolicies.at(-1)?.revision??0,policy:{schemaVersion:1,requiredReviews,allowLowRiskQaWaiver:false,requireHumanIntegration:requireHuman,requireJudge,verifierDigest:data.verifierDigest}}})}}>
     <label>Quantidade de revisores <select className={selectStyle} value={requiredReviews} onChange={e=>setRequiredReviews(Number(e.target.value))}>
      {[1,2,3].map(n=><option key={n} value={n}>{n}</option>)}
     </select></label>
     <label className="flex items-center gap-2"><input type="checkbox" checked={requireHuman} onChange={e=>setRequireHuman(e.target.checked)}/>
      Exigir aprovação humana para integrar</label>
     <label className="flex items-center gap-2"><input type="checkbox" checked={requireJudge} onChange={e=>setRequireJudge(e.target.checked)}/>
      Incluir julgador depois das revisões</label>
     <Button disabled={busy} type="submit">Publicar política de revisão</Button>
    </form>
   </SettingsField>
   <SettingsField title="Fluxo da conversa" hint={`Revisão ativa: ${data.activeTemplateRevision??'padrão'}. Solicitações anteriores mantêm seu fluxo congelado.`}>
    <form className="flex flex-col gap-2" onSubmit={e=>{e.preventDefault();const template=templateWorkflow==='engineering-synthetic-v1'
     ?{workflow:templateWorkflow,qualityRevision:Number(qualityRevision),targetRef}:{workflow:templateWorkflow}
     mutate.mutate({action:'template.publish',payload:{expectedRevision:data.templates.at(-1)?.revision??0,template}})}}>
     <select aria-label="Fluxo" className={selectStyle} value={templateWorkflow} onChange={e=>setTemplateWorkflow(e.target.value)}>
      <option value="baseline-synthetic-v1">Fluxo básico de teste</option>
      <option value="engineering-synthetic-v1">Implementação, QA, revisão e integração — teste</option>
     </select>
     {templateWorkflow==='engineering-synthetic-v1'&&<>
      <select aria-label="Política de revisão" className={selectStyle} required value={qualityRevision} onChange={e=>setQualityRevision(e.target.value)}>
       <option value="">Selecione a revisão</option>{data.qualityPolicies.map(p=><option key={p.revision} value={p.revision}>Revisão {p.revision}</option>)}
      </select>
      <Input aria-label="Branch de destino" value={targetRef} onChange={e=>setTargetRef(e.target.value)} required/>
     </>}
     <Button disabled={busy||(templateWorkflow==='engineering-synthetic-v1'&&(!qualityRevision||!targetRef))} type="submit">Publicar e usar fluxo</Button>
    </form>
    <div className="flex flex-wrap gap-2">{data.templates.map(t=><Button key={t.revision} disabled={busy||data.activeTemplateRevision===t.revision}
     onClick={()=>mutate.mutate({action:'template.assign',payload:{revision:t.revision}})}>Usar fluxo {t.revision}</Button>)}</div>
   </SettingsField>
   <SettingsField title="Concessões" hint="Processos incertos continuam consumindo capacidade até reconciliação.">
    <ul className="flex flex-col gap-2">{data.waits.map(w=><li key={w.attempt_id} className="break-words rounded-md border p-3">
     {w.role} · {w.reason==='CAPACITY_BUSY'?'Aguardando vaga':w.reason==='CAPACITY_QUEUED'?'Aguardando sua vez':'Nenhum perfil elegível disponível'}
    </li>)}</ul>
    <ul className="flex flex-col gap-2">{data.grants.map(g=><li key={g.id} className="break-words rounded-md border p-3">
     {g.role} · {g.state}{g.emergency?' · reserva emergencial':''}<br/><span className="text-xs">{g.id}</span>
    </li>)}</ul>
   </SettingsField>
   <SettingsField title="Uso por tentativa" hint="Contadores informados pelo executor, não saldo da assinatura. Cache e raciocínio podem estar incluídos em entrada e saída.">
    <p>Saldo da assinatura: desconhecido</p>
    {usage.data?.attempts.length===0&&<p>Nenhuma tentativa registrada nesta conversa.</p>}
    <ul className="flex flex-col gap-2">{usage.data?.attempts.map(item=><li key={item.grant_id} className="break-words rounded-md border p-3">
     <strong>{item.model} · {item.effort}</strong><br/>{item.role} · {item.state}<br/>
     {item.counters?<>Entrada: {item.counters.input?.toLocaleString()??'desconhecida'} · Saída: {item.counters.output?.toLocaleString()??'desconhecida'}<br/>
      Cache: {item.counters.cache?.toLocaleString()??'desconhecido'} · Raciocínio: {item.counters.reasoning?.toLocaleString()??'desconhecido'}</>:<>Uso ainda não informado.</>}
    </li>)}</ul>
   </SettingsField>
  </>}
 </div>
}
