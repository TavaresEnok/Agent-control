import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {afterEach,expect,it,vi} from 'vitest'
import {AgentControlIntegrationApproval} from './agent-control-integration-approval'
const artifact={id:'00000000-0000-4000-8000-000000000001',commit_id:'a'.repeat(40),tree_id:'b'.repeat(40),base_id:'c'.repeat(40),identity_digest:'d'.repeat(64),
 policy_revision:2,target_ref:'refs/heads/protected',approved:false,canceled:false}
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
for(const truncated of [false,true])it(`approves only an identity-matched complete preview, truncated=${truncated}`,async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({artifactId:artifact.id,artifactDigest:artifact.identity_digest,commit:artifact.commit_id,
  tree:artifact.tree_id,base:artifact.base_id,diff:'+fixture',truncated,diffSha256:'e'.repeat(64)}))))
 const approve=vi.fn(),client=new QueryClient({defaultOptions:{queries:{retry:false}}})
 render(<QueryClientProvider client={client}><AgentControlIntegrationApproval contextId="fixture" artifact={artifact} canApprove busy={false} onApprove={approve}/></QueryClientProvider>)
 const button=screen.getByText('Aprovar integração deste commit') as HTMLButtonElement
 expect(button.disabled).toBe(true)
 fireEvent.click(screen.getByText('Ver alterações deste artefato'))
 await waitFor(()=>expect(screen.getByText('+fixture')).toBeTruthy())
 expect(button.disabled).toBe(truncated)
 fireEvent.click(button)
 expect(approve).toHaveBeenCalledTimes(truncated?0:1)
 if(!truncated)expect(approve).toHaveBeenCalledWith({artifactId:artifact.id,artifactDigest:artifact.identity_digest,policyRevision:2,targetRef:artifact.target_ref})
 client.clear()
})
