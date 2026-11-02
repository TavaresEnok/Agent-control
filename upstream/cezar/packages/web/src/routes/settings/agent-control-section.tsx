import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsField } from './settings-field'

const contextsSchema=z.object({contexts:z.array(z.object({id:z.string().uuid(),paused:z.boolean()}))})
const resourcesSchema=z.object({contextId:z.string(),assignedPolicyRevision:z.number().nullable(),
 accounts:z.array(z.object({id:z.string(),label:z.string(),provider:z.string(),quota_status:z.string(),eligibility:z.string()})),
 profiles:z.array(z.object({id:z.string(),account_id:z.string(),model:z.string(),effort:z.string(),role:z.string()})),
 policies:z.array(z.object({revision:z.number()})),
 grants:z.array(z.object({id:z.string(),role:z.string(),state:z.string(),profile_id:z.string(),emergency:z.boolean()}))})
async function request(path:string,body?:unknown):Promise<unknown>{
 const response=await fetch(path,{method:body?'POST':'GET',credentials:'include',headers:body?{'content-type':'application/json'}:undefined,
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
 const [programmer,setProgrammer]=useState(''),[reviewer,setReviewer]=useState('')
 const contexts=useQuery({queryKey:['ac-contexts'],queryFn:async()=>contextsSchema.parse(await request('/api/v1/ac/contexts'))})
 const contextId=selected||contexts.data?.contexts[0]?.id||''
 const resources=useQuery({queryKey:['ac-resources',contextId],enabled:!!contextId,
  queryFn:async()=>resourcesSchema.parse(await request(`/api/v1/ac/contexts/${contextId}/resources`))})
 const mutate=useMutation({mutationFn:async(command:{action:string;payload:unknown})=>{
   const storageKey=`ac-control-pending:${contextId}`
   const semantic=JSON.stringify(command)
   const stored=z.object({semantic:z.string(),intentId:z.string().uuid()}).safeParse(JSON.parse(sessionStorage.getItem(storageKey)||'null'))
   const intentId=stored.success&&stored.data.semantic===semantic?stored.data.intentId:crypto.randomUUID()
   sessionStorage.setItem(storageKey,JSON.stringify({semantic,intentId}))
   const result=z.object({intentId:z.string(),state:z.literal('applied')}).passthrough().parse(await request('/api/v1/ac/control',
    {schemaVersion:1,intentId,deliveryAttemptId:crypto.randomUUID(),contextId,...command}))
   sessionStorage.removeItem(storageKey)
   return result
  },onSuccess:()=>{void cache.invalidateQueries({queryKey:['ac-resources',contextId]})}})
 const data=resources.data
 const busy=mutate.isPending
 const selectStyle='h-9 min-w-0 max-w-full rounded-md border border-input bg-card px-2 text-sm'
 return <div className="flex min-w-0 flex-col gap-6">
  <SettingsField title="Agent Control" hint="Contas de laboratório, políticas publicadas e capacidade confirmada.">
   <label className="flex flex-col gap-1">Conversa
    <select aria-label="Conversa" className={selectStyle} value={contextId} onChange={e=>setSelected(e.target.value)}>
     {contexts.data?.contexts.map(c=><option key={c.id} value={c.id}>{c.id}{c.paused?' — pausada':''}</option>)}
    </select>
   </label>
  </SettingsField>
  {(contexts.error||resources.error)&&<p role="alert">{(contexts.error||resources.error)?.message}</p>}
  {mutate.error&&<p role="alert">{mutate.error.message}</p>}
  {mutate.isSuccess&&<p role="status">Alteração aplicada e persistida.</p>}
  {data&&<>
   <SettingsField title="Contas" hint="Cota sem observação válida aparece como unknown. Nenhuma assinatura real é utilizada.">
    <ul className="flex flex-col gap-2">{data.accounts.map(a=><li key={a.id} className="break-words rounded-md border p-3">
     <strong>{a.label}</strong> · {a.provider}<br/>{a.quota_status} · {a.eligibility}
    </li>)}</ul>
    <form className="flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();const id=crypto.randomUUID();mutate.mutate({action:'account.add',payload:{
     id,provider:'synthetic',label,resourceIdentity:`synthetic-${id}`,mode:'synthetic',eligibility:'not_assessed',
     eligibilitySource:'synthetic://manual-registration',maxConcurrent:1}})}}>
     <Input aria-label="Nome da conta simulada" value={label} onChange={e=>setLabel(e.target.value)} required maxLength={100}/>
     <Button disabled={busy||!label} type="submit">Adicionar conta simulada</Button>
    </form>
   </SettingsField>
   <SettingsField title="Perfis" hint="Modelo, esforço e função pertencem a um perfil de uma conta específica.">
    <ul>{data.profiles.map(p=><li key={p.id} className="break-words">{p.model} · {p.effort} · {p.role}</li>)}</ul>
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
   <SettingsField title="Política" hint={`Revisão atribuída: ${data.assignedPolicyRevision??'nenhuma'}. Publicar não altera tentativas em andamento.`}>
    <form className="flex flex-col gap-2" onSubmit={e=>{
     e.preventDefault()
     const policy={schemaVersion:1,maxProgrammersPerContext:10,maxEvaluatorsPerContext:2,
      roles:{programmer:{regular:[programmer],emergency:[]},...(reviewer?{reviewer:{regular:[reviewer],emergency:[]}}:{})}}
     mutate.mutate({action:'policy.publish',payload:{expectedRevision:data.policies.at(-1)?.revision??0,policy}})
    }}>
     <select aria-label="Programador regular" className={selectStyle} required value={programmer} onChange={e=>setProgrammer(e.target.value)}>
      <option value="">Selecione o programador</option>{data.profiles.filter(p=>p.role==='programmer').map(p=><option key={p.id} value={p.id}>{p.model} · {p.effort}</option>)}
     </select>
     <select aria-label="Revisor regular" className={selectStyle} value={reviewer} onChange={e=>setReviewer(e.target.value)}>
      <option value="">Sem revisor configurado</option>{data.profiles.filter(p=>p.role==='reviewer').map(p=><option key={p.id} value={p.id}>{p.model} · {p.effort}</option>)}
     </select>
     <Button disabled={busy||!programmer} type="submit">Publicar nova revisão</Button>
    </form>
    <div className="flex flex-wrap gap-2">{data.policies.map(p=><Button key={p.revision} disabled={busy||data.assignedPolicyRevision===p.revision}
     onClick={()=>mutate.mutate({action:'policy.assign',payload:{revision:p.revision}})}>Usar revisão {p.revision}</Button>)}</div>
   </SettingsField>
   <SettingsField title="Concessões" hint="Processos incertos continuam consumindo capacidade até reconciliação.">
    <ul className="flex flex-col gap-2">{data.grants.map(g=><li key={g.id} className="break-words rounded-md border p-3">
     {g.role} · {g.state}{g.emergency?' · reserva emergencial':''}<br/><span className="text-xs">{g.id}</span>
    </li>)}</ul>
   </SettingsField>
  </>}
 </div>
}
