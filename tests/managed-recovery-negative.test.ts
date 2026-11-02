import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {readManagedRecipe} from '../src/managed-plan.ts';
import {ManagerPlans,type ManagerPlan} from '../src/planning.ts';
import {digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const policy={schemaVersion:1 as const,requiredReviews:1,allowLowRiskQaWaiver:false,requireJudge:true,requireHumanIntegration:true,verifierDigest:'a'.repeat(64)};

test('a partial persisted fork with an orphan cannot resume, including while paused',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(base,'rec_negative'),db=new Ledger(isolated.url);
 try{
  await db.migrate();const project=randomUUID(),principal=`recovery-${randomUUID()}`;
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'recovery negative']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const contextId=await db.createContext(principal,project,randomUUID());
  const authority=await db.acquire(principal,contextId,randomUUID(),'synthetic-manager',60);
  await db.pool.query('INSERT INTO ac_quality_policies VALUES($1,1,$2,$3)',[project,policy,digest(policy)]);
  const task=(id:string)=>({id,objectiveRef:`message:${id}`,acceptanceRefs:['acceptance:synthetic-effect-v1'],inputRefs:[],outputRefs:[`output:${id}`],dependsOn:[],writePaths:[`src/${id}`],qualityRevision:1,targetRef:'refs/heads/main',maxCorrections:0});
  const plan:ManagerPlan={schemaVersion:1,contextId,objectiveRef:'message:objective',sourceMessageRef:'message:request',constraintRefs:[],tasks:[task('one'),task('two')]};
  const proposal=await new ManagerPlans(db).publish(principal,authority,0,plan);
  const parent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,
   action:'plan.start',payload:{workflow:'managed-synthetic-v1',messageRef:'message:request',proposalRevision:proposal.revision,proposalDigest:proposal.digest}},authority,'api');
  const recipe=await readManagedRecipe(db,parent.id),launch=Object.entries(recipe.launches).find(([,ids])=>ids.length===2);
  assert(launch);const [cursor,ids]=launch;const units=ids.map(id=>recipe.units.find(unit=>unit.id===id)!);
  const run={id:parent.run_id,workflowDef:recipe.workflow,graphState:{cursor,outputs:{[cursor]:{runIds:units[0]!.runId}}},steps:[]};
  const childRuns=units.map(unit=>({id:unit.runId,workflowDef:{name:'(fork branch)',source:'built-in',steps:[{id:'task',name:unit.id,prompt:'{{task}}'}]},dispatch:{parentRunId:run.id,rootRunId:run.id}}));
  let reconciles=0,resumes=0;
  const boundary={ledger:db,projectId:project,store:{getRun:(id:string)=>id===run.id?run:childRuns.find(child=>child.id===id)},
   isolated:{reconcileManagedTask:()=>{reconciles++;}},engineering:{replayManagedComposition:()=>{reconciles++;}},
   managedPlans:new Map(),authorities:new Map(),resumeManagedRecord:()=>{resumes++;}};
  const recover=(CezarRuntime.prototype as unknown as {recoverManagedGraph:(this:unknown,intent:typeof parent,a:typeof authority)=>Promise<void>}).recoverManagedGraph;
  await recover.call(boundary,parent,authority);
  assert.equal(reconciles,0,'unrecorded orphan must not be applied');assert.equal(resumes,0,'partial fork must not be redispatched');
  await db.pause(principal,contextId,true);
  await assert.rejects(recover.call(boundary,parent,authority),/HUMAN_PAUSED/);
  assert.equal(reconciles,0);assert.equal(resumes,0);
 }finally{await db.close();await isolated.close();}
});
