import {useState} from 'react'
import {z} from 'zod'
import {Button} from '@/components/ui/button'
import {Input} from '@/components/ui/input'

const roleSchema=z.enum(['manager','programmer','reviewer','qa','specialist','judge'])
type Role=z.infer<typeof roleSchema>
const chainSchema=z.object({regular:z.array(z.string().uuid()).min(1).max(20),emergency:z.array(z.string().uuid()).max(20)})
export const policyEditorSchema=z.object({schemaVersion:z.literal(1),maxProgrammersPerContext:z.number().int().min(1).max(10),
 maxEvaluatorsPerContext:z.number().int().min(1).max(10),roles:z.object({manager:chainSchema.optional(),programmer:chainSchema.optional(),
 reviewer:chainSchema.optional(),qa:chainSchema.optional(),specialist:chainSchema.optional(),judge:chainSchema.optional()})})
type Policy=z.infer<typeof policyEditorSchema>
type Draft=Record<Role,{regular:string[];emergency:string[]}>
const labels:Record<Role,string>={manager:'Gerente',programmer:'Programação',reviewer:'Revisão',qa:'QA',specialist:'Especialista',judge:'Julgador'}
const empty=():Draft=>({manager:{regular:[],emergency:[]},programmer:{regular:[],emergency:[]},reviewer:{regular:[],emergency:[]},
 qa:{regular:[],emergency:[]},specialist:{regular:[],emergency:[]},judge:{regular:[],emergency:[]}})
type Props={profiles:{id:string;account_id:string;model:string;effort:string;role:string}[];accounts:{id:string;label:string}[];
 policies:{revision:number;snapshot?:unknown}[];busy:boolean;onPublish:(payload:{expectedRevision:number;policy:Policy})=>void}

/** Edits the existing capacity contract; publication and assignment remain distinct. */
export function AgentControlPolicyEditor({profiles,accounts,policies,busy,onPublish}:Props){
 const [roles,setRoles]=useState<Draft>(empty),[programmers,setProgrammers]=useState(10),[evaluators,setEvaluators]=useState(2)
 const [loaded,setLoaded]=useState(''),[rollback,setRollback]=useState<string|null>(null),[error,setError]=useState('')
 const [baseRevision,setBaseRevision]=useState(policies.at(-1)?.revision??0)
 const describe=(id:string)=>{const profile=profiles.find(p=>p.id===id);return profile
  ?`${accounts.find(a=>a.id===profile.account_id)?.label??'Conta'} · ${profile.model} · ${profile.effort}`:id}
 const add=(role:Role,kind:'regular'|'emergency',id:string)=>{
  if(!id)return
  setRollback(null)
  setRoles(current=>{
   if([...current[role].regular,...current[role].emergency].includes(id))return current
   return {...current,[role]:{...current[role],[kind]:[...current[role][kind],id]}}
  })
 }
 const edit=(role:Role,kind:'regular'|'emergency',index:number,action:'remove'|'up'|'down')=>{setRollback(null);setRoles(current=>{
  const list=[...current[role][kind]]
  if(action==='remove')list.splice(index,1)
  else{const target=index+(action==='up'?-1:1);if(target<0||target>=list.length)return current;[list[index],list[target]]=[list[target]!,list[index]!]}
  return {...current,[role]:{...current[role],[kind]:list}}
 })}
 const load=(restore=false)=>{
  const parsed=policyEditorSchema.safeParse(policies.find(p=>String(p.revision)===loaded)?.snapshot)
  if(!parsed.success){setError('Não foi possível carregar essa revisão.');return}
  const next=empty();for(const role of roleSchema.options){const chain=parsed.data.roles[role];if(chain)next[role]={regular:[...chain.regular],emergency:[...chain.emergency]}}
  setRollback(restore?loaded:null);setRoles(next);setProgrammers(parsed.data.maxProgrammersPerContext);setEvaluators(parsed.data.maxEvaluatorsPerContext);setBaseRevision(policies.at(-1)?.revision??0);setError('')
 }
 return <form className="flex min-w-0 flex-col gap-4" onSubmit={event=>{
  event.preventDefault();setError('')
  if(!roles.programmer.regular.length){setError('Selecione ao menos um programador regular.');return}
  const selected=Object.fromEntries(roleSchema.options.filter(role=>roles[role].regular.length||roles[role].emergency.length).map(role=>[role,roles[role]]))
  const parsed=policyEditorSchema.safeParse({schemaVersion:1,maxProgrammersPerContext:programmers,maxEvaluatorsPerContext:evaluators,roles:selected})
  if(!parsed.success){setError('Cada função configurada precisa de um perfil regular e limites válidos.');return}
  for(const role of roleSchema.options)for(const id of [...roles[role].regular,...roles[role].emergency]){
   if(!profiles.some(p=>p.id===id&&p.role===role)){setError('Uma função contém perfil ausente ou incompatível. Recarregue a revisão e confira os perfis.');return}
  }
  onPublish({expectedRevision:baseRevision,policy:parsed.data})
 }}>
  <div className="flex flex-wrap items-end gap-2">
   <label className="flex min-w-0 flex-col gap-1">Revisão para editar
    <select aria-label="Revisão para editar" className="h-9 rounded-md border bg-card px-2" value={loaded} onChange={e=>setLoaded(e.target.value)}>
     <option value="">Nova política</option>{policies.map(p=><option key={p.revision} value={p.revision}>Revisão {p.revision}</option>)}
    </select>
   </label>
   <Button type="button" disabled={busy||!loaded} onClick={()=>load()}>Carregar revisão</Button>
   <Button type="button" variant="outline" disabled={busy||!loaded} onClick={()=>load(true)}>Preparar reversão desta revisão</Button>
  </div>
  {rollback&&<p role="status">Reversão preparada da revisão {rollback}. Publique para criar uma nova revisão com este conteúdo; tentativas existentes preservam sua política original.</p>}
  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
   <label>Programadores por conversa<Input aria-label="Programadores por conversa" type="number" min={1} max={10} value={programmers} onChange={e=>{setRollback(null);setProgrammers(Number(e.target.value))}}/></label>
   <label>Avaliações por conversa<Input aria-label="Avaliações por conversa" type="number" min={1} max={10} value={evaluators} onChange={e=>{setRollback(null);setEvaluators(Number(e.target.value))}}/></label>
  </div>
  <p className="text-xs text-muted-foreground">A ordem regular define a seleção inicial. Um trabalhador regular saudável permanece; a reserva recebe novas tarefas somente enquanto os regulares estão indisponíveis. As vagas globais continuam limitando esta conversa.</p>
  {baseRevision!==(policies.at(-1)?.revision??0)&&<p role="status">Uma nova revisão foi publicada. Carregue a revisão desejada antes de publicar outra alteração.</p>}
  {roleSchema.options.map(role=><fieldset key={role} className="min-w-0 rounded-md border p-3">
   <legend className="px-1 font-medium">{labels[role]}</legend>
   {(['regular','emergency'] as const).map(kind=><div key={kind} className="mb-3 flex min-w-0 flex-col gap-2">
    <span className="text-sm">{kind==='regular'?'Preferência regular':'Reserva de emergência'}</span>
    <ol className="flex min-w-0 flex-col gap-2">{roles[role][kind].map((id,index)=><li key={id} className="flex min-w-0 flex-wrap items-center gap-1">
     <span className="min-w-0 flex-1 break-words text-sm">{index+1}. {describe(id)}</span>
     <Button type="button" size="sm" aria-label={`Subir ${labels[role]} ${kind} ${index+1}`} disabled={busy||index===0} onClick={()=>edit(role,kind,index,'up')}>↑</Button>
     <Button type="button" size="sm" aria-label={`Descer ${labels[role]} ${kind} ${index+1}`} disabled={busy||index===roles[role][kind].length-1} onClick={()=>edit(role,kind,index,'down')}>↓</Button>
     <Button type="button" size="sm" disabled={busy} onClick={()=>edit(role,kind,index,'remove')}>Remover</Button>
    </li>)}</ol>
    <select aria-label={`${labels[role]} — ${kind==='regular'?'adicionar regular':'adicionar reserva'}`} value="" disabled={busy||roles[role][kind].length>=20}
     className="h-9 min-w-0 max-w-full rounded-md border bg-card px-2 text-sm" onChange={e=>add(role,kind,e.target.value)}>
     <option value="">Adicionar perfil</option>{profiles.filter(p=>p.role===role&&![...roles[role].regular,...roles[role].emergency].includes(p.id)).map(p=><option key={p.id} value={p.id}>{describe(p.id)}</option>)}
    </select>
   </div>)}
  </fieldset>)}
  {error&&<p role="alert">{error}</p>}
  <Button type="submit" disabled={busy||baseRevision!==(policies.at(-1)?.revision??0)}>{rollback?'Publicar reversão como nova revisão':'Publicar nova revisão'}</Button>
 </form>
}
