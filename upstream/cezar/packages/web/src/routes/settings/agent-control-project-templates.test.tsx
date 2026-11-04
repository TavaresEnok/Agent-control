import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {afterEach,expect,it,vi} from 'vitest'
import {AgentControlSection} from './agent-control-section'
import {projectTemplateDigest} from './agent-control-project-templates'
vi.mock('./agent-control-diagnostics',()=>({AgentControlDiagnostics:()=> <h2>Fixture diagnostics</h2>}))
vi.mock('./agent-control-manager-plans',()=>({AgentControlManagerPlans:()=> <h2>Fixture plans</h2>}))
vi.mock('./agent-control-operator',()=>({operatorIdentity:async()=>({deviceId:'00000000-0000-4000-8000-000000000002',publicKey:'fixture'}),signControl:vi.fn(async()=>'fixture-proof')}))
vi.mock('./agent-control-project-admin',()=>({AgentControlProjectAdmin:()=>null}))
vi.mock('./agent-control-import-preview',()=>({AgentControlImportPreview:()=>null}))
const context='00000000-0000-4000-8000-000000000001',installation='00000000-0000-4000-8000-000000000002'
const templateId='00000000-0000-4000-8000-000000000010'
const digest='ab'.repeat(32)
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
function resources(projectTemplates?:unknown,canManage=true){
 const body:Record<string,unknown>={installationId:installation,principalId:'fixture',verifierDigest:'a'.repeat(64),contextId:context,assignedPolicyRevision:null,
  approvals:[],canApproveIntegration:false,canAuthorizeRemoteSource:false,remoteSourceHosts:[],remoteSourceAuthorizations:[],remoteOperations:[],operatorDeviceIds:[],capacity:null,canConfigureCapacity:false,administrative:{policies:[],operations:[],managerProfileIds:[],recentOperations:[]},providerEligibility:{assessments:[],truncated:false},providerBindings:[],providerAdapters:[],accounts:[],profiles:[],catalog:[],policies:[],qualityPolicies:[],templates:[],activeTemplateRevision:null,plans:[],waits:[],grants:[]}
 if(projectTemplates!==undefined){body.projectTemplates=projectTemplates;body.projectTemplatesTruncated=false;body.canManageProjectTemplates=canManage}
 return body
}
function stubWidth(width:number){
 vi.stubGlobal('matchMedia',(query:string)=>({matches:width<=Number(/max-width:\s*(\d+)px/.exec(query)?.[1]??-1),media:query,addEventListener(){},removeEventListener(){}}))
}
function renderSection(options:{projectTemplates?:unknown;canManage?:boolean;controlStatus?:number;controlError?:string;qaWaiver?:unknown}={}){
 const posts:Array<Record<string,unknown>>=[]
 let resourceCalls=0
 vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>{
  if(path.endsWith('/resources')){resourceCalls++;return new Response(JSON.stringify({...resources(options.projectTemplates,options.canManage??true),...(options.qaWaiver?{qaWaiver:options.qaWaiver}:{})}))}
  if(path.endsWith('/manager'))return new Response(JSON.stringify({contextId:context,state:'stopped',executionEnabled:false,semanticManagerEnabled:false}))
  if(path.endsWith('/contexts'))return new Response(JSON.stringify({contexts:[{id:context,paused:false,pause_revision:0,draining:false,drain_revision:0,policy_revision:1}]}))
  if(path.endsWith('/operator/identity'))return new Response(JSON.stringify({principalId:'fixture',projectId:installation,installationId:installation,operatorDeviceIds:[]}))
  if(path.endsWith('/usage'))return new Response(JSON.stringify({subscriptionBalance:'unknown',overlappingCounters:true,attempts:[]}))
  if(path.endsWith('/control')){
   const body=JSON.parse(String(init?.body)) as Record<string,unknown>
   posts.push(body)
   if(options.controlStatus)return new Response(JSON.stringify({error:options.controlError}),{status:options.controlStatus})
   return new Response(JSON.stringify({intentId:body.intentId,state:'applied',result:body.action==='qa.waiver.authorize'?{authorizationId:templateId}:{revision:1}}))
  }
  return new Response('{}',{status:404})
 }))
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})
 render(<QueryClientProvider client={client}><AgentControlSection/></QueryClientProvider>)
 return {posts,resourceCalls:()=>resourceCalls,client}
}
const catalog=[{templateId,revision:1,headRevision:2,name:'Fluxo de laboratório',digest,snapshot:{workflow:'baseline-synthetic-v1'}},{templateId,revision:2,headRevision:2,name:'Fluxo de laboratório',digest:'cd'.repeat(32),snapshot:{workflow:'engineering-synthetic-v1',qualityRevision:1,targetRef:'refs/heads/protected'}}]

it('authorizes the displayed project-wide task binding through signed control',async()=>{
 const qaWaiver={canAuthorize:true,active:{templateId,templateRevision:2,templateName:'Fluxo de laboratório',templateDigest:digest,policyRevision:4,policyDigest:'cd'.repeat(32)},authorizations:[],truncated:false}
 const {posts,client}=renderSection({qaWaiver})
 await screen.findByText(/Alcance: projeto inteiro/)
 fireEvent.change(screen.getByLabelText('Identificador da tarefa para dispensa de QA'),{target:{value:'docs'}})
 fireEvent.click(screen.getByRole('button',{name:'Autorizar dispensa de QA para esta tarefa'}))
 await waitFor(()=>expect(posts).toHaveLength(1))
 expect(posts[0]).toMatchObject({action:'qa.waiver.authorize',contextId:context,payload:{policyRevision:4,templateId,templateRevision:2,taskId:'docs',riskRule:'explicit-low'}})
 expect(await screen.findByText(`Autorização registrada: ${templateId}`)).toBeTruthy()
 client.clear()
})

it('does not allow a viewer or an incomplete authorization list to submit',async()=>{
 const active={templateId,templateRevision:2,templateName:'Fluxo',templateDigest:digest,policyRevision:4,policyDigest:'cd'.repeat(32)}
 const viewer=renderSection({qaWaiver:{canAuthorize:false,active,authorizations:[],truncated:false}})
 await screen.findByText('Somente o titular do projeto pode autorizar.')
 expect(screen.queryByRole('button',{name:'Autorizar dispensa de QA para esta tarefa'})).toBeNull()
 viewer.client.clear();cleanup()
 const truncated=renderSection({qaWaiver:{canAuthorize:true,active,authorizations:[],truncated:true}})
 await screen.findByText(/lista de autorizações está incompleta/)
 fireEvent.change(screen.getByLabelText('Identificador da tarefa para dispensa de QA'),{target:{value:'docs'}})
 expect((screen.getByRole('button',{name:'Autorizar dispensa de QA para esta tarefa'}) as HTMLButtonElement).disabled).toBe(true)
 expect(truncated.posts).toHaveLength(0)
 truncated.client.clear()
})

it('publishes the current flow and applies the selected revision through the signed control mutation',async()=>{
 const {posts,client}=renderSection({projectTemplates:catalog})
 await screen.findByText('Fluxo da conversa')
 expect(screen.getByText('revisão 1 de 2',{exact:false})).toBeTruthy()
 fireEvent.change(screen.getByLabelText('Nome do template do projeto'),{target:{value:'Fluxo de laboratório'}})
 fireEvent.click(screen.getByRole('button',{name:'Salvar fluxo atual como template do projeto'}))
 await waitFor(()=>expect(posts).toHaveLength(1))
 const published=posts[0]!
 expect(published.action).toBe('project-template.publish')
 const payload=published.payload as {name:string;expectedRevision:number;template:Record<string,unknown>;digest:string;templateId:string}
 expect(payload.name).toBe('Fluxo de laboratório')
 expect(payload.expectedRevision).toBe(0)
 expect(payload.template).toEqual({workflow:'baseline-synthetic-v1'})
 expect(payload.digest).toBe(await projectTemplateDigest({workflow:'baseline-synthetic-v1'}))
 expect(payload.template).not.toHaveProperty('account')
 expect(published).not.toHaveProperty('projectId')
 fireEvent.click(screen.getByRole('button',{name:'Reutilizar revisão 1'}))
 await waitFor(()=>expect(posts).toHaveLength(2))
 expect(posts[1]).toMatchObject({action:'project-template.apply',payload:{templateId,revision:1,expectedRevision:2,expectedContextRevision:0}})
 expect(JSON.stringify(posts)).not.toMatch(/credential|transcript|password|token/)
 client.clear()
})

it('keeps a legacy resources payload usable and shows conflict and refusal without a new approval flow',async()=>{
 const legacy=renderSection()
 await screen.findByText('Fluxo da conversa')
 expect(screen.getByText('O catálogo de templates do projeto não veio nesta resposta.')).toBeTruthy()
 expect(screen.queryByRole('button',{name:'Salvar fluxo atual como template do projeto'})).toBeNull()
 expect(screen.queryByText('Aprovar template')).toBeNull()
 legacy.client.clear();cleanup()
 const conflict=renderSection({projectTemplates:[],controlStatus:409,controlError:'PROJECT_TEMPLATE_REVISION_CONFLICT'})
 await screen.findByRole('button',{name:'Salvar fluxo atual como template do projeto'})
 const before=conflict.resourceCalls()
 fireEvent.change(screen.getByLabelText('Nome do template do projeto'),{target:{value:'Fluxo de laboratório'}})
 fireEvent.click(screen.getByRole('button',{name:'Salvar fluxo atual como template do projeto'}))
 await screen.findByText('A revisão mudou. Recarregue a conversa e confira a revisão antes de repetir.')
 await waitFor(()=>expect(conflict.resourceCalls()).toBeGreaterThan(before))
 conflict.client.clear();cleanup()
 const refused=renderSection({projectTemplates:catalog,canManage:false})
 await screen.findByText('Somente o titular do projeto publica ou reutiliza templates.')
 expect((screen.getByRole('button',{name:'Reutilizar revisão 1'}) as HTMLButtonElement).disabled).toBe(true)
 fireEvent.click(screen.getByRole('button',{name:'Reutilizar revisão 1'}))
 expect(refused.posts).toHaveLength(0)
 refused.client.clear();cleanup()
 const invalid=renderSection({projectTemplates:[],controlStatus:409,controlError:'PROJECT_TEMPLATE_DIGEST_MISMATCH'})
 await screen.findByRole('button',{name:'Salvar fluxo atual como template do projeto'})
 fireEvent.change(screen.getByLabelText('Nome do template do projeto'),{target:{value:'Fluxo de laboratório'}})
 fireEvent.click(screen.getByRole('button',{name:'Salvar fluxo atual como template do projeto'}))
 expect(await screen.findAllByText('PROJECT_TEMPLATE_DIGEST_MISMATCH')).toHaveLength(2)
 invalid.client.clear()
})

for(const width of [360,390])it(`keeps the project template form inside ${width}px`,async()=>{
 stubWidth(width)
 const {client}=renderSection({projectTemplates:catalog})
 await screen.findByLabelText('Nome do template do projeto')
 expect(document.querySelector('[data-viewport="narrow"]')).toBeTruthy()
 const field=screen.getByLabelText('Nome do template do projeto') as HTMLInputElement
 expect(field.className).toContain('min-w-0')
 expect(field.className).toContain('max-w-full')
 const save=screen.getByRole('button',{name:'Salvar fluxo atual como template do projeto'}) as HTMLButtonElement
 expect(save.className).toContain('min-h-11')
 expect(save.className).toContain('max-w-full')
 expect(screen.getByText(digest).className).toContain('break-all')
 client.clear()
})
