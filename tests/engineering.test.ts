import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {Integrator} from '../src/integration.ts';
import {canonical,type Command} from '../src/contracts.ts';
import {provisionEngineering} from './fixtures/provision-engineering.ts';
import {Templates} from '../src/templates.ts';
import {IsolatedImplementation} from '../src/isolated-implementation.ts';

// Synthetic payloads, actual PostgreSQL, Cezar, Ruby Git helper, processes and Git refs.
test('engineering DAG records independent verification before conditional integration', {timeout:90000}, async()=>{
 const isolated=process.env.AC_ISOLATED_ENGINEERING==='1';
 const url=isolated?process.env.AC_SANDBOX_DATABASE_URL:process.env.AC_TEST_DATABASE_URL;
 if(!url?.endsWith(isolated?'/ac_sandbox_test':'/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();
 const project=randomUUID(),principal='engineering-'+randomUUID();
 await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Engineering fixture']);
 await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
 await mkdir('.state/projects',{recursive:true});const repo=await mkdtemp(resolve('.state/projects/ac-engineering-'));
 const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
 git('init','-q','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','Synthetic fixture');
 await writeFile(join(repo,'README.md'),'Fixture only\n');git('add','.');git('commit','-qm','base');git('branch','protected');
 const base=git('rev-parse','HEAD');await mkdir(join(repo,'.ai/cezar'),{recursive:true});
 await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[],worktreeRetention:0}));
 const {revision,options}=await provisionEngineering(db,principal,project,repo,3,true);
 const context=await db.createContext(principal,project,randomUUID());await new (await import('../src/capacity.ts')).Capacity(db).assignPolicy(principal,context,revision);
 if(options.qualityRevision===undefined||options.targetRef===undefined)throw Error('MISSING_ENGINEERING_FIXTURE_CONFIG');
 await new Templates(db).publish(principal,context,0,{workflow:'engineering-synthetic-v1',qualityRevision:options.qualityRevision,targetRef:options.targetRef});
 const authority=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
 const runtime=new CezarRuntime(db,repo,project,options,isolated?new IsolatedImplementation(db):undefined);await runtime.start();
 try{
  const command:Command={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,
   action:'plan.start',payload:{workflow:'engineering-synthetic-v1',messageRef:'encrypted:synthetic'}};
  const intent=await db.accept(principal,command,authority,'api');await runtime.dispatch(intent,authority);
  let done=false;
  for(let i=0;i<500;i++){
   const run=runtime.store.getRun(intent.run_id);
   if(run?.status==='failed')throw Error('SYNTHETIC_ENGINEERING_FAILED '+JSON.stringify({error:run.error,steps:run.steps}));
   if(run&&['review','done'].includes(run.status)){done=true;break;}
   await new Promise(r=>setTimeout(r,100));
  }
  assert(done,'synthetic DAG did not finish');
  const operation=(await db.pool.query('SELECT * FROM ac_operations WHERE intent_id=$1',[intent.id])).rows[0];
  if(isolated){
   const job=(await db.pool.query('SELECT * FROM ac_sandbox_jobs WHERE id=$1',[operation.id])).rows[0];
   assert.equal(job.state,'completed');assert.equal(job.profile,'synthetic-implementation-v1');
   assert.equal(job.receipt.implementation.commit,operation.receipt.commit);
  }
  assert.equal(git('rev-parse','refs/heads/protected'),operation.receipt.commit);
  assert.equal(git('rev-parse','refs/heads/main'),base);
  const stages=(await db.pool.query('SELECT node_id,session_id,state,receipt FROM ac_stage_operations WHERE intent_id=$1 ORDER BY node_id',[intent.id])).rows;
  assert.deepEqual(stages.map(s=>s.node_id),['integrate','judge','qa','review','review','review']);
  assert(stages.every(s=>s.state==='completed'));
  const evidence=(await db.pool.query('SELECT * FROM ac_verification_evidence WHERE artifact_id=$1',[stages.find(s=>s.node_id==='qa').receipt.verification.artifactId])).rows;
  assert.equal(evidence.length,5);assert.equal(new Set(evidence.map(e=>e.session_id)).size,5);
  assert(evidence.every(e=>e.session_id!==operation.native_session_id&&e.status==='passed'));
  const overlap=(await db.pool.query(`WITH points AS (
   SELECT started_at at,1 delta FROM ac_stage_operations WHERE intent_id=$1 AND node_id='review'
   UNION ALL SELECT finished_at at,-1 delta FROM ac_stage_operations WHERE intent_id=$1 AND node_id='review'),
   occupancy AS (SELECT sum(delta) OVER (ORDER BY at,delta ROWS UNBOUNDED PRECEDING) n FROM points)
   SELECT max(n) maximum FROM occupancy`,[intent.id])).rows[0].maximum;
  assert(Number(overlap)>=1&&Number(overlap)<=2,'reviewers obey the two-slot evaluation policy');
  const recorded=stages.find(s=>s.node_id==='review').receipt.verification;
  const changed={...recorded,commit:'f'.repeat(40)};
  const signature=createHmac('sha256',options.verifierKey).update(canonical(changed)).digest('hex');
  await assert.rejects(options.quality.record(principal,changed,signature,authority),/VERIFICATION_ARTIFACT_MISMATCH/);
  const reused={...recorded,id:randomUUID(),sessionId:operation.native_session_id};
  const reusedSignature=createHmac('sha256',options.verifierKey).update(canonical(reused)).digest('hex');
  await assert.rejects(options.quality.record(principal,reused,reusedSignature,authority),/VERIFICATION_NOT_INDEPENDENT/);
  await assert.rejects(options.quality.record(principal,changed,'0'.repeat(64),authority),/UNTRUSTED_VERIFICATION/);
  const integration=(await db.pool.query('SELECT * FROM ac_integration_intents WHERE artifact_id=$1',[recorded.artifactId])).rows[0];
  const rejected=await options.git.cas(operation.receipt.commit,base,'refs/heads/protected',randomUUID());
  assert.equal(rejected.status,'rejected');
  git('update-ref','refs/heads/protected',base,operation.receipt.commit);
  const replay=await new Integrator(db,options.quality,options.git,project,'refs/heads/protected').integrate(principal,integration.id,authority);
  assert.equal(replay.status,'integrated');assert.equal(git('rev-parse','refs/heads/protected'),base);
  await writeFile(isolated?'docs/validation/evidence/engineering-dag-isolated.json':'docs/validation/evidence/engineering-dag-real-components.json',JSON.stringify({result:'passed',synthetic:true,
   actualComponents:['PostgreSQL','Cezar RunManager','Git','Ruby helper','OS processes'],
   independentVerifierSessions:5,reviewers:3,judge:1,maxSimultaneousReviews:Number(overlap),stages:stages.map(s=>s.node_id),verifiedTree:operation.receipt.tree,
   denied:['changed artifact','implementation session reused','invalid signature','moved base'],replayDoesNotRewriteRef:true,
   isolatedImplementation:isolated,
   limitation:'Synthetic fixed implementation and reviewers; verification processes remain controller-local. No real provider, mobile client or production deployment.'},null,2));
 }finally{await runtime.close();await db.close();}
});
