import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {afterEach,expect,it,vi} from 'vitest'
import {AgentControlProjectAdmin} from './agent-control-project-admin'
import {signControl} from './agent-control-operator'
vi.mock('./agent-control-operator',()=>({signControl:vi.fn().mockResolvedValue('fixture-proof')}))
afterEach(()=>{cleanup();vi.unstubAllGlobals();sessionStorage.clear()})
it('registers only a root-relative project and retries the same signed intent',async()=>{
 const commands:Record<string,any>[]=[]
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init?:RequestInit)=>{
  if(init?.method==='POST'){
   const command=JSON.parse(String(init.body));commands.push(command)
   if(commands.length===1)return new Response(JSON.stringify({error:'TEMPORARY_FAILURE'}),{status:503})
   return new Response(JSON.stringify({state:'applied',projectId:command.payload.projectId}))
  }
  return new Response(JSON.stringify({principalId:'fixture',installationId:'00000000-0000-4000-8000-000000000001',operatorDeviceIds:[],canRegister:true,server:{kind:'local',remoteManagement:false},roots:[{id:'fixture',label:'Fixture root'}]}))
 }))
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})
 render(<QueryClientProvider client={client}><AgentControlProjectAdmin/></QueryClientProvider>)
 fireEvent.change(await screen.findByLabelText('Nome do projeto'),{target:{value:'Example'}})
 fireEvent.change(screen.getByLabelText('Raiz autorizada'),{target:{value:'fixture'}})
 fireEvent.change(screen.getByLabelText('Caminho relativo do repositório'),{target:{value:'repo'}})
 fireEvent.click(screen.getByText('Cadastrar projeto'))
 await screen.findByText('TEMPORARY_FAILURE');fireEvent.click(screen.getByText('Cadastrar projeto'))
 await screen.findByText('Projeto cadastrado.')
 expect(commands).toHaveLength(2);expect(commands[0]!.intentId).toBe(commands[1]!.intentId)
 expect(commands[0]!.payload.projectId).toBe(commands[1]!.payload.projectId)
 expect(commands[0]!.deliveryAttemptId).not.toBe(commands[1]!.deliveryAttemptId)
 expect(commands[0]!.payload).toMatchObject({label:'Example',rootId:'fixture',relativePath:'repo'})
 await waitFor(()=>expect(sessionStorage.length).toBe(0));client.clear()
})
it('allows discarding a definitive refusal and keeps uncertain submissions',async()=>{
 let status=403
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init?:RequestInit)=>init?.method==='POST'
  ?new Response(JSON.stringify({error:'REJECTED'}),{status})
  :new Response(JSON.stringify({principalId:'fixture',installationId:'00000000-0000-4000-8000-000000000001',operatorDeviceIds:[],canRegister:true,server:{kind:'local',remoteManagement:false},roots:[{id:'fixture',label:'Fixture root'}]}))))
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})
 render(<QueryClientProvider client={client}><AgentControlProjectAdmin/></QueryClientProvider>)
 fireEvent.change(await screen.findByLabelText('Nome do projeto'),{target:{value:'Example'}})
 fireEvent.change(screen.getByLabelText('Raiz autorizada'),{target:{value:'fixture'}})
 fireEvent.change(screen.getByLabelText('Caminho relativo do repositório'),{target:{value:'repo'}})
 fireEvent.click(screen.getByText('Cadastrar projeto'));fireEvent.click(await screen.findByText('Descartar rascunho recusado'))
 expect(sessionStorage.length).toBe(0)
 status=503;fireEvent.click(screen.getByText('Cadastrar projeto'));await screen.findByText('REJECTED')
 expect(screen.queryByText('Descartar rascunho recusado')).toBeNull();expect(sessionStorage.length).toBe(1)
 client.clear()
})
it('removes discard permission before retrying a previously refused submission',async()=>{
 let count=0
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init?:RequestInit)=>{
  if(init?.method==='POST'){count++;return new Response(JSON.stringify({error:count===1?'REJECTED':'UNKNOWN'}),{status:count===1?403:503})}
  return new Response(JSON.stringify({principalId:'fixture',installationId:'00000000-0000-4000-8000-000000000001',operatorDeviceIds:[],canRegister:true,server:{kind:'local',remoteManagement:false},roots:[{id:'fixture',label:'Fixture root'}]}))
 }))
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})
 render(<QueryClientProvider client={client}><AgentControlProjectAdmin/></QueryClientProvider>)
 fireEvent.change(await screen.findByLabelText('Nome do projeto'),{target:{value:'Example'}})
 fireEvent.change(screen.getByLabelText('Raiz autorizada'),{target:{value:'fixture'}})
 fireEvent.change(screen.getByLabelText('Caminho relativo do repositório'),{target:{value:'repo'}})
 fireEvent.click(screen.getByText('Cadastrar projeto'));await screen.findByText('Descartar rascunho recusado')
 fireEvent.click(screen.getByText('Cadastrar projeto'));await screen.findByText('UNKNOWN')
 expect(screen.queryByText('Descartar rascunho recusado')).toBeNull();expect(sessionStorage.length).toBe(1)
 client.clear()
})
it('allows discarding a draft if signing fails before any request is sent',async()=>{
 vi.mocked(signControl).mockRejectedValueOnce(Error('DEVICE_KEY_UNAVAILABLE'))
 const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({principalId:'fixture',installationId:'00000000-0000-4000-8000-000000000001',operatorDeviceIds:[],canRegister:true,server:{kind:'local',remoteManagement:false},roots:[{id:'fixture',label:'Fixture root'}]})))
 vi.stubGlobal('fetch',fetchMock)
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})
 render(<QueryClientProvider client={client}><AgentControlProjectAdmin/></QueryClientProvider>)
 fireEvent.change(await screen.findByLabelText('Nome do projeto'),{target:{value:'Example'}})
 fireEvent.change(screen.getByLabelText('Raiz autorizada'),{target:{value:'fixture'}})
 fireEvent.change(screen.getByLabelText('Caminho relativo do repositório'),{target:{value:'repo'}})
 fireEvent.click(screen.getByText('Cadastrar projeto'));fireEvent.click(await screen.findByText('Descartar rascunho recusado'))
 expect(fetchMock).toHaveBeenCalledTimes(1);expect(sessionStorage.length).toBe(0);client.clear()
})
it('shows a redacted read-only ssh origin and ignores credentials in the payload',async()=>{
 const hostId='00000000-0000-4000-8000-000000000010',project='00000000-0000-4000-8000-000000000011'
 const commit='ab'.repeat(20),tree='cd'.repeat(20)
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({principalId:'fixture',installationId:'00000000-0000-4000-8000-000000000001',operatorDeviceIds:[],canRegister:false,
  server:{kind:'local',remoteManagement:false},roots:[],remoteSources:[{projectId:project,hostId,commit,tree,state:'materialized',reviewStatus:'not_reviewed',proof:'super-secret-proof',publicKey:'ssh-ed25519 SECRET'}]}))))
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})
 render(<QueryClientProvider client={client}><AgentControlProjectAdmin/></QueryClientProvider>)
 expect(await screen.findByText(/Origem SSH somente leitura/)).toBeTruthy()
 expect(screen.getByText(new RegExp(hostId))).toBeTruthy()
 expect(screen.getByText(new RegExp(commit))).toBeTruthy()
 expect(screen.getByText(new RegExp(tree))).toBeTruthy()
 expect(screen.getByText(/não revisada/)).toBeTruthy()
 expect(screen.queryByText(/super-secret-proof/)).toBeNull()
 expect(screen.queryByText(/ssh-ed25519/)).toBeNull()
 expect(screen.queryByRole('button',{name:'Materializar'})).toBeNull()
 client.clear()
})
it('does not discard an uncertain earlier submission when a later signature fails',async()=>{
 vi.mocked(signControl).mockRejectedValueOnce(Error('DEVICE_KEY_UNAVAILABLE'))
 sessionStorage.setItem('ac-project-register:fixture:00000000-0000-4000-8000-000000000001',JSON.stringify({semantic:JSON.stringify({label:'Example',rootId:'fixture',relativePath:'repo'}),intentId:'00000000-0000-4000-8000-000000000002',projectId:'00000000-0000-4000-8000-000000000003',uncertain:true}))
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({principalId:'fixture',installationId:'00000000-0000-4000-8000-000000000001',operatorDeviceIds:[],canRegister:true,server:{kind:'local',remoteManagement:false},roots:[{id:'fixture',label:'Fixture root'}]}))))
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})
 render(<QueryClientProvider client={client}><AgentControlProjectAdmin/></QueryClientProvider>)
 fireEvent.change(await screen.findByLabelText('Nome do projeto'),{target:{value:'Example'}})
 fireEvent.change(screen.getByLabelText('Raiz autorizada'),{target:{value:'fixture'}})
 fireEvent.change(screen.getByLabelText('Caminho relativo do repositório'),{target:{value:'repo'}})
 fireEvent.click(screen.getByText('Cadastrar projeto'));await screen.findByText('DEVICE_KEY_UNAVAILABLE')
 expect(screen.queryByText('Descartar rascunho recusado')).toBeNull();expect(sessionStorage.length).toBe(1);client.clear()
})
