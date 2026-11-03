import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,generateKeyPairSync,sign,createHash} from 'node:crypto';
import {Ledger,type Intent} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {QualityPolicies} from '../src/quality-policy.ts';
import {Cancellations} from '../src/cancellation.ts';
import {Templates} from '../src/templates.ts';
import {ContextKeys,keyFingerprint} from '../src/context-keys.ts';
import {SemanticPlanning,planningReceiptMessage,type PlanningExecutor} from '../src/semantic-planning.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {HappierEndpoint,loadHappier,stableId} from '../src/happier.ts';
import {digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('encrypted chat requests produce one durable proposal across ACK loss and pause, without dispatching an implementation',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const database=await isolatedDatabase(base,'conversation'),db=new Ledger(database.url),capacity=new Capacity(db);
 try{
  await db.migrate();const project=randomUUID(),principal='chat-planner-'+randomUUID(),account=randomUUID(),profile=randomUUID(),session=randomUUID(),key=randomBytes(32);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'isolated planning']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);await capacity.configure(principal,{programmingLimit:8,evaluationLimit:2});
  await capacity.registerModel(principal,{provider:'fixture-planner',model:'fixture-model',efforts:['medium'],roles:['manager'],source:'synthetic://fixture'});
  await capacity.addAccount(principal,project,{id:account,provider:'fixture-planner',label:'fixture',resourceIdentity:account,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://fixture',maxConcurrent:1});
  await capacity.addProfile(principal,project,{id:profile,accountId:account,model:'fixture-model',effort:'medium',role:'manager'});
  await capacity.observeQuota(principal,account,{status:'available',source:'synthetic://fixture',ttlSeconds:300});
  const context=await db.createContext(principal,project,session);
  const rev=await capacity.publish(principal,project,0,{schemaVersion:1,maxProgrammersPerContext:8,maxEvaluatorsPerContext:2,roles:{manager:{regular:[profile],emergency:[]}}});await capacity.assignPolicy(principal,context,rev);
  const quality=await new QualityPolicies(db).publish(principal,project,0,{schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:true,verifierDigest:'a'.repeat(64)});
  await new Templates(db).publish(principal,context,0,{workflow:'semantic-proposal-v1',qualityRevision:quality,targetRef:'refs/heads/protected'});
  await new ContextKeys(db).authorize(principal,context,1,'legacy',keyFingerprint(key));
  const authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  const keys=generateKeyPairSync('ed25519');let invocations=0,reconciliations=0,pending:Awaited<ReturnType<PlanningExecutor['execute']>>|null=null;
  const executor:PlanningExecutor={id:'fixture-chat',digest:'b'.repeat(64),publicKey:keys.publicKey.export({format:'der',type:'spki'}).toString('base64'),provider:'fixture-planner',mode:'synthetic',
   async execute(input){await input.assertAuthorized();invocations++;
    const output=JSON.stringify({schemaVersion:1,contextId:context,objectiveRef:input.sourceMessageRef,sourceMessageRef:input.sourceMessageRef,parallelism:2,constraintRefs:[],tasks:[{id:'one',objectiveRef:input.sourceMessageRef,acceptanceRefs:[input.sourceMessageRef],inputRefs:[],outputRefs:['output:one'],dependsOn:[],writePaths:['src/one.txt'],qualityRevision:quality,targetRef:'refs/heads/protected',maxCorrections:0}]});
    const physical={jobId:input.callId,containerId:'c'.repeat(64),exitCode:0,finishedAt:new Date().toISOString(),synthetic:true};await db.pool.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1",[input.grantId,physical]);
    const payload={callId:input.callId,intentId:input.intentId,contextId:context,grantId:input.grantId,profileId:input.profile.id,sessionId:input.sessionId,epoch:input.executionEpoch,executorDigest:this.digest,inputDigest:input.inputDigest,profileDigest:digest(input.profile),outputDigest:createHash('sha256').update(output).digest('hex'),physicalDigest:digest(physical),exitCode:0};
    pending={output,receipt:{payload,signature:sign(null,planningReceiptMessage(payload),keys.privateKey).toString('hex')}};throw Error('FIXTURE_ACK_LOST');},
   async reconcile(input){await input.assertAuthorized();reconciliations++;return pending;}};
  const planner=new SemanticPlanning(db,executor),boundary=await loadHappier();
  const endpoint=Object.create(HappierEndpoint.prototype) as HappierEndpoint;
  const options={baseUrl:'http://127.0.0.1',token:'synthetic',key,principal,sessionId:session,machineId:'synthetic',authority,semanticPlanning:planner};
  let dispatches=0,waiting=0;
  Object.defineProperties(endpoint,{ledger:{value:db},runtime:{value:{projectId:project,executionMode:'execution',dispatch:async()=>{dispatches++;},reconcileCancellations:async()=>{},recoverManaged:async()=>{}}},boundary:{value:boundary},options:{value:options},lifecycle:{value:new AbortController()},socket:{value:{connected:true,emit:()=>{}}},
   notifications:{value:{observe:async()=>{waiting++;}}},receivePending:{value:async()=>{}},flushNotifications:{value:async()=>{}},deliverQueuedMessages:{value:async()=>{}},
   seal:{value:(v:unknown)=>boundary.encodeBase64(boundary.encrypt(key,'legacy',v))}});
  const text='PRIVATE SYNTHETIC PLANNING REQUEST',localId='request-'+randomUUID();
  const first=await endpoint.accept({text,localId}),repeat=await endpoint.accept({text,localId});assert.equal(first.result.intentId,repeat.result.intentId);
  await assert.rejects(endpoint.accept({text:'different',localId}),/INTENT_PAYLOAD_CONFLICT/);
  const intents=await db.pool.query<Intent>('SELECT * FROM ac_intents WHERE context_id=$1',[context]);assert.equal(intents.rowCount,1);const intent=intents.rows[0];
  assert.equal(intent.command.payload.workflow,'semantic-proposal-v1');assert.equal(intent.command.action,'plan.propose');assert(!JSON.stringify(intent).includes(text));
  const protectedRuntime=Object.create(CezarRuntime.prototype) as CezarRuntime;Object.defineProperty(protectedRuntime,'executionEnabled',{value:true});
  await assert.rejects(protectedRuntime.dispatch(intent,authority),/PLANNING_INTENT_NOT_EXECUTION/);
  const message=(await db.pool.query('SELECT ciphertext FROM ac_chat_messages WHERE session_id=$1',[session])).rows[0];assert(!JSON.stringify(message).includes(text));
  await assert.rejects(db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.propose',payload:{workflow:'semantic-proposal-v1',localId:'forged',messageRef:'message:forged',messageDigest:digest('forged'),qualityRevision:quality,targetRef:'refs/heads/other'}},authority,'api'),/TEMPLATE_WORKFLOW_MISMATCH/);
  await endpoint.tick();assert.equal(invocations,1);assert.equal(dispatches,0);assert.equal(waiting,1);
  await db.pause(principal,context,true);await assert.rejects(endpoint.tick(),/HUMAN_PAUSED/);assert.equal(invocations,1);assert.equal(reconciliations,1);
  await db.pause(principal,context,false);
  const collisionId=session+'|proposal-'+stableId('semantic-proposal-v1\0'+intent.id);
  const collision=boundary.encodeBase64(boundary.encrypt(key,'legacy',{role:'user',content:{type:'text',text:'collision fixture'}}));
  await db.pool.query('INSERT INTO ac_chat_messages(id,session_id,ciphertext) VALUES($1,$2,$3)',[collisionId,session,collision]);
  await assert.rejects(endpoint.tick(),/CHAT_MESSAGE_CONFLICT/);assert.equal((await db.pool.query('SELECT state FROM ac_intents WHERE id=$1',[intent.id])).rows[0].state,'accepted');
  await db.pool.query('DELETE FROM ac_chat_messages WHERE id=$1',[collisionId]);
  await endpoint.tick();await endpoint.tick();assert.equal(dispatches,0);
  assert.equal(invocations,1);assert.equal(reconciliations,1);
  assert.equal((await db.pool.query('SELECT state FROM ac_intents WHERE id=$1',[intent.id])).rows[0].state,'done');
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_manager_plans WHERE context_id=$1',[context])).rows[0].n,1);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_chat_messages WHERE id=$1',[session+'|proposal-'+stableId('semantic-proposal-v1\0'+intent.id)])).rows[0].n,1);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_sandbox_jobs')).rows[0].n,0);
  assert(!JSON.stringify((await db.pool.query('SELECT * FROM ac_semantic_planning_calls')).rows).includes(text));
  // Cancellation of a ready result closes the call, freeing the single-call
  // slot. An uncertain result remains unconfirmed even after grant release.
  const second=await endpoint.accept({text:'second synthetic request',localId:'second-'+randomUUID()});await endpoint.tick();assert.equal(invocations,2);
  await db.pause(principal,context,true);await assert.rejects(endpoint.tick(),/HUMAN_PAUSED/);assert.equal(reconciliations,2);
  const secondIntent=(await db.pool.query('SELECT * FROM ac_intents WHERE id=$1',[second.result.intentId])).rows[0];
  await db.pool.query('INSERT INTO ac_plan_cancellations(intent_id,context_id,requested_by,plan_revision) VALUES($1,$2,$3,$4)',[secondIntent.id,context,principal,secondIntent.plan_revision]);
  await new Cancellations(db).reconcile(authority,()=>{});
  assert.equal((await db.pool.query('SELECT state FROM ac_plan_cancellations WHERE intent_id=$1',[secondIntent.id])).rows[0].state,'confirmed');
  assert.equal((await db.pool.query('SELECT failure_code FROM ac_semantic_planning_calls WHERE intent_id=$1',[secondIntent.id])).rows[0].failure_code,'PLANNING_CANCELED');
  await db.pause(principal,context,false);const third=await endpoint.accept({text:'third synthetic request',localId:'third-'+randomUUID()});await endpoint.tick();assert.equal(invocations,3);
  const thirdIntent=(await db.pool.query('SELECT * FROM ac_intents WHERE id=$1',[third.result.intentId])).rows[0];
  await db.pool.query('INSERT INTO ac_plan_cancellations(intent_id,context_id,requested_by,plan_revision) VALUES($1,$2,$3,$4)',[thirdIntent.id,context,principal,thirdIntent.plan_revision]);
  await new Cancellations(db).reconcile(authority,()=>{});
  assert.equal((await db.pool.query('SELECT state FROM ac_plan_cancellations WHERE intent_id=$1',[thirdIntent.id])).rows[0].state,'requested');
  assert.equal((await db.pool.query('SELECT state FROM ac_semantic_planning_calls WHERE intent_id=$1',[thirdIntent.id])).rows[0].state,'uncertain');
  await new QualityPolicies(db).publish(principal,project,1,{schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:true,verifierDigest:'a'.repeat(64)});
  await assert.rejects(new Templates(db).assign(principal,context,1),/QUALITY_POLICY_CONFLICT/);
  await assert.rejects(new Templates(db).publish(principal,context,1,{workflow:'semantic-proposal-v1',qualityRevision:quality,targetRef:'refs/heads/protected'}),/QUALITY_POLICY_CONFLICT/);
  await assert.rejects(endpoint.accept({text:'stale policy fixture',localId:'stale-'+randomUUID()}),/QUALITY_POLICY_CONFLICT/);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_intents WHERE context_id=$1',[context])).rows[0].n,3);
 }finally{await db.close();await database.close();}
});
