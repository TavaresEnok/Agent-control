import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,generateKeyPairSync,sign,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger,type Intent} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {QualityPolicies} from '../src/quality-policy.ts';
import {Templates} from '../src/templates.ts';
import {ContextKeys,keyFingerprint} from '../src/context-keys.ts';
import {SemanticPlanning,planningReceiptMessage,type PlanningExecutor} from '../src/semantic-planning.ts';
import {HappierEndpoint,type HappierBoundary} from '../src/happier.ts';
import {LocalConversationTransport} from '../src/conversation-transport.ts';
import {personalPanelLocalId} from '../src/personal-panel-conversation.ts';
import {digest,type Authority} from '../src/contracts.ts';
import {decideProposal,proposalStartIntentId} from '../src/proposal-decision.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import type {CezarRuntime} from '../src/cezar.ts';
import type {PersonalManagerChat} from '../src/personal-manager-chat.ts';

/** The standard test base gets its own throwaway database. Any other database named by AC_TEST_DATABASE_URL (a
 * dedicated one for a work branch) is used directly, with random project and context ids. */
async function testDatabase(label:string){
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 if(new URL(base).pathname==='/ac_implementation_test'){const isolated=await isolatedDatabase(base,label);return {url:isolated.url,close:()=>isolated.close()};}
 return {url:base,close:async()=>{}};
}

async function context(db:Ledger){
 const project=randomUUID(),principal='proposal-'+randomUUID();
 await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'proposal decisions']);
 await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
 return {project,principal,contextId:await db.createContext(principal,project,randomUUID())};
}
/** What the managed execution looks like to the ledger for these tests: the intent row, created by the same insert the ledger performs. */
async function startRow(db:Ledger,contextId:string,principal:string,id:string,revision:number,proposalDigest:string){
 const command={schemaVersion:1,contextId,intentId:id,policyRevision:1,action:'plan.start',payload:{workflow:'managed-synthetic-v1',messageRef:'approved:'+proposalDigest.slice(0,32),proposalRevision:revision,proposalDigest,native:true}};
 // Like the ledger, asking again for the same intent id returns the existing intent.
 await db.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision)
  VALUES($1,$2,$3,$4,$5,$6,$7,1,$8) ON CONFLICT(id) DO NOTHING`,[id,contextId,principal,digest(command),command,randomUUID(),randomUUID(),revision]);
 return (await db.pool.query('SELECT * FROM ac_intents WHERE id=$1',[id])).rows[0] as Intent;
}
const executions=async(db:Ledger,contextId:string)=>(await db.pool.query("SELECT count(*)::int n FROM ac_intents WHERE context_id=$1 AND command->>'action'='plan.start'",[contextId])).rows[0].n as number;
const decisions=async(db:Ledger,contextId:string)=>(await db.pool.query('SELECT revision,decision,source,intent_id FROM ac_proposal_decisions WHERE context_id=$1 ORDER BY revision',[contextId])).rows;
const decideOnce=(db:Ledger,contextId:string,revision:number,proposalDigest:string,decision:'approved'|'discarded')=>db.tx(c=>decideProposal(c,{contextId,revision,digest:proposalDigest,decision,source:'manual'}));

test('approve and approve, approve and discard, and a repeat after a lost response all read one durable decision',async()=>{
 const database=await testDatabase('propdec'),db=new Ledger(database.url);
 try{
  await db.migrate();
  const {contextId,principal}=await context(db),d='a'.repeat(64);
  // approve/approve in parallel: one decision row, one execution id, and exactly one created.
  const both=await Promise.all([decideOnce(db,contextId,1,d,'approved'),decideOnce(db,contextId,1,d,'approved')]);
  assert.equal(both.filter(item=>item.created).length,1);
  assert.equal(both[0].decision.intentId,both[1].decision.intentId);
  assert.equal(both[0].decision.intentId,proposalStartIntentId(contextId,1));
  // approve/discard in parallel: whichever commits first stands, the other reads it; never both.
  const opposite=await Promise.all([decideOnce(db,contextId,2,d,'approved'),decideOnce(db,contextId,2,d,'discarded')]);
  assert.equal(opposite.filter(item=>item.created).length,1);
  assert.equal(opposite[0].decision.decision,opposite[1].decision.decision);
  const rows=await decisions(db,contextId);assert.deepEqual(rows.map(row=>row.revision),[1,2]);
  // a repeat after a lost response returns the stored decision without writing again, even with the opposite word
  const repeat=await decideOnce(db,contextId,1,d,'discarded');
  assert.equal(repeat.created,false);assert.equal(repeat.decision.decision,'approved');
  // a decision is bound to the proposal digest
  await assert.rejects(decideOnce(db,contextId,1,'b'.repeat(64),'approved'),/PROPOSAL_DIGEST_CONFLICT/);
  // the decision is immutable
  await assert.rejects(db.pool.query("UPDATE ac_proposal_decisions SET decision='discarded' WHERE context_id=$1 AND revision=1",[contextId]),/PROPOSAL_DECISION_IMMUTABLE/);
  // at most one execution per proposal, whoever starts it: the decided id once, never a second intent, never after a discard
  const approved=rows.find(row=>row.revision===1)!;
  const started=await Promise.allSettled([startRow(db,contextId,principal,approved.intent_id,1,d),startRow(db,contextId,principal,randomUUID(),1,d)]);
  assert.equal(started.filter(item=>item.status==='fulfilled').length,1);
  assert.equal(await executions(db,contextId),1);
  assert.match(String((started.find(item=>item.status==='rejected') as PromiseRejectedResult|undefined)?.reason?.message??''),/PROPOSAL_ALREADY_DECIDED/);
  const second=rows.find(row=>row.revision===2)!;
  // a second intent never starts a decided proposal: refused after a discard, and refused when its id is not the decided one
  await assert.rejects(startRow(db,contextId,principal,randomUUID(),2,d),/PROPOSAL_ALREADY_DECIDED/);
  assert.ok(second);
  // an intent that goes through the ledger alone (API, panel) records its own decision and blocks a later discard
  const direct=randomUUID();await startRow(db,contextId,principal,direct,3,d);
  assert.deepEqual((await decisions(db,contextId)).find(row=>row.revision===3)?.decision,'approved');
  assert.equal((await decideOnce(db,contextId,3,d,'discarded')).decision.decision,'approved');
 }finally{await db.close();await database.close();}
});

/** Personal-mode bridge over the real ledger with a deterministic planner. Plan intents go through the real ledger; the
 * managed execution is the intent row the ledger writes, so executions can be counted, and a crash can be injected. */
async function personalFixture(autoApprove:boolean){
  const database=await testDatabase('propfix'),db=new Ledger(database.url),folder=await mkdtemp(join(tmpdir(),'ac-proposal-repo-'));
 const key=randomBytes(32),endpoints:HappierEndpoint[]=[];
 await db.migrate();
 const project=randomUUID(),principal='proposal-auto-'+randomUUID(),account=randomUUID(),profile=randomUUID(),session=randomUUID();
 await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'auto approve']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
 await db.pool.query('UPDATE ac_projects SET auto_approve_plans=$2 WHERE id=$1',[project,autoApprove]);
 await db.pool.query('INSERT INTO ac_control_admins VALUES($1) ON CONFLICT DO NOTHING',[principal]);
 const capacity=new Capacity(db);await capacity.configure(principal,{programmingLimit:8,evaluationLimit:2});
 await capacity.registerModel(principal,{provider:'fixture-planner',model:'fixture-model',efforts:['medium'],roles:['manager'],source:'synthetic://fixture'});
 await capacity.addAccount(principal,project,{id:account,provider:'fixture-planner',label:'fixture',resourceIdentity:account,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://fixture',maxConcurrent:1});
 await capacity.addProfile(principal,project,{id:profile,accountId:account,model:'fixture-model',effort:'medium',role:'manager'});
 await capacity.observeQuota(principal,account,{status:'available',source:'synthetic://fixture',ttlSeconds:300});
 const contextId=await db.createContext(principal,project,session);
 const rev=await capacity.publish(principal,project,0,{schemaVersion:1,maxProgrammersPerContext:8,maxEvaluatorsPerContext:2,roles:{manager:{regular:[profile],emergency:[]}}});await capacity.assignPolicy(principal,contextId,rev);
 const quality=await new QualityPolicies(db).publish(principal,project,0,{schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:true,verifierDigest:'a'.repeat(64)});
 await new Templates(db).publish(principal,contextId,0,{workflow:'semantic-proposal-v1',qualityRevision:quality,targetRef:'refs/heads/protected'});
 await new ContextKeys(db).authorize(principal,contextId,1,'legacy',keyFingerprint(key));
 const authority=await db.acquire(principal,contextId,randomUUID(),'fixture-manager',60);
 const keys=generateKeyPairSync('ed25519');
 const executor:PlanningExecutor={id:'fixture-chat',digest:'b'.repeat(64),publicKey:keys.publicKey.export({format:'der',type:'spki'}).toString('base64'),provider:'fixture-planner',mode:'synthetic',
  async execute(input){await input.assertAuthorized();
   const output=JSON.stringify({schemaVersion:1,contextId,objectiveRef:input.sourceMessageRef,sourceMessageRef:input.sourceMessageRef,parallelism:2,constraintRefs:[],tasks:[{id:'one',objectiveRef:input.sourceMessageRef,acceptanceRefs:[input.sourceMessageRef],inputRefs:[],outputRefs:['output:one'],dependsOn:[],writePaths:['src/one.txt'],qualityRevision:quality,targetRef:'refs/heads/protected',maxCorrections:0}]});
   const physical={jobId:input.callId,containerId:'c'.repeat(64),exitCode:0,finishedAt:new Date().toISOString(),synthetic:true};await db.pool.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1",[input.grantId,physical]);
   const payload={callId:input.callId,intentId:input.intentId,contextId,grantId:input.grantId,profileId:input.profile.id,sessionId:input.sessionId,epoch:input.executionEpoch,executorDigest:this.digest,inputDigest:input.inputDigest,profileDigest:digest(input.profile),outputDigest:createHash('sha256').update(output).digest('hex'),physicalDigest:digest(physical),exitCode:0};
   return {output,receipt:{payload,signature:sign(null,planningReceiptMessage(payload),keys.privateKey).toString('hex')}};},
  async reconcile(){return null;}};
 const planner=new SemanticPlanning(db,executor);
 const managerChat={async decide(){return {kind:'plan' as const,answer:''};}} as unknown as PersonalManagerChat;
 const runtime={repo:folder,projectId:project,executionMode:'execution',async reconcileCancellations(){},async recoverManaged(){},async dispatch(){return undefined;},store:{listRuns:()=>[],updateRun(){},flush(){}}} as unknown as CezarRuntime;
 const boundary=new Proxy({} as HappierBoundary,{get(){throw Error('BOUNDARY_FORBIDDEN');}});
 const control={crash:false,startAttempts:0};
 const realAccept=db.accept.bind(db);
 (db as unknown as {accept:unknown}).accept=async(p:string,command:{action:string;intentId:string;payload:{proposalRevision?:number;proposalDigest?:string}},...rest:unknown[])=>{
  if(command.action!=='plan.start')return (realAccept as (...args:unknown[])=>Promise<Intent>)(p,command,...rest);
  control.startAttempts++;if(control.crash)throw Error('PROCESS_DIED');
  return startRow(db,contextId,p,command.intentId,command.payload.proposalRevision!,command.payload.proposalDigest!);};
 const open=async()=>{const transport=new LocalConversationTransport({ledger:db,contextId,principal});
  const endpoint=new HappierEndpoint(db,runtime,boundary,{baseUrl:'http://127.0.0.1',token:'',key,principal,sessionId:session,machineId:'local',authority:authority as Authority,personalConversation:true,managerChat,semanticPlanning:planner},transport);
  await transport.start();endpoints.push(endpoint);return endpoint;};
 const say=async(endpoint:HappierEndpoint,text:string)=>endpoint.enqueueOwnerMessage(text,personalPanelLocalId('m'+randomUUID().slice(0,10)));
 return {db,contextId,control,open,say,async close(){for(const endpoint of endpoints)endpoint.close();key.fill(0);await db.close();await database.close();await rm(folder,{recursive:true,force:true});}};
}

test('auto-approval survives a crash right after the publication commit: restart creates exactly one execution',{timeout:60000},async()=>{
 const f=await personalFixture(true);
 try{
  const {db,contextId}=f;
  const say=(endpoint:HappierEndpoint,text:string)=>f.say(endpoint,text);
  // The first process dies when it asks for the execution, which is right after the publication commit.
  f.control.crash=true;
  const first=await f.open();await f.say(first,'crie o módulo de faturas');
  await assert.rejects(first.tick(),/PROCESS_DIED/);first.close();
  assert.equal(f.control.startAttempts,1);
  // The proposal is published and the planning intent is done; the process died before the execution existed.
  assert.equal((await db.pool.query("SELECT state FROM ac_intents WHERE context_id=$1 AND command->>'action'='plan.propose'",[contextId])).rows[0].state,'done');
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_manager_plans WHERE context_id=$1',[contextId])).rows[0].n,1);
  assert.equal(await executions(db,contextId),0);
  const stored=await decisions(db,contextId);assert.equal(stored.length,1);assert.equal(stored[0].decision,'approved');assert.equal(stored[0].source,'auto');
  // Restart: a new process finds the approved, unstarted proposal and creates exactly one execution, however many ticks follow.
  f.control.crash=false;
  const second=await f.open();
  await second.tick();await second.tick();await second.tick();
  assert.equal(await executions(db,contextId),1);
  const execution=(await db.pool.query("SELECT id,command FROM ac_intents WHERE context_id=$1 AND command->>'action'='plan.start'",[contextId])).rows[0];
  assert.equal(execution.id,proposalStartIntentId(contextId,1));assert.equal(execution.command.payload.proposalRevision,1);
  const plan=(await db.pool.query('SELECT revision,digest FROM ac_manager_plans WHERE context_id=$1',[contextId])).rows[0];
  assert.equal(execution.command.payload.proposalDigest,plan.digest);
  // A later manual answer is a repeat of the standing decision: no second execution, and a discard cannot undo it.
  await say(second,'aprovar');await say(second,'descartar');await second.tick();await second.tick();
  assert.equal(await executions(db,contextId),1);
  assert.equal((await decisions(db,contextId)).length,1);
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_audit WHERE context_id=$1 AND kind='proposal.discarded'",[contextId])).rows[0].n,0);
 }finally{await f.close();}
});

test('manual approve/approve, approve/discard and a repeat after a lost response give one durable decision and at most one execution',{timeout:90000},async()=>{
 const f=await personalFixture(false);
 try{
  const {db,contextId}=f;
  const bridge=await f.open();
  const propose=async(text:string)=>{await f.say(bridge,text);await bridge.tick();};
  const answer=(word:string)=>bridge.accept({localId:personalPanelLocalId('a'+randomUUID().slice(0,10)),text:word});
  // revision 1: approve and approve at the same time
  await propose('primeiro pedido de mudança');
  assert.equal((await decisions(db,contextId)).length,0);
  await Promise.all([answer('aprovar'),answer('aprovar')]);
  assert.equal(await executions(db,contextId),1);
  assert.deepEqual((await decisions(db,contextId)).map(row=>[row.revision,row.decision]),[[1,'approved']]);
  // revision 2: approve and discard at the same time; one decision stands, and the execution agrees with it
  await propose('segundo pedido de mudança');
  await Promise.all([answer('aprovar'),answer('descartar')]);
  const second=(await decisions(db,contextId)).find(row=>row.revision===2)!;
  assert.ok(second);
  assert.equal(await executions(db,contextId),second.decision==='approved'?2:1);
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_audit WHERE context_id=$1 AND kind='proposal.discarded'",[contextId])).rows[0].n,second.decision==='discarded'?1:0);
  await answer(second.decision==='approved'?'descartar':'aprovar');
  assert.equal((await decisions(db,contextId)).find(row=>row.revision===2)!.decision,second.decision);
  assert.equal(await executions(db,contextId),second.decision==='approved'?2:1);
  // revision 3: the answer is lost after the decision committed (the process dies before the execution exists)
  await propose('terceiro pedido de mudança');
  f.control.crash=true;
  await assert.rejects(answer('aprovar'),/PROCESS_DIED/);
  f.control.crash=false;
  const before=await executions(db,contextId);
  assert.equal((await decisions(db,contextId)).find(row=>row.revision===3)!.decision,'approved');
  await answer('aprovar');await answer('aprovar');
  assert.equal(await executions(db,contextId),before+1);
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_intents WHERE id=$1",[proposalStartIntentId(contextId,3)])).rows[0].n,1);
 }finally{await f.close();}
});
