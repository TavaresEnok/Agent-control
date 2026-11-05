import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {afterEach,expect,it,vi} from 'vitest'
import {AgentControlProjectEnvironments} from './agent-control-project-environments'
vi.mock('./agent-control-operator',()=>({signControl:vi.fn().mockResolvedValue('synthetic-proof')}))
afterEach(()=>{cleanup();sessionStorage.clear();vi.unstubAllGlobals()})
const projectId='00000000-0000-4000-8000-000000000001',installationId='00000000-0000-4000-8000-000000000002'
function panel(){const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});return render(<QueryClientProvider client={client}><AgentControlProjectEnvironments projectId={projectId} installationId={installationId} principalId="synthetic"/></QueryClientProvider>)}
it('publishes typed relative scope and resumes the same operation after ambiguous response and reload',async()=>{
 const commands:Record<string,unknown>[]=[]
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit={})=>{
  if(init.method!=='POST')return Response.json({projectId,revision:commands.length?1:0,config:null,canConfigure:true,pathScope:'existing_repository_relative_directories',remoteHosts:[]})
  const command=JSON.parse(String(init.body));commands.push(command);return commands.length===1?Response.json({error:'ACK_UNCERTAIN'},{status:503}):Response.json({state:'applied',projectId,revision:1})
 }))
 const first=panel();fireEvent.click(await screen.findByRole('button',{name:'Carregar configuração de ambientes'}));fireEvent.change(screen.getByLabelText('Diretórios autorizados 1'),{target:{value:'src\ntests\n'}});fireEvent.click(screen.getByRole('button',{name:'Publicar ambientes e destinos'}));expect(await screen.findByText('ACK_UNCERTAIN')).toBeTruthy();expect(screen.queryByText('Descartar publicação recusada')).toBeNull();first.unmount()
 panel();const resume=await screen.findByRole('button',{name:'Confirmar configuração de ambientes pendente'});await waitFor(()=>expect((resume as HTMLButtonElement).disabled).toBe(false));fireEvent.click(resume);expect(await screen.findByText('Ambientes e destinos publicados e persistidos.')).toBeTruthy()
 expect(commands).toHaveLength(2);expect(commands[0]!.intentId).toBe(commands[1]!.intentId);expect(commands[0]!.deliveryAttemptId).not.toBe(commands[1]!.deliveryAttemptId);expect(commands[1]!.payload).toEqual(commands[0]!.payload)
 expect(commands[1]!.payload).toMatchObject({projectId,expectedRevision:0,config:{sourceBranch:'refs/heads/main',environments:[{targetRef:'refs/heads/protected',authorizedDirectories:['src','tests'],destinations:[{kind:'local_repository'}]}]}});expect(sessionStorage.length).toBe(0)
})
it('does not offer publication of an absolute or parent path',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({projectId,revision:0,config:null,canConfigure:true,pathScope:'existing_repository_relative_directories'})))
 panel();fireEvent.click(await screen.findByRole('button',{name:'Carregar configuração de ambientes'}));fireEvent.change(screen.getByLabelText('Diretórios autorizados 1'),{target:{value:'/etc\n../private'}});expect((screen.getByRole('button',{name:'Publicar ambientes e destinos'}) as HTMLButtonElement).disabled).toBe(true)
})
it('preserves a definitive first refusal across reload and permits discarding it',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit={})=>init.method==='POST'?Response.json({error:'PROJECT_ENVIRONMENT_REVISION_CONFLICT'},{status:409}):Response.json({projectId,revision:1,config:null,canConfigure:true,pathScope:'existing_repository_relative_directories',remoteHosts:[]})))
 const first=panel();fireEvent.click(await screen.findByRole('button',{name:'Carregar configuração de ambientes'}));fireEvent.change(screen.getByLabelText('Diretórios autorizados 1'),{target:{value:'src'}});fireEvent.click(screen.getByRole('button',{name:'Publicar ambientes e destinos'}));await screen.findByText('PROJECT_ENVIRONMENT_REVISION_CONFLICT');first.unmount()
 panel();fireEvent.click(await screen.findByRole('button',{name:'Descartar publicação recusada'}));await waitFor(()=>expect(sessionStorage.length).toBe(0));await waitFor(()=>expect((screen.getByRole('button',{name:'Carregar configuração de ambientes'}) as HTMLButtonElement).disabled).toBe(false))
})
