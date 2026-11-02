import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {Control} from '../src/control.ts';
import {Operators,operatorMessage} from '../src/operator.ts';
import {Ledger} from '../src/ledger.ts';
import {ProviderCollectors,type ProviderAdapter,type ProviderProbeResult} from '../src/providers.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';
import {digest,type Command} from '../src/contracts.ts';

test('provider probes serialize per account, feed actual capacity and preserve unknown/redacted state',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url?.endsWith('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(url,'providers'),db=new Ledger(isolated.url);
 try{
  await db.migrate();const project=randomUUID(),principal='collector-'+randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Synthetic provider collector']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const fixture=await provisionCapacity(db,principal,project);
  const account=(await db.pool.query('SELECT a.id account_id FROM ac_accounts a JOIN ac_account_access x ON x.account_id=a.id WHERE x.project_id=$1',[project])).rows[0].account_id;
  const provider=(await db.pool.query('SELECT provider FROM ac_accounts WHERE id=$1',[account])).rows[0].provider;
  let calls=0,release:((value:ProviderProbeResult)=>void)|undefined;
  let next:unknown={status:'available',ttlSeconds:60,remainingPercent:67,resetAt:null};
  const manifest={id:'synthetic-quota',version:'1',provider,mode:'synthetic' as const,eligibility:'documented_supported' as const,
   source:'synthetic://quota-contract',timeoutMs:1000};
  const adapter:ProviderAdapter={manifest,probe:async()=>{calls++;return await new Promise<ProviderProbeResult>(resolve=>{release=resolve;});}};
  const collectors=new ProviderCollectors(db,[adapter]);
  const contextForControl=await db.createContext(principal,project,randomUUID());
  const deviceId=randomUUID(),keys=generateKeyPairSync('ed25519');
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await new Operators(db).enroll(principal,principal,deviceId,keys.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const installationId=(await db.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0].id;
  const command={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:contextForControl,
   action:'provider.bind' as const,payload:{accountId:account,adapterId:manifest.id,expectedRevision:0,minimumIntervalSeconds:1}};
  const proof=(value:Record<string,unknown>)=>{const data={deviceId,expiresAt:Date.now()+120000};return {...data,
   signature:sign(null,Buffer.from(operatorMessage(principal,value,data,installationId)),keys.privateKey).toString('hex')};};
  const control=new Control(db,[adapter]);
  const bound=await control.execute(principal,command,proof(command));
  assert.deepEqual(await control.execute(principal,{...command,deliveryAttemptId:randomUUID()},proof(command)),bound);
  assert.equal((await control.view(principal,contextForControl)).providerBindings.length,1);
  await assert.rejects(collectors.latest('outsider',project,account),/ACCOUNT_FORBIDDEN/);
  const id=randomUUID(),first=collectors.collect(principal,project,account,id);
  for(let i=0;!release&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert(release);await assert.rejects(collectors.collect(principal,project,account,randomUUID()),/PROVIDER_PROBE_IN_PROGRESS/);
  release(next as ProviderProbeResult);assert.equal((await first).snapshot.status,'available');
  const expiry=(await collectors.latest(principal,project,account)).expiresAt;
  assert.equal((await collectors.collect(principal,project,account,id)).duplicate,true);
  assert.deepEqual((await collectors.latest(principal,project,account)).expiresAt,expiry);assert.equal(calls,1);
  await assert.rejects(collectors.collect(principal,project,account,randomUUID()),/PROVIDER_PROBE_THROTTLED/);
  const context=await db.createContext(principal,project,randomUUID());await fixture.service.assignPolicy(principal,context,fixture.revision);
  const authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  const cmd:Command={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,
   action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:collector'}};
  const intent=await db.accept(principal,cmd,authority,'api');
  const grant=await fixture.service.reserve(principal,{attemptId:randomUUID(),intentId:intent.id,contextId:context,role:'programmer'},authority);
  assert.equal(grant.account_id,account);
  await fixture.service.transition(principal,grant.id,authority,'released',{state:'not_started',processId:'synthetic-probe-never-started'});
  await db.pool.query("UPDATE ac_provider_bindings SET last_started_at=clock_timestamp()-interval '2 seconds' WHERE account_id=$1",[account]);
  const invalid=new ProviderCollectors(db,[{manifest,probe:async()=>({status:'available',ttlSeconds:60,remainingPercent:100,resetAt:null,
   credential:'THIS_MUST_NEVER_BE_PERSISTED'}) as ProviderProbeResult}]);
  const bad=await invalid.collect(principal,project,account,randomUUID());
  assert.equal(bad.snapshot.status,'configuration_error');assert.equal(bad.snapshot.remainingPercent,null);
  const quota=(await db.pool.query('SELECT status FROM ac_quota_observations WHERE account_id=$1',[account])).rows[0];
  assert.equal(quota.status,'configuration_error');
  await assert.rejects(fixture.service.reserve(principal,{attemptId:randomUUID(),intentId:intent.id,contextId:context,role:'programmer'},authority),/NO_ELIGIBLE_CAPACITY/);
  const rows=await db.pool.query('SELECT snapshot FROM ac_provider_observations WHERE account_id=$1',[account]);
  assert(!JSON.stringify(rows.rows).includes('THIS_MUST_NEVER_BE_PERSISTED'));
  const changed=new ProviderCollectors(db,[{manifest:{...manifest,version:'2'},probe:async()=>next as ProviderProbeResult}]);
  await assert.rejects(changed.collect(principal,project,account,randomUUID()),/PROVIDER_ADAPTER_VERSION_CHANGED/);
  await db.pool.query("UPDATE ac_provider_observations SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1",[account]);
  const expired=await collectors.latest(principal,project,account);assert.equal(expired.status,'unknown');assert.equal(expired.remainingPercent,null);
  const replay=await collectors.collect(principal,project,account,id);
  assert.equal(replay.snapshot.status,'unknown');assert.equal(replay.snapshot.remainingPercent,null);assert.equal(calls,1);
  const latestRow=(await db.pool.query("SELECT id,snapshot FROM ac_provider_observations WHERE account_id=$1 ORDER BY completed_at DESC LIMIT 1",[account])).rows[0];
  const corrupt={...latestRow.snapshot,credential:'SYNTHETIC_EXTRA_MUST_NOT_LEAK'};
  await db.pool.query('UPDATE ac_provider_observations SET snapshot=$2,digest=$3 WHERE id=$1',[latestRow.id,corrupt,digest(corrupt)]);
  await assert.rejects(control.view(principal,contextForControl),/PROVIDER_OBSERVATION_CORRUPT/);
  await assert.rejects(collectors.latest(principal,project,account),/PROVIDER_OBSERVATION_CORRUPT/);
  const timeoutAdapter:ProviderAdapter={manifest:{...manifest,version:'timeout',timeoutMs:20},probe:async()=>await new Promise(()=>{})};
  const timeouts=new ProviderCollectors(db,[timeoutAdapter]);
  await timeouts.bind(principal,project,{accountId:account,adapterId:manifest.id,expectedRevision:1,minimumIntervalSeconds:1});
  await db.pool.query("UPDATE ac_provider_bindings SET last_started_at=clock_timestamp()-interval '2 seconds' WHERE account_id=$1",[account]);
  assert.equal((await timeouts.collect(principal,project,account,randomUUID())).snapshot.status,'unreachable');
  await assert.rejects(timeouts.collect(principal,project,account,randomUUID()),/PROVIDER_PROBE_UNCERTAIN/);
 }finally{await db.close();await isolated.close();}
});
