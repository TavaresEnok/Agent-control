import {cleanup,fireEvent,render,screen} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {afterEach,expect,it,vi} from 'vitest'
import {AgentControlRemoteReturn,remoteReturnCandidateKey} from './agent-control-remote-return'
import {signControl} from './agent-control-operator'
vi.mock('./agent-control-operator',()=>({signControl:vi.fn().mockResolvedValue('synthetic-proof')}))
afterEach(()=>{cleanup();sessionStorage.clear();vi.unstubAllGlobals();vi.clearAllMocks()})
const candidate={projectId:'00000000-0000-4000-8000-000000000001',contextId:'00000000-0000-4000-8000-000000000002',hostId:'00000000-0000-4000-8000-000000000003',artifactId:'00000000-0000-4000-8000-000000000004',commit:'ab'.repeat(20),tree:'cd'.repeat(20),destinationRef:'refs/heads/reviewed',expectedCommit:'ef'.repeat(20)}
function panel(){const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});return render(<QueryClientProvider client={client}><AgentControlRemoteReturn principalId="synthetic" installationId="00000000-0000-4000-8000-000000000005" candidates={[candidate]} receipts={[]}/></QueryClientProvider>)}
it('retains an ambiguous signed return across remount, reuses intent and never accepts bundle bytes',async()=>{
 const requests:Record<string,unknown>[]=[]
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>{const body=JSON.parse(String(init.body));requests.push(body);return requests.length===1?Response.json({error:'TRANSPORT_UNCERTAIN'},{status:503}):Response.json({state:'returned',projectId:candidate.projectId,artifactId:candidate.artifactId,operationId:body.intentId,destinationRef:candidate.destinationRef})}))
 const first=panel();fireEvent.change(screen.getByLabelText('Artefato aprovado'),{target:{value:remoteReturnCandidateKey(candidate)}});fireEvent.click(screen.getByRole('button',{name:'Devolver artefato aprovado'}));expect(await screen.findByRole('alert')).toHaveProperty('textContent','TRANSPORT_UNCERTAIN')
 first.unmount();panel();fireEvent.click(screen.getByRole('button',{name:'Confirmar devolução pendente'}));expect(await screen.findByText('Devolução confirmada e persistida.')).toBeTruthy()
 expect(requests).toHaveLength(2);expect(requests[0]!.intentId).toBe(requests[1]!.intentId);expect(requests[0]!.deliveryAttemptId).not.toBe(requests[1]!.deliveryAttemptId)
 expect(requests[1]!.payload).toEqual({projectId:candidate.projectId,contextId:candidate.contextId,hostId:candidate.hostId,artifactId:candidate.artifactId,destinationRef:candidate.destinationRef});expect(sessionStorage.length).toBe(0);expect(signControl).toHaveBeenCalledTimes(2)
})
it('preserves the pending operation when the server response is inconsistent',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({state:'returned',projectId:candidate.contextId,artifactId:candidate.artifactId,operationId:candidate.contextId,destinationRef:candidate.destinationRef})))
 panel();fireEvent.change(screen.getByLabelText('Artefato aprovado'),{target:{value:remoteReturnCandidateKey(candidate)}});fireEvent.click(screen.getByRole('button',{name:'Devolver artefato aprovado'}));expect(await screen.findByRole('alert')).toHaveProperty('textContent','COMMAND_RESPONSE_MISMATCH');expect(sessionStorage.length).toBe(1)
})

it('distinguishes two destinations approved for the same artifact',async()=>{
 const other={...candidate,destinationRef:'refs/heads/second-reviewed'}
 let payload:unknown
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>{const command=JSON.parse(String(init.body));payload=command.payload;return Response.json({state:'returned',projectId:other.projectId,artifactId:other.artifactId,operationId:command.intentId,destinationRef:other.destinationRef})}))
 const cache=new QueryClient({defaultOptions:{mutations:{retry:false}}});render(<QueryClientProvider client={cache}><AgentControlRemoteReturn principalId="synthetic" installationId="00000000-0000-4000-8000-000000000005" candidates={[candidate,other]} receipts={[]}/></QueryClientProvider>)
 fireEvent.change(screen.getByLabelText('Artefato aprovado'),{target:{value:remoteReturnCandidateKey(other)}});fireEvent.click(screen.getByRole('button',{name:'Devolver artefato aprovado'}));expect(await screen.findByText('Devolução confirmada e persistida.')).toBeTruthy();expect(payload).toMatchObject({destinationRef:other.destinationRef})
})
