import {cleanup,render,screen,waitFor} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {afterEach,expect,it,vi} from 'vitest'
import {AgentControlSection} from './agent-control-section'
const identityGate=vi.hoisted(()=>({resolve:undefined as undefined|((value:{deviceId:string;publicKey:string})=>void)}))
vi.mock('./agent-control-diagnostics',()=>({AgentControlDiagnostics:()=> <h2>Fixture diagnostics</h2>}))
vi.mock('./agent-control-manager-plans',()=>({AgentControlManagerPlans:()=> <h2>Fixture plans</h2>}))
vi.mock('./agent-control-operator',()=>({operatorIdentity:()=>new Promise(resolve=>{identityGate.resolve=resolve}),signControl:vi.fn()}))
vi.mock('./agent-control-project-admin',()=>({AgentControlProjectAdmin:()=>null}))
vi.mock('./agent-control-import-preview',()=>({AgentControlImportPreview:()=>null}))
const context='00000000-0000-4000-8000-000000000001',installation='00000000-0000-4000-8000-000000000002'
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
it('does not duplicate diagnostics when resources and plan controls arrive after context',async()=>{
 let resolveResources!:(value:Response)=>void
 const pending=new Promise<Response>(resolve=>{resolveResources=resolve})
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>{
  if(path.endsWith('/resources'))return pending
  if(path.endsWith('/contexts'))return new Response(JSON.stringify({contexts:[{id:context,paused:false,pause_revision:0,draining:false,drain_revision:0,policy_revision:1}]}))
  if(path.endsWith('/operator/identity'))return new Response(JSON.stringify({principalId:'fixture',projectId:installation,installationId:installation,operatorDeviceIds:[]}))
  if(path.endsWith('/usage'))return new Response(JSON.stringify({subscriptionBalance:'unknown',overlappingCounters:true,attempts:[
   {grant_id:context,role:'programmer',state:'uncertain',resource_kind:'local_compositor',account_id:null,profile_id:null,model:null,effort:null,seq:null,counters:null,observed_at:null},
   {grant_id:installation,role:'reviewer',state:'running',resource_kind:'model',account_id:context,profile_id:installation,model:'fixture-model',effort:'medium',seq:null,counters:null,observed_at:null}]}))
  return new Response('{}')
 }))
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}})
 render(<QueryClientProvider client={client}><AgentControlSection/></QueryClientProvider>)
 await screen.findByText('Fixture diagnostics');expect(screen.queryByText('Fixture plans')).toBeNull()
 resolveResources(new Response(JSON.stringify({installationId:installation,principalId:'fixture',verifierDigest:'a'.repeat(64),contextId:context,assignedPolicyRevision:null,
  approvals:[],canApproveIntegration:false,canAuthorizeRemoteSource:false,remoteSourceHosts:[],remoteSourceAuthorizations:[],remoteOperations:[],operatorDeviceIds:[],capacity:null,canConfigureCapacity:false,providerBindings:[],providerAdapters:[],accounts:[],profiles:[],catalog:[],policies:[],qualityPolicies:[],templates:[],activeTemplateRevision:null,plans:[],waits:[],grants:[
   {id:context,role:'programmer',state:'uncertain',resource_kind:'local_compositor',account_id:null,profile_id:null,emergency:false},
   {id:installation,role:'reviewer',state:'running',resource_kind:'model',account_id:context,profile_id:installation,emergency:false}]})))
 await screen.findByText('Fixture plans')
 await waitFor(()=>expect(identityGate.resolve).toBeDefined())
 identityGate.resolve!({deviceId:installation,publicKey:'fixture'})
 await screen.findByText('Dispositivo de administração')
 await waitFor(()=>expect(screen.getAllByText('Fixture diagnostics')).toHaveLength(1))
 expect(screen.getAllByText(/Composição determinística local/)).toHaveLength(2)
 expect(screen.getByText('Contadores de modelo não se aplicam.')).toBeTruthy()
 expect(screen.getByText('fixture-model · medium')).toBeTruthy()
 client.clear()
})
