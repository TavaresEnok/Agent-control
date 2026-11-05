import {installGraphAllocator} from './fixtures/r2-graph-allocator.ts';
import {cleanupGraphFixture,readGraphManifest} from './fixtures/native-graph-cleanup.ts';
import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash,createHmac,createPublicKey,verify} from 'node:crypto';
import {lstat,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import pg from 'pg';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {ProviderEligibility} from '../src/provider-eligibility.ts';
import {AccountHomes} from '../src/account-homes.ts';
import {NativeExecutionSupervisor} from '../src/native-execution-supervisor.ts';
import {NativeImplementation} from '../src/native-implementation.ts';
import {NativeVerification} from '../src/native-verification.ts';
import {NativeQa,NativeQaContract,nativeQaContractDigest} from '../src/native-qa.ts';
import {DockerDaemon} from '../src/sandbox-broker.ts';
import {Quality,VerificationReceipt} from '../src/quality.ts';
import {GitArtifacts} from '../src/git.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {canonical,digest,Refusal} from '../src/contracts.ts';

test('synthetic native graph resumes after controller SIGKILL at retired programmer boundary', {timeout:120000,skip:!(process.env.AC_TEST_DATABASE_URL&&process.env.AC_TEAM_GRAPH_IMAGE&&process.env.AC_TEAM_GRAPH_NETWORK)},async()=>{
 const root=await mkdtemp(join(tmpdir(),'ac-graph-kill-')),marker=join(root,'marker.json'),initial=join(root,'initial.json');let info:any,db:Ledger|undefined,runtime:CezarRuntime|undefined,primary:unknown,heartbeat:ReturnType<typeof setInterval>|undefined;
 const childEnv:NodeJS.ProcessEnv={...process.env,AC_TEAM_GRAPH_CRASH_MARKER:marker,AC_TEAM_GRAPH_INITIAL_MANIFEST:initial};delete childEnv.NODE_TEST_CONTEXT;
 const child=spawn(process.execPath,['--import','tsx','tests/r2-graph-physical.test.ts'],{env:childEnv,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',x=>output+=String(x));child.stderr.on('data',x=>output+=String(x));
 const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
 try{
  installGraphAllocator();
  for(let i=0;i<400;i++){try{info=JSON.parse(await readFile(marker,'utf8'));break;}catch{}if(child.exitCode!==null)throw Error('CHILD_FAILED '+output);await new Promise(r=>setTimeout(r,100));}
  assert(info,'SIGKILL marker missing '+output);const manifest=await readGraphManifest(initial,root);assert.equal(info.url,manifest.url);assert.equal(info.area,manifest.area);child.kill('SIGKILL');await closed;assert.equal(child.signalCode,'SIGKILL');
  db=new Ledger(info.url);await db.pause(info.principal,info.context,true);await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[info.context]);
  const next=await db.acquire(info.principal,info.context,randomUUID(),'fixture-manager',60);heartbeat=setInterval(()=>{void db!.heartbeat(next).catch(()=>{});},5000);await assert.rejects(db.tx(c=>db!.fence(c,info.authority)),/STALE_MANAGER/);
  const supervisor=new NativeExecutionSupervisor(db,info.supervisorConfig),quality=new Quality(db,Buffer.from(info.verifierKey,'base64'),new GitArtifacts(info.repo));
  mock.method(ProviderEligibility.prototype,'view',async()=>({accountId:info.account,latest:{fresh:true,effectiveStatus:'documented_supported',provider:'codex',authenticationMode:'subscription_oauth',executionMode:'central_isolated_cli',adapterId:info.supervisorConfig.id,adapterVersion:supervisor.executorDigest,revision:1},history:[]}));
  mock.method(AccountHomes.prototype,'inspectGranted',async()=>({accountId:info.account,projectId:info.project,ownerId:info.principal,uid:'1',device:'1',inode:'1'}));
  const reserve=Capacity.prototype.reserve;mock.method(Capacity.prototype,'reserve',async function(this:Capacity,...args:Parameters<Capacity['reserve']>){try{await db!.pool.query("UPDATE ac_accounts SET mode='synthetic' WHERE id=$1",[info.account]);return await reserve.apply(this,args);}finally{await db!.pool.query("UPDATE ac_accounts SET mode='subscription_cli' WHERE id=$1",[info.account]);}});
  const qaContract=NativeQaContract.parse({schemaVersion:1,id:'r2-graph-check',image:process.env.AC_TEAM_GRAPH_IMAGE,argv:['/usr/local/bin/node','-e',"const fs=require('fs'),path=require('path'); const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):e.name.endsWith('.ts')?[path.join(d,e.name)]:[]); const files=walk('/work/src'); if(!files.length||files.some(f=>!fs.readFileSync(f,'utf8').startsWith('// synthetic src/')))process.exit(1); console.log('validated '+files.length+' files')"],environment:['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','NODE_VERSION=22.23.3','YARN_VERSION=1.22.22','HOME=/tmp'],timeoutMs:15000,memoryBytes:268435456,pids:64,nanoCpus:1000000000});
  assert.equal(nativeQaContractDigest(qaContract),info.qaDigest);
  const nativeQa=new NativeQa(db,quality,info.repo,join(info.area,'qa'),qaContract,Buffer.from(info.verifierKey,'base64'));
  const git=new GitArtifacts(info.repo),implementation=new NativeImplementation(db,info.repo,quality,[supervisor]),verification=new NativeVerification(db,quality,[supervisor],Buffer.from(info.verifierKey,'base64'));
  runtime=new CezarRuntime(db,info.repo,info.project,{quality,git,qualityRevision:2,targetRef:'refs/heads/protected',verifierKey:Buffer.from(info.verifierKey,'base64'),allowedTargets:['refs/heads/protected'],nativeQa,nativeVerification:verification},undefined,undefined,{nativeExecutions:[supervisor],nativeImplementation:implementation});await runtime.start();
  const parent=(await db.pool.query('SELECT * FROM ac_intents WHERE id=$1',[info.parentId])).rows[0];await runtime.recoverManaged(next);assert.equal(runtime.store.getRun(parent.run_id)?.status,'waiting');
  await db.pause(info.principal,info.context,false);let done=false;for(let i=0;i<900;i++){await runtime.recoverManaged(next);const run=runtime.store.getRun(parent.run_id);if(run?.status==='failed')throw Error('RESUME_FAILED '+JSON.stringify({error:run.error,steps:run.steps}));if(run?.status==='done'){done=true;break;}await new Promise(r=>setTimeout(r,100));}
  assert(done,'graph did not resume '+JSON.stringify({run:runtime.store.getRun(parent.run_id),jobs:(await db.pool.query('SELECT id,role,state FROM ac_native_execution_jobs')).rows,qa:(await db.pool.query('SELECT id,state FROM ac_native_qa_jobs')).rows}));const jobs=(await db.pool.query('SELECT id,role,state FROM ac_native_execution_jobs ORDER BY role')).rows;assert(jobs.filter(j=>j.role==='programmer').length>=3);assert(jobs.filter(j=>j.role==='reviewer').length>=3);assert(jobs.every(j=>j.state==='completed'));assert(jobs.some(j=>j.id===info.jobId));const writer=(await db.pool.query('SELECT state FROM ac_worktree_writers WHERE parent_intent_id=$1',[info.parentId])).rows;assert(writer.length>=3);assert(writer.every(w=>w.state==='neutralized'));const q=(await db.pool.query('SELECT state,receipt FROM ac_native_qa_jobs')).rows;assert(q.length>=3);assert(q.every(j=>j.state==='completed'&&j.receipt.exitCode===0));
  const docker=new DockerDaemon(),reviewers=(await db.pool.query(`SELECT j.id,j.worker_id,j.tools_id,j.network_id,j.receipt,j.session_id,j.grant_id,j.manager_epoch,t.state,t.binding,t.proof FROM ac_native_execution_jobs j LEFT JOIN ac_native_terminal_retirements t ON t.job_id=j.id WHERE j.role='reviewer'`)).rows;
  assert(reviewers.length>=3);for(const j of reviewers){assert.equal(j.state,'removed');assert.equal(await docker.inspect(j.worker_id),null);assert.equal(await docker.inspect(j.tools_id),null);assert.equal(await docker.inspectPrivateNetwork(j.network_id),null);
   assert.equal(j.binding.jobId,j.id);assert.equal(j.binding.grantId,j.grant_id);assert.equal(j.binding.sessionId,j.session_id);assert.equal(j.binding.epoch,Number(j.manager_epoch));assert.equal(j.binding.workerId,j.worker_id);assert.equal(j.binding.toolsId,j.tools_id);assert.equal(j.binding.networkId,j.network_id);assert.equal(j.binding.terminalDigest,digest(j.receipt));assert.deepEqual(j.proof.payload,j.binding);
   assert(verify(null,Buffer.from('agent-control:native-terminal-retirement:v1\n'+canonical(j.binding)),createPublicKey(info.supervisorConfig.signingKeyPem),Buffer.from(j.proof.signature,'hex')));
   for(const [name,key] of [['worker-terminal.log','workerLogSha256'],['tools-terminal.log','toolsLogSha256']])assert.equal(createHash('sha256').update(await readFile(join(info.supervisorConfig.hostRoot,j.id,name!))).digest('hex'),j.binding[key!]);
   assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_verification_evidence WHERE kind='review' AND grant_id=$1 AND session_id=$2",[j.grant_id,j.session_id])).rows[0].n,1);
  }
  const first=reviewers[0];await supervisor.retireTerminal(info.principal,next,first.id);const replay=(await db.pool.query('SELECT binding,proof FROM ac_native_terminal_retirements WHERE job_id=$1',[first.id])).rows[0];assert.deepEqual(replay,{binding:first.binding,proof:first.proof});
  for(const task of ['alpha','beta','gamma'])for(const file of ['a.ts','b.ts'])assert.match(execFileSync('git',['-C',info.repo,'show',`refs/heads/protected:src/${task}/${file}`],{encoding:'utf8'}),/^\/\/ synthetic src\//);
  console.log(JSON.stringify({controller:'SIGKILL',pausePreserved:true,programmerJob:info.jobId,programmerJobs:jobs.filter(j=>j.role==='programmer').length,reviewJobs:jobs.filter(j=>j.role==='reviewer').length,modelCalls:0,capacity:'substituted',qa:'native-docker'}));
 }catch(error){primary=error;}finally{
  const errors:unknown[]=[];
  try{if(heartbeat)clearInterval(heartbeat);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}mock.restoreAll();await runtime?.close();}catch(error){errors.push(error);}
  let manifest:{url:string;area:string}|undefined;
  try{manifest=await readGraphManifest(initial,root);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')errors.push(error);}
  if(manifest){try{const qaDb=db??new Ledger(manifest.url);try{const docker=new DockerDaemon();for(const j of (await qaDb.pool.query("SELECT to_regclass('ac_native_qa_jobs') AS name")).rows[0]?.name?(await qaDb.pool.query("SELECT id FROM ac_native_qa_jobs")).rows:[]){const c=await docker.inspect('ac-native-qa-'+j.id);if(c){if(c.Config.Labels['agent-control.job']!==j.id||c.Image!==process.env.AC_TEAM_GRAPH_IMAGE)throw Error('QA_IDENTITY_MISMATCH');if(c.State.Running)await docker.stop(c.Id);await docker.remove(c.Id);if(await docker.inspect(c.Id))throw Error('QA_CONTAINER_REMAINS');}}}finally{if(!db)await qaDb.close();}await cleanupGraphFixture(manifest,process.env.AC_TEAM_GRAPH_IMAGE!,db);db=undefined;}catch(error){errors.push(error);db=undefined;}}
  if(db)try{await db.close();}catch(error){errors.push(error);}
  if(!errors.length)try{await rm(root,{recursive:true,force:true});}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(primary?[primary,...errors]:errors,'NATIVE_GRAPH_CLEANUP_FAILED');
 }if(primary)throw primary;
});

