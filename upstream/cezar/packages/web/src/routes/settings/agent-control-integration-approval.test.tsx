import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {QueryClient,QueryClientProvider,useMutation} from '@tanstack/react-query'
import {afterEach,expect,it,vi} from 'vitest'
import {z} from 'zod'
import {AgentControlIntegrationApproval} from './agent-control-integration-approval'
import {agentControlFetch,agentControlPendingKey} from './agent-control-fetch'
import {signControl} from './agent-control-operator'
vi.mock('./agent-control-operator',()=>({signControl:vi.fn(async()=>'fixture-proof'),operatorIdentity:vi.fn()}))
const artifact={id:'00000000-0000-4000-8000-000000000001',commit_id:'a'.repeat(40),tree_id:'b'.repeat(40),base_id:'c'.repeat(40),identity_digest:'d'.repeat(64),
 policy_revision:2,target_ref:'refs/heads/protected',approved:false,canceled:false}
const secret='super-secret-token'
const contextId='fixture'
afterEach(()=>{cleanup();sessionStorage.clear();vi.unstubAllGlobals();vi.restoreAllMocks()})
function stubWidth(width:number){
 vi.stubGlobal('matchMedia',(query:string)=>({matches:width<=Number(/max-width:\s*(\d+)px/.exec(query)?.[1]??-1),media:query,addEventListener(){},removeEventListener(){}}))
}
function diffResponse(truncated:boolean){
 return new Response(JSON.stringify({artifactId:artifact.id,artifactDigest:artifact.identity_digest,commit:artifact.commit_id,tree:artifact.tree_id,base:artifact.base_id,
  diff:'+fixture',truncated,diffSha256:'e'.repeat(64),token:secret}))
}
function renderApproval(onApprove:()=>void|Promise<unknown>){
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})
 const view=render(<QueryClientProvider client={client}><AgentControlIntegrationApproval contextId={contextId} artifact={artifact} canApprove busy={false} onApprove={onApprove}/></QueryClientProvider>)
 return {client,...view}
}
function SettingsTransport({record}:{record:unknown[]}){
 const mutate=useMutation({mutationFn:async(command:{action:string;payload:unknown})=>{
  const storageKey=agentControlPendingKey(contextId)
  const semantic=JSON.stringify(command)
  const stored=z.object({semantic:z.string(),intentId:z.string().uuid()}).safeParse(JSON.parse(sessionStorage.getItem(storageKey)||'null'))
  const intentId=stored.success&&stored.data.semantic===semantic?stored.data.intentId:crypto.randomUUID()
  sessionStorage.setItem(storageKey,JSON.stringify({semantic,intentId}))
  const body={schemaVersion:1,intentId,deliveryAttemptId:crypto.randomUUID(),contextId,...command}
  const proof=await signControl('fixture-principal',body,'fixture-installation')
  const response=await agentControlFetch('/api/v1/ac/control',{method:'POST',headers:{'content-type':'application/json','x-ac-operator-proof':proof},body:JSON.stringify(body)})
  const value:unknown=await response.json()
  if(!response.ok){const parsed=z.object({error:z.string()}).safeParse(value);throw Error(parsed.success?parsed.data.error:`HTTP_${response.status}`)}
  const applied=z.object({intentId:z.string(),state:z.literal('applied')}).passthrough().parse(value)
  sessionStorage.removeItem(storageKey)
  return applied
 }})
 return <AgentControlIntegrationApproval contextId={contextId} artifact={artifact} canApprove busy={mutate.isPending}
  onApprove={payload=>{const value=mutate.mutate({action:'integration.approve',payload});record.push(value)}}/>
}
for(const truncated of [false,true])it(`approves only an identity-matched complete preview, truncated=${truncated}`,async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(diffResponse(truncated)))
 const approve=vi.fn(),{client}=renderApproval(approve)
 const button=screen.getByText('Aprovar integração deste commit') as HTMLButtonElement
 expect(button.disabled).toBe(true)
 expect(screen.getByRole('button',{name:'Ver alterações deste artefato'}).getAttribute('data-viewport')).toBeNull()
 expect(document.querySelector('[data-viewport="desktop"]')).toBeTruthy()
 fireEvent.click(screen.getByText('Ver alterações deste artefato'))
 await waitFor(()=>expect(screen.getByText('+fixture')).toBeTruthy())
 expect(button.disabled).toBe(truncated)
 fireEvent.click(button)
 expect(approve).toHaveBeenCalledTimes(truncated?0:1)
 if(!truncated)expect(approve).toHaveBeenCalledWith({artifactId:artifact.id,artifactDigest:artifact.identity_digest,policyRevision:2,targetRef:artifact.target_ref})
 expect(screen.queryByText(secret)).toBeNull()
 client.clear()
})
for(const width of [360,390])it(`narrow ${width}px shows digest, policy and destination and blocks a truncated preview`,async()=>{
 stubWidth(width)
 const fetchMock=vi.fn().mockResolvedValue(diffResponse(true))
 vi.stubGlobal('fetch',fetchMock)
 const approve=vi.fn(),{client}=renderApproval(approve)
 expect(document.querySelector('[data-viewport="narrow"]')).toBeTruthy()
 expect(screen.getByText('Digest').tagName).toBe('DT')
 expect(screen.getByText(artifact.identity_digest).tagName).toBe('DD')
 expect(screen.getByText('Política').tagName).toBe('DT')
 expect(screen.getByText(String(artifact.policy_revision)).tagName).toBe('DD')
 expect(screen.getByText('Destino').tagName).toBe('DT')
 expect(screen.getByText(artifact.target_ref).tagName).toBe('DD')
 const view=screen.getByRole('button',{name:'Ver alterações deste artefato'}) as HTMLButtonElement
 const approveButton=screen.getByRole('button',{name:'Aprovar integração deste commit'}) as HTMLButtonElement
 expect(view.style.minHeight).toBe('44px')
 expect(approveButton.style.minWidth).toBe('44px')
 expect(view.className).toContain('min-h-11')
 expect(view.className).toContain('focus-visible:ring')
 expect(view.type).toBe('button')
 view.focus()
 expect(document.activeElement).toBe(view)
 fireEvent.keyDown(view,{key:'Enter'})
 await waitFor(()=>expect(screen.getByText('+fixture')).toBeTruthy())
 expect(screen.getByRole('alert').textContent).toContain('prévia está incompleta')
 expect(approveButton.disabled).toBe(true)
 expect(approveButton.getAttribute('aria-describedby')).toBe(`approval-preview-truncated-${artifact.id}`)
 fireEvent.click(approveButton)
 fireEvent.keyDown(approveButton,{key:' '})
 expect(approve).not.toHaveBeenCalled()
 expect(screen.queryByText(secret)).toBeNull()
 const init=(fetchMock.mock.calls[0]?.[1]??{}) as RequestInit
 expect(init.credentials).toBe('include')
 expect(new Headers(init.headers).has('authorization')).toBe(false)
 client.clear()
})
it('retries MANAGER_UNAVAILABLE from the void settings mutation and shows the sent ids',async()=>{
 vi.mocked(signControl).mockResolvedValue('fixture-proof')
 stubWidth(360)
 let seq=0
 vi.spyOn(crypto,'randomUUID').mockImplementation(()=>`00000000-0000-4000-8000-${String(++seq).padStart(12,'0')}` as `${string}-${string}-${string}-${string}-${string}`)
 const commands:Array<{body:Record<string,unknown>;init:RequestInit}>=[]
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=String(input)
  if(path.endsWith('/diff'))return diffResponse(false)
  if(path.endsWith('/control')){
   const body=JSON.parse(String(init?.body)) as Record<string,unknown>
   commands.push({body,init:init??{}})
   return commands.length===1?new Response(JSON.stringify({error:'MANAGER_UNAVAILABLE'}),{status:409}):new Response(JSON.stringify({intentId:body.intentId,state:'applied'}))
  }
  return new Response('{}',{status:404})
 }))
 const record:unknown[]=[]
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})
 render(<QueryClientProvider client={client}><SettingsTransport record={record}/></QueryClientProvider>)
 fireEvent.click(screen.getByRole('button',{name:'Ver alterações deste artefato'}))
 await screen.findByText('+fixture')
 fireEvent.click(screen.getByRole('button',{name:'Aprovar integração deste commit'}))
 await screen.findByText(/MANAGER_UNAVAILABLE/)
 expect(record[0]).toBeUndefined()
 expect(commands).toHaveLength(1)
 const first=commands[0]!
 expect(first.body).toMatchObject({schemaVersion:1,contextId,action:'integration.approve',payload:{artifactId:artifact.id,artifactDigest:artifact.identity_digest,policyRevision:2,targetRef:artifact.target_ref}})
 expect(first.body.intentId).toBe('00000000-0000-4000-8000-000000000001')
 expect(first.body.deliveryAttemptId).toBe('00000000-0000-4000-8000-000000000003')
 expect(document.querySelector('[data-approval-intent]')?.getAttribute('data-approval-intent')).toBe(first.body.intentId)
 expect(document.querySelector('[data-approval-delivery]')?.getAttribute('data-approval-delivery')).toBe(first.body.deliveryAttemptId)
 expect(String(first.init.body)).not.toContain(secret)
 expect(new Headers(first.init.headers).get('x-ac-operator-proof')).toBe('fixture-proof')
 expect(new Headers(first.init.headers).has('authorization')).toBe(false)
 const stored=JSON.parse(sessionStorage.getItem(agentControlPendingKey(contextId))||'null') as {intentId:string;semantic:string}
 expect(stored.intentId).toBe(first.body.intentId)
 expect(JSON.stringify(stored)).not.toContain('deliveryAttemptId')
 expect(JSON.stringify(stored)).not.toContain(secret)
 const retry=await screen.findByRole('button',{name:'Tentar novamente a aprovação'}) as HTMLButtonElement
 await waitFor(()=>expect(document.activeElement).toBe(retry))
 expect(retry.disabled).toBe(false)
 expect(retry.style.minHeight).toBe('44px')
 expect(retry.getAttribute('aria-describedby')).toBe(`approval-error-${artifact.id}`)
 fireEvent.keyDown(retry,{key:'Enter'})
 await waitFor(()=>expect(commands).toHaveLength(2))
 expect(record[1]).toBeUndefined()
 const second=commands[1]!
 expect(second.body.intentId).toBe(first.body.intentId)
 expect(second.body.deliveryAttemptId).not.toBe(first.body.deliveryAttemptId)
 expect(second.body.deliveryAttemptId).toBe('00000000-0000-4000-8000-000000000005')
 expect(second.body.payload).toEqual(first.body.payload)
 await waitFor(()=>expect(document.querySelector('[data-approval-delivery]')?.getAttribute('data-approval-delivery')).toBe(second.body.deliveryAttemptId))
 expect(document.querySelector('[data-approval-intent]')?.getAttribute('data-approval-intent')).toBe(second.body.intentId)
 expect(sessionStorage.getItem(agentControlPendingKey(contextId))).toBeNull()
 await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull())
 client.clear()
})
it('blocks resend when the stored approval intent is corrupt',async()=>{
 stubWidth(390)
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(diffResponse(false)))
 sessionStorage.setItem(agentControlPendingKey(contextId),'{')
 const approve=vi.fn()
 const {client}=renderApproval(approve)
 fireEvent.click(screen.getByRole('button',{name:'Ver alterações deste artefato'}))
 await screen.findByText('+fixture')
 fireEvent.click(screen.getByRole('button',{name:'Aprovar integração deste commit'}))
 await screen.findByText('PENDING_COMMAND_INVALID')
 expect(approve).not.toHaveBeenCalled()
 expect(sessionStorage.getItem(agentControlPendingKey(contextId))).toBe('{')
 client.clear()
})
it('keeps the desktop card at a wide viewport',async()=>{
 stubWidth(1280)
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(diffResponse(false)))
 const approve=vi.fn(),{client}=renderApproval(approve)
 const button=screen.getByRole('button',{name:'Aprovar integração deste commit'}) as HTMLButtonElement
 expect(document.querySelector('[data-viewport="desktop"]')).toBeTruthy()
 expect(screen.queryByText('Digest')).toBeNull()
 expect(button.style.minHeight).toBe('')
 expect(button.className).not.toContain('min-h-11')
 expect(button.type).toBe('button')
 const view=screen.getByRole('button',{name:'Ver alterações deste artefato'}) as HTMLButtonElement
 view.focus()
 expect(document.activeElement).toBe(view)
 fireEvent.keyDown(view,{key:'Enter'})
 await screen.findByText('+fixture')
 button.focus()
 expect(document.activeElement).toBe(button)
 fireEvent.keyDown(button,{key:'Enter'})
 expect(approve).toHaveBeenCalledTimes(1)
 client.clear()
})
