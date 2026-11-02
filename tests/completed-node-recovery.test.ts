import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync,spawn,type ChildProcess} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {Capacity} from '../src/capacity.ts';
import {Templates} from '../src/templates.ts';
import {provisionEngineering} from './fixtures/provision-engineering.ts';

for(const stopNode of ['qa','review','judge','integrate','integrate-after-cas','integrate-before-cas','qa-before-start','qa-wait-capacity','integrate-registered'])test(`SIGKILL at ${stopNode}: ${stopNode==='integrate-before-cas'?'preserve uncertainty without writing Git':'replay receipt and finish the same graph'}`,{timeout:30000},async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url?.endsWith('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();let runtime:CezarRuntime|undefined,child:ChildProcess|undefined,configPath:string|undefined;
 try{
  const project=randomUUID(),principal='completed-recovery-'+randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Completed node recovery']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await mkdir('.state/projects',{recursive:true});const repo=await mkdtemp(resolve('.state/projects/ac-completed-recovery-'));
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
  git('init','-q','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','Synthetic fixture');
  await writeFile(join(repo,'README.md'),'Recovery fixture only\n');git('add','.');git('commit','-qm','base');git('branch','protected');
  const base=git('rev-parse','HEAD');await mkdir(join(repo,'.ai/cezar'),{recursive:true});
  await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[],worktreeRetention:0}));
  const {revision,options}=await provisionEngineering(db,principal,project,repo,2,true);
  const context=await db.createContext(principal,project,randomUUID());await new Capacity(db).assignPolicy(principal,context,revision);
  await new Templates(db).publish(principal,context,0,{workflow:'engineering-synthetic-v1',qualityRevision:options.qualityRevision!,targetRef:options.targetRef!});
  const authority=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,
   action:'plan.start',payload:{workflow:'engineering-synthetic-v1',messageRef:'encrypted:completed-recovery'}},authority,'api');
  const marker=join(repo,'completed-marker.json');configPath=join(repo,'controller-fixture.json');
  await writeFile(configPath,JSON.stringify({scope:'isolated-completed-node-recovery',repo,project,intent,authority,marker,stopNode,
   verifierKey:Buffer.from(options.verifierKey).toString('base64'),qualityRevision:options.qualityRevision}),{mode:0o600});
  child=spawn(process.execPath,['--import','tsx','tests/fixtures/interrupted-completed-node.ts',configPath],{stdio:['ignore','pipe','pipe']});
  let output='';child.stdout?.on('data',b=>{output=(output+String(b)).slice(-3000);});child.stderr?.on('data',b=>{output=(output+String(b)).slice(-3000);});
  const closed=new Promise<void>((ok,fail)=>{child!.once('close',()=>ok());child!.once('error',fail);});
  let saved=false;
  for(let i=0;i<150;i++){
   try{saved=JSON.parse(await readFile(marker,'utf8')).ready;}catch{}
   if(saved)break;if(child.exitCode!==null)throw Error('CHILD_EXITED '+output);
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert(saved,'completed stage marker missing '+output);child.kill('SIGKILL');await closed;
  const before=(await db.pool.query('SELECT id,node_id,session_id FROM ac_stage_operations WHERE intent_id=$1 ORDER BY id',[intent.id])).rows;
  if(stopNode==='qa-wait-capacity'){
   const account=(await db.pool.query("SELECT account_id FROM ac_capacity_grants WHERE intent_id=$1 AND role='programmer'",[intent.id])).rows[0].account_id;
   await new Capacity(db).observeQuota(principal,account,{status:'available',source:'synthetic://resumed-wait',ttlSeconds:3600});
  }
  await db.pause(principal,context,true);await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);
  const successor=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
  const cas=options.git.cas.bind(options.git);let casCalls=0;
  options.git.cas=async(...args)=>{casCalls++;return cas(...args);};
  runtime=new CezarRuntime(db,repo,project,options);await runtime.start();
  assert.equal(runtime.store.getRun(intent.run_id)?.status,'waiting');
  await runtime.recoverManaged(successor);assert.equal(runtime.store.getRun(intent.run_id)?.status,'waiting');
  assert.deepEqual((await db.pool.query('SELECT id,node_id,session_id FROM ac_stage_operations WHERE intent_id=$1 ORDER BY id',[intent.id])).rows,before);
  await db.pause(principal,context,false);await new Promise(resolve=>setTimeout(resolve,1050));await runtime.recoverManaged(successor);
  if(stopNode==='integrate-before-cas'){
   assert.equal(runtime.store.getRun(intent.run_id)?.status,'waiting');assert.equal(git('rev-parse','protected'),base);
   const uncertain=(await db.pool.query('SELECT x.state FROM ac_integration_intents x JOIN ac_artifacts a ON a.id=x.artifact_id WHERE a.intent_id=$1',[intent.id])).rows[0];
   assert.equal(uncertain.state,'uncertain');assert.equal(casCalls,0,'an unchanged ref cannot authorize a blind replay of CAS');
   return;
  }
  let done=false;
  for(let i=0;i<160;i++){
   const run=runtime.store.getRun(intent.run_id);if(run?.status==='failed')throw Error('REPLAY_FAILED '+run.error);
   if(run&&['review','done'].includes(run.status)){done=true;break;}
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert(done,'graph did not resume '+JSON.stringify(runtime.store.getRun(intent.run_id)));
  const after=(await db.pool.query('SELECT id,node_id,session_id,state FROM ac_stage_operations WHERE intent_id=$1',[intent.id])).rows;
  assert.equal(after.length,5);assert(after.every(stage=>stage.state==='completed'));
  for(const stage of before)assert(after.some(later=>later.id===stage.id&&later.session_id===stage.session_id),'completed stage must retain its identity');
  assert.equal((await db.pool.query('SELECT count(*) n FROM ac_capacity_grants WHERE intent_id=$1',[intent.id])).rows[0].n,'5');
  assert.equal((await db.pool.query('SELECT count(*) n FROM ac_integration_intents x JOIN ac_artifacts a ON a.id=x.artifact_id WHERE a.intent_id=$1',[intent.id])).rows[0].n,'1');
  const receipt=(await db.pool.query('SELECT receipt FROM ac_operations WHERE id=$1',[intent.operation_id])).rows[0].receipt;
  assert.equal(git('rev-parse','protected'),receipt.commit);assert.equal(git('rev-parse','main'),base);
  assert.equal(casCalls,['integrate','integrate-after-cas'].includes(stopNode)?0:1,'terminal integration replay must not execute CAS again');
 }finally{if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await runtime?.close();await db.close();if(configPath)await rm(configPath,{force:true});}
});
