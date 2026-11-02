import {useState} from 'react'
import {z} from 'zod'
import {Button} from '@/components/ui/button'
const roleSchema=z.enum(['manager','programmer','reviewer','qa','specialist','judge'])
const effortSchema=z.enum(['low','medium','high'])
export const catalogEntrySchema=z.object({provider:z.string(),model:z.string(),efforts:z.array(effortSchema),roles:z.array(roleSchema),source:z.string()})
type Props={accounts:{id:string;label:string;provider:string;can_manage:boolean}[];catalog:z.infer<typeof catalogEntrySchema>[];busy:boolean;
 onAdd:(payload:{id:string;accountId:string;model:string;effort:z.infer<typeof effortSchema>;role:z.infer<typeof roleSchema>})=>void}
const labels={manager:'Gerente',programmer:'Programação',reviewer:'Revisão',qa:'QA',specialist:'Especialista',judge:'Julgador'}
export function AgentControlProfileEditor({accounts,catalog,busy,onAdd}:Props){
 const [account,setAccount]=useState(''),[role,setRole]=useState<z.infer<typeof roleSchema>>('programmer')
 const [model,setModel]=useState(''),[effort,setEffort]=useState<z.infer<typeof effortSchema>>('medium')
 const chosen=accounts.find(a=>a.id===account&&a.can_manage)
 const models=catalog.filter(entry=>entry.provider===chosen?.provider&&entry.roles.includes(role))
 const entry=models.find(entry=>entry.model===model),valid=!!chosen&&!!entry&&entry.efforts.includes(effort)
 const style='h-9 min-w-0 max-w-full rounded-md border bg-card px-2 text-sm'
 return <form className="flex min-w-0 flex-col gap-2" onSubmit={event=>{
  event.preventDefault();if(!valid)return
  onAdd({id:crypto.randomUUID(),accountId:account,model,effort,role})
 }}>
  <label className="flex flex-col gap-1">Conta do perfil<select aria-label="Conta do perfil" className={style} required value={account}
   onChange={event=>{setAccount(event.target.value);setModel('')}} disabled={busy}>
   <option value="">Selecione a conta</option>{accounts.filter(a=>a.can_manage).map(a=><option key={a.id} value={a.id}>{a.label}</option>)}
  </select></label>
  <label className="flex flex-col gap-1">Função do perfil<select aria-label="Função do perfil" className={style} value={role}
   onChange={event=>{setRole(roleSchema.parse(event.target.value));setModel('')}} disabled={busy}>
   {roleSchema.options.map(value=><option key={value} value={value}>{labels[value]}</option>)}
  </select></label>
  <label className="flex flex-col gap-1">Modelo validado<select aria-label="Modelo validado" className={style} required value={entry?model:''}
   onChange={event=>{const selected=models.find(m=>m.model===event.target.value);setModel(event.target.value);
    if(selected&&!selected.efforts.includes(effort))setEffort(selected.efforts[0]??'medium')}} disabled={busy||!chosen}>
   <option value="">Selecione um modelo do catálogo</option>{models.map(value=><option key={value.model} value={value.model}>{value.model}</option>)}
  </select></label>
  {chosen&&!models.length&&<p role="status">Nenhum modelo foi homologado no catálogo para esta conta e função.</p>}
  <label className="flex flex-col gap-1">Esforço do perfil<select aria-label="Esforço do perfil" className={style} required
   value={entry?.efforts.includes(effort)?effort:''} onChange={event=>setEffort(effortSchema.parse(event.target.value))} disabled={busy||!entry}>
   <option value="">Selecione o esforço</option>{entry?.efforts.map(value=><option key={value} value={value}>{value}</option>)}
  </select></label>
  {entry&&<p className="break-words text-xs text-muted-foreground">Fonte do catálogo: {entry.source}</p>}
  <Button disabled={busy||!valid} type="submit">Cadastrar perfil</Button>
 </form>
}
