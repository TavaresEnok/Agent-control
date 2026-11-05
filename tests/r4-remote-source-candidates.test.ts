import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {ProjectAdmin} from '../src/project-admin.ts';
import {Control} from '../src/control.ts';
import {Operators,operatorMessage} from '../src/operator.ts';
import {ContextKeys} from '../src/context-keys.ts';
import {digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('remote candidate projection follows current-epoch authorized exact exports without rebinding materialized repository',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(base,'sourceprojection'),db=new Ledger(isolated.url);
 try{
  await db.migrate();const project=randomUUID(),host=randomUUID(),principal='projection-'+randomUUID(),device=randomUUID(),keys=generateKeyPairSync('ed25519');
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Projection fixture']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await new Operators(db).enroll(principal,principal,device,keys.publicKey.export({type:'spki',format:'der'}).toString('base64'));
  const installation=(await db.pool.query('SELECT id FROM ac_installation_identity')).rows[0].id;
  const proof=(value:Record<string,unknown>)=>{const p={deviceId:device,expiresAt:Date.now()+120000};return {...p,signature:sign(null,Buffer.from(operatorMessage(principal,value,p,installation)),keys.privateKey).toString('hex')};};
  const context=await db.createContext(principal,project,randomUUID());let authority=await db.acquire(principal,context,randomUUID(),'projection',60);
  await db.pool.query("INSERT INTO ac_remote_hosts(id,project_id,label,hostname,port,username,public_key,fingerprint,credential_ref,remote_root,allowed_tasks,max_concurrent,registration_digest) VALUES($1,$2,'Fixture','fixture.invalid',22,'fixture','fixture','fixture',$3,'/fixture',ARRAY['git-export','git-workspace'],1,'fixture')",[host,project,randomUUID()]);
  const commit='a'.repeat(40),tree='b'.repeat(40);
  const intent=()=>db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:projection'}},authority,'api');
  const authorize=async(intentId:string)=>{const command={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,action:'remote.source.authorize' as const,payload:{schemaVersion:1 as const,intentId,hostId:host,commit,tree}};await new Control(db).execute(principal,command,proof(command));return command.intentId;};
  const exported=async(intentId:string,options:{epoch?:number;commit?:string;tree?:string;digest?:string}={})=>{
   const id=randomUUID(),receipt={commit:options.commit??commit,tree:options.tree??tree};
   await db.pool.query("INSERT INTO ac_remote_operations(id,context_id,host_id,task_id,request_digest,manager_epoch,state,remote_receipt,intent_id) VALUES($1,$2,$3,'git-export',$4,$5,'completed',$6,$7)",[id,context,host,options.digest??digest({action:'git-export',operationId:id,intentId,contextId:context,hostId:host,...receipt}),options.epoch??authority.epoch,receipt,intentId]);return id;
  };
  const initial=await intent(),authorization=await authorize(initial.id),source=await exported(initial.id),materialization=randomUUID();
  // Deliberately seeded projection inputs only. Physical SSH/provenance creation
  // is exercised separately by the canonical browser fixture.
  await db.pool.query("INSERT INTO ac_project_admin_intents VALUES($1,$2,'fixture','project.materializeRemoteSource','{}',clock_timestamp())",[materialization,principal]);
  await db.pool.query('INSERT INTO ac_remote_source_materializations(id,project_id,context_id,host_id,operation_id,commit_id,tree_id,bundle_sha256,authorization_id,principal_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[materialization,project,context,host,source,commit,tree,'c'.repeat(64),authorization,principal]);
  const admin=new ProjectAdmin(db,[],'/projection-private',{remoteDevelopment:{async resolve(){throw Error('NO_EFFECT_ALLOWED');}}});
  assert.equal((await admin.view(principal)).remoteDevelopment.candidates[0]?.sourceOperationId,source);
  await new ContextKeys(db).authorize(principal,context,1,'legacy','d'.repeat(64));authority=await db.acquire(principal,context,randomUUID(),'projection',60);
  assert.equal(authority.epoch,2);assert.equal((await admin.view(principal)).remoteDevelopment.candidates.length,0,'old epoch must not offer an unusable source intent');
  const current=await intent();await authorize(current.id);const exact=await exported(current.id);
  await exported(current.id,{commit:'e'.repeat(40)});await exported(current.id,{tree:'f'.repeat(40)});await exported(current.id,{digest:'altered'});await exported(current.id,{epoch:1});
  const unsigned=await intent();await exported(unsigned.id);
  const candidates=(await admin.view(principal)).remoteDevelopment.candidates;assert.equal(candidates.length,1);assert.equal(candidates[0]?.sourceOperationId,exact);assert.equal(candidates[0]?.intentId,current.id);assert.equal(JSON.stringify(candidates).includes('requestDigest'),false);
  assert.equal((await db.pool.query('SELECT operation_id FROM ac_remote_source_materializations')).rows[0].operation_id,source);
  console.log(JSON.stringify({proof:'current-epoch-remote-source-candidates',oldEpochExcluded:true,newAuthorizedExactExportVisible:true,wrongCommitTreeDigestEpochAndUnsignedExcluded:true,immutableMaterializationRebound:false,physicalSsh:false}));
 }finally{await db.close();await isolated.close();}
});
