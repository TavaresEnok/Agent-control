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
  const project=new Headers(init.headers).get('x-agent-control-project')??'';if(!_path.endsWith('/diagnostics'))return Response.json({id:contextId,intents:[]});calls.push(project)
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

it('retrieves a task explicitly and labels structured capacity reasons without raw worker errors',async()=>{
 const intent='00000000-0000-4000-8000-000000000101',calls:string[]=[]
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>{if(!path.includes('/diagnostics'))return Response.json({id:contextId,intents:Array.from({length:101},(_,index)=>({id:index===100?intent:`00000000-0000-4000-8000-${String(index+1000).padStart(12,'0')}`,state:'failed',plan_revision:index+1}))});calls.push(path);const targeted=path.includes('intentId=');return Response.json({contextId,...(targeted?{intentId:intent}:{}),findings:targeted?[{code:'capacity_wait',meaning:'A tarefa aguarda um perfil elegível.',owner:'Titular da conta',nextCondition:'Confirmar quota do perfil e retomar a seleção.',evidence:[{kind:'intent',id:intent}],capacityWait:{reason:'NO_ELIGIBLE_CAPACITY',exclusions:[{profileId:projectA,reason:'quota_unknown'}]}}]:[],assessment:targeted?'observed':'unknown',truncated:false})}))
 const cache=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={cache}><AgentControlDiagnostics contextId={contextId}/></QueryClientProvider>)
 await screen.findByText(/Nenhuma causa foi comprovada/);fireEvent.change(await screen.findByLabelText('Tarefa registrada para diagnóstico'),{target:{value:intent}});expect(await screen.findByText('A tarefa aguarda um perfil elegível.')).toBeTruthy();expect(screen.getByText(/Nenhum perfil elegível/)).toBeTruthy();expect(screen.getByText(/Cota desconhecida/)).toBeTruthy();expect(calls.at(-1)).toContain('intentId='+intent)
 fireEvent.click(screen.getByRole('button',{name:'Voltar ao diagnóstico da conversa'}));await screen.findByText(/Nenhuma causa foi comprovada/);expect(screen.queryByText('A tarefa aguarda um perfil elegível.')).toBeNull()
})
