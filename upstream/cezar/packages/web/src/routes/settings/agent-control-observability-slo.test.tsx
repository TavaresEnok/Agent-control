import {afterEach,expect,test,vi} from 'vitest'
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {ProjectScopeProvider} from '@/api/project-scope-context'
import {AgentControlObservability,sloUnavailableMessage} from './agent-control-observability'
import {narrowManagerPlanQuery} from './agent-control-fetch'
import type {AgentControlSloReport} from '@open-mercato/cezar-api-client'

afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals()})

function point(freshnessLimitSeconds:number,ageSeconds:string|null,observedAt:string|null='2026-11-03T12:00:00.000Z'):AgentControlSloReport['results'][number]['window']{
 return {kind:'snapshot_point',freshnessLimitSeconds,observedAt,ageSeconds}
}
const report:AgentControlSloReport={schemaVersion:1,catalogVersion:1,scope:'installation_aggregate',results:[
 {id:'infrastructure_failure_rate',version:1,status:'violated',reason:'objective_missed',margin:{unit:'ppm',headroom:'-1'},window:point(360,'12')},
 {id:'pending_receipt_age',version:1,status:'unknown',reason:'snapshot_stale',margin:null,window:point(300,'301')},
 {id:'queue_backlog',version:1,status:'unknown',reason:'required_signal_absent',margin:null,window:point(240,null,null)},
 {id:'dispatch_latency',version:1,status:'violated',reason:'objective_missed',margin:{unit:'seconds',headroom:'-3'},window:point(180,'9')},
 {id:'manager_availability',version:1,status:'ok',reason:'within_objective',margin:{unit:'ppm',headroom:'1000000'},window:point(120,'4')},
]}
const metrics={schemaVersion:1,scope:'installation_aggregate',observedAt:'2026-11-03T12:00:00.000Z',databaseReadOnly:true,diskObservation:'not_configured',metrics:[]}

function stubViewport(width:number){
 vi.stubGlobal('matchMedia',(query:string)=>{
  const matches=query===narrowManagerPlanQuery&&width<=Number(narrowManagerPlanQuery.match(/\d+/)?.[0])
  return {matches,media:query,addEventListener(){},removeEventListener(){}}
 })
}
function jsonResponse(body:unknown,status=200){
 return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}})
}
function renderPanel(fetchImpl:(input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>){
 vi.stubGlobal('fetch',fetchImpl)
 const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}})
 return render(<QueryClientProvider client={client}><ProjectScopeProvider projectId="proj-slo"><AgentControlObservability enabled/></ProjectScopeProvider></QueryClientProvider>)
}
function card(id:string){
 const node=document.querySelector(`[data-slo="${id}"]`)
 expect(node).not.toBeNull()
 return node as HTMLElement
}

test.each([360,390])('at %ipx shows five SLOs with text status, reason and margin',async width=>{
 stubViewport(width)
 const fetchMock=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  expect(new Headers(init?.headers).get('X-Agent-Control-Project')).toBe('proj-slo')
  expect(init?.credentials).toBe('include')
  if(String(input).endsWith('/observability/slo'))return jsonResponse(report)
  if(String(input).endsWith('/observability'))return jsonResponse(metrics)
  return new Response('sekret-unexpected',{status:500})
 })
 renderPanel(fetchMock)
 expect(await screen.findByRole('heading',{name:'Níveis de serviço'})).toBeTruthy()
 expect(await screen.findByText('Disponibilidade dos gerentes')).toBeTruthy()
 const manager=card('manager_availability')
 const latency=card('dispatch_latency')
 const queue=card('queue_backlog')
 const receipt=card('pending_receipt_age')
 const rate=card('infrastructure_failure_rate')
 expect(within(manager).getByText('Disponibilidade dos gerentes')).toBeTruthy()
 expect(manager.querySelector('[data-slo-status="ok"]')?.textContent).toBe('dentro do objetivo')
 expect(within(manager).getByText(/A medição ficou dentro do objetivo da bancada/)).toBeTruthy()
 expect(within(manager).getByText('Margem: 1.000.000 ppm de folga')).toBeTruthy()
 expect(within(manager).getByText('Janela: Frescor máximo 120 segundos. Idade da observação: 4 segundos.')).toBeTruthy()
 expect(manager.textContent).not.toMatch(/301/)
 expect(latency.querySelector('[data-slo-status="violated"]')?.textContent).toBe('violado')
 expect(within(latency).getByRole('alert').textContent).toMatch(/Objetivo violado/)
 expect(latency.className).toContain('border-destructive')
 expect(within(latency).getByText(/A medição ficou fora do objetivo da bancada/)).toBeTruthy()
 expect(within(latency).getByText('Margem: 3 segundos abaixo do objetivo')).toBeTruthy()
 expect(within(latency).getByText('Janela: Frescor máximo 180 segundos. Idade da observação: 9 segundos.')).toBeTruthy()
 expect(queue.querySelector('[data-slo-status="unknown"]')?.textContent).toBe('desconhecido')
 expect(queue.textContent).not.toMatch(/dentro do objetivo/)
 expect(queue.textContent).toMatch(/Ausência não é cumprimento/)
 expect(queue.textContent).toMatch(/Desconhecido não é cumprimento do objetivo/)
 expect(within(queue).getByText(/Sem margem/)).toBeTruthy()
 expect(within(queue).getByText('Janela: Frescor máximo 240 segundos. Sem idade de observação confirmada.')).toBeTruthy()
 expect(queue.textContent).not.toMatch(/Idade da observação:/)
 expect(receipt.querySelector('[data-slo-status="unknown"]')?.textContent).toBe('desconhecido')
 expect(receipt.textContent).not.toMatch(/dentro do objetivo/)
 expect(receipt.textContent).toMatch(/limite de frescor/)
 expect(within(receipt).getByText('Janela: Frescor máximo 300 segundos. Idade da observação: 301 segundos.')).toBeTruthy()
 expect(rate.querySelector('[data-slo-status="violated"]')?.textContent).toBe('violado')
 expect(within(rate).getByText('Margem: 1 ppm abaixo do objetivo')).toBeTruthy()
 expect(within(rate).getByText('Janela: Frescor máximo 360 segundos. Idade da observação: 12 segundos.')).toBeTruthy()
 expect(within(rate).getByRole('alert')).toBeTruthy()
 for(const node of [manager,latency,queue,receipt,rate]){
  expect(node.className).toContain('break-words')
  expect(node.className).toContain('min-w-0')
  expect(node.className).not.toMatch(/truncate|line-clamp|text-ellipsis/)
 }
 const panel=document.querySelector('[data-slo-panel="report"]')
 expect(panel?.querySelector(':scope > p')?.textContent).not.toMatch(/Frescor máximo|Idade da observação/)
 expect(panel?.getAttribute('data-slo-layout')).toBe('stack')
 expect(panel?.className).toContain('flex-col')
 expect(screen.getByRole('button',{name:'Atualizar níveis de serviço'}).className).toContain('min-h-11')
 expect(screen.getByRole('button',{name:'Atualizar níveis de serviço'}).className).toContain('w-full')
 expect(document.body.textContent).not.toMatch(/sekret/)
 const paths=fetchMock.mock.calls.map(call=>String(call[0]))
 expect(paths).toContain('/api/v1/ac/observability/slo')
})

test.each([
 ['http',()=>Promise.resolve(new Response(JSON.stringify({error:'postgres://user:sekret-db@db/app'}),{status:503,headers:{'content-type':'application/json'}}))],
 ['network',()=>Promise.reject(Error('connect ECONNREFUSED sekret-net'))],
 ['json',()=>Promise.resolve(new Response('sekret-body',{status:200,headers:{'content-type':'text/plain'}}))],
 ['schema',()=>Promise.resolve(jsonResponse({schemaVersion:1,catalogVersion:1,scope:'installation_aggregate',results:[],leak:'sekret-schema'}))],
 ['duplicate',()=>Promise.resolve(jsonResponse({...report,results:report.results.map(result=>({...result,id:'queue_backlog'}))}))],
] as const)('%s stays unavailable and retries without showing the payload',async(_kind,fail)=>{
 stubViewport(390)
 let recover=false
 const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
  if(String(input).endsWith('/observability/slo'))return recover?jsonResponse(report):fail()
  if(String(input).endsWith('/observability'))return jsonResponse(metrics)
  return new Response('sekret-other',{status:500})
 })
 renderPanel(fetchMock)
 expect(await screen.findByRole('alert')).toBeTruthy()
 expect(screen.getByText(sloUnavailableMessage)).toBeTruthy()
 expect(document.body.textContent).not.toMatch(/sekret/)
 expect(screen.queryByText('Disponibilidade dos gerentes')).toBeNull()
 expect(document.querySelector('[data-slo-status="ok"]')).toBeNull()
 recover=true
 fireEvent.click(screen.getByRole('button',{name:'Tentar novamente'}))
 expect(await screen.findByText('Disponibilidade dos gerentes')).toBeTruthy()
 expect(screen.queryByText(sloUnavailableMessage)).toBeNull()
 expect(screen.queryByRole('button',{name:'Tentar novamente'})).toBeNull()
})

test('a failed refresh hides the previous report instead of confirming it',async()=>{
 stubViewport(390)
 let fail=false
 const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
  if(String(input).endsWith('/observability/slo')){
   if(fail)return jsonResponse({schemaVersion:1,catalogVersion:1,scope:'installation_aggregate',results:[],leak:'sekret-stale'})
   return jsonResponse(report)
  }
  if(String(input).endsWith('/observability'))return jsonResponse(metrics)
  return new Response('sekret-other',{status:500})
 })
 renderPanel(fetchMock)
 expect(await screen.findByText('dentro do objetivo')).toBeTruthy()
 expect(document.querySelector('[data-slo-panel="report"]')).not.toBeNull()
 fail=true
 fireEvent.click(screen.getByRole('button',{name:'Atualizar níveis de serviço'}))
 expect(await screen.findByText(sloUnavailableMessage)).toBeTruthy()
 expect(screen.getByRole('button',{name:'Tentar novamente'})).toBeTruthy()
 expect(document.querySelector('[data-slo-panel="report"]')).toBeNull()
 expect(document.querySelector('[data-slo-status="ok"]')).toBeNull()
 expect(document.querySelector('[data-slo-status="violated"]')).toBeNull()
 expect(screen.queryByText('dentro do objetivo')).toBeNull()
 expect(screen.queryByText('Disponibilidade dos gerentes')).toBeNull()
 expect(screen.queryByText('Margem: 1.000.000 ppm de folga')).toBeNull()
 expect(document.body.textContent).not.toMatch(/sekret/)
 expect(fetchMock.mock.calls.filter(call=>String(call[0]).endsWith('/observability/slo'))).toHaveLength(2)
})

test('a free reason and a 19-digit headroom stay on the matching line',async()=>{
 stubViewport(390)
 const headroom='1000000000000000000'
 const free={...report,results:report.results.map(result=>result.id==='manager_availability'?{...result,reason:'folga confirmada na bancada',margin:{unit:'count' as const,headroom},window:{...result.window,observedAt:'ontem',ageSeconds:'1234567890123456789'}}:result)}
 const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
  if(String(input).endsWith('/observability/slo'))return jsonResponse(free)
  if(String(input).endsWith('/observability'))return jsonResponse(metrics)
  return new Response('sekret-other',{status:500})
 })
 renderPanel(fetchMock)
 const manager=await screen.findByText('Disponibilidade dos gerentes').then(()=>card('manager_availability'))
 expect(screen.queryByText(sloUnavailableMessage)).toBeNull()
 expect(within(manager).getByText('Motivo: Motivo não catalogado nesta tela: folga confirmada na bancada.')).toBeTruthy()
 expect(within(manager).getByText('Margem: 1.000.000.000.000.000.000 itens de folga')).toBeTruthy()
 expect(within(manager).getByText('Janela: Frescor máximo 120 segundos. Idade da observação: 1.234.567.890.123.456.789 segundos.')).toBeTruthy()
 expect(within(card('pending_receipt_age')).getByText('Janela: Frescor máximo 300 segundos. Idade da observação: 301 segundos.')).toBeTruthy()
 expect(document.body.textContent).not.toMatch(/sekret/)
})

test('a negative age keeps its sign on each service level',async()=>{
 stubViewport(390)
 const large='-123456789012345678901'
 const signed={...report,results:report.results.map(result=>{
  if(result.id==='dispatch_latency')return {...result,window:point(-1.25,'-3','agora')}
  if(result.id==='manager_availability')return {...result,window:point(120.5,large,'ontem')}
  return result
 })}
 const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
  if(String(input).endsWith('/observability/slo'))return jsonResponse(signed)
  if(String(input).endsWith('/observability'))return jsonResponse(metrics)
  return new Response('sekret-other',{status:500})
 })
 renderPanel(fetchMock)
 const latency=await screen.findByText('Latência de despacho').then(()=>card('dispatch_latency'))
 const manager=card('manager_availability')
 expect(screen.queryByText(sloUnavailableMessage)).toBeNull()
 expect(within(latency).getByText('Janela: Frescor máximo -1.25 segundos. Idade da observação: -3 segundos.')).toBeTruthy()
 expect(latency.textContent).not.toMatch(/Idade da observação: 3 segundos/)
 expect(within(manager).getByText('Janela: Frescor máximo 120.5 segundos. Idade da observação: -123.456.789.012.345.678.901 segundos.')).toBeTruthy()
 expect(manager.textContent).not.toMatch(/Idade da observação: 123/)
 expect(within(card('queue_backlog')).getByText('Janela: Frescor máximo 240 segundos. Sem idade de observação confirmada.')).toBeTruthy()
 expect(within(card('pending_receipt_age')).getByText('Janela: Frescor máximo 300 segundos. Idade da observação: 301 segundos.')).toBeTruthy()
 expect(within(card('infrastructure_failure_rate')).getByText('Janela: Frescor máximo 360 segundos. Idade da observação: 12 segundos.')).toBeTruthy()
 expect(document.body.textContent).not.toMatch(/sekret/)
})

test('a closed admin view does not request service levels',()=>{
 const fetchMock=vi.fn()
 vi.stubGlobal('fetch',fetchMock)
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}})
 render(<QueryClientProvider client={client}><ProjectScopeProvider projectId="proj-slo"><AgentControlObservability enabled={false}/></ProjectScopeProvider></QueryClientProvider>)
 expect(fetchMock).not.toHaveBeenCalled()
 expect(screen.queryByRole('heading',{name:'Níveis de serviço'})).toBeNull()
 expect(screen.queryByText('Operação da central')).toBeNull()
})
