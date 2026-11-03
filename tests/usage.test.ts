import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {Usage} from '../src/usage.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';
import type {Command} from '../src/contracts.ts';

test('usage observations deduplicate, reject regressions and preserve unknown balances',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url?.endsWith('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(url,'usage'),db=new Ledger(isolated.url);await db.migrate();const project=randomUUID(),principal='usage-'+randomUUID();
 try{
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Usage fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const capacity=await provisionCapacity(db,principal,project),context=await db.createContext(principal,project,randomUUID());
  await capacity.service.assignPolicy(principal,context,capacity.revision);
  const authority=await db.acquire(principal,context,randomUUID(),'fixture',60);
  const cmd:Command={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:synthetic'}};
  const intent=await db.accept(principal,cmd,authority,'api');
  const attempt=(await db.pool.query('SELECT execution_attempt_id FROM ac_operations WHERE id=$1',[intent.operation_id])).rows[0].execution_attempt_id;
  const grant=await capacity.service.reserve(principal,{attemptId:attempt,intentId:intent.id,contextId:context,role:'programmer'},authority);
  const usage=new Usage(db),event={grantId:grant.id,eventId:randomUUID(),seq:1,counters:{input:10,output:2,cache:5,reasoning:null}};
  assert.equal((await usage.record(principal,authority,event)).duplicate,false);
  assert.equal((await usage.record(principal,authority,event)).duplicate,true);
  await assert.rejects(usage.record(principal,authority,{...event,counters:{...event.counters,input:11}}),/USAGE_EVENT_CONFLICT/);
  await assert.rejects(usage.record(principal,authority,{...event,eventId:randomUUID(),seq:2,counters:{...event.counters,input:9}}),/USAGE_COUNTER_REGRESSION/);
  await usage.record(principal,authority,{...event,eventId:randomUUID(),seq:2,counters:{input:20,output:4,cache:8,reasoning:1}});
  const report=await usage.context(principal,context);assert.equal(report.subscriptionBalance,'unknown');
  assert.equal(report.attempts[0].reported_tokens,null);assert(!JSON.stringify(report).includes('reported_physical'));
  assert.deepEqual(report.attempts[0].counters,{input:20,output:4,cache:8,reasoning:1});
  await assert.rejects(usage.context('other',context),/CONTEXT_FORBIDDEN/);
 }finally{await db.close();await isolated.close();}
});
