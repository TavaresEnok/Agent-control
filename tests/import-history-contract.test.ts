import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {ImportBundle} from '../src/import.ts';
import {digest} from '../src/contracts.ts';
import {historicalBundle} from './fixtures/import-v2-bundle.ts';
import type {HappierBoundary} from '../src/happier.ts';

const boundary={encrypt:()=>new Uint8Array([1,2,3]),encodeBase64:(b:Uint8Array)=>Buffer.from(b).toString('base64')} as unknown as HappierBoundary;
async function fixture(){return historicalBundle(randomUUID(),'session-1',randomBytes(32),boundary);}
test('v2 retains typed historical plan and evidence as untrusted source claims',async()=>{
 const input=await fixture(), parsed=ImportBundle.parse(input);
 assert.equal(parsed.schemaVersion,2);if(parsed.schemaVersion!==2)throw Error();
 const history=parsed.contexts[0].history,plan=history.plans[0];
 assert.equal(plan.format,'structured-plan-v1');if(plan.format!=='structured-plan-v1')throw Error();
 assert.equal(plan.contract.tasks.length,2);assert.deepEqual(plan.contract.tasks[1].dependsOn,[plan.contract.tasks[0].idDigest]);
 assert.equal(history.evidence[0].sourceReportedStatus,'passed');assert.equal(history.evidence[0].planRef.id,plan.id);
 assert.equal(JSON.stringify(parsed).includes('synthetic-only-check'),false);
});
test('v2 rejects changed payload, missing references, cycles, and arbitrary cleartext',async()=>{
 const input=await fixture();
 const broken=structuredClone(input);broken.contexts[0].history.plans[0].payloadDigest='0'.repeat(64);assert.equal(ImportBundle.safeParse(broken).success,false);
 const missing=structuredClone(input);missing.contexts[0].history.evidence[0].planRef.id=digest('missing');assert.equal(ImportBundle.safeParse(missing).success,false);
 const cycle=structuredClone(input);cycle.contexts[0].history.plans[0].contract.tasks[0].dependsOn=[cycle.contexts[0].history.plans[0].contract.tasks[1].idDigest];assert.equal(ImportBundle.safeParse(cycle).success,false);
 const clear=structuredClone(input);clear.contexts[0].history.plans[0].payload={secret:'cleartext'};clear.contexts[0].history.plans[0].payloadDigest=digest(clear.contexts[0].history.plans[0].payload);assert.equal(ImportBundle.safeParse(clear).success,false);
});

test('v2 journal survives lost acknowledgement and restart, pages every record, and rejects conflicts',{timeout:60000},async()=>{
 const {isolatedDatabase}=await import('./fixtures/isolated-database.ts');const {Ledger}=await import('../src/ledger.ts');const {IsolatedImport}=await import('../src/import.ts');const {ImportedHistory}=await import('../src/import-history.ts');
 const base=process.env.AC_TEST_DATABASE_URL;assert(base);const isolated=await isolatedDatabase(base,'importv2');const db=new Ledger(isolated.url);await db.migrate();
 const principal='owner-'+randomUUID(),project=randomUUID(),other='other-'+randomUUID(),delivered=new Map<string,string>();let lose=true;
 const transport={verifySession:async()=>true,verifySessionKey:async()=>true,verifyCiphertext:async()=>true,deliver:async(_p:string,_s:string,id:string,ciphertext:string)=>{const previous=delivered.get(id);if(previous)assert.equal(previous,ciphertext);delivered.set(id,ciphertext);if(lose){lose=false;throw Error('lost ack');}}};
 try{
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Fixture']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const input=await historicalBundle(project,'session-'+randomUUID(),randomBytes(32),boundary);let importer=new IsolatedImport(db,transport);
  await importer.stage(principal,input);await assert.rejects(importer.deliver(principal,input.importId),/lost ack/);
  importer=new IsolatedImport(db,transport);assert.equal((await importer.deliver(principal,input.importId)).state,'completed');assert.equal(delivered.size,1);assert.equal((await importer.stage(principal,input)).state,'completed');
  const archive=new ImportedHistory(db),pages=[];for await(const page of archive.exportPages(principal,project,input.importId,1))pages.push(page);
  assert.equal(pages.length,3);assert.deepEqual(pages.flatMap(p=>p.records).map((r:any)=>r.kind),['run','plan','evidence']);assert(pages.every(p=>p.historicalOnly&&!p.executable&&!p.sourceClaimsVerified&&p.payloadIntegrityVerified));
  await assert.rejects(archive.page(other,project,input.importId),/IMPORT_FORBIDDEN/);await assert.rejects(archive.page(principal,project,input.importId,'bad'),/IMPORT_HISTORY_CURSOR_INVALID/);
  const reimport={...input,importId:randomUUID()};await importer.stage(principal,reimport);await importer.deliver(principal,reimport.importId);const aliases=[];for await(const page of archive.exportPages(principal,project,reimport.importId,1))aliases.push(page);assert.equal(aliases.flatMap(p=>p.records).length,3);assert.equal(delivered.size,1);
  const conflict=structuredClone(reimport);conflict.importId=randomUUID();conflict.contexts[0].sourcePaused=true;await assert.rejects(importer.stage(principal,conflict),/IMPORT_SOURCE_CONTEXT_CONFLICT/);
  const entry=(await db.pool.query('SELECT context_id FROM ac_import_entries WHERE batch_id=$1',[input.importId])).rows[0];assert.equal((await db.pool.query('SELECT paused FROM ac_contexts WHERE id=$1',[entry.context_id])).rows[0].paused,true);
  for(const table of ['ac_intents','ac_managers'])assert.equal(Number((await db.pool.query(`SELECT count(*) n FROM ${table} WHERE context_id=$1`,[entry.context_id])).rows[0].n),0);
 }finally{await db.close();await isolated.close();}
});
