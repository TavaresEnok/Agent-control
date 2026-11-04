import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { describe, test } from 'node:test';
import { digest, Refusal } from '../src/contracts.ts';
import { ControlCommand } from '../src/control.ts';
import { operatorMessage } from '../src/operator.ts';
import { ProjectTemplateApply, ProjectTemplateName, ProjectTemplatePublish, projectTemplateLockKey } from '../src/project-templates.ts';
import { Template, type TemplateSnapshot } from '../src/templates.ts';
import { isolatedDatabase } from './fixtures/isolated-database.ts';

const baseline={workflow:'baseline-synthetic-v1' as const};
const synthetic=(qualityRevision:number,targetRef='refs/heads/protected')=>({workflow:'engineering-synthetic-v1' as const,qualityRevision,targetRef});
const semantic=(qualityRevision:number)=>({workflow:'semantic-proposal-v1' as const,qualityRevision,targetRef:'refs/heads/protected'});
const native=(qualityRevision:number)=>({workflow:'engineering-native-v1' as const,qualityRevision,targetRef:'refs/heads/protected',writePaths:['src']});

test('project template schema rejects a foreign project, a bad name and a digest that does not match the snapshot',()=>{
 const templateId=randomUUID();
 const publish={templateId,expectedRevision:0,name:'Fluxo de laboratório',template:baseline,digest:digest(baseline)};
 assert.deepEqual(ProjectTemplatePublish.parse(publish),publish);
 assert.equal(ProjectTemplatePublish.parse({...publish,name:'  Fluxo de laboratório  '}).name,'Fluxo de laboratório');
 assert.throws(()=>ProjectTemplatePublish.parse({...publish,projectId:randomUUID()}));
 assert.throws(()=>ProjectTemplatePublish.parse({...publish,name:'',digest:digest(baseline)}));
 assert.throws(()=>ProjectTemplatePublish.parse({...publish,name:'x'.repeat(81)}));
 assert.throws(()=>ProjectTemplatePublish.parse({...publish,name:'segredo=token'}));
 assert.throws(()=>ProjectTemplateName.parse('a\nb'));
 assert.throws(()=>Template.parse({...baseline,account:'hidden',credential:'hidden'}));
 const command={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:randomUUID(),action:'project-template.publish' as const,payload:publish};
 assert.equal(ControlCommand.parse(command).action,'project-template.publish');
 assert.throws(()=>ControlCommand.parse({...command,payload:{...publish,projectId:randomUUID()}}));
 const apply={templateId,revision:1,expectedRevision:2,expectedContextRevision:0};
 assert.deepEqual(ProjectTemplateApply.parse(apply),apply);
 assert.throws(()=>ProjectTemplateApply.parse({...apply,projectId:randomUUID()}));
 assert.throws(()=>ControlCommand.parse({...command,action:'project-template.apply',payload:{...apply,transcript:'hidden'}}));
 const projectId=randomUUID();
 const key=projectTemplateLockKey(projectId,templateId);
 assert.equal(key.includes('\u0000'),false);
 assert.deepEqual(JSON.parse(key),['project-template',projectId,templateId]);
 assert.notEqual(key,projectTemplateLockKey(templateId,projectId));
 assert.notEqual(key,projectTemplateLockKey(randomUUID(),templateId));
});

const skip=process.env.AC_TEST_DATABASE_URL?false:'AC_TEST_DATABASE_URL ausente; prova PG reservada ao laboratório isolado';

describe('project workflow templates',{skip},()=>{
 let ledger:import('../src/ledger.ts').Ledger;
 let closeDatabase:(()=>Promise<void>)|undefined;
 let installation:string;
 const owner='project-template-owner-'+randomUUID();
 const editor='project-template-editor-'+randomUUID();
 const viewer='project-template-viewer-'+randomUUID();
 const keys=new Map<string,ReturnType<typeof generateKeyPairSync>>();
 const devices=new Map<string,string>();

 test.before(async()=>{
  const base=process.env.AC_TEST_DATABASE_URL;
  if(!base)throw new Error('ISOLATED_DATABASE_REQUIRED');
  const {Ledger}=await import('../src/ledger.ts');
  const {Operators}=await import('../src/operator.ts');
  const fixture=await isolatedDatabase(base,'projtpl');
  closeDatabase=fixture.close;
  ledger=new Ledger(fixture.url);
  await ledger.migrate();
  installation=(await ledger.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0].id as string;
  await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1)',[owner]);
  for(const principal of [owner,editor,viewer]){
   const pair=generateKeyPairSync('ed25519');
   const deviceId=randomUUID();
   keys.set(principal,pair);devices.set(principal,deviceId);
   await new Operators(ledger).enroll(owner,principal,deviceId,pair.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  }
 });
 test.after(async()=>{await ledger?.close();await closeDatabase?.();});

 async function project(label:string){
  const id=randomUUID();
  await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[id,label]);
  await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[id,owner]);
  await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'operator')",[id,editor]);
  await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'viewer')",[id,viewer]);
  return id;
 }
 async function contexts(projectId:string){
  return [await ledger.createContext(owner,projectId,randomUUID()),await ledger.createContext(owner,projectId,randomUUID())] as const;
 }
 function proof(principal:string,command:Record<string,unknown>){
  const deviceId=devices.get(principal)!;
  const data={deviceId,expiresAt:Date.now()+120000};
  return {...data,signature:sign(null,Buffer.from(operatorMessage(principal,command,data,installation)),keys.get(principal)!.privateKey).toString('hex')};
 }
 function publishCommand(contextId:string,templateId:string,expectedRevision:number,template:TemplateSnapshot,name='Fluxo de laboratório'){
  return {schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,action:'project-template.publish' as const,
   payload:{templateId,expectedRevision,name,template,digest:digest(template)}};
 }
 async function counts(){
  const read=async(sql:string)=>Number((await ledger.pool.query(sql)).rows[0].count);
  return {accounts:await read('SELECT count(*) FROM ac_accounts'),profiles:await read('SELECT count(*) FROM ac_profiles'),grants:await read('SELECT count(*) FROM ac_capacity_grants'),intents:await read('SELECT count(*) FROM ac_intents')};
 }

 test('publishes and applies an exact revision inside one project without copying accounts',async()=>{
  const {Control}=await import('../src/control.ts');
  const {QualityPolicies}=await import('../src/quality-policy.ts');
  const projectId=await project('same');
  const other=await project('other');
  const [origin,destination]=await contexts(projectId);
  const [foreign]=await contexts(other);
  const scoped=new Control(ledger,[],projectId);
  const quality=await new QualityPolicies(ledger).publish(owner,projectId,0,{schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:false,verifierDigest:'a'.repeat(64)});
  const templateId=randomUUID();
  const first=publishCommand(origin,templateId,0,synthetic(quality),'Fluxo de laboratório');
  const before=await counts();
  const published=await scoped.execute(owner,first,proof(owner,first));
  assert.deepEqual(published.result,{templateId,revision:1,digest:digest(synthetic(quality)),name:'Fluxo de laboratório'});
  const replay=await scoped.execute(owner,{...first,deliveryAttemptId:randomUUID()},proof(owner,first));
  assert.deepEqual(replay,published);
  await scoped.execute(owner,first,proof(owner,first));
  const renamed={...first,deliveryAttemptId:randomUUID(),payload:{...first.payload,name:'Outro nome'}};
  await assert.rejects(scoped.execute(owner,renamed,proof(owner,renamed)),(error:unknown)=>error instanceof Refusal&&error.code==='CONTROL_INTENT_CONFLICT');
  const delivered={...publishCommand(origin,templateId,1,synthetic(quality,'refs/heads/next'),'Fluxo seguinte'),deliveryAttemptId:first.deliveryAttemptId};
  await assert.rejects(scoped.execute(owner,delivered,proof(owner,delivered)),(error:unknown)=>error instanceof Refusal&&error.code==='CONTROL_DELIVERY_CONFLICT');
  const second=publishCommand(origin,templateId,1,synthetic(quality,'refs/heads/next'),'Fluxo seguinte');
  await scoped.execute(owner,second,proof(owner,second));
  const stale=publishCommand(origin,templateId,1,baseline,'Fluxo obsoleto');
  await assert.rejects(scoped.execute(owner,stale,proof(owner,stale)),(error:unknown)=>error instanceof Refusal&&error.code==='PROJECT_TEMPLATE_REVISION_CONFLICT');
  const badDigest=publishCommand(origin,randomUUID(),0,baseline);
  badDigest.payload.digest='b'.repeat(64);
  await assert.rejects(scoped.execute(owner,badDigest,proof(owner,badDigest)),(error:unknown)=>error instanceof Refusal&&error.code==='PROJECT_TEMPLATE_DIGEST_MISMATCH');
  const apply={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:destination,action:'project-template.apply' as const,
   payload:{templateId,revision:1,expectedRevision:2,expectedContextRevision:0}};
  const applied=await scoped.execute(owner,apply,proof(owner,apply));
  assert.equal((applied.result as {catalogRevision:number;contextRevision:number;digest:string}).catalogRevision,1);
  assert.equal((applied.result as {digest:string}).digest,digest(synthetic(quality)));
  const sameDelivery=await scoped.execute(owner,apply,proof(owner,apply));
  assert.deepEqual(sameDelivery,applied);
  const redelivered={...apply,deliveryAttemptId:randomUUID()};
  const newDelivery=await scoped.execute(owner,redelivered,proof(owner,redelivered));
  assert.deepEqual(newDelivery,applied);
  const drifted={...apply,deliveryAttemptId:randomUUID(),payload:{...apply.payload,expectedContextRevision:1}};
  await assert.rejects(scoped.execute(owner,drifted,proof(owner,drifted)),(error:unknown)=>error instanceof Refusal&&error.code==='CONTROL_INTENT_CONFLICT');
  const third=publishCommand(origin,templateId,2,synthetic(quality,'refs/heads/later'),'Fluxo posterior');
  await scoped.execute(owner,third,proof(owner,third));
  const sameAfterPublish=await scoped.execute(owner,apply,proof(owner,apply));
  assert.deepEqual(sameAfterPublish,applied);
  const redeliveredAfterPublish={...apply,deliveryAttemptId:randomUUID()};
  const newAfterPublish=await scoped.execute(owner,redeliveredAfterPublish,proof(owner,redeliveredAfterPublish));
  assert.deepEqual(newAfterPublish,applied);
  const local=(await ledger.pool.query('SELECT revision,snapshot,digest,source_project_id,source_template_id,source_revision FROM ac_context_templates WHERE context_id=$1',[destination])).rows;
  assert.equal(local.length,1);
  assert.deepEqual(local[0].snapshot,synthetic(quality));
  assert.equal(local[0].digest,digest(synthetic(quality)));
  assert.equal(local[0].source_project_id,projectId);
  assert.equal(local[0].source_template_id,templateId);
  assert.equal(Number(local[0].source_revision),1);
  assert.equal((await ledger.pool.query("SELECT count(*) FROM ac_audit WHERE context_id=$1 AND kind='project-template.applied'",[destination])).rows[0].count,'1');
  assert.equal((await ledger.pool.query('SELECT count(*) FROM ac_context_templates WHERE context_id=$1',[origin])).rows[0].count,'0');
  const foreignCommand=publishCommand(foreign,randomUUID(),0,baseline,'Outro projeto');
  await new Control(ledger,[],other).execute(owner,foreignCommand,proof(owner,foreignCommand));
  const leaked={...apply,intentId:randomUUID(),deliveryAttemptId:randomUUID(),payload:{templateId:foreignCommand.payload.templateId,revision:1,expectedRevision:0,expectedContextRevision:1}};
  await assert.rejects(scoped.execute(owner,leaked,proof(owner,leaked)),(error:unknown)=>error instanceof Refusal&&error.code==='PROJECT_TEMPLATE_NOT_FOUND');
  assert.equal((await ledger.pool.query('SELECT count(*) FROM ac_context_templates WHERE context_id=$1',[destination])).rows[0].count,'1');
  const outside=new Control(ledger,[],randomUUID());
  await assert.rejects(outside.execute(owner,apply,proof(owner,apply)),(error:unknown)=>error instanceof Refusal&&error.code==='PROJECT_RUNTIME_MISMATCH');
  const editorCommand=publishCommand(origin,randomUUID(),0,baseline,'Editor');
  await assert.rejects(scoped.execute(editor,editorCommand,proof(editor,editorCommand)),(error:unknown)=>error instanceof Refusal&&error.code==='PROJECT_OWNER_REQUIRED');
  const viewerCommand=publishCommand(origin,randomUUID(),0,baseline,'Consulta');
  await assert.rejects(scoped.execute(viewer,viewerCommand,proof(viewer,viewerCommand)),(error:unknown)=>error instanceof Refusal&&error.code==='CONTEXT_FORBIDDEN');
  const view=await scoped.view(viewer,destination);
  assert.equal(view.canManageProjectTemplates,false);
  assert.equal(view.projectTemplates.some(item=>item.templateId===foreignCommand.payload.templateId),false);
  assert.deepEqual(view.projectTemplates.map(item=>[item.name,item.revision,item.headRevision]),[['Fluxo de laboratório',1,3],['Fluxo posterior',3,3],['Fluxo seguinte',2,3]]);
  assert.equal(JSON.stringify(view.projectTemplates).includes('account'),false);
  const tampered=randomUUID();
  await ledger.pool.query('INSERT INTO ac_project_templates(project_id,template_id,revision,name,snapshot,digest,published_by) VALUES($1,$2,1,$3,$4,$5,$6)',[projectId,tampered,'Digest adulterado',baseline,'c'.repeat(64),owner]);
  const ownerView=await scoped.view(owner,origin);
  assert.equal(ownerView.projectTemplates.some(item=>item.templateId===tampered),false);
  const tamperedApply={...apply,intentId:randomUUID(),deliveryAttemptId:randomUUID(),payload:{templateId:tampered,revision:1,expectedRevision:1,expectedContextRevision:1}};
  await assert.rejects(scoped.execute(owner,tamperedApply,proof(owner,tamperedApply)),(error:unknown)=>error instanceof Refusal&&error.code==='PROJECT_TEMPLATE_DIGEST_MISMATCH');
  await assert.rejects(ledger.pool.query('UPDATE ac_project_templates SET name=$2 WHERE template_id=$1',[templateId,'trocado']),/POLICY_REVISION_IMMUTABLE/);
  await assert.rejects(ledger.pool.query(`INSERT INTO ac_project_templates(project_id,template_id,revision,name,snapshot,digest,published_by) VALUES($1,$2,1,'Segredo',$3,$4,$5)`,[projectId,randomUUID(),{workflow:'baseline-synthetic-v1',token:'secret'},digest(baseline),owner]));
  const obsolete=semantic(quality);
  const obsoleteId=randomUUID();
  const obsoletePublish=publishCommand(origin,obsoleteId,0,obsolete,'Proposta');
  await scoped.execute(owner,obsoletePublish,proof(owner,obsoletePublish));
  await new QualityPolicies(ledger).publish(owner,projectId,1,{schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:false,verifierDigest:'b'.repeat(64)});
  const obsoleteApply={...apply,intentId:randomUUID(),deliveryAttemptId:randomUUID(),payload:{templateId:obsoleteId,revision:1,expectedRevision:1,expectedContextRevision:1}};
  await assert.rejects(scoped.execute(owner,obsoleteApply,proof(owner,obsoleteApply)),(error:unknown)=>error instanceof Refusal&&error.code==='QUALITY_POLICY_CONFLICT');
  const missing=publishCommand(origin,randomUUID(),0,native(1),'Nativo sem política vigente');
  await assert.rejects(scoped.execute(owner,missing,proof(owner,missing)),(error:unknown)=>error instanceof Refusal&&error.code==='QUALITY_POLICY_CONFLICT');
  const after=await counts();
  assert.deepEqual(after,before);
  assert.equal((await ledger.pool.query('SELECT count(*) FROM ac_context_templates WHERE context_id=$1',[destination])).rows[0].count,'1');
 });

 test('serializes the same catalog identity and does not lose a concurrent context update',async()=>{
  const {Control}=await import('../src/control.ts');
  const projectId=await project('race');
  const [left,right]=await contexts(projectId);
  const control=new Control(ledger,[],projectId);
  const templateId=randomUUID();
  const one=publishCommand(left,templateId,0,baseline,'Primeira');
  const two=publishCommand(right,templateId,0,baseline,'Segunda');
  const published=await Promise.allSettled([control.execute(owner,one,proof(owner,one)),control.execute(owner,two,proof(owner,two))]);
  assert.equal(published.filter(item=>item.status==='fulfilled').length,1);
  assert.equal(published.filter(item=>item.status==='rejected'&&item.reason instanceof Refusal&&item.reason.code==='PROJECT_TEMPLATE_REVISION_CONFLICT').length,1);
  assert.equal((await ledger.pool.query('SELECT count(*) FROM ac_project_templates WHERE template_id=$1',[templateId])).rows[0].count,'1');
  const firstApply={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:left,action:'project-template.apply' as const,payload:{templateId,revision:1,expectedRevision:1,expectedContextRevision:0}};
  const secondApply={...firstApply,intentId:randomUUID(),deliveryAttemptId:randomUUID()};
  const applied=await Promise.allSettled([control.execute(owner,firstApply,proof(owner,firstApply)),control.execute(owner,secondApply,proof(owner,secondApply))]);
  assert.equal(applied.filter(item=>item.status==='fulfilled').length,1);
  assert.equal(applied.filter(item=>item.status==='rejected'&&item.reason instanceof Refusal&&item.reason.code==='TEMPLATE_REVISION_CONFLICT').length,1);
  const rows=(await ledger.pool.query('SELECT revision,snapshot FROM ac_context_templates WHERE context_id=$1 ORDER BY revision',[left])).rows;
  assert.equal(rows.length,1);
  assert.deepEqual(rows[0].snapshot,baseline);
  assert.equal((await ledger.pool.query('SELECT active_template_revision FROM ac_contexts WHERE id=$1',[left])).rows[0].active_template_revision,1);
 });
});
