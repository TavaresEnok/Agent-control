import {afterEach,expect,test,vi} from 'vitest'
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {AgentControlProviderCollectors} from './agent-control-provider-collectors'
import {AgentControlObservability} from './agent-control-observability'
import type {AgentControlProviderBinding,AgentControlOperationalSnapshot} from '@open-mercato/cezar-api-client'
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers()})
const account='11111111-1111-4111-8111-111111111111'
const binding:AgentControlProviderBinding={account_id:account,adapter_id:'fixture-quota',adapter_version:'1',revision:1,minimum_interval_seconds:60,
 probe_pending:false,probe_uncertain:false,fresh:true,completed_at:'2026-11-02T10:00:00.000Z',expires_at:'2026-11-02T10:00:01.000Z',
 snapshot:{schemaVersion:1,status:'available',source:'synthetic://fixture/quota',remainingPercent:24,resetAt:null,failure:'none',subscriptionBalance:'reported'}}
test('collector view expires reported balances and preserves the revision loaded when editing',()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-02T10:00:00.000Z'))
 const bind=vi.fn(),props={accounts:[{id:account,label:'Programação teste',provider:'synthetic',mode:'synthetic',eligibility:'documented_supported',can_manage:true}],
  bindings:[binding],adapters:[{id:'fixture-quota',version:'1',provider:'synthetic',mode:'synthetic' as const,source:'synthetic://fixture/quota'}],canConfigure:true,busy:false,onBind:bind}
 const view=render(<AgentControlProviderCollectors {...props}/>)
 expect(screen.getByText(/24% restante/)).toBeTruthy()
 act(()=>{vi.advanceTimersByTime(1500)})
 expect(screen.queryByText(/24% restante/)).toBeNull();expect(screen.getByText(/Observação expirada/)).toBeTruthy()
 fireEvent.change(screen.getByLabelText('Conta para coleta'),{target:{value:account}})
 fireEvent.change(screen.getByLabelText('Coletor homologado'),{target:{value:'fixture-quota'}})
 view.rerender(<AgentControlProviderCollectors {...props} bindings={[{...binding,revision:2,minimum_interval_seconds:120}]}/>)
 expect((screen.getByRole('button',{name:'Vincular coletor de cota'}) as HTMLButtonElement).disabled).toBe(true)
 fireEvent.click(screen.getByRole('button',{name:'Recarregar coletor'}))
 fireEvent.click(screen.getByRole('button',{name:'Vincular coletor de cota'}))
 expect(bind).toHaveBeenCalledWith({accountId:account,adapterId:'fixture-quota',expectedRevision:2,minimumIntervalSeconds:120})
 view.rerender(<AgentControlProviderCollectors {...props} canConfigure={false}/>)
 expect(screen.queryByLabelText('Conta para coleta')).toBeNull()
})
test('operational aggregate is fetched only for administrators and never invents disk or missing counters',async()=>{
 const snapshot:AgentControlOperationalSnapshot={schemaVersion:1,scope:'installation_aggregate',observedAt:'2026-11-02T10:00:00.000Z',
  databaseReadOnly:true,diskObservation:'not_configured',metrics:[]}
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot),{status:200,headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',fetch)
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}})
 const view=render(<QueryClientProvider client={client}><AgentControlObservability enabled={false}/></QueryClientProvider>)
 expect(fetch).not.toHaveBeenCalled();expect(screen.queryByText('Operação da central')).toBeNull()
 view.rerender(<QueryClientProvider client={client}><AgentControlObservability enabled={true}/></QueryClientProvider>)
 expect(await screen.findByText(/Medição de disco não configurada/)).toBeTruthy();expect(fetch).toHaveBeenCalledTimes(1)
 expect(screen.queryByText(/0[,\.]0 GiB/)).toBeNull()
 const admission=screen.getByText('Admissão de novas execuções').parentElement!
 expect(within(admission).getByText('não informado')).toBeTruthy();expect(within(admission).queryByText('Fechada')).toBeNull()
 client.clear()
})
