import {cleanup,render,screen} from '@testing-library/react'
import {afterEach,expect,it} from 'vitest'
import {AgentControlGrantSelection,grantSelectionSchema} from './agent-control-grant-selection'
const accountId='00000000-0000-4000-8000-000000000001',profileId='00000000-0000-4000-8000-000000000002'
const base={accountId,profileId,policyRevision:3,configRevision:2,chain:'regular',position:2,reason:'fallback'}
afterEach(cleanup)
it('explains the selected authorized profile, revisions and fallback',()=>{
 render(<AgentControlGrantSelection selection={grantSelectionSchema.parse(base)} accountId={accountId} profileId={profileId} accounts={[{id:accountId,label:'Conta visível'}]} profiles={[{id:profileId,account_id:accountId,model:'modelo',effort:'medium',role:'programmer'}]}/>)
 expect(screen.getByText(/Conta visível · modelo · medium/)).toBeTruthy();expect(screen.getByText(/revisão 3.*revisão 2/)).toBeTruthy();expect(screen.getByText(/Perfil alternativo escolhido/)).toBeTruthy();expect(screen.getByText(/posição 2 na ordem efetiva total/)).toBeTruthy()
})
it('does not disclose unknown identities and tolerates malformed selection',()=>{
 expect(grantSelectionSchema.parse({...base,reason:'unknown'})).toBeNull()
 const {container}=render(<AgentControlGrantSelection selection={grantSelectionSchema.parse(base)} accountId={accountId} profileId={profileId} accounts={[]} profiles={[]}/>)
 expect(container.textContent).toContain('Detalhes do perfil indisponíveis');expect(container.textContent).not.toContain(accountId);expect(container.textContent).not.toContain(profileId)
})
it.each([['sticky','Perfil mantido da seleção anterior'],['first_eligible','Primeiro perfil elegível'],['fallback','Perfil alternativo escolhido']] as const)('explains %s', (reason, message)=>{
 render(<AgentControlGrantSelection selection={grantSelectionSchema.parse({...base,reason})} accountId={accountId} profileId={profileId} accounts={[]} profiles={[]}/>)
 expect(screen.getByText(new RegExp(message))).toBeTruthy()
})
it('rejects selection evidence that does not match the grant',()=>{
 const {container}=render(<AgentControlGrantSelection selection={grantSelectionSchema.parse(base)} accountId={profileId} profileId={profileId} accounts={[{id:accountId,label:'Não exibir'}]} profiles={[]}/>)
 expect(container.textContent).toContain('Detalhes da seleção não disponíveis');expect(container.textContent).not.toContain('Não exibir')
})
