import type {WorkflowGraph} from '@open-mercato/cezar-api-client'
import {agentControlFetch} from '../settings/agent-control-fetch'
import {signControl} from '../settings/agent-control-operator'
import {z} from 'zod'

type Projection={projectId:string;name:string;revision:number;workflow:{name:string;description?:string;graph:WorkflowGraph}|null}
async function json(response:Response){const body=await response.json();if(!response.ok)throw Error(typeof body?.error==='string'?body.error:`HTTP_${response.status}`);return body}
export async function defaultProject():Promise<string>{
 const value=await json(await agentControlFetch('/api/v1/ac/operator/identity'))
 if(typeof value.projectId!=='string'||!value.projectId)throw Error('PROJECT_REQUIRED')
 return value.projectId
}
export async function managedWorkflows(projectId:string):Promise<{workflows:{name:string;revision:number}[]}>{
 return json(await agentControlFetch(`/api/v1/ac/workflow-graphs?projectId=${encodeURIComponent(projectId)}`))
}
export async function managedWorkflow(projectId:string,name:string):Promise<Projection>{
 return json(await agentControlFetch(`/api/v1/ac/workflow-graphs?projectId=${encodeURIComponent(projectId)}&name=${encodeURIComponent(name)}`))
}
const Payload=z.object({projectId:z.string().uuid(),name:z.string().min(1).max(80),description:z.string().max(4096).optional(),graph:z.unknown(),expectedRevision:z.number().int().nonnegative()}).strict()
const Pending=z.object({intentId:z.string().uuid(),payload:Payload,uncertain:z.boolean()}).strict()
type Payload=z.infer<typeof Payload>
async function pendingContext(projectId:string){
 const admin=await json(await agentControlFetch('/api/v1/ac/project-admin'))
 if(typeof admin.principalId!=='string'||typeof admin.installationId!=='string')throw Error('OPERATOR_IDENTITY_INVALID')
 const key=`ac-workflow-graph-pending:${encodeURIComponent(admin.principalId)}:${admin.installationId}:${projectId}`
 let raw:unknown;try{raw=JSON.parse(sessionStorage.getItem(key)||'null')}catch{throw Error('PENDING_COMMAND_INVALID')}
 const parsed=Pending.safeParse(raw)
 if(raw!==null&&(!parsed.success||parsed.data.payload.projectId!==projectId))throw Error('PENDING_COMMAND_INVALID')
 return {admin,key,pending:parsed.success?parsed.data:null}
}
export async function hasPendingManagedWorkflow(projectId:string){return (await pendingContext(projectId)).pending!==null}
async function sendPending(projectId:string,payload?:Payload){
 const {admin,key,pending}=await pendingContext(projectId)
 if(pending&&payload&&JSON.stringify(pending.payload)!==JSON.stringify(payload))throw Error('PENDING_WORKFLOW_REQUIRES_RESUME')
 if(!pending&&!payload)throw Error('PENDING_WORKFLOW_MISSING')
 const record=pending??{intentId:crypto.randomUUID(),payload:payload!,uncertain:false}
 sessionStorage.setItem(key,JSON.stringify(record))
 const command={schemaVersion:1,intentId:record.intentId,deliveryAttemptId:crypto.randomUUID(),action:'workflow.graph.save',payload:record.payload}
 const proof=await signControl(admin.principalId,command,admin.installationId)
 sessionStorage.setItem(key,JSON.stringify({...record,uncertain:true}))
 const response=await agentControlFetch('/api/v1/ac/workflow-graphs',{method:'POST',headers:{'content-type':'application/json','x-ac-operator-proof':proof},body:JSON.stringify(command)})
 let result:unknown;try{result=await response.json()}catch{throw Error('COMMAND_RESPONSE_INVALID')}
 if(!response.ok){
  const parsed=z.object({error:z.string()}).safeParse(result),code=parsed.success?parsed.data.error:`HTTP_${response.status}`
  // Only the first, definitely refused revision-CAS attempt is known not to have a journal.
  if(!record.uncertain&&code==='WORKFLOW_REVISION_CONFLICT')sessionStorage.removeItem(key)
  throw Error(code==='WORKFLOW_REVISION_CONFLICT'&&!record.uncertain?'A revisão mudou. Recarregue o fluxo antes de salvar.':code)
 }
 const parsed=z.object({state:z.literal('applied'),projectId:z.string().uuid(),name:z.string(),revision:z.number().int(),path:z.string()}).safeParse(result)
 if(!parsed.success||parsed.data.projectId!==projectId||parsed.data.name!==record.payload.name||parsed.data.revision!==record.payload.expectedRevision+1)throw Error('COMMAND_RESPONSE_MISMATCH')
 sessionStorage.removeItem(key);return parsed.data
}
export async function saveManagedWorkflow(projectId:string,name:string,description:string,graph:WorkflowGraph,expectedRevision:number){
 return sendPending(projectId,{projectId,name,...(description?{description}:{}),graph,expectedRevision})
}
export async function resumeManagedWorkflow(projectId:string){return sendPending(projectId)}

export async function validateManagedWorkflow(projectId:string,graph:WorkflowGraph):Promise<{issues:string[]}>{
 return json(await agentControlFetch('/api/v1/ac/workflow-graphs/validate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectId,graph})}))
}
