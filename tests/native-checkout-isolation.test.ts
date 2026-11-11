import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {NativeQa,type NativeQaContract} from '../src/native-qa.ts';
import {NativeImplementation} from '../src/native-implementation.ts';
import type {NativeExecutionSupervisor} from '../src/native-execution-supervisor.ts';
import {Refusal} from '../src/contracts.ts';
import {GitArtifacts} from '../src/git.ts';
import {Quality} from '../src/quality.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('QA and implementation of one checkout refuse an intent from another project',{skip:!process.env.AC_TEST_DATABASE_URL},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'f2chk'),db=new Ledger(fixture.url),area=await mkdtemp(join(tmpdir(),'ac-checkout-iso-'));
 try{
  await db.migrate();
  const principal='checkout-'+randomUUID(),repoA=join(area,'repo-a'),repoB=join(area,'repo-b'),qaRoot=join(area,'qa');
  for(const path of [repoA,repoB,qaRoot])await mkdir(path,{mode:0o700});
  const projectA=randomUUID(),projectB=randomUUID();
  const admit=async(project:string,repo:string)=>{
   await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'checkout isolation']);
   await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
   await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
   await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),principal]);
   const context=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
   const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
   return {authority,intent};
  };
  await admit(projectA,repoA);
  const other=await admit(projectB,repoB);
  const quality=new Quality(db,randomBytes(32),new GitArtifacts(repoA));
  const contract:NativeQaContract={schemaVersion:1,id:'fixture-qa',image:'sha256:'+'a'.repeat(64),argv:['/usr/bin/true'],environment:['PATH=/usr/bin:/bin'],timeoutMs:1000,memoryBytes:67108864,pids:16,nanoCpus:100000000};
  const qa=new NativeQa(db,quality,repoA,qaRoot,contract,randomBytes(32),'/no-operational-docker.sock');
  const implementation=new NativeImplementation(db,repoA,quality,[{ledger:db} as NativeExecutionSupervisor]);
  const artifact={id:randomUUID(),commit_id:'a'.repeat(40),tree_id:'b'.repeat(40),base_id:'c'.repeat(40),policy_revision:1} as Parameters<NativeQa['start']>[5];
  await assert.rejects(qa.start(principal,other.authority,other.intent.id,{id:randomUUID(),session_id:randomUUID()},randomUUID(),artifact),(error:unknown)=>{
   assert.ok(error instanceof Refusal);assert.equal(error.code,'NATIVE_QA_SCOPE_MISMATCH');return true;
  });
  await assert.rejects(implementation.prepareRecovery(other.intent,other.authority),(error:unknown)=>{
   assert.ok(error instanceof Refusal);assert.equal(error.code,'NATIVE_IMPLEMENTATION_SCOPE_MISMATCH');return true;
  });
  assert.equal(Number((await db.pool.query('SELECT count(*)::int n FROM ac_native_qa_jobs')).rows[0].n),0);
  assert.equal(Number((await db.pool.query('SELECT count(*)::int n FROM ac_native_execution_jobs')).rows[0].n),0);
 }finally{await db.close();await fixture.close();await rm(area,{recursive:true,force:true});}
});
