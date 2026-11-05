import {z} from 'zod'
const selectionSchema=z.object({accountId:z.string().uuid(),profileId:z.string().uuid(),policyRevision:z.number().int().positive(),configRevision:z.number().int().nonnegative(),chain:z.enum(['regular','emergency']),position:z.number().int().positive(),reason:z.enum(['sticky','first_eligible','fallback'])}).strict()
export const grantSelectionSchema=selectionSchema.nullable().optional().catch(null)
type Selection=z.infer<typeof selectionSchema>
const reasons:Record<Selection['reason'],string>={sticky:'Perfil mantido da seleção anterior.',first_eligible:'Primeiro perfil elegível na cadeia.',fallback:'Perfil alternativo escolhido após opções anteriores indisponíveis.'}
export function AgentControlGrantSelection({selection,accountId,profileId,accounts,profiles}:{selection:Selection|null|undefined;accountId:string;profileId:string;accounts:{id:string;label:string}[];profiles:{id:string;account_id:string;model:string;effort:string;role:string}[]}){
 if(!selection||selection.accountId!==accountId||selection.profileId!==profileId)return <p>Detalhes da seleção não disponíveis para esta concessão.</p>
 const account=accounts.find(a=>a.id===selection.accountId),profile=profiles.find(p=>p.id===selection.profileId&&p.account_id===selection.accountId)
 return <div className="mt-2 text-sm"><p><strong>Perfil selecionado:</strong> {account&&profile?`${account.label} · ${profile.model} · ${profile.effort} · ${profile.role}`:'Detalhes do perfil indisponíveis'}</p>
  <p>Política de capacidade: revisão {selection.policyRevision} · configuração: revisão {selection.configRevision}</p><p>Cadeia {selection.chain==='regular'?'regular':'emergencial'} · posição {selection.position} na ordem efetiva total</p><p>Motivo: {reasons[selection.reason]}</p></div>
}
