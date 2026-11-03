import {afterEach,expect,it,vi} from 'vitest'
import {setApiScope} from '@open-mercato/cezar-api-client'
import {agentControlFetch,displayedProposalDigest,displayedProposalIdentity,planStartErrorMessage,planStartGenericError,planStartPayload,proposalMatchesSummary,ProposalIdentityMismatch,settleDisplayedProposalIdentities} from './agent-control-fetch'
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
it('rejects an ambiguous proposal digest and keeps plan.start on the full identity',()=>{
 const digest='ab'.repeat(32)
 expect(displayedProposalDigest(digest)).toBe(digest)
 expect(()=>displayedProposalDigest(`${digest.slice(0,8)}…`)).toThrow('PROPOSAL_DIGEST_AMBIGUOUS')
 expect(()=>displayedProposalDigest(digest.slice(0,63))).toThrow('PROPOSAL_DIGEST_AMBIGUOUS')
 const identity=displayedProposalIdentity({revision:4,digest,plan:{objectiveRef:'message:objective',sourceMessageRef:'message:request'}})
 expect(proposalMatchesSummary(identity,{revision:4,digest})).toBe(true)
 expect(proposalMatchesSummary(identity,{revision:4,digest:`${'a'.repeat(63)}b`})).toBe(false)
 expect(planStartPayload(identity)).toEqual({workflow:'managed-synthetic-v1',messageRef:'message:request',proposalRevision:4,proposalDigest:digest})
})
it('keeps valid proposal identities when another preview fails or disagrees',async()=>{
 const secret='preview-token-not-returned'
 const digest='ab'.repeat(32),other='cd'.repeat(32)
 const calls:string[]=[]
 const rows=await settleDisplayedProposalIdentities([
  async()=>{calls.push('ready');return displayedProposalIdentity({revision:1,digest,plan:{objectiveRef:'message:objective-1',sourceMessageRef:'message:request-1'}})},
  async()=>{calls.push('fail');throw Error(`HTTP 500 ${secret}`)},
  async()=>{calls.push('mismatch');throw new ProposalIdentityMismatch()},
  async()=>{calls.push('later');return displayedProposalIdentity({revision:4,digest:other,plan:{objectiveRef:'message:objective-4',sourceMessageRef:'message:request-4'}})},
 ])
 expect(calls).toEqual(['ready','fail','mismatch','later'])
 expect(rows.map(row=>row.status)).toEqual(['ready','failed','mismatch','ready'])
 expect(rows[0]).toEqual({status:'ready',identity:{revision:1,digest,objectiveRef:'message:objective-1',sourceMessageRef:'message:request-1'}})
 expect(rows[3]).toEqual({status:'ready',identity:{revision:4,digest:other,objectiveRef:'message:objective-4',sourceMessageRef:'message:request-4'}})
 expect(JSON.stringify(rows)).not.toContain(secret)
 expect(await settleDisplayedProposalIdentities([])).toEqual([])
})
it('keeps recognized plan.start codes and drops any other error text',()=>{
 const secret='Bearer eyJhbGciOiJIUzI1NiJ9.leak-token'
 expect(planStartErrorMessage('MANAGER_UNAVAILABLE')).toBe('MANAGER_UNAVAILABLE')
 expect(planStartErrorMessage('HTTP_409')).toBe('HTTP_409')
 expect(planStartErrorMessage('PROPOSAL_NOT_READY')).toBe('PROPOSAL_NOT_READY')
 for(const raw of [secret,`MANAGER_UNAVAILABLE ${secret}`,`HTTP_409 ${secret}`,'HTTP_','HTTP_99','http_500','']){
  const message=planStartErrorMessage(raw)
  expect(message).toBe(planStartGenericError)
  expect(message).not.toContain(secret)
  expect(message).not.toContain('Bearer')
  if(raw)expect(message).not.toContain(raw)
 }
})
