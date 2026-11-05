import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {convertPaseoOfflineHistory} from '../src/paseo-history-converter.ts';
import {digest} from '../src/contracts.ts';
const fixture=async()=>JSON.parse(await readFile(new URL('./fixtures/import-v2/paseo-offline.json',import.meta.url),'utf8'));

test('offline conversion preserves source provenance, typed links and unknown fields without authorizing execution',async()=>{
 const source=await fixture();source.plans[0].legacyExtra.secretCanary='synthetic-private-canary';
 const converted=convertPaseoOfflineHistory(source),plan=converted.history.plans[0];
 assert.equal(converted.executable,false);assert.equal(converted.sourceClaimsVerified,false);
 assert.equal(plan.provenance.sourceSnapshotDigest,digest(source));assert.equal(plan.provenance.sourceObjectDigest,digest(source.plans[0]));
 assert.equal(plan.sourceReportedState,'unknown');assert.equal(plan.format,'structured-plan-v1');
 if(plan.format!=='structured-plan-v1')throw Error();
 assert.deepEqual(plan.contract.tasks[1].dependsOn,[plan.contract.tasks[0].idDigest]);
 assert.equal(converted.history.evidence[0].planRef.id,plan.id);
 assert.equal(JSON.stringify(converted).includes('synthetic-private-canary'),false);
 assert.equal(JSON.stringify(plan.payload).includes(digest('synthetic-private-canary')),true);
 assert.deepEqual(convertPaseoOfflineHistory(source),converted);
});

test('offline conversion refuses unknown versions and ambiguous or broken references',async()=>{
 const source=await fixture();
 assert.throws(()=>convertPaseoOfflineHistory({...source,sourceVersion:'unknown-live-format'}));
 assert.throws(()=>convertPaseoOfflineHistory({...source,plans:[source.plans[0],{...source.plans[0],id:'another-plan'}]}),/RUN_BINDING_REQUIRED/);
 const cycle=structuredClone(source);cycle.plans[0].tasks[0].dependsOn=['evaluate'];assert.throws(()=>convertPaseoOfflineHistory(cycle));
 const orphan=structuredClone(source);orphan.evidence[0].run='missing';assert.throws(()=>convertPaseoOfflineHistory(orphan));
 const duplicate=structuredClone(source);duplicate.runs.push(duplicate.runs[0]);assert.throws(()=>convertPaseoOfflineHistory(duplicate),/DUPLICATE_RUN/);
 const graph=structuredClone(source);graph.plans[0].graph.edges[0].to.port='absent';assert.throws(()=>convertPaseoOfflineHistory(graph));
 assert.throws(()=>convertPaseoOfflineHistory(undefined),/SIZE_LIMIT/);
});
