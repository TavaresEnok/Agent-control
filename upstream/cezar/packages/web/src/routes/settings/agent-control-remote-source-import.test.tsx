import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {afterEach,expect,it,vi} from 'vitest'
import {AgentControlProjectAdmin} from './agent-control-project-admin'
import {remoteSourceSemantic,remoteSourceStorageKey} from './agent-control-remote-source-import'
import {signControl} from './agent-control-operator'
vi.mock('./agent-control-operator',()=>({signControl:vi.fn().mockResolvedValue('fixture-proof')}))
afterEach(()=>{cleanup();vi.unstubAllGlobals();sessionStorage.clear();vi.mocked(signControl).mockReset();vi.mocked(signControl).mockResolvedValue('fixture-proof')})

const project='00000000-0000-4000-8000-000000000011'
const context='00000000-0000-4000-8000-000000000012'
const operation='00000000-0000-4000-8000-000000000013'
const host='00000000-0000-4000-8000-000000000014'
const installation='00000000-0000-4000-8000-000000000001'
const commit='ab'.repeat(20),tree='cd'.repeat(20)
const marker='SNAPSHOT-LOCAL-BYTES'
async function sha256(bytes:Uint8Array){
 const digest=await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>)
 return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('')
}
function candidate(sha:string){
 return {projectId:project,contextId:context,operationId:operation,hostId:host,label:'Origem admitida',commit,tree,sha256:sha,state:'exported' as const,reviewStatus:'not_reviewed' as const}
}
function view(extra:Record<string,unknown>={}){
 return {principalId:'fixture',installationId:installation,operatorDeviceIds:[],canRegister:true,server:{kind:'local',remoteManagement:false},roots:[{id:'fixture',label:'Fixture root'}],...extra}
}
function renderPanel(body:unknown){
 const posts:{url:string;command:Record<string,unknown>}[]=[]
 const fetchMock=vi.fn(async(url:string,init?:RequestInit)=>{
  if(init?.method==='POST'){
   const command=JSON.parse(String(init.body)) as Record<string,unknown>
   posts.push({url:String(url),command})
   return fetchMock.next(command)
  }
  return new Response(JSON.stringify(body))
 }) as ReturnType<typeof vi.fn> & {next:(command:Record<string,unknown>)=>Response|Promise<Response>}
 fetchMock.next=()=>new Response(JSON.stringify({error:'UNSET'}),{status:500})
 vi.stubGlobal('fetch',fetchMock)
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})
 render(<QueryClientProvider client={client}><AgentControlProjectAdmin/></QueryClientProvider>)
 return {posts,fetchMock,client}
}

it('opens an old project-admin response without the import selector',async()=>{
 renderPanel(view())
 expect(await screen.findByLabelText('Nome do projeto')).toBeTruthy()
 expect(screen.queryByLabelText('Snapshot exportado')).toBeNull()
 expect(screen.queryByRole('button',{name:'Materializar origem SSH'})).toBeNull()
 expect(screen.queryByText(/onboarding/i)).toBeNull()
})

it('shows a short reason when the principal has no export candidate',async()=>{
 renderPanel(view({remoteSourceCandidates:[]}))
 expect(await screen.findByText(/Nenhuma exportação Git concluída deste projeto/)).toBeTruthy()
 expect(screen.queryByText(/onboarding/i)).toBeNull()
 expect(screen.queryByText(/concluíd[oa] o onboarding/i)).toBeNull()
 expect(screen.getByLabelText('Nome do projeto')).toBeTruthy()
})

it('refuses an empty or oversized file and a different sha before signing',async()=>{
 const sha=await sha256(new TextEncoder().encode(marker))
 const panel=renderPanel(view({remoteSourceCandidates:[candidate(sha)],remoteSources:[]}))
 fireEvent.change(await screen.findByLabelText('Snapshot exportado'),{target:{value:operation}})
 fireEvent.change(screen.getByLabelText('Arquivo Git bundle local'),{target:{files:[new File([new Uint8Array(65537)],'large.bundle')]}})
 fireEvent.click(screen.getByRole('button',{name:'Materializar origem SSH'}))
 expect(await screen.findByText('BUNDLE_TOO_LARGE')).toBeTruthy()
 fireEvent.change(screen.getByLabelText('Arquivo Git bundle local'),{target:{files:[new File([new Uint8Array()],'empty.bundle')]}})
 fireEvent.click(screen.getByRole('button',{name:'Materializar origem SSH'}))
 expect(await screen.findByText('BUNDLE_INVALID')).toBeTruthy()
 fireEvent.change(screen.getByLabelText('Arquivo Git bundle local'),{target:{files:[new File(['other-bytes'],'other.bundle')]}})
 fireEvent.click(screen.getByRole('button',{name:'Materializar origem SSH'}))
 expect(await screen.findByText('BUNDLE_SHA256_MISMATCH')).toBeTruthy()
 expect(vi.mocked(signControl)).not.toHaveBeenCalled()
 expect(panel.posts).toHaveLength(0)
 panel.client.clear()
})

it('materializes the selected snapshot and retries an uncertain send with the same intent',async()=>{
 const bytes=new TextEncoder().encode(marker)
 const sha=await sha256(bytes)
 const panel=renderPanel(view({remoteSourceCandidates:[{...candidate(sha),proof:'super-secret-proof',hostname:'secret.invalid'}]}))
 panel.fetchMock.next=command=>{
  if(panel.posts.length===1)return new Response(JSON.stringify({error:'TEMPORARY_FAILURE'}),{status:503})
  const payload=command.payload as {projectId:string}
  return new Response(JSON.stringify({state:'applied',projectId:payload.projectId,reviewStatus:'not_reviewed'}))
 }
 expect(await screen.findByText(/não aprova integração/)).toBeTruthy()
 expect(screen.queryByText(/super-secret-proof/)).toBeNull()
 expect(screen.queryByText(/secret\.invalid/)).toBeNull()
 fireEvent.change(screen.getByLabelText('Snapshot exportado'),{target:{value:operation}})
 fireEvent.change(screen.getByLabelText('Arquivo Git bundle local'),{target:{files:[new File([bytes],'source.bundle')]}})
 fireEvent.click(screen.getByRole('button',{name:'Materializar origem SSH'}))
 expect(await screen.findByText('TEMPORARY_FAILURE')).toBeTruthy()
 expect(screen.queryByText('Descartar rascunho recusado')).toBeNull()
 const stored=sessionStorage.getItem(remoteSourceStorageKey('fixture',installation))??''
 expect(stored).not.toContain(marker)
 expect(stored).not.toContain('bundle')
 expect(JSON.parse(stored).uncertain).toBe(true)
 const intentId=JSON.parse(stored).intentId as string
 const signed=vi.mocked(signControl).mock.calls.length
 expect((screen.getByRole('button',{name:'Materializar origem SSH'}) as HTMLButtonElement).disabled).toBe(true)
 fireEvent.submit(screen.getByLabelText('Snapshot exportado').closest('form')!)
 expect(await screen.findByText('SNAPSHOT_REQUIRED')).toBeTruthy()
 expect(vi.mocked(signControl).mock.calls.length).toBe(signed)
 expect(panel.posts).toHaveLength(1)
 expect(JSON.parse(sessionStorage.getItem(remoteSourceStorageKey('fixture',installation))??'{}').intentId).toBe(intentId)
 fireEvent.change(screen.getByLabelText('Snapshot exportado'),{target:{value:operation}})
 fireEvent.change(screen.getByLabelText('Arquivo Git bundle local'),{target:{files:[new File(['different'],'other.bundle')]}})
 fireEvent.click(screen.getByRole('button',{name:'Materializar origem SSH'}))
 expect(await screen.findByText('BUNDLE_SHA256_MISMATCH')).toBeTruthy()
 expect(vi.mocked(signControl).mock.calls.length).toBe(signed)
 expect(panel.posts).toHaveLength(1)
 expect(JSON.parse(sessionStorage.getItem(remoteSourceStorageKey('fixture',installation))??'{}').intentId).toBe(intentId)
 expect(screen.queryByText('Descartar rascunho recusado')).toBeNull()
 fireEvent.change(screen.getByLabelText('Arquivo Git bundle local'),{target:{files:[new File([bytes],'source.bundle')]}})
 fireEvent.click(screen.getByRole('button',{name:'Materializar origem SSH'}))
 expect(await screen.findByText(/Origem SSH materializada/)).toBeTruthy()
 expect(panel.posts).toHaveLength(2)
 expect(panel.posts[0]!.url).toBe('/api/v1/ac/project-admin/remote-source')
 expect(panel.posts[0]!.command.action).toBe('project.materializeRemoteSource')
 expect(panel.posts[0]!.command.intentId).toBe(panel.posts[1]!.command.intentId)
 expect(panel.posts[0]!.command.deliveryAttemptId).not.toBe(panel.posts[1]!.command.deliveryAttemptId)
 const first=panel.posts[0]!.command.payload as {projectId:string;commit:string;tree:string}
 expect(first).toMatchObject({projectId:project,contextId:context,operationId:operation,hostId:host,commit,tree})
 await waitFor(()=>expect(sessionStorage.length).toBe(0))
 panel.client.clear()
})

it('requires the same snapshot and file after an uncertain reload and does not discard it',async()=>{
 const bytes=new TextEncoder().encode(marker)
 const sha=await sha256(bytes)
 const selected=candidate(sha)
 const otherBytes=new TextEncoder().encode('other-snapshot')
 const otherOperation='00000000-0000-4000-8000-000000000015'
 const other={...candidate(await sha256(otherBytes)),operationId:otherOperation,label:'Outra origem'}
 const key=remoteSourceStorageKey('fixture',installation)
 const intentId='00000000-0000-4000-8000-000000000099'
 sessionStorage.setItem(key,JSON.stringify({semantic:remoteSourceSemantic(selected),intentId,uncertain:true}))
 const panel=renderPanel(view({remoteSourceCandidates:[selected,other]}))
 panel.fetchMock.next=command=>new Response(JSON.stringify({state:'applied',projectId:(command.payload as {projectId:string}).projectId,reviewStatus:'not_reviewed'}))
 expect(await screen.findByText(/Envio anterior incerto/)).toBeTruthy()
 fireEvent.change(screen.getByLabelText('Snapshot exportado'),{target:{value:operation}})
 fireEvent.change(screen.getByLabelText('Arquivo Git bundle local'),{target:{files:[new File(['different'],'other.bundle')]}})
 fireEvent.click(screen.getByRole('button',{name:'Materializar origem SSH'}))
 expect(await screen.findByText('BUNDLE_SHA256_MISMATCH')).toBeTruthy()
 expect(vi.mocked(signControl)).not.toHaveBeenCalled()
 expect(panel.posts).toHaveLength(0)
 expect(JSON.parse(sessionStorage.getItem(key)??'{}').intentId).toBe(intentId)
 expect(screen.queryByText('Descartar rascunho recusado')).toBeNull()
 fireEvent.change(screen.getByLabelText('Snapshot exportado'),{target:{value:otherOperation}})
 fireEvent.change(screen.getByLabelText('Arquivo Git bundle local'),{target:{files:[new File([otherBytes],'other.bundle')]}})
 fireEvent.click(screen.getByRole('button',{name:'Materializar origem SSH'}))
 expect(await screen.findByText('PENDING_COMMAND_DIFFERENT')).toBeTruthy()
 expect(panel.posts).toHaveLength(0)
 expect(vi.mocked(signControl)).not.toHaveBeenCalled()
 expect(JSON.parse(sessionStorage.getItem(key)??'{}').intentId).toBe(intentId)
 expect(sessionStorage.getItem(key)??'').not.toContain(marker)
 fireEvent.change(screen.getByLabelText('Snapshot exportado'),{target:{value:operation}})
 fireEvent.change(screen.getByLabelText('Arquivo Git bundle local'),{target:{files:[new File([bytes],'source.bundle')]}})
 fireEvent.click(screen.getByRole('button',{name:'Materializar origem SSH'}))
 expect(await screen.findByText(/Origem SSH materializada/)).toBeTruthy()
 expect(panel.posts[0]!.command.intentId).toBe(intentId)
 expect(panel.posts[0]!.command.deliveryAttemptId).not.toBe(intentId)
 await waitFor(()=>expect(sessionStorage.length).toBe(0))
 panel.client.clear()
})

it('resumes the same intent after a lost applied response and an empty candidate list',async()=>{
 const bytes=new TextEncoder().encode(marker)
 const sha=await sha256(bytes)
 const selected=candidate(sha)
 const key=remoteSourceStorageKey('fixture',installation)
 const panel=renderPanel(view({remoteSourceCandidates:[selected]}))
 panel.fetchMock.next=()=>Promise.reject(new TypeError('Failed to fetch'))
 fireEvent.change(await screen.findByLabelText('Snapshot exportado'),{target:{value:operation}})
 fireEvent.change(screen.getByLabelText('Arquivo Git bundle local'),{target:{files:[new File([bytes],'source.bundle')]}})
 fireEvent.click(screen.getByRole('button',{name:'Materializar origem SSH'}))
 expect(await screen.findByText('Failed to fetch')).toBeTruthy()
 const stored=JSON.parse(sessionStorage.getItem(key)??'{}') as {intentId:string;uncertain:boolean}
 expect(stored.uncertain).toBe(true)
 expect(sessionStorage.getItem(key)??'').not.toContain(marker)
 expect(sessionStorage.getItem(key)??'').not.toContain('bundle')
 const intentId=stored.intentId
 const firstDelivery=panel.posts[0]!.command.deliveryAttemptId
 cleanup()
 const again=renderPanel(view({remoteSourceCandidates:[]}))
 again.fetchMock.next=command=>new Response(JSON.stringify({state:'applied',projectId:(command.payload as {projectId:string}).projectId,reviewStatus:'not_reviewed'}))
 expect(await screen.findByText(/O snapshot saiu da lista/)).toBeTruthy()
 expect(screen.getByText(new RegExp(`Snapshot pendente; projeto ${project}; commit ${commit}; tree ${tree}; SHA-256 ${sha}; exportado; não revisado`))).toBeTruthy()
 expect(screen.queryByLabelText('Snapshot exportado')).toBeNull()
 expect(screen.queryByText('Descartar rascunho recusado')).toBeNull()
 expect(screen.queryByText(/Nenhuma exportação Git concluída deste projeto/)).toBeNull()
 expect(screen.queryByText(/onboarding/i)).toBeNull()
 const signed=vi.mocked(signControl).mock.calls.length
 fireEvent.change(screen.getByLabelText('Arquivo Git bundle local'),{target:{files:[new File(['different'],'other.bundle')]}})
 fireEvent.click(screen.getByRole('button',{name:'Materializar origem SSH'}))
 expect(await screen.findByText('BUNDLE_SHA256_MISMATCH')).toBeTruthy()
 expect(vi.mocked(signControl).mock.calls.length).toBe(signed)
 expect(again.posts).toHaveLength(0)
 expect(JSON.parse(sessionStorage.getItem(key)??'{}').intentId).toBe(intentId)
 expect(sessionStorage.getItem(key)??'').not.toContain(marker)
 fireEvent.change(screen.getByLabelText('Arquivo Git bundle local'),{target:{files:[new File([bytes],'source.bundle')]}})
 fireEvent.click(screen.getByRole('button',{name:'Materializar origem SSH'}))
 expect(await screen.findByText(/Origem SSH materializada/)).toBeTruthy()
 expect(again.posts).toHaveLength(1)
 expect(again.posts[0]!.url).toBe('/api/v1/ac/project-admin/remote-source')
 expect(again.posts[0]!.command.intentId).toBe(intentId)
 expect(again.posts[0]!.command.deliveryAttemptId).not.toBe(firstDelivery)
 expect(again.posts[0]!.command.payload).toMatchObject({projectId:project,contextId:context,operationId:operation,hostId:host,commit,tree})
 await waitFor(()=>expect(sessionStorage.length).toBe(0))
 again.client.clear()
})

it('lets a signature refusal before sending discard a draft and keeps a sent refusal',async()=>{
 const bytes=new TextEncoder().encode(marker)
 const sha=await sha256(bytes)
 vi.mocked(signControl).mockRejectedValueOnce(Error('DEVICE_KEY_UNAVAILABLE'))
 const panel=renderPanel(view({remoteSourceCandidates:[candidate(sha)]}))
 fireEvent.change(await screen.findByLabelText('Snapshot exportado'),{target:{value:operation}})
 fireEvent.change(screen.getByLabelText('Arquivo Git bundle local'),{target:{files:[new File([bytes],'source.bundle')]}})
 fireEvent.click(screen.getByRole('button',{name:'Materializar origem SSH'}))
 fireEvent.click(await screen.findByText('Descartar rascunho recusado'))
 expect(panel.posts).toHaveLength(0)
 expect(sessionStorage.length).toBe(0)
 panel.fetchMock.next=()=>new Response(JSON.stringify({error:'REMOTE_SOURCE_AUTHORIZATION_INVALID'}),{status:403})
 fireEvent.click(screen.getByRole('button',{name:'Materializar origem SSH'}))
 expect(await screen.findByText('REMOTE_SOURCE_AUTHORIZATION_INVALID')).toBeTruthy()
 expect(screen.queryByText('Descartar rascunho recusado')).toBeNull()
 expect(sessionStorage.length).toBe(1)
 expect(sessionStorage.getItem(remoteSourceStorageKey('fixture',installation))??'').not.toContain(marker)
 panel.client.clear()
})
