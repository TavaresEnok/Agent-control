import {cleanup,fireEvent,render,screen} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {AgentControlPolicyEditor} from './agent-control-policy-editor'
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const accounts=[{id:id(20),label:'Conta principal'},{id:id(21),label:'Conta de programação'}]
const roles=['manager','programmer','programmer','reviewer','qa','specialist','judge','programmer']
const profiles=roles.map((role,index)=>({id:id(index+1),account_id:index===7?id(21):id(20),model:`Modelo ${index+1}`,effort:'medium',role}))
afterEach(cleanup)

it('loads all roles and publishes reordered regular and emergency chains without discarding other functions',()=>{
 const publish=vi.fn(),policy={schemaVersion:1,maxProgrammersPerContext:10,maxEvaluatorsPerContext:2,roles:{
  manager:{regular:[id(1)],emergency:[]},programmer:{regular:[id(2),id(3)],emergency:[id(8)]},
  reviewer:{regular:[id(4)],emergency:[]},qa:{regular:[id(5)],emergency:[]},
  specialist:{regular:[id(6)],emergency:[]},judge:{regular:[id(7)],emergency:[]}}}
 const view=render(<AgentControlPolicyEditor profiles={profiles} accounts={accounts} policies={[{revision:3,snapshot:policy}]} busy={false} onPublish={publish}/>)
 fireEvent.change(screen.getByLabelText('Revisão para editar'),{target:{value:'3'}});fireEvent.click(screen.getByText('Carregar revisão'))
 expect(screen.getByText('1. Conta de programação · Modelo 8 · medium')).not.toBeNull()
 fireEvent.click(screen.getByLabelText('Descer Programação regular 1'))
 fireEvent.change(screen.getByLabelText('Programadores por conversa'),{target:{value:'8'}})
 expect(Array.from((screen.getByLabelText('Programação — adicionar regular') as HTMLSelectElement).options).map(o=>o.value)).not.toContain(id(8))
 fireEvent.click(screen.getByText('Publicar nova revisão'))
 expect(publish).toHaveBeenCalledOnce()
 expect(publish).toHaveBeenCalledWith({expectedRevision:3,policy:{...policy,maxProgrammersPerContext:8,
  roles:{...policy.roles,programmer:{regular:[id(3),id(2)],emergency:[id(8)]}}}})
 view.rerender(<AgentControlPolicyEditor profiles={profiles} accounts={accounts} policies={[{revision:3,snapshot:policy},{revision:4,snapshot:policy}]} busy={false} onPublish={publish}/>)
 expect((screen.getByText('Publicar nova revisão') as HTMLButtonElement).disabled).toBe(true)
 fireEvent.click(screen.getByText('Carregar revisão'));fireEvent.click(screen.getByText('Publicar nova revisão'))
 expect(publish).toHaveBeenLastCalledWith({expectedRevision:4,policy})
})

it('refuses a role with only emergency profiles instead of silently dropping it',()=>{
 const publish=vi.fn()
 render(<AgentControlPolicyEditor profiles={profiles} accounts={accounts} policies={[]} busy={false} onPublish={publish}/>)
 fireEvent.change(screen.getByLabelText('Programação — adicionar regular'),{target:{value:id(2)}})
 fireEvent.change(screen.getByLabelText('QA — adicionar reserva'),{target:{value:id(5)}})
 fireEvent.click(screen.getByText('Publicar nova revisão'))
 expect(publish).not.toHaveBeenCalled();expect(screen.getByRole('alert').textContent).toContain('Cada função configurada precisa de um perfil regular')
})

it('captures the restored revision rather than an unloaded dropdown choice and clears rollback on edits',()=>{
 const publish=vi.fn(),original={schemaVersion:1,maxProgrammersPerContext:10,maxEvaluatorsPerContext:2,roles:{programmer:{regular:[id(2)],emergency:[]}}},later={...original,maxProgrammersPerContext:2}
 render(<AgentControlPolicyEditor profiles={profiles} accounts={accounts} policies={[{revision:1,snapshot:original},{revision:2,snapshot:later}]} busy={false} onPublish={publish}/>)
 fireEvent.change(screen.getByLabelText('Revisão para editar'),{target:{value:'1'}});fireEvent.click(screen.getByText('Preparar reversão desta revisão'));fireEvent.change(screen.getByLabelText('Revisão para editar'),{target:{value:'2'}})
 expect(screen.getByRole('status').textContent).toContain('Reversão preparada da revisão 1.')
 fireEvent.click(screen.getByText('Publicar reversão como nova revisão'));expect(publish).toHaveBeenLastCalledWith({expectedRevision:2,policy:original})
 fireEvent.change(screen.getByLabelText('Programadores por conversa'),{target:{value:'3'}});expect(screen.queryByText('Publicar reversão como nova revisão')).toBeNull();expect(screen.getByText('Publicar nova revisão')).toBeTruthy()
})
