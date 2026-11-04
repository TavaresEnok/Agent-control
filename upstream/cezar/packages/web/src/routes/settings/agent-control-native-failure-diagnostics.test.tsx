import {cleanup,fireEvent,render,screen} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {afterEach,expect,it,vi} from 'vitest'
import {agentControlDiagnosticsSchema} from '@open-mercato/cezar-api-client'
import {ProjectScopeProvider} from '@/api/project-scope-context'
import {AgentControlDiagnostics} from './agent-control-diagnostics'

const contextId='33333333-3333-4333-8333-333333333333'
const projectId='44444444-4444-4444-8444-444444444444'
const jobId='11111111-1111-4111-8111-111111111111'
const leaked='STDOUT_SENTINEL_/tmp/native-key.pem'
afterEach(()=>{cleanup();vi.unstubAllGlobals()})

it('shows the safe native failure from the existing diagnostics contract and keeps a legacy finding',async()=>{
 const native=agentControlDiagnosticsSchema.parse({contextId,truncated:false,assessment:'observed',findings:[{
  code:'native_execution_failed',
  meaning:'Um job de execução nativa deste contexto está armazenado como falha terminal.',
  owner:'Supervisor de execução nativa',
  nextCondition:'Conservar o job citado. Esta consulta não altera execução, seleção ou recuperação.',
  evidence:[{kind:'native_execution_job',id:jobId},{kind:'operation',id:jobId}],
  nativeFailure:{cause:'invalid_scope',origin:'stored_agreement'},
 }]})
 const legacy=agentControlDiagnosticsSchema.parse({contextId,truncated:false,assessment:'observed',findings:[{
  code:'context_paused',meaning:'A pausa humana está ativa.',owner:'Operador do contexto',nextCondition:'Retomada explícita e autorizada.',
  evidence:[{kind:'context',id:contextId}],
 }]})
 let mode:'native'|'legacy'='native'
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(mode==='native'?native:legacy))))
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}})
 render(<QueryClientProvider client={client}><ProjectScopeProvider projectId={projectId}><AgentControlDiagnostics contextId={contextId}/></ProjectScopeProvider></QueryClientProvider>)
 await screen.findByText('Motivo seguro: O finalizador registrou escopo inválido.')
 expect(screen.getByText('Observação: Registros ligados concordam nesta leitura. Assinatura e recibo não foram verificados.')).toBeTruthy()
 expect(screen.getByText(native.findings[0]!.meaning)).toBeTruthy()
 fireEvent.click(screen.getByText('Referências (2)'))
 expect(screen.getByText(`native_execution_job: ${jobId}`)).toBeTruthy()
 expect(screen.getByText(`operation: ${jobId}`)).toBeTruthy()
 expect(document.body.textContent?.includes(leaked)).toBe(false)
 expect(document.body.textContent?.includes('invalid_scope')).toBe(false)
 expect(document.body.textContent?.includes('QUOTA_EXHAUSTED')).toBe(false)
 mode='legacy'
 fireEvent.click(screen.getByRole('button',{name:'Atualizar diagnóstico'}))
 await screen.findByText('A pausa humana está ativa.')
 expect(screen.queryByText(/Motivo seguro/)).toBeNull()
 expect(document.body.textContent?.includes(leaked)).toBe(false)
 client.clear()
})
