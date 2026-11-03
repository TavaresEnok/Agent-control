import '@xyflow/react/dist/style.css'
import {useMutation,useQueries,useQuery,useQueryClient} from '@tanstack/react-query'
import {useEffect,useMemo,useState} from 'react'
import {Background,Controls,ReactFlow,ReactFlowProvider,type Node,type NodeProps,type Edge} from '@xyflow/react'
import {managerPlanListSchema,managerPlanPreviewSchema,managerPlanPublishedSchema,managerPlanComparisonSchema,type WorkflowGraph,type WorkflowGraphNode} from '@open-mercato/cezar-api-client'
import {Button} from '@/components/ui/button'
import {autoLayout,parseFrom,portTone} from '@/lib/workflow-graph'
import {GraphNodeView,edgeStyle} from '../workflow-graph/graph-node'
import {SettingsField} from './settings-field'
import {z} from 'zod'
import {agentControlFetch,displayedProposalDigest,displayedProposalIdentity,managerPlanTouchMinPx,narrowManagerPlanQuery,planStartErrorMessage,planStartPayload,ProposalIdentityMismatch,proposalMatchesSummary,settleDisplayedProposalIdentities,type SettledProposalIdentity} from './agent-control-fetch'

export {managerPlanTouchMinPx,narrowManagerPlanQuery}

function useNarrowManagerPlanViewport(){
 const [narrow,setNarrow]=useState(false)
 useEffect(()=>{
  const media=window.matchMedia?.(narrowManagerPlanQuery)
  if(!media)return
  const update=()=>setNarrow(media.matches)
  update()
  media.addEventListener('change',update)
  return ()=>media.removeEventListener('change',update)
 },[])
 return narrow
}

async function read(path:string){
 const response=await agentControlFetch(path)
 if(!response.ok)throw Error(`Não foi possível carregar o plano (HTTP ${response.status}).`)
 return response.json() as Promise<unknown>
}
function ProposalNode({data}:NodeProps<Node<{node:WorkflowGraphNode}>>){
 return <GraphNodeView node={data.node} connectable={false}/>
}
const nodeTypes={proposal:ProposalNode}
/** The same graph cards and layout as the native editor; the graph itself is read-only. */
function ProposalGraph({graph}:{graph:WorkflowGraph}){
 const {nodes,edges}=useMemo(()=>{
  const positions=autoLayout(graph)
  const nodes:Node<{node:WorkflowGraphNode}>[]=graph.nodes.map(node=>({id:node.id,type:'proposal',position:positions[node.id]??{x:0,y:0},
   draggable:false,connectable:false,data:{node}}))
  const edges:Edge[]=graph.edges.flatMap((edge,index)=>{
   const source=parseFrom(edge.from,graph.nodes),node=graph.nodes.find(node=>node.id===source?.node)
   return source&&node?[{id:`proposal-edge-${index}`,source:source.node,sourceHandle:source.port,target:edge.to,
    type:'smoothstep',style:edgeStyle({tone:portTone(node,source.port),back:false,emphasis:'dim'})}]:[]
  })
  return {nodes,edges}
 },[graph])
 return <div className="h-[420px] min-w-0 overflow-hidden rounded-md border" aria-label="Grafo proposto, somente leitura">
  <ReactFlowProvider><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false}
   elementsSelectable={false} fitView fitViewOptions={{padding:0.15,maxZoom:1}} minZoom={0.1} colorMode="system" proOptions={{hideAttribution:true}}>
   <Background/><Controls showInteractive={false}/>
  </ReactFlow></ReactFlowProvider>
 </div>
}
function ProposalParallelism({value,busy,onSave,touch}:{value:number;busy:boolean;onSave:(value:number)=>void;touch:boolean}){
 const [parallelism,setParallelism]=useState(value)
 const touchStyle=touch?{minHeight:managerPlanTouchMinPx,minWidth:managerPlanTouchMinPx}:undefined
 return <div className="flex flex-wrap items-center gap-2"><label>Paralelismo desejado <select value={parallelism} disabled={busy} aria-label={touch?'Paralelismo desejado':undefined} className={touch?'max-w-full':undefined} style={touchStyle} onChange={e=>setParallelism(Number(e.target.value))}>
  {Array.from({length:10},(_,i)=><option key={i+1} value={i+1}>{i+1}</option>)}
 </select></label><Button type="button" variant="outline" className={touch?'h-auto whitespace-normal':undefined} style={touchStyle} disabled={busy||parallelism===value} onClick={()=>onSave(parallelism)}>Salvar como nova proposta</Button>
 <p className="text-xs text-muted-foreground">O limite de capacidade continua valendo. Dependências e arquivos compartilhados reduzem o paralelismo. Planos já aceitos permanecem preservados.</p></div>
}
const acceptedCommandSchema=z.object({intentId:z.string().uuid(),runId:z.string().uuid(),state:z.string()})
/** A matching or failed preview can stay fresh. A divergent one must not, so retry can replace it. */
function managerPlanIdentityStaleTime(query:{state:{data?:SettledProposalIdentity}}):number{
 const status=query.state.data?.status
 if(status==='ready'||status==='failed')return Infinity
 return 0
}
export function AgentControlManagerPlans({contextId,policyRevision,principalId,projectId}:{contextId:string;policyRevision:number|null;principalId:string;projectId:string}){
 const [selectedRevision,setSelectedRevision]=useState<number|null>(null)
 const narrow=useNarrowManagerPlanViewport()
 const cache=useQueryClient()
 const summaries=useQuery({queryKey:['ac-manager-plans',contextId,projectId],enabled:!!contextId,refetchInterval:5000,
  queryFn:async()=>managerPlanListSchema.parse(await read(`/api/v1/ac/contexts/${contextId}/manager-plans`))})
 const selected=useQuery({queryKey:['ac-manager-plan',contextId,selectedRevision,projectId],enabled:!!contextId&&selectedRevision!==null,
  queryFn:async()=>managerPlanPreviewSchema.parse(await read(`/api/v1/ac/contexts/${contextId}/manager-plans/${selectedRevision}`))})
 const listed=summaries.data?.proposals??[]
 // A failed or divergent preview is stored as data for that revision only. Retry calls refetch, which ignores freshness.
 const identityQueries=useQueries({queries:listed.map(plan=>({
  queryKey:['ac-manager-plan-identity',contextId,projectId,plan.revision,plan.digest],
  enabled:narrow&&!!contextId,staleTime:managerPlanIdentityStaleTime,
  queryFn:async():Promise<SettledProposalIdentity>=>{
   const [row]=await settleDisplayedProposalIdentities([async()=>{
    const preview=managerPlanPreviewSchema.parse(await read(`/api/v1/ac/contexts/${contextId}/manager-plans/${plan.revision}`))
    const identity=displayedProposalIdentity(preview)
    if(!proposalMatchesSummary(identity,plan))throw new ProposalIdentityMismatch()
    return identity
   }])
   return row??{status:'failed'}
  },
 }))})
 const latestRevision=summaries.data?.proposals[0]?.revision
 const comparison=useQuery({queryKey:['ac-manager-plan-comparison',contextId,selectedRevision,latestRevision,projectId],
  enabled:selectedRevision!==null&&latestRevision!==undefined&&selectedRevision<latestRevision,
  queryFn:async()=>managerPlanComparisonSchema.parse(await read(`/api/v1/ac/contexts/${contextId}/manager-plans/${selectedRevision}/compare/${latestRevision}`))})
 const restore=useMutation({mutationFn:async()=>{
  if(!selectedRevision||!latestRevision||selectedRevision>=latestRevision)throw Error('Selecione uma revisão já registrada.')
  const response=await agentControlFetch(`/api/v1/ac/contexts/${contextId}/manager-plans/${selectedRevision}/restore`,{method:'POST',
   headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision:latestRevision})})
  if(!response.ok)throw Error(`Não foi possível restaurar a proposta (HTTP ${response.status}). Recarregue as versões antes de tentar novamente.`)
  return managerPlanPublishedSchema.parse(await response.json())
 },onSuccess:value=>{setSelectedRevision(value.revision);void cache.invalidateQueries({queryKey:['ac-manager-plans',contextId]})},
 onError:()=>{void cache.invalidateQueries({queryKey:['ac-manager-plans',contextId]})}})
 const saveParallelism=useMutation({mutationFn:async(parallelism:number)=>{
  if(!selected.data||latestRevision===undefined||selected.data.revision!==latestRevision)throw Error('Selecione a proposta mais recente antes de alterar o paralelismo.')
  const response=await agentControlFetch(`/api/v1/ac/contexts/${contextId}/manager-plans`,{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({expectedRevision:latestRevision,plan:{...selected.data.plan,parallelism}})})
  if(!response.ok)throw Error(`Não foi possível salvar o paralelismo (HTTP ${response.status}). Recarregue as versões.`)
  return managerPlanPublishedSchema.parse(await response.json())
 },onSuccess:value=>{setSelectedRevision(value.revision);void cache.invalidateQueries({queryKey:['ac-manager-plans',contextId]})},
 onError:()=>{void cache.invalidateQueries({queryKey:['ac-manager-plans',contextId]})}})
 const selectedIdentity=selected.data?displayedProposalIdentity(selected.data):null
 const selectedSummary=selectedIdentity?listed.find(plan=>plan.revision===selectedIdentity.revision):undefined
 const startReady=!!selectedIdentity&&!!selectedSummary&&proposalMatchesSummary(selectedIdentity,selectedSummary)&&selectedRevision===selectedIdentity.revision
 const start=useMutation({mutationFn:async()=>{
  try{
   if(!selected.data||!policyRevision)throw Error(planStartErrorMessage('PROPOSAL_NOT_READY'))
   const identity=displayedProposalIdentity(selected.data)
   const summary=listed.find(plan=>plan.revision===identity.revision)
   if(!summary||!proposalMatchesSummary(identity,summary)||selectedRevision!==identity.revision)throw Error(planStartErrorMessage('PROPOSAL_NOT_READY'))
   const payload=planStartPayload(identity)
   const semantic=JSON.stringify({contextId,policyRevision,payload})
   const key=`ac-start:${encodeURIComponent(principalId)}:${projectId}:${contextId}:${selected.data.digest}:${policyRevision}`
   let raw:unknown
   try{raw=JSON.parse(sessionStorage.getItem(key)||'null')}catch{throw Error(planStartErrorMessage('PENDING_COMMAND_INVALID'))}
   const saved=z.object({semantic:z.string(),intentId:z.string().uuid()}).safeParse(raw)
   if(raw!==null&&(!saved.success||saved.data.semantic!==semantic))throw Error(planStartErrorMessage('PENDING_COMMAND_INVALID'))
   const intentId=saved.success&&saved.data.semantic===semantic?saved.data.intentId:crypto.randomUUID()
   sessionStorage.setItem(key,JSON.stringify({semantic,intentId}))
   const response=await agentControlFetch('/api/v1/ac/commands',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({schemaVersion:1,intentId,deliveryAttemptId:crypto.randomUUID(),contextId,policyRevision,action:'plan.start',payload})})
   let value:unknown
   try{value=await response.json()}catch{throw Error(planStartErrorMessage(`HTTP_${response.status}`))}
   if(!response.ok){
    const error=z.object({error:z.string()}).safeParse(value)
    throw Error(planStartErrorMessage(error.success?error.data.error:`HTTP_${response.status}`))
   }
   const accepted=acceptedCommandSchema.safeParse(value)
   if(!accepted.success||accepted.data.intentId!==intentId)throw Error(planStartErrorMessage('COMMAND_RESPONSE_MISMATCH'))
   return accepted.data
  }catch(error){
   const message=error instanceof Error?error.message:''
   throw Error(planStartErrorMessage(message))
  }
 },onSuccess:()=>{void cache.invalidateQueries({queryKey:['ac-resources',contextId]})}})
 return <SettingsField title="Planejamento do gerente" hint="Propostas versionadas com dependências, contratos e critérios de aceite. Consultar uma proposta preserva os planos já aceitos e as pausas.">
  {summaries.isPending&&<p role="status">Carregando propostas…</p>}
  {summaries.error&&<p role="alert">{summaries.error.message}</p>}
  {summaries.data?.proposals.length===0&&<p>Nenhuma proposta registrada nesta conversa.</p>}
  <div className={narrow?'flex min-w-0 flex-col gap-2':'flex flex-wrap gap-2'} role="list" aria-label="Propostas desta conversa">{listed.map((plan,index)=>{
   const digest=displayedProposalDigest(plan.digest)
   const identityQuery=identityQueries[index]
   const row=narrow?identityQuery?.data:undefined
   const identity=row?.status==='ready'?row.identity:null
   const failed=row?.status==='failed'
   const mismatched=row?.status==='mismatch'
   const label=identity?`Proposta ${plan.revision}, ${plan.taskCount} tarefas, objetivo ${identity.objectiveRef}, origem ${identity.sourceMessageRef}, identificador ${digest}`:failed?`Proposta ${plan.revision}, ${plan.taskCount} tarefas, identificador ${digest}, objetivo e origem indisponíveis`:mismatched?`Proposta ${plan.revision}, ${plan.taskCount} tarefas, identificador ${digest}, prévia divergente`:`Proposta ${plan.revision}, ${plan.taskCount} tarefas, identificador ${digest}, objetivo e origem ainda não disponíveis`
   const touchStyle={minHeight:managerPlanTouchMinPx,minWidth:managerPlanTouchMinPx}
   const retryIdentity=()=>{if(!identityQuery?.isFetching)void identityQuery?.refetch({cancelRefetch:false})}
   return <div role="listitem" key={plan.revision} className={narrow?'min-w-0 max-w-full':undefined} data-plan-row-state={narrow?row?.status??'pending':undefined}><Button type="button" variant={selectedRevision===plan.revision?'primary':'outline'}
    aria-pressed={selectedRevision===plan.revision} aria-label={narrow?label:undefined}
    className={narrow?'h-auto w-full min-w-0 max-w-full justify-start whitespace-normal px-3 py-2 text-left font-normal':undefined}
    style={narrow?touchStyle:undefined}
    onClick={()=>{if(selectedRevision!==plan.revision)start.reset();setSelectedRevision(plan.revision)}}>
    {narrow?<span className="flex min-w-0 flex-col items-start gap-1"><span>Proposta {plan.revision} · {plan.taskCount} tarefas</span>
     {identity?<><span data-plan-surface="list" data-plan-field="objective">Objetivo: {identity.objectiveRef}</span>
      <span data-plan-surface="list" data-plan-field="origin">Solicitação de origem: {identity.sourceMessageRef}</span></>:
      <span role="status">{failed?'Objetivo e origem desta proposta estão indisponíveis.':mismatched?'A prévia desta proposta divergiu da lista.':'Objetivo e origem desta proposta ainda não estão disponíveis.'}</span>}
     <span id={`plan-listed-digest-${plan.revision}`} data-plan-surface="list" data-plan-field="digest" className="max-w-full break-all font-mono text-xs font-normal">Identificador da proposta: {digest}</span></span>:
     `Proposta ${plan.revision} · ${plan.taskCount} tarefas`}
   </Button>
   {narrow&&(failed||mismatched)&&<div className="mt-1 flex min-w-0 flex-col gap-1">
    <p role="alert">{failed?'Não foi possível carregar o objetivo e a origem desta proposta.':'A prévia recebida divergiu da revisão listada. Nada foi solicitado.'}</p>
    <Button type="button" variant="outline" className="h-auto w-full min-w-0 max-w-full whitespace-normal px-3 py-2 text-left font-normal" style={touchStyle}
     disabled={identityQuery?.isFetching===true}
     aria-label={failed?`Tentar novamente a proposta ${plan.revision}, identificador ${digest}`:`Tentar novamente a prévia divergente da proposta ${plan.revision}`}
     aria-describedby={`plan-listed-digest-${plan.revision}`}
     onClick={retryIdentity}>Tentar novamente</Button>
   </div>}
   </div>})}</div>
  {summaries.data?.hasMore&&<p className="text-xs text-muted-foreground">Exibindo as 100 versões mais recentes.</p>}
  {selected.isFetching&&selectedRevision!==null&&<p role="status">Carregando grafo…</p>}
  {selected.error&&<p role="alert">{selected.error.message}</p>}
  {restore.error&&<p role="alert">{restore.error.message}</p>}
  {restore.isSuccess&&<p role="status">Nova proposta registrada. Planos aceitos continuam preservados.</p>}
  {selected.data&&<div className="flex min-w-0 flex-col gap-3">
   <ProposalParallelism key={`parallelism-${selected.data.revision}`} value={selected.data.plan.parallelism??4} touch={narrow} busy={!startReady||saveParallelism.isPending||latestRevision===undefined||selected.data.revision!==latestRevision} onSave={value=>saveParallelism.mutate(value)}/>
   {saveParallelism.error&&<p role="alert">{saveParallelism.error.message}</p>}
   {!startReady&&<p role="alert">A revisão exibida não confere com o identificador da proposta. A execução não foi solicitada.</p>}
   {narrow&&startReady&&selectedIdentity&&<div data-plan-surface="start" className="min-w-0 max-w-full break-words" aria-label="Execução da proposta selecionada">
    <p data-plan-field="objective">Objetivo: {selectedIdentity.objectiveRef}</p>
    <p data-plan-field="origin">Solicitação de origem: {selectedIdentity.sourceMessageRef}</p>
    <p data-plan-field="digest" className="max-w-full break-all font-mono text-xs">Identificador da proposta: {selectedIdentity.digest}</p>
    <p data-plan-field="revision">Revisão {selectedIdentity.revision}</p>
   </div>}
   <Button type="button" className={narrow?'h-auto w-full min-w-0 max-w-full whitespace-normal':undefined} style={narrow?{minHeight:managerPlanTouchMinPx,minWidth:managerPlanTouchMinPx}:undefined}
    aria-label={narrow&&startReady&&selectedIdentity?`Solicitar execução da proposta ${selectedIdentity.revision}, objetivo ${selectedIdentity.objectiveRef}, origem ${selectedIdentity.sourceMessageRef}, identificador ${selectedIdentity.digest}`:undefined}
    disabled={!policyRevision||!startReady||start.isPending||start.isSuccess||selected.isFetching} onClick={()=>start.mutate()}>Solicitar execução desta proposta</Button>
   {!policyRevision&&<p role="status">Política da conversa indisponível; não é possível solicitar execução.</p>}
   {start.error&&<p role="alert">{planStartErrorMessage(start.error.message)}</p>}
   {start.isSuccess&&<p role="status">Solicitação aceita ({start.data.state}); acompanhe o plano para verificar seu andamento.</p>}
   {latestRevision!==undefined&&selectedRevision!==null&&selectedRevision<latestRevision&&<div className="flex flex-col gap-2">
    <Button type="button" variant="outline" className={narrow?'h-auto w-full whitespace-normal':undefined} style={narrow?{minHeight:managerPlanTouchMinPx,minWidth:managerPlanTouchMinPx}:undefined} disabled={restore.isPending} onClick={()=>restore.mutate()}>Restaurar como nova proposta</Button>
    <p className="text-xs text-muted-foreground">A restauração cria uma versão nova; preserva o histórico, as pausas e os planos já aceitos.</p>
    {comparison.error&&<p role="alert">{comparison.error.message}</p>}
    {comparison.data&&<div className="rounded-md border p-3 text-sm">
     <p>Diferenças até a proposta {comparison.data.toRevision}:</p>
     <p>Adicionadas: {comparison.data.added.join(', ')||'nenhuma'} · removidas: {comparison.data.removed.join(', ')||'nenhuma'}</p>
     {comparison.data.objectiveChanged&&<p>Objetivo alterado.</p>}{comparison.data.constraintsChanged&&<p>Restrições alteradas.</p>}
     {comparison.data.sourceMessageChanged&&<p>Solicitação de origem alterada.</p>}
     {comparison.data.changed.map(change=><p key={change.taskId}>{change.taskId}: {change.fields.join(', ')}</p>)}
    </div>}
   </div>}

   {startReady&&selectedIdentity?<><div className="min-w-0 break-words rounded-md border p-3 text-sm">
    <p role="status">Proposta {selectedIdentity.revision} — este grafo ainda não está em execução.</p>
    <p data-plan-surface="detail" data-plan-field="objective">Objetivo: {selectedIdentity.objectiveRef}</p>
    <p data-plan-surface="detail" data-plan-field="origin">Solicitação de origem: {selectedIdentity.sourceMessageRef}</p>
    <p data-plan-surface="detail" data-plan-field="digest" className="max-w-full break-all">Identificador da proposta: {selectedIdentity.digest}</p>
   </div>
   {selected.data.compilation.workflow.graph&&<ProposalGraph key={`${contextId}-${selected.data.revision}`} graph={selected.data.compilation.workflow.graph}/>}
   <ul className="flex min-w-0 flex-col gap-2">{selected.data.plan.tasks.map(task=><li key={task.id} className="min-w-0 break-words rounded-md border p-3 text-sm">
    <strong>{task.id}</strong><p>Objetivo: {task.objectiveRef}</p><p>Depende de: {task.dependsOn.join(', ')||'nenhuma tarefa'}</p>
    <p>Caminhos de escrita: {task.writePaths.join(', ')}</p><p>Critérios de aceite: {task.acceptanceRefs.join(', ')}</p>
    <p>Política de qualidade {task.qualityRevision} · até {task.maxCorrections} correções · {task.targetRef}</p>
   </li>)}</ul></>:null}
  </div>}
 </SettingsField>
}
