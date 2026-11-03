import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {compileManagerPlan,ManagerPlan} from '../src/planning.ts';
import {correctionExecutionRecipe} from '../src/managed-plan.ts';
const policy={schemaVersion:1 as const,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:false,verifierDigest:'a'.repeat(64)};
test('explicit parallelism admits eight independent tasks while preserving legacy four and bounded native recipes',()=>{
 const plan=ManagerPlan.parse({schemaVersion:1,contextId:randomUUID(),objectiveRef:'message:objective',sourceMessageRef:'message:request',constraintRefs:[],
  tasks:Array.from({length:8},(_,i)=>({id:'task'+i,objectiveRef:'message:task'+i,acceptanceRefs:['acceptance:synthetic-effect-v1'],inputRefs:[],outputRefs:['output:task'+i],
   dependsOn:[],writePaths:['task'+i+'.txt'],qualityRevision:1,targetRef:'refs/heads/protected',maxCorrections:1}))});
 assert.deepEqual(compileManagerPlan(plan,[{qualityRevision:1,policy}]).batches.map(batch=>batch.length),[4,4]);
 const wide={...plan,parallelism:8};assert.deepEqual(compileManagerPlan(wide,[{qualityRevision:1,policy}]).batches.map(batch=>batch.length),[8]);
 const recipe=correctionExecutionRecipe(wide,[{qualityRevision:1,policy}],randomUUID(),1);
 assert.equal(Object.values(recipe.launches).filter(batch=>batch.length===8).length,1);
 assert.equal(recipe.units.find(unit=>unit.kind==='composition')?.sources.length,8);
 assert.throws(()=>ManagerPlan.parse({...plan,parallelism:11}));
 const overlap={...wide,tasks:wide.tasks.map(task=>({...task,writePaths:['shared.txt']}))};
 assert.equal(compileManagerPlan(overlap,[{qualityRevision:1,policy}]).batches.length,8);
});
