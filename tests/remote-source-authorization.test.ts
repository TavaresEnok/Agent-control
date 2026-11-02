import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {Control} from '../src/control.ts';
import {Operators,operatorMessage} from '../src/operator.ts';
import {RemoteOperations,type RemoteTransport} from '../src/remote.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('signed owner authorizes only the specified remote source and replay revalidates it',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const db=await isolatedDatabase(base,'sourceauth'),ledger=new Ledger(db.url),project=randomUUID(),principal='source-'+randomUUID();
 try{
  await ledger.migrate();await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'source fixture']);
  await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  const keys=generateKeyPairSync('ed25519'),deviceId=randomUUID();
  await new Operators(ledger).enroll(principal,principal,deviceId,keys.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const installation=(await ledger.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0].id;
  const proof=(command:Record<string,unknown>)=>{const data={deviceId,expiresAt:Date.now()+120000};return {...data,signature:sign(null,Buffer.from(operatorMessage(principal,command,data,installation)),keys.privateKey).toString('hex')};};
  const contextId=await ledger.createContext(principal,project,randomUUID()),authority=await ledger.acquire(principal,contextId,randomUUID(),'fixture',60);
  const intent=await ledger.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,
   action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
  const bytes=Buffer.from('fixture'),bundleSha256=createHash('sha256').update(bytes).digest('hex');let calls=0;
  const transport:RemoteTransport={async exchange(_host,raw){calls++;const {action,...reply}=raw as Record<string,unknown>;return {...reply,bundle:bytes.toString('base64'),bundleSha256};}};
  const remote=new RemoteOperations(ledger,transport),hostId=randomUUID();
  await remote.registerHost(principal,project,{id:hostId,label:'fixture',hostname:'fixture.invalid',port:2222,username:'fixture',publicKey:'ssh-ed25519 '+'A'.repeat(64),
   fingerprint:'SHA256:'+'A'.repeat(43),credentialRef:randomUUID(),remoteRoot:'/fixture',allowedTasks:['git-export'],maxConcurrent:2});
  const request={operationId:randomUUID(),intentId:intent.id,contextId,hostId,commit:'1'.repeat(40),tree:'2'.repeat(40)};
  await assert.rejects(remote.exportGit(principal,request,authority),/REMOTE_SOURCE_AUTHORIZATION_REQUIRED/);assert.equal(calls,0);
  const control=new Control(ledger),command={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,
   action:'remote.source.authorize' as const,payload:{schemaVersion:1 as const,intentId:intent.id,hostId,commit:request.commit,tree:request.tree}};
  await assert.rejects(control.execute(principal,command,{...proof(command),signature:'0'.repeat(128)}),/OPERATOR_SIGNATURE_INVALID/);
  const result=await control.execute(principal,command,proof(command));
  assert.deepEqual(await control.execute(principal,{...command,deliveryAttemptId:randomUUID()},proof(command)),result);
  const changed={...command,payload:{...command.payload,tree:'3'.repeat(40)}};
  await assert.rejects(control.execute(principal,changed,proof(changed)),/CONTROL_INTENT_CONFLICT/);
  const exported=await remote.exportGit(principal,request,authority);assert.equal(exported.snapshot.reviewStatus,'not_reviewed');
  assert.equal(exported.snapshot.sourceAuthorizationId,command.intentId);
  await assert.rejects(remote.exportGit(principal,{...request,operationId:randomUUID(),tree:'3'.repeat(40)},authority),/REMOTE_SOURCE_AUTHORIZATION_REQUIRED/);
  assert.equal((await remote.exportGit(principal,request,authority)).sha256,bundleSha256);assert.equal(calls,2);
  await assert.rejects(ledger.pool.query('UPDATE ac_remote_source_authorizations SET tree_id=$1',[request.commit]),/POLICY_REVISION_IMMUTABLE/);
 }finally{await ledger.close();await db.close();}
});
