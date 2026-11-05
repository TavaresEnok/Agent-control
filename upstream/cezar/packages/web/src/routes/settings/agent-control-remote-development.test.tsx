import {cleanup,fireEvent,render,screen} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {afterEach,expect,it,vi} from 'vitest'
import {AgentControlRemoteDevelopment} from './agent-control-remote-development'
import {signControl} from './agent-control-operator'
vi.mock('./agent-control-operator',()=>({signControl:vi.fn().mockResolvedValue('synthetic-proof')}))
afterEach(()=>{cleanup();sessionStorage.clear();vi.unstubAllGlobals();vi.clearAllMocks()})
const projectId='00000000-0000-4000-8000-000000000001',contextId='00000000-0000-4000-8000-000000000002',hostId='00000000-0000-4000-8000-000000000003',installationId='00000000-0000-4000-8000-000000000004',sourceOperationId='00000000-0000-4000-8000-000000000005'
const candidate={projectId,contextId,hostId,sourceOperationId,intentId:sourceOperationId,label:'Disposable',commit:'a'.repeat(40),tree:'b'.repeat(40)}
function panel(candidates=[candidate],workspaces:Parameters<typeof AgentControlRemoteDevelopment>[0]['view']['workspaces']=[]){const client=new QueryClient({defaultOptions:{mutations:{retry:false}}});return render(<QueryClientProvider client={client}><AgentControlRemoteDevelopment principalId="synthetic" installationId={installationId} projectId={projectId} view={{configured:true,candidates,workspaces}}/></QueryClientProvider>)}
it('recovers a signed pending prepare after lost ACK even when its candidate disappears',async()=>{
 const requests:Array<{intentId:string;deliveryAttemptId:string;payload:{projectId:string;contextId:string;workspaceId:string}}>=[]
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>{const body=JSON.parse(String(init.body));requests.push(body);if(requests.length===1)throw Error('ACK_LOST');return Response.json({state:'prepared',projectId:body.payload.projectId,contextId:body.payload.contextId,workspaceId:body.payload.workspaceId,commit:'a'.repeat(40),tree:'b'.repeat(40)})}))
 const first=panel();fireEvent.click(screen.getByRole('button',{name:'Preparar workspace remoto'}));expect(await screen.findByRole('alert')).toHaveProperty('textContent','ACK_LOST')
 first.unmount();panel([]);fireEvent.click(screen.getByRole('button',{name:'Confirmar pedido remoto pendente'}));expect(await screen.findByText('Pedido remoto confirmado. O artefato continua não revisado.')).toBeTruthy()
 expect(requests).toHaveLength(2);expect(requests[1]!.intentId).toBe(requests[0]!.intentId);expect(requests[1]!.deliveryAttemptId).not.toBe(requests[0]!.deliveryAttemptId);expect(requests[1]!.payload).toEqual(requests[0]!.payload);expect(signControl).toHaveBeenCalledTimes(2);expect(sessionStorage.length).toBe(0)
})
it('signs only the configured launch identifiers and requires unreviewed registration identity',async()=>{
 const workspaceId='00000000-0000-4000-8000-000000000006',requests:Record<string,unknown>[]=[]
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>{const body=JSON.parse(String(init.body));requests.push(body);return Response.json({state:'launched',...body.payload,implementationState:'uncertain'})}))
 panel([],[{projectId,contextId,workspaceId,hostId,state:'prepared'}]);fireEvent.click(screen.getByRole('button',{name:'Executar tarefa remota configurada'}));expect(await screen.findByText('Pedido remoto confirmado. O artefato continua não revisado.')).toBeTruthy();expect(requests[0]!.payload).toEqual({projectId,contextId,workspaceId});expect(JSON.stringify(requests)).not.toContain('taskId')
 cleanup();panel([],[{projectId,contextId,workspaceId,hostId,state:'prepared',implementationState:'uncertain',emissionPhase:'emitting'}]);fireEvent.click(screen.getByRole('button',{name:'Registrar artefato remoto'}));expect(await screen.findByRole('alert')).toHaveProperty('textContent','COMMAND_RESPONSE_MISMATCH');expect(sessionStorage.length).toBe(1)
})
it('does not offer another project candidate or an unconfigured task',()=>{panel([{...candidate,projectId:installationId}]);expect(screen.queryByRole('button',{name:'Preparar workspace remoto'})).toBeNull();expect(screen.queryByRole('textbox')).toBeNull()})
