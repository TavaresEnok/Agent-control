import {z} from 'zod'
import {CAPACITY_EXCLUSION_REASONS,EXCLUSION_TEXT} from './agent-control-capacity-waits'
const selectionSchema=z.object({accountId:z.string().uuid(),profileId:z.string().uuid(),policyRevision:z.number().int().positive(),configRevision:z.number().int().nonnegative(),chain:z.enum(['regular','emergency']),position:z.number().int().positive(),reason:z.enum(['sticky','first_eligible','fallback']),preferredProfileId:z.string().uuid().nullable().optional(),skippedCandidates:z.array(z.object({profileId:z.string().uuid(),reason:z.enum(CAPACITY_EXCLUSION_REASONS)}).strict()).max(39).optional()}).strict().refine(value=>{
 if(value.skippedCandidates===undefined)return value.preferredProfileId===undefined
 return value.preferredProfileId!==undefined&&value.skippedCandidates.length===value.position-1&&new Set(value.skippedCandidates.map(item=>item.profileId)).size===value.skippedCandidates.length&&!value.skippedCandidates.some(item=>item.profileId===value.profileId)
})
export const grantSelectionSchema=selectionSchema.nullable().optional().catch(null)
type Selection=z.infer<typeof selectionSchema>
const reasons:Record<Selection['reason'],string>={sticky:'Perfil mantido da seleção anterior.',first_eligible:'Primeiro perfil elegível na cadeia.',fallback:'Perfil alternativo escolhido após opções anteriores indisponíveis.'}
export function AgentControlGrantSelection({selection,accountId,profileId,accounts,profiles}:{selection:Selection|null|undefined;accountId:string;profileId:string;accounts:{id:string;label:string}[];profiles:{id:string;account_id:string;model:string;effort:string;role:string}[]}){
 if(!selection||selection.accountId!==accountId||selection.profileId!==profileId)return <p>Detalhes da seleção não disponíveis para esta concessão.</p>
 const account=accounts.find(a=>a.id===selection.accountId),profile=profiles.find(p=>p.id===selection.profileId&&p.account_id===selection.accountId)
 const describe=(id:string)=>{const p=profiles.find(item=>item.id===id);const a=p?accounts.find(item=>item.id===p.account_id):undefined;return p&&a?`${a.label} · ${p.model} · ${p.effort}`:'Perfil indisponível'}
 return <div className="mt-2 text-sm"><p><strong>Perfil selecionado:</strong> {account&&profile?`${account.label} · ${profile.model} · ${profile.effort} · ${profile.role}`:'Detalhes do perfil indisponíveis'}</p>
  <p>Política de capacidade: revisão {selection.policyRevision} · configuração: revisão {selection.configRevision}</p><p>Cadeia {selection.chain==='regular'?'regular':'emergencial'} · posição {selection.position} na ordem efetiva total</p><p>Motivo: {reasons[selection.reason]}</p>{selection.preferredProfileId&&<p>Preferência original: {describe(selection.preferredProfileId)}</p>}{selection.skippedCandidates&&selection.skippedCandidates.length>0&&<ul>{selection.skippedCandidates.map(item=><li key={item.profileId}>{describe(item.profileId)}: {EXCLUSION_TEXT[item.reason]}</li>)}</ul>}</div>
}
