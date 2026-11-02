import {useState} from 'react'
import {z} from 'zod'
import {Button} from '@/components/ui/button'
import {SettingsField} from './settings-field'

const hash=z.string().regex(/^[a-f0-9]{64}$/)
const entrySchema=z.object({id:z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/),version:z.number().int().positive(),executorDigest:hash,receiptKeyFingerprint:hash,managerProfileIds:z.array(z.string().min(1).max(100)).min(1).max(50)}).strict()
export const administrativeViewSchema=z.object({policies:z.array(z.object({revision:z.number().int().positive(),digest:hash,snapshot:z.object({operations:z.array(entrySchema).max(100)}).strict(),published_at:z.string()})),
 operations:z.array(z.object({id:z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/),version:z.number().int().positive(),executorDigest:hash,receiptKeyFingerprint:hash}).strict()).max(100),
 managerProfileIds:z.array(z.string().min(1).max(100)),recentOperations:z.array(z.object({id:z.string().uuid(),name:z.string(),version:z.number().int().positive(),
  state:z.enum(['registered','running','uncertain','completed']),epoch:z.union([z.number(),z.string()]),created_at:z.string()}).strict()).max(50)}).strict()
type Entry=z.infer<typeof entrySchema>
type View=z.infer<typeof administrativeViewSchema>
export type AdministrativePolicyPayload={expectedRevision:number;policy:{operations:Entry[]}}
type Props={view:View;canEdit:boolean;busy:boolean;onPublish:(payload:AdministrativePolicyPayload)=>void}
const key=(item:{id:string;version:number})=>`${item.id}:${item.version}`
const same=(left:{id:string;version:number;executorDigest:string;receiptKeyFingerprint:string},right:typeof left)=>key(left)===key(right)&&left.executorDigest===right.executorDigest&&left.receiptKeyFingerprint===right.receiptKeyFingerprint
export function AgentControlAdministrativePolicy({view,canEdit,busy,onPublish}:Props){
 const latest=view.policies.reduce<View['policies'][number]|undefined>((current,item)=>!current||item.revision>current.revision?item:current,undefined)
 const [baseRevision,setBaseRevision]=useState(latest?.revision??0)
 const [draft,setDraft]=useState<Entry[]>(()=>latest?.snapshot.operations.map(item=>({...item,managerProfileIds:[...item.managerProfileIds]}))??[])
 const [recentPage,setRecentPage]=useState(0)
 const managers=view.managerProfileIds
 const unavailable=draft.filter(item=>!view.operations.some(operation=>same(item,operation)))
 const valid=draft.length<=100&&unavailable.length===0&&draft.every(item=>item.managerProfileIds.length>0&&item.managerProfileIds.length<=50&&item.managerProfileIds.every(id=>managers.includes(id)))
 const changed=(latest?.revision??0)!==baseRevision
 const lastRecentPage=Math.max(0,Math.ceil(view.recentOperations.length/10)-1),currentRecentPage=Math.min(recentPage,lastRecentPage)
 const toggleOperation=(operation:View['operations'][number])=>setDraft(current=>current.some(item=>same(item,operation))
  ?current.filter(item=>!same(item,operation)):[...current,{...operation,managerProfileIds:[]}])
 const toggleProfile=(operation:View['operations'][number],profileId:string)=>setDraft(current=>current.map(item=>same(item,operation)
  ?{...item,managerProfileIds:item.managerProfileIds.includes(profileId)?item.managerProfileIds.filter(id=>id!==profileId):[...item.managerProfileIds,profileId]}:item))
 const reload=()=>{setBaseRevision(latest?.revision??0);setDraft(latest?.snapshot.operations.map(item=>({...item,managerProfileIds:[...item.managerProfileIds]}))??[])}
 return <SettingsField title="Política de operações administrativas" hint="A política autoriza apenas operações registradas e os perfis de gerente selecionados para esta conversa.">
  <p className="text-sm">A publicação altera a política; ela não executa uma operação nem aceita comandos de shell. Uma política vazia revoga as autorizações.</p>
  <p className="text-xs text-muted-foreground">Revisão carregada: {baseRevision||'nenhuma'}; revisão mais recente: {latest?.revision??'nenhuma'}.</p>
  {latest&&<details><summary>Política registrada · revisão {latest.revision}</summary><p className="break-all text-xs">Digest: {latest.digest}</p><p>Operações autorizadas: {latest.snapshot.operations.length}</p></details>}
  <div className="flex min-w-0 flex-col gap-2"><p className="text-sm font-medium">Operações administrativas recentes</p>
   {view.recentOperations.length===0?<p className="text-sm">Nenhuma operação registrada nesta conversa.</p>:<>
    <p className="text-xs text-muted-foreground">São exibidas até as 50 operações mais recentes. Resultado incerto não confirma conclusão.</p>
    <ul className="flex min-w-0 flex-col gap-2">{view.recentOperations.slice(currentRecentPage*10,(currentRecentPage+1)*10).map(item=><li key={item.id} className="min-w-0 break-words rounded-md border p-3 text-sm">
     <p>{item.name} · versão {item.version} · {item.state}</p><p>Época {item.epoch} · {new Date(item.created_at).toLocaleString()}</p><p className="break-all text-xs">{item.id}</p>
    </li>)}</ul>
    {lastRecentPage>0&&<div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" disabled={currentRecentPage===0} onClick={()=>setRecentPage(currentRecentPage-1)}>Anteriores</Button><span>Página {currentRecentPage+1} de {lastRecentPage+1}</span><Button type="button" variant="outline" disabled={currentRecentPage===lastRecentPage} onClick={()=>setRecentPage(currentRecentPage+1)}>Próximas</Button></div>}
   </>}
  </div>
  {view.operations.length===0&&<p role="status">Nenhuma operação administrativa está registrada neste servidor. O bootstrap atual não disponibiliza helpers reais.</p>}
  {changed&&<p role="alert">A política mudou no servidor. Recarregue a revisão antes de publicar.</p>}
  {canEdit&&<>
   <Button type="button" variant="outline" disabled={busy} onClick={reload}>Recarregar política administrativa</Button>
   {unavailable.length>0&&<div className="rounded-md border p-3 text-sm"><p>Operações da revisão carregada não estão mais registradas com a mesma identidade. Remova-as explicitamente para publicar.</p>
    {unavailable.map(item=><div key={key(item)} className="flex flex-wrap items-center gap-2"><span>{item.id} · versão {item.version}</span><Button type="button" variant="outline" disabled={busy} onClick={()=>setDraft(current=>current.filter(entry=>key(entry)!==key(item)))}>Remover operação indisponível</Button></div>)}
   </div>}
   {view.operations.map(operation=>{
    const selected=draft.find(item=>same(item,operation))
    return <div key={key(operation)} className="min-w-0 rounded-md border p-3 text-sm">
     <label className="flex items-center gap-2"><input type="checkbox" checked={!!selected} disabled={busy||!!draft.find(item=>key(item)===key(operation)&&!same(item,operation))} onChange={()=>toggleOperation(operation)}/>{operation.id} · versão {operation.version}</label>
     <details><summary>Identidade da operação</summary><p className="break-all">Executor: {operation.executorDigest}</p><p className="break-all">Chave de recibo: {operation.receiptKeyFingerprint}</p></details>
     {selected&&<fieldset className="flex min-w-0 flex-col gap-1"><legend>Perfis de gerente autorizados</legend>
      {managers.length===0&&<p>Nenhum perfil de gerente conhecido nesta conversa. É necessário cadastrar um gerente pelo bootstrap; somente uma política vazia pode ser publicada agora.</p>}
      {managers.map(id=><label key={id} className="flex items-start gap-2"><input type="checkbox" checked={selected.managerProfileIds.includes(id)} disabled={busy} onChange={()=>toggleProfile(operation,id)}/><span className="break-all">{id}</span></label>)}
      {selected.managerProfileIds.filter(id=>!managers.includes(id)).map(id=><div key={id} className="flex flex-wrap items-center gap-2"><span className="break-all">Perfil indisponível: {id}</span><Button type="button" variant="outline" disabled={busy} onClick={()=>toggleProfile(operation,id)}>Remover perfil indisponível</Button></div>)}
     </fieldset>}
    </div>
   })}
   {draft.length>0&&<Button type="button" variant="outline" disabled={busy} onClick={()=>setDraft([])}>Limpar operações da política</Button>}
   <Button type="button" disabled={busy||changed||!valid} onClick={()=>onPublish({expectedRevision:baseRevision,policy:{operations:draft}})}>Publicar política administrativa</Button>
   {!valid&&<p role="status">Cada operação deve estar registrada e ter ao menos um perfil de gerente disponível.</p>}
  </>}
  {!canEdit&&<p>Somente o titular do projeto pode publicar esta política.</p>}
 </SettingsField>
}
