import {z} from 'zod'
const Id=z.string().uuid(),Scope={projectId:Id,contextId:Id,workspaceId:Id},Hash=z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
export const remoteDevelopmentActionSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('project.prepareRemoteDevelopment'),payload:z.object({...Scope,hostId:Id,sourceOperationId:Id}).strict()}).strict(),
 z.object({action:z.literal('project.launchRemoteDevelopment'),payload:z.object(Scope).strict()}).strict(),
 z.object({action:z.literal('project.registerRemoteArtifact'),payload:z.object(Scope).strict()}).strict(),
])
export const remoteDevelopmentViewSchema=z.object({configured:z.boolean(),candidates:z.array(z.object({projectId:Id,contextId:Id,hostId:Id,sourceOperationId:Id,intentId:Id,label:z.string(),commit:Hash,tree:Hash})).max(100),workspaces:z.array(z.object({...Scope,hostId:Id,state:z.string(),implementationState:z.string().optional(),emissionPhase:z.string().optional(),artifactId:Id.optional(),commit:Hash.optional(),tree:Hash.optional()})).max(100)})
export const remoteDevelopmentResultSchema=z.discriminatedUnion('state',[
 z.object({...Scope,state:z.literal('prepared'),commit:Hash,tree:Hash}).strict(),
 z.object({...Scope,state:z.literal('launched'),implementationState:z.string()}).strict(),
 z.object({...Scope,state:z.literal('registered'),artifactId:Id,commit:Hash,tree:Hash,reviewStatus:z.literal('not_reviewed')}).strict(),
])
