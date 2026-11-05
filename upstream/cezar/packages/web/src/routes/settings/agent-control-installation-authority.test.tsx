import {cleanup,fireEvent,render,screen} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {afterEach,expect,it,vi} from 'vitest'
import {AgentControlInstallationAuthority} from './agent-control-installation-authority'
vi.mock('./agent-control-operator',()=>({signControl:vi.fn().mockResolvedValue('synthetic-proof')}))
afterEach(()=>{cleanup();sessionStorage.clear();vi.unstubAllGlobals()})
const domain='00000000-0000-4000-8000-000000000001',installation='00000000-0000-4000-8000-000000000002'
function panel(){const cache=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});return render(<QueryClientProvider client={cache}><AgentControlInstallationAuthority/></QueryClientProvider>)}
it('replays the original epoch after ACK loss and a newer domain projection, even across reload',async()=>{
 const sent:Record<string,unknown>[]=[];let epoch=1
 vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit={})=>{
  if(url.endsWith('/operator/identity'))return Response.json({principalId:'synthetic',installationId:installation})
  if(init.method!=='POST')return Response.json({mode:'synthetic-laboratory',operationalActivation:'blocked',domain:{id:domain,holder_installation_id:installation,epoch,paused:epoch>1},installations:[{id:installation,label:'R3 synthetic'}]})
  sent.push(JSON.parse(String(init.body)));epoch=2
  return sent.length===1?Response.json({error:'ACK_LOST'},{status:503}):Response.json({state:'applied',token:{domainId:domain,installationId:installation,epoch:1},paused:true})
 }))
 const first=panel();expect(screen.queryByText('Pausar autoridade de laboratório')).toBeNull();fireEvent.change(screen.getByLabelText('Domínio de laboratório'),{target:{value:domain}});fireEvent.click(screen.getByRole('button',{name:'Consultar autoridade'}));fireEvent.click(await screen.findByRole('button',{name:'Pausar autoridade de laboratório'}));expect(await screen.findByText('ACK_LOST')).toBeTruthy();first.unmount()
 panel();fireEvent.change(screen.getByLabelText('Domínio de laboratório'),{target:{value:domain}});fireEvent.click(screen.getByRole('button',{name:'Consultar autoridade'}));fireEvent.click(await screen.findByRole('button',{name:'Confirmar alteração de autoridade pendente'}));expect(await screen.findByText('Alteração de autoridade confirmada.')).toBeTruthy()
 expect(sent).toHaveLength(2);expect(sent[0]!.payload).toEqual({expectedEpoch:1,paused:true});expect(sent[1]!.payload).toEqual(sent[0]!.payload);expect(sent[1]!.intentId).toBe(sent[0]!.intentId);expect(sent[1]!.deliveryAttemptId).not.toBe(sent[0]!.deliveryAttemptId);expect(sessionStorage.length).toBe(0)
})
