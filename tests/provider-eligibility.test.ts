import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {ProviderEligibility} from '../src/provider-eligibility.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('provider eligibility is owner-scoped immutable reviewed metadata, not activation',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const database=await isolatedDatabase(base,'eligibility'),db=new Ledger(database.url),capacity=new Capacity(db),service=new ProviderEligibility(db);
 try{
  await db.migrate();const project=randomUUID(),principal='owner-'+randomUUID(),accountId=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'eligibility fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner'),($1,$3,'viewer')",[project,principal,'fixture-viewer']);
  await capacity.addAccount(principal,project,{id:accountId,provider:'explicit-fixture',label:'fixture',resourceIdentity:randomUUID(),mode:'subscription_cli',
   eligibility:'not_assessed',eligibilitySource:'synthetic://fixture',maxConcurrent:1});
  const input={accountId,expectedRevision:0,plan:'fixture plan',adapterId:'fixture-adapter',adapterVersion:'v1',authenticationMode:'subscription_oauth' as const,
   executionMode:'central_isolated_cli' as const,sourceURL:'https://example.test/policy',status:'documented_supported' as const,
   reason:'synthetic reviewed metadata',reviewedAt:new Date(Date.now()-40000).toISOString(),validForSeconds:30};
  await assert.rejects(service.publish('fixture-viewer',project,input),/ACCOUNT_FORBIDDEN/);
  await assert.rejects(service.publish(principal,project,{...input,authenticationMode:'api_key'}),/PROVIDER_ELIGIBILITY_MODE_MISMATCH/);
  await assert.rejects(service.publish(principal,project,{...input,reviewedAt:new Date(Date.now()+120000).toISOString()}),/PROVIDER_ELIGIBILITY_REVIEW_TIME_INVALID/);
  await assert.rejects(service.publish(principal,project,{...input,reviewedAt:new Date(Date.now()-31*86400000).toISOString()}),/PROVIDER_ELIGIBILITY_REVIEW_TIME_INVALID/);
  await assert.rejects(service.publish(principal,project,{...input,sourceURL:'https://example.test/policy?token=fixture'}));
  const first=await service.publish(principal,project,input),replay=await service.publish(principal,project,input);
  assert.equal(first.revision,1);assert.equal(first.duplicate,false);assert.equal(replay.duplicate,true);assert.equal(replay.expiresAt,first.expiresAt);
  await assert.rejects(service.publish(principal,project,{...input,reason:'changed'}),/PROVIDER_ELIGIBILITY_REVISION_CONFLICT/);
  const observed=await service.view('fixture-viewer',project,accountId);assert.equal(observed.latest?.fresh,false);assert.equal(observed.latest?.effectiveStatus,'not_assessed');
  const second=await service.publish(principal,project,{...input,expectedRevision:1,reviewedAt:new Date().toISOString(),validForSeconds:300});
  assert.equal(second.revision,2);const history=await service.view(principal,project,accountId,1);
  assert.equal(history.history.length,1);assert.equal(history.latest?.fresh,true);assert.equal(history.latest?.effectiveStatus,'documented_supported');
  const projectView=await service.viewProject('fixture-viewer',project,1);
  assert.equal(projectView.truncated,false);assert.equal(projectView.assessments.length,1);
  assert.equal(projectView.assessments[0]?.accountId,accountId);assert.equal(projectView.assessments[0]?.revision,2);
  await assert.rejects(service.viewProject('outsider',project),/PROJECT_FORBIDDEN/);
  assert.equal((await db.pool.query('SELECT enabled,eligibility FROM ac_accounts WHERE id=$1',[accountId])).rows[0].enabled,false);
  assert.equal((await db.pool.query('SELECT eligibility FROM ac_accounts WHERE id=$1',[accountId])).rows[0].eligibility,'not_assessed');
  await assert.rejects(db.pool.query('UPDATE ac_provider_eligibility_assessments SET reason=$2 WHERE account_id=$1',[accountId,'forged']),/POLICY_REVISION_IMMUTABLE/);
  await assert.rejects(service.view('outsider',project,accountId),/ACCOUNT_FORBIDDEN/);
 }finally{await db.close();await database.close();}
});
