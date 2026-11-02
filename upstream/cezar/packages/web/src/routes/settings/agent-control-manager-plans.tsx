import '@xyflow/react/dist/style.css'
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query'
import {useMemo,useState} from 'react'
import {Background,Controls,ReactFlow,ReactFlowProvider,type Node,type NodeProps,type Edge} from '@xyflow/react'
import {managerPlanListSchema,managerPlanPreviewSchema,managerPlanPublishedSchema,managerPlanComparisonSchema,type WorkflowGraph,type WorkflowGraphNode} from '@open-mercato/cezar-api-client'
import {Button} from '@/components/ui/button'
import {autoLayout,parseFrom,portTone} from '@/lib/workflow-graph'
import {GraphNodeView,edgeStyle} from '../workflow-graph/graph-node'
import {SettingsField} from './settings-field'
import {z} from 'zod'
import {agentControlFetch} from './agent-control-fetch'

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
const acceptedCommandSchema=z.object({intentId:z.string().uuid(),runId:z.string().uuid(),state:z.string()})
export function AgentControlManagerPlans({contextId,policyRevision,principalId,projectId}:{contextId:string;policyRevision:number|null;principalId:string;projectId:string}){
 const [selectedRevision,setSelectedRevision]=useState<number|null>(null)
 const cache=useQueryClient()
 const summaries=useQuery({queryKey:['ac-manager-plans',contextId,projectId],enabled:!!contextId,refetchInterval:5000,
  queryFn:async()=>managerPlanListSchema.parse(await read(`/api/v1/ac/contexts/${contextId}/manager-plans`))})
 const selected=useQuery({queryKey:['ac-manager-plan',contextId,selectedRevision,projectId],enabled:!!contextId&&selectedRevision!==null,
  queryFn:async()=>managerPlanPreviewSchema.parse(await read(`/api/v1/ac/contexts/${contextId}/manager-plans/${selectedRevision}`))})
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
 const start=useMutation({mutationFn:async()=>{
  if(!selected.data||!policyRevision)throw Error('PROPOSAL_NOT_READY')
  const payload={workflow:'managed-synthetic-v1' as const,messageRef:selected.data.plan.sourceMessageRef,
   proposalRevision:selected.data.revision,proposalDigest:selected.data.digest}
  const semantic=JSON.stringify({contextId,policyRevision,payload})
  const key=`ac-start:${encodeURIComponent(principalId)}:${projectId}:${contextId}:${selected.data.digest}:${policyRevision}`
  let raw:unknown
  try{raw=JSON.parse(sessionStorage.getItem(key)||'null')}catch{throw Error('PENDING_COMMAND_INVALID')}
  const saved=z.object({semantic:z.string(),intentId:z.string().uuid()}).safeParse(raw)
  if(raw!==null&&(!saved.success||saved.data.semantic!==semantic))throw Error('PENDING_COMMAND_INVALID')
  const intentId=saved.success&&saved.data.semantic===semantic?saved.data.intentId:crypto.randomUUID()
  sessionStorage.setItem(key,JSON.stringify({semantic,intentId}))
  const response=await agentControlFetch('/api/v1/ac/commands',{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({schemaVersion:1,intentId,deliveryAttemptId:crypto.randomUUID(),contextId,policyRevision,action:'plan.start',payload})})
  const value:unknown=await response.json()
  if(!response.ok){const error=z.object({error:z.string()}).safeParse(value);throw Error(error.success?error.data.error:`HTTP_${response.status}`)}
  const accepted=acceptedCommandSchema.parse(value)
  if(accepted.intentId!==intentId)throw Error('COMMAND_RESPONSE_MISMATCH')
  return accepted
 },onSuccess:()=>{void cache.invalidateQueries({queryKey:['ac-resources',contextId]})}})
 return <SettingsField title="Planejamento do gerente" hint="Propostas versionadas com dependências, contratos e critérios de aceite. Consultar uma proposta preserva os planos já aceitos e as pausas.">
  {summaries.isPending&&<p role="status">Carregando propostas…</p>}
  {summaries.error&&<p role="alert">{summaries.error.message}</p>}
  {summaries.data?.proposals.length===0&&<p>Nenhuma proposta registrada nesta conversa.</p>}
  <div className="flex flex-wrap gap-2">{summaries.data?.proposals.map(plan=><Button key={plan.revision} type="button" variant={selectedRevision===plan.revision?'primary':'outline'}
   aria-pressed={selectedRevision===plan.revision} onClick={()=>{if(selectedRevision!==plan.revision)start.reset();setSelectedRevision(plan.revision)}}>Proposta {plan.revision} · {plan.taskCount} tarefas</Button>)}</div>
  {summaries.data?.hasMore&&<p className="text-xs text-muted-foreground">Exibindo as 100 versões mais recentes.</p>}
  {selected.isFetching&&selectedRevision!==null&&<p role="status">Carregando grafo…</p>}
  {selected.error&&<p role="alert">{selected.error.message}</p>}
  {restore.error&&<p role="alert">{restore.error.message}</p>}
  {restore.isSuccess&&<p role="status">Nova proposta registrada. Planos aceitos continuam preservados.</p>}
  {selected.data&&<div className="flex min-w-0 flex-col gap-3">
   <Button type="button" disabled={!policyRevision||start.isPending||start.isSuccess||selected.isFetching} onClick={()=>start.mutate()}>Solicitar execução desta proposta</Button>
   {!policyRevision&&<p role="status">Política da conversa indisponível; não é possível solicitar execução.</p>}
   {start.error&&<p role="alert">{start.error.message}</p>}
   {start.isSuccess&&<p role="status">Solicitação aceita ({start.data.state}); acompanhe o plano para verificar seu andamento.</p>}
   {latestRevision!==undefined&&selectedRevision!==null&&selectedRevision<latestRevision&&<div className="flex flex-col gap-2">
    <Button type="button" variant="outline" disabled={restore.isPending} onClick={()=>restore.mutate()}>Restaurar como nova proposta</Button>
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

   <div className="min-w-0 break-words rounded-md border p-3 text-sm">
    <p role="status">Proposta {selected.data.revision} — este grafo ainda não está em execução.</p>
    <p>Objetivo: {selected.data.plan.objectiveRef}</p>
    <p>Solicitação de origem: {selected.data.plan.sourceMessageRef}</p>
    <p className="break-all">Identificador da proposta: {selected.data.digest}</p>
   </div>
   {selected.data.compilation.workflow.graph&&<ProposalGraph key={`${contextId}-${selected.data.revision}`} graph={selected.data.compilation.workflow.graph}/>}
   <ul className="flex min-w-0 flex-col gap-2">{selected.data.plan.tasks.map(task=><li key={task.id} className="min-w-0 break-words rounded-md border p-3 text-sm">
    <strong>{task.id}</strong><p>Objetivo: {task.objectiveRef}</p><p>Depende de: {task.dependsOn.join(', ')||'nenhuma tarefa'}</p>
    <p>Caminhos de escrita: {task.writePaths.join(', ')}</p><p>Critérios de aceite: {task.acceptanceRefs.join(', ')}</p>
    <p>Política de qualidade {task.qualityRevision} · até {task.maxCorrections} correções · {task.targetRef}</p>
   </li>)}</ul>
  </div>}
 </SettingsField>
}
