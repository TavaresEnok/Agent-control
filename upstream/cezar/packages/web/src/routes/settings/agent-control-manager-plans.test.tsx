import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {afterEach,expect,it,vi} from 'vitest'
import {AgentControlManagerPlans,managerPlanTouchMinPx,narrowManagerPlanQuery} from './agent-control-manager-plans'

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

function stubViewport(width:number){
 vi.stubGlobal('matchMedia',(query:string)=>{
  if(query!==narrowManagerPlanQuery)return {matches:false,media:query,addEventListener(){},removeEventListener(){}}
  const limit=Number(narrowManagerPlanQuery.match(/\d+/)?.[0])
  return {matches:width<=limit,media:query,addEventListener(){},removeEventListener(){}}
 })
}
function planBody(revision:number,digestValue:string,objectiveRef:string,sourceMessageRef:string){
 const body={schemaVersion:1,contextId,objectiveRef,sourceMessageRef,constraintRefs:[],tasks:[{id:'one',objectiveRef:'message:one',acceptanceRefs:['acceptance:one'],inputRefs:[],outputRefs:['output:one'],dependsOn:[],writePaths:['src/one'],qualityRevision:1,targetRef:'refs/heads/main',maxCorrections:0}]}
 return {revision,digest:digestValue,compilationDigest:'b'.repeat(64),parentRevision:null,epoch:1,plan:body,compilation:{schemaVersion:1,planDigest:digestValue,workflow:{name:'fixture',steps:[],source:'built-in'},bindings:[],admission:'managed-delivery-adapter-required',batches:[['one']]}}
}
function field(surface:string,name:string){
 return document.querySelector(`[data-plan-surface="${surface}"][data-plan-field="${name}"], [data-plan-surface="${surface}"] [data-plan-field="${name}"]`)
}
function assertFullDigest(node:Element|null,digestValue:string){
 expect(node).not.toBeNull()
 const text=node?.textContent??''
 expect(text.match(/[a-f0-9]{64}/g)).toEqual([digestValue])
 expect(text).not.toMatch(/…|\.{3}/)
 expect(node?.className).toContain('break-all')
 expect(node?.className).not.toMatch(/truncate|line-clamp|text-ellipsis/)
}
function renderPlans(principalId='fixture'){
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})
 const view=render(<QueryClientProvider client={client}><AgentControlManagerPlans contextId={contextId} policyRevision={2} principalId={principalId} projectId={contextId}/></QueryClientProvider>)
 return {client,view}
}

it.each([360,390])('at %ipx shows objective, origin and the full digest and retries plan.start with that identity',async width=>{
 const secret='bearer-secret-not-rendered'
 const commands:Record<string,unknown>[]=[]
 const fetchMock=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=String(input)
  if(path.endsWith('/commands')){
   const command=JSON.parse(String(init?.body));commands.push(command)
   const headers=new Headers(init?.headers)
   expect(headers.get('authorization')).toBeNull()
   return commands.length===1?new Response(JSON.stringify({error:'MANAGER_UNAVAILABLE'}),{status:409}):new Response(JSON.stringify({intentId:command.intentId,runId:intentRun,state:'accepted'}),{status:202})
  }
  if(path.endsWith('/manager-plans'))return new Response(JSON.stringify({proposals:[{revision:1,epoch:1,digest,taskCount:1,createdAt:'2026-11-02T00:00:00.000Z'}],hasMore:false}))
  return new Response(JSON.stringify(preview))
 })
 vi.stubGlobal('fetch',fetchMock)
 stubViewport(width)
 const {client}=renderPlans(secret)
 const proposal=await screen.findByRole('button',{name:new RegExp(`objetivo message:objective, origem message:request, identificador ${digest}`)})
 expect(proposal.style.minHeight).toBe(`${managerPlanTouchMinPx}px`)
 expect(proposal.style.minWidth).toBe(`${managerPlanTouchMinPx}px`)
 expect(proposal.getAttribute('type')).toBe('button')
 expect(proposal.className).toContain('focus-visible:ring-[3px]')
 assertFullDigest(field('list','digest'),digest)
 expect(field('list','objective')?.textContent).toBe('Objetivo: message:objective')
 expect(field('list','origin')?.textContent).toBe('Solicitação de origem: message:request')
 proposal.focus()
 expect(document.activeElement).toBe(proposal)
 fireEvent.keyDown(proposal,{key:'Enter',code:'Enter'})
 fireEvent.click(proposal)
 const start=await screen.findByRole('button',{name:new RegExp(`Solicitar execução da proposta 1, objetivo message:objective, origem message:request, identificador ${digest}`)})
 expect(start.style.minHeight).toBe(`${managerPlanTouchMinPx}px`)
 start.focus()
 expect(document.activeElement).toBe(start)
 assertFullDigest(field('start','digest'),digest)
 expect(field('start','objective')?.textContent).toBe(field('list','objective')?.textContent)
 expect(field('start','origin')?.textContent).toBe(field('list','origin')?.textContent)
 expect(field('start','revision')?.textContent).toBe('Revisão 1')
 expect(field('detail','digest')?.textContent).toContain(digest)
 fireEvent.click(start)
 await screen.findByText('MANAGER_UNAVAILABLE')
 fireEvent.click(start)
 await waitFor(()=>expect(commands).toHaveLength(2))
 await screen.findByText(/Solicitação aceita/)
 expect(commands[0]!.intentId).toBe(commands[1]!.intentId)
 expect(commands[0]!.deliveryAttemptId).not.toBe(commands[1]!.deliveryAttemptId)
 expect(commands[0]).toMatchObject({contextId,policyRevision:2,action:'plan.start',payload:{workflow:'managed-synthetic-v1',messageRef:'message:request',proposalRevision:1,proposalDigest:digest}})
 expect(JSON.stringify(commands)).not.toContain(secret)
 expect(document.body.textContent).not.toContain(secret)
 expect(document.body.textContent).not.toMatch(/authorization|cookie|session-token/i)
 client.clear()
})

it('lists two narrow proposals without collapsing digests that differ only at the end',async()=>{
 const first='a'.repeat(64),second=`${'a'.repeat(63)}b`
 const proposals=[{revision:2,epoch:1,digest:second,taskCount:1,createdAt:'2026-11-02T00:00:00.000Z'},{revision:1,epoch:1,digest:first,taskCount:1,createdAt:'2026-11-02T00:00:00.000Z'}]
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
  const path=String(input)
  if(path.endsWith('/manager-plans'))return new Response(JSON.stringify({proposals,hasMore:false}))
  const revision=Number(path.match(/manager-plans\/(\d+)/)?.[1])
  const item=proposals.find(plan=>plan.revision===revision)
  return new Response(JSON.stringify(planBody(revision,item?.digest??first,`message:objective-${revision}`,`message:request-${revision}`)))
 }))
 stubViewport(360)
 const {client}=renderPlans()
 await screen.findByText('Objetivo: message:objective-2')
 const digests=[...document.querySelectorAll('[data-plan-surface="list"][data-plan-field="digest"]')]
 expect(digests).toHaveLength(2)
 assertFullDigest(digests[0]??null,second)
 assertFullDigest(digests[1]??null,first)
 expect(digests[0]?.textContent).not.toContain(first)
 client.clear()
})

it('keeps the other narrow proposals when one preview fails and retries only that proposal',async()=>{
 const secret='bearer-secret-not-rendered'
 const first='a'.repeat(64),broken='b'.repeat(64),third='c'.repeat(64)
 const proposals=[{revision:3,epoch:1,digest:third,taskCount:1,createdAt:'2026-11-02T00:00:00.000Z'},{revision:2,epoch:1,digest:broken,taskCount:1,createdAt:'2026-11-02T00:00:00.000Z'},{revision:1,epoch:1,digest:first,taskCount:1,createdAt:'2026-11-02T00:00:00.000Z'}]
 const attempts=new Map<number,number>()
 let releaseInvalid:()=>void=()=>{}
 const invalidGate=new Promise<void>(resolve=>{releaseInvalid=resolve})
 const commands:unknown[]=[]
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=String(input)
  if(path.endsWith('/commands')){commands.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({error:'UNEXPECTED'}),{status:500})}
  if(path.endsWith('/manager-plans'))return new Response(JSON.stringify({proposals,hasMore:false}))
  const revision=Number(path.match(/manager-plans\/(\d+)/)?.[1])
  const attempt=(attempts.get(revision)??0)+1
  attempts.set(revision,attempt)
  if(revision===2&&attempt===1)return new Response(JSON.stringify({authorization:secret,token:secret}),{status:500})
  if(revision===2&&attempt===2){await invalidGate;return new Response(JSON.stringify({token:secret,revision:2}),{status:200})}
  const item=proposals.find(plan=>plan.revision===revision)
  return new Response(JSON.stringify(planBody(revision,item?.digest??first,`message:objective-${revision}`,`message:request-${revision}`)))
 }))
 stubViewport(360)
 const {client}=renderPlans(secret)
 await screen.findByText('Objetivo: message:objective-3')
 await screen.findByText('Objetivo: message:objective-1')
 expect(screen.queryByText('Objetivo: message:objective-2')).toBeNull()
 expect(screen.queryByText(/message:request-2/)).toBeNull()
 const digests=[...document.querySelectorAll('[data-plan-surface="list"][data-plan-field="digest"]')]
 expect(digests).toHaveLength(3)
 assertFullDigest(digests.find(node=>node.textContent?.includes(broken))??null,broken)
 assertFullDigest(digests.find(node=>node.textContent?.includes(first))??null,first)
 assertFullDigest(digests.find(node=>node.textContent?.includes(third))??null,third)
 const retry=await screen.findByRole('button',{name:`Tentar novamente a proposta 2, identificador ${broken}`})
 expect(retry.style.minHeight).toBe(`${managerPlanTouchMinPx}px`)
 expect(retry.style.minWidth).toBe(`${managerPlanTouchMinPx}px`)
 expect(retry.getAttribute('type')).toBe('button')
 expect(retry.className).toContain('focus-visible:ring-[3px]')
 expect(screen.getByRole('alert').textContent).toBe('Não foi possível carregar o objetivo e a origem desta proposta.')
 retry.focus()
 expect(document.activeElement).toBe(retry)
 fireEvent.keyDown(retry,{key:'Enter',code:'Enter'})
 fireEvent.click(retry)
 await waitFor(()=>expect(attempts.get(2)).toBe(2))
 expect((retry as HTMLButtonElement).disabled).toBe(true)
 fireEvent.click(retry)
 expect(attempts.get(2)).toBe(2)
 expect(attempts.get(1)).toBe(1)
 expect(attempts.get(3)).toBe(1)
 expect(screen.getByText('Objetivo: message:objective-3')).toBeTruthy()
 expect(screen.getByText('Objetivo: message:objective-1')).toBeTruthy()
 expect(document.body.textContent).not.toContain(secret)
 releaseInvalid()
 await screen.findByText('Não foi possível carregar o objetivo e a origem desta proposta.')
 expect(screen.queryByText('Objetivo: message:objective-2')).toBeNull()
 expect(screen.getByText('Objetivo: message:objective-3')).toBeTruthy()
 expect(document.body.textContent).not.toContain(secret)
 const again=await screen.findByRole('button',{name:`Tentar novamente a proposta 2, identificador ${broken}`})
 again.focus()
 expect(document.activeElement).toBe(again)
 fireEvent.click(again)
 await screen.findByText('Objetivo: message:objective-2')
 await screen.findByText('Solicitação de origem: message:request-2')
 expect(screen.getAllByText('Objetivo: message:objective-2')).toHaveLength(1)
 expect(screen.getByText('Objetivo: message:objective-1')).toBeTruthy()
 expect(screen.getByText('Objetivo: message:objective-3')).toBeTruthy()
 expect(screen.queryByRole('button',{name:`Tentar novamente a proposta 2, identificador ${broken}`})).toBeNull()
 expect(attempts.get(1)).toBe(1)
 expect(attempts.get(3)).toBe(1)
 expect(attempts.get(2)).toBe(3)
 expect(commands).toEqual([])
 expect(document.body.textContent).not.toContain(secret)
 expect(document.body.textContent).not.toMatch(/authorization|cookie|session-token/i)
 client.clear()
})

it('keeps the desktop proposal list compact and still shows the full digest after selection',async()=>{
 const commands:Record<string,unknown>[]=[]
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=String(input)
  if(path.endsWith('/commands')){
   commands.push(JSON.parse(String(init?.body)))
   return new Response(JSON.stringify({intentId:commands[0]!.intentId,runId:intentRun,state:'accepted'}),{status:202})
  }
  if(path.endsWith('/manager-plans'))return new Response(JSON.stringify({proposals:[{revision:1,epoch:1,digest,taskCount:1,createdAt:'2026-11-02T00:00:00.000Z'}],hasMore:false}))
  return new Response(JSON.stringify(preview))
 }))
 stubViewport(1280)
 const {client}=renderPlans()
 const proposal=await screen.findByRole('button',{name:'Proposta 1 · 1 tarefas'})
 expect(proposal.textContent).toBe('Proposta 1 · 1 tarefas')
 expect(proposal.style.minHeight).toBe('')
 expect(proposal.className).not.toContain('w-full')
 expect(field('list','digest')).toBeNull()
 fireEvent.click(proposal)
 const start=await screen.findByRole('button',{name:'Solicitar execução desta proposta'})
 expect(start.style.minHeight).toBe('')
 expect(field('start','digest')).toBeNull()
 await waitFor(()=>expect(field('detail','digest')).not.toBeNull())
 assertFullDigest(field('detail','digest'),digest)
 fireEvent.click(start)
 await screen.findByText(/Solicitação aceita/)
 expect(commands[0]).toMatchObject({action:'plan.start',payload:{proposalRevision:1,proposalDigest:digest,messageRef:'message:request'}})
 client.clear()
})

it('does not send plan.start when the opened preview digest is not the listed digest',async()=>{
 const listed='c'.repeat(64),opened='d'.repeat(64)
 const commands:unknown[]=[]
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
  const path=String(input)
  if(path.endsWith('/commands')){commands.push(1);return new Response(JSON.stringify({error:'UNEXPECTED'}),{status:500})}
  if(path.endsWith('/manager-plans'))return new Response(JSON.stringify({proposals:[{revision:1,epoch:1,digest:listed,taskCount:1,createdAt:'2026-11-02T00:00:00.000Z'}],hasMore:false}))
  return new Response(JSON.stringify(planBody(1,opened,'message:other','message:other-request')))
 }))
 stubViewport(390)
 const {client}=renderPlans()
 await screen.findByText(`Identificador da proposta: ${listed}`)
 fireEvent.click(await screen.findByRole('button',{name:new RegExp(listed)}))
 const start=await screen.findByRole('button',{name:'Solicitar execução desta proposta'})
 expect((start as HTMLButtonElement).disabled).toBe(true)
 expect(await screen.findByText(/não confere com o identificador/)).toBeTruthy()
 expect(field('start','digest')).toBeNull()
 expect(field('detail','digest')).toBeNull()
 expect(document.body.textContent).not.toContain(opened)
 expect(document.body.textContent).toContain(listed)
 fireEvent.click(start)
 await waitFor(()=>expect(commands).toHaveLength(0))
 client.clear()
})

function listRow(digestValue:string){
 return [...document.querySelectorAll('[role="listitem"]')].find(node=>node.textContent?.includes(digestValue))??null
}

it('recovers a narrow proposal after a divergent preview starts matching the list',async()=>{
 const secret='bearer:eyJhbGciOiJIUzI1NiJ9.leak-token'
 const listed='e'.repeat(64),wrong='f'.repeat(64),other='a'.repeat(64)
 const proposals=[{revision:2,epoch:1,digest:listed,taskCount:1,createdAt:'2026-11-02T00:00:00.000Z'},{revision:1,epoch:1,digest:other,taskCount:1,createdAt:'2026-11-02T00:00:00.000Z'}]
 const attempts=new Map<number,number>()
 const commands:unknown[]=[]
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=String(input)
  if(path.endsWith('/commands')){commands.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({error:secret}),{status:500})}
  if(path.endsWith('/manager-plans'))return new Response(JSON.stringify({proposals,hasMore:false}))
  const revision=Number(path.match(/manager-plans\/(\d+)/)?.[1])
  const attempt=(attempts.get(revision)??0)+1
  attempts.set(revision,attempt)
  if(revision===2&&attempt===1)return new Response(JSON.stringify(planBody(2,wrong,secret,'message:request-secret')))
  const item=proposals.find(plan=>plan.revision===revision)
  return new Response(JSON.stringify(planBody(revision,item?.digest??other,`message:objective-${revision}`,`message:request-${revision}`)))
 }))
 stubViewport(360)
 const {client}=renderPlans()
 await screen.findByText('Objetivo: message:objective-1')
 const alert=await screen.findByRole('alert')
 expect(alert.textContent).toBe('A prévia recebida divergiu da revisão listada. Nada foi solicitado.')
 expect(listRow(listed)?.getAttribute('data-plan-row-state')).toBe('mismatch')
 expect(listRow(listed)?.textContent).toContain('A prévia desta proposta divergiu da lista.')
 expect(listRow(listed)?.textContent).not.toContain('ainda não estão disponíveis')
 expect(screen.queryByText('Objetivo: message:objective-2')).toBeNull()
 expect(document.body.textContent).not.toContain(secret)
 expect(document.body.textContent).not.toContain(wrong)
 const retry=await screen.findByRole('button',{name:'Tentar novamente a prévia divergente da proposta 2'})
 expect(retry.style.minHeight).toBe(`${managerPlanTouchMinPx}px`)
 expect(retry.style.minWidth).toBe(`${managerPlanTouchMinPx}px`)
 expect(retry.getAttribute('type')).toBe('button')
 expect(retry.getAttribute('aria-describedby')).toBe('plan-listed-digest-2')
 retry.focus()
 expect(document.activeElement).toBe(retry)
 expect(attempts.get(2)).toBe(1)
 expect(attempts.get(1)).toBe(1)
 fireEvent.click(retry)
 await screen.findByText('Objetivo: message:objective-2')
 await screen.findByText('Solicitação de origem: message:request-2')
 expect(listRow(listed)?.getAttribute('data-plan-row-state')).toBe('ready')
 expect(screen.queryByRole('alert')).toBeNull()
 expect(screen.queryByRole('button',{name:'Tentar novamente a prévia divergente da proposta 2'})).toBeNull()
 expect(attempts.get(2)).toBe(2)
 expect(attempts.get(1)).toBe(1)
 expect(commands).toEqual([])
 expect(document.body.textContent).not.toContain(secret)
 expect(document.body.textContent).not.toContain(wrong)
 expect(document.body.textContent).toContain(listed)
 client.clear()
})

it('does not render or log a secret returned in the plan.start error',async()=>{
 const secret='Bearer eyJhbGciOiJIUzI1NiJ9.leak-token'
 const lines:string[]=[]
 const record=(args:unknown[])=>{
  for(const arg of args){
   if(typeof arg==='string')lines.push(arg)
   else if(arg instanceof Error)lines.push(arg.message,arg.stack??'')
   else{try{lines.push(JSON.stringify(arg))}catch{lines.push(String(arg))}}
  }
 }
 const spies=[vi.spyOn(console,'error'),vi.spyOn(console,'warn'),vi.spyOn(console,'log'),vi.spyOn(console,'info'),vi.spyOn(console,'debug')].map(spy=>spy.mockImplementation((...args:unknown[])=>record(args)))
 const commands:Record<string,unknown>[]=[]
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=String(input)
  if(path.endsWith('/commands')){
   const command=JSON.parse(String(init?.body));commands.push(command)
   return new Response(JSON.stringify({error:`MANAGER_UNAVAILABLE ${secret}`,authorization:secret,token:secret}),{status:409})
  }
  if(path.endsWith('/manager-plans'))return new Response(JSON.stringify({proposals:[{revision:1,epoch:1,digest,taskCount:1,createdAt:'2026-11-02T00:00:00.000Z'}],hasMore:false}))
  return new Response(JSON.stringify(preview))
 }))
 stubViewport(360)
 const {client}=renderPlans()
 fireEvent.click(await screen.findByRole('button',{name:new RegExp(`identificador ${digest}`)}))
 fireEvent.click(await screen.findByRole('button',{name:new RegExp(`Solicitar execução da proposta 1, objetivo message:objective, origem message:request, identificador ${digest}`)}))
 const alert=await screen.findByRole('alert')
 expect(alert.textContent).toBe('Não foi possível solicitar a execução desta proposta.')
 expect(alert.getAttribute('aria-label')).toBeNull()
 const visible=`${document.body.textContent??''}\n${document.body.innerHTML}\n${sessionStorage.getItem(sessionStorage.key(0)??'')??''}\n${lines.join('\n')}`
 expect(visible).not.toContain(secret)
 expect(visible).not.toContain('Bearer')
 expect(visible).not.toContain('eyJhbGci')
 for(const node of document.querySelectorAll('[aria-label]'))expect(node.getAttribute('aria-label')??'').not.toContain('Bearer')
 expect(commands).toHaveLength(1)
 expect(JSON.stringify(commands)).not.toContain(secret)
 for(const spy of spies)spy.mockRestore()
 client.clear()
})
