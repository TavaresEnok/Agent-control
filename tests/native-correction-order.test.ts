import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ManagedRecipe,nativeCorrectionExecutionRecipe,correctionExecutionRecipe,supportsManagedRecipeContract} from '../src/managed-plan.ts';
import {digest} from '../src/contracts.ts';
import {resolveFrozenWorkflow} from '../src/workflow-versions.ts';

test('new native correction v4 reviews before QA while retained v2 bytes and pins remain usable',()=>{
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/native-correction-recipe-v2.json',import.meta.url),'utf8'));
 assert.equal(fixture.recipe.schemaVersion,2);assert.equal(digest(fixture.recipe),'03a23ebde28cd8eed92816b901fc11f28176900a45d78a93ed60aef76d404780');
 assert.equal(digest(ManagedRecipe.parse(fixture.recipe)),fixture.digest);assert.equal(digest(fixture.recipe.workflow),fixture.workflowDigest);
 assert(supportsManagedRecipeContract(fixture.recipe));
 const contextId='10000000-0000-4000-8000-000000000001',parent='10000000-0000-4000-8000-000000000002';
 const plan={schemaVersion:1 as const,contextId,objectiveRef:'message:sum',sourceMessageRef:'message:sum',constraintRefs:[],tasks:[{id:'sum',objectiveRef:'message:sum',acceptanceRefs:['acceptance:sum'],inputRefs:[],outputRefs:['output:sum'],dependsOn:[],writePaths:['src/sum.ts'],qualityRevision:1,targetRef:'refs/heads/protected',maxCorrections:1}]};
 const policies=[{qualityRevision:1,policy:{schemaVersion:1 as const,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:false,verifierDigest:'a'.repeat(64)}}];
 const recipe=nativeCorrectionExecutionRecipe(plan,policies,parent,1);assert.equal(recipe.schemaVersion,4);assert.equal(recipe.workflow.description,'native-correction-review-before-qa-v1');
 assert.equal(recipe.workflow.name,fixture.recipe.workflow.name);assert.notEqual(digest(recipe.workflow),fixture.workflowDigest);assert(supportsManagedRecipeContract(recipe));
 const edges=recipe.workflow.graph!.edges,edge=(from:string,to:string)=>edges.some(item=>item.from===from&&item.to===to);
 const units=recipe.units.filter(unit=>unit.kind==='task');assert.equal(units.length,2);
 for(const unit of units){assert(edge(unit.id+'-review.pass',unit.id+'-qa'));assert(edge(unit.id+'-qa.pass',unit.id+'-select'));assert(!edge(unit.id+'-qa.pass',unit.id+'-review'));}
 assert(edge('launch-0','task-sum-review'));
 assert(fixture.recipe.workflow.graph.edges.some((edge:{from:string;to:string})=>edge.from==='task-sum-qa.pass'&&edge.to==='task-sum-review'));
 for(const snapshot of [fixture.recipe.workflow,recipe.workflow]){
  const storedDigest=digest(snapshot);const decision=resolveFrozenWorkflow({commandWorkflow:'managed-synthetic-v1',snapshot,storedDigest,intentEpoch:1,
   pin:{workflowVersion:'snapshot',workflowDigest:storedDigest,managerEpoch:1,runtimeVersion:'agent-control-0.1.0',runtimeBuild:'cezar-pinned-058',policy:'pinned'}});
  assert.equal(decision.ok,true);if(decision.ok)assert.equal(decision.digest,storedDigest);
 }
 const synthetic=correctionExecutionRecipe({...plan,tasks:plan.tasks.map(task=>({...task,acceptanceRefs:['acceptance:synthetic-effect-v1']}))},policies,parent,1);
 assert.equal(synthetic.schemaVersion,2);assert(synthetic.workflow.graph!.edges.some(item=>item.from==='task-sum-qa.pass'&&item.to==='task-sum-review'));
 assert.equal(supportsManagedRecipeContract({...recipe,mode:'synthetic-only'}),false);assert.equal(supportsManagedRecipeContract({...recipe,schemaVersion:5}),false);
});
