import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {ReconciliationHistory,historyPageSql} from '../src/reconciliation-history.ts';
import {Cancellations} from '../src/cancellation.ts';

test('durable finite reconciliation sweeps replay crashes, fence acknowledgements and revisit old/late/changed rows',async()=>{
 const url=process.env.AC_R3_HISTORY_DATABASE_URL;
 if(!url?.endsWith('/ac_r3_history'))throw Error('DISPOSABLE_R3_HISTORY_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();
 const principal='r3-history-'+randomUUID(),project=randomUUID();
 try{
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Disposable R3 history']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const contextId=await db.createContext(principal,project,randomUUID());
  const a=await db.acquire(principal,contextId,randomUUID(),'synthetic-manager',60);
  const add=async(client=db.pool,created='2020-01-01T00:00:00.123456Z')=>{
   const id=randomUUID();
   await client.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,created_at)
    VALUES($1,$2,$3,'fixture','{}',$4,$5,1,0,$6)`,[id,contextId,principal,randomUUID(),randomUUID(),created]);return id;
  };
  const allocated=(await db.pool.query("SELECT nextval(pg_get_serial_sequence('ac_reconciliation_entries','seq'))::text n")).rows[0].n;
  const ids:string[]=[];for(let i=0;i<9;i++)ids.push(await add());
  const h=new ReconciliationHistory(db,3);
  const page=await h.page(a,'restart','ac_intents');assert.equal(page.ids.length,3);
  // Persisted effect + lost controller before ack. New helper replays exactly
  // the same page; the SQL effect is idempotent and remains one row per job.
  await db.pool.query(`CREATE TABLE IF NOT EXISTS r3_history_effects(id uuid PRIMARY KEY,n integer NOT NULL DEFAULT 1)`);
  const effect=async(p:typeof page)=>{for(const id of p.ids)await db.pool.query('INSERT INTO r3_history_effects(id) VALUES($1) ON CONFLICT DO NOTHING',[id]);};
  await effect(page);
  const restarted=new ReconciliationHistory(db,3),replay=await restarted.page(a,'restart','ac_intents');
  assert.deepEqual(replay,page);await effect(replay);replay.retain=replay.ids;await restarted.acknowledge(a,replay);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM r3_history_effects WHERE id=ANY($1::uuid[])',[page.ids])).rows[0].n,3);
  await assert.rejects(h.acknowledge(a,page),/RECONCILIATION_PAGE_SUPERSEDED/);
  const next=await h.page(a,'restart','ac_intents');assert.deepEqual(next.ids,ids.slice(3,6));
  await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[contextId]);
  const successor=await db.acquire(principal,contextId,randomUUID(),'synthetic-manager',60);
  await assert.rejects(h.acknowledge(a,next),/STALE_MANAGER/);
  const successorPage=await new ReconciliationHistory(db,3).page(successor,'restart','ac_intents');assert.deepEqual(successorPage.ids,next.ids);
  successorPage.retain=successorPage.ids;await h.acknowledge(successor,successorPage);
  const final=await h.page(successor,'restart','ac_intents');assert.deepEqual(final.ids,ids.slice(6));final.retain=final.ids;await h.acknowledge(successor,final);
  assert.deepEqual((await h.page(successor,'restart','ac_intents')).ids,ids.slice(0,3),'uncertain rows revisit');

  // A fixed ceiling cannot be extended by arrivals. An older timestamp and an
  // sequence hole published behind the cursor are both revisited. The hole
  // is an explicit registry fixture, not a real concurrent source transaction.
  let first=await h.page(successor,'finite','ac_intents');const ceiling=first.ceiling;first.retain=first.ids;await h.acknowledge(successor,first);
  const newest=await add();
  const late=await add();await db.pool.query('DELETE FROM ac_reconciliation_entries WHERE row_id=$1',[late]);
  await db.pool.query("INSERT INTO ac_reconciliation_entries(seq,context_id,source,row_id) OVERRIDING SYSTEM VALUE VALUES($1,$2,'ac_intents',$3)",[allocated,contextId,late]);
  const seen=new Set(first.ids);let completed=false;
  for(let tick=0;tick<5;tick++){
   const p=await h.page(successor,'finite','ac_intents');assert.equal(p.ceiling,ceiling);
   p.ids.forEach(id=>seen.add(id));p.retain=p.ids;await h.acknowledge(successor,p);
   if(p.cursor===p.ceiling){completed=true;break;}
  }
  assert.equal(completed,true);assert.equal(seen.has(newest),false);assert.equal(seen.has(late),false);
  const later=new Set<string>();for(let tick=0;tick<100;tick++)await h.run(successor,'finite','ac_intents',async(pageIds,retain)=>{pageIds.forEach(id=>later.add(id));retain(pageIds);});
  assert.equal(later.has(late),true);assert.equal(later.has(newest),true);

  // Inactive history is excluded from normal callbacks, source modifications
  // reactivate old rows, and dependency-only changes receive bounded audit.
  const clean=new ReconciliationHistory(db,256);
  await clean.run(successor,'dirty','ac_intents',async(_ids,retain)=>retain([]));
  assert.deepEqual((await clean.page(successor,'dirty','ac_intents')).ids,[]);
  await db.pool.query("UPDATE ac_intents SET state='failed' WHERE id=$1",[ids[0]]);
  const changed=await clean.page(successor,'dirty','ac_intents');assert.deepEqual(changed.ids,[ids[0]]);
  await db.pool.query("UPDATE ac_intents SET state='accepted' WHERE id=$1",[ids[0]]);
  await clean.acknowledge(successor,changed);
  let changedWhileRunning=await clean.page(successor,'dirty','ac_intents');
  if(!changedWhileRunning.ids.length){await clean.acknowledge(successor,changedWhileRunning);changedWhileRunning=await clean.page(successor,'dirty','ac_intents');}
  assert.deepEqual(changedWhileRunning.ids,[ids[0]],'ack cannot erase concurrent update');
  await clean.acknowledge(successor,changedWhileRunning);
  let audited=false;for(let tick=0;tick<20;tick++)await clean.run(successor,'dirty','ac_intents',async(auditIds,retain)=>{if(auditIds.includes(ids[1]))audited=true;retain([]);});
  assert.equal(audited,true,'finite audit revisits rows changed only through dependencies');
  const otherLane=await clean.page(successor,'independent','ac_intents');assert.equal(otherLane.ids.length,11,'one lane cannot clean another lane membership');

  // Callback-level failure advances the page while retaining retry candidates.
  const failedPage=await h.page(successor,'failure','ac_intents');
  await assert.rejects(h.run(successor,'failure','ac_intents',async()=>{throw Error('fixture failure');}),/fixture failure/);
  const afterFailure=await h.page(successor,'failure','ac_intents');
  assert.equal(afterFailure.ids.length,3);assert.ok(BigInt(afterFailure.cursor)>BigInt(failedPage.cursor));
  assert.equal(afterFailure.ids.some(id=>failedPage.ids.includes(id)),false);
  assert.throws(()=>new ReconciliationHistory(db,0),/INVALID_RECONCILIATION_PAGE_SIZE/);
 }finally{await db.pool.end();}
});

test('real cancellation rows isolate one callback failure and commit later confirmations',async()=>{
 const url=process.env.AC_R3_HISTORY_DATABASE_URL;if(!url?.endsWith('/ac_r3_history'))throw Error('DISPOSABLE_R3_HISTORY_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();
 try{
  const project=randomUUID(),principal='r3-failure-'+randomUUID();await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Disposable cancellation']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const context=await db.createContext(principal,project,randomUUID()),a=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
  const ids:string[]=[];for(let n=0;n<3;n++){
   const id=randomUUID();ids.push(id);await db.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision) VALUES($1,$2,$3,'fixture','{}',$4,$5,1,0)`,[id,context,principal,randomUUID(),id]);
   await db.pool.query(`INSERT INTO ac_plan_cancellations(intent_id,context_id,requested_by,plan_revision) VALUES($1,$2,$3,0)`,[id,context,principal]);
  }
  let calls=0;await assert.rejects(new Cancellations(db).reconcile(a,run=>{calls++;if(run===ids[0])throw Error('bad row');}),/CANCELLATION_STATE_RECONCILIATION_FAILED/);
  assert.equal(calls,3);
  const states=(await db.pool.query('SELECT intent_id,state FROM ac_plan_cancellations WHERE context_id=$1',[context])).rows;
  assert.equal(states.find(r=>r.intent_id===ids[0]).state,'requested');assert.equal(states.filter(r=>r.state==='confirmed').length,2);
  await new Cancellations(db).reconcile(a,()=>{});
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_plan_cancellations WHERE context_id=$1 AND state='confirmed'",[context])).rows[0].n,3);
 }finally{await db.pool.end();}
});


test('normal page uses indexed active/fresh sets across 20000 inactive memberships',async()=>{
 const url=process.env.AC_R3_HISTORY_DATABASE_URL;if(!url?.endsWith('/ac_r3_history'))throw Error('DISPOSABLE_R3_HISTORY_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();
 try{
  const project=randomUUID(),principal='r3-index-'+randomUUID();await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Disposable query plan']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const context=await db.createContext(principal,project,randomUUID()),a=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
  // Membership-only volume fixture: no accounts, execution or external jobs.
  await db.pool.query("INSERT INTO ac_reconciliation_entries(context_id,source,row_id) SELECT $1,'ac_intents',gen_random_uuid() FROM generate_series(1,20000)",[context]);
  const ceiling=(await db.pool.query('SELECT max(seq)::text n FROM ac_reconciliation_entries WHERE context_id=$1',[context])).rows[0].n;
  await db.pool.query("INSERT INTO ac_reconciliation_visits(context_id,lane,seq,revision,active) SELECT context_id,'index',seq,revision,seq=$2 FROM ac_reconciliation_entries WHERE context_id=$1",[context,ceiling]);
  await db.pool.query("INSERT INTO ac_reconciliation_progress(context_id,lane,cursor_seq,ceiling_seq,floor_seq,sweep,manager_epoch) VALUES($1,'index',0,$2,$2,1,1)",[context,ceiling]);
  await db.pool.query('ANALYZE ac_reconciliation_entries');await db.pool.query('ANALYZE ac_reconciliation_visits');
  const result=await db.pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+historyPageSql,[context,'ac_intents','0',ceiling,32,false,ceiling,'index']);
  const plan=result.rows[0]['QUERY PLAN'][0].Plan;
  const scans:any[]=[];const walk=(node:any)=>{if(['ac_reconciliation_entries','ac_reconciliation_visits'].includes(node['Relation Name']))scans.push(node);for(const child of node.Plans??[])walk(child);};walk(plan);
  assert.equal(scans.some(node=>node['Node Type']==='Seq Scan'),false,JSON.stringify(plan));
  assert.ok((plan['Shared Hit Blocks']??0)+(plan['Shared Read Blocks']??0)<300,JSON.stringify(plan));
  const page=await new ReconciliationHistory(db).page(a,'index','ac_intents');assert.equal(page.ids.length,1);assert.equal(page.cursor,ceiling);
  console.log(JSON.stringify({proof:'r3-history-indexed-inactive',inactiveMemberships:19999,returned:page.ids.length,sharedBlocks:(plan['Shared Hit Blocks']??0)+(plan['Shared Read Blocks']??0)}));
 }finally{await db.pool.end();}
});
