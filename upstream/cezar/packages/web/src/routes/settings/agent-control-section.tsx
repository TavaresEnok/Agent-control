import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { z } from 'zod'
import {agentControlProviderBindingSchema,agentControlProviderAdapterSchema} from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsField } from './settings-field'
import { operatorIdentity,signControl } from './agent-control-operator'
import {AgentControlPolicyEditor,policyEditorSchema} from './agent-control-policy-editor'
import {AgentControlCapacityEditor,capacityEditorSchema} from './agent-control-capacity-editor'
import {AgentControlProfileEditor,catalogEntrySchema} from './agent-control-profile-editor'
import {AgentControlIntegrationApproval,approvalSchema} from './agent-control-integration-approval'
import {AgentControlManagerPlans} from './agent-control-manager-plans'
import {AgentControlProviderCollectors} from './agent-control-provider-collectors'
import {AgentControlObservability} from './agent-control-observability'

const contextsSchema=z.object({contexts:z.array(z.object({id:z.string().uuid(),paused:z.boolean(),pause_revision:z.number().int().nonnegative(),draining:z.boolean(),drain_revision:z.number().int().nonnegative()}))})
const usageSchema=z.object({subscriptionBalance:z.literal('unknown'),overlappingCounters:z.literal(true),attempts:z.array(z.object({
 grant_id:z.string().uuid(),role:z.string(),account_id:z.string().uuid(),model:z.string(),effort:z.string(),state:z.string(),
 counters:z.object({input:z.number().nullable(),output:z.number().nullable(),cache:z.number().nullable(),reasoning:z.number().nullable()}).nullable(),
 observed_at:z.string().nullable()}))})
const resourcesSchema=z.object({installationId:z.string().uuid(),principalId:z.string(),verifierDigest:z.string().regex(/^[a-f0-9]{64}$/),contextId:z.string(),assignedPolicyRevision:z.number().nullable(),
 approvals:z.array(approvalSchema),canApproveIntegration:z.boolean(),
 remoteOperations:z.array(z.object({id:z.string().uuid(),intent_id:z.string().uuid().nullable(),task_id:z.string(),state:z.string(),host_label:z.string()})),
 operatorDeviceIds:z.array(z.string().uuid()),
 capacity:capacityEditorSchema.nullable(),canConfigureCapacity:z.boolean(),
 providerBindings:z.array(agentControlProviderBindingSchema),providerAdapters:z.array(agentControlProviderAdapterSchema),
 accounts:z.array(z.object({id:z.string(),label:z.string(),provider:z.string(),mode:z.string(),quota_status:z.string(),eligibility:z.string(),enabled:z.boolean(),revision:z.number().int().positive(),can_manage:z.boolean()})),
 profiles:z.array(z.object({id:z.string(),account_id:z.string(),model:z.string(),effort:z.string(),role:z.string(),enabled:z.boolean(),revision:z.number().int().positive(),can_manage:z.boolean()})),
 catalog:z.array(catalogEntrySchema),
 policies:z.array(z.object({revision:z.number(),snapshot:policyEditorSchema.optional()})),
 qualityPolicies:z.array(z.object({revision:z.number()})),
 templates:z.array(z.object({revision:z.number(),snapshot:z.object({workflow:z.string(),qualityRevision:z.number().optional(),targetRef:z.string().optional()})})),
 activeTemplateRevision:z.number().nullable(),
 plans:z.array(z.object({id:z.string().uuid(),run_id:z.string().uuid(),plan_revision:z.number(),state:z.string(),cancellation_state:z.enum(['requested','confirmed']).nullable()})),
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
 const [selected,setSelected]=useState(''),[label,setLabel]=useState(''),[sessionId,setSessionId]=useState('')
 const [requiredReviews,setRequiredReviews]=useState(1),[requireHuman,setRequireHuman]=useState(false),[requireJudge,setRequireJudge]=useState(false)
 const [templateWorkflow,setTemplateWorkflow]=useState('baseline-synthetic-v1'),[qualityRevision,setQualityRevision]=useState(''),[targetRef,setTargetRef]=useState('refs/heads/protected')
 const [bootstrapToken,setBootstrapToken]=useState(''),[newDevice,setNewDevice]=useState(''),[newPublicKey,setNewPublicKey]=useState('')
 const contexts=useQuery({queryKey:['ac-contexts'],refetchInterval:5000,queryFn:async()=>contextsSchema.parse(await request('/api/v1/ac/contexts'))})
 const contextId=selected||contexts.data?.contexts[0]?.id||''
 const resources=useQuery({queryKey:['ac-resources',contextId],enabled:!!contextId,refetchInterval:5000,
  queryFn:async()=>resourcesSchema.parse(await request(`/api/v1/ac/contexts/${contextId}/resources`))})
 const operator=useQuery({queryKey:['ac-operator-identity'],queryFn:async()=>z.object({principalId:z.string(),projectId:z.string().uuid(),
  installationId:z.string().uuid(),operatorDeviceIds:z.array(z.string().uuid())}).parse(await request('/api/v1/ac/operator/identity'))})
 const identity=useQuery({queryKey:['ac-operator-device',operator.data?.principalId],enabled:!!operator.data,
  queryFn:()=>operatorIdentity(operator.data!.principalId,operator.data!.operatorDeviceIds)})
 const linkContext=useMutation({mutationFn:async()=>{
  if(!operator.data)throw Error('PROJECT_NOT_READY')
  return z.object({contextId:z.string().uuid()}).parse(await request('/api/v1/ac/contexts',{projectId:operator.data.projectId,happierSessionId:sessionId}))
 },onSuccess:value=>{setSelected(value.contextId);setSessionId('');void cache.invalidateQueries({queryKey:['ac-contexts']})}})
 const usage=useQuery({queryKey:['ac-usage',contextId],enabled:!!contextId,refetchInterval:5000,
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
  onError:error=>{
   if(['ACCOUNT_PROFILE_REVISION_CONFLICT','CAPACITY_CONFIG_CONFLICT','PROVIDER_BINDING_CONFLICT','PROVIDER_PROBE_IN_PROGRESS','PROVIDER_PROBE_UNCERTAIN','POLICY_CONFLICT','PLAN_ALREADY_TERMINAL','PLAN_REVISION_MISMATCH'].includes(error.message))void cache.invalidateQueries({queryKey:['ac-resources',contextId]})
   if(['PAUSE_REVISION_CONFLICT','DRAIN_REVISION_CONFLICT'].includes(error.message))void cache.invalidateQueries({queryKey:['ac-contexts']})
  }})
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
   <form className="flex flex-col gap-2" onSubmit={event=>{event.preventDefault();linkContext.mutate()}}>
    <label className="flex flex-col gap-1">Vincular conversa existente do Happier
     <Input aria-label="Identificador da sessão Happier" value={sessionId} onChange={event=>setSessionId(event.target.value)} maxLength={200} required/>
    </label>
    <Button type="submit" disabled={!operator.data||!sessionId||linkContext.isPending}>Vincular conversa</Button>
    <p className="text-xs text-muted-foreground">O acesso é verificado no Happier. Vincular não inicia gerente ou trabalhadores.</p>
    {linkContext.error&&<p role="alert">{linkContext.error.message}</p>}
   </form>
   <label className="flex flex-col gap-1">Conversa
    <select aria-label="Conversa" className={selectStyle} value={contextId} onChange={e=>setSelected(e.target.value)}>
     {contexts.data?.contexts.map(c=><option key={c.id} value={c.id}>{c.id}{c.paused?' — pausada':''}</option>)}
    </select>
   </label>
   {selectedContext&&<div className="flex flex-wrap items-center gap-2">
    <span>{selectedContext.paused?'Pausada':'Ativa'}</span>
    <Button disabled={busy} onClick={()=>mutate.mutate({action:'context.pause',payload:{paused:!selectedContext.paused,expectedRevision:selectedContext.pause_revision}})}>
     {selectedContext.paused?'Retomar etapas':'Pausar novas etapas'}
    </Button>
    <Button disabled={busy} onClick={()=>mutate.mutate({action:'context.drain',payload:{draining:!selectedContext.draining,expectedRevision:selectedContext.drain_revision}})}>
     {selectedContext.draining?'Permitir novos planos':'Concluir planos aceitos e aguardar'}
    </Button>
    <p className="w-full text-xs text-muted-foreground">{selectedContext.draining?'Drenagem ativa: os planos já aceitos podem concluir; novos planos são recusados.':'Novos planos permitidos, sujeitos à pausa, às políticas e à capacidade.'} A pausa impede novas etapas; não confirma cancelamento de processos.</p>
   </div>}
  </SettingsField>
  <Button variant="outline" disabled={busy} onClick={()=>{void request('/api/v1/ac/auth/logout',{}).then(()=>window.location.reload())}}>Sair deste navegador</Button>
  {(contexts.error||resources.error||usage.error)&&<p role="alert">{(contexts.error||resources.error||usage.error)?.message}</p>}
  {mutate.error&&<p role="alert">{mutate.error.message}</p>}
  {mutate.isSuccess&&<p role="status">Alteração aplicada e persistida.</p>}
  {data&&<SettingsField title="Planos desta conversa" hint="Cancelar bloqueia novas etapas. A confirmação de parada depende da reconciliação física e preserva os artefatos existentes.">
   {data.plans.length===0&&<p>Nenhum plano aceito nesta conversa.</p>}
   {data.plans.map(plan=><div key={plan.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
    <span className="break-all text-sm">Plano {plan.plan_revision} — {plan.cancellation_state==='requested'?'cancelamento solicitado; aguardando confirmação':plan.cancellation_state==='confirmed'?'cancelamento confirmado':plan.state}</span>
    {!plan.cancellation_state&&!['done','review','failed','canceled','cancelled'].includes(plan.state)&&<Button disabled={busy}
     onClick={()=>mutate.mutate({action:'plan.cancel',payload:{intentId:plan.id,planRevision:plan.plan_revision}})}>Cancelar este plano e solicitar parada</Button>}
   </div>)}
  </SettingsField>}
  {data&&<AgentControlManagerPlans key={contextId} contextId={contextId}/>}
  {data&&<AgentControlProviderCollectors key={`providers-${contextId}`} accounts={data.accounts} bindings={data.providerBindings} adapters={data.providerAdapters}
   canConfigure={data.canConfigureCapacity} busy={busy} onBind={payload=>mutate.mutate({action:'provider.bind',payload})}/>}
  {data&&<AgentControlObservability enabled={data.canConfigureCapacity}/>}
  {data&&data.approvals.length>0&&<SettingsField title="Integrações com aprovação humana" hint="A aprovação vale somente para o commit, árvore, base e política exibidos. QA e revisão continuam obrigatórios.">
   {data.approvals.map(artifact=><AgentControlIntegrationApproval key={artifact.id} contextId={contextId} artifact={artifact}
    canApprove={data.canApproveIntegration} busy={busy} onApprove={payload=>mutate.mutate({action:'integration.approve',payload})}/>)}
  </SettingsField>}
  {data&&data.remoteOperations.length>0&&<SettingsField title="Operações remotas" hint="Resultado incerto não confirma conclusão nem parada. Cancelamento atua pelo plano correspondente.">
   {data.remoteOperations.map(operation=><div key={operation.id} className="rounded-md border p-2 text-sm">
    <p>{operation.host_label} · {operation.task_id} · {operation.state}</p>
    {!operation.intent_id&&<p role="status">Operação antiga sem vínculo com plano; exige reconciliação conservadora.</p>}
   </div>)}
  </SettingsField>}
  {operator.error&&<p role="alert">{operator.error.message}</p>}
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
    <AgentControlProfileEditor key={contextId} accounts={data.accounts} catalog={data.catalog} busy={busy}
     onAdd={payload=>mutate.mutate({action:'profile.add',payload})}/>
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
