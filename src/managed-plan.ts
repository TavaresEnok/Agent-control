import {z} from 'zod';
import {digest,Id,Refusal,type Authority,type Command} from './contracts.ts';
import type {Ledger,Intent} from './ledger.ts';
import type pg from 'pg';
import {compileManagerPlan,ManagerPlan,type PlanningPolicy} from './planning.ts';
import {QualityPolicy} from './quality-policy.ts';
import {workflowDefSchema,type WorkflowDef} from '../upstream/cezar/packages/cezar/dist/workflows/types.js';
import {graphIssues,graphToSteps,type GraphNode,type GraphEdge} from '../upstream/cezar/packages/cezar/dist/workflows/graph.js';

export function managedId(parent:string,unit:string,kind:string){
 const h=digest({domain:'managed-delivery-v1',parent,unit,kind});return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
const Phase=z.enum(['implement','qa','review','judge','integrate']);
export const ManagedUnit=z.object({id:z.string(),kind:z.enum(['task','composition']),intentId:Id,runId:Id,operationId:Id,attemptId:Id,
 qualityRevision:z.number().int().positive(),targetRef:z.string(),writePaths:z.array(z.string()),acceptanceRefs:z.array(z.string()),sources:z.array(z.string())}).strict();
export type ManagedUnit=z.infer<typeof ManagedUnit>;
export const ManagedRecipe=z.object({schemaVersion:z.literal(1),mode:z.literal('synthetic-only'),parentIntentId:Id,
 proposalRevision:z.number().int().positive(),proposalDigest:z.string(),workflow:workflowDefSchema,
 units:z.array(ManagedUnit),bindings:z.record(z.string(),z.object({unitId:z.string(),phase:Phase}).strict()),
 launches:z.record(z.string(),z.array(z.string())),targetRef:z.string()}).strict();
export type ManagedRecipe=z.infer<typeof ManagedRecipe>;
export const ManagedExecutionInput=z.object({parentIntentId:Id,unitId:z.string(),kind:z.enum(['task','composition']),
 base:z.string().regex(/^[a-f0-9]{40}$/),writePaths:z.array(z.string()),acceptanceRefs:z.array(z.string()),sources:z.array(z.string())}).strict();
export type ManagedExecutionInput=z.infer<typeof ManagedExecutionInput>;
export function executionRecipe(plan:ManagerPlan,policies:PlanningPolicy[],parentIntentId:string,proposalRevision:number):ManagedRecipe{
 const preview=compileManagerPlan(plan,policies),tasks=new Map(plan.tasks.map(task=>[task.id,task])),policy=new Map(policies.map(p=>[p.qualityRevision,QualityPolicy.parse(p.policy)]));
 if(plan.tasks.some(task=>task.maxCorrections>0))throw new Refusal('MANAGED_CORRECTION_EXECUTOR_UNAVAILABLE');
 if(new Set(plan.tasks.map(task=>task.targetRef)).size!==1)throw new Refusal('MANAGED_SINGLE_TARGET_REQUIRED');
 if(plan.tasks.some(task=>task.acceptanceRefs.length!==1||task.acceptanceRefs[0]!=='acceptance:synthetic-effect-v1'))
  throw new Refusal('MANAGED_ACCEPTANCE_EXECUTOR_UNAVAILABLE');
 if(plan.tasks.some(task=>task.writePaths.length!==1||task.writePaths[0]!.length>240||
  !/^(?!\.)(?!.*(?:^|\/)\.)(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(task.writePaths[0]!)))
  throw new Refusal('MANAGED_WRITE_SCOPE_UNAVAILABLE');
 const targetRef=plan.tasks[0]!.targetRef,units:ManagedUnit[]=[],bindings:ManagedRecipe['bindings']={},launches:ManagedRecipe['launches']={};
 const nodes:GraphNode[]=[{id:'start',type:'start'},{id:'failed',type:'end',status:'failed'}],edges:GraphEdge[]=[];let cursor='start';
 const unit=(id:string,kind:ManagedUnit['kind'],qualityRevision:number,writePaths:string[],sources:string[]=[])=>{
  const value:ManagedUnit={id,kind,intentId:managedId(parentIntentId,id,'intent'),runId:managedId(parentIntentId,id,'run'),
   operationId:managedId(parentIntentId,id,'operation'),attemptId:managedId(parentIntentId,id,'attempt'),qualityRevision,targetRef,writePaths,
   acceptanceRefs:['acceptance:synthetic-effect-v1'],sources};units.push(value);return value;
 };
 const edge=(id:string)=>{edges.push({from:cursor,to:id},{from:id+'.failed',to:'failed'});cursor=id;};
 const checks=(u:ManagedUnit,integrate:boolean)=>{
  for(const phase of ['qa','review',...(policy.get(u.qualityRevision)!.requireJudge?['judge']:[]),...(integrate?['integrate']:[])] as const){
   const id=`${u.id}-${phase}`;nodes.push({id,type:'agent',name:`${u.id}: ${phase}`,prompt:`Resolve frozen managed phase ${id}.`});bindings[id]={unitId:u.id,phase:Phase.parse(phase)};edge(id);
  }
 };
 // Policy changes create separate batches; a composed artifact has exactly one
 // frozen quality policy, never an improvised blend of review requirements.
 const batches=preview.batches.flatMap(batch=>{
  const grouped=new Map<number,string[]>();for(const id of batch){const revision=tasks.get(id)!.qualityRevision;grouped.set(revision,[...(grouped.get(revision)??[]),id]);}return [...grouped.values()];
 });
 for(const [batchIndex,batch] of batches.entries()){
  const members=batch.map(id=>{const task=tasks.get(id)!;return unit(`task-${id}`,'task',task.qualityRevision,task.writePaths);});
  const launch=`launch-${batchIndex}`;
  if(members.length===1){const u=members[0]!;nodes.push({id:launch,type:'dispatch',name:u.id,prompt:`AC_MANAGED_UNIT:${u.id}`});launches[launch]=[u.id];edge(launch);checks(u,true);}
  else{
   const join=`join-${batchIndex}`;nodes.push({id:launch,type:'fork',branches:members.length},{id:join,type:'join',wait:'all'});edges.push({from:cursor,to:launch},{from:join+'.failed',to:'failed'});launches[launch]=members.map(u=>u.id);
   for(const [index,u] of members.entries()){const id=`${u.id}-implement`;nodes.push({id,type:'agent',name:u.id,prompt:`AC_MANAGED_UNIT:${u.id}`});
    bindings[id]={unitId:u.id,phase:'implement'};edges.push({from:`${launch}.${index+1}`,to:id},{from:id,to:join},{from:id+'.failed',to:join});}
   cursor=join;for(const u of members)checks(u,false);
   const composedId=`compose-${batchIndex}`;
   const composed=unit(composedId,'composition',members[0]!.qualityRevision,[...new Set(members.flatMap(u=>u.writePaths))],members.map(u=>u.id));
   const id=`${composedId}-launch`;nodes.push({id,type:'dispatch',name:composed.id,prompt:`AC_MANAGED_UNIT:${composed.id}`});launches[id]=[composed.id];edge(id);checks(composed,true);
  }
 }
 nodes.push({id:'done',type:'end',status:'success'});edges.push({from:cursor,to:'done'});const graph={nodes,edges};
 if(graphIssues(graph).length)throw new Refusal('MANAGED_NATIVE_GRAPH_INVALID');
 return ManagedRecipe.parse({schemaVersion:1,mode:'synthetic-only',parentIntentId,proposalRevision,proposalDigest:digest(plan),
  workflow:{name:`managed-synthetic-${parentIntentId}`,source:'built-in',steps:graphToSteps(graph),graph},units,bindings,launches,targetRef});
}
export async function freezeManagedExecution(ledger:Ledger,c:pg.PoolClient,parent:Intent,principal:string,a:Authority,revision:number,expectedDigest:string){
 const saved=(await c.query('SELECT snapshot,digest FROM ac_manager_plans WHERE context_id=$1 AND revision=$2',[a.contextId,revision])).rows[0];
 if(!saved||saved.digest!==expectedDigest)throw new Refusal('MANAGED_PROPOSAL_MISMATCH');const plan=ManagerPlan.parse(saved.snapshot);
 if(digest(plan)!==saved.digest||plan.contextId!==a.contextId)throw new Refusal('MANAGED_PROPOSAL_MISMATCH');
 const project=(await c.query('SELECT project_id FROM ac_contexts WHERE id=$1',[a.contextId])).rows[0].project_id;
 const policies:PlanningPolicy[]=[];for(const qualityRevision of new Set(plan.tasks.map(task=>task.qualityRevision))){
  const row=(await c.query('SELECT snapshot,digest FROM ac_quality_policies WHERE project_id=$1 AND revision=$2',[project,qualityRevision])).rows[0];
  const policy=QualityPolicy.parse(row?.snapshot);if(digest(policy)!==row.digest)throw new Refusal('QUALITY_POLICY_DIGEST_MISMATCH');policies.push({qualityRevision,policy});
 }
 const recipe=executionRecipe(plan,policies,parent.id,revision);
 await c.query('INSERT INTO ac_managed_executions VALUES($1,$2,$3,$4,$5,$6)',[parent.id,a.contextId,revision,expectedDigest,digest(recipe),recipe]);
 for(const u of recipe.units){
  const command:Command={schemaVersion:1,intentId:u.intentId,deliveryAttemptId:managedId(parent.id,u.id,'delivery'),contextId:a.contextId,
   policyRevision:parent.command.policyRevision,action:'plan.start',payload:{workflow:'engineering-synthetic-v1',messageRef:`managed:${parent.id}:${u.id}`}};
  const {deliveryAttemptId,...semantic}=command;
  await c.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,parent_intent_id,parent_unit_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[u.intentId,a.contextId,principal,digest({principal,...semantic}),command,u.operationId,u.runId,a.epoch,parent.plan_revision,parent.id,u.id]);
  await c.query('INSERT INTO ac_operations(id,intent_id,state,manager_epoch,execution_attempt_id) VALUES($1,$2,\'registered\',$3,$4)',[u.operationId,u.intentId,a.epoch,u.attemptId]);
  const contract={qualityRevision:u.qualityRevision,targetRef:u.targetRef};
  await c.query('INSERT INTO ac_execution_contracts VALUES($1,$2,$3,$4,$5)',[u.intentId,project,u.qualityRevision,u.targetRef,digest(contract)]);
 }
 return recipe.workflow;
}
export async function readManagedRecipe(ledger:Ledger,parentId:string){
 const row=(await ledger.pool.query('SELECT recipe,recipe_digest FROM ac_managed_executions WHERE parent_intent_id=$1',[parentId])).rows[0];
 if(!row)throw new Refusal('MANAGED_RECIPE_MISSING');const value=ManagedRecipe.parse(row.recipe);
 if(digest(value)!==row.recipe_digest||value.parentIntentId!==parentId)throw new Refusal('MANAGED_RECIPE_MISMATCH');return value;
}
/** Resolve only the immutable parent recipe and its exact child identity. */
export async function readManagedUnit(ledger:Ledger,intent:Intent):Promise<{parentIntentId:string;unit:ManagedUnit;recipe:ManagedRecipe}|null>{
 const row=(await ledger.pool.query('SELECT * FROM ac_intents WHERE id=$1',[intent.id])).rows[0];
 if(!row||row.context_id!==intent.context_id||row.run_id!==intent.run_id||row.operation_id!==intent.operation_id||
    row.plan_revision!==intent.plan_revision||digest(row.command)!==digest(intent.command))throw new Refusal('INTENT_IDENTITY_MISMATCH',403);
 if(!row.parent_intent_id&&!row.parent_unit_id)return null;
 if(!row.parent_intent_id||!row.parent_unit_id)throw new Refusal('MANAGED_UNIT_MISMATCH');
 const recipe=await readManagedRecipe(ledger,row.parent_intent_id),unit=recipe.units.find(u=>u.id===row.parent_unit_id);
 const parent=(await ledger.pool.query('SELECT context_id,principal_id,plan_revision FROM ac_intents WHERE id=$1',[row.parent_intent_id])).rows[0];
 if(!unit||!parent||parent.context_id!==row.context_id||parent.principal_id!==row.principal_id||parent.plan_revision!==row.plan_revision||
    unit.intentId!==row.id||unit.runId!==row.run_id||unit.operationId!==row.operation_id)throw new Refusal('MANAGED_UNIT_MISMATCH');
 return {parentIntentId:row.parent_intent_id,unit,recipe};
}
export async function readManagedInput(ledger:Ledger,intentId:string):Promise<ManagedExecutionInput>{
 const row=(await ledger.pool.query('SELECT base_id,snapshot,digest FROM ac_managed_delivery_inputs WHERE intent_id=$1',[intentId])).rows[0];
 if(!row)throw new Refusal('MANAGED_INPUT_MISSING');
 const input=ManagedExecutionInput.parse(row.snapshot);
 const intent=(await ledger.pool.query<Intent>('SELECT * FROM ac_intents WHERE id=$1',[intentId])).rows[0];
 if(!intent)throw new Refusal('INTENT_MISSING');const bound=await readManagedUnit(ledger,intent);
 if(!bound||digest(input)!==row.digest||input.base!==row.base_id||input.parentIntentId!==bound.parentIntentId||
    input.unitId!==bound.unit.id||input.kind!==bound.unit.kind||digest(input.writePaths)!==digest(bound.unit.writePaths)||
    digest(input.acceptanceRefs)!==digest(bound.unit.acceptanceRefs)||digest(input.sources)!==digest(bound.unit.sources))
  throw new Refusal('MANAGED_INPUT_MISMATCH');
 return input;
}
