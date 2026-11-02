import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {Ledger} from '../src/ledger.ts';
import {ContextDiagnostics} from '../src/diagnostics.ts';
import {createDiagnosticsApi} from '../src/diagnostics-api.ts';

test('context diagnostics stays read-only, scoped, evidence-based and redacted',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url||!/^\/ac_diagnostics_test_[a-f0-9]+$/.test(new URL(url).pathname))throw Error('ISOLATED_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();const project=randomUUID(),other=randomUUID(),owner='owner-'+randomUUID(),outsider='outsider-'+randomUUID();
 try{
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2),($3,$4)',[project,'fixture',other,'other']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner'),($3,$2,'owner'),($3,$4,'owner')",[project,owner,other,outsider]);
  const context=await db.createContext(owner,project,randomUUID()),otherContext=await db.createContext(owner,other,randomUUID());
  const authority=await db.acquire(owner,context,randomUUID(),'synthetic-manager',60);
  const service=new ContextDiagnostics(db,project),unknown=await service.read(owner,context);
  assert.equal(unknown.assessment,'unknown');assert.deepEqual(unknown.findings,[]);
  await assert.rejects(service.read(outsider,context),/CONTEXT_FORBIDDEN/);
  await assert.rejects(service.read(owner,otherContext),/PROJECT_RUNTIME_MISMATCH/);
  const secret='secret-transcript-example';
  const intent=await db.accept(owner,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:secret}},authority,'api');
  await db.pool.query('UPDATE ac_contexts SET paused=true,draining=true WHERE id=$1',[context]);
  await db.pool.query("UPDATE ac_operations SET state='uncertain' WHERE id=$1",[intent.operation_id]);
  await db.pool.query('INSERT INTO ac_plan_cancellations(intent_id,context_id,requested_by,plan_revision) VALUES($1,$2,$3,$4)',[intent.id,context,owner,intent.plan_revision]);
  const attempt=randomUUID();await db.pool.query("INSERT INTO ac_capacity_waits(attempt_id,context_id,intent_id,role,request_digest,manager_epoch,reason) VALUES($1,$2,$3,'programmer','opaque',$4,$5)",[attempt,context,intent.id,authority.epoch,secret]);
  const before=(await db.pool.query('SELECT count(*)::int n FROM ac_audit')).rows[0].n;
  const result=await service.read(owner,context),codes=result.findings.map(x=>x.code);
  for(const code of ['context_paused','context_draining','effect_uncertain','cancellation_requested','capacity_wait'] as const)assert(codes.includes(code),code);
  assert(!JSON.stringify(result).includes(secret));assert(result.findings.every(x=>x.owner&&x.nextCondition&&x.evidence.length));
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_audit')).rows[0].n,before);
  const app=new Hono<{Variables:{principal:string}}>();app.use('*',async(c,next)=>{const principal=c.req.header('x-test-principal');if(principal)c.set('principal',principal);await next();});app.route('/api/v1/ac',createDiagnosticsApi(db,project));
  const path=`/api/v1/ac/contexts/${context}/diagnostics`;
  assert.equal((await app.request(path)).status,401);
  assert.equal((await app.request(path,{headers:{'x-test-principal':outsider}})).status,403);
  const response=await app.request(path,{headers:{'x-test-principal':owner}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert(!JSON.stringify(await response.json()).includes(secret));
  assert.equal((await app.request('/api/v1/ac/auth/session',{method:'POST'})).status,404);
 }finally{await db.close();}
});
