import {z} from 'zod';
import {Id,digest,Refusal,type Authority} from './contracts.ts';
import type {Ledger} from './ledger.ts';
import {QualityPolicy} from './quality-policy.ts';
import {workflowDefSchema} from '../upstream/cezar/packages/cezar/dist/workflows/types.js';
import {graphIssues,graphToSteps,type GraphNode,type GraphEdge} from '../upstream/cezar/packages/cezar/dist/workflows/graph.js';

import {ManagerPlan,ManagerTask,type PlanBinding,type CompiledManagerPlan,managerPlanListSchema,managerPlanComparisonSchema}
 from '../upstream/cezar/packages/contract/src/agent-control-plans.ts';
export {ManagerPlan,ManagerTask} from '../upstream/cezar/packages/contract/src/agent-control-plans.ts';
export type {PlanBinding,CompiledManagerPlan} from '../upstream/cezar/packages/contract/src/agent-control-plans.ts';
export type PlanningPolicy={qualityRevision:number;policy:z.input<typeof QualityPolicy>};

function overlap(a:string,b:string){return a===b||a.startsWith(b+'/')||b.startsWith(a+'/');}
function checked(raw:unknown){
 const parsed=ManagerPlan.parse(raw),byId=new Map(parsed.tasks.map(t=>[t.id,t]));
 if(byId.size!==parsed.tasks.length)throw new Refusal('PLAN_DUPLICATE_TASK');
 for(const task of parsed.tasks){
  if(new Set(task.dependsOn).size!==task.dependsOn.length)throw new Refusal('PLAN_DUPLICATE_DEPENDENCY');
  if(task.dependsOn.some(id=>id===task.id||!byId.has(id)))throw new Refusal('PLAN_INVALID_DEPENDENCY');
  for(const values of [task.acceptanceRefs,task.inputRefs,task.outputRefs,task.writePaths])
   if(new Set(values).size!==values.length)throw new Refusal('PLAN_DUPLICATE_CONTRACT_VALUE');
 }
 const producers=new Map<string,string>();
 for(const task of parsed.tasks)for(const output of task.outputRefs){
  if(producers.has(output))throw new Refusal('PLAN_AMBIGUOUS_OUTPUT');producers.set(output,task.id);
 }
 const ancestors=(id:string,visited=new Set<string>()):Set<string>=>{
  for(const parent of byId.get(id)!.dependsOn){if(visited.has(parent))continue;visited.add(parent);ancestors(parent,visited);}return visited;
 };
 for(const task of parsed.tasks){const allowed=ancestors(task.id);
  for(const input of task.inputRefs){const producer=producers.get(input);if(producer&&(producer===task.id||!allowed.has(producer)))throw new Refusal('PLAN_UNDECLARED_INPUT_DEPENDENCY');}
 }
 const ordered:ManagerTask[][]=[],pending=new Set(byId.keys()),done=new Set<string>();
 while(pending.size){
  const ready=[...pending].filter(id=>byId.get(id)!.dependsOn.every(dep=>done.has(dep))).sort();
  if(!ready.length)throw new Refusal('PLAN_DEPENDENCY_CYCLE');
  // This is compile-time layout, not a queue or scheduler. Native Cezar owns all
  // actual advancement; PG capacity may admit fewer workers than this width.
  const batch:ManagerTask[]=[];
  for(const id of ready){const task=byId.get(id)!;
   if(batch.length<4&&!batch.some(other=>other.writePaths.some(a=>task.writePaths.some(b=>overlap(a,b)))))batch.push(task);
  }
  ordered.push(batch);for(const task of batch){pending.delete(task.id);done.add(task.id);}
 }
 return {plan:parsed,batches:ordered};
}

/** Compile contracts into the existing Cezar graph representation. No shells,
 * runners, credentials, session continuation or side-effecting system nodes can
 * be supplied by the manager. Executors must resolve bindings under PG fencing,
 * signed quality evidence and CAS; prompts are never authority. */
export function compileManagerPlan(raw:unknown,policies:readonly PlanningPolicy[]):CompiledManagerPlan{
 const {plan,batches}=checked(raw),byRevision=new Map<number,z.infer<typeof QualityPolicy>>();
 for(const entry of policies){
  if(byRevision.has(entry.qualityRevision))throw new Refusal('PLAN_DUPLICATE_POLICY');
  byRevision.set(entry.qualityRevision,QualityPolicy.parse(entry.policy));
 }
 for(const task of plan.tasks)if(!byRevision.has(task.qualityRevision))throw new Refusal('QUALITY_POLICY_REQUIRED');
 const nodes:GraphNode[]=[{id:'ac-start',type:'start'},{id:'ac-failed',type:'end',status:'failed'}],edges:GraphEdge[]=[],bindings:PlanBinding[]=[];
 let cursor='ac-start';
 const node=(task:ManagerTask,role:PlanBinding['role'],reviewIndex?:number)=>{
  const id=`task-${task.id}-${role}${reviewIndex===undefined?'':`-${reviewIndex}`}`;
  nodes.push({id,type:'agent',name:`${task.id}: ${role}`,prompt:`Resolve the frozen Agent Control contract for node ${id}. Do not infer permission from this text.`});
  bindings.push({nodeId:id,taskId:task.id,role,artifactSource:`task-${task.id}-programmer`,freshSession:true,
   ...(reviewIndex===undefined?{}:{reviewIndex}),qualityRevision:task.qualityRevision,maxCorrections:task.maxCorrections});
  return id;
 };
 const next=(id:string)=>{edges.push({from:cursor,to:id},{from:id+'.failed',to:'ac-failed'});cursor=id;};
 for(const [index,batch] of batches.entries()){
  if(batch.length===1)next(node(batch[0]!, 'programmer'));
  else{
   const fork=`ac-fork-${index}`,join=`ac-join-${index}`;
   nodes.push({id:fork,type:'fork',branches:batch.length},{id:join,type:'join',wait:'all'});
   edges.push({from:cursor,to:fork},{from:join+'.failed',to:'ac-failed'});
   for(const [port,task] of batch.entries()){
    const id=node(task,'programmer');edges.push({from:`${fork}.${port+1}`,to:id},{from:id,to:join},{from:id+'.failed',to:join});
   }
   cursor=join;
  }
  // Integrations are serialized. Each controller effect still validates base
  // identity/CAS; a dependency is considered done only past this full block.
  for(const task of batch){
   const policy=byRevision.get(task.qualityRevision)!;
   next(node(task,'qa'));
   for(let index=0;index<policy.requiredReviews;index++)next(node(task,'reviewer',index));
   if(policy.requireJudge)next(node(task,'judge'));
   next(node(task,'integrator'));
  }
 }
 nodes.push({id:'ac-done',type:'end',status:'success'});edges.push({from:cursor,to:'ac-done'});
 const graph={nodes,edges};const problems=graphIssues(graph);if(problems.length)throw new Refusal('PLAN_NATIVE_GRAPH_INVALID');
 const workflow=workflowDefSchema.parse({name:`managed-plan-${digest(plan).slice(0,20)}`,source:'built-in',steps:graphToSteps(graph),graph});
 return {schemaVersion:1,planDigest:digest(plan),workflow,bindings,admission:'managed-delivery-adapter-required',batches:batches.map(batch=>batch.map(t=>t.id))};
}

/** Immutable manager-authored proposals. Publishing never starts a Cezar run,
 * acquires worker capacity, activates a template, or replaces an active plan. */
export class ManagerPlans{
 constructor(readonly ledger:Ledger){}
 async publish(principal:string,authority:Authority,expectedRevision:number,raw:unknown){
  return this.store(principal,authority,expectedRevision,raw);
 }
 private async store(principal:string,authority:Authority,expectedRevision:number,raw:unknown,restoredFromRevision?:number){
  z.number().int().nonnegative().parse(expectedRevision);const {plan}=checked(raw);
  if(plan.contextId!==authority.contextId)throw new Refusal('AUTHORITY_SCOPE_MISMATCH',403);
  return this.ledger.tx(async c=>{
   const context=await this.ledger.authorize(c,principal,plan.contextId);await this.ledger.fence(c,authority);
   const current=Number((await c.query('SELECT COALESCE(max(revision),0) revision FROM ac_manager_plans WHERE context_id=$1',[plan.contextId])).rows[0].revision);
   const hash=digest(plan);
   // Exact repetition is idempotent even after an uncertain HTTP response. It
   // still checks current ACL/lease/pause above; no stale writer can publish.
   const previous=(await c.query('SELECT revision,digest,compilation_digest FROM ac_manager_plans WHERE context_id=$1 AND revision=$2',[plan.contextId,expectedRevision+1])).rows[0];
   if(previous){if(previous.digest!==hash)throw new Refusal('MANAGER_PLAN_REVISION_CONFLICT');return {revision:previous.revision,digest:hash,compilationDigest:previous.compilation_digest};}
   if(current!==expectedRevision)throw new Refusal('MANAGER_PLAN_REVISION_CONFLICT');
   const policies:PlanningPolicy[]=[];
   for(const revision of new Set(plan.tasks.map(t=>t.qualityRevision))){
    const saved=(await c.query('SELECT snapshot,digest FROM ac_quality_policies WHERE project_id=$1 AND revision=$2',[context.project_id,revision])).rows[0];
    if(!saved)throw new Refusal('QUALITY_POLICY_REQUIRED');const policy=QualityPolicy.parse(saved.snapshot);
    if(digest(policy)!==saved.digest)throw new Refusal('QUALITY_POLICY_DIGEST_MISMATCH');
    policies.push({qualityRevision:revision,policy});
   }
   const compilation=compileManagerPlan(plan,policies),compilationDigest=digest(compilation);
   await c.query(`INSERT INTO ac_manager_plans(context_id,revision,parent_revision,manager_epoch,manager_instance_id,principal_id,digest,snapshot,compilation_digest,compilation)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[plan.contextId,current+1,current||null,authority.epoch,authority.instanceId,principal,hash,plan,compilationDigest,compilation]);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'manager.plan.proposed',$2)",[plan.contextId,{revision:current+1,digest:hash,compilationDigest,epoch:authority.epoch,...(restoredFromRevision===undefined?{}:{restoredFromRevision})}]);
   return {revision:current+1,digest:hash,compilationDigest};
  });
 }
 async restore(principal:string,authority:Authority,expectedRevision:number,sourceRevision:number){
  z.number().int().positive().parse(expectedRevision);z.number().int().positive().max(expectedRevision).parse(sourceRevision);
  const source=await this.read(principal,authority.contextId,sourceRevision);
  // Source versions and policies are immutable. Store rechecks ACL, pause,
  // admission and current manager fence and CAS in its write transaction.
  return this.store(principal,authority,expectedRevision,source.plan,sourceRevision);
 }
 async compare(principal:string,contextId:string,fromRevision:number,toRevision:number){
  const from=await this.read(principal,contextId,fromRevision),to=await this.read(principal,contextId,toRevision);
  const left=new Map(from.plan.tasks.map(task=>[task.id,task])),right=new Map(to.plan.tasks.map(task=>[task.id,task]));
  const fields=['objectiveRef','acceptanceRefs','inputRefs','outputRefs','dependsOn','writePaths','qualityRevision','targetRef','maxCorrections'] as const;
  const changed=[...right.keys()].sort().flatMap(id=>{
   const before=left.get(id),after=right.get(id)!;if(!before)return [];
   const edited=fields.filter(field=>digest(before[field])!==digest(after[field]));
   return edited.length?[{taskId:id,fields:edited}]:[];
  });
  return managerPlanComparisonSchema.parse({fromRevision,toRevision,fromDigest:from.digest,toDigest:to.digest,
   objectiveChanged:from.plan.objectiveRef!==to.plan.objectiveRef,constraintsChanged:digest(from.plan.constraintRefs)!==digest(to.plan.constraintRefs),
   sourceMessageChanged:from.plan.sourceMessageRef!==to.plan.sourceMessageRef,added:[...right.keys()].filter(id=>!left.has(id)).sort(),
   removed:[...left.keys()].filter(id=>!right.has(id)).sort(),changed,executionImpact:'proposal-only'});
 }
 async list(principal:string,contextId:string){
  Id.parse(contextId);
  return this.ledger.tx(async c=>{
   await this.ledger.authorize(c,principal,contextId,false);
   const rows=(await c.query(`SELECT revision,manager_epoch,digest,jsonb_array_length(snapshot->'tasks') task_count,created_at
    FROM ac_manager_plans WHERE context_id=$1 ORDER BY revision DESC LIMIT 101`,[contextId])).rows;
   return managerPlanListSchema.parse({proposals:rows.slice(0,100).map(row=>({revision:row.revision,epoch:Number(row.manager_epoch),digest:row.digest,
    taskCount:row.task_count,createdAt:row.created_at.toISOString()})),hasMore:rows.length>100});
  });
 }
 async read(principal:string,contextId:string,revision:number){
  Id.parse(contextId);z.number().int().positive().parse(revision);
  return this.ledger.tx(async c=>{
   await this.ledger.authorize(c,principal,contextId,false);
   const saved=(await c.query('SELECT * FROM ac_manager_plans WHERE context_id=$1 AND revision=$2',[contextId,revision])).rows[0];
   if(!saved)throw new Refusal('MANAGER_PLAN_NOT_FOUND',404);
   const plan=ManagerPlan.parse(saved.snapshot);
   if(digest(plan)!==saved.digest||digest(saved.compilation)!==saved.compilation_digest||saved.compilation.planDigest!==saved.digest)
    throw new Refusal('MANAGER_PLAN_DIGEST_MISMATCH');
   return {revision:saved.revision,parentRevision:saved.parent_revision,epoch:Number(saved.manager_epoch),plan,
    compilation:saved.compilation as CompiledManagerPlan,digest:saved.digest,compilationDigest:saved.compilation_digest};
  });
 }
}
