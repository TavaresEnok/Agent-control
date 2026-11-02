import {afterEach,expect,it,vi} from 'vitest'
import {setApiScope} from '@open-mercato/cezar-api-client'
import {agentControlFetch} from './agent-control-fetch'
afterEach(()=>{setApiScope(null);vi.unstubAllGlobals()})
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
