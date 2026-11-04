import { workflowDefSchema } from '../upstream/cezar/packages/cezar/dist/workflows/types.js';
import { Refusal } from './contracts.ts';
export const baselineWorkflow = workflowDefSchema.parse({
 name:'baseline-synthetic-v1',source:'built-in',
 steps:[{id:'implement',name:'Synthetic implementation',prompt:'Execute the fixed isolated baseline fixture.'}],
 graph:{version:2,nodes:[{id:'start',type:'start'},
  {id:'implement',type:'agent',name:'Synthetic implementation',prompt:'Execute the fixed isolated baseline fixture.'},
  {id:'done',type:'end',status:'success'}],edges:[{from:'start',to:'implement'},{from:'implement',to:'done'}]},
});
const nodes=[
 {id:'implement',type:'agent' as const,name:'Synthetic implementation',prompt:'Execute the fixed isolated engineering fixture.'},
 {id:'qa',type:'agent' as const,name:'Synthetic QA process',prompt:'Verify the immutable artifact using the fixed QA executor.'},
 {id:'review',type:'agent' as const,name:'Synthetic independent review process',prompt:'Review the same artifact in a new verifier session.'},
 {id:'judge',type:'agent' as const,name:'Optional synthetic judge',prompt:'Consolidate only complete QA and review evidence.'},
 {id:'integrate',type:'agent' as const,name:'Conditional integration',prompt:'Apply the exact verified artifact using the controller CAS gate.'},
];
export const engineeringWorkflow=workflowDefSchema.parse({name:'engineering-synthetic-v1',source:'built-in',
 steps:nodes.map(({id,name,prompt})=>({id,name,prompt})),graph:{version:2,nodes:[{id:'start',type:'start'},...nodes,{id:'done',type:'end',status:'success'}],
 edges:[{from:'start',to:'implement'},{from:'implement',to:'qa'},{from:'qa',to:'review'},{from:'review',to:'judge'},{from:'judge',to:'integrate'},{from:'integrate',to:'done'}]}});
const nativeNodes=nodes.map(node=>({...node,name:node.name.replace(/Synthetic/gi,'Native'),prompt:'Execute the frozen native engineering stage through its admitted controller adapter.'}));
/** Dynamic native plans keep this prefix. Cezar still owns the frozen graph. */
export const engineeringNativePlanWorkflowPrefix='engineering-native-plan-';
export const engineeringNativeWorkflow=workflowDefSchema.parse({...engineeringWorkflow,name:'engineering-native-v1',
 steps:nativeNodes.map(({id,name,prompt})=>({id,name,prompt})),
 graph:{...engineeringWorkflow.graph,nodes:[{id:'start',type:'start'},...nativeNodes,{id:'done',type:'end',status:'success'}]}});
// Frozen intent marker for the manager's planning effect. It is never dispatched
// to Cezar as an execution graph; Cezar remains sole owner of work DAGs.
export const semanticProposalWorkflow=workflowDefSchema.parse({name:'semantic-proposal-v1',source:'built-in',steps:[],
 graph:{version:2,nodes:[{id:'start',type:'start'},{id:'done',type:'end',status:'success'}],edges:[{from:'start',to:'done'}]}});
/** Current built-ins only. A new execution never selects a retained snapshot; those stay in src/workflow-versions.ts. */
export const currentBuiltInWorkflows=Object.freeze([semanticProposalWorkflow,baselineWorkflow,engineeringWorkflow,engineeringNativeWorkflow]);
export function workflowFor(name:string){
 const found=currentBuiltInWorkflows.find(item=>item.name===name);
 if(!found)throw new Refusal('WORKFLOW_NOT_ADMITTED');
 return found;
}
