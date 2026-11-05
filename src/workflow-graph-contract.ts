import {z} from 'zod';
import {Id,Refusal} from './contracts.ts';
import {workflowGraphSchema,graphIssues,graphToSteps} from '../upstream/cezar/packages/cezar/dist/workflows/graph.js';

/** A deliberately narrow command: no caller-controlled paths or overwrite flag. */
export const WorkflowGraphName=z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const WorkflowGraphCommand=z.object({
 schemaVersion:z.literal(1),intentId:Id,deliveryAttemptId:Id,action:z.literal('workflow.graph.save'),
 payload:z.object({projectId:Id,name:WorkflowGraphName,description:z.string().max(4096).optional(),
  graph:workflowGraphSchema,expectedRevision:z.number().int().min(0).max(2147483646)}).strict(),
}).strict();
export function parseWorkflowGraphCommand(raw:unknown){
 // Bound inputs before graph algorithms, and count the original request rather than the parsed form.
 if(Buffer.byteLength(JSON.stringify(raw)??'')>256*1024)throw new Refusal('WORKFLOW_GRAPH_TOO_LARGE',400);
 const command=WorkflowGraphCommand.parse(raw),graph=command.payload.graph;
 if(graph.nodes.length>256||graph.edges.length>1024)throw new Refusal('WORKFLOW_GRAPH_TOO_LARGE',400);
 const issues=graphIssues(graph);
 if(issues.length)throw new Refusal('WORKFLOW_GRAPH_INVALID',400);
 graphToSteps(graph);
 return command;
}
