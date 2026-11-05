import {cleanup,fireEvent,render,screen} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {afterEach,expect,it,vi} from 'vitest'
import {AgentControlUsageReport,usageReportParams} from './agent-control-usage-report'
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
const contextId='00000000-0000-4000-8000-000000000001',profileId='00000000-0000-4000-8000-000000000002'
it('keeps unknown counters distinct from zero and continues with original filters',async()=>{
 const urls:string[]=[]
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{urls.push(url);return Response.json({schemaVersion:1,scope:'reported_attempt_usage_deltas',subscriptionBalance:'unknown',monetaryCost:'unknown',overlappingCounters:true,profileMetadata:'current',reworkDefinition:'recorded_correction_decision',contextId,periods:{current:{from:'2026-11-01T00:00:00Z',to:'2026-11-02T00:00:00Z'},previous:{from:'2026-10-31T00:00:00Z',to:'2026-11-01T00:00:00Z'}},attempts:urls.length===1?[{grantId:profileId,model:'synthetic',effort:'medium',rework:true,baseline:'missing',counters:{input:null,output:'0',cache:null,reasoning:null}}]:[],comparison:[],nextCursor:urls.length===1?'bound-cursor':null,page:{limit:100,complete:urls.length>1}})}))
 const cache=new QueryClient({defaultOptions:{mutations:{retry:false}}});render(<QueryClientProvider client={cache}><AgentControlUsageReport contextId={contextId} profiles={[]}/></QueryClientProvider>)
 fireEvent.change(screen.getByLabelText('Início UTC'),{target:{value:'2026-11-01T00:00'}});fireEvent.change(screen.getByLabelText('Fim UTC'),{target:{value:'2026-11-02T00:00'}});fireEvent.click(screen.getByRole('button',{name:'Consultar relatório de uso'}))
 expect(await screen.findByText('Entrada: desconhecido')).toBeTruthy();expect(screen.getByText('Saída: 0')).toBeTruthy();expect(screen.getByText(/CSV contém uma página/)).toBeTruthy()
 fireEvent.change(screen.getByLabelText('Retrabalho registrado'),{target:{value:'only'}});fireEvent.click(screen.getByRole('button',{name:'Próxima página de tentativas'}));expect(await screen.findByText(/Esta página contém 0 tentativas/)).toBeTruthy()
 const first=new URL(urls[0]!,'http://synthetic.invalid'),second=new URL(urls[1]!,'http://synthetic.invalid');expect(second.searchParams.get('rework')).toBe(first.searchParams.get('rework'));expect(second.searchParams.get('cursor')).toBe('bound-cursor');expect(second.searchParams.get('from')).toBe('2026-11-01T00:00:00.000Z')
})
it('encodes page filters explicitly for both JSON and CSV routes',()=>{
 expect(new URLSearchParams(usageReportParams({from:'2026-11-01T00:00:00Z',to:'2026-11-02T00:00:00Z',profileId,rework:'exclude'},'cursor+/=')).get('cursor')).toBe('cursor+/=')
})

it('hides a previous context report and its download actions after switching context',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({schemaVersion:1,scope:'reported_attempt_usage_deltas',subscriptionBalance:'unknown',monetaryCost:'unknown',overlappingCounters:true,profileMetadata:'current',reworkDefinition:'recorded_correction_decision',contextId,periods:{current:{from:'2026-11-01T00:00:00Z',to:'2026-11-02T00:00:00Z'},previous:{from:'2026-10-31T00:00:00Z',to:'2026-11-01T00:00:00Z'}},attempts:[],comparison:[],nextCursor:null,page:{limit:100,complete:true}})))
 const cache=new QueryClient({defaultOptions:{mutations:{retry:false}}}),view=render(<QueryClientProvider client={cache}><AgentControlUsageReport contextId={contextId} profiles={[]}/></QueryClientProvider>)
 fireEvent.click(screen.getByRole('button',{name:'Consultar relatório de uso'}));expect(await screen.findByRole('button',{name:'Baixar CSV desta página'})).toBeTruthy()
 view.rerender(<QueryClientProvider client={cache}><AgentControlUsageReport contextId={profileId} profiles={[]}/></QueryClientProvider>);expect(screen.queryByRole('button',{name:'Baixar CSV desta página'})).toBeNull();expect(screen.queryByText(/Esta página contém/)).toBeNull()
})
