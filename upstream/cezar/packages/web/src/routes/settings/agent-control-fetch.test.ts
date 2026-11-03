import {afterEach,expect,it,vi} from 'vitest'
import {setApiScope} from '@open-mercato/cezar-api-client'
import {agentControlCommandAttempt,agentControlFetch,agentControlPendingKey,integrationApprovalSemantic,subscribeControlSubmissions} from './agent-control-fetch'
afterEach(()=>{setApiScope(null);sessionStorage.clear();vi.unstubAllGlobals();vi.restoreAllMocks()})
it('sends the current project and preserves request headers',async()=>{
 const fetchMock=vi.fn().mockResolvedValue(new Response('{}'))
 vi.stubGlobal('fetch',fetchMock)
 setApiScope('00000000-0000-4000-8000-000000000001')
 await agentControlFetch('/api/v1/ac/contexts',{headers:{'content-type':'application/json'}})
 const init=fetchMock.mock.calls[0]![1] as RequestInit
 expect(new Headers(init.headers).get('x-agent-control-project')).toBe('00000000-0000-4000-8000-000000000001')
 expect(new Headers(init.headers).get('content-type')).toBe('application/json')
 expect(init.credentials).toBe('include')
})
it('reuses the approval intent and refuses a corrupt or conflicting record',()=>{
 let seq=0
 vi.spyOn(crypto,'randomUUID').mockImplementation(()=>`00000000-0000-4000-8000-${String(++seq).padStart(12,'0')}` as `${string}-${string}-${string}-${string}-${string}`)
 const payload={artifactId:'00000000-0000-4000-8000-000000000010',artifactDigest:'d'.repeat(64),policyRevision:2,targetRef:'refs/heads/protected'}
 const semantic=integrationApprovalSemantic(payload)
 const key=agentControlPendingKey('fixture')
 const first=agentControlCommandAttempt(key,semantic)
 const second=agentControlCommandAttempt(key,semantic)
 expect(first.intentId).toBe(second.intentId)
 expect(first.deliveryAttemptId).not.toBe(second.deliveryAttemptId)
 expect(sessionStorage.getItem(key)).not.toContain('super-secret-token')
 expect(sessionStorage.getItem(key)).not.toContain(first.deliveryAttemptId)
 expect(()=>agentControlCommandAttempt(key,integrationApprovalSemantic({...payload,policyRevision:3}))).toThrow('PENDING_COMMAND_INVALID')
 sessionStorage.setItem(key,'{')
 expect(()=>agentControlCommandAttempt(key,semantic)).toThrow('PENDING_COMMAND_INVALID')
 expect(sessionStorage.getItem(key)).toBe('{')
})
it('publishes the control post body and leaves the response readable',async()=>{
 const seen:Array<{intentId:string;deliveryAttemptId:string;action:string}>=[]
 const stop=subscribeControlSubmissions(command=>{seen.push(command)})
 const body={intentId:'00000000-0000-4000-8000-000000000010',deliveryAttemptId:'00000000-0000-4000-8000-000000000011',action:'integration.approve',payload:{artifactId:'artifact'}}
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:'MANAGER_UNAVAILABLE'}),{status:409})))
 const response=await agentControlFetch('/api/v1/ac/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
 expect(seen).toEqual([body])
 expect(await response.json()).toEqual({error:'MANAGER_UNAVAILABLE'})
 await agentControlFetch('/api/v1/ac/contexts/fixture/artifacts/1/diff')
 expect(seen).toHaveLength(1)
 stop()
})
