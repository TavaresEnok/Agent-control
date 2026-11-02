import {cleanup,fireEvent,render,screen} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import type {z} from 'zod'
import {AgentControlProfileEditor,catalogEntrySchema} from './agent-control-profile-editor'
const first='00000000-0000-4000-8000-000000000001',second='00000000-0000-4000-8000-000000000002'
const catalog:z.infer<typeof catalogEntrySchema>[]=[
 {provider:'fixture-a',model:'programmer-a',efforts:['medium','high'],roles:['programmer'],source:'synthetic://a'},
 {provider:'fixture-b',model:'reviewer-b',efforts:['high'],roles:['reviewer'],source:'synthetic://b'},
]
afterEach(cleanup)
it('uses only the selected account provider, supported role and allowed effort, resetting incompatible choices',()=>{
 const add=vi.fn()
 render(<AgentControlProfileEditor accounts={[{id:first,label:'A',provider:'fixture-a',can_manage:true},
  {id:second,label:'B',provider:'fixture-b',can_manage:true}]} catalog={catalog} busy={false} onAdd={add}/>)
 fireEvent.change(screen.getByLabelText('Conta do perfil'),{target:{value:first}})
 fireEvent.change(screen.getByLabelText('Modelo validado'),{target:{value:'programmer-a'}})
 fireEvent.click(screen.getByText('Cadastrar perfil'))
 expect(add).toHaveBeenLastCalledWith({id:expect.any(String),accountId:first,model:'programmer-a',role:'programmer',effort:'medium'})
 fireEvent.change(screen.getByLabelText('Conta do perfil'),{target:{value:second}})
 expect((screen.getByText('Cadastrar perfil') as HTMLButtonElement).disabled).toBe(true)
 expect(screen.getByRole('status').textContent).toContain('Nenhum modelo foi homologado')
 fireEvent.change(screen.getByLabelText('Função do perfil'),{target:{value:'reviewer'}})
 fireEvent.change(screen.getByLabelText('Modelo validado'),{target:{value:'reviewer-b'}})
 expect(Array.from((screen.getByLabelText('Esforço do perfil') as HTMLSelectElement).options).map(o=>o.value)).toEqual(['','high'])
 fireEvent.click(screen.getByText('Cadastrar perfil'))
 expect(add).toHaveBeenLastCalledWith({id:expect.any(String),accountId:second,model:'reviewer-b',role:'reviewer',effort:'high'})
})
