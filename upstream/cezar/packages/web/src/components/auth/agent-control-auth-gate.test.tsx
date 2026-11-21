import {cleanup,fireEvent,render,screen} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {afterEach,expect,it,vi} from 'vitest'
import {AgentControlAuthGate} from './agent-control-auth-gate'
afterEach(()=>{cleanup();vi.unstubAllEnvs();vi.unstubAllGlobals()})
function view(config:unknown,login:(path:string,init?:RequestInit)=>Response){
 vi.stubEnv('VITE_AGENT_CONTROL_MANAGED','1')
 let authenticated=false
 const request=vi.fn(async(path:string,init?:RequestInit)=>{
  if(path.endsWith('/auth/status'))return authenticated?Response.json({authenticated:true,principalId:'owner'}):new Response('{}',{status:401})
  if(path.endsWith('/auth/config'))return Response.json(config)
  const response=login(path,init);if(response.ok)authenticated=true;return response
 })
 vi.stubGlobal('fetch',request)
 const cache=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})
 render(<QueryClientProvider client={cache}><AgentControlAuthGate><p>Private cockpit</p></AgentControlAuthGate></QueryClientProvider>)
 return request
}
it('signs in with user and password and offers no external login',async()=>{
 const request=view({enabled:false,passwordLogin:true},()=>Response.json({ok:true}))
 fireEvent.change(await screen.findByLabelText('Usuário'),{target:{value:'dono'}})
 fireEvent.change(screen.getByLabelText('Senha'),{target:{value:'segredo-longo'}})
 expect(screen.queryByText(/Happier/)).toBeNull()
 fireEvent.click(screen.getByRole('button',{name:'Entrar'}))
 await screen.findByText('Private cockpit')
 const login=request.mock.calls.find(([path])=>path==='/api/v1/ac/auth/password')
 expect(JSON.parse(String(login?.[1]?.body))).toEqual({user:'dono',password:'segredo-longo'})
 expect(request.mock.calls.every(([path])=>!path.includes('/pair'))).toBe(true)
})
it('keeps the one-time code when password login is not configured',async()=>{
 const request=view({enabled:true,webUrl:'https://legacy.example',serverUrl:'https://legacy.example',passwordLogin:false},()=>Response.json({ok:true}))
 await screen.findByText('O login por usuário e senha precisa ser configurado nesta instalação.')
 expect(screen.queryByLabelText('Senha')).toBeNull()
 expect(screen.queryByText(/Happier/)).toBeNull()
 fireEvent.click(screen.getByRole('button',{name:'Entrar com código'}))
 await screen.findByText(/npm run gateway -- pair/)
 fireEvent.change(screen.getByLabelText('Código'),{target:{value:'ABCD1234'}})
 fireEvent.click(screen.getByRole('button',{name:'Entrar'}))
 await screen.findByText('Private cockpit')
 expect(request.mock.calls.some(([path])=>path==='/api/v1/ac/auth/code')).toBe(true)
})
it('reports a wrong password without opening the cockpit',async()=>{
 view({enabled:false,passwordLogin:true},()=>new Response('{}',{status:401}))
 fireEvent.change(await screen.findByLabelText('Usuário'),{target:{value:'dono'}})
 fireEvent.change(screen.getByLabelText('Senha'),{target:{value:'errada'}})
 fireEvent.click(screen.getByRole('button',{name:'Entrar'}))
 expect((await screen.findByRole('alert')).textContent).toBe('Usuário ou senha incorretos.')
 expect(screen.queryByText('Private cockpit')).toBeNull()
})
