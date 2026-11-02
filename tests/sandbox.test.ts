import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {Ledger} from '../src/ledger.ts';
import {SandboxClient} from '../src/sandbox-client.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';
import type {Command} from '../src/contracts.ts';

test('isolated Docker worker has no administrative socket, peer credentials or network', {timeout:40000,skip:!process.env.AC_SANDBOX_DATABASE_URL?'sandbox profile not enabled':false},async()=>{
 const url=process.env.AC_SANDBOX_DATABASE_URL;if(!url?.endsWith('/ac_sandbox_test'))throw Error('ISOLATED_SANDBOX_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();const project=randomUUID(),principal='sandbox-'+randomUUID();
 await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Sandbox fixture']);
 await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
 const capacity=await provisionCapacity(db,principal,project),context=await db.createContext(principal,project,randomUUID());
 await capacity.service.assignPolicy(principal,context,capacity.revision);
 const authority=await db.acquire(principal,context,randomUUID(),'fixture',60);
 const command:Command={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,
  action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:sandbox'}};
 const intent=await db.accept(principal,command,authority,'api');
 const operation=(await db.pool.query('SELECT execution_attempt_id FROM ac_operations WHERE id=$1',[intent.operation_id])).rows[0];
 const grant=await capacity.service.reserve(principal,{attemptId:operation.execution_attempt_id,intentId:intent.id,contextId:context,role:'programmer'},authority);
 await db.pool.query('UPDATE ac_operations SET grant_id=$2 WHERE id=$1',[intent.operation_id,grant.id]);
 const client=new SandboxClient();let terminal=false;
 try{
  const forged=JSON.stringify({schemaVersion:1,action:'start',jobId:intent.operation_id,grantId:grant.id,authority,profile:'synthetic-probe-v1',expiresAt:Date.now()+30000,signature:'0'.repeat(64)});
  const status=await new Promise<number>((ok,fail)=>{const req=httpRequest({socketPath:'/run/ac-broker/control.sock',path:'/v1/jobs',method:'POST',headers:{'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>ok(res.statusCode??0));});req.on('error',fail);req.end(forged);});
  assert.equal(status,403);
  const started=await client.perform('start',intent.operation_id,grant.id,authority) as {state:string};assert.equal(started.state,'running');
  let result:{exitCode?:number;probe?:{visible:string[];network:boolean;uid:number}}={};
  for(let i=0;i<80;i++){
   result=await client.perform('reconcile',intent.operation_id,grant.id,authority) as typeof result;
   if(result.exitCode!==undefined){terminal=true;break;}
   await new Promise(r=>setTimeout(r,250));
  }
  assert(terminal,'sandbox result not observed');assert.equal(result.exitCode,0);
  assert.deepEqual(result.probe,{visible:[],network:false,uid:10001});
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[grant.id])).rows[0].state,'released');
  assert.deepEqual(await client.perform('start',intent.operation_id,grant.id,authority),result,'replay returns receipt, no second process');
  await client.perform('cleanup',intent.operation_id,grant.id,authority);
 }finally{await db.close();}
});
