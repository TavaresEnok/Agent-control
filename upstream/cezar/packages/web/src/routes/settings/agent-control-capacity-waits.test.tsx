import {cleanup,render,screen,waitFor} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {afterEach,expect,it,vi} from 'vitest'
import {AgentControlSection} from './agent-control-section'
import {AgentControlCapacityWaits,capacityWaitSchema,type CapacityWait} from './agent-control-capacity-waits'

vi.mock('./agent-control-diagnostics',()=>({AgentControlDiagnostics:()=> <h2>Fixture diagnostics</h2>}))
vi.mock('./agent-control-manager-plans',()=>({AgentControlManagerPlans:()=> <h2>Fixture plans</h2>}))
vi.mock('./agent-control-operator',()=>({operatorIdentity:()=>new Promise(()=>{}),signControl:vi.fn()}))
vi.mock('./agent-control-project-admin',()=>({AgentControlProjectAdmin:()=>null}))
vi.mock('./agent-control-import-preview',()=>({AgentControlImportPreview:()=>null}))

const context='00000000-0000-4000-8000-000000000001'
const installation='00000000-0000-4000-8000-000000000002'
const accountId='00000000-0000-4000-8000-0000000000aa'
const known='00000000-0000-4000-8000-000000000010'
const ids=[
 '11111111-1111-4111-8111-111111111111',
 '22222222-2222-4222-8222-222222222222',
 '33333333-3333-4333-8333-333333333333',
 '44444444-4444-4444-8444-444444444444',
 '55555555-5555-4555-8555-555555555555',
 '66666666-6666-4666-8666-666666666666',
 '77777777-7777-4777-8777-777777777777',
 '88888888-8888-4888-8888-888888888888',
]
const reasons=['profile_missing','access_removed','account_disabled','profile_disabled','not_synthetic','ineligible','quota_exhausted','quota_unknown'] as const
const refusal='00000000-0000-4000-8000-000000000101'
const legacy='00000000-0000-4000-8000-000000000102'
const invalid='00000000-0000-4000-8000-000000000103'
const busy='00000000-0000-4000-8000-000000000104'
const queued='00000000-0000-4000-8000-000000000105'
const localBusy='00000000-0000-4000-8000-000000000106'
const localPlain='00000000-0000-4000-8000-000000000107'

const exclusions=reasons.map((reason,index)=>({profileId:index===3?known:ids[index]!,reason}))
const waits:unknown[]=[
 {attempt_id:refusal,role:'programmer',reason:'NO_ELIGIBLE_CAPACITY',resource_kind:'model',desired_profile:null,exclusions},
 {attempt_id:legacy,role:'reviewer',reason:'NO_ELIGIBLE_CAPACITY',resource_kind:'model',desired_profile:null},
 {attempt_id:invalid,role:'programmer',reason:'NO_ELIGIBLE_CAPACITY',resource_kind:'model',desired_profile:null,exclusions:[{profileId:known,reason:'quota_exhausted',note:'motivo-falso'}]},
 {attempt_id:busy,role:'programmer',reason:'CAPACITY_BUSY',resource_kind:'model',desired_profile:known,exclusions:[{profileId:known,reason:'quota_exhausted'}]},
 {attempt_id:queued,role:'programmer',reason:'CAPACITY_QUEUED',resource_kind:'model',desired_profile:known},
 {attempt_id:localBusy,role:'programmer',reason:'CAPACITY_BUSY',resource_kind:'local_compositor',desired_profile:null,exclusions:[{profileId:known,reason:'ineligible'}]},
 {attempt_id:localPlain,role:'programmer',reason:null,resource_kind:'local_compositor',desired_profile:null},
]

const profiles=[{id:known,account_id:accountId,model:'worker',effort:'medium',role:'programmer',enabled:false,revision:1,can_manage:false}]
const accounts=[{id:accountId,label:'Conta visível',provider:'synthetic',mode:'synthetic',quota_status:'unknown',eligibility:'documented_supported',enabled:true,revision:1,can_manage:false},{id:installation,label:'Rótulo alheio',provider:'synthetic',mode:'synthetic',quota_status:'unknown',eligibility:'documented_supported',enabled:true,revision:1,can_manage:false}]

function resources(){
 return {installationId:installation,principalId:'fixture',verifierDigest:'a'.repeat(64),contextId:context,assignedPolicyRevision:null,
  approvals:[],canApproveIntegration:false,canAuthorizeRemoteSource:false,remoteSourceHosts:[],remoteSourceAuthorizations:[],remoteOperations:[],operatorDeviceIds:[],capacity:null,canConfigureCapacity:false,
  administrative:{policies:[],operations:[],managerProfileIds:[],recentOperations:[]},providerEligibility:{assessments:[],truncated:false},providerBindings:[],providerAdapters:[],
  accounts,profiles,catalog:[],policies:[],qualityPolicies:[],templates:[],activeTemplateRevision:null,plans:[],waits,grants:[]}
}

afterEach(()=>{cleanup();vi.unstubAllGlobals()})

it('renders ordered profile reasons and keeps queue, legacy and invalid waits distinct',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>{
  if(path.endsWith('/resources'))return new Response(JSON.stringify(resources()))
  if(path.endsWith('/manager'))return new Response(JSON.stringify({contextId:context,state:'stopped',executionEnabled:false,semanticManagerEnabled:false}))
  if(path.endsWith('/contexts'))return new Response(JSON.stringify({contexts:[{id:context,paused:false,pause_revision:0,draining:false,drain_revision:0,policy_revision:1}]}))
  if(path.endsWith('/operator/identity'))return new Response(JSON.stringify({principalId:'fixture',projectId:installation,installationId:installation,operatorDeviceIds:[]}))
  if(path.endsWith('/usage'))return new Response(JSON.stringify({subscriptionBalance:'unknown',overlappingCounters:true,attempts:[]}))
  return new Response('{}',{status:404})
 }))
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}})
 render(<QueryClientProvider client={client}><AgentControlSection/></QueryClientProvider>)
 await screen.findByText('Conta visível · worker · medium · Perfil desativado')
 const list=document.querySelector('[data-attempt="'+refusal+'"] [data-slot="capacity-wait-exclusions"]')
 expect(list).not.toBeNull()
 expect([...(list?.querySelectorAll('[data-reason]')??[])].map(item=>item.getAttribute('data-reason'))).toEqual([...reasons])
 const refusalText=list?.textContent??''
 expect(refusalText).toContain('Perfil indisponível neste projeto (11111111) · Perfil removido')
 expect(refusalText).toContain('Inelegível para o plano ou modo')
 expect(refusalText).toContain('Cota esgotada')
 expect(refusalText).toContain('Cota desconhecida')
 expect(refusalText).not.toContain('Rótulo alheio')
 expect(refusalText).not.toContain('motivo-falso')
 expect(screen.queryByText(/motivo-falso/)).toBeNull()
 const legacyRow=document.querySelector('[data-attempt="'+legacy+'"]')
 const invalidRow=document.querySelector('[data-attempt="'+invalid+'"]')
 const busyRow=document.querySelector('[data-attempt="'+busy+'"]')
 const queuedRow=document.querySelector('[data-attempt="'+queued+'"]')
 const localBusyRow=document.querySelector('[data-attempt="'+localBusy+'"]')
 const localPlainRow=document.querySelector('[data-attempt="'+localPlain+'"]')
 expect(legacyRow?.textContent).toContain('reviewer · Nenhum perfil elegível disponível')
 expect(legacyRow?.querySelector('[data-slot="capacity-wait-exclusions"]')).toBeNull()
 expect(invalidRow?.textContent).toContain('programmer · Nenhum perfil elegível disponível')
 expect(invalidRow?.querySelector('[data-slot="capacity-wait-exclusions"]')).toBeNull()
 expect(invalidRow?.textContent).not.toContain('Cota esgotada')
 expect(busyRow?.textContent).toContain('programmer · Aguardando vaga')
 expect(busyRow?.textContent).not.toContain('Nenhum perfil elegível')
 expect(busyRow?.querySelector('[data-slot="capacity-wait-exclusions"]')).toBeNull()
 expect(queuedRow?.textContent).toContain('programmer · Aguardando sua vez')
 expect(queuedRow?.querySelector('[data-slot="capacity-wait-exclusions"]')).toBeNull()
 expect(localBusyRow?.textContent).toContain('Composição determinística local · Aguardando vaga')
 expect(localBusyRow?.querySelector('[data-slot="capacity-wait-exclusions"]')).toBeNull()
 expect(localPlainRow?.textContent).toContain('Composição determinística local · Aguardando capacidade local')
 expect(screen.queryByRole('alert')).toBeNull()
 await waitFor(()=>expect(screen.getByText('Fixture diagnostics')).toBeTruthy())
 client.clear()
})

it('parses a wait that omits exclusions and drops an invalid list',()=>{
 const parsed=waits.map(row=>capacityWaitSchema.parse(row)) as CapacityWait[]
 expect(parsed[0]?.exclusions).toHaveLength(8)
 expect(parsed[1]?.exclusions).toBeUndefined()
 expect(parsed[2]?.exclusions).toBeUndefined()
 const removed=capacityWaitSchema.parse({attempt_id:legacy,role:'programmer',reason:'CAPACITY_BUSY',resource_kind:'model',desired_profile:null,exclusions:'quota_exhausted'})
 expect(removed.exclusions).toBeUndefined()
 expect(removed.reason).toBe('CAPACITY_BUSY')
 render(<AgentControlCapacityWaits waits={[parsed[5]!,parsed[6]!]} profiles={profiles} accounts={accounts}/>)
 expect(screen.getByText('Composição determinística local · Aguardando vaga')).toBeTruthy()
 expect(screen.getByText('Composição determinística local · Aguardando capacidade local')).toBeTruthy()
 expect(document.querySelector('[data-slot="capacity-wait-exclusions"]')).toBeNull()
})
