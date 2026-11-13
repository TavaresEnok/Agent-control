import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {coerceClaudePlan} from '../src/claude-planning-adapter.ts';
import {Capacity,CapacityPolicy,GrantRequest,programmerChain} from '../src/capacity.ts';
import {digest} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {nativeManagedTaskText} from '../src/managed-plan.ts';
import {ManagerPlan,TASK_LEVEL_PROMPT,managerPlanOutputJsonSchema} from '../src/planning.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

function plan(level?:'basic'|'standard'){
 const task={id:'write-docs',objectiveRef:'message:source',acceptanceRefs:['message:source'],inputRefs:[],outputRefs:['output:docs'],dependsOn:[],
  writePaths:['docs/a.md'],qualityRevision:1,targetRef:'refs/heads/main',maxCorrections:0,...(level?{level}:{})};
 return {schemaVersion:1 as const,contextId:randomUUID(),objectiveRef:'message:objective',sourceMessageRef:'message:source',constraintRefs:[],tasks:[task]};
}

test('old plans stay valid and level is omitted unless the task sets it',()=>{
 const raw=plan();
 const parsed=ManagerPlan.parse(raw);
 assert.equal(Object.hasOwn(parsed.tasks[0]!,'level'),false);
 assert.equal(digest(parsed),digest(raw));
 assert.equal(ManagerPlan.parse(plan('basic')).tasks[0]!.level,'basic');
 assert.equal(ManagerPlan.parse(plan('standard')).tasks[0]!.level,'standard');
 assert.throws(()=>ManagerPlan.parse({...raw,tasks:[{...raw.tasks[0],surprise:true}]}));
 const request={attemptId:randomUUID(),intentId:randomUUID(),contextId:randomUUID(),role:'programmer' as const};
 const grant=GrantRequest.parse(request);
 assert.equal(Object.hasOwn(grant,'taskLevel'),false);
 assert.equal(digest(grant),digest(request));
 assert.match(TASK_LEVEL_PROMPT,/documentação, texto, configuração simples/);
 const text=nativeManagedTaskText(ManagerPlan.parse(plan('basic')).tasks[0]!);
 assert.equal(text.includes('level'),false);
 const coerced=coerceClaudePlan({tasks:[{id:'write-docs',level:'basic',writePaths:['docs/a.md']}]},'message:source',{contextId:raw.contextId,qualityRevision:1,targetRef:'refs/heads/main',knownReferences:['message:source']}) as {tasks:{level?:string}[]};
 assert.equal(coerced.tasks[0]?.level,'basic');
 const dropped=coerceClaudePlan({tasks:[{id:'write-docs',level:'huge',writePaths:['docs/a.md']}]},'message:source',{contextId:raw.contextId,qualityRevision:1,targetRef:'refs/heads/main',knownReferences:['message:source']}) as {tasks:{level?:string}[]};
 assert.equal(Object.hasOwn(dropped.tasks[0]!,'level'),false);
 const schema=managerPlanOutputJsonSchema();
 const tasks:any[]=[];
 const visit=(node:unknown)=>{
  if(!node||typeof node!=='object')return;
  if(Array.isArray(node)){for(const item of node)visit(item);return;}
  const record=node as any;
  if(record.properties?.level&&record.properties?.writePaths)tasks.push(record);
  for(const value of Object.values(record))visit(value);
 };
 visit(schema);
 assert.ok(tasks.length>=1);
 for(const node of tasks){
  assert.deepEqual(node.properties.level.enum,['basic','standard']);
  assert.equal((node.required??[]).includes('level'),false);
 }
});

test('programmer chain follows the task level when the policy has tiers',()=>{
 const standard=randomUUID(),basic=randomUUID();
 const chain={regular:[standard,basic],emergency:[] as string[]};
 const tiered=CapacityPolicy.parse({schemaVersion:1,maxProgrammersPerContext:2,maxEvaluatorsPerContext:1,roles:{programmer:chain},programmerTiers:{standard:[standard],basic:[basic]}});
 assert.deepEqual(programmerChain(tiered,'programmer',chain,'basic').regular,[basic]);
 assert.deepEqual(programmerChain(tiered,'programmer',chain,'standard').regular,[standard]);
 assert.deepEqual(programmerChain(tiered,'programmer',chain).regular,[standard]);
 const open=CapacityPolicy.parse({schemaVersion:1,maxProgrammersPerContext:2,maxEvaluatorsPerContext:1,roles:{programmer:chain}});
 assert.deepEqual(programmerChain(open,'programmer',chain,'basic').regular,[standard,basic]);
});

const databaseUrl=process.env.AC_TEST_DATABASE_URL;
test('basic reserves the basic profile and standard reserves the standard profile',{skip:databaseUrl?false:'AC_TEST_DATABASE_URL is unset'},async()=>{
 const database=await isolatedDatabase(databaseUrl!,'tasklevel'),db=new Ledger(database.url),capacity=new Capacity(db);
 try{
  await db.migrate();
  const principal='task-level-owner',project=randomUUID(),account=randomUUID(),standard=randomUUID(),basic=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Task levels']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await capacity.configure(principal,{programmingLimit:4,evaluationLimit:2});
  await capacity.registerModel(principal,{provider:'grok',model:'grok-4.7',efforts:['low','medium','high'],roles:['programmer'],source:'synthetic://task-level'});
  await capacity.addAccount(principal,project,{id:account,provider:'grok',label:'grok',resourceIdentity:'task-level:'+account,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://task-level',maxConcurrent:2});
  await capacity.addProfile(principal,project,{id:standard,accountId:account,model:'grok-4.7',effort:'high',role:'programmer'});
  await capacity.addProfile(principal,project,{id:basic,accountId:account,model:'grok-4.7',effort:'medium',role:'programmer'});
  await capacity.observeQuota(principal,account,{status:'available',source:'synthetic://task-level',ttlSeconds:3600});
  const revision=await capacity.publish(principal,project,0,{schemaVersion:1,maxProgrammersPerContext:2,maxEvaluatorsPerContext:1,roles:{programmer:{regular:[standard,basic],emergency:[]}},programmerTiers:{standard:[standard],basic:[basic]},qaModel:false});
  const context=await db.createContext(principal,project,randomUUID());
  await capacity.assignPolicy(principal,context,revision);
  const authority=await db.acquire(principal,context,randomUUID(),'task-level',60);
  const intent=(await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:task-level'}},authority,'api')).id;
  const reserve=async(taskLevel?:'basic'|'standard')=>capacity.reserve(principal,{attemptId:randomUUID(),intentId:intent,contextId:context,role:'programmer',...(taskLevel?{taskLevel}:{})},authority);
  const release=async(id:string)=>capacity.transition(principal,id,authority,'released',{state:'not_started',processId:'task-level'});
  const first=await reserve('standard');
  assert.equal(first.profile_id,standard);
  await release(first.id);
  const second=await reserve('basic');
  assert.equal(second.profile_id,basic);
  await release(second.id);
  const omitted=await reserve();
  assert.equal(omitted.profile_id,standard);
 }finally{await db.close();await database.close();}
});
