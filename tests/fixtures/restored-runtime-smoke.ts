// Starts only the in-memory managed runtime on a restored synthetic repository.
// No HTTP listener, conversation endpoint, provider or worker is started.
import assert from 'node:assert/strict';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {Ledger} from '../../src/ledger.ts';
import {CezarRuntime} from '../../src/cezar.ts';
const url=process.env.AC_TEST_DATABASE_URL;
if(!url||!/^ac_restore_[a-f0-9]{16}$/.test(new URL(url).pathname.slice(1)))throw Error('NEW_RESTORE_DATABASE_REQUIRED');
const restored=await realpath(process.argv[2]),fixture=JSON.parse(await readFile(join(restored,'.state/browser-fixture.json'),'utf8'));
const repo=await realpath(fixture.repo);
if(!repo.startsWith(restored+sep+'.state/projects'+sep))throw Error('REPOSITORY_OUTSIDE_RESTORE');
const config=JSON.parse(await readFile(join(repo,'.ai/cezar/config.json'),'utf8'));
if(Object.keys(config).some(key=>!['baseBranch','skillsRepos','maxParallel','worktreeRetention'].includes(key)))throw Error('UNEXPECTED_RESTORE_FIXTURE_CONFIG');
const ledger=new Ledger(url);let runtime:CezarRuntime|undefined;
try{
 const admission=(await ledger.pool.query('SELECT enabled FROM ac_admission_control WHERE id=1')).rows[0];
 assert.equal(admission.enabled,false);
 const identity=async()=>{const row=(await ledger.pool.query(`SELECT
  (SELECT md5(string_agg(id::text||state,',' ORDER BY id)) FROM ac_operations) operations,
  (SELECT md5(string_agg(id::text||state,',' ORDER BY id)) FROM ac_capacity_grants) grants,
  (SELECT count(*) FROM ac_intents) intents`)).rows[0];return row;};
 const before=await identity();runtime=new CezarRuntime(ledger,repo,fixture.project);
 for(const run of runtime.store.listRuns())if(run.worktreePath)
  assert((await realpath(run.worktreePath)).startsWith(repo+sep+'.ai/cezar/worktrees'+sep),'native run still points outside restored repository');
 const ids=runtime.store.listRuns().map(run=>run.id).sort();await runtime.start();
 assert.deepEqual(runtime.store.listRuns().map(run=>run.id).sort(),ids);
 assert.deepEqual(await identity(),before);
 const result={result:'passed',synthetic:true,admissionClosed:true,runsPreserved:ids.length,
  operationsAndGrantsUnchanged:true,noHttpListener:true,noConversationEndpoint:true,noWorkerDispatched:true,
  limitation:'Managed runtime only; canonical Happier UI, live physical effects, provider accounts and full disaster recovery are not exercised.'};
 await writeFile(resolve('docs/validation/evidence/restored-runtime-smoke.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));
}finally{await runtime?.close();await ledger.close();}
