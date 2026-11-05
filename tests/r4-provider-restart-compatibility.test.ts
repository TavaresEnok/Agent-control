import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {ProviderCollectors,type ProviderAdapter} from '../src/providers.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';

const execute=promisify(execFile);
async function setup(label:string){
 const url=process.env.AC_TEST_DATABASE_URL;if(!url?.endsWith('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(url,label),db=new Ledger(isolated.url),folder=await mkdtemp(join(tmpdir(),'ac-r4-provider-restart-'));
 try{
 await db.migrate();const project=randomUUID(),principal='r4-restart-'+randomUUID();
 await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'R4 synthetic restart protocol']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
 const provision=await provisionCapacity(db,principal,project),account=(await db.pool.query('SELECT id FROM ac_accounts')).rows[0].id;
 const context=await db.createContext(principal,project,randomUUID());await provision.service.assignPolicy(principal,context,provision.revision);
 const authority=await db.acquire(principal,context,randomUUID(),'r4-manager',60);
 const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:r4-preserved'}},authority,'api');
 const counter=join(folder,'probe-effects.ndjson'),descriptor=join(folder,'child.json');await writeFile(counter,'',{mode:0o600});
 const adapter=(version:string):ProviderAdapter=>({manifest:{id:'r4-restart-fixture',version,provider:'synthetic',mode:'synthetic',eligibility:'documented_supported',source:'synthetic://r4-restart-contract',timeoutMs:30},probe:async()=>{throw Error('PARENT_PROBE_MUST_NOT_RUN');}});
 const bind=async(version:string,revision:number)=>new ProviderCollectors(db,[adapter(version)]).bind(principal,project,{accountId:account,adapterId:'r4-restart-fixture',expectedRevision:revision,minimumIntervalSeconds:3600});
 const child=async(mode:string,version='v1',observation=randomUUID(),crash=false)=>{
  await writeFile(descriptor,JSON.stringify({url:isolated.url,principal,project,account,counter,version,mode,observation}),{mode:0o600});
  const promise=execute(process.execPath,['--import','tsx','tests/fixtures/r4-provider-restart-child.ts',descriptor],{cwd:process.cwd(),timeout:15000,maxBuffer:32768,env:{HOME:folder,PATH:'/tmp/node-v22.23.3-linux-x64/bin:/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC'}});
  if(crash){await assert.rejects(promise,error=>{assert.equal((error as {code:number}).code,17);return true;});return undefined;}
  const output=await promise;assert.equal(output.stderr,'');return JSON.parse(output.stdout.trim());
 };
 const effects=async()=>{const text=await readFile(counter,'utf8');return text.trim()?text.trim().split('\n').map(line=>JSON.parse(line)):[];};
 const age=async()=>db.pool.query("UPDATE ac_provider_bindings SET last_started_at=clock_timestamp()-interval '3601 seconds' WHERE account_id=$1",[account]);
 const reserve=()=>provision.service.reserve(principal,{attemptId:randomUUID(),intentId:intent.id,contextId:context,role:'programmer'},authority);
 const state=async()=>({intents:(await db.pool.query('SELECT id,context_id,command,state FROM ac_intents ORDER BY id')).rows,paused:(await db.pool.query('SELECT paused FROM ac_contexts WHERE id=$1',[context])).rows[0].paused});
 const noWorkers=async()=>{assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_operations WHERE state<>'registered' OR handle IS NOT NULL OR receipt IS NOT NULL")).rows[0].n,0);for(const table of ['ac_native_execution_jobs','ac_native_planning_jobs'])assert.equal((await db.pool.query('SELECT count(*)::int n FROM '+table)).rows[0].n,0);};
 return {db,isolated,folder,bind,child,effects,age,reserve,state,noWorkers,account,project,principal,provision,context,authority,intent,close:async()=>{await db.close();await isolated.close();await rm(folder,{recursive:true,force:true});}};
 }catch(error){await db.close();await isolated.close();await rm(folder,{recursive:true,force:true});throw error;}
}

test('RF21 finite effect count persists across collector process restarts under failure and uncertain teardown',{timeout:120000},async()=>{
 const f=await setup('r4retry');
 try{
  await f.bind('v1',0);const original=await f.state();
  assert.equal((await f.child('throw')).status,'unreachable');
  for(let i=0;i<4;i++)assert.equal((await f.child('throw')).code,'PROVIDER_PROBE_THROTTLED');
  assert.equal((await f.effects()).length,1,'process restart cannot reset durable interval');
  await assert.rejects(f.reserve(),/NO_ELIGIBLE_CAPACITY/);
  for(let window=0;window<3;window++){await f.age();assert.equal((await f.child('throw')).status,'unreachable');assert.equal((await f.child('throw')).code,'PROVIDER_PROBE_THROTTLED');}
  assert.equal((await f.effects()).length,4,'one read-only probe in each explicitly aged interval, no immediate retry loop');
  await f.age();assert.equal((await f.child('timeout')).status,'unreachable');
  await f.age();for(let i=0;i<3;i++)assert.equal((await f.child('available')).code,'PROVIDER_PROBE_UNCERTAIN');
  assert.equal((await f.effects()).length,5,'unconfirmed timeout must survive restart as quarantine');
  await assert.rejects(f.reserve(),/NO_ELIGIBLE_CAPACITY/);assert.deepEqual(await f.state(),original);await f.noWorkers();
  console.log(JSON.stringify({scope:'collector-only',restarts:15,transportFailureEffects:4,timeoutEffects:1,afterQuarantineEffects:0,inferenceEffects:0,workPreserved:true,unboundedLifetimeBudgetClaim:false}));
 }finally{await f.close();}
});

test('RF21 crashed collector with expired lease cannot restart a second effect',{timeout:60000},async()=>{
 const f=await setup('r4retrycrash');try{
  await f.bind('v1',0);const original=await f.state();await f.child('crash','v1',randomUUID(),true);
  await f.db.pool.query("UPDATE ac_provider_bindings SET lease_until=clock_timestamp()-interval '1 second',last_started_at=clock_timestamp()-interval '3601 seconds' WHERE account_id=$1",[f.account]);
  for(let i=0;i<3;i++)assert.equal((await f.child('available')).code,'PROVIDER_PROBE_UNCERTAIN');
  assert.equal((await f.effects()).length,1);await assert.rejects(f.reserve(),/NO_ELIGIBLE_CAPACITY/);assert.deepEqual(await f.state(),original);await f.noWorkers();
 }finally{await f.close();}
});

test('RNF13 T26 synthetic registry old/new incompatible and expired-auth transitions preserve pending work',{timeout:90000},async()=>{
 const f=await setup('r4compat');try{
  await f.bind('v1',0);const original=await f.state();assert.equal((await f.child('available')).status,'available');
  assert.equal((await f.child('available','v2')).code,'PROVIDER_ADAPTER_VERSION_CHANGED');assert.equal((await f.effects()).length,1);
  await f.bind('v2',1);await assert.rejects(f.reserve(),/NO_ELIGIBLE_CAPACITY/);
  await f.age();assert.equal((await f.child('incompatible','v2')).status,'unknown');await assert.rejects(f.reserve(),/NO_ELIGIBLE_CAPACITY/);
  await f.age();assert.equal((await f.child('auth','v2')).status,'auth_required');await assert.rejects(f.reserve(),/NO_ELIGIBLE_CAPACITY/);
  assert.equal((await f.db.pool.query('SELECT status FROM ac_quota_observations WHERE account_id=$1',[f.account])).rows[0].status,'auth_required');
  await f.age();assert.equal((await f.child('available','v2')).status,'available');
  const grant=await f.reserve();await f.provision.service.transition(f.principal,grant.id,f.authority,'released',{state:'not_started',processId:'r4-no-worker-started'});
  await assert.rejects(f.provision.service.addProfile(f.principal,f.project,{id:randomUUID(),accountId:f.account,model:'unconfirmed-new-model',effort:'medium',role:'programmer'}),/MODEL_EFFORT_NOT_IN_CATALOG/);
  assert.deepEqual(await f.state(),original);await f.noWorkers();assert.deepEqual((await f.effects()).map(row=>row.version),['v1','v2','v2','v2']);
  console.log(JSON.stringify({scope:'synthetic-collector-registry-and-real-capacity',oldVersion:'v1',newVersion:'v2',incompatible:'unknown',authExpired:'auth_required',inferenceEffects:0,workPreserved:true,officialCliProtocolPromotionProven:false}));
 }finally{await f.close();}
});
