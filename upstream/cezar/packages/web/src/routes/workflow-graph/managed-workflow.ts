import type {WorkflowGraph} from '@open-mercato/cezar-api-client'
import {agentControlFetch,agentControlCommandAttempt} from '../settings/agent-control-fetch'
import {signControl} from '../settings/agent-control-operator'

type Projection={projectId:string;name:string;revision:number;workflow:{name:string;description?:string;graph:WorkflowGraph}|null}
async function json(response:Response){const body=await response.json();if(!response.ok)throw Error(typeof body?.error==='string'?body.error:`HTTP_${response.status}`);return body}
export async function managedWorkflow(projectId:string,name:string):Promise<Projection>{
 return json(await agentControlFetch(`/api/v1/ac/workflow-graphs?projectId=${encodeURIComponent(projectId)}&name=${encodeURIComponent(name)}`))
}
export async function saveManagedWorkflow(projectId:string,name:string,description:string,graph:WorkflowGraph,expectedRevision:number){
 const admin=await json(await agentControlFetch('/api/v1/ac/project-admin'))
 const payload={projectId,name,...(description?{description}:{}),graph,expectedRevision}
 const semantic=JSON.stringify({action:'workflow.graph.save',payload})
 const key=`ac-workflow-graph:${admin.principalId}:${admin.installationId}:${projectId}:${name}`
 const attempt=agentControlCommandAttempt(key,semantic)
 const command={schemaVersion:1,...attempt,action:'workflow.graph.save',payload}
 const proof=await signControl(admin.principalId,command,admin.installationId)
 const response=await agentControlFetch('/api/v1/ac/workflow-graphs',{method:'POST',headers:{'content-type':'application/json','x-ac-operator-proof':proof},body:JSON.stringify(command)})
 const result=await json(response)
 if(result.state!=='applied'||result.projectId!==projectId||result.name!==name||result.revision!==expectedRevision+1)throw Error('COMMAND_RESPONSE_MISMATCH')
 sessionStorage.removeItem(key)
 return result as {state:'applied';projectId:string;name:string;revision:number;path:string}
}

export async function validateManagedWorkflow(projectId:string,graph:WorkflowGraph):Promise<{issues:string[]}>{
 return json(await agentControlFetch('/api/v1/ac/workflow-graphs/validate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectId,graph})}))
}
