import {mock,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,createHash} from 'node:crypto';
import {symlink,chmod} from 'node:fs/promises';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFileSync,spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {NativePlanningSupervisor,nativePlanningExecutorDigest} from '../src/native-planning-supervisor.ts';
import {waitForNativeLaunch} from '../src/native-worker-gate.ts';
import {nativeContainerNeverStarted} from '../src/native-execution-isolation.ts';
import {Authority,Refusal,digest} from '../src/contracts.ts';
import {ProviderEligibility} from '../src/provider-eligibility.ts';
import {AccountHomes} from '../src/account-homes.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {IsolatedImplementation} from '../src/isolated-implementation.ts';
import {SandboxClient} from '../src/sandbox-client.ts';
import {Templates} from '../src/templates.ts';
import {provisionEngineering} from './fixtures/provision-engineering.ts';
import type {Command} from '../src/contracts.ts';

class CountStarts extends SandboxClient{
 starts=0;
 override async perform(...args:Parameters<SandboxClient['perform']>){if(args[0]==='start'&&args[4]?.profile==='synthetic-implementation-v1')this.starts++;return super.perform(...args);}
}
test('worker gate and process evidence reject partial launches and unproven starts',async()=>{
 const area=await mkdtemp(join(tmpdir(),'ac-native-gate-'));
 try{
  assert.equal(nativeContainerNeverStarted({Status:'created',Running:false,Pid:0,StartedAt:'0001-01-01T00:00:00Z'}),true);
  assert.equal(nativeContainerNeverStarted({Status:'created',Running:false,StartedAt:'0001-01-01T00:00:00Z'}),false);
  assert.equal(nativeContainerNeverStarted({Status:'running',Running:true,Pid:4242,StartedAt:'2026-11-03T00:00:00Z'}),false);
  assert.equal(nativeContainerNeverStarted({Status:'exited',Running:false,Pid:0,StartedAt:'2026-11-03T00:00:00Z'}),false);
  const launch=join(area,'launch.json');
  await assert.rejects(waitForNativeLaunch(join(area,'missing.json'),30),/WORKER_GATE_EXPIRED/);
  await writeFile(launch,'',{mode:0o600});await assert.rejects(waitForNativeLaunch(launch,30),/INVALID_WORKER_GATE/);
  await writeFile(launch,'{"ok":1}\n',{mode:0o600});await chmod(launch,0o666);await assert.rejects(waitForNativeLaunch(launch,30),/INVALID_WORKER_GATE/);
  await chmod(launch,0o600);await waitForNativeLaunch(launch,30);
  const link=join(area,'link.json');await symlink(launch,link);await assert.rejects(waitForNativeLaunch(link,30),/INVALID_WORKER_GATE/);
 }finally{await rm(area,{recursive:true,force:true});}
});

type MemoryRow=Record<string,unknown>;
class PlanningRecoveryMemory{
 tables:Record<string,MemoryRow[]>={};
 private snap:string|null=null;
 insert(table:string,row:MemoryRow){(this.tables[table]??=[]).push({...row});}
 one(table:string,id:string){const row=(this.tables[table]??[]).find(item=>item.id===id);if(!row)throw Error('MISSING_ROW');return row;}
 query(sql:string,params:unknown[]=[]){
  const text=sql.replace(/\s+/g,' ').trim();
  const selected=(rows:MemoryRow[])=>({rows,rowCount:rows.length});
  const wrote=(count:number)=>({rows:[],rowCount:count});
  if(text==='BEGIN'){this.snap=JSON.stringify(this.tables);return selected([]);}
  if(text==='COMMIT'){this.snap=null;return selected([]);}
  if(text==='ROLLBACK'){if(this.snap!==null)this.tables=JSON.parse(this.snap);this.snap=null;return selected([]);}
  if(text.startsWith('SELECT x.*,m.role FROM ac_contexts')){
   const context=this.tables.ac_contexts?.find(row=>row.id===params[0]&&!row.archived);
   const member=this.tables.ac_memberships?.find(row=>row.project_id===context?.project_id&&row.principal_id===params[1]);
   return context&&member?selected([{...context,role:member.role}]):selected([]);
  }
  if(text.startsWith('SELECT x.paused,m.epoch FROM ac_contexts')){
   const context=this.tables.ac_contexts?.find(row=>row.id===params[0]);
   const manager=this.tables.ac_managers?.find(row=>row.context_id===params[0]&&row.instance_id===params[1]&&Number(row.epoch)===Number(params[2])&&Number(row.lease_until)>Date.now());
   return context&&manager?selected([{paused:Boolean(context.paused),epoch:manager.epoch}]):selected([]);
  }
  if(text.startsWith('SELECT enabled FROM ac_admission_control'))return selected((this.tables.ac_admission_control??[]).filter(row=>row.id===(params[0]??1)));
  if(text.startsWith('SELECT 1 FROM ac_intents WHERE id=$1 AND context_id=$2')){
   const intent=this.tables.ac_intents?.find(row=>row.id===params[0]&&row.context_id===params[1]);
   return intent?selected([{one:1}]):selected([]);
  }
  if(text.startsWith('SELECT instance_id FROM ac_managers')){
   const manager=this.tables.ac_managers?.find(row=>row.context_id===params[0]&&Number(row.epoch)===Number(params[1]));
   return manager?selected([{instance_id:manager.instance_id}]):selected([]);
  }
  if(text.startsWith('SELECT id FROM ac_native_planning_jobs WHERE id=$1')){
   const job=this.tables.ac_native_planning_jobs?.find(row=>row.id===params[0]);
   return job?selected([{id:job.id}]):selected([]);
  }
  if(text.includes('profile_role')){
   const grant=this.tables.ac_capacity_grants?.find(row=>row.id===params[0]);
   const account=this.tables.ac_accounts?.find(row=>row.id===grant?.account_id);
   const profile=this.tables.ac_profiles?.find(row=>row.id===grant?.profile_id);
   const intent=this.tables.ac_intents?.find(row=>row.id===grant?.intent_id);
   if(!grant||!account||!profile||!intent)return selected([]);
   return selected([{...grant,provider:account.provider,mode:account.mode,account_enabled:account.enabled,eligibility:account.eligibility,resource_identity:account.resource_identity,profile_enabled:profile.enabled,model:profile.model,effort:profile.effort,profile_role:profile.role,principal_id:intent.principal_id}]);
  }
  if(text.includes('q.expires_at>clock_timestamp() fresh')){
   const grant=this.tables.ac_capacity_grants?.find(row=>row.id===params[0]&&Number(row.manager_epoch)===Number(params[1]));
   const account=this.tables.ac_accounts?.find(row=>row.id===grant?.account_id);
   const profile=this.tables.ac_profiles?.find(row=>row.id===grant?.profile_id);
   if(!grant||!account||!profile)return selected([]);
   return selected([{state:grant.state,account_enabled:account.enabled,profile_enabled:profile.enabled,status:'available',fresh:true}]);
  }
  if(text.startsWith('INSERT INTO ac_native_planning_jobs')){
   this.insert('ac_native_planning_jobs',{id:params[0],grant_id:params[1],context_id:params[2],input_digest:params[3],launch_digest:params[4],container_name:params[5],container_id:null,state:'uncertain',receipt:null});
   return wrote(1);
  }
  if(text.includes('j.state job_state')){
   const call=this.tables.ac_semantic_planning_calls?.find(row=>row.id===params[0]&&row.context_id===params[1]);
   const job=this.tables.ac_native_planning_jobs?.find(row=>row.id===call?.id&&row.grant_id===call?.grant_id);
   const grant=this.tables.ac_capacity_grants?.find(row=>row.id===call?.grant_id);
   const profile=this.tables.ac_profiles?.find(row=>row.id===grant?.profile_id);
   const account=this.tables.ac_accounts?.find(row=>row.id===grant?.account_id);
   if(!call||!job||!grant||!profile||!account)return selected([]);
   return selected([{...call,job_state:job.state,container_name:job.container_name,container_id:job.container_id??null,launch_digest:job.launch_digest,job_receipt:job.receipt??null,job_input:job.input_digest,grant_state:grant.state,physical_receipt:grant.physical_receipt??null,account_id:grant.account_id,model:profile.model,effort:profile.effort,provider:account.provider,mode:account.mode}]);
  }
  if(text.startsWith('SELECT j.*,g.account_id FROM ac_native_planning_jobs')){
   const job=this.tables.ac_native_planning_jobs?.find(row=>row.id===params[0]&&row.context_id===params[1]);
   const grant=this.tables.ac_capacity_grants?.find(row=>row.id===job?.grant_id);
   return job&&grant?selected([{...job,account_id:grant.account_id}]):selected([]);
  }
  if(text.startsWith('SELECT j.*,g.state grant_state,g.physical_receipt FROM ac_native_planning_jobs')){
   const job=this.tables.ac_native_planning_jobs?.find(row=>row.id===params[0]&&row.context_id===params[1]);
   const grant=this.tables.ac_capacity_grants?.find(row=>row.id===job?.grant_id);
   return job&&grant?selected([{...job,grant_state:grant.state,physical_receipt:grant.physical_receipt??null}]):selected([]);
  }
  if(text.startsWith('SELECT * FROM ac_native_planning_jobs WHERE id=$1 AND grant_id=$2')){
   const job=this.tables.ac_native_planning_jobs?.find(row=>row.id===params[0]&&row.grant_id===params[1]&&row.context_id===params[2]);
   return job?selected([{...job}]):selected([]);
  }
  if(text.startsWith('SELECT * FROM ac_native_planning_jobs WHERE id=$1')){
   const job=this.tables.ac_native_planning_jobs?.find(row=>row.id===params[0]);
   return job?selected([{...job}]):selected([]);
  }
  if(text.startsWith('SELECT * FROM ac_semantic_planning_calls WHERE id=$1')){
   const call=this.tables.ac_semantic_planning_calls?.find(row=>row.id===params[0]);
   return call?selected([{...call}]):selected([]);
  }
  if(text.startsWith('SELECT * FROM ac_capacity_grants WHERE id=$1')){
   const grant=this.tables.ac_capacity_grants?.find(row=>row.id===params[0]);
   return grant?selected([{...grant}]):selected([]);
  }
  if(text.startsWith('SELECT 1 FROM ac_plan_cancellations'))return selected((this.tables.ac_plan_cancellations??[]).filter(row=>row.intent_id===params[0]).map(()=>({one:1})));
  if(text.startsWith('UPDATE ac_native_planning_jobs SET state=$2,container_id=$3,receipt=$4 WHERE id=$1')){
   const job=this.tables.ac_native_planning_jobs?.find(row=>row.id===params[0]);if(!job)return wrote(0);
   job.state=params[1];job.container_id=params[2];job.receipt=params[3];return wrote(1);
  }
  if(text.includes("state IN ('reserved','uncertain')")){
   const grant=this.tables.ac_capacity_grants?.find(row=>row.id===params[0]&&(row.state==='reserved'||row.state==='uncertain'));
   if(!grant)return wrote(0);grant.state='released';grant.physical_receipt=params[1];return wrote(1);
  }
  if(text.startsWith("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1")){
   const grant=this.tables.ac_capacity_grants?.find(row=>row.id===params[0]);if(!grant)return wrote(0);
   grant.state='released';grant.physical_receipt=params[1];return wrote(1);
  }
  throw Error('UNHANDLED_SQL '+text);
 }
}
function planningSubstituteLedger(){
 const memory=new PlanningRecoveryMemory();
 const client={query:(sql:string,params?:unknown[])=>memory.query(sql,params??[]),release(){}};
 const ledger=Object.create(Ledger.prototype) as Ledger;
 Object.assign(ledger,{pool:{query:(sql:string,params?:unknown[])=>memory.query(sql,params??[]),connect:async()=>client,end:async()=>{}}});
 return {ledger,memory};
}
async function planningRecoveryOnSubstitute(){
 const {ledger:db,memory}=planningSubstituteLedger(),area=await mkdtemp(join(tmpdir(),'ac-plan-recover-'));
 const spool=join(area,'spool'),accounts=join(area,'accounts');await mkdir(spool,{mode:0o700});await mkdir(accounts,{mode:0o700});
 const project=randomUUID(),principal='native-recover-'+randomUUID(),account=randomUUID(),profile=randomUUID(),context=randomUUID(),instance=randomUUID();
 const subject='a'.repeat(64),intent=randomUUID();
 memory.insert('ac_projects',{id:project});memory.insert('ac_memberships',{project_id:project,principal_id:principal,role:'owner'});
 memory.insert('ac_contexts',{id:context,project_id:project,paused:false,archived:false});
 memory.insert('ac_managers',{context_id:context,instance_id:instance,epoch:1,lease_until:Date.now()+60_000});
 memory.insert('ac_admission_control',{id:1,enabled:true});
 memory.insert('ac_accounts',{id:account,provider:'codex',mode:'subscription_cli'});
 memory.insert('ac_profiles',{id:profile,model:'fixture-model',effort:'medium'});
 memory.insert('ac_intents',{id:intent,context_id:context,principal_id:principal});
 const authority=Authority.parse({contextId:context,instanceId:instance,epoch:1});
 const imageId='sha256:'+'c'.repeat(64),keys=generateKeyPairSync('ed25519');
 const supervisor=new NativePlanningSupervisor(db,{id:'codex-native-planning',executorDigest:nativePlanningExecutorDigest(imageId),imageId,hostRoot:spool,accountRoot:accounts,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetwork:'ac-native-provider',accountSubjects:[{accountId:account,subjectDigest:subject}]});
 const fingerprint=createHash('sha256').update(Buffer.from(supervisor.executor.publicKey,'base64')).digest('hex');
 const containers=new Map<string,{value:any}|null>();let creates=0,starts=0,failStop=false,failInspect=false,inspects=0,failAfter=-1;const removed:string[]=[];
 const docker={
  inspect:async(name:string)=>{inspects++;if(failInspect||(failAfter>=0&&inspects>failAfter))throw new Refusal('DOCKER_UNCERTAIN');const slot=containers.get(name);return slot?slot.value:null;},
  stop:async(id:string)=>{if(failStop)throw new Refusal('DOCKER_STOP_UNCERTAIN');for(const slot of containers.values())if(slot?.value.Id===id)slot.value.State={Running:false,Status:'exited',ExitCode:137,FinishedAt:new Date().toISOString(),StartedAt:new Date().toISOString(),Pid:0};},
  remove:async(id:string)=>{removed.push(id);for(const [name,slot] of containers)if(slot?.value.Id===id)containers.set(name,null);},
  create:async()=>{creates++;throw new Refusal('DOCKER_CREATE_UNCERTAIN');},start:async()=>{starts++;throw new Refusal('DOCKER_START_UNCERTAIN');}};
 Object.defineProperty(supervisor,'docker',{value:docker});
 const plant=(jobState:'uncertain'|'running',grantState:'reserved'|'running'|'uncertain',container?:Record<string,any>)=>{
  const grant=randomUUID(),call=randomUUID(),session=randomUUID(),inputDigest=digest({call}),name='ac-native-plan-'+call;
  memory.insert('ac_capacity_grants',{id:grant,intent_id:intent,context_id:context,manager_epoch:authority.epoch,account_id:account,profile_id:profile,state:grantState,resource_kind:'model',physical_receipt:null});
  memory.insert('ac_semantic_planning_calls',{id:call,context_id:context,intent_id:intent,grant_id:grant,session_id:session,profile_id:profile,execution_epoch:authority.epoch,input_digest:inputDigest,state:'uncertain',selected_executor_id:supervisor.executor.id,selected_executor_digest:supervisor.executor.digest,selected_key_fingerprint:fingerprint});
  memory.insert('ac_native_planning_jobs',{id:call,grant_id:grant,context_id:context,input_digest:inputDigest,launch_digest:'d'.repeat(64),container_name:name,container_id:container?.Id??null,state:jobState,receipt:null});
  if(container){const root=join(spool,call);container.Config.Labels['agent-control.job']=call;container.Mounts=[
   {Source:join(accounts,account),Destination:'/account',RW:true},{Source:join(root,'input'),Destination:'/input',RW:false},
   {Source:join(root,'output'),Destination:'/output',RW:true},{Source:join(root,'planning'),Destination:'/planning',RW:false},
   {Source:join(root,'public-key.pem'),Destination:'/runner/planning-public-key.pem',RW:false}];containers.set(name,{value:container});}
  return {grant,call,name};
 };
 const shell=(id:string,state:Record<string,unknown>)=>({Id:id,Image:imageId,Config:{User:`${process.getuid?.()}:${process.getgid?.()}`,Entrypoint:['node','/opt/agent-control/dist/src/native-planning-worker.mjs'],Cmd:[],WorkingDir:'/planning',Env:['PATH=/usr/bin'],Labels:{'agent-control.job':'','agent-control.launch':'d'.repeat(64),'agent-control.contract':'native-planning-v1'} as Record<string,string>},
  HostConfig:{NetworkMode:'ac-native-provider',ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:96,Memory:512*1024*1024,NanoCpus:1e9},State:state,Mounts:[] as {Source:string;Destination:string;RW:boolean}[]});
 const running=plant('running','running',shell('e'.repeat(64),{Running:true,Status:'running',ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'2026-11-03T00:00:00Z',Pid:4242}));
 failStop=true;assert.deepEqual(await supervisor.stop(principal,authority,running.call),{state:'uncertain'});assert.equal(creates,0);assert.equal(starts,0);assert.equal(removed.length,0);
 assert.equal(memory.one('ac_capacity_grants',running.grant).state,'running');failStop=false;
 const crashed=await supervisor.recover(principal,authority,running.call);
 assert.equal(crashed.state,'uncertain');assert.equal(crashed.interval,'before_terminal_evidence');assert.equal(crashed.grant,'preserved');assert.equal(crashed.replayed,false);assert.equal(creates,0);
 const opaque=plant('uncertain','reserved',shell('f'.repeat(64),{Running:false,Status:'created',ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z'}));
 const lacked=await supervisor.recover(principal,authority,opaque.call);
 assert.equal(lacked.state,'uncertain');assert.equal(lacked.grant,'preserved');assert.equal(removed.length,0);assert.equal(memory.one('ac_capacity_grants',opaque.grant).state,'reserved');
 const created=plant('uncertain','reserved',shell('1'.repeat(64),{Running:false,Status:'created',ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'0001-01-01T00:00:00Z',Pid:0}));
 const freed=await supervisor.recover(principal,authority,created.call);
 assert.equal(freed.state,'released_unstarted');assert.deepEqual(freed.removed,['1'.repeat(64)]);assert.equal(freed.replayed,false);assert.equal(creates,0);assert.equal(starts,0);
 assert.equal((memory.one('ac_capacity_grants',created.grant).physical_receipt as {executionStarted:boolean}).executionStarted,false);
 assert.equal((await supervisor.recover(principal,authority,created.call)).state,'released_unstarted');assert.equal(removed.length,1);
 const absent=plant('uncertain','reserved');
 const absentRecovery=await supervisor.recover(principal,authority,absent.call);
 assert.equal(absentRecovery.state,'uncertain');assert.equal(absentRecovery.grant,'preserved');assert.equal(absentRecovery.interval,'terminal_evidence_missing');assert.equal(absentRecovery.removed.length,0);assert.equal(creates,0);
 assert.equal(memory.one('ac_capacity_grants',absent.grant).state,'reserved');
 const again=await supervisor.recover(principal,authority,absent.call);assert.equal(again.replayed,false);assert.equal(again.grant,'preserved');assert.equal(creates,0);
 const delayed=plant('uncertain','reserved'),delayedId='71'.repeat(32);let delayedHits=0;const baseInspect=docker.inspect.bind(docker);
 docker.inspect=async (name:string)=>{if(name!==delayed.name)return baseInspect(name);delayedHits++;if(delayedHits<=2){if(delayedHits===2){const root=join(spool,delayed.call),body=shell(delayedId,{Running:false,Status:'created',ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'0001-01-01T00:00:00Z',Pid:0});body.Config.Labels['agent-control.job']=delayed.call;body.Mounts=[{Source:join(accounts,account),Destination:'/account',RW:true},{Source:join(root,'input'),Destination:'/input',RW:false},{Source:join(root,'output'),Destination:'/output',RW:true},{Source:join(root,'planning'),Destination:'/planning',RW:false},{Source:join(root,'public-key.pem'),Destination:'/runner/planning-public-key.pem',RW:false}];containers.set(name,{value:body});}return null;}return baseInspect(name);};
 const delayedRecovery=await supervisor.recover(principal,authority,delayed.call);
 assert.equal(delayedRecovery.state,'uncertain');assert.equal(delayedRecovery.grant,'preserved');assert.equal(delayedRecovery.replayed,false);assert.equal(delayedHits>=2,true);
 assert.equal(removed.includes(delayedId),false);assert.equal(memory.one('ac_capacity_grants',delayed.grant).state,'reserved');assert.ok(containers.get(delayed.name));
 docker.inspect=baseInspect;const delayedProof=await supervisor.recover(principal,authority,delayed.call);
 assert.equal(delayedProof.state,'released_unstarted');assert.deepEqual(delayedProof.removed,[delayedId]);assert.equal((memory.one('ac_capacity_grants',delayed.grant).physical_receipt as {executionStarted:boolean}).executionStarted,false);assert.equal(creates,0);
 const exitId='72'.repeat(32),exitJob=plant('uncertain','reserved',shell(exitId,{Running:false,Status:'created',ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'0001-01-01T00:00:00Z',Pid:0}));const removedBeforeExit=removed.length;
 docker.inspect=async (name:string)=>{const slot=containers.get(name);if(slot?.value?.Id===exitId&&nativeContainerNeverStarted(slot.value.State)){const shot=structuredClone(slot.value);slot.value.State={Running:false,Status:'exited',ExitCode:0,FinishedAt:new Date().toISOString(),StartedAt:new Date().toISOString(),Pid:0};return shot;}return slot?.value??null;};
 const exitedEarly=await supervisor.recover(principal,authority,exitJob.call);
 assert.equal(exitedEarly.interval,'before_terminal_evidence');assert.equal(exitedEarly.grant,'preserved');assert.equal(removed.slice(removedBeforeExit).includes(exitId),false);assert.ok(containers.get(exitJob.name));assert.equal(memory.one('ac_capacity_grants',exitJob.grant).state,'reserved');assert.equal(creates,0);
 docker.inspect=baseInspect;const epochId='73'.repeat(32),epochJob=plant('uncertain','reserved',shell(epochId,{Running:false,Status:'created',ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'0001-01-01T00:00:00Z',Pid:0}));const removedBeforeEpoch=removed.length;
 docker.inspect=async (name:string)=>{const slot=containers.get(name);if(slot?.value?.Id===epochId&&nativeContainerNeverStarted(slot.value.State))memory.tables.ac_managers[0]!.epoch=9;return slot?.value??null;};
 await assert.rejects(supervisor.recover(principal,authority,epochJob.call),/STALE_MANAGER/);
 assert.equal(removed.slice(removedBeforeEpoch).includes(epochId),false);assert.equal(memory.one('ac_capacity_grants',epochJob.grant).state,'reserved');assert.equal(creates,0);docker.inspect=baseInspect;
 const runningGrant=plant('uncertain','running');
 const heldRunning=await supervisor.recover(principal,authority,runningGrant.call);
 assert.equal(heldRunning.interval,'terminal_evidence_missing');assert.equal(heldRunning.grant,'preserved');assert.equal(memory.one('ac_capacity_grants',runningGrant.grant).state,'running');assert.equal(creates,0);
 const recorded=plant('running','uncertain');
 const missing=await supervisor.recover(principal,authority,recorded.call);
 assert.equal(missing.interval,'terminal_evidence_missing');assert.equal(missing.grant,'preserved');assert.equal(memory.one('ac_capacity_grants',recorded.grant).state,'uncertain');
 failInspect=true;const blind=plant('uncertain','reserved');
 assert.equal((await supervisor.recover(principal,authority,blind.call)).interval,'docker_response_lost');
 assert.equal(memory.one('ac_capacity_grants',blind.grant).state,'reserved');assert.equal(creates,0);failInspect=false;
 inspects=0;failAfter=2;const late=plant('uncertain','reserved',shell('5'.repeat(64),{Running:false,Status:'created',ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'0001-01-01T00:00:00Z',Pid:0}));
 const lateRecovery=await supervisor.recover(principal,authority,late.call);
 assert.equal(lateRecovery.interval,'docker_response_lost');assert.equal(lateRecovery.grant,'preserved');assert.equal(memory.one('ac_capacity_grants',late.grant).state,'reserved');assert.equal(creates,0);failAfter=-1;
 assert.deepEqual(await supervisor.stop(principal,authority,absent.call),{state:'uncertain'});
 const alive=plant('running','running',shell('2'.repeat(64),{Running:true,Status:'running',ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'2026-11-03T00:00:00Z',Pid:7}));
 memory.tables.ac_managers[0]!.lease_until=Date.now()-1000;
 await assert.rejects(supervisor.recover(principal,authority,alive.call),/STALE_MANAGER/);
 assert.equal(memory.one('ac_capacity_grants',alive.grant).state,'running');
 const next=randomUUID(),manager=memory.tables.ac_managers[0]!;manager.instance_id=next;manager.epoch=2;manager.lease_until=Date.now()+60_000;
 const successor=Authority.parse({contextId:context,instanceId:next,epoch:2});
 const other=new NativePlanningSupervisor(db,{id:'codex-native-planning',executorDigest:nativePlanningExecutorDigest(imageId),imageId,hostRoot:spool,accountRoot:accounts,protectedRepositories:[],signingKeyPem:generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetwork:'ac-native-provider',accountSubjects:[{accountId:account,subjectDigest:subject}]});
 Object.defineProperty(other,'docker',{value:docker});
 const foreign=await other.recover(principal,successor,alive.call);
 assert.equal(foreign.interval,'supervisor_identity');assert.equal(foreign.grant,'preserved');assert.equal(foreign.replayed,false);
 const observed=await supervisor.recover(principal,successor,alive.call);
 assert.equal(observed.state,'uncertain');assert.equal(observed.grant,'preserved');assert.equal(creates,0);assert.equal(starts,0);
 const terminal=plant('running','running',shell('3'.repeat(64),{Running:false,Status:'exited',ExitCode:137,FinishedAt:new Date().toISOString(),StartedAt:'2026-11-03T00:00:00Z',Pid:0}));
 const root=join(spool,terminal.call);await mkdir(root,{mode:0o700});await mkdir(join(root,'output'),{mode:0o700});
 const first=await supervisor.recover(principal,successor,terminal.call);
 assert.equal(first.state,'acknowledged');assert.equal(first.interval,'ack_lost');assert.equal(first.replayed,false);
 const replay=await supervisor.recover(principal,successor,terminal.call);
 assert.equal(replay.state,'acknowledged');assert.deepEqual(replay.receipt,first.receipt);assert.equal(creates,0);assert.equal(starts,0);
 assert.equal(memory.tables.ac_native_planning_jobs!.filter(row=>row.grant_id===terminal.grant).length,1);
 const quiet=plant('running','running',shell('4'.repeat(64),{Running:false,Status:'exited',ExitCode:0,FinishedAt:new Date().toISOString(),StartedAt:'2026-11-03T00:00:00Z',Pid:0}));
 const quietRoot=join(spool,quiet.call);await mkdir(quietRoot,{mode:0o700});await mkdir(join(quietRoot,'output'),{mode:0o700});
 const unresolved=await supervisor.recover(principal,successor,quiet.call);
 assert.equal(unresolved.interval,'terminal_evidence_missing');assert.equal(unresolved.grant,'preserved');assert.equal(creates,0);
 assert.equal(memory.one('ac_capacity_grants',quiet.grant).state,'running');
 const jobsBeforeProcess=memory.tables.ac_native_planning_jobs.length;
 const processExit=spawnSync(process.execPath,['-e','process.exit(137)'],{timeout:5000});
 assert.equal(processExit.status,137);assert.equal(creates,0);assert.equal(starts,0);
 assert.equal(memory.tables.ac_native_planning_jobs.length,jobsBeforeProcess);
 await rm(area,{recursive:true,force:true});
}
test('native planning recovery preserves uncertain grants and releases only a proven-unstarted container',async()=>{
 if(!process.env.AC_TEST_DATABASE_URL){await planningRecoveryOnSubstitute();return;}
 const base=process.env.AC_TEST_DATABASE_URL;
 const fixture=await isolatedDatabase(base,'nativerecov'),db=new Ledger(fixture.url),area=await mkdtemp(join(tmpdir(),'ac-plan-recover-'));
 const spool=join(area,'spool'),accounts=join(area,'accounts');await mkdir(spool,{mode:0o700});await mkdir(accounts,{mode:0o700});
 try{
  await db.migrate();const capacity=new Capacity(db),project=randomUUID(),principal='native-recover-'+randomUUID(),account=randomUUID(),profile=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'planning recovery']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const subject='a'.repeat(64);await capacity.addAccount(principal,project,{id:account,provider:'codex',label:'synthetic metadata',resourceIdentity:'codex:'+subject,mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/fixture',maxConcurrent:1});
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'fixture-model','medium','manager',false)",[profile,account]);
  const context=await db.createContext(principal,project,randomUUID());const authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),principal]);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
  const imageId='sha256:'+'c'.repeat(64),keys=generateKeyPairSync('ed25519');
  const supervisor=new NativePlanningSupervisor(db,{id:'codex-native-planning',executorDigest:nativePlanningExecutorDigest(imageId),imageId,hostRoot:spool,accountRoot:accounts,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetwork:'ac-native-provider',accountSubjects:[{accountId:account,subjectDigest:subject}]});
  const fingerprint=createHash('sha256').update(Buffer.from(supervisor.executor.publicKey,'base64')).digest('hex');
  const containers=new Map<string,{value:any}|null>();let creates=0,starts=0,failStop=false,failInspect=false;const removed:string[]=[];
  const docker={
   inspect:async(name:string)=>{if(failInspect)throw new Refusal('DOCKER_UNCERTAIN');const slot=containers.get(name);return slot?slot.value:null;},
   stop:async(id:string)=>{if(failStop)throw new Refusal('DOCKER_STOP_UNCERTAIN');for(const slot of containers.values())if(slot?.value.Id===id)slot.value.State={Running:false,Status:'exited',ExitCode:137,FinishedAt:new Date().toISOString(),StartedAt:new Date().toISOString(),Pid:0};},
   remove:async(id:string)=>{removed.push(id);for(const [name,slot] of containers)if(slot?.value.Id===id)containers.set(name,null);},
   create:async()=>{creates++;throw new Refusal('DOCKER_CREATE_UNCERTAIN');},start:async()=>{starts++;throw new Refusal('DOCKER_START_UNCERTAIN');}};
  Object.defineProperty(supervisor,'docker',{value:docker});
  const plant=async(jobState:'uncertain'|'running',grantState:'reserved'|'running'|'uncertain',container?:Record<string,any>)=>{
   const grant=randomUUID(),call=randomUUID(),session=randomUUID(),inputDigest=digest({call}),launchDigest='d'.repeat(64),name='ac-native-plan-'+call;
   await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
    VALUES($1,$2,$3,$4,$5,$6,$7,'manager',$8,1,1,$9,false,$10)`,[grant,randomUUID(),intent.id,context,authority.epoch,account,profile,project,inputDigest,grantState]);
   await db.pool.query(`INSERT INTO ac_semantic_planning_calls(id,context_id,intent_id,principal_id,input_digest,executor_id,executor_digest,expected_revision,attempt_id,session_id,grant_id,profile_id,execution_epoch,state,selected_executor_id,selected_executor_digest,selected_key_fingerprint)
    VALUES($1,$2,$3,$4,$5,'semantic-planning-v1',$6,0,$7,$8,$9,$10,$11,'uncertain',$12,$13,$14)`,[call,context,intent.id,principal,inputDigest,digest({contract:'semantic-planning-v1'}),randomUUID(),session,grant,profile,authority.epoch,supervisor.executor.id,supervisor.executor.digest,fingerprint]);
   await db.pool.query(`INSERT INTO ac_native_planning_jobs(id,grant_id,context_id,input_digest,launch_digest,container_name,container_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[call,grant,context,inputDigest,launchDigest,name,container?.Id??null,jobState]);
   if(container){const root=join(spool,call);container.Config.Labels['agent-control.job']=call;container.Mounts=[
    {Source:join(accounts,account),Destination:'/account',RW:true},{Source:join(root,'input'),Destination:'/input',RW:false},
    {Source:join(root,'output'),Destination:'/output',RW:true},{Source:join(root,'planning'),Destination:'/planning',RW:false},
    {Source:join(root,'public-key.pem'),Destination:'/runner/planning-public-key.pem',RW:false}];containers.set(name,{value:container});}
   return {grant,call,name};
  };
  const closeCall=async(call:string)=>db.pool.query("UPDATE ac_semantic_planning_calls SET state='rejected',failure_code='fixture-next' WHERE id=$1",[call]);
  const shell=(id:string,state:Record<string,unknown>)=>({Id:id,Image:imageId,Config:{User:`${process.getuid?.()}:${process.getgid?.()}`,Entrypoint:['node','/opt/agent-control/dist/src/native-planning-worker.mjs'],Cmd:[],WorkingDir:'/planning',Env:['PATH=/usr/bin'],Labels:{'agent-control.job':'','agent-control.launch':'d'.repeat(64),'agent-control.contract':'native-planning-v1'} as Record<string,string>},
   HostConfig:{NetworkMode:'ac-native-provider',ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:96,Memory:512*1024*1024,NanoCpus:1e9},State:state,Mounts:[] as {Source:string;Destination:string;RW:boolean}[]});
  const running=await plant('running','running',shell('e'.repeat(64),{Running:true,Status:'running',ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'2026-11-03T00:00:00Z',Pid:4242}));
  failStop=true;assert.deepEqual(await supervisor.stop(principal,authority,running.call),{state:'uncertain'});assert.equal(creates,0);assert.equal(starts,0);assert.equal(removed.length,0);
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[running.grant])).rows[0].state,'running');failStop=false;
  const crashed=await supervisor.recover(principal,authority,running.call);
  assert.equal(crashed.state,'uncertain');assert.equal(crashed.interval,'before_terminal_evidence');assert.equal(crashed.grant,'preserved');assert.equal(crashed.replayed,false);assert.equal(creates,0);
  await closeCall(running.call);
  const opaque=await plant('uncertain','reserved',shell('f'.repeat(64),{Running:false,Status:'created',ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z'}));
  const lacked=await supervisor.recover(principal,authority,opaque.call);
  assert.equal(lacked.state,'uncertain');assert.equal(lacked.grant,'preserved');assert.equal(removed.length,0);assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[opaque.grant])).rows[0].state,'reserved');
  await closeCall(opaque.call);
  const created=await plant('uncertain','reserved',shell('1'.repeat(64),{Running:false,Status:'created',ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'0001-01-01T00:00:00Z',Pid:0}));
  const freed=await supervisor.recover(principal,authority,created.call);
  assert.equal(freed.state,'released_unstarted');assert.deepEqual(freed.removed,['1'.repeat(64)]);assert.equal(freed.replayed,false);assert.equal(creates,0);assert.equal(starts,0);
  assert.equal((await db.pool.query('SELECT state,physical_receipt FROM ac_capacity_grants WHERE id=$1',[created.grant])).rows[0].physical_receipt.executionStarted,false);
  assert.equal((await supervisor.recover(principal,authority,created.call)).state,'released_unstarted');assert.equal(removed.length,1);
  await closeCall(created.call);
  const absent=await plant('uncertain','reserved');
  const absentRecovery=await supervisor.recover(principal,authority,absent.call);
  assert.equal(absentRecovery.state,'uncertain');assert.equal(absentRecovery.grant,'preserved');assert.equal(absentRecovery.interval,'terminal_evidence_missing');assert.equal(absentRecovery.removed.length,0);assert.equal(creates,0);
  assert.equal((await db.pool.query('SELECT state,physical_receipt FROM ac_capacity_grants WHERE id=$1',[absent.grant])).rows[0].state,'reserved');
  const again=await supervisor.recover(principal,authority,absent.call);assert.equal(again.replayed,false);assert.equal(again.grant,'preserved');assert.equal(creates,0);
  await closeCall(absent.call);
  const recorded=await plant('running','uncertain');
  const missing=await supervisor.recover(principal,authority,recorded.call);
  assert.equal(missing.interval,'terminal_evidence_missing');assert.equal(missing.grant,'preserved');assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[recorded.grant])).rows[0].state,'uncertain');
  await closeCall(recorded.call);
  failInspect=true;const blind=await plant('uncertain','reserved');
  assert.equal((await supervisor.recover(principal,authority,blind.call)).interval,'docker_response_lost');
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[blind.grant])).rows[0].state,'reserved');assert.equal(creates,0);failInspect=false;await closeCall(blind.call);
  const alive=await plant('running','running',shell('2'.repeat(64),{Running:true,Status:'running',ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'2026-11-03T00:00:00Z',Pid:7}));
  await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);
  const successor=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  await assert.rejects(supervisor.recover(principal,authority,alive.call),/STALE_MANAGER/);
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[alive.grant])).rows[0].state,'running');
  const other=new NativePlanningSupervisor(db,{id:'codex-native-planning',executorDigest:nativePlanningExecutorDigest(imageId),imageId,hostRoot:spool,accountRoot:accounts,protectedRepositories:[],signingKeyPem:generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetwork:'ac-native-provider',accountSubjects:[{accountId:account,subjectDigest:subject}]});
  Object.defineProperty(other,'docker',{value:docker});
  const foreign=await other.recover(principal,successor,alive.call);
  assert.equal(foreign.interval,'supervisor_identity');assert.equal(foreign.grant,'preserved');assert.equal(foreign.replayed,false);assert.equal(removed.length,1);
  const observed=await supervisor.recover(principal,successor,alive.call);
  assert.equal(observed.state,'uncertain');assert.equal(observed.grant,'preserved');assert.equal(creates,0);assert.equal(starts,0);
  await closeCall(alive.call);
  const terminal=await plant('running','running',shell('3'.repeat(64),{Running:false,Status:'exited',ExitCode:137,FinishedAt:new Date().toISOString(),StartedAt:'2026-11-03T00:00:00Z',Pid:0}));
  const root=join(spool,terminal.call);await mkdir(root,{mode:0o700});await mkdir(join(root,'output'),{mode:0o700});
  const first=await supervisor.recover(principal,successor,terminal.call);
  assert.equal(first.state,'acknowledged');assert.equal(first.interval,'ack_lost');assert.equal(first.replayed,false);
  const replay=await supervisor.recover(principal,successor,terminal.call);
  assert.equal(replay.state,'acknowledged');assert.deepEqual(replay.receipt,first.receipt);assert.equal(creates,0);assert.equal(starts,0);
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_native_planning_jobs WHERE grant_id=$1",[terminal.grant])).rows[0].n,1);
  await closeCall(terminal.call);
  const quiet=await plant('running','running',shell('4'.repeat(64),{Running:false,Status:'exited',ExitCode:0,FinishedAt:new Date().toISOString(),StartedAt:'2026-11-03T00:00:00Z',Pid:0}));
  const quietRoot=join(spool,quiet.call);await mkdir(quietRoot,{mode:0o700});await mkdir(join(quietRoot,'output'),{mode:0o700});
  const unresolved=await supervisor.recover(principal,successor,quiet.call);
  assert.equal(unresolved.interval,'terminal_evidence_missing');assert.equal(unresolved.grant,'preserved');assert.equal(creates,0);
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[quiet.grant])).rows[0].state,'running');
 }finally{await db.close();await fixture.close();await rm(area,{recursive:true,force:true});}
});

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

test('native planning recovery interrupts an in-flight create or start and lets the successor read the same journal',async()=>{
 const {ledger:db,memory}=planningSubstituteLedger(),area=await mkdtemp(join(tmpdir(),'ac-plan-launch-boundary-'));
 const spool=join(area,'spool'),accounts=join(area,'accounts');await mkdir(spool,{mode:0o700});await mkdir(accounts,{mode:0o700});await chmod(spool,0o700);await chmod(accounts,0o700);
 const project=randomUUID(),principal='native-boundary-'+randomUUID(),account=randomUUID(),profile=randomUUID(),context=randomUUID(),instance=randomUUID(),intent=randomUUID();
 const subject='a'.repeat(64);
 memory.insert('ac_projects',{id:project});memory.insert('ac_memberships',{project_id:project,principal_id:principal,role:'owner'});
 memory.insert('ac_contexts',{id:context,project_id:project,paused:false,archived:false});
 memory.insert('ac_managers',{context_id:context,instance_id:instance,epoch:1,lease_until:Date.now()+60_000});
 memory.insert('ac_admission_control',{id:1,enabled:true});
 memory.insert('ac_accounts',{id:account,provider:'codex',mode:'subscription_cli',enabled:true,eligibility:'documented_supported',resource_identity:'codex:'+subject});
 memory.insert('ac_profiles',{id:profile,model:'fixture-model',effort:'medium',role:'manager',enabled:true});
 memory.insert('ac_intents',{id:intent,context_id:context,principal_id:principal});
 const authority=Authority.parse({contextId:context,instanceId:instance,epoch:1});
 const imageId='sha256:'+'c'.repeat(64),keys=generateKeyPairSync('ed25519');
 const config={id:'codex-native-planning',executorDigest:nativePlanningExecutorDigest(imageId),imageId,hostRoot:spool,accountRoot:accounts,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetwork:'ac-native-provider',accountSubjects:[{accountId:account,subjectDigest:subject}]};
 const supervisor=new NativePlanningSupervisor(db,config);
 const fingerprint=createHash('sha256').update(Buffer.from(supervisor.executor.publicKey,'base64')).digest('hex');
 const containers=new Map<string,any>();let creates=0,starts=0,phase='idle',inspectsDuringHold=0;let mode:'hold-create'|'hold-start'|'hold-start-running'='hold-create';const removed:string[]=[];
 let open:(value?:unknown)=>void=()=>{},fail:(error?:unknown)=>void=()=>{},entered=()=>{};
 let barrier=new Promise((resolve,reject)=>{open=resolve;fail=reject;});
 let arrived=new Promise<void>(resolve=>{entered=resolve;});
 const arm=()=>{barrier=new Promise((resolve,reject)=>{open=resolve;fail=reject;});arrived=new Promise<void>(resolve=>{entered=resolve;});phase='idle';inspectsDuringHold=0;};
 const createdState={Running:false,Status:'created',ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'0001-01-01T00:00:00Z',Pid:0};
 const bodyOf=(id:string,configuration:any,state:Record<string,unknown>)=>{
  const binds:string[]=configuration.HostConfig?.Binds??[];
  return {Id:id,Image:configuration.Image,Config:{User:configuration.User,Entrypoint:configuration.Entrypoint,Cmd:configuration.Cmd??[],WorkingDir:configuration.WorkingDir,Env:configuration.Env??[],Labels:configuration.Labels},
   HostConfig:configuration.HostConfig,Mounts:binds.map(bind=>{const modeFlag=bind.endsWith(':rw');const head=bind.slice(0,bind.lastIndexOf(':'));const colon=head.indexOf(':');return {Source:head.slice(0,colon),Destination:head.slice(colon+1),RW:modeFlag};}),State:state};
 };
 let sequence=0;const nextId=()=>`${(++sequence).toString(16).padStart(2,'0')}${'ab'.repeat(31)}`;
 const docker={
  inspect:async(name:string)=>{if(phase==='create-held'||phase==='start-held')inspectsDuringHold++;const slot=containers.get(name);return slot??null;},
  stop:async()=>{throw new Refusal('DOCKER_STOP_UNEXPECTED');},
  remove:async(id:string)=>{removed.push(id);for(const [name,slot] of containers)if(slot?.Id===id)containers.set(name,null);},
  create:async(name:string,configuration:any)=>{creates++;if(mode==='hold-create'){phase='create-held';entered();await barrier;throw new Refusal('DOCKER_CREATE_UNCERTAIN');}
   const id=nextId();containers.set(name,bodyOf(id,configuration,createdState));return id;},
  start:async(id:string)=>{starts++;const slot=[...containers.values()].find(item=>item?.Id===id);
   if(mode==='hold-start'||mode==='hold-start-running'){phase='start-held';entered();await barrier;if(mode==='hold-start-running'&&slot)slot.State={Running:true,Status:'running',ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:new Date().toISOString(),Pid:7};throw new Refusal('DOCKER_START_UNCERTAIN');}
   throw new Refusal('DOCKER_START_UNCERTAIN');}};
 Object.defineProperty(supervisor,'docker',{value:docker});
 const viewed=mock.method(ProviderEligibility.prototype,'view',async()=>({accountId:account,latest:{fresh:true,effectiveStatus:'documented_supported',provider:'codex',authenticationMode:'subscription_oauth',executionMode:'central_isolated_cli',adapterId:config.id,adapterVersion:supervisor.executor.digest},history:[]}));
 const homes=mock.method(AccountHomes.prototype,'inspectGranted',async()=>({accountId:account,projectId:project,ownerId:principal,uid:'1',device:'1',inode:'1'}));
 const invocation=(callId:string,grantId:string,sessionId:string)=>{
  const inputDigest=digest({boundary:callId});
  memory.insert('ac_capacity_grants',{id:grantId,intent_id:intent,context_id:context,project_id:project,manager_epoch:1,account_id:account,profile_id:profile,role:'manager',state:'reserved',resource_kind:'model',physical_receipt:null});
  memory.insert('ac_semantic_planning_calls',{id:callId,context_id:context,intent_id:intent,grant_id:grantId,session_id:sessionId,profile_id:profile,execution_epoch:1,input_digest:inputDigest,state:'uncertain',selected_executor_id:config.id,selected_executor_digest:supervisor.executor.digest,selected_key_fingerprint:fingerprint});
  return {callId,intentId:intent,contextId:context,grantId,sessionId,executionEpoch:1,inputDigest,profile:{id:profile,accountId:account,provider:'codex',mode:'subscription_cli' as const,model:'fixture-model',effort:'medium' as const},sourceMessageRef:'message:boundary',text:'boundary',constraints:{qualityRevision:1,targetRef:'refs/heads/boundary',knownReferences:[] as string[]},outputSchema:{},assertAuthorized:async()=>{}};
 };
 const hold=async(launch:Promise<unknown>,callId:string)=>{
  await arrived;const queued=supervisor.recover(principal,authority,callId);let settled=false;const observed=queued.then(value=>{settled=true;return value;});
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(settled,false);assert.equal(inspectsDuringHold,0);
  phase='idle';open();
  await assert.rejects(launch,/DOCKER_(CREATE|START)_UNCERTAIN/);
  return observed;
 };
 try{
  mode='hold-create';const lostCall=randomUUID(),lostGrant=randomUUID();
  const lost=invocation(lostCall,lostGrant,randomUUID());
  const lostLaunch=supervisor.executor.execute(lost);
  const lostRecovery=await hold(lostLaunch,lostCall);
  assert.equal(lostRecovery.state,'uncertain');assert.equal(lostRecovery.interval,'terminal_evidence_missing');assert.equal(lostRecovery.grant,'preserved');assert.equal(lostRecovery.replayed,false);
  assert.equal(creates,1);assert.equal(starts,0);assert.equal(removed.length,0);assert.equal(memory.one('ac_capacity_grants',lostGrant).state,'reserved');assert.equal(memory.one('ac_capacity_grants',lostGrant).physical_receipt,null);
  const successor=new NativePlanningSupervisor(db,config);Object.defineProperty(successor,'docker',{value:docker});
  const lostAgain=await successor.recover(principal,authority,lostCall);
  assert.equal(lostAgain.grant,'preserved');assert.equal(lostAgain.replayed,false);assert.equal(creates,1);assert.equal(starts,0);
  assert.equal(memory.tables.ac_native_planning_jobs.filter(row=>row.id===lostCall).length,1);
  arm();mode='hold-start-running';const runningCall=randomUUID(),runningGrant=randomUUID();
  const runningLaunch=supervisor.executor.execute(invocation(runningCall,runningGrant,randomUUID()));
  const runningRecovery=await hold(runningLaunch,runningCall);
  assert.equal(runningRecovery.interval,'before_terminal_evidence');assert.equal(runningRecovery.grant,'preserved');assert.equal(runningRecovery.replayed,false);assert.equal(removed.length,0);
  assert.equal(memory.one('ac_capacity_grants',runningGrant).state,'reserved');assert.equal(creates,2);assert.equal(starts,1);
  const runningAgain=await successor.recover(principal,authority,runningCall);
  assert.equal(runningAgain.grant,'preserved');assert.equal(runningAgain.replayed,false);assert.equal(creates,2);assert.equal(starts,1);assert.equal(removed.length,0);
  arm();mode='hold-start';const freshCall=randomUUID(),freshGrant=randomUUID();const beforeRelease=creates;
  const freshLaunch=supervisor.executor.execute(invocation(freshCall,freshGrant,randomUUID()));
  const released=await hold(freshLaunch,freshCall);
  assert.equal(released.state,'released_unstarted');assert.equal(released.interval,'proven_not_started');assert.equal(released.grant,'released');assert.equal(released.replayed,false);
  assert.equal((memory.one('ac_capacity_grants',freshGrant).physical_receipt as {executionStarted:boolean}).executionStarted,false);
  assert.equal(creates,beforeRelease+1);assert.equal(starts,2);
  const releasedAgain=await successor.recover(principal,authority,freshCall);
  assert.equal(releasedAgain.state,'released_unstarted');assert.equal(releasedAgain.replayed,false);assert.equal(creates,beforeRelease+1);assert.equal(starts,2);
 }finally{viewed.mock.restore();homes.mock.restore();await rm(area,{recursive:true,force:true});}
});
