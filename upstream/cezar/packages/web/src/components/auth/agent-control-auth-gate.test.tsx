import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {afterEach,expect,it,vi} from 'vitest'
const mock=vi.hoisted(()=>({pair:vi.fn(),authentication:vi.fn()}))
vi.mock('@agent-control/happier-browser-auth',()=>({nacl:{box:{keyPair:mock.pair}},createTerminalPairingAuthentication:mock.authentication,
 applyTerminalAuthRequestExpiry:vi.fn(),openTerminalProvisioningResponse:vi.fn(),buildTerminalConnectLinks:vi.fn()}))
import {AgentControlAuthGate} from './agent-control-auth-gate'
afterEach(()=>{cleanup();vi.unstubAllEnvs();vi.unstubAllGlobals();vi.resetAllMocks()})
it.each(['keypair','pairing'])('restores login and wipes partial secrets when %s initialization fails',async failure=>{
 vi.stubEnv('VITE_AGENT_CONTROL_MANAGED','1')
 vi.stubGlobal('crypto',{subtle:{},getRandomValues:(value:Uint8Array)=>value.fill(7)})
 const secret=new Uint8Array(32).fill(9)
 mock.pair.mockImplementation(()=>{if(failure==='keypair')throw Error('ENTROPY_UNAVAILABLE');return {secretKey:secret,publicKey:new Uint8Array(32)}})
 mock.authentication.mockImplementation(()=>{throw Error('PAIRING_ENTROPY_UNAVAILABLE')})
 const request=vi.fn(async(path:string)=>path.endsWith('/status')?new Response('{}',{status:401}):
  Response.json({enabled:true,webUrl:'https://chat.example',serverUrl:'https://happier.example'}))
 vi.stubGlobal('fetch',request)
 const cache=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})
 render(<QueryClientProvider client={cache}><AgentControlAuthGate><p>Private cockpit</p></AgentControlAuthGate></QueryClientProvider>)
 const button=await screen.findByRole('button',{name:'Entrar pelo Happier'})
 await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(false))
 fireEvent.click(button)
 await screen.findByRole('alert')
 await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(false))
 expect(request.mock.calls.every(([path])=>!path.includes('/pair'))).toBe(true)
 if(failure==='pairing')expect([...secret]).toEqual(Array(32).fill(0))
 expect(screen.queryByText('Private cockpit')).toBeNull()
 cache.clear()
})
