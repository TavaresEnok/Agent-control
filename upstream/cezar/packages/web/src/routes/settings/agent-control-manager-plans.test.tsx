import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {afterEach,expect,it,vi} from 'vitest'
import {AgentControlManagerPlans} from './agent-control-manager-plans'

const contextId='00000000-0000-4000-8000-000000000001',intentRun='00000000-0000-4000-8000-000000000002'
const digest='a'.repeat(64)
const plan={schemaVersion:1,contextId,objectiveRef:'message:objective',sourceMessageRef:'message:request',constraintRefs:[],tasks:[{id:'one',objectiveRef:'message:one',acceptanceRefs:['acceptance:one'],inputRefs:[],outputRefs:['output:one'],dependsOn:[],writePaths:['src/one'],qualityRevision:1,targetRef:'refs/heads/main',maxCorrections:0}]}
const preview={revision:1,digest,compilationDigest:'b'.repeat(64),parentRevision:null,epoch:1,plan,compilation:{schemaVersion:1,planDigest:digest,workflow:{name:'fixture',steps:[],source:'built-in'},bindings:[],admission:'managed-delivery-adapter-required',batches:[['one']]}}
afterEach(()=>{cleanup();vi.unstubAllGlobals();sessionStorage.clear()})
it('retries unavailable manager with the same intent and the selected proposal identity',async()=>{
 const commands:Record<string,unknown>[]=[]
 const fetchMock=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=String(input)
  if(path.endsWith('/commands')){
   const command=JSON.parse(String(init?.body));commands.push(command)
   return commands.length===1?new Response(JSON.stringify({error:'MANAGER_UNAVAILABLE'}),{status:409}):new Response(JSON.stringify({intentId:command.intentId,runId:intentRun,state:'accepted'}),{status:202})
  }
  if(path.endsWith('/manager-plans'))return new Response(JSON.stringify({proposals:[{revision:1,epoch:1,digest,taskCount:1,createdAt:'2026-11-02T00:00:00.000Z'}],hasMore:false}))
  return new Response(JSON.stringify(preview))
 })
 vi.stubGlobal('fetch',fetchMock)
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})
 render(<QueryClientProvider client={client}><AgentControlManagerPlans contextId={contextId} policyRevision={2} principalId="fixture" projectId={contextId}/></QueryClientProvider>)
 fireEvent.click(await screen.findByText('Proposta 1 · 1 tarefas'))
 const button=await screen.findByText('Solicitar execução desta proposta')
 fireEvent.click(button)
 await screen.findByText('MANAGER_UNAVAILABLE')
 fireEvent.click(button)
 await waitFor(()=>expect(commands).toHaveLength(2))
 await screen.findByText(/Solicitação aceita/)
 expect(commands[0]!.intentId).toBe(commands[1]!.intentId)
 expect(commands[0]!.deliveryAttemptId).not.toBe(commands[1]!.deliveryAttemptId)
 expect(commands[0]).toMatchObject({contextId,policyRevision:2,action:'plan.start',payload:{workflow:'managed-synthetic-v1',messageRef:'message:request',proposalRevision:1,proposalDigest:digest}})
 client.clear()
})
