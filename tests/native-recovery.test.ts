import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync,spawn,type ChildProcess} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {IsolatedImplementation} from '../src/isolated-implementation.ts';
import {SandboxClient} from '../src/sandbox-client.ts';
import {Capacity} from '../src/capacity.ts';
import {Templates} from '../src/templates.ts';
import {provisionEngineering} from './fixtures/provision-engineering.ts';
import type {Command} from '../src/contracts.ts';

class CountStarts extends SandboxClient{
 starts=0;
 override async perform(...args:Parameters<SandboxClient['perform']>){if(args[0]==='start'&&args[4]?.profile==='synthetic-implementation-v1')this.starts++;return super.perform(...args);}
}
for(const boundary of ['implementation','qa-physical'])test(`native Cezar graph resumes after SIGKILL at ${boundary}, preserving pause`,
 {timeout:60000,skip:!process.env.AC_SANDBOX_DATABASE_URL},async()=>{
 const url=process.env.AC_SANDBOX_DATABASE_URL!;
 if(!url.endsWith('/ac_sandbox_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();
 const project=randomUUID(),principal='native-recovery-'+randomUUID();
 await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Native graph recovery']);
 await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
 await mkdir('.state/projects',{recursive:true});const repo=await mkdtemp(resolve('.state/projects/ac-native-recovery-'));
 const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
 git('init','-q','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','Synthetic fixture');
 await writeFile(join(repo,'README.md'),'Native recovery fixture\n');git('add','.');git('commit','-qm','base');git('branch','protected');
 const base=git('rev-parse','HEAD');await mkdir(join(repo,'.ai/cezar'),{recursive:true});
 await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[],worktreeRetention:0}));
 const {revision,options}=await provisionEngineering(db,principal,project,repo,2,true);
 const context=await db.createContext(principal,project,randomUUID());await new Capacity(db).assignPolicy(principal,context,revision);
 await new Templates(db).publish(principal,context,0,{workflow:'engineering-synthetic-v1',qualityRevision:options.qualityRevision!,targetRef:options.targetRef!});
 const authority=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
 const command:Command={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,
  action:'plan.start',payload:{workflow:'engineering-synthetic-v1',messageRef:'encrypted:native-recovery'}};
 const intent=await db.accept(principal,command,authority,'api');
 const marker=join(repo,'physical-complete.json'),configPath=join(repo,'controller-fixture.json');
 await writeFile(configPath,JSON.stringify({scope:'isolated-native-recovery',repo,project,intent,authority,marker,
  verifierKey:Buffer.from(options.verifierKey).toString('base64'),qualityRevision:options.qualityRevision,stopAfterVerifier:boundary==='qa-physical'}),{mode:0o600});
 let child:ChildProcess|undefined,runtime:CezarRuntime|undefined,output='';
 try{
  child=spawn(process.execPath,['--import','tsx','tests/fixtures/interrupted-engineering.ts',configPath],{stdio:['ignore','pipe','pipe']});
  child.stdout?.on('data',b=>{output=(output+String(b)).slice(-4000);});child.stderr?.on('data',b=>{output=(output+String(b)).slice(-4000);});
  const closed=new Promise<void>((ok,fail)=>{child!.once('close',()=>ok());child!.once('error',fail);});
  let physical=false;
  for(let i=0;i<150;i++){
   try{physical=JSON.parse(await readFile(marker,'utf8')).physicalComplete;}catch{}
   if(physical)break;if(child.exitCode!==null)throw Error('FIXTURE_EXITED '+output);
   await new Promise(r=>setTimeout(r,100));
  }
  assert(physical,'physical result marker missing '+output);
  child.kill('SIGKILL');await closed;
  await db.pause(principal,context,true);
  await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);
  const successor=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60),client=new CountStarts();
  runtime=new CezarRuntime(db,repo,project,options,new IsolatedImplementation(db,client));await runtime.start();
  assert.equal(runtime.store.getRun(intent.run_id)?.status,'waiting');
  await runtime.recoverManaged(successor);
  assert.equal(runtime.store.getRun(intent.run_id)?.status,'waiting','human pause survives physical reconciliation');
  assert.equal((await db.pool.query('SELECT count(*) n FROM ac_stage_operations WHERE intent_id=$1',[intent.id])).rows[0].n,boundary==='qa-physical'?'1':'0');
  await db.pause(principal,context,false);await new Promise(r=>setTimeout(r,1050));await runtime.recoverManaged(successor);
  let done=false;
  for(let i=0;i<200;i++){
   const run=runtime.store.getRun(intent.run_id);
   if(run?.status==='failed')throw Error('RECOVERED_DAG_FAILED '+JSON.stringify({error:run.error,steps:run.steps}));
   if(run&&['review','done'].includes(run.status)){done=true;break;}
   await new Promise(r=>setTimeout(r,100));
  }
  assert(done,'native graph did not finish '+JSON.stringify(runtime.store.getRun(intent.run_id)));
  const operation=(await db.pool.query('SELECT * FROM ac_operations WHERE id=$1',[intent.operation_id])).rows[0];
  assert.equal(git('rev-parse','protected'),operation.receipt.commit);assert.equal(git('rev-parse','main'),base);
  assert.equal(client.starts,0,'replayed implementation must not launch another container');
  const stages=(await db.pool.query('SELECT node_id,state FROM ac_stage_operations WHERE intent_id=$1 ORDER BY node_id',[intent.id])).rows;
  assert.deepEqual(stages.map(s=>s.node_id),['integrate','judge','qa','review','review']);assert(stages.every(s=>s.state==='completed'));
  await writeFile(`docs/validation/evidence/native-graph-recovery-${boundary}.json`,JSON.stringify({result:'passed',synthetic:true,controllerSignal:'SIGKILL',
   pausePreserved:true,physicalLaunches:1,recoveryLaunches:client.starts,stages:stages.map(s=>s.node_id),
   boundary,limitation:'Recovery covers the specified synthetic physical receipt boundary; missing verifier output, active old writers and real providers remain unverified.'},null,2)+'\n');
 }finally{if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await runtime?.close();await db.close();await rm(configPath,{force:true});}
});
