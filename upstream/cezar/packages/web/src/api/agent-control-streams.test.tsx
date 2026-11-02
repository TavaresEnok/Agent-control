import {QueryClientProvider} from '@tanstack/react-query'
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {MemoryRouter,useNavigate} from 'react-router'
import {ScopedEvents} from '@/app'
import {createQueryClient} from './query-client'
import {createUsageStore} from './events'
import {useGlobalEvents} from './global-events'
import {useWebhookSubscription} from '@/hooks/use-webhooks'
function Streams(){useGlobalEvents(createUsageStore(),null);useWebhookSubscription('00000000-0000-4000-8000-000000000001',true);return null}
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.unstubAllEnvs()})
it('does not open an unscoped stream or webhook in managed mode',()=>{
 const source=vi.fn()
 vi.stubEnv('VITE_AGENT_CONTROL_MANAGED','1')
 vi.stubGlobal('EventSource',source)
 const client=createQueryClient()
 render(<QueryClientProvider client={client}><Streams/></QueryClientProvider>)
 expect(source).not.toHaveBeenCalled()
 client.clear()
})
it('opens the managed stream on the selected route and closes it on switching projects',async()=>{
 const opened:{url:string;close:ReturnType<typeof vi.fn>;addEventListener:ReturnType<typeof vi.fn>;removeEventListener:ReturnType<typeof vi.fn>}[]=[]
 class Source{url:string;close=vi.fn();addEventListener=vi.fn();removeEventListener=vi.fn();readyState=0
  constructor(url:string){this.url=url;opened.push(this)}}
 vi.stubEnv('VITE_AGENT_CONTROL_MANAGED','1');vi.stubGlobal('EventSource',Source)
 const client=createQueryClient(),first='00000000-0000-4000-8000-000000000001',second='00000000-0000-4000-8000-000000000002'
 function Switch(){const navigate=useNavigate();return <button onClick={()=>navigate(`/p/${second}/settings`)}>Switch</button>}
 render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/p/${first}/settings`]}><ScopedEvents><Switch/></ScopedEvents></MemoryRouter></QueryClientProvider>)
 await waitFor(()=>expect(opened[0]?.url).toContain(`/api/v1/p/${first}/workspace/events`))
 fireEvent.click(screen.getByText('Switch'))
 await waitFor(()=>expect(opened[1]?.url).toContain(`/api/v1/p/${second}/workspace/events`))
 expect(opened[0]?.close).toHaveBeenCalled()
 client.clear()
})
