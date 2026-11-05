import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,cp,symlink,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createLocalWorkflowRuntime} from '../src/local-workflow-runtime.ts';
import {execFile,spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import {Ledger} from '../src/ledger.ts';
import {digest,Refusal} from '../src/contracts.ts';
import {HappierEndpoint} from '../src/happier.ts';
import {ManagerPlans,type ManagerPlan} from '../src/planning.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';
import {WorkflowGenerations} from '../src/workflow-generations.ts';
import {workflowVersionRegistry} from '../src/workflow-versions.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

let fixture:Awaited<ReturnType<typeof isolatedDatabase>>,db:Ledger;
const principal='synthetic-generation-owner',hash='a'.repeat(64),workflowDigests=workflowVersionRegistry.map(x=>x.digest);
before(async()=>{const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');fixture=await isolatedDatabase(base,'generations');db=new Ledger(fixture.url);await db.migrate();});
after(async()=>{await db?.close();await fixture?.close();});
async function setup(incompatible=false){
 const project=randomUUID(),session=randomUUID();await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'synthetic-generation']);
 await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
 const installed=await mkdtemp(join(tmpdir(),'ac-r4-installed-generation-'));
 await cp(resolve('src'),join(installed,'src'),{recursive:true});
 if(incompatible){const versions=join(installed,'src/workflow-versions.ts');await writeFile(versions,(await readFile(versions,'utf8')).replace("  entry(baselineWorkflow, 'v1', 'current'), entry(baselineWorkflow, 'v0', 'retained'),\n",''));}
 await writeFile(join(installed,'src/cezar.ts'),(await readFile(join(installed,'src/cezar.ts'),'utf8'))+'\n// Compatible installed build: identical frozen graph protocol, new package bytes.\n');
 for(const name of ['node_modules','upstream','db','package.json','package-lock.json','adapters'])await symlink(resolve(name),join(installed,name));
 const nextModule=await import(pathToFileURL(join(installed,'src/local-workflow-runtime.ts')).href),nextLedger=await import(pathToFileURL(join(installed,'src/ledger.ts')).href),nextGenerations=await import(pathToFileURL(join(installed,'src/workflow-generations.ts')).href),nextCezar=await import(pathToFileURL(join(installed,'src/cezar.ts')).href),nextHandoff=await import(pathToFileURL(join(installed,'src/workflow-runtime-handoff.ts')).href);
 const oldCapability=await createLocalWorkflowRuntime(),nextCapability=await nextModule.createLocalWorkflowRuntime();
 const oldIdentity=oldCapability.identity,nextIdentity=nextCapability.identity;assert.notEqual(oldIdentity.buildId,nextIdentity.buildId);
 const old=new Ledger(fixture.url,undefined,oldIdentity),next:Ledger=new nextLedger.Ledger(fixture.url,undefined,nextIdentity),generations=new WorkflowGenerations(old),newGenerations:WorkflowGenerations=new nextGenerations.WorkflowGenerations(next);
 const context=await db.createContext(principal,project,session),authority=await old.acquire(principal,context,randomUUID(),'synthetic-fixture',60);
 await generations.announce(principal,project,oldCapability,60);await newGenerations.announce(principal,project,nextCapability,60);
 await generations.selectForNew(principal,project,oldIdentity.buildId);
 const accept=async(ledger=old)=>ledger.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:synthetic-generation'}},authority,'api');
 const intent=await accept();
 return {oldCapability,nextCapability,nextCezar,nextHandoff,project,session,context,authority,intent,old,next,generations,newGenerations,oldIdentity,nextIdentity,accept,close:async()=>{await old.close();await next.close();await rm(installed,{recursive:true,force:true});}};
}
const code=(wanted:string)=>(error:unknown)=>{assert.equal((error as {code?:string}).code,wanted);return true;};
test('two live installed runtime identities preserve old routing and route only new admissions to selected build',async()=>{
 const s=await setup();let folder:string|undefined,runtime:CezarRuntime|undefined;
 try{
  await s.generations.selectForNew(principal,s.project,s.nextIdentity.buildId);const newer=await s.accept(s.next);
  await s.old.tx(c=>s.old.assertIntentActive(c,s.context,s.intent.id));await s.next.tx(c=>s.next.assertIntentActive(c,s.context,newer.id));
  await assert.rejects(s.next.tx(c=>s.next.assertIntentActive(c,s.context,s.intent.id)),code('WORKFLOW_RUNTIME_ROUTE_MISMATCH'));
  await assert.rejects(s.old.tx(c=>s.old.assertIntentActive(c,s.context,newer.id)),code('WORKFLOW_RUNTIME_ROUTE_MISMATCH'));
  folder=await mkdtemp(join(tmpdir(),'ac-r4-generation-runtime-'));runtime=new CezarRuntime(s.old,folder,s.project);
  runtime.store.createRun({id:s.intent.run_id,title:'retained synthetic graph',task:'Intent '+s.intent.id,workflow:'baseline-synthetic-v1',steps:[{id:'implement',name:'Implementation',kind:'agent'}]});runtime.store.flush();
  const pinned=await runtime.reconcileWorkflowVersion(s.intent,s.authority);assert.equal(pinned.state,'current');
  await assert.rejects(s.generations.releaseRetained(principal,s.project,s.oldIdentity.buildId),code('RUNTIME_STILL_REQUIRED'));
  await s.old.pool.query("UPDATE ac_workflow_runtime_instances SET lease_until=clock_timestamp()-interval '1 second' WHERE instance_id=$1",[s.oldIdentity.instanceId]);
  await assert.rejects(runtime.reconcileWorkflowVersion(s.intent,s.authority),code('WORKFLOW_RUNTIME_UNAVAILABLE'));
  assert.equal(runtime.store.getRun(s.intent.run_id)?.task,'Intent '+s.intent.id);
 }finally{await runtime?.close();if(folder)await rm(folder,{recursive:true,force:true});await s.close();}
});
test('paused pending outbox, message and uncertain operation survive fenced generation and stay parked until physical reconciliation',async()=>{
 const s=await setup();let folder:string|undefined,runtime:CezarRuntime|undefined,newRuntime:CezarRuntime|undefined;
 try{
  folder=await mkdtemp(join(tmpdir(),'ac-r4-generation-pending-'));runtime=new CezarRuntime(s.old,folder,s.project);
  runtime.store.createRun({id:s.intent.run_id,title:'Pending compatible graph',task:'Intent '+s.intent.id,workflow:'baseline-synthetic-v1',steps:[{id:'implement',name:'Pending implementation',kind:'agent'}]});
  runtime.store.updateRun(s.intent.run_id,{status:'waiting',error:'Managed execution awaiting authoritative reconciliation',workflowDef:workflowVersionRegistry.find(x=>x.name==='baseline-synthetic-v1'&&x.status==='current')!.definition,graphState:{cursor:'implement',outputs:{},loops:{},taken:[]}});
  runtime.store.appendEvent(s.intent.run_id,{type:'note',message:'Safe pending history remains readable.'});runtime.store.flush();
  const graphBefore=runtime.store.getRun(s.intent.run_id),eventsBefore=runtime.store.readEvents(s.intent.run_id);
  await s.old.pool.query('INSERT INTO ac_chat_messages(id,session_id,ciphertext) VALUES($1,$2,$3)',['synthetic-'+randomUUID(),s.session,'ciphertext-only']);
  await s.old.pause(principal,s.context,true);await s.old.pool.query("UPDATE ac_operations SET state='uncertain',handle=$2 WHERE id=$1",[s.intent.operation_id,{synthetic:'stable-handle'}]);
  const before=(await s.old.pool.query(`SELECT i.*,o.state AS operation_state,o.handle,b.id AS outbox_id,b.state AS outbox_state,x.paused,x.pause_revision
   FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id JOIN ac_outbox b ON b.intent_id=i.id JOIN ac_contexts x ON x.id=i.context_id WHERE i.id=$1`,[s.intent.id])).rows[0];
  const request={intentId:s.intent.id,expectedGeneration:0,requestId:randomUUID(),targetBuild:s.nextIdentity.buildId,successorManagerInstance:randomUUID()};
  const result=await s.generations.rollover(principal,s.authority,request);assert.equal(result.generation,1);assert.equal(result.continuation.pendingMessages,1);assert.equal(result.continuation.paused,true);
  assert.deepEqual(await s.generations.rollover(principal,s.authority,request),result,'lost ACK replay must return same successor');
  const after=(await s.old.pool.query(`SELECT i.*,o.state AS operation_state,o.handle,b.id AS outbox_id,b.state AS outbox_state,x.paused,x.pause_revision
   FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id JOIN ac_outbox b ON b.intent_id=i.id JOIN ac_contexts x ON x.id=i.context_id WHERE i.id=$1`,[s.intent.id])).rows[0];assert.deepEqual(after,before);
  await assert.rejects(s.old.pool.query("UPDATE ac_workflow_generations SET continuation='{}' WHERE intent_id=$1 AND generation=1",[s.intent.id]),/WORKFLOW_GENERATION_IMMUTABLE/);
  await assert.rejects(s.old.heartbeat(s.authority),code('STALE_MANAGER'));
  await assert.rejects(s.old.tx(c=>s.old.fence(c,s.authority)),code('STALE_MANAGER'));
  await assert.rejects(s.next.tx(c=>s.next.fence(c,result.authority)),code('WORKFLOW_GENERATION_RECONCILIATION_REQUIRED'));
  await assert.rejects(s.newGenerations.reconciled(principal,result.authority,s.intent.id),code('GENERATION_EFFECT_RECONCILIATION_REQUIRED'));
  // Synthetic external-effect receipt stands in for the existing physical
  // reconciler; rollover itself must never invent completion or respawn.
  await s.next.pool.query("UPDATE ac_operations SET state='completed',receipt=$2 WHERE id=$1",[s.intent.operation_id,{synthetic:true,existingHandleReconciled:true}]);
  await s.newGenerations.reconciled(principal,result.authority,s.intent.id);
  await assert.rejects(s.next.tx(c=>s.next.fence(c,result.authority)),code('HUMAN_PAUSED'));
  await s.next.pause(principal,s.context,false);await s.next.tx(c=>s.next.fence(c,result.authority));
  await assert.rejects(s.old.tx(c=>s.old.assertIntentActive(c,s.context,s.intent.id)),code('WORKFLOW_RUNTIME_ROUTE_MISMATCH'));
  assert.deepEqual(await s.newGenerations.releaseRetained(principal,s.project,s.oldIdentity.buildId),{released:1});
  await runtime.close();runtime=undefined;newRuntime=new s.nextCezar.CezarRuntime(s.next,folder,s.project);
  assert.deepEqual(JSON.parse(JSON.stringify(newRuntime!.store.getRun(s.intent.run_id))),JSON.parse(JSON.stringify(graphBefore)));assert.deepEqual(newRuntime!.store.readEvents(s.intent.run_id),eventsBefore);
  assert.equal((await newRuntime!.reconcileWorkflowVersion(s.intent,result.authority)).state,'current');
 }finally{await runtime?.close();await newRuntime?.close();if(folder)await rm(folder,{recursive:true,force:true});await s.close();}
});
test('missing or incompatible target runtime cannot create successor or fence old manager',async()=>{
 const s=await setup(true);try{
  await assert.rejects(s.generations.announce(principal,s.project,{identity:{instanceId:randomUUID(),buildId:'caller-asserted'}}),code('LOCAL_RUNTIME_CAPABILITY_REQUIRED'));
  // Actual second installed package omits baseline from its trusted catalog; caller cannot supply a digest list.
  for(const targetBuild of ['missing',s.nextIdentity.buildId])await assert.rejects(s.generations.rollover(principal,s.authority,{intentId:s.intent.id,expectedGeneration:0,requestId:randomUUID(),targetBuild,successorManagerInstance:randomUUID()}),code('WORKFLOW_RUNTIME_MISSING_OR_INCOMPATIBLE'));
  assert.equal((await s.old.pool.query('SELECT count(*) FROM ac_workflow_generations WHERE intent_id=$1',[s.intent.id])).rows[0].count,'1');await s.old.heartbeat(s.authority);
 }finally{await s.close();}
});
test('real subprocess crash before commit rolls back; crash after commit and replay preserve one successor',async()=>{
 const s=await setup();try{
  for(const where of ['before-commit','after-commit']){
   const request={intentId:s.intent.id,expectedGeneration:0,requestId:randomUUID(),targetBuild:s.nextIdentity.buildId,successorManagerInstance:randomUUID()},payload={identity:s.oldIdentity,principal,authority:s.authority,request};
   await assert.rejects(promisify(execFile)(process.execPath,['--import','tsx','tests/fixtures/workflow-rollover-crash.ts',fixture.url,JSON.stringify(payload),where],{cwd:process.cwd(),timeout:15000,env:{PATH:process.env.PATH,HOME:tmpdir(),LANG:'C.UTF-8',TZ:'UTC'}}),error=>{assert.equal((error as {signal?:string}).signal,'SIGKILL');return true;});
   const count=(await s.old.pool.query('SELECT count(*) FROM ac_workflow_generations WHERE intent_id=$1',[s.intent.id])).rows[0].count;
   if(where==='before-commit'){assert.equal(count,'1');await s.old.heartbeat(s.authority);}
   else{assert.equal(count,'2');const replay=await s.generations.rollover(principal,s.authority,request);assert.equal(replay.generation,1);assert.equal(replay.authority.instanceId,request.successorManagerInstance);}
  }
 }finally{await s.close();}
});

test('root generation barrier cannot clear over a live child or independent stage effect',async()=>{
 const s=await setup();try{
  const child={id:randomUUID(),operation_id:randomUUID(),run_id:randomUUID()};
  await s.old.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,parent_intent_id,parent_unit_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'synthetic-child')`,[child.id,s.context,principal,hash,{...s.intent.command,intentId:child.id},child.operation_id,child.run_id,s.authority.epoch,s.intent.plan_revision,s.intent.id]);
  await s.old.pool.query("INSERT INTO ac_operations(id,intent_id,state,manager_epoch) VALUES($1,$2,'registered',$3)",[child.operation_id,child.id,s.authority.epoch]);
  await s.old.pool.query("UPDATE ac_operations SET state='running' WHERE id=$1",[child.operation_id]);
  const result=await s.generations.rollover(principal,s.authority,{intentId:s.intent.id,expectedGeneration:0,requestId:randomUUID(),targetBuild:s.nextIdentity.buildId,successorManagerInstance:randomUUID()});
  await assert.rejects(s.newGenerations.reconciled(principal,result.authority,s.intent.id),code('GENERATION_EFFECT_RECONCILIATION_REQUIRED'));
  await s.old.pool.query("UPDATE ac_operations SET state='completed',receipt=$2 WHERE id=$1",[child.operation_id,{synthetic:true}]);
  const stage=randomUUID();await s.old.pool.query("INSERT INTO ac_stage_operations(id,intent_id,node_id,session_id,attempt_id,manager_epoch,state) VALUES($1,$2,'review',$3,$4,$5,'uncertain')",[stage,child.id,randomUUID(),randomUUID(),s.authority.epoch]);
  await assert.rejects(s.newGenerations.reconciled(principal,result.authority,s.intent.id),code('GENERATION_EFFECT_RECONCILIATION_REQUIRED'));
  await s.old.pool.query("UPDATE ac_stage_operations SET state='completed',receipt=$2 WHERE id=$1",[stage,{synthetic:true}]);
  await s.newGenerations.reconciled(principal,result.authority,s.intent.id);
 }finally{await s.close();}
});

test('real old writer process stops on epoch fence; status history continues in bounded pages without cloning graph',async()=>{
 const s=await setup();let writer:ReturnType<typeof spawn>|undefined;
 try{
  for(let seq=1;seq<=205;seq++)await s.old.pool.query('INSERT INTO ac_events VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),s.context,s.intent.run_id,s.intent.plan_revision,seq,'waiting']);
  writer=spawn(process.execPath,['--import','tsx','tests/fixtures/workflow-generation-writer.ts',fixture.url,JSON.stringify(s.authority)],{cwd:process.cwd(),env:{PATH:process.env.PATH,HOME:tmpdir(),LANG:'C.UTF-8',TZ:'UTC'},stdio:['ignore','pipe','pipe']});
  let output='';writer.stdout!.on('data',bytes=>{output+=bytes;});
  for(let attempt=0;attempt<150&&!output.includes('READY');attempt++)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(output.includes('READY'),'WRITER_DID_NOT_START');
  const stopped=once(writer,'exit');
  const result=await s.generations.rollover(principal,s.authority,{intentId:s.intent.id,expectedGeneration:0,requestId:randomUUID(),targetBuild:s.nextIdentity.buildId,successorManagerInstance:randomUUID()});
  await Promise.race([stopped,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('OLD_WRITER_NOT_FENCED')),5000))]);assert.ok(output.includes('STALE_MANAGER'));
  assert.equal(result.continuation.historyAfterSeq,'205');
  const count=(await s.old.pool.query("SELECT count(*) FROM ac_audit WHERE context_id=$1 AND kind='synthetic.generation.writer'",[s.context])).rows[0].count;
  assert.ok(Number(count)>0);await new Promise(resolve=>setTimeout(resolve,60));assert.equal((await s.old.pool.query("SELECT count(*) FROM ac_audit WHERE context_id=$1 AND kind='synthetic.generation.writer'",[s.context])).rows[0].count,count);
  let cursor:string|null='0';const sequences:string[]=[];do{const page=await s.newGenerations.historyPage(principal,s.intent.id,result.generation,cursor,100);assert.ok(page.events.length<=100);sequences.push(...page.events.map(row=>row.seq));cursor=page.nextAfterSeq;}while(cursor);
  assert.equal(sequences.length,205);assert.equal(new Set(sequences).size,205);assert.equal(sequences[0],'1');assert.equal(sequences.at(-1),'205');
  await s.newGenerations.reconciled(principal,result.authority,s.intent.id);
 }finally{if(writer&&writer.exitCode===null)writer.kill('SIGKILL');await s.close();}
});

test('historical admitted081 terminal job does not permanently block; unresolved prejournal still parks',async()=>{
 const s=await setup();try{
  if(!(await s.old.pool.query("SELECT to_regclass('ac_native_resource_admissions') AS name")).rows[0].name)await s.old.pool.query(await readFile(new URL('./fixtures/workflow-generations-resource-081.sql',import.meta.url),'utf8'));
  const capacity=await provisionCapacity(s.old,principal,s.project);await capacity.service.assignPolicy(principal,s.context,capacity.revision);
  const granted=await capacity.service.reserve(principal,{attemptId:randomUUID(),intentId:s.intent.id,contextId:s.context,role:'programmer'},s.authority);assert.ok(granted);const grant=granted!;
  const job=randomUUID(),worker='1'.repeat(64),tools='2'.repeat(64),network='3'.repeat(64),physical={jobId:job,containerId:worker,toolsContainerId:tools,networkId:network,finishedAt:new Date().toISOString(),toolsFinishedAt:new Date().toISOString()};
  await s.old.pool.query(`INSERT INTO ac_native_resource_admissions(job_id,grant_id,context_id,manager_epoch,authority_id,names,state_root,state,reason)
   VALUES($1,$2,$3,$4,'synthetic-resource-host',$5,'/synthetic-private','admitted','admitted')`,[job,grant.id,s.context,s.authority.epoch,{}]);
  const result=await s.generations.rollover(principal,s.authority,{intentId:s.intent.id,expectedGeneration:0,requestId:randomUUID(),targetBuild:s.nextIdentity.buildId,successorManagerInstance:randomUUID()});
  await assert.rejects(s.newGenerations.reconciled(principal,result.authority,s.intent.id),code('GENERATION_EFFECT_RECONCILIATION_REQUIRED'));
  // Explicit synthetic terminal journal fixture, not a physical completion claim.
  await s.old.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state,worker_id,tools_id,network_id,receipt)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$9,$9,$9,$10,'programmer','completed',$11,$12,$13,$14)`,[job,grant.id,s.intent.id,s.context,s.authority.epoch,randomUUID(),grant.account_id,grant.profile_id,hash,'a'.repeat(40),worker,tools,network,{payload:{physicalDigest:digest(physical)}}]);
  await s.old.pool.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1",[grant.id,physical]);
  await assert.rejects(s.newGenerations.reconciled(principal,result.authority,s.intent.id),code('GENERATION_EFFECT_RECONCILIATION_REQUIRED'));
  await s.old.pool.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state,proof) VALUES($1,$2,'removed',$3)",[job,{synthetic:true},{syntheticRemoved:true}]);
  await s.newGenerations.reconciled(principal,result.authority,s.intent.id);
  assert.equal((await s.old.pool.query('SELECT state FROM ac_native_resource_admissions WHERE job_id=$1',[job])).rows[0].state,'admitted');
 }finally{await s.close();}
});

test('modern RunStore restart and first append use frozen record and bounded tail, without replaying large native transcript',async()=>{
 const s=await setup();let folder:string|undefined,runtime:CezarRuntime|undefined,reopened:CezarRuntime|undefined;
 const original={open:fs.openSync,read:fs.readSync,readFile:fs.readFileSync,close:fs.closeSync};let instrumented=false;
 try{
  folder=await mkdtemp(join(tmpdir(),'ac-r4-generation-history-'));runtime=new CezarRuntime(s.old,folder,s.project);
  runtime.store.createRun({id:s.intent.run_id,title:'Large durable pending graph',task:'Intent '+s.intent.id,workflow:'baseline-synthetic-v1',steps:[{id:'implement',name:'Implementation',kind:'agent'}]});
  runtime.store.updateRun(s.intent.run_id,{status:'waiting',error:'Managed execution awaiting authoritative reconciliation',workflowDef:workflowVersionRegistry.find(x=>x.name==='baseline-synthetic-v1'&&x.status==='current')!.definition,graphState:{cursor:'implement',outputs:{},loops:{},taken:[]}});
  for(let n=0;n<10000;n++)runtime.store.appendEvent(s.intent.run_id,{type:'note',message:'Safe retained native history '+n+' '+'safe '.repeat(40)});runtime.store.flush();
  const transition=await s.generations.rollover(principal,s.authority,{intentId:s.intent.id,expectedGeneration:0,requestId:randomUUID(),targetBuild:s.nextIdentity.buildId,successorManagerInstance:randomUUID()});
  await runtime.close();runtime=undefined;await s.newGenerations.reconciled(principal,transition.authority,s.intent.id);
  const transcript=join(folder,'.ai/cezar/runs',s.intent.run_id+'.ndjson'),fileBytes=fs.statSync(transcript).size;assert.ok(fileBytes>1024*1024);
  let tailBytes=0,wholeReads=0;const descriptors=new Set<number>();
  fs.openSync=((...args:unknown[])=>{const fd=(original.open as (...args:unknown[])=>number)(...args);if(String(args[0])===transcript)descriptors.add(fd);return fd;}) as typeof fs.openSync;
  fs.readSync=((...args:unknown[])=>{const count=(original.read as (...args:unknown[])=>number)(...args);if(descriptors.has(Number(args[0])))tailBytes+=count;return count;}) as typeof fs.readSync;
  fs.readFileSync=((...args:unknown[])=>{if(String(args[0])===transcript){wholeReads++;throw Error('UNBOUNDED_NATIVE_TRANSCRIPT_READ');}return (original.readFile as (...args:unknown[])=>unknown)(...args);}) as typeof fs.readFileSync;
  fs.closeSync=((fd:number)=>{descriptors.delete(fd);return original.close(fd);}) as typeof fs.closeSync;syncBuiltinESMExports();instrumented=true;
  reopened=new s.nextCezar.CezarRuntime(s.next,folder,s.project);reopened!.store.readEvents=()=>{throw Error('UNBOUNDED_NATIVE_EVENT_REPLAY');};
  await reopened!.start();assert.equal(reopened!.store.getRun(s.intent.run_id)?.graphState?.cursor,'implement');
  assert.equal((await reopened!.reconcileWorkflowVersion(s.intent,transition.authority)).state,'current');
  const next=reopened!.store.appendEvent(s.intent.run_id,{type:'note',message:'Safe event after renewed process.'});assert.equal(next.seq,10001);
  assert.equal(wholeReads,0);assert.ok(tailBytes>0&&tailBytes<=64*1024);assert.ok(tailBytes<fileBytes/10);
  console.log(JSON.stringify({modernManagedRecovery:true,retainedEvents:10000,transcriptBytes:fileBytes,wholeTranscriptReads:wholeReads,tailBytes,successorSeq:next.seq,graphCursor:'implement'}));
 }finally{if(instrumented){fs.openSync=original.open;fs.readSync=original.read;fs.readFileSync=original.readFile;fs.closeSync=original.close;syncBuiltinESMExports();}await runtime?.close();await reopened?.close();if(folder)await rm(folder,{recursive:true,force:true});await s.close();}
});

test('Happier tick parks absent old build per intent while new build admissions and queued delivery continue',async()=>{
 const s=await setup();let folder:string|undefined,runtime:CezarRuntime|undefined;
 try{
  await s.generations.selectForNew(principal,s.project,s.nextIdentity.buildId);const newer=await s.accept(s.next);
  await s.old.pool.query("UPDATE ac_workflow_runtime_instances SET lease_until=clock_timestamp()-interval '1 second' WHERE instance_id=$1",[s.oldIdentity.instanceId]);
  folder=await mkdtemp(join(tmpdir(),'ac-r4-generation-caller-'));runtime=new s.nextCezar.CezarRuntime(s.next,folder,s.project);
  const seen:string[]=[],waits:Record<string,unknown>[]= [];let flushed=false,delivered=false;
  // Transport shell only. Actual route/fence and workflow reconciliation use
  // PG/Ledger/Cezar; no message is sent to a real account or socket.
  const endpoint=Object.create(HappierEndpoint.prototype);
  Object.assign(endpoint,{ledger:s.next,options:{authority:s.authority,principal,sessionId:s.session},socket:{connected:true,emit:()=>{}},lastPendingAt:Date.now(),
   validateLink:async()=>s.next.tx(async c=>{await s.next.authorize(c,principal,s.context);await s.next.fence(c,s.authority,true);}),
   runtime:{reconcileCancellations:async()=>{throw new Refusal('WORKFLOW_RUNTIME_UNAVAILABLE');},recoverManaged:async()=>{throw new Refusal('WORKFLOW_RUNTIME_ROUTE_MISMATCH');},
    dispatch:async(intent:typeof newer,authority:typeof s.authority)=>{await runtime!.reconcileWorkflowVersion(intent,authority);seen.push(intent.id);return undefined;},
    observe:async()=>{throw Error('WRONG_RUNTIME_OBSERVE_FORBIDDEN');}},
   notifications:{observe:async(_principal:string,_authority:unknown,_session:string,value:Record<string,unknown>)=>{waits.push(value);}},
   receivePending:async()=>{},flushNotifications:async()=>{flushed=true;},deliverQueuedMessages:async()=>{delivered=true;}});
  await endpoint.tick();assert.deepEqual(seen,[newer.id]);assert.ok(waits.some(row=>row.entityId===s.intent.run_id&&row.reason==='RUNTIME_UNAVAILABLE'));assert.equal(flushed,true);assert.equal(delivered,true);
  const before=(await s.old.pool.query('SELECT state FROM ac_operations WHERE id=$1',[s.intent.operation_id])).rows[0].state;assert.equal(before,'registered');
 }finally{await runtime?.close();if(folder)await rm(folder,{recursive:true,force:true});await s.close();}
});

test('future managed plan is locally resolver-approved atomically without rewriting installed catalog, and target approves frozen compatibility',async()=>{
 const s=await setup();let folder:string|undefined,runtime:CezarRuntime|undefined;
 try{
  const catalogBefore=(await s.old.pool.query('SELECT workflow_digests FROM ac_workflow_runtime_instances WHERE instance_id=$1',[s.oldIdentity.instanceId])).rows[0].workflow_digests;
  const policy={schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireJudge:true,requireHumanIntegration:true,verifierDigest:hash};
  await s.old.pool.query('INSERT INTO ac_quality_policies VALUES($1,1,$2,$3)',[s.project,policy,digest(policy)]);
  const plan:ManagerPlan={schemaVersion:1,contextId:s.context,objectiveRef:'message:synthetic-objective',sourceMessageRef:'message:synthetic-request',constraintRefs:[],tasks:[{id:'one',objectiveRef:'message:synthetic-task',acceptanceRefs:['acceptance:synthetic-effect-v1'],inputRefs:[],outputRefs:['output:one'],dependsOn:[],writePaths:['src/one'],qualityRevision:1,targetRef:'refs/heads/main',maxCorrections:0}]};
  const proposal=await new ManagerPlans(s.old).publish(principal,s.authority,0,plan);
  const dynamic=await s.old.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:s.context,policyRevision:1,action:'plan.start',payload:{workflow:'managed-synthetic-v1',messageRef:'message:synthetic-request',proposalRevision:proposal.revision,proposalDigest:proposal.digest}},s.authority,'api');
  const frozen=(await s.old.pool.query('SELECT digest,snapshot FROM ac_frozen_plans WHERE intent_id=$1',[dynamic.id])).rows[0];
  assert.equal(catalogBefore.includes(frozen.digest),false);
  assert.equal((await s.old.pool.query('SELECT count(*) FROM ac_workflow_runtime_snapshots WHERE instance_id=$1 AND workflow_digest=$2',[s.oldIdentity.instanceId,frozen.digest])).rows[0].count,'1');
  assert.deepEqual((await s.old.pool.query('SELECT workflow_digests FROM ac_workflow_runtime_instances WHERE instance_id=$1',[s.oldIdentity.instanceId])).rows[0].workflow_digests,catalogBefore);
  await assert.rejects(s.generations.rollover(principal,s.authority,{intentId:dynamic.id,expectedGeneration:0,requestId:randomUUID(),targetBuild:s.nextIdentity.buildId,successorManagerInstance:randomUUID()}),code('WORKFLOW_RUNTIME_MISSING_OR_INCOMPATIBLE'));
  await s.newGenerations.approveFrozen(principal,s.project,s.nextCapability,dynamic.id);
  const next=await s.generations.rollover(principal,s.authority,{intentId:dynamic.id,expectedGeneration:0,requestId:randomUUID(),targetBuild:s.nextIdentity.buildId,successorManagerInstance:randomUUID()});await s.newGenerations.reconciled(principal,next.authority,dynamic.id);
  folder=await mkdtemp(join(tmpdir(),'ac-r4-dynamic-runtime-'));runtime=new s.nextCezar.CezarRuntime(s.next,folder,s.project);
  assert.equal((await runtime!.reconcileWorkflowVersion(dynamic,next.authority)).state,'dynamic');
  await assert.rejects(s.old.pool.query('DELETE FROM ac_workflow_runtime_snapshots WHERE instance_id=$1',[s.oldIdentity.instanceId]),/WORKFLOW_VERSION_PIN_IMMUTABLE/);
 }finally{await runtime?.close();if(folder)await rm(folder,{recursive:true,force:true});await s.close();}
});

test('actual prepared package handoff closes old Cezar lock, retries committed transfer, and lost ACK returns one live successor',async()=>{
 const s=await setup();let folder:string|undefined,source:CezarRuntime|undefined,successor:CezarRuntime|undefined,competitor:CezarRuntime|undefined;
 try{
  folder=await mkdtemp(join(tmpdir(),'ac-r4-real-package-handoff-'));source=new CezarRuntime(s.old,folder,s.project);
  source.store.createRun({id:s.intent.run_id,title:'Actual package handoff',task:'Intent '+s.intent.id,workflow:'baseline-synthetic-v1',steps:[{id:'implement',name:'Pending implementation',kind:'agent'}]});
  source.store.updateRun(s.intent.run_id,{status:'waiting',error:'Managed execution awaiting authoritative reconciliation',workflowDef:workflowVersionRegistry.find(x=>x.name==='baseline-synthetic-v1'&&x.status==='current')!.definition,graphState:{cursor:'implement',outputs:{},loops:{},taken:[]}});
  source.store.appendEvent(s.intent.run_id,{type:'note',message:'Safe durable handoff event.'});source.store.flush();await source.start('administration-only');assert.equal(source.ownsRuntimeLock,true);
  competitor=new s.nextCezar.CezarRuntime(s.next,folder,s.project);await assert.rejects(competitor!.start('administration-only'),/RUNTIME_ALREADY_ACTIVE/);await competitor!.close();competitor=undefined;
  const request={authority:s.authority,intentId:s.intent.id,expectedGeneration:0,requestId:randomUUID(),successorManagerInstance:randomUUID()};
  const denied=await s.nextHandoff.prepareWorkflowRuntime({ledger:s.next,capability:s.nextCapability,principal,runtimeArguments:[s.next,folder,s.project]});
  await assert.rejects(denied.handoffFrom(source,request,{mode:'execution'}),/RUNTIME_EXECUTION_ACTIVATION_NOT_AUTHORIZED/);assert.equal(source.ownsRuntimeLock,true);await s.old.heartbeat(s.authority);
  const prepared=await s.nextHandoff.prepareWorkflowRuntime({ledger:s.next,capability:s.nextCapability,principal,runtimeArguments:[s.next,folder,s.project],allowExecutionActivation:true});
  const otherContext=await db.createContext(principal,s.project,randomUUID()),otherAuthority=await s.old.acquire(principal,otherContext,randomUUID(),'synthetic-other',60);
  const other=await s.old.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:otherContext,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:other'}},otherAuthority,'api');
  const stage=randomUUID();await s.old.pool.query("INSERT INTO ac_stage_operations(id,intent_id,node_id,session_id,attempt_id,manager_epoch,state) VALUES($1,$2,'review',$3,$4,$5,'uncertain')",[stage,other.id,randomUUID(),randomUUID(),otherAuthority.epoch]);
  await assert.rejects(prepared.handoffFrom(source,request,{mode:'execution'}),code('GENERATION_EFFECT_RECONCILIATION_REQUIRED'));
  assert.equal(source.ownsRuntimeLock,true);assert.equal((await s.next.pool.query('SELECT state FROM ac_workflow_project_handoffs WHERE request_id=$1',[request.requestId])).rows[0].state,'active');
  await assert.rejects(s.old.tx(c=>s.old.fence(c,otherAuthority)),code('WORKFLOW_PROJECT_HANDOFF_REQUIRED'));
  await s.old.pool.query("UPDATE ac_stage_operations SET state='completed',receipt=$2 WHERE id=$1",[stage,{synthetic:true}]);
  await assert.rejects(prepared.handoffFrom(source,request,{mode:'execution',reconcile:async(administration:CezarRuntime)=>{assert.equal(source!.ownsRuntimeLock,false);assert.equal(administration.ownsRuntimeLock,true);assert.equal(administration.executionMode,'administration-only');throw Error('SYNTHETIC_RECONCILER_RETRY');}}),/SYNTHETIC_RECONCILER_RETRY/);
  assert.equal((await s.next.pool.query("SELECT state FROM ac_workflow_generations WHERE intent_id=$1 AND generation=1",[s.intent.id])).rows[0].state,'reconciling');assert.equal(source.ownsRuntimeLock,false);
  assert.equal((await s.next.pool.query('SELECT state FROM ac_workflow_project_handoffs WHERE request_id=$1',[request.requestId])).rows[0].state,'active');
  const outcome=await prepared.handoffFrom(source,request,{mode:'execution',reconcile:async(administration:CezarRuntime,authority:typeof s.authority)=>{assert.equal(administration.ownsRuntimeLock,true);await assert.rejects(s.next.tx(c=>s.next.fence(c,authority)),code('WORKFLOW_PROJECT_HANDOFF_REQUIRED'));}});
  successor=outcome.runtime;assert.equal(successor!.ownsRuntimeLock,true);assert.equal(successor!.executionMode,'execution');assert.equal(successor!.store.getRun(s.intent.run_id)?.graphState?.cursor,'implement');assert.equal(successor!.store.readEvents(s.intent.run_id)[0]?.type,'note');
  successor!.store.appendEvent(s.intent.run_id,{type:'note',message:'Safe successor event after ACK loss.'});
  const replay=await prepared.handoffFrom(source,request,{mode:'execution'});assert.equal(replay.runtime,successor);assert.equal(replay.authority.epoch,s.authority.epoch+1);assert.equal(successor!.store.getRun(s.intent.run_id)?.lastSeq,2);
  assert.equal((await s.next.pool.query('SELECT state FROM ac_workflow_project_handoffs WHERE request_id=$1',[request.requestId])).rows[0].state,'released');
  await assert.rejects(prepared.handoffFrom(source,{...request,successorManagerInstance:randomUUID()},{mode:'execution'}),code('GENERATION_REQUEST_CONFLICT'));
  assert.equal((await s.next.pool.query('SELECT count(*) FROM ac_workflow_generations WHERE intent_id=$1',[s.intent.id])).rows[0].count,'2');await assert.rejects(s.old.heartbeat(s.authority),code('STALE_MANAGER'));
 }finally{await competitor?.close();await source?.close();await successor?.close();if(folder)await rm(folder,{recursive:true,force:true});await s.close();}
});
