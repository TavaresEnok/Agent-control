import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {afterEach,expect,it,vi} from 'vitest'
import {ProjectScopeProvider} from '@/api/project-scope-context'
import {AgentControlDiagnostics} from './agent-control-diagnostics'
const contextId='00000000-0000-4000-8000-000000000001',projectA='00000000-0000-4000-8000-000000000002',projectB='00000000-0000-4000-8000-000000000003'
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
it('shows unknown neutrally and reloads scoped findings with collapsed references',async()=>{
 const calls:string[]=[]
 vi.stubGlobal('fetch',vi.fn(async(_path:string,init:RequestInit)=>{
  const project=new Headers(init.headers).get('x-agent-control-project')??'';calls.push(project)
  const findings=project===projectB?Array.from({length:11},(_,i)=>({code:'context_paused',meaning:`Pausa ${i+1}`,owner:'Operador',nextCondition:'Retomar com autorização',evidence:[{kind:'context',id:contextId}]})):[]
  return new Response(JSON.stringify({contextId,findings,truncated:false,assessment:findings.length?'observed':'unknown',...(findings.length?{}:{explanation:'Estado desconhecido.'})}))
 }))
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}})
 const view=render(<QueryClientProvider client={client}><ProjectScopeProvider projectId={projectA}><AgentControlDiagnostics contextId={contextId}/></ProjectScopeProvider></QueryClientProvider>)
 await screen.findByText('Estado desconhecido.')
 expect(screen.queryByText(/saudável/i)).toBeNull()
 view.rerender(<QueryClientProvider client={client}><ProjectScopeProvider projectId={projectB}><AgentControlDiagnostics contextId={contextId}/></ProjectScopeProvider></QueryClientProvider>)
 await screen.findByText('Pausa 1');expect(screen.queryByText('Estado desconhecido.')).toBeNull()
 expect(screen.getAllByText('Responsável: Operador')).toHaveLength(10);expect(screen.getAllByText('Próxima condição: Retomar com autorização')).toHaveLength(10)
 expect(screen.queryByText('Pausa 11')).toBeNull();expect(screen.getAllByText('Referências (1)')[0]!.parentElement?.hasAttribute('open')).toBe(false)
 fireEvent.click(screen.getByText('Próximos'));await screen.findByText('Pausa 11');expect(screen.queryByText('Pausa 1')).toBeNull()
 await waitFor(()=>expect(calls).toEqual([projectA,projectB]));client.clear()
})
