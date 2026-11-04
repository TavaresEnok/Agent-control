import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {digest,Refusal} from '../src/contracts.ts';
import {workflowFor} from '../src/workflows.ts';
import {agentControlDiagnosticsSchema} from '../upstream/cezar/packages/contract/src/agent-control-operations.ts';
import {
  AGENT_CONTROL_RUNTIME_BUILD,AGENT_CONTROL_RUNTIME_VERSION,currentWorkflow,resolveFrozenWorkflow,retainedWorkflows,
  workflowForAdmission,workflowVersionRegistry,WORKFLOW_VERSION_RETIRED,
} from '../src/workflow-versions.ts';

const names=['baseline-synthetic-v1','engineering-synthetic-v1','engineering-native-v1','semantic-proposal-v1'] as const;

test('workflow catalog is pinned, current-only for admission, and does not upgrade a retained snapshot',()=>{
  assert.equal(AGENT_CONTROL_RUNTIME_VERSION,'agent-control-0.1.0');
  assert.equal(workflowVersionRegistry.every(entry=>entry.policy==='pinned'),true);
  for(const name of names){
    const current=currentWorkflow(name),retained=retainedWorkflows(name);
    assert.equal(current?.status,'current');
    assert.equal(current?.version,'v1');
    assert.equal(digest(workflowFor(name)),current?.digest);
    assert.equal(retained.length,1);
    assert.equal(retained[0]?.version,'v0');
    assert.notEqual(retained[0]?.digest,current?.digest);
    assert.equal(digest(workflowForAdmission(name,'v1')),current?.digest);
    assert.throws(()=>workflowForAdmission(name,'v0'),(error:unknown)=>error instanceof Refusal&&error.code==='WORKFLOW_VERSION_NOT_CURRENT');
    const decision=resolveFrozenWorkflow({commandWorkflow:name,snapshot:retained[0]!.definition,storedDigest:retained[0]!.digest,pin:null,intentEpoch:1});
    assert.equal(decision.ok,true);
    if(!decision.ok)return;
    assert.equal(decision.version,'v0');
    assert.equal(decision.policy,'pinned');
    assert.equal(decision.legacy,true);
    assert.equal(digest(decision.definition),retained[0]!.digest);
    assert.notEqual(digest(decision.definition),digest(workflowFor(name)));
  }
  assert.throws(()=>workflowForAdmission('not-a-workflow','v1'),(error:unknown)=>error instanceof Refusal&&error.code==='WORKFLOW_NOT_ADMITTED');
  const retained=retainedWorkflows('baseline-synthetic-v1')[0]!,current=currentWorkflow('baseline-synthetic-v1')!;
  assert.equal(resolveFrozenWorkflow({commandWorkflow:retained.name,snapshot:retained.definition,storedDigest:current.digest,pin:null,intentEpoch:1}).ok,false);
  const unknown={...current.definition,description:'retired-sentinel-9f3c'};
  const unregistered=resolveFrozenWorkflow({commandWorkflow:current.name,snapshot:unknown,storedDigest:digest(unknown),pin:null,intentEpoch:1});
  assert.deepEqual(unregistered,{ok:false,cause:WORKFLOW_VERSION_RETIRED,reason:'unregistered'});
  const mismatched=resolveFrozenWorkflow({commandWorkflow:current.name,snapshot:retained.definition,storedDigest:retained.digest,pin:{
    workflowVersion:'v1',workflowDigest:retained.digest,managerEpoch:1,runtimeVersion:AGENT_CONTROL_RUNTIME_VERSION,runtimeBuild:AGENT_CONTROL_RUNTIME_BUILD,policy:'pinned'},intentEpoch:1});
  assert.deepEqual(mismatched,{ok:false,cause:WORKFLOW_VERSION_RETIRED,reason:'divergent'});
});

const skip=process.env.AC_TEST_DATABASE_URL?false:'AC_TEST_DATABASE_URL ausente; prova PG reservada ao laboratório isolado';

test('pinned recovery keeps the frozen snapshot and a retired version stays parked',{skip,timeout:90000},async()=>{
  const base=process.env.AC_TEST_DATABASE_URL;
  if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
  const [{Ledger},{CezarRuntime},{Capacity},{ContextDiagnostics},{Control},{isolatedDatabase}]=await Promise.all([
    import('../src/ledger.ts'),import('../src/cezar.ts'),import('../src/capacity.ts'),import('../src/diagnostics.ts'),import('../src/control.ts'),import('./fixtures/isolated-database.ts'),
  ]);
  const fixture=await isolatedDatabase(base,'wfver');
  const db=new Ledger(fixture.url);
  let runtime:InstanceType<typeof CezarRuntime>|undefined,repo='';
  const workers=(operationId:string)=>{
    const listing=execFileSync('ps',['-eo','args'],{encoding:'utf8'});
    return listing.split('\n').filter(line=>line.includes('synthetic-worker.mjs')&&line.includes(operationId)).length;
  };
  try{
    await db.migrate();
    const project=randomUUID(),principal='workflow-version-'+randomUUID(),viewer='workflow-viewer-'+randomUUID(),outsider='workflow-outsider-'+randomUUID();
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Workflow versions']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'viewer')",[project,viewer]);
    const capacity=await new Capacity(db).constructor === Capacity ? await import('./fixtures/provision-capacity.ts').then(m=>m.provisionCapacity(db,principal,project)) : null;
    if(!capacity)throw Error('CAPACITY_FIXTURE_MISSING');
    const context=await db.createContext(principal,project,randomUUID());
    await capacity.service.assignPolicy(principal,context,capacity.revision);
    const authority=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
    await mkdir('.state/projects',{recursive:true});
    repo=await mkdtemp(resolve('.state/projects/ac-workflow-version-'));
    const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
    git('init','-q','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','Synthetic fixture');
    await writeFile(join(repo,'README.md'),'Workflow version fixture\n');git('add','.');git('commit','-qm','base');
    await mkdir(join(repo,'.ai/cezar'),{recursive:true});
    await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[],worktreeRetention:0}));
    const retained=retainedWorkflows('baseline-synthetic-v1')[0]!,current=currentWorkflow('baseline-synthetic-v1')!;
    const seed=async(snapshot:unknown,storedDigest:string)=>{
      const id=randomUUID(),runId=randomUUID(),operationId=randomUUID(),deliveryAttemptId=randomUUID();
      const command={schemaVersion:1 as const,intentId:id,deliveryAttemptId,contextId:context,policyRevision:1,action:'plan.start' as const,payload:{workflow:'baseline-synthetic-v1' as const,messageRef:'encrypted:version-fixture'}};
      const {deliveryAttemptId:delivery, ...semantic}=command;
      void delivery;
      const revision=(await db.pool.query('UPDATE ac_contexts SET plan_revision=plan_revision+1 WHERE id=$1 RETURNING plan_revision',[context])).rows[0].plan_revision;
      await db.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,context,principal,digest({principal,...semantic}),command,operationId,runId,authority.epoch,revision]);
      await db.pool.query("INSERT INTO ac_operations(id,intent_id,state,manager_epoch) VALUES($1,$2,'registered',$3)",[operationId,id,authority.epoch]);
      await db.pool.query('INSERT INTO ac_outbox(id,intent_id) VALUES($1,$2)',[randomUUID(),id]);
      await db.pool.query('INSERT INTO ac_frozen_plans VALUES($1,$2,$3,$4,$5)',[context,revision,id,storedDigest,snapshot]);
      return {...(await db.pool.query('SELECT * FROM ac_intents WHERE id=$1',[id])).rows[0],operationId};
    };
    const counts=async(operationId:string)=>({
      grants:(await db.pool.query('SELECT count(*)::int n FROM ac_capacity_grants WHERE intent_id=(SELECT intent_id FROM ac_operations WHERE id=$1)',[operationId])).rows[0].n,
      operation:(await db.pool.query('SELECT state,grant_id,receipt,manager_epoch FROM ac_operations WHERE id=$1',[operationId])).rows[0],
      outbox:(await db.pool.query('SELECT state FROM ac_outbox WHERE intent_id=(SELECT intent_id FROM ac_operations WHERE id=$1)',[operationId])).rows[0].state,
      pause:(await db.pool.query('SELECT paused,pause_revision FROM ac_contexts WHERE id=$1',[context])).rows[0],
      messages:(await db.pool.query('SELECT count(*)::int n FROM ac_chat_messages')).rows[0].n,
      deliveries:(await db.pool.query('SELECT count(*)::int n FROM ac_deliveries')).rows[0].n,
      audits:(await db.pool.query("SELECT count(*)::int n FROM ac_audit WHERE context_id=$1 AND kind='workflow.version_retired'",[context])).rows[0].n,
    });
    runtime=new CezarRuntime(db,repo,project);await runtime.start();
    const retiredSnapshot={...current.definition,description:'retired-sentinel-9f3c'};
    const retired=await seed(retiredSnapshot,digest(retiredSnapshot));
    const divergent=await seed(retained.definition,current.digest);
    const wrong=await seed(retained.definition,retained.digest);
    await db.pool.query(`INSERT INTO ac_workflow_version_pins(intent_id,context_id,manager_epoch,workflow_name,workflow_version,workflow_digest,runtime_version,runtime_build,policy)
      VALUES($1,$2,$3,$4,'v1',$5,$6,$7,'pinned')`,[wrong.id,context,authority.epoch,retained.name,retained.digest,AGENT_CONTROL_RUNTIME_VERSION,AGENT_CONTROL_RUNTIME_BUILD]);
    const legacy=await seed(retained.definition,retained.digest);
    const before=await counts(retired.operationId);
    runtime.store.createRun({id:retired.run_id,title:'parked',workflow:current.name,task:`Intent ${retired.id}`,steps:[{id:'implement',name:'Synthetic implementation',kind:'agent'}]});
    runtime.store.updateRun(retired.run_id,{status:'waiting',error:'Managed execution awaiting authoritative reconciliation',workflowDef:retiredSnapshot});
    assert.equal(await runtime.dispatch(retired,authority),undefined);
    await runtime.recoverManaged(authority);
    await new Promise(resolve=>setTimeout(resolve,1100));
    await runtime.recoverManaged(authority);
    const after=await counts(retired.operationId);
    assert.equal(after.grants,0);
    assert.equal(after.operation.state,'registered');
    assert.equal(after.operation.grant_id,null);
    assert.equal(after.operation.receipt,null);
    assert.equal(String(after.operation.manager_epoch),String(before.operation.manager_epoch));
    assert.equal(after.outbox,'pending');
    assert.equal(after.pause.paused,false);
    assert.equal(after.pause.pause_revision,0);
    assert.equal(after.messages,before.messages);
    assert.equal(after.deliveries,before.deliveries);
    assert.equal(after.audits,1);
    assert.equal(workers(retired.operationId),0);
    assert.equal(workers(divergent.operationId),0);
    assert.equal(runtime.store.getRun(retired.run_id)?.status,'waiting');
    assert.equal(runtime.store.getRun(divergent.run_id),undefined);
    assert.equal((await runtime.reconcileWorkflowVersion(divergent,authority)).state,'retired');
    assert.equal((await counts(divergent.operationId)).grants,0);
    assert.equal((await counts(divergent.operationId)).audits,after.audits+1);
    const kept=await runtime.reconcileWorkflowVersion(legacy,authority);
    assert.equal(kept.state,'retained');
    if(kept.state!=='retained')return;
    assert.equal(kept.version,'v0');
    assert.equal(digest(kept.definition),retained.digest);
    assert.notEqual(digest(kept.definition),current.digest);
    assert.equal(workers(legacy.operationId),0);
    const pin=(await db.pool.query('SELECT workflow_version,workflow_digest,manager_epoch,runtime_version,runtime_build,policy FROM ac_workflow_version_pins WHERE intent_id=$1',[legacy.id])).rows[0];
    assert.equal(pin.workflow_version,'v0');
    assert.equal(pin.workflow_digest,retained.digest);
    assert.equal(Number(pin.manager_epoch),authority.epoch);
    assert.equal(pin.runtime_version,AGENT_CONTROL_RUNTIME_VERSION);
    assert.equal(pin.runtime_build,AGENT_CONTROL_RUNTIME_BUILD);
    assert.equal(pin.policy,'pinned');
    await assert.rejects(db.pool.query("UPDATE ac_workflow_version_pins SET workflow_version='v9' WHERE intent_id=$1",[legacy.id]),/WORKFLOW_VERSION_PIN_IMMUTABLE/);
    const resumed=await runtime.dispatch(legacy,authority);
    assert.equal(digest(resumed?.workflowDef),retained.digest);
    assert.notEqual(digest(resumed?.workflowDef),current.digest);
    const body={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start' as const,payload:{workflow:'baseline-synthetic-v1' as const,messageRef:'encrypted:current-fixture'}};
    const fresh=await db.accept(principal,body,authority,'api');
    const started=await runtime.dispatch(fresh,authority);
    assert.equal(digest(started?.workflowDef),current.digest);
    const freshPin=(await db.pool.query('SELECT workflow_version,runtime_version,runtime_build,policy FROM ac_workflow_version_pins WHERE intent_id=$1',[fresh.id])).rows[0];
    assert.equal(freshPin.workflow_version,'v1');
    assert.equal(freshPin.runtime_version,AGENT_CONTROL_RUNTIME_VERSION);
    assert.equal(freshPin.runtime_build,AGENT_CONTROL_RUNTIME_BUILD);
    assert.equal(freshPin.policy,'pinned');
    const diagnostics=new ContextDiagnostics(db,project);
    const report=await diagnostics.workflowVersions(principal,context);
    assert.equal(agentControlDiagnosticsSchema.parse(await diagnostics.read(principal,context)).contextId,context);
    const view=await new Control(db).view(viewer,context);
    assert.equal(view.workflowVersions.readOnly,true);
    assert.equal(view.workflowVersions.policy,'pinned');
    const rendered=JSON.stringify({report,slice:view.workflowVersions});
    assert.equal(rendered.includes('retired-sentinel-9f3c'),false);
    assert.equal(rendered.includes('retained-v0'),false);
    assert.equal(rendered.includes('Execute the fixed isolated baseline fixture'),false);
    assert.equal(rendered.includes('encrypted:version-fixture'),false);
    assert.equal(report.blocked.some(item=>item.intentId===retired.id&&item.cause==='WORKFLOW_VERSION_RETIRED'&&item.reason==='unregistered'),true);
    assert.equal(report.blocked.some(item=>item.intentId===divergent.id&&item.reason==='divergent'),true);
    assert.equal(report.blocked.some(item=>item.intentId===wrong.id&&item.reason==='divergent'),true);
    assert.equal(report.inUse.some(item=>item.intentId===legacy.id&&item.workflowVersion==='v0'&&item.persistence==='recorded'&&item.runtimeBuild===AGENT_CONTROL_RUNTIME_BUILD),true);
    assert.equal(report.inUse.some(item=>item.intentId===fresh.id&&item.workflowVersion==='v1'&&item.persistence==='recorded'),true);
    assert.equal(report.registry.some(item=>item.name==='baseline-synthetic-v1'&&item.status==='retained'&&item.policy==='pinned'),true);
    await assert.rejects(diagnostics.workflowVersions(outsider,context),(error:unknown)=>error instanceof Refusal&&error.code==='CONTEXT_FORBIDDEN');
    await assert.rejects(new ContextDiagnostics(db,randomUUID()).workflowVersions(principal,context),(error:unknown)=>error instanceof Refusal&&error.code==='PROJECT_RUNTIME_MISMATCH');
    await assert.rejects(new Control(db,[],randomUUID()).view(principal,context),(error:unknown)=>error instanceof Refusal&&error.code==='PROJECT_RUNTIME_MISMATCH');
  }finally{
    await runtime?.close();
    await db.close();
    await fixture.close();
    if(repo)await rm(repo,{recursive:true,force:true});
  }
});
