// @vitest-environment jsdom
import {beforeEach,describe,expect,it,vi} from 'vitest'
import type {WorkflowGraph} from '@open-mercato/cezar-api-client'
const {fetcher}=vi.hoisted(()=>({fetcher:vi.fn()}))
vi.mock('../settings/agent-control-fetch',()=>({agentControlFetch:fetcher}))
vi.mock('../settings/agent-control-operator',()=>({signControl:vi.fn(async()=>'proof')}))
import {hasPendingManagedWorkflow,saveManagedWorkflow} from './managed-workflow'
const project='11111111-1111-4111-8111-111111111111',installation='22222222-2222-4222-8222-222222222222'
const graph={nodes:[],edges:[]} as WorkflowGraph
const ok=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}})
beforeEach(()=>{sessionStorage.clear();fetcher.mockReset();fetcher.mockImplementation(async(path:string)=>path==='/api/v1/ac/project-admin'?ok({principalId:'fixture',installationId:installation}):ok({error:'WORKFLOW_REPOSITORY_REQUIRED'},409))})
describe('managed workflow pending save',()=>{
 it('releases a definitive first refusal before any journal exists',async()=>{
  await expect(saveManagedWorkflow(project,'fixture','',graph,0)).rejects.toThrow('WORKFLOW_REPOSITORY_REQUIRED')
  expect(await hasPendingManagedWorkflow(project)).toBe(false)
 })
 it.each(['WORKFLOW_GRAPH_FORBIDDEN','WORKFLOW_REPOSITORY_CHANGED'])('retains possibly post-journal refusal %s',async code=>{
  fetcher.mockImplementation(async(path:string)=>path==='/api/v1/ac/project-admin'?ok({principalId:'fixture',installationId:installation}):ok({error:code},409))
  await expect(saveManagedWorkflow(project,'fixture','',graph,0)).rejects.toThrow(code)
  expect(await hasPendingManagedWorkflow(project)).toBe(true)
 })
 it('retains an uncertain intent even when later refused before journal',async()=>{
  fetcher.mockImplementation(async(path:string)=>{if(path==='/api/v1/ac/project-admin')return ok({principalId:'fixture',installationId:installation});throw Error('network lost')})
  await expect(saveManagedWorkflow(project,'fixture','',graph,0)).rejects.toThrow('network lost')
  expect(await hasPendingManagedWorkflow(project)).toBe(true)
  fetcher.mockImplementation(async(path:string)=>path==='/api/v1/ac/project-admin'?ok({principalId:'fixture',installationId:installation}):ok({error:'WORKFLOW_REVISION_CONFLICT'},409))
  await expect(saveManagedWorkflow(project,'fixture','',graph,0)).rejects.toThrow('WORKFLOW_REVISION_CONFLICT')
  expect(await hasPendingManagedWorkflow(project)).toBe(true)
 })
})
