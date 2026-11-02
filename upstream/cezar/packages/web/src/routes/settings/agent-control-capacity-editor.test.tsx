import {cleanup,fireEvent,render,screen} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {AgentControlCapacityEditor} from './agent-control-capacity-editor'
const account='00000000-0000-4000-8000-000000000001'
const config={revision:4,programmingLimit:10,evaluationLimit:2,originalFallback:{accountId:account,programmingLimit:8,evaluationLimit:2}}
afterEach(cleanup)
it('keeps the loaded revision and requires reload after a concurrent global change',()=>{
 const save=vi.fn(),props={accounts:[{id:account,label:'Reserva original'}],busy:false,canEdit:true,onSave:save}
 const view=render(<AgentControlCapacityEditor {...props} config={config}/>)
 fireEvent.change(screen.getByLabelText('Programadores globais'),{target:{value:'8'}})
 fireEvent.click(screen.getByText('Aplicar limites globais'))
 expect(save).toHaveBeenCalledWith({expectedRevision:4,programmingLimit:8,evaluationLimit:2,originalFallback:config.originalFallback})
 save.mockClear();view.rerender(<AgentControlCapacityEditor {...props} config={{...config,revision:5,programmingLimit:12}}/>)
 expect((screen.getByText('Aplicar limites globais') as HTMLButtonElement).disabled).toBe(true)
 fireEvent.click(screen.getByText('Recarregar valores globais'));fireEvent.click(screen.getByText('Aplicar limites globais'))
 expect(save).toHaveBeenCalledWith({expectedRevision:5,programmingLimit:12,evaluationLimit:2,originalFallback:config.originalFallback})
})
it('shows the global limits without an edit path for a non-administrator',()=>{
 render(<AgentControlCapacityEditor config={{...config,originalFallback:null}} accounts={[]} busy={false} canEdit={false} onSave={vi.fn()}/>)
 expect(screen.getByText('Limite global: 10 programadores e 2 avaliações. Revisão 4.')).not.toBeNull()
 expect(screen.queryByRole('button')).toBeNull();expect(screen.queryByRole('spinbutton')).toBeNull()
})
