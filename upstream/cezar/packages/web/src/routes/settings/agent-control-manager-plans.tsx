import '@xyflow/react/dist/style.css'
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query'
import {useMemo,useState} from 'react'
import {Background,Controls,ReactFlow,ReactFlowProvider,type Node,type NodeProps,type Edge} from '@xyflow/react'
import {managerPlanListSchema,managerPlanPreviewSchema,managerPlanPublishedSchema,managerPlanComparisonSchema,type WorkflowGraph,type WorkflowGraphNode} from '@open-mercato/cezar-api-client'
import {Button} from '@/components/ui/button'
import {autoLayout,parseFrom,portTone} from '@/lib/workflow-graph'
import {GraphNodeView,edgeStyle} from '../workflow-graph/graph-node'
import {SettingsField} from './settings-field'

async function read(path:string){
 const response=await fetch(path,{credentials:'include'})
 if(!response.ok)throw Error(`Não foi possível carregar o plano (HTTP ${response.status}).`)
 return response.json() as Promise<unknown>
}
function ProposalNode({data}:NodeProps<Node<{node:WorkflowGraphNode}>>){
 return <GraphNodeView node={data.node} connectable={false}/>
}
const nodeTypes={proposal:ProposalNode}
/** The same graph cards and layout as the native editor. Proposals have no run
 * status and no save/start controls; only accepted runs can show live progress. */
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
export function AgentControlManagerPlans({contextId}:{contextId:string}){
 const [selectedRevision,setSelectedRevision]=useState<number|null>(null)
 const cache=useQueryClient()
 const summaries=useQuery({queryKey:['ac-manager-plans',contextId],enabled:!!contextId,refetchInterval:5000,
  queryFn:async()=>managerPlanListSchema.parse(await read(`/api/v1/ac/contexts/${contextId}/manager-plans`))})
 const selected=useQuery({queryKey:['ac-manager-plan',contextId,selectedRevision],enabled:!!contextId&&selectedRevision!==null,
  queryFn:async()=>managerPlanPreviewSchema.parse(await read(`/api/v1/ac/contexts/${contextId}/manager-plans/${selectedRevision}`))})
 const latestRevision=summaries.data?.proposals[0]?.revision
 const comparison=useQuery({queryKey:['ac-manager-plan-comparison',contextId,selectedRevision,latestRevision],
  enabled:selectedRevision!==null&&latestRevision!==undefined&&selectedRevision<latestRevision,
  queryFn:async()=>managerPlanComparisonSchema.parse(await read(`/api/v1/ac/contexts/${contextId}/manager-plans/${selectedRevision}/compare/${latestRevision}`))})
 const restore=useMutation({mutationFn:async()=>{
  if(!selectedRevision||!latestRevision||selectedRevision>=latestRevision)throw Error('Selecione uma revisão já registrada.')
  const response=await fetch(`/api/v1/ac/contexts/${contextId}/manager-plans/${selectedRevision}/restore`,{method:'POST',credentials:'include',
   headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision:latestRevision})})
  if(!response.ok)throw Error(`Não foi possível restaurar a proposta (HTTP ${response.status}). Recarregue as versões antes de tentar novamente.`)
  return managerPlanPublishedSchema.parse(await response.json())
 },onSuccess:value=>{setSelectedRevision(value.revision);void cache.invalidateQueries({queryKey:['ac-manager-plans',contextId]})},
 onError:()=>{void cache.invalidateQueries({queryKey:['ac-manager-plans',contextId]})}})
 return <SettingsField title="Planejamento do gerente" hint="Propostas versionadas com dependências, contratos e critérios de aceite. Consultar uma proposta preserva os planos já aceitos e as pausas.">
  {summaries.isPending&&<p role="status">Carregando propostas…</p>}
  {summaries.error&&<p role="alert">{summaries.error.message}</p>}
  {summaries.data?.proposals.length===0&&<p>Nenhuma proposta registrada nesta conversa.</p>}
  <div className="flex flex-wrap gap-2">{summaries.data?.proposals.map(plan=><Button key={plan.revision} type="button" variant={selectedRevision===plan.revision?'primary':'outline'}
   aria-pressed={selectedRevision===plan.revision} onClick={()=>setSelectedRevision(plan.revision)}>Proposta {plan.revision} · {plan.taskCount} tarefas</Button>)}</div>
  {summaries.data?.hasMore&&<p className="text-xs text-muted-foreground">Exibindo as 100 versões mais recentes.</p>}
  {selected.isFetching&&selectedRevision!==null&&<p role="status">Carregando grafo…</p>}
  {selected.error&&<p role="alert">{selected.error.message}</p>}
  {restore.error&&<p role="alert">{restore.error.message}</p>}
  {restore.isSuccess&&<p role="status">Nova proposta registrada. Planos aceitos continuam preservados.</p>}
  {selected.data&&<div className="flex min-w-0 flex-col gap-3">
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

   <p role="status" className="text-sm">Proposta {selected.data.revision} — aguardando integração ao executor de entregas. Este grafo ainda não está em execução.</p>
   {selected.data.compilation.workflow.graph&&<ProposalGraph key={`${contextId}-${selected.data.revision}`} graph={selected.data.compilation.workflow.graph}/>}
   <ul className="flex min-w-0 flex-col gap-2">{selected.data.plan.tasks.map(task=><li key={task.id} className="min-w-0 break-words rounded-md border p-3 text-sm">
    <strong>{task.id}</strong><p>Depende de: {task.dependsOn.join(', ')||'nenhuma tarefa'}</p>
    <p>Caminhos de escrita: {task.writePaths.join(', ')}</p><p>Critérios de aceite: {task.acceptanceRefs.join(', ')}</p>
    <p>Política de qualidade {task.qualityRevision} · até {task.maxCorrections} correções · {task.targetRef}</p>
   </li>)}</ul>
  </div>}
 </SettingsField>
}
