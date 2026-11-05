import {cleanup,fireEvent,render,screen} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {MemoryRouter,Route,Routes} from 'react-router'
import {afterEach,expect,it,vi} from 'vitest'
import {AgentControlConversationResolver} from './agent-control-conversation-resolver'
const projectA='00000000-0000-4000-8000-000000000001',projectB='00000000-0000-4000-8000-000000000002'
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
function view(matches:unknown[]){
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({matches})))
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}})
 render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/settings/agent-control?acSession=session-a']}><Routes><Route path='/settings/agent-control' element={<AgentControlConversationResolver sessionId='session-a'/>}/><Route path='/p/:projectId/settings/agent-control' element={<p>Scoped panel</p>}/></Routes></MemoryRouter></QueryClientProvider>)
}
it('opens the unique authorized project without selecting the default',async()=>{view([{projectId:projectB,contextId:projectA}]);await screen.findByText('Scoped panel')})
it('requires explicit choice for ambiguous authorized matches',async()=>{
 view([{projectId:projectA,contextId:projectA},{projectId:projectB,contextId:projectB}]);await screen.findByText('Escolha o projeto desta conversa.');expect(screen.queryByText('Scoped panel')).toBeNull()
 fireEvent.click(screen.getByRole('link',{name:`Abrir projeto ${projectB}`}));await screen.findByText('Scoped panel')
})
it('does not expose a configuration form when no authorized match exists',async()=>{view([]);await screen.findByText('Esta conversa não tem vínculo autorizado disponível.');expect(screen.queryByText('Scoped panel')).toBeNull()})
