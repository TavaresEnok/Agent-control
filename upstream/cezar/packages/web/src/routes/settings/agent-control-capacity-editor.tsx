import {useState} from 'react'
import {z} from 'zod'
import {Input} from '@/components/ui/input'
import {Button} from '@/components/ui/button'
const limit=z.number().int().min(1).max(128)
export const capacityEditorSchema=z.object({revision:z.number().int().nonnegative(),programmingLimit:limit,evaluationLimit:limit,
 originalFallback:z.object({accountId:z.string().uuid(),programmingLimit:limit,evaluationLimit:limit}).nullable()})
type Config=z.infer<typeof capacityEditorSchema>
type Props={config:Config|null;canEdit:boolean;accounts:{id:string;label:string}[];busy:boolean;
 onSave:(payload:{expectedRevision:number;programmingLimit:number;evaluationLimit:number;originalFallback:Config['originalFallback']})=>void}
export function AgentControlCapacityEditor({config,canEdit,accounts,busy,onSave}:Props){
 const [programmers,setProgrammers]=useState(config?.programmingLimit??''),[evaluators,setEvaluators]=useState(config?.evaluationLimit??'')
 const [original,setOriginal]=useState(config?.originalFallback?.accountId??'')
 const [reserveProgrammers,setReserveProgrammers]=useState(config?.originalFallback?.programmingLimit??'')
 const [reserveEvaluators,setReserveEvaluators]=useState(config?.originalFallback?.evaluationLimit??'')
 const [baseRevision,setBaseRevision]=useState(config?.revision??0)
 const [error,setError]=useState('')
 const load=()=>{setProgrammers(config?.programmingLimit??'');setEvaluators(config?.evaluationLimit??'');setOriginal(config?.originalFallback?.accountId??'');
  setReserveProgrammers(config?.originalFallback?.programmingLimit??'');setReserveEvaluators(config?.originalFallback?.evaluationLimit??'');setBaseRevision(config?.revision??0);setError('')}
 if(!canEdit)return <p>{config?`Limite global: ${config.programmingLimit} programadores e ${config.evaluationLimit} avaliações. Revisão ${config.revision}.`:'Capacidade global ainda não configurada.'}</p>
 return <form className="flex min-w-0 flex-col gap-3" onSubmit={event=>{
  event.preventDefault();setError('')
  const parsed=capacityEditorSchema.safeParse({revision:baseRevision,programmingLimit:Number(programmers),evaluationLimit:Number(evaluators),
   originalFallback:original?{accountId:original,programmingLimit:Number(reserveProgrammers),evaluationLimit:Number(reserveEvaluators)}:null})
  if(!parsed.success){setError('Preencha limites válidos entre 1 e 128.');return}
  const {revision,...payload}=parsed.data;onSave({expectedRevision:revision,...payload})
 }}>
  <p className="text-sm">Revisão global: {config?.revision??'ainda não configurada'}. As vagas são compartilhadas entre projetos e conversas.</p>
  {baseRevision!==(config?.revision??0)&&<p role="status">Os limites mudaram no servidor. Recarregue os valores antes de aplicar outra alteração.</p>}
  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
   <label>Programadores globais<Input aria-label="Programadores globais" type="number" required min={1} max={128} value={programmers} onChange={e=>setProgrammers(e.target.value)}/></label>
   <label>Avaliações globais<Input aria-label="Avaliações globais" type="number" required min={1} max={128} value={evaluators} onChange={e=>setEvaluators(e.target.value)}/></label>
  </div>
  <label className="flex flex-col gap-1">Conta de reserva final
   <select aria-label="Conta de reserva final" value={original} onChange={e=>setOriginal(e.target.value)} className="h-9 min-w-0 max-w-full rounded-md border bg-card px-2 text-sm">
    <option value="">Sem limite especial por conta</option>
    {original&&!accounts.some(a=>a.id===original)&&<option value={original}>Conta configurada fora deste projeto</option>}
    {accounts.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}
   </select>
  </label>
  {original&&<>
   <p className="text-xs text-muted-foreground">A reserva não recebe nova programação enquanto houver outro programador elegível em contexto ativo. Quando somente ela estiver disponível, estes limites adicionais se aplicam.</p>
   <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
    <label>Programadores da reserva<Input aria-label="Programadores da reserva" type="number" required min={1} max={128} value={reserveProgrammers} onChange={e=>setReserveProgrammers(e.target.value)}/></label>
    <label>Avaliações da reserva<Input aria-label="Avaliações da reserva" type="number" required min={1} max={128} value={reserveEvaluators} onChange={e=>setReserveEvaluators(e.target.value)}/></label>
   </div>
  </>}
  {error&&<p role="alert">{error}</p>}
  <div className="flex flex-wrap gap-2"><Button type="button" disabled={busy} onClick={load}>Recarregar valores globais</Button>
   <Button type="submit" disabled={busy||baseRevision!==(config?.revision??0)}>Aplicar limites globais</Button></div>
 </form>
}
