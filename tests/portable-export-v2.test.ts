import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {ManagerPlans,type ManagerPlan} from '../src/planning.ts';
import {PortableExportV2,portableSections} from '../src/portable-export-v2.ts';
import {Hono} from 'hono';
import {createPortableExportApi} from '../src/portable-export-api.ts';
import {collectPortableMetadata} from '../src/portable-export-collect.ts';
import {createHash} from 'node:crypto';
import {digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('portable v2 preserves complete redacted contracts and durable bounded owner-scoped cuts',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const database=await isolatedDatabase(base,'portable'),db=new Ledger(database.url),capacity=new Capacity(db);
 try{
  await db.migrate();const project=randomUUID(),principal='owner-'+randomUUID(),account=randomUUID(),profile=randomUUID(),fallback=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner'),($1,$3,'viewer')",[project,principal,'fixture-viewer']);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await capacity.configure(principal,{programmingLimit:1,evaluationLimit:1});
  await capacity.registerModel(principal,{provider:'fixture',model:'fixture',efforts:['medium'],roles:['programmer'],source:'synthetic://fixture'});
  await capacity.addAccount(principal,project,{id:account,provider:'fixture',label:'fixture',resourceIdentity:randomUUID(),mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://fixture',maxConcurrent:1});
  await capacity.addProfile(principal,project,{id:profile,accountId:account,model:'fixture',effort:'medium',role:'programmer'});
  await capacity.addProfile(principal,project,{id:fallback,accountId:account,model:'fixture',effort:'medium',role:'programmer'});
  await capacity.observeQuota(principal,account,{status:'available',source:'synthetic://fixture',ttlSeconds:60});
  const revision=await capacity.publish(principal,project,0,{schemaVersion:1,maxProgrammersPerContext:1,maxEvaluatorsPerContext:1,roles:{programmer:{regular:[profile],emergency:[fallback]}}});
  const contextId=await db.createContext(principal,project,randomUUID()),other=await db.createContext(principal,project,randomUUID());
  const authority=await db.acquire(principal,contextId,randomUUID(),'fixture-manager',60);await capacity.assignPolicy(principal,contextId,revision);
  const quality={schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireJudge:false,requireHumanIntegration:false,verifierDigest:'a'.repeat(64)};
  await db.pool.query('INSERT INTO ac_quality_policies VALUES($1,1,$2,$3)',[project,quality,digest(quality)]);
  const plan:ManagerPlan={schemaVersion:1,contextId,objectiveRef:'message:DO_NOT_EXPORT_TRANSCRIPT',sourceMessageRef:'message:DO_NOT_EXPORT_SOURCE',constraintRefs:[],tasks:[{
   id:'one',objectiveRef:'message:DO_NOT_EXPORT_OBJECTIVE',acceptanceRefs:['acceptance:synthetic-effect-v1'],inputRefs:[],outputRefs:['output:one'],dependsOn:[],
   writePaths:['DO_NOT_EXPORT_PATH/file.txt'],qualityRevision:1,targetRef:'refs/heads/DO_NOT_EXPORT_BRANCH',maxCorrections:0}]};
  await new ManagerPlans(db).publish(principal,authority,0,plan);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,
   action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:DO_NOT_EXPORT_TEXT'}},authority,'api');
  const grant=await capacity.reserve(principal,{attemptId:randomUUID(),intentId:intent.id,contextId,role:'programmer'},authority);
  const artifact=randomUUID(),commit='a'.repeat(40),tree='b'.repeat(40),baseCommit='c'.repeat(40),artifactDigest=digest({commit,tree,base:baseCommit});
  await db.pool.query(`INSERT INTO ac_artifacts VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,'high')`,[artifact,contextId,intent.id,grant.id,randomUUID(),project,commit,tree,baseCommit,artifactDigest]);
  await db.pool.query(`INSERT INTO ac_verification_evidence(id,artifact_id,kind,session_id,grant_id,policy_revision,status,receipt,receipt_digest)
   VALUES($1,$2,'qa',$3,$4,1,'passed',$5,$6)`,[randomUUID(),artifact,randomUUID(),grant.id,{message:'DO_NOT_EXPORT_RECEIPT'},digest({message:'DO_NOT_EXPORT_RECEIPT'})]);
  await db.pool.query(`INSERT INTO ac_integration_intents(id,artifact_id,context_id,manager_epoch,target_ref,state,receipt)
   VALUES($1,$2,$3,$4,'refs/heads/DO_NOT_EXPORT_BRANCH','integrated',$5)`,[randomUUID(),artifact,contextId,authority.epoch,{path:'/DO_NOT_EXPORT_HOST_PATH'}]);
  await db.pool.query("INSERT INTO ac_audit(context_id,kind,detail) SELECT $1,'custom.event',$2 FROM generate_series(1,102)",[contextId,{path:'/DO_NOT_EXPORT_AUDIT'}]);
  // One source record exceeds a response page after redaction; byte continuation
  // must preserve it without dropping fields or splitting logical semantics.
  const largePlan={...plan,tasks:Array.from({length:64},(_,i)=>({...plan.tasks[0],id:'do-not-export-task-'+i,dependsOn:i?['do-not-export-task-'+(i-1)]:[],writePaths:Array.from({length:64},(_,j)=>'DO_NOT_EXPORT_PATH/'+i+'/'+j+'.txt'),
   acceptanceRefs:Array.from({length:32},(_,j)=>'acceptance:DO_NOT_EXPORT_'+i+'_'+j),outputRefs:Array.from({length:32},(_,j)=>'output:DO_NOT_EXPORT_'+i+'_'+j)}))};
  const compilation={schemaVersion:1,workflow:{steps:[{id:'node',prompt:'DO_NOT_EXPORT_PROMPT'}],graph:{nodes:[{id:'node',type:'agent',prompt:'DO_NOT_EXPORT_PROMPT'}],edges:[{from:'node',to:'node'}]}},bindings:[]};
  await db.pool.query('INSERT INTO ac_manager_plans(context_id,revision,parent_revision,manager_epoch,manager_instance_id,principal_id,digest,snapshot,compilation_digest,compilation) VALUES($1,2,1,1,$2,$3,$4,$5,$6,$7)',[contextId,randomUUID(),principal,digest(largePlan),largePlan,digest(compilation),compilation]);
  const service=new PortableExportV2(db);
  await assert.rejects(service.page('fixture-viewer',project,contextId),/PORTABLE_EXPORT_FORBIDDEN/);
  const auditBefore=Number((await db.pool.query('SELECT count(*) n FROM ac_audit WHERE context_id=$1',[contextId])).rows[0].n);assert(auditBefore>100);
  const first=await service.page(principal,project,contextId);assert(first.nextCursor);assert(first.manifest[0].bytes>256*1024);
  assert.equal(first.manifest.find(x=>x.section==='audit')!.records,auditBefore);
  await db.pool.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'concurrent.insert',$2)",[contextId,{private:'DO_NOT_EXPORT_AFTER_CUT'}]);
  const freshService=new PortableExportV2(db); // Durable cursor survives service replacement.
  await assert.rejects(freshService.page(principal,project,other,first.nextCursor!),/PORTABLE_EXPORT_CURSOR_INVALID/);
  await assert.rejects(freshService.page(principal,randomUUID(),contextId,first.nextCursor!),/PORTABLE_EXPORT_FORBIDDEN/);
  const decoded=JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString());decoded.offset+=160*1024;
  await assert.rejects(freshService.page(principal,project,contextId,Buffer.from(JSON.stringify(decoded)).toString('base64url')),/PORTABLE_EXPORT_CURSOR_INVALID/);
  const chunks=new Map<string,Buffer[]>();let page=first,pages=0;
  for(;;){
   const {digest:pageDigest,...payload}=page;assert.equal(pageDigest,digest(payload));assert(Buffer.byteLength(JSON.stringify(page))<=256*1024);
   const bytes=Buffer.from(page.data,'base64');assert.equal(createHash('sha256').update(bytes).digest('hex'),page.chunkDigest);
   const prior=chunks.get(page.section)??[];assert.equal(page.offset,prior.reduce((n,b)=>n+b.length,0));prior.push(bytes);chunks.set(page.section,prior);pages++;
   if(!page.nextCursor)break;page=await freshService.page(principal,project,contextId,page.nextCursor);
  }
  assert(pages>portableSections.length);
  const sections=Object.fromEntries(first.manifest.map(entry=>{const bytes=Buffer.concat(chunks.get(entry.section)!);assert.equal(bytes.length,entry.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.digest);const records=JSON.parse(bytes.toString());assert.equal(records.length,entry.records);return [entry.section,records];}));
  assert.deepEqual(sections.capacityPolicies[0].policy.roles.programmer,{regular:[profile],emergency:[fallback]});
  assert.equal(sections.managerPlans[1].plan.tasks.length,64);assert.equal(sections.managerPlans[1].plan.tasks[0].writePaths.length,64);
  assert.equal(sections.managerPlans[1].plan.tasks[0].acceptanceRefs.length,32);
  assert.equal(sections.managerPlans[1].sourceDigest,digest(largePlan));assert.equal(sections.managerPlans[1].compilationSourceDigest,digest(compilation));
  assert.equal(sections.frozenPlans[0].definition.graph.nodes[0].type,'start');assert(sections.frozenPlans[0].definition.graph.edges.length);
  assert.equal(sections.verification[0].sourceDigest,digest({message:'DO_NOT_EXPORT_RECEIPT'}));
  assert.equal(sections.audit.length,auditBefore);assert(!JSON.stringify(sections).includes('DO_NOT_EXPORT'));assert(!JSON.stringify(sections).includes(account));assert(!JSON.stringify(sections).includes('do-not-export-task'));
  assert.deepEqual(sections.managerPlans[1].plan.tasks[1].dependsOn[0],sections.managerPlans[1].plan.tasks[0].id);
  await db.pool.query("UPDATE ac_memberships SET role='viewer' WHERE project_id=$1 AND principal_id=$2",[project,principal]);
  await assert.rejects(freshService.page(principal,project,contextId,first.nextCursor!),/PORTABLE_EXPORT_FORBIDDEN/);
  await db.pool.query("UPDATE ac_memberships SET role='owner' WHERE project_id=$1 AND principal_id=$2",[project,principal]);
  const expiredId=randomUUID();await db.pool.query(`INSERT INTO ac_portable_export_snapshots(id,principal_id,project_id,context_id,expires_at,cursor_key,manifest)
   SELECT $1,principal_id,project_id,context_id,clock_timestamp()-interval '1 second',cursor_key,manifest FROM ac_portable_export_snapshots WHERE id=$2`,[expiredId,first.exportId]);
  const expiredCursor={...JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString()),id:expiredId};
  await assert.rejects(freshService.page(principal,project,contextId,Buffer.from(JSON.stringify(expiredCursor)).toString('base64url')),/PORTABLE_EXPORT_EXPIRED/);
  assert.equal((await freshService.purgeExpired()).deleted,1);
  await freshService.release(principal,project,contextId,first.exportId);
  await assert.rejects(freshService.page(principal,project,contextId,first.nextCursor!),/PORTABLE_EXPORT_CURSOR_INVALID/);
  const collected=await collectPortableMetadata(db,principal,project,contextId);
  assert.equal(collected.truncated,false);assert.equal(collected.sections.audit.length,auditBefore+1);
  const {digest:collectedDigest,...collectedPayload}=collected;assert.equal(collectedDigest,digest(collectedPayload));
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_portable_export_snapshots WHERE principal_id=$1',[principal])).rows[0].n,0,'collector releases only its durable export');
  const app=new Hono<{Variables:{principal:string}}>();app.use('*',async(c,next)=>{c.set('principal',principal);await next();});app.route('/',createPortableExportApi(db,project));
  const response=await app.request('/contexts/'+other+'/export/metadata/v2');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const apiPage=await response.json();assert.equal(apiPage.schemaVersion,2);assert.equal((await app.request('/contexts/'+other+'/export/metadata/v2/'+apiPage.exportId,{method:'DELETE'})).status,200);
  const active=[];for(let i=0;i<4;i++)active.push(await freshService.page(principal,project,other));
  await assert.rejects(freshService.page(principal,project,other),/PORTABLE_EXPORT_ACTIVE_LIMIT/);
  await freshService.release(principal,project,contextId,active[0].exportId);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_portable_export_snapshots WHERE principal_id=$1',[principal])).rows[0].n,4,'cross-context release does not remove another cut');
  for(const cut of active)await freshService.release(principal,project,other,cut.exportId);
  await db.pool.query("INSERT INTO ac_audit(context_id,kind,detail) SELECT $1,'large.section','{}'::jsonb FROM generate_series(1,10001)",[other]);
  await assert.rejects(freshService.page(principal,project,other),/PORTABLE_EXPORT_SIZE_EXCEEDED/);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_portable_export_snapshots WHERE principal_id=$1',[principal])).rows[0].n,0,'refusal does not publish a partial cut');
 }finally{await db.close();await database.close();}
});
