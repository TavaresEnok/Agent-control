import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,stat,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApi} from '../src/api.ts';
import type {CezarRuntime} from '../src/cezar.ts';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {configureCodexQuotaRegistry} from '../src/codex-quota-registry.ts';
import {codexReadonlyIdentity} from '../src/codex-readonly-quota-source.ts';
import {CodexQuotaDockerSupervisor} from '../src/codex-quota-supervisor.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
test('R3 quota durable container fixture, exact protocol, identity, unavailable and restart reconciliation',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL,image=process.env.AC_R3_QUOTA_IMAGE;
 assert(url);assert(image);assert(url.endsWith('/ac_implementation_test'));assert(image.startsWith('sha256:'));
 const isolated=await isolatedDatabase(url,'r3_quota'),db=new Ledger(isolated.url),home=await mkdtemp(join(tmpdir(),'ac-r3-quota-'));
 try{
  await db.migrate();const project=randomUUID(),account=randomUUID(),principal='r3-quota-owner';
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'R3 disposable quota']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const subjectDigest=codexReadonlyIdentity({type:'chatgpt',email:'fixture@example.invalid',accountId:'subject'})!;
  await new Capacity(db).addAccount(principal,project,{id:account,provider:'codex',label:'R3 synthetic metadata',resourceIdentity:'codex:'+subjectDigest,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://r3-quota',maxConcurrent:1});
  const info=await stat(home,{bigint:true}),binding={accountId:account,subjectDigest,home,device:String(info.dev),inode:String(info.ino),uid:String(info.uid)};
  const dormant=randomUUID(),dormantBinding={...binding,accountId:dormant,subjectDigest:'a'.repeat(64)};
  await new Capacity(db).addAccount(principal,project,{id:dormant,provider:'codex',label:'Dormant metadata only',resourceIdentity:'codex:'+dormantBinding.subjectDigest,mode:'subscription_cli',eligibility:'not_assessed',eligibilitySource:'synthetic://r3-not-assessed',maxConcurrent:1});
  const dormantRegistry=await configureCodexQuotaRegistry(db,{state:'configured-inactive',bindings:[dormantBinding]});assert.equal(dormantRegistry.adapters.length,0);
  await assert.rejects(configureCodexQuotaRegistry(db,{state:'lab-synthetic',contract:'ac-r3-quota-disposable-v1',bindings:[dormantBinding],image,timeoutMs:1000}),/QUOTA_REAL_ACTIVATION_BLOCKED/);
  assert.equal((await db.pool.query('SELECT enabled FROM ac_accounts WHERE id=$1',[dormant])).rows[0].enabled,false);
  const inactive=await configureCodexQuotaRegistry(db,{state:'configured-inactive',bindings:[binding]});assert.equal(inactive.adapters.length,0);assert.equal(inactive.report.realActivation,'blocked');
  const config={state:'lab-synthetic' as const,contract:'ac-r3-quota-disposable-v1' as const,bindings:[binding],image,timeoutMs:1000};
  const registry=await configureCodexQuotaRegistry(db,config);
  await registry.collectors.bind(principal,project,{accountId:account,adapterId:registry.adapters[0].manifest.id,expectedRevision:0,minimumIntervalSeconds:1});
  const app=createApi(db,{projectId:project,nativeExecutionReady:false} as CezarRuntime,async req=>req.headers.get('authorization')==='Bearer r3-owner'?principal:null,()=>undefined,undefined,undefined,undefined,undefined,registry.adapters,undefined,undefined,undefined,registry);
  assert.equal((await app.request('/api/v1/ac/quota-registry')).status,401);
  const report=await app.request('/api/v1/ac/quota-registry',{headers:{authorization:'Bearer r3-owner'}});
  assert.equal(report.status,200);assert.deepEqual(await report.json(),{...registry.report,registered:1});
  const collect=async(mode:string)=>{
   await writeFile(join(home,'fixture.json'),JSON.stringify({mode,resetsAt:Math.floor(Date.now()/1000)+3600}));
   await db.pool.query("UPDATE ac_provider_bindings SET last_started_at=clock_timestamp()-interval '2 seconds' WHERE account_id=$1",[account]);
   const response=await app.request('/api/v1/ac/quota/'+account+'/collect',{method:'POST',headers:{authorization:'Bearer r3-owner','content-type':'application/json'},body:JSON.stringify({observationId:randomUUID()})});assert.equal(response.status,200);return await response.json() as {snapshot:{status:string}};
  };
  assert.equal((await collect('valid')).snapshot.status,'available');
  const trace=(await readFile(join(home,'trace'),'utf8')).trim().split('\n').map(x=>JSON.parse(x));
  assert.deepEqual(trace.slice(1).map(x=>x.method),['initialize','initialized','account/read','account/rateLimits/read']);
  assert.deepEqual(trace[3].params,{refreshToken:false});
  assert.equal((await db.pool.query('SELECT status FROM ac_quota_observations WHERE account_id=$1',[account])).rows[0].status,'available');
  assert.equal((await collect('hang')).snapshot.status,'unknown');
  assert.equal((await collect('auth')).snapshot.status,'auth_required');
  assert.equal((await collect('malformed')).snapshot.status,'unknown');
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_readonly_quota_runs WHERE state='uncertain'")).rows[0].n,0);
  // A separate controller dies after the container has a setsid descendant.
  await rm(join(home,'trace'),{force:true});
  await writeFile(join(home,'fixture.json'),JSON.stringify({mode:'escaped'}));
  const controller=spawn(process.execPath,['--import','tsx','tests/fixtures/r3-quota-controller.ts',isolated.url,home,account,subjectDigest,image],{stdio:['ignore','pipe','pipe']});
  controller.stderr.resume();await once(controller.stdout,'data');
  for(let i=0;i<100;i++){if(await readFile(join(home,'escaped'),'utf8').catch(()=>''))break;await new Promise(r=>setTimeout(r,20));}
  assert(Number(await readFile(join(home,'escaped'),'utf8'))>1);
  const pending=(await db.pool.query("SELECT * FROM ac_readonly_quota_runs WHERE state='uncertain'")).rows[0];assert(pending.resource_id);
  const docker=promisify(execFile);
  const before=JSON.parse((await docker('docker',['inspect',pending.resource_id])).stdout)[0];assert.equal(before.State.Running,true);
  const top=(await docker('docker',['top',pending.resource_id,'-eo','pid,ppid,args'])).stdout;assert(top.trim().split('\n').length>=3);
  controller.kill('SIGKILL');await once(controller,'exit');
  assert.equal(JSON.parse((await docker('docker',['inspect',pending.resource_id])).stdout)[0].State.Running,true);
  const restarted=new CodexQuotaDockerSupervisor(db,binding,image);
  // A second controller startup must not destroy a healthy collector's live lease.
  await db.pool.query("UPDATE ac_provider_bindings SET lease_id=$2,lease_until=clock_timestamp()+interval '30 seconds' WHERE account_id=$1",[account,randomUUID()]);
  assert.equal(await restarted.reconcile(pending.id),false);
  await db.pool.query("UPDATE ac_provider_bindings SET lease_until=clock_timestamp()-interval '1 second' WHERE account_id=$1",[account]);
  assert.equal(await restarted.reconcile(pending.id),true);
  await assert.rejects(docker('docker',['inspect',pending.resource_id]));
  assert.equal((await collect('valid')).snapshot.status,'available');
  // Unknown create ACK and no physical resource cannot prove absence of a pending create.
  const uncertain=randomUUID();await db.pool.query("INSERT INTO ac_readonly_quota_runs(id,account_id,resource_name,subject_digest,state) VALUES($1,$2,$3,$4,'uncertain')",[uncertain,account,'ac-r3-quota-'+uncertain,subjectDigest]);
  assert.equal(await restarted.reconcile(uncertain),false);
  assert.equal((await collect('valid')).snapshot.status,'unknown');
  assert.equal((await db.pool.query('SELECT state FROM ac_readonly_quota_runs WHERE id=$1',[uncertain])).rows[0].state,'uncertain');
 }finally{await db.close();await isolated.close();await rm(home,{recursive:true,force:true});}
});
