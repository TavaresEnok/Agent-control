import {useState} from 'react'
import {Button} from '@/components/ui/button'
import {Input} from '@/components/ui/input'
import {SettingsField} from './settings-field'

type Plan={id:string;plan_revision:number;state:string;cancellation_state:'requested'|'confirmed'|null}
type Host={id:string;label:string}
type Authorization={authorizationId:string;intentId:string;hostId:string;commit:string;tree:string;kind:'source_read_authorization'}
export type RemoteSourcePayload={schemaVersion:1;intentId:string;hostId:string;commit:string;tree:string}
const gitId=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const terminal=new Set(['done','review','failed','canceled','cancelled','cancellation_requested'])
const pageSize=10
export function AgentControlRemoteSources({canAuthorize,hosts,plans,authorizations,busy,onAuthorize}:{canAuthorize:boolean;hosts:Host[];plans:Plan[];authorizations:Authorization[];busy:boolean;onAuthorize:(payload:RemoteSourcePayload)=>void}){
 const [intentId,setIntentId]=useState(''),[hostId,setHostId]=useState(''),[commit,setCommit]=useState(''),[tree,setTree]=useState(''),[page,setPage]=useState(0)
 const eligible=plans.filter(plan=>!plan.cancellation_state&&!terminal.has(plan.state))
 const valid=eligible.some(plan=>plan.id===intentId)&&hosts.some(host=>host.id===hostId)&&gitId.test(commit)&&gitId.test(tree)&&commit.length===tree.length
 const lastPage=Math.max(0,Math.ceil(authorizations.length/pageSize)-1),currentPage=Math.min(page,lastPage)
 return <SettingsField title="Fontes Git remotas" hint="A autorização permite apenas ler o commit e a árvore identificados no host e plano selecionados.">
  <p className="text-sm">Autorizar leitura não inicia execução nem aprova integração.</p>
  {canAuthorize&&<>
   {eligible.length===0&&<p role="status">Nenhum plano elegível nesta conversa.</p>}
   {hosts.length===0&&<p role="status">Nenhum host autorizado para exportar Git neste projeto.</p>}
   <form className="flex min-w-0 flex-col gap-2" onSubmit={event=>{event.preventDefault();if(valid&&!busy)onAuthorize({schemaVersion:1,intentId,hostId,commit,tree})}}>
    <label className="flex flex-col gap-1">Plano<select aria-label="Plano para leitura remota" className="h-9 min-w-0 max-w-full rounded-md border border-input bg-card px-2 text-sm" value={intentId} onChange={event=>setIntentId(event.target.value)} required>
     <option value="">Selecione um plano</option>{eligible.map(plan=><option key={plan.id} value={plan.id}>Plano {plan.plan_revision} · {plan.state} · {plan.id}</option>)}
    </select></label>
    <label className="flex flex-col gap-1">Host<select aria-label="Host para leitura remota" className="h-9 min-w-0 max-w-full rounded-md border border-input bg-card px-2 text-sm" value={hostId} onChange={event=>setHostId(event.target.value)} required>
     <option value="">Selecione um host</option>{hosts.map(host=><option key={host.id} value={host.id}>{host.label}</option>)}
    </select></label>
    <label className="flex flex-col gap-1">Commit<Input value={commit} onChange={event=>setCommit(event.target.value)} pattern="([a-f0-9]{40}|[a-f0-9]{64})" maxLength={64} required/></label>
    <label className="flex flex-col gap-1">Árvore<Input value={tree} onChange={event=>setTree(event.target.value)} pattern="([a-f0-9]{40}|[a-f0-9]{64})" maxLength={64} required/></label>
    <p className="text-xs text-muted-foreground">Informe hashes Git hexadecimais minúsculos com 40 ou 64 caracteres; ambos devem ter o mesmo tamanho.</p>
    <Button type="submit" disabled={busy||!valid}>Autorizar leitura desta fonte</Button>
   </form>
  </>}
  {authorizations.length>0&&<div className="flex min-w-0 flex-col gap-2">
   <p className="text-sm">Autorizações de leitura registradas; o uso continua sujeito ao estado atual do plano e do host.</p>
   <ul className="flex min-w-0 flex-col gap-2">{authorizations.slice(currentPage*pageSize,(currentPage+1)*pageSize).map(item=><li key={item.authorizationId} className="min-w-0 break-all rounded-md border p-3 text-sm">
    <p>Plano: {item.intentId}</p><p>Host: {hosts.find(host=>host.id===item.hostId)?.label??item.hostId}</p><p>Commit: {item.commit}</p><p>Árvore: {item.tree}</p>
   </li>)}</ul>
   {lastPage>0&&<div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>Anteriores</Button><span>Página {currentPage+1} de {lastPage+1}</span><Button type="button" variant="outline" disabled={currentPage===lastPage} onClick={()=>setPage(currentPage+1)}>Próximos</Button></div>}
  </div>}
 </SettingsField>
}
