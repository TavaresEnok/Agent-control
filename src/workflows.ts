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
// Frozen intent marker for the manager's planning effect. It is never dispatched
// to Cezar as an execution graph; Cezar remains sole owner of work DAGs.
export const semanticProposalWorkflow=workflowDefSchema.parse({name:'semantic-proposal-v1',source:'built-in',steps:[],
 graph:{version:2,nodes:[{id:'start',type:'start'},{id:'done',type:'end',status:'success'}],edges:[{from:'start',to:'done'}]}});
export function workflowFor(name:string){
 if(name===semanticProposalWorkflow.name)return semanticProposalWorkflow;
 if(name===baselineWorkflow.name)return baselineWorkflow;
 if(name===engineeringWorkflow.name)return engineeringWorkflow;
 throw new Refusal('WORKFLOW_NOT_ADMITTED');
}
