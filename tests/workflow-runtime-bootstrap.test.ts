import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {prepareWorkflowRuntimeRegistration,startWorkflowRuntimeRegistration,WorkflowRuntimeRegistrationConfig} from '../src/workflow-runtime-bootstrap.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('configured runtime registration measures local bytes, renews only registration and expires its own leases on close',async()=>{
 assert.equal(await prepareWorkflowRuntimeRegistration(undefined),undefined);
 assert.equal(WorkflowRuntimeRegistrationConfig.safeParse({state:'registered-inactive',buildId:'invented'}).success,false);
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('AC_TEST_DATABASE_URL_REQUIRED');
 const db=await isolatedDatabase(base,'r4register');const local=await prepareWorkflowRuntimeRegistration({state:'registered-inactive'});assert(local);
 const ledger=new Ledger(db.url,undefined,local.identity);let registration:Awaited<ReturnType<typeof startWorkflowRuntimeRegistration>>|undefined;
 try{
  await ledger.migrate();const a=randomUUID(),b=randomUUID();
  for(const id of [a,b]){await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[id,'synthetic']);await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,'owner','owner')",[id]);}
  registration=await startWorkflowRuntimeRegistration(ledger,local,[{id:a,owner:'owner'},{id:b,owner:'owner'}]);
  assert.equal(registration.report.state,'registered-inactive');assert.equal(registration.report.automaticDispatch,false);
  assert.equal((await ledger.pool.query('SELECT 1 FROM ac_workflow_runtime_instances WHERE instance_id=$1 AND lease_until>clock_timestamp()',[local.identity.instanceId])).rowCount,2);
  for(const table of ['ac_workflow_runtime_defaults','ac_workflow_generations','ac_intents','ac_operations','ac_capacity_grants'])assert.equal((await ledger.pool.query('SELECT 1 FROM '+table)).rowCount,0,table);
  await assert.rejects(startWorkflowRuntimeRegistration(ledger,JSON.parse(JSON.stringify(local)),[{id:a,owner:'owner'}]),/LOCAL_RUNTIME_CAPABILITY_REQUIRED/);
  assert.equal((await ledger.pool.query('SELECT 1 FROM ac_workflow_runtime_instances WHERE instance_id=$1 AND lease_until>clock_timestamp()',[local.identity.instanceId])).rowCount,2);
  await registration.close();await registration.close();
  assert.equal((await ledger.pool.query('SELECT 1 FROM ac_workflow_runtime_instances WHERE instance_id=$1 AND lease_until>clock_timestamp()',[local.identity.instanceId])).rowCount,0);
  await assert.rejects(startWorkflowRuntimeRegistration(ledger,local,[{id:a,owner:'owner'},{id:b,owner:'outsider'}]),/PROJECT_OWNER_REQUIRED/);
  assert.equal((await ledger.pool.query('SELECT 1 FROM ac_workflow_runtime_instances WHERE instance_id=$1 AND lease_until>clock_timestamp()',[local.identity.instanceId])).rowCount,0);
 }finally{await registration?.close();await ledger.close();await db.close();}
});

test('recurring registration isolates revoked project ownership and failing diagnostics',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('AC_TEST_DATABASE_URL_REQUIRED');
 const db=await isolatedDatabase(base,'r4renew');const local=await prepareWorkflowRuntimeRegistration({state:'registered-inactive'});assert(local);
 const ledger=new Ledger(db.url,undefined,local.identity);let registration:Awaited<ReturnType<typeof startWorkflowRuntimeRegistration>>|undefined;
 try{
  await ledger.migrate();const a=randomUUID(),b=randomUUID();
  for(const id of [a,b]){await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[id,'synthetic']);await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,'owner','owner')",[id]);}
  let errors=0;registration=await startWorkflowRuntimeRegistration(ledger,local,[{id:a,owner:'owner'},{id:b,owner:'owner'}],()=>{errors++;throw Error('synthetic diagnostic failure');});
  const before=(await ledger.pool.query('SELECT lease_until FROM ac_workflow_runtime_instances WHERE project_id=$1',[b])).rows[0].lease_until as Date;
  await ledger.pool.query('DELETE FROM ac_memberships WHERE project_id=$1',[a]);
  const until=Date.now()+14000;let renewed=false;
  while(Date.now()<until){await new Promise(resolve=>setTimeout(resolve,250));const row=(await ledger.pool.query('SELECT lease_until FROM ac_workflow_runtime_instances WHERE project_id=$1',[b])).rows[0];if(row.lease_until.getTime()>before.getTime()){renewed=true;break;}}
  assert(renewed,'authorized project still renews after an earlier project loses its owner');assert.equal(errors,1);
 }finally{await registration?.close();await ledger.close();await db.close();}
});
