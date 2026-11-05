import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,mkdir,rm,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {Projects} from '../src/projects.ts';
import {Capacity,profileConfigDigest} from '../src/capacity.ts';
import {Control} from '../src/control.ts';
import {Operators,operatorMessage} from '../src/operator.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';
test('profile version and account rename are signed, conflict-safe and preserve existing policy and grant',async()=>{
 const url=process.env.AC_R5_GRAPH_DATABASE_URL;if(!url?.endsWith('/ac_r5_mobile_graph'))throw Error('DISPOSABLE_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();const root=await mkdtemp('/tmp/ac-r5-profile-'),repo=join(root,'repo');
 try{
  await mkdir(repo,{mode:0o700});execFileSync('git',['init',repo],{stdio:'ignore'});await chmod(join(repo,'.git'),0o700);
  const project=randomUUID(),principal='profile-'+randomUUID(),device=randomUUID(),keys=generateKeyPairSync('ed25519');
  await new Projects(db).register([{id:project,label:'profile',repo,owner:principal}],principal);
  const {revision}=await provisionCapacity(db,principal,project);const capacity=new Capacity(db);
  await capacity.registerModel('synthetic-capacity-administrator',{provider:'synthetic',model:'revision-model',efforts:['high'],roles:['programmer'],source:'synthetic://revision'});
  const context=await db.createContext(principal,project,randomUUID());await capacity.assignPolicy(principal,context,revision);
  await new Operators(db).enroll(principal,principal,device,keys.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const installation=(await db.pool.query('SELECT id FROM ac_installation_identity WHERE singleton')).rows[0].id;
  const proof=(command:Record<string,unknown>)=>{const p={deviceId:device,expiresAt:Date.now()+120000};return {...p,signature:sign(null,Buffer.from(operatorMessage(principal,command,p,installation)),keys.privateKey).toString('hex')};};
  const source=(await db.pool.query('SELECT p.* FROM ac_profiles p JOIN ac_account_access a ON a.account_id=p.account_id WHERE a.project_id=$1',[project])).rows[0];
  const before=(await db.pool.query('SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 AND revision=$2',[project,revision])).rows[0].snapshot;
  const authority=await db.acquire(principal,context,randomUUID(),'profile-fixture',60);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:revision,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
  const grant=await capacity.reserve(principal,{attemptId:randomUUID(),contextId:context,intentId:intent.id,role:'programmer'},authority);
  const base={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context};
  const command={...base,action:'profile.revise' as const,payload:{sourceProfileId:source.id,expectedDigest:profileConfigDigest(source),newId:randomUUID(),model:'revision-model',effort:'high' as const,role:'programmer' as const}};
  const control=new Control(db);const result=await control.execute(principal,command,proof(command));
  const replay={...command,deliveryAttemptId:randomUUID()};assert.deepEqual(await control.execute(principal,replay,proof(replay)),result);
  const conflict={...command,payload:{...command.payload,model:'fixed-worker-v1'}};await assert.rejects(control.execute(principal,conflict,proof(conflict)),/CONTROL_INTENT_CONFLICT/);
  assert.deepEqual((await db.pool.query('SELECT * FROM ac_profiles WHERE id=$1',[source.id])).rows[0],source);
  assert.deepEqual((await db.pool.query('SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 AND revision=$2',[project,revision])).rows[0].snapshot,before);
  assert.equal((await db.pool.query('SELECT profile_id FROM ac_capacity_grants WHERE id=$1',[grant.id])).rows[0].profile_id,source.id);
  assert.equal((await db.pool.query('SELECT source_profile_id FROM ac_profile_lineage WHERE new_profile_id=$1',[command.payload.newId])).rows[0].source_profile_id,source.id);
  const distinct={...command,intentId:randomUUID(),deliveryAttemptId:randomUUID(),payload:{...command.payload,newId:randomUUID()}};
  assert.equal((await control.execute(principal,distinct,proof(distinct))).state,'applied');
  const badCatalog={...command,intentId:randomUUID(),deliveryAttemptId:randomUUID(),payload:{...command.payload,newId:randomUUID(),effort:'low' as const}};
  await assert.rejects(control.execute(principal,badCatalog,proof(badCatalog)),/MODEL_EFFORT_NOT_IN_CATALOG/);
  const collision={...command,intentId:randomUUID(),deliveryAttemptId:randomUUID()};await assert.rejects(control.execute(principal,collision,proof(collision)),/PROFILE_ID_CONFLICT/);
  const staleDigest={...command,intentId:randomUUID(),deliveryAttemptId:randomUUID(),payload:{...command.payload,newId:randomUUID(),expectedDigest:'0'.repeat(64)}};
  await assert.rejects(control.execute(principal,staleDigest,proof(staleDigest)),/ACCOUNT_PROFILE_REVISION_CONFLICT/);

  await assert.rejects(db.pool.query('DELETE FROM ac_profile_lineage WHERE new_profile_id=$1',[command.payload.newId]),/POLICY_REVISION_IMMUTABLE/);
  const rename={...base,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'account.rename' as const,payload:{id:source.account_id,label:'Renamed fixture',expectedRevision:1}};
  await control.execute(principal,rename,proof(rename));const stale={...rename,intentId:randomUUID(),deliveryAttemptId:randomUUID()};await assert.rejects(control.execute(principal,stale,proof(stale)),/ACCOUNT_PROFILE_REVISION_CONFLICT/);
  const revoker=await db.pool.connect();await revoker.query('BEGIN');
  try{
   await revoker.query('DELETE FROM ac_account_access WHERE account_id=$1 AND project_id=$2',[source.account_id,project]);
   const revoked={...command,intentId:randomUUID(),deliveryAttemptId:randomUUID(),payload:{...command.payload,newId:randomUUID()}};
   const blocked=control.execute(principal,revoked,proof(revoked));let waiting=false;
   for(let i=0;i<100;i++){waiting=!!(await db.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF a,p FOR SHARE OF x%'")).rowCount;if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));}
   assert(waiting,'revision waits for concurrent revocation');await revoker.query('COMMIT');await assert.rejects(blocked,/ACCOUNT_PROFILE_FORBIDDEN/);
  }finally{await revoker.query('ROLLBACK');revoker.release();}
  await db.pool.query('INSERT INTO ac_account_access VALUES($1,$2)',[source.account_id,project]);
  const memberRevoker=await db.pool.connect();await memberRevoker.query('BEGIN');
  try{
   await memberRevoker.query('DELETE FROM ac_memberships WHERE project_id=$1 AND principal_id=$2',[project,principal]);
   const another={...rename,intentId:randomUUID(),deliveryAttemptId:randomUUID(),payload:{...rename.payload,expectedRevision:2,label:'Must not apply'}};
   const blocked=control.execute(principal,another,proof(another));let waiting=false;
   for(let i=0;i<100;i++){waiting=!!(await db.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%ac_memberships%FOR SHARE%'")).rowCount;if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));}
   assert(waiting,'rename waits for concurrent membership revocation');await memberRevoker.query('COMMIT');await assert.rejects(blocked,/PROJECT_OWNER_REQUIRED/);
  }finally{await memberRevoker.query('ROLLBACK');memberRevoker.release();}
 }finally{await db.pool.end();await rm(root,{recursive:true,force:true});}
});
