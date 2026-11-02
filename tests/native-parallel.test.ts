import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {Capacity} from '../src/capacity.ts';
import {Templates} from '../src/templates.ts';
import {provisionEngineering} from './fixtures/provision-engineering.ts';

test('three admitted native workflows progress beyond standalone cap while PG still limits workers',{timeout:20000},async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url?.endsWith('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();let runtime:CezarRuntime|undefined;
 let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
 try{
  const principal='parallel-'+randomUUID(),project=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Native flow budget fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await mkdir('.state/projects',{recursive:true});const repo=await mkdtemp(resolve('.state/projects/ac-parallel-'));
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
  git('init','-q','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','Synthetic fixture');
  await writeFile(join(repo,'README.md'),'Parallel fixture only\n');git('add','.');git('commit','-qm','base');git('branch','protected');
  await mkdir(join(repo,'.ai/cezar'),{recursive:true});await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[],worktreeRetention:0}));
  const {revision,options}=await provisionEngineering(db,principal,project,repo,1,false);
  runtime=new CezarRuntime(db,repo,project,options);await runtime.start();
  const original=runtime.recordReceipt.bind(runtime);let receipts=0;
  runtime.recordReceipt=async(...args)=>{await original(...args);receipts++;await barrier;await db.pause(principal,args[1].contextId,true);};
  const intents=[];
  for(let i=0;i<3;i++){
   const context=await db.createContext(principal,project,randomUUID());await new Capacity(db).assignPolicy(principal,context,revision);
   await new Templates(db).publish(principal,context,0,{workflow:'engineering-synthetic-v1',qualityRevision:options.qualityRevision!,targetRef:options.targetRef!});
   const authority=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
   const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',
    payload:{workflow:'engineering-synthetic-v1',messageRef:'encrypted:parallel-fixture'}},authority,'api');
   intents.push({intent,authority});await runtime.dispatch(intent,authority);
  }
  for(let i=0;i<80&&receipts<3;i++)await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(receipts,3,'standalone two-flow ceiling must not strand the third admitted task');
  release();
  for(let i=0;i<80;i++){
   if(intents.every(({intent})=>runtime!.store.getRun(intent.run_id)?.status==='waiting'))break;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert(intents.every(({intent})=>runtime!.store.getRun(intent.run_id)?.status==='waiting'));
  assert.equal((await db.pool.query('SELECT count(*) n FROM ac_stage_operations s JOIN ac_intents i ON i.id=s.intent_id WHERE i.context_id=ANY($1::uuid[])',[intents.map(v=>v.authority.contextId)])).rows[0].n,'0');
  for(const {intent,authority} of intents){
   await db.pool.query('INSERT INTO ac_plan_cancellations(intent_id,context_id,requested_by,plan_revision) VALUES($1,$2,$3,$4)',[intent.id,authority.contextId,principal,intent.plan_revision]);
   await runtime.reconcileCancellations(authority);
  }
  assert.equal(git('rev-parse','protected'),git('rev-parse','main'));
 }finally{release();await runtime?.close();await db.close();}
});
