import {mock,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,createHash} from 'node:crypto';
import {mkdtemp,mkdir,rm,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {Capacity} from '../src/capacity.ts';
import {NativeExecutionSupervisor,NativeExecutionRequest} from '../src/native-execution-supervisor.ts';
import {nativeContainerNeverStarted} from '../src/native-execution-isolation.ts';
import {Authority,Refusal,digest} from '../src/contracts.ts';
import {ProviderEligibility} from '../src/provider-eligibility.ts';
import {AccountHomes} from '../src/account-homes.ts';
import {GitArtifacts} from '../src/git.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('native execution retains uncertain capacity, fences takeover and replays only physical receipts',{skip:!process.env.AC_TEST_DATABASE_URL},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'nativeexec'),db=new Ledger(fixture.url),area=await mkdtemp(join(tmpdir(),'ac-native-exec-'));let runtime:CezarRuntime|undefined;
 try{
  await db.migrate();const capacity=new Capacity(db),project=randomUUID(),principal='native-exec-'+randomUUID(),account=randomUUID(),profile=randomUUID();
  const repo=join(area,'repo'),spool=join(area,'spool'),accounts=join(area,'accounts');for(const path of [repo,spool,accounts])await mkdir(path,{mode:0o700});
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'isolated executor fixture']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
  const subject='a'.repeat(64);await capacity.addAccount(principal,project,{id:account,provider:'codex',label:'dormant fixture',resourceIdentity:'codex:'+subject,mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/fixture',maxConcurrent:1});
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'fixture-model','medium','programmer',false)",[profile,account]);
  const context=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),principal]);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
  const grant=randomUUID(),keys=generateKeyPairSync('ed25519'),image='sha256:'+'c'.repeat(64);
  const config={id:'codex-native-execution',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:'d'.repeat(64),socketPath:'/no-operational-docker.sock',accountSubjects:[{accountId:account,subjectDigest:subject}],workerEnv:[],toolsEnv:[]};
  const supervisor=new NativeExecutionSupervisor(db,config),input=NativeExecutionRequest.parse({jobId:intent.operation_id,intentId:intent.id,grantId:grant,sessionId:randomUUID(),base:'e'.repeat(40),role:'programmer',task:'synthetic metadata only',writePaths:['src/example.ts']});
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,'programmer',$8,1,1,$9,false,'reserved')`,[grant,randomUUID(),intent.id,context,authority.epoch,account,profile,project,digest(input)]);
  // No auth file exists. A dormant account is refused before socket or home access.
  await assert.rejects(supervisor.start(principal,authority,input),/NATIVE_EXECUTION_NOT_ELIGIBLE/);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_native_execution_jobs')).rows[0].n,0);
  const workerId='f'.repeat(64),toolsId='1'.repeat(64),network='2'.repeat(64),hash=digest(input),fingerprint=createHash('sha256').update(keys.publicKey.export({format:'der',type:'spki'})).digest('hex');
  await db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state,worker_id,tools_id,network_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,'programmer','running',$14,$15,$16)`,[input.jobId,grant,intent.id,context,authority.epoch,input.sessionId,account,profile,digest({fixture:true}),supervisor.executorDigest,fingerprint,hash,input.base,workerId,toolsId,network]);
  await db.pool.query("UPDATE ac_capacity_grants SET state='uncertain' WHERE id=$1",[grant]);
  await db.pool.query("UPDATE ac_operations SET state='uncertain',grant_id=$2,native_session_id=$3 WHERE id=$1",[input.jobId,grant,input.sessionId]);
  const root=join(spool,input.jobId);await mkdir(root,{mode:0o700});await mkdir(join(root,'output'),{mode:0o700});await writeFile(join(root,'request.json'),JSON.stringify(input),{mode:0o600});
  const labels={'agent-control.job':input.jobId,'agent-control.launch':hash,'agent-control.contract':'native-execution-v1'};
  const physical=(id:string)=>({Id:id,Image:image,Config:{Labels:labels},State:{Status:'running',Running:true,ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z'}});
  const worker=physical(workerId),tools=physical(toolsId);let stops=0;
  const docker={inspect:async(name:string)=>name.startsWith('ac-native-worker-')?worker:tools,stop:async(id:string)=>{stops++;const p=id===workerId?worker:tools;p.State={Status:'exited',Running:false,ExitCode:137,FinishedAt:new Date().toISOString()};}};
  Object.defineProperty(supervisor,'docker',{value:docker});
  assert.deepEqual(await supervisor.reconcile(principal,authority,input),{state:'running'});
  await assert.rejects(supervisor.reconcile(principal,authority,{...input,task:'collision'}),/NATIVE_EXECUTION_REPLAY_MISMATCH/);
  await db.pause(principal,context,true);await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);
  const successor=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  await assert.rejects(supervisor.stop(principal,authority,input),/STALE_MANAGER/);assert.equal(stops,0);
  worker.Image='sha256:'+'9'.repeat(64);await assert.rejects(supervisor.stop(principal,successor,input),/NATIVE_EXECUTION_CONTAINER_MISMATCH/);assert.equal(stops,0);worker.Image=image;
  await supervisor.stop(principal,successor,input);assert.equal(stops,2);
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[grant])).rows[0].state,'uncertain');
  const terminal=await supervisor.reconcile(principal,successor,input);assert.equal(terminal.state,'failed');assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[grant])).rows[0].state,'released');
  assert.deepEqual(await supervisor.reconcileRegistered(principal,successor,input.jobId),terminal);
  await db.pool.query("UPDATE ac_operations SET state='uncertain',grant_id=$2 WHERE id=$1",[input.jobId,grant]);
  await db.pool.query('INSERT INTO ac_plan_cancellations(intent_id,context_id,requested_by,plan_revision) VALUES($1,$2,$3,$4)',[intent.id,context,principal,intent.plan_revision]);
  runtime=new CezarRuntime(db,repo,project,undefined,undefined,undefined,{nativeExecutions:[supervisor]});await runtime.start('administration-only');
  await runtime.reconcileCancellations(successor,principal);
  assert.equal((await db.pool.query('SELECT state FROM ac_plan_cancellations WHERE intent_id=$1',[intent.id])).rows[0].state,'confirmed');
  assert.equal((await db.pool.query('SELECT receipt FROM ac_operations WHERE id=$1',[input.jobId])).rows[0].receipt.cancellation,true);
  assert.equal(stops,2);
  await assert.rejects(db.pool.query('UPDATE ac_native_execution_jobs SET input_digest=$2 WHERE id=$1',[input.jobId,'0'.repeat(64)]),/NATIVE_EXECUTION_JOB_IMMUTABLE/);
  const other=new NativeExecutionSupervisor(db,{...config,signingKeyPem:generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}).toString()});
  await assert.rejects(other.reconcile(principal,successor,input),/NATIVE_EXECUTION_REPLAY_MISMATCH/);
 }finally{await runtime?.close();await db.close();await fixture.close();await rm(area,{recursive:true,force:true});}
});

type MemoryRow=Record<string,unknown>;
class ExecutionRecoveryMemory{
 tables:Record<string,MemoryRow[]>={};
 private snap:string|null=null;
 insert(table:string,row:MemoryRow){(this.tables[table]??=[]).push({...row});}
 one(table:string,id:string){const row=this.tables[table]?.find(item=>item.id===id);if(!row)throw Error('MISSING_ROW');return row;}
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
  if(text.includes('ac_provider_eligibility_assessments')){
   const grant=this.tables.ac_capacity_grants?.find(row=>row.id===params[0]&&row.state==='uncertain');
   return grant?selected([{...grant,model:grant.model,effort:grant.effort}]):selected([]);
  }
  if(text.startsWith('INSERT INTO ac_native_execution_jobs')){
   this.insert('ac_native_execution_jobs',{id:params[0],grant_id:params[1],intent_id:params[2],context_id:params[3],manager_epoch:params[4],session_id:params[5],executor_digest:params[6],key_fingerprint:params[7],input_digest:params[8],base_id:params[9],role:params[10],account_id:params[11],profile_id:params[12],profile_digest:params[13],eligibility_revision:params[14],state:'uncertain',worker_id:null,tools_id:null,network_id:null,receipt:null});
   return wrote(1);
  }
  if(text.startsWith("UPDATE ac_capacity_grants SET state='uncertain' WHERE id=$1")){
   const grant=this.tables.ac_capacity_grants?.find(row=>row.id===params[0]);if(!grant)return wrote(0);
   grant.state='uncertain';return wrote(1);
  }
  if(text.startsWith("UPDATE ac_operations SET state='uncertain',native_session_id=$2 WHERE id=$1")){
   const operation=this.tables.ac_operations?.find(row=>row.id===params[0]);if(!operation)return wrote(0);
   operation.state='uncertain';operation.native_session_id=params[1];return wrote(1);
  }
  if(text.startsWith('UPDATE ac_native_execution_jobs SET network_id=$2')){
   const job=this.tables.ac_native_execution_jobs?.find(row=>row.id===params[0]);if(!job)return wrote(0);job.network_id=params[1];return wrote(1);
  }
  if(text.startsWith('UPDATE ac_native_execution_jobs SET tools_id=$2')){
   const job=this.tables.ac_native_execution_jobs?.find(row=>row.id===params[0]);if(!job)return wrote(0);job.tools_id=params[1];return wrote(1);
  }
  if(text.startsWith('UPDATE ac_native_execution_jobs SET worker_id=$2')){
   const job=this.tables.ac_native_execution_jobs?.find(row=>row.id===params[0]);if(!job)return wrote(0);job.worker_id=params[1];return wrote(1);
  }
  if(text.includes('i.principal_id FROM ac_native_execution_jobs')){
   const job=this.tables.ac_native_execution_jobs?.find(row=>row.id===params[0]&&row.context_id===params[1]);
   const grant=this.tables.ac_capacity_grants?.find(row=>row.id===job?.grant_id);
   const intent=this.tables.ac_intents?.find(row=>row.id===job?.intent_id);
   if(!job||!grant||!intent)return selected([]);
   return selected([{...job,grant_state:grant.state,physical_receipt:grant.physical_receipt??null,principal_id:intent.principal_id}]);
  }
  if(text.startsWith('SELECT j.*,g.state grant_state')){
   const job=this.tables.ac_native_execution_jobs?.find(row=>row.id===params[0]&&row.context_id===params[1]);
   const grant=this.tables.ac_capacity_grants?.find(row=>row.id===job?.grant_id);
   return job&&grant?selected([{...job,grant_state:grant.state,physical_receipt:grant.physical_receipt??null}]):selected([]);
  }
  if(text.startsWith('SELECT intent_id FROM ac_native_execution_jobs')){
   const job=this.tables.ac_native_execution_jobs?.find(row=>row.id===params[0]&&row.context_id===params[1]);
   return job?selected([{intent_id:job.intent_id}]):selected([]);
  }
  if(text.startsWith('SELECT * FROM ac_native_execution_jobs WHERE id=$1')){
   const job=this.tables.ac_native_execution_jobs?.find(row=>row.id===params[0]);
   return job?selected([{...job}]):selected([]);
  }
  if(text.startsWith('SELECT principal_id FROM ac_intents WHERE id=$1 AND context_id=$2')){
   const intent=this.tables.ac_intents?.find(row=>row.id===params[0]&&row.context_id===params[1]);
   return intent?selected([{principal_id:intent.principal_id}]):selected([]);
  }
  if(text.startsWith('SELECT principal_id FROM ac_intents WHERE id=$1')){
   const intent=this.tables.ac_intents?.find(row=>row.id===params[0]);
   return intent?selected([{principal_id:intent.principal_id}]):selected([]);
  }
  if(text.startsWith('SELECT * FROM ac_capacity_grants WHERE id=$1')){
   const grant=this.tables.ac_capacity_grants?.find(row=>row.id===params[0]);
   return grant?selected([{...grant}]):selected([]);
  }
  if(text.startsWith('SELECT 1 FROM ac_plan_cancellations'))return selected((this.tables.ac_plan_cancellations??[]).filter(row=>row.intent_id===params[0]&&row.state==='requested').map(()=>({one:1})));
  if(text.startsWith('SELECT state FROM ac_native_artifact_finalizations'))return selected((this.tables.ac_native_artifact_finalizations??[]).filter(row=>row.job_id===params[0]).map(row=>({state:row.state})));
  if(text.startsWith('UPDATE ac_native_execution_jobs SET state=$2,worker_id=$3,tools_id=$4,receipt=$5 WHERE id=$1')){
   const job=this.tables.ac_native_execution_jobs?.find(row=>row.id===params[0]);if(!job)return wrote(0);
   job.state=params[1];job.worker_id=params[2];job.tools_id=params[3];job.receipt=params[4];return wrote(1);
  }
  if(text.startsWith("UPDATE ac_operations SET state='completed'")){
   const operation=this.tables.ac_operations?.find(row=>row.id===params[0]&&row.intent_id===params[2]&&row.grant_id===params[3]&&row.native_session_id===params[4]&&Number(row.manager_epoch)===Number(params[5])&&(row.state==='uncertain'||row.state==='running'));
   if(!operation)return wrote(0);operation.state='completed';operation.receipt=params[1];return wrote(1);
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
function executionSubstituteLedger(){
 const memory=new ExecutionRecoveryMemory();
 const client={query:(sql:string,params?:unknown[])=>memory.query(sql,params??[]),release(){}};
 const ledger=Object.create(Ledger.prototype) as Ledger;
 Object.assign(ledger,{pool:{query:(sql:string,params?:unknown[])=>memory.query(sql,params??[]),connect:async()=>client,end:async()=>{}}});
 return {ledger,memory};
}
async function executionRecoveryOnSubstitute(){
 const {ledger:db,memory}=executionSubstituteLedger(),area=await mkdtemp(join(tmpdir(),'ac-exec-recover-'));
 const repo=join(area,'repo'),spool=join(area,'spool'),accounts=join(area,'accounts');
 for(const path of [repo,spool,accounts])await mkdir(path,{mode:0o700});
 const project=randomUUID(),principal='exec-recover-'+randomUUID(),account=randomUUID(),profile=randomUUID(),context=randomUUID(),instance=randomUUID(),intent=randomUUID(),operation=randomUUID();
 const subject='a'.repeat(64);
 memory.insert('ac_projects',{id:project});memory.insert('ac_memberships',{project_id:project,principal_id:principal,role:'owner'});
 memory.insert('ac_contexts',{id:context,project_id:project,paused:false,archived:false});
 memory.insert('ac_managers',{context_id:context,instance_id:instance,epoch:1,lease_until:Date.now()+60_000});
 memory.insert('ac_admission_control',{id:1,enabled:true});
 memory.insert('ac_intents',{id:intent,context_id:context,principal_id:principal,operation_id:operation});
 const authority=Authority.parse({contextId:context,instanceId:instance,epoch:1});
 const keys=generateKeyPairSync('ed25519'),image='sha256:'+'c'.repeat(64);
 const config={id:'codex-native-execution',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:'d'.repeat(64),socketPath:'/no-operational-docker.sock',accountSubjects:[{accountId:account,subjectDigest:subject}],workerEnv:[],toolsEnv:[]};
 const supervisor=new NativeExecutionSupervisor(db,config);
 const fingerprint=createHash('sha256').update(keys.publicKey.export({format:'der',type:'spki'})).digest('hex');
 const containers=new Map<string,any>(),networks=new Map<string,any>();let creates=0,starts=0,failStop=false,failInspect=false,inspects=0,failAfter=-1;const removed:string[]=[];
 const note=()=>{inspects++;if(failInspect||(failAfter>=0&&inspects>failAfter))throw new Refusal('DOCKER_UNCERTAIN');};
 const docker={
  inspect:async(name:string)=>{note();return containers.get(name)??null;},
  inspectPrivateNetwork:async(id:string)=>{note();return networks.has(id)?networks.get(id):null;},
  stop:async(id:string)=>{if(failStop)throw new Refusal('DOCKER_STOP_UNCERTAIN');const found=[...containers.values()].find(item=>item?.Id===id);if(found)found.State={Status:'exited',Running:false,ExitCode:137,FinishedAt:new Date().toISOString(),StartedAt:'2026-11-03T00:00:00Z',Pid:0};},
  remove:async(id:string)=>{removed.push(id);for(const [name,item] of containers)if(item?.Id===id)containers.set(name,null);},
  create:async()=>{creates++;throw new Refusal('DOCKER_CREATE_UNCERTAIN');},start:async()=>{starts++;throw new Refusal('DOCKER_START_UNCERTAIN');},
  createPrivateNetwork:async()=>{creates++;throw new Refusal('DOCKER_NETWORK_UNCERTAIN');}};
 Object.defineProperty(supervisor,'docker',{value:docker});
 const plant=async(state:'uncertain'|'running',grantState:'reserved'|'uncertain'|'running',options:{jobId?:string;worker?:any;tools?:any;network?:any;networkId?:string|null;workerId?:string|null;toolsId?:string|null;launch?:boolean;operation?:boolean}={})=>{
  const grant=randomUUID(),session=randomUUID(),jobId=options.jobId??randomUUID();
  const input=NativeExecutionRequest.parse({jobId,intentId:intent,grantId:grant,sessionId:session,base:'e'.repeat(40),role:'programmer',task:'synthetic metadata only',writePaths:['src/example.ts']});
  const hash=digest(input);
  memory.insert('ac_capacity_grants',{id:grant,intent_id:intent,context_id:context,manager_epoch:authority.epoch,account_id:account,profile_id:profile,role:'programmer',resource_kind:'model',state:grantState,physical_receipt:null});
  memory.insert('ac_native_execution_jobs',{id:jobId,grant_id:grant,intent_id:intent,context_id:context,manager_epoch:authority.epoch,session_id:session,account_id:account,profile_id:profile,profile_digest:digest({fixture:true}),eligibility_revision:1,executor_digest:supervisor.executorDigest,key_fingerprint:fingerprint,input_digest:hash,base_id:input.base,role:'programmer',state,worker_id:options.workerId??null,tools_id:options.toolsId??null,network_id:options.networkId??null});
  if(options.operation)memory.insert('ac_operations',{id:jobId,intent_id:intent,grant_id:grant,native_session_id:session,manager_epoch:authority.epoch,state:'uncertain'});
  const root=join(spool,jobId);await mkdir(root,{mode:0o700});await mkdir(join(root,'input'),{mode:0o700});await mkdir(join(root,'output'),{mode:0o700});
  const request=join(root,'request.json');await writeFile(request,JSON.stringify(input),{mode:0o600});await chmod(request,0o600);
  if(options.launch){const launch=join(root,'input','launch.json');await writeFile(launch,'{"published":true}\n',{mode:0o600});await chmod(launch,0o600);}
  const labels={'agent-control.job':jobId,'agent-control.launch':hash,'agent-control.contract':'native-execution-v1'};
  if(options.worker){options.worker.Config.Labels=labels;containers.set('ac-native-worker-'+jobId,options.worker);}
  if(options.tools){options.tools.Config.Labels=labels;containers.set('ac-native-tools-'+jobId,options.tools);}
  if(options.networkId)networks.set(options.networkId,options.network??null);
  return {grant,jobId,input};
 };
 const body=(id:string,proc:Record<string,unknown>)=>({Id:id,Image:image,Config:{Labels:{}},State:proc});
 const runningId='f'.repeat(64),toolsId='1'.repeat(64),networkId='2'.repeat(64);
 const running=await plant('running','uncertain',{worker:body(runningId,{Status:'running',Running:true,ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'2026-11-03T00:00:00Z',Pid:4242}),tools:body(toolsId,{Status:'running',Running:true,ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'2026-11-03T00:00:00Z',Pid:4243}),workerId:runningId,toolsId,networkId,network:{Id:networkId,Containers:{}}});
 failStop=true;assert.deepEqual(await supervisor.stop(principal,authority,running.input),{state:'uncertain'});
 assert.equal(memory.one('ac_capacity_grants',running.grant).state,'uncertain');assert.equal(creates,0);assert.equal(starts,0);failStop=false;
 const crashed=await supervisor.recover(principal,authority,running.jobId);
 assert.equal(crashed.state,'uncertain');assert.equal(crashed.interval,'before_terminal_evidence');assert.equal(crashed.grant,'preserved');assert.equal(crashed.replayed,false);assert.equal(removed.length,0);
 const opaque=await plant('uncertain','uncertain',{worker:body('3'.repeat(64),{Status:'created',Running:false,FinishedAt:'0001-01-01T00:00:00Z'}),tools:body('4'.repeat(64),{Status:'created',Running:false,FinishedAt:'0001-01-01T00:00:00Z'}),networkId:'5'.repeat(64),network:{Id:'5'.repeat(64),Containers:{}}});
 const lacked=await supervisor.recover(principal,authority,opaque.jobId);
 assert.equal(lacked.grant,'preserved');assert.equal(removed.length,0);assert.equal(memory.one('ac_capacity_grants',opaque.grant).state,'uncertain');
 const createdWorker='6'.repeat(64),createdTools='7'.repeat(64),keptNetwork='8'.repeat(64);
 const leftover=await plant('uncertain','uncertain',{worker:body(createdWorker,{Status:'created',Running:false,ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'0001-01-01T00:00:00Z',Pid:0}),tools:body(createdTools,{Status:'created',Running:false,ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'0001-01-01T00:00:00Z',Pid:0}),workerId:createdWorker,toolsId:createdTools,networkId:keptNetwork,network:{Id:keptNetwork,Containers:{[createdWorker]:{IPv4Address:'172.20.0.2/16'}}}});
 const kept=await supervisor.recover(principal,authority,leftover.jobId);
 assert.equal(kept.interval,'network_or_container_remains');assert.equal(kept.grant,'preserved');assert.deepEqual(kept.removed.sort(),[createdWorker,createdTools].sort());assert.equal(creates,0);
 assert.equal(memory.one('ac_capacity_grants',leftover.grant).state,'uncertain');
 const goneNetwork='9'.repeat(64);
 const unstarted=await plant('uncertain','uncertain',{networkId:goneNetwork,network:null});
 const unacked=await supervisor.recover(principal,authority,unstarted.jobId);
 assert.equal(unacked.state,'uncertain');assert.equal(unacked.grant,'preserved');assert.equal(unacked.interval,'terminal_evidence_missing');assert.equal(unacked.replayed,false);assert.equal(creates,0);assert.equal(starts,0);
 assert.equal(memory.one('ac_capacity_grants',unstarted.grant).state,'uncertain');assert.equal(memory.one('ac_capacity_grants',unstarted.grant).physical_receipt,null);
 assert.equal((await supervisor.recover(principal,authority,unstarted.jobId)).grant,'preserved');assert.equal(creates,0);
 const provenWorker='81'.repeat(32),provenTools='82'.repeat(32),provenNetwork='83'.repeat(32),createdState={Status:'created',Running:false,ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'0001-01-01T00:00:00Z',Pid:0};
 const proven=await plant('uncertain','uncertain',{worker:body(provenWorker,createdState),tools:body(provenTools,createdState),workerId:provenWorker,toolsId:provenTools,networkId:provenNetwork,network:null});
 const released=await supervisor.recover(principal,authority,proven.jobId);
 assert.equal(released.state,'released_unstarted');assert.equal(released.replayed,false);assert.deepEqual(released.removed.sort(),[provenWorker,provenTools].sort());assert.equal(creates,0);assert.equal(starts,0);
 assert.equal((memory.one('ac_capacity_grants',proven.grant).physical_receipt as {executionStarted:boolean}).executionStarted,false);
 assert.equal((await supervisor.recover(principal,authority,proven.jobId)).state,'released_unstarted');assert.equal(creates,0);
 const lateWorker='8d'.repeat(32),lateNetwork='8c'.repeat(32),lateJob=await plant('uncertain','uncertain',{networkId:lateNetwork,network:null});let workerHits=0;const baseInspect=docker.inspect.bind(docker);
 docker.inspect=async (name:string)=>{if(name!=='ac-native-worker-'+lateJob.jobId)return baseInspect(name);workerHits++;if(workerHits<=2){if(workerHits===2){const appeared=body(lateWorker,createdState);appeared.Config.Labels={'agent-control.job':lateJob.jobId,'agent-control.launch':digest(lateJob.input),'agent-control.contract':'native-execution-v1'};containers.set(name,appeared);}return null;}return containers.get(name)??null;};
 const lateCreate=await supervisor.recover(principal,authority,lateJob.jobId);
 assert.equal(lateCreate.grant,'preserved');assert.equal(lateCreate.state,'uncertain');assert.equal(lateCreate.replayed,false);assert.equal(workerHits>=2,true);assert.equal(removed.includes(lateWorker),false);
 assert.equal(memory.one('ac_capacity_grants',lateJob.grant).state,'uncertain');assert.ok(containers.get('ac-native-worker-'+lateJob.jobId));assert.equal(creates,0);docker.inspect=baseInspect;
 const raceWorker='84'.repeat(32),raceTools='85'.repeat(32),raceNetwork='86'.repeat(32),raceJob=await plant('uncertain','uncertain',{worker:body(raceWorker,createdState),tools:body(raceTools,createdState),workerId:raceWorker,toolsId:raceTools,networkId:raceNetwork,network:null});const removedBeforeRace=removed.length;
 docker.inspect=async (name:string)=>{const live=containers.get(name);if(live&&nativeContainerNeverStarted(live.State)&&(live.Id===raceWorker||live.Id===raceTools)){const shot=structuredClone(live);live.State={Status:'exited',Running:false,ExitCode:0,FinishedAt:new Date().toISOString(),StartedAt:new Date().toISOString(),Pid:0};return shot;}return live??null;};
 const raced=await supervisor.recover(principal,authority,raceJob.jobId);
 assert.equal(raced.interval,'before_terminal_evidence');assert.equal(raced.grant,'preserved');assert.equal(removed.slice(removedBeforeRace).some(id=>id===raceWorker||id===raceTools),false);
 assert.ok(containers.get('ac-native-worker-'+raceJob.jobId));assert.equal(memory.one('ac_capacity_grants',raceJob.grant).state,'uncertain');assert.notEqual((memory.one('ac_capacity_grants',raceJob.grant).physical_receipt as {executionStarted?:boolean}|null)?.executionStarted,false);assert.equal(creates,0);
 docker.inspect=baseInspect;const epochWorker='87'.repeat(32),epochTools='88'.repeat(32),epochNetwork='89'.repeat(32),epochJob=await plant('uncertain','uncertain',{worker:body(epochWorker,createdState),tools:body(epochTools,createdState),workerId:epochWorker,toolsId:epochTools,networkId:epochNetwork,network:null});const removedBeforeEpoch=removed.length;
 docker.inspect=async (name:string)=>{if(name==='ac-native-worker-'+epochJob.jobId)memory.tables.ac_managers[0]!.epoch=9;return baseInspect(name);};
 await assert.rejects(supervisor.recover(principal,authority,epochJob.jobId),/STALE_MANAGER/);
 assert.equal(removed.slice(removedBeforeEpoch).some(id=>id===epochWorker||id===epochTools),false);assert.equal(memory.one('ac_capacity_grants',epochJob.grant).state,'uncertain');assert.equal(creates,0);docker.inspect=baseInspect;
 const unproven=await plant('uncertain','reserved');
 const held=await supervisor.recover(principal,authority,unproven.jobId);
 assert.equal(held.interval,'network_unproven');assert.equal(held.grant,'preserved');assert.equal(memory.one('ac_capacity_grants',unproven.grant).state,'reserved');
 const published=await plant('uncertain','uncertain',{networkId:'a'.repeat(64),network:null,launch:true});
 const publishedRecovery=await supervisor.recover(principal,authority,published.jobId);
 assert.equal(publishedRecovery.interval,'terminal_evidence_missing');assert.equal(publishedRecovery.grant,'preserved');
 const mixedWorker='aa'.repeat(32),mixedTools='bb'.repeat(32),mixedNetwork='bc'.repeat(32);
 const mixed=await plant('uncertain','uncertain',{worker:body(mixedWorker,{Status:'running',Running:true,ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'2026-11-03T00:00:00Z',Pid:9}),tools:body(mixedTools,{Status:'created',Running:false,ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'0001-01-01T00:00:00Z',Pid:0}),workerId:mixedWorker,toolsId:mixedTools,networkId:mixedNetwork,network:{Id:mixedNetwork,Containers:{}}});
 const mixedRecovery=await supervisor.recover(principal,authority,mixed.jobId);
 assert.equal(mixedRecovery.interval,'before_terminal_evidence');assert.equal(mixedRecovery.grant,'preserved');assert.equal(mixedRecovery.removed.length,0);assert.equal(creates,0);
 assert.equal(memory.one('ac_capacity_grants',mixed.grant).state,'uncertain');
 const halfId='cd'.repeat(32);
 const half=await plant('uncertain','reserved',{tools:body(halfId,{Status:'created',Running:false,ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'0001-01-01T00:00:00Z',Pid:0}),workerId:'de'.repeat(32),toolsId:halfId,networkId:'ef'.repeat(32),network:null});
 const halfRecovery=await supervisor.recover(principal,authority,half.jobId);
 assert.equal(halfRecovery.interval,'terminal_evidence_missing');assert.equal(halfRecovery.grant,'preserved');assert.equal(halfRecovery.removed.length,0);
 assert.equal(memory.one('ac_capacity_grants',half.grant).state,'reserved');
 failInspect=true;const blind=await plant('uncertain','uncertain',{networkId:'b'.repeat(64),network:null});
 assert.equal((await supervisor.recover(principal,authority,blind.jobId)).interval,'docker_response_lost');
 assert.equal(memory.one('ac_capacity_grants',blind.grant).state,'uncertain');failInspect=false;
 inspects=0;failAfter=5;const late=await plant('uncertain','uncertain',{networkId:'ab'.repeat(32),network:null});
 const lateRecovery=await supervisor.recover(principal,authority,late.jobId);
 assert.equal(lateRecovery.interval,'docker_response_lost');assert.equal(lateRecovery.grant,'preserved');assert.equal(memory.one('ac_capacity_grants',late.grant).state,'uncertain');assert.equal(creates,0);failAfter=-1;
 const oneSided=await plant('running','uncertain',{worker:body('ac'.repeat(32),{Status:'running',Running:true,Pid:3,StartedAt:'2026-11-03T00:00:00Z',FinishedAt:'0001-01-01T00:00:00Z'}),workerId:'ac'.repeat(32),networkId:networkId});
 assert.deepEqual(await supervisor.stop(principal,authority,oneSided.input),{state:'uncertain'});
 assert.equal(memory.one('ac_capacity_grants',oneSided.grant).state,'uncertain');assert.equal(creates,0);
 const staleManager=memory.tables.ac_managers[0];if(!staleManager)throw Error('manager');
 staleManager.lease_until=Date.now()-1000;
 await assert.rejects(supervisor.recover(principal,authority,running.jobId),/STALE_MANAGER/);
 assert.equal(memory.one('ac_capacity_grants',running.grant).state,'uncertain');
 const next=randomUUID(),manager=memory.tables.ac_managers[0];if(!manager)throw Error('manager');
 manager.instance_id=next;manager.epoch=2;manager.lease_until=Date.now()+60_000;
 const successor=Authority.parse({contextId:context,instanceId:next,epoch:2});
 const other=new NativeExecutionSupervisor(db,{...config,signingKeyPem:generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}).toString()});
 Object.defineProperty(other,'docker',{value:{...docker,create:async()=>{creates++;throw new Refusal('DOCKER_CREATE_UNCERTAIN');}}});
 const foreign=await other.recover(principal,successor,running.jobId);
 assert.equal(foreign.interval,'supervisor_identity');assert.equal(foreign.grant,'preserved');assert.equal(foreign.replayed,false);
 const successorView=await supervisor.recover(principal,successor,running.jobId);
 assert.equal(successorView.state,'uncertain');assert.equal(successorView.grant,'preserved');assert.equal(creates,0);assert.equal(starts,0);
 const exitedWorker='c'.repeat(64),exitedTools='d'.repeat(64);
 const terminal=await plant('running','uncertain',{jobId:operation,worker:body(exitedWorker,{Status:'exited',Running:false,ExitCode:137,FinishedAt:new Date().toISOString(),StartedAt:'2026-11-03T00:00:00Z',Pid:0}),tools:body(exitedTools,{Status:'exited',Running:false,ExitCode:0,FinishedAt:new Date().toISOString(),StartedAt:'2026-11-03T00:00:00Z',Pid:0}),workerId:exitedWorker,toolsId:exitedTools,networkId,operation:true});
 const jobsBefore=memory.tables.ac_native_execution_jobs.length;
 const first=await supervisor.recover(principal,successor,operation);
 assert.equal(first.state,'acknowledged');assert.equal(first.interval,'ack_lost');assert.equal(first.replayed,false);assert.equal(creates,0);assert.equal(starts,0);
 const replay=await supervisor.recover(principal,successor,operation);
 assert.equal(replay.state,'acknowledged');assert.deepEqual(replay.receipt,first.receipt);assert.equal(creates,0);
 assert.equal(memory.one('ac_capacity_grants',terminal.grant).state,'released');
 assert.equal(memory.tables.ac_native_execution_jobs.length,jobsBefore);
 const quietWorker='e'.repeat(64),quietTools='fa'.repeat(32);
 const quiet=await plant('running','uncertain',{worker:body(quietWorker,{Status:'exited',Running:false,ExitCode:0,FinishedAt:new Date().toISOString(),StartedAt:'2026-11-03T00:00:00Z',Pid:0}),tools:body(quietTools,{Status:'exited',Running:false,ExitCode:0,FinishedAt:new Date().toISOString(),StartedAt:'2026-11-03T00:00:00Z',Pid:0}),workerId:quietWorker,toolsId:quietTools,networkId:'ab'.repeat(32)});
 const unresolved=await supervisor.recover(principal,successor,quiet.jobId);
 assert.equal(unresolved.interval,'terminal_evidence_missing');assert.equal(unresolved.grant,'preserved');assert.equal(creates,0);assert.equal(starts,0);
 assert.equal(memory.one('ac_capacity_grants',quiet.grant).state,'uncertain');
 const jobsAfterRecovery=memory.tables.ac_native_execution_jobs.length;
 const processExit=spawnSync(process.execPath,['-e','process.exit(137)'],{timeout:5000});
 assert.equal(processExit.status,137);assert.equal(creates,0);assert.equal(starts,0);assert.equal(memory.tables.ac_native_execution_jobs.length,jobsAfterRecovery);
 await rm(area,{recursive:true,force:true});
}
test('native execution recovery does not replay and keeps a grant without terminal proof',async()=>{
 if(!process.env.AC_TEST_DATABASE_URL){await executionRecoveryOnSubstitute();return;}
 const base=process.env.AC_TEST_DATABASE_URL;
 const fixture=await isolatedDatabase(base,'execrecover'),db=new Ledger(fixture.url),area=await mkdtemp(join(tmpdir(),'ac-exec-recover-'));
 try{
  await db.migrate();const capacity=new Capacity(db),project=randomUUID(),principal='exec-recover-'+randomUUID(),account=randomUUID(),profile=randomUUID();
  const repo=join(area,'repo'),spool=join(area,'spool'),accounts=join(area,'accounts');for(const path of [repo,spool,accounts])await mkdir(path,{mode:0o700});
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'execution recovery']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
  const subject='a'.repeat(64);await capacity.addAccount(principal,project,{id:account,provider:'codex',label:'dormant fixture',resourceIdentity:'codex:'+subject,mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/fixture',maxConcurrent:1});
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'fixture-model','medium','programmer',false)",[profile,account]);
  const context=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),principal]);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
  const keys=generateKeyPairSync('ed25519'),image='sha256:'+'c'.repeat(64);
  const config={id:'codex-native-execution',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:'d'.repeat(64),socketPath:'/no-operational-docker.sock',accountSubjects:[{accountId:account,subjectDigest:subject}],workerEnv:[],toolsEnv:[]};
  const supervisor=new NativeExecutionSupervisor(db,config);
  const fingerprint=createHash('sha256').update(keys.publicKey.export({format:'der',type:'spki'})).digest('hex');
  const containers=new Map<string,any>(),networks=new Map<string,any>();let creates=0,starts=0,failStop=false,failInspect=false;const removed:string[]=[];
  const docker={
   inspect:async(name:string)=>{if(failInspect)throw new Refusal('DOCKER_UNCERTAIN');return containers.get(name)??null;},
   inspectPrivateNetwork:async(id:string)=>{if(failInspect)throw new Refusal('DOCKER_NETWORK_UNCERTAIN');return networks.has(id)?networks.get(id):null;},
   stop:async(id:string)=>{if(failStop)throw new Refusal('DOCKER_STOP_UNCERTAIN');const found=[...containers.values()].find(item=>item?.Id===id);if(found)found.State={Status:'exited',Running:false,ExitCode:137,FinishedAt:new Date().toISOString(),StartedAt:'2026-11-03T00:00:00Z',Pid:0};},
   remove:async(id:string)=>{removed.push(id);for(const [name,item] of containers)if(item?.Id===id)containers.set(name,null);},
   create:async()=>{creates++;throw new Refusal('DOCKER_CREATE_UNCERTAIN');},start:async()=>{starts++;throw new Refusal('DOCKER_START_UNCERTAIN');},
   createPrivateNetwork:async()=>{creates++;throw new Refusal('DOCKER_NETWORK_UNCERTAIN');}};
  Object.defineProperty(supervisor,'docker',{value:docker});
  const plant=async(state:'uncertain'|'running',grantState:'reserved'|'uncertain'|'running',options:{jobId?:string;worker?:any;tools?:any;network?:any;networkId?:string|null;workerId?:string|null;toolsId?:string|null;launch?:boolean}={})=>{
   const grant=randomUUID(),session=randomUUID(),jobId=options.jobId??randomUUID();
   const input=NativeExecutionRequest.parse({jobId,intentId:intent.id,grantId:grant,sessionId:session,base:'e'.repeat(40),role:'programmer',task:'synthetic metadata only',writePaths:['src/example.ts']});
   const hash=digest(input);
   await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
    VALUES($1,$2,$3,$4,$5,$6,$7,'programmer',$8,1,1,$9,false,$10)`,[grant,randomUUID(),intent.id,context,authority.epoch,account,profile,project,hash,grantState]);
   await db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state,worker_id,tools_id,network_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,'programmer',$14,$15,$16,$17)`,[jobId,grant,intent.id,context,authority.epoch,session,account,profile,digest({fixture:true}),supervisor.executorDigest,fingerprint,hash,input.base,state,options.workerId??null,options.toolsId??null,options.networkId??null]);
   const root=join(spool,jobId);await mkdir(root,{mode:0o700});await mkdir(join(root,'input'),{mode:0o700});await mkdir(join(root,'output'),{mode:0o700});
   await writeFile(join(root,'request.json'),JSON.stringify(input),{mode:0o600});
   if(options.launch)await writeFile(join(root,'input','launch.json'),'{"published":true}\n',{mode:0o600});
   const labels={'agent-control.job':jobId,'agent-control.launch':hash,'agent-control.contract':'native-execution-v1'};
   if(options.worker){options.worker.Config.Labels=labels;containers.set('ac-native-worker-'+jobId,options.worker);} 
   if(options.tools){options.tools.Config.Labels=labels;containers.set('ac-native-tools-'+jobId,options.tools);} 
   if(options.networkId)networks.set(options.networkId,options.network??null);
   return {grant,jobId,input};
  };
  const body=(id:string,proc:Record<string,unknown>)=>({Id:id,Image:image,Config:{Labels:{}},State:proc});
  const runningId='f'.repeat(64),toolsId='1'.repeat(64),networkId='2'.repeat(64);
  const running=await plant('running','uncertain',{worker:body(runningId,{Status:'running',Running:true,ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'2026-11-03T00:00:00Z',Pid:4242}),tools:body(toolsId,{Status:'running',Running:true,ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'2026-11-03T00:00:00Z',Pid:4243}),workerId:runningId,toolsId,networkId,network:{Id:networkId,Containers:{}}});
  failStop=true;assert.deepEqual(await supervisor.stop(principal,authority,running.input),{state:'uncertain'});
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[running.grant])).rows[0].state,'uncertain');assert.equal(creates,0);assert.equal(starts,0);failStop=false;
  const crashed=await supervisor.recover(principal,authority,running.jobId);
  assert.equal(crashed.state,'uncertain');assert.equal(crashed.interval,'before_terminal_evidence');assert.equal(crashed.grant,'preserved');assert.equal(crashed.replayed,false);assert.equal(removed.length,0);
  const opaque=await plant('uncertain','uncertain',{worker:body('3'.repeat(64),{Status:'created',Running:false,FinishedAt:'0001-01-01T00:00:00Z'}),tools:body('4'.repeat(64),{Status:'created',Running:false,FinishedAt:'0001-01-01T00:00:00Z'}),networkId:'5'.repeat(64),network:{Id:'5'.repeat(64),Containers:{}}});
  const lacked=await supervisor.recover(principal,authority,opaque.jobId);
  assert.equal(lacked.grant,'preserved');assert.equal(removed.length,0);assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[opaque.grant])).rows[0].state,'uncertain');
  const createdWorker='6'.repeat(64),createdTools='7'.repeat(64),keptNetwork='8'.repeat(64);
  const leftover=await plant('uncertain','uncertain',{worker:body(createdWorker,{Status:'created',Running:false,ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'0001-01-01T00:00:00Z',Pid:0}),tools:body(createdTools,{Status:'created',Running:false,ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'0001-01-01T00:00:00Z',Pid:0}),workerId:createdWorker,toolsId:createdTools,networkId:keptNetwork,network:{Id:keptNetwork,Containers:{[createdWorker]:{IPv4Address:'172.20.0.2/16'}}}});
  const kept=await supervisor.recover(principal,authority,leftover.jobId);
  assert.equal(kept.interval,'network_or_container_remains');assert.equal(kept.grant,'preserved');assert.deepEqual(kept.removed.sort(),[createdWorker,createdTools].sort());assert.equal(creates,0);
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[leftover.grant])).rows[0].state,'uncertain');
  const goneNetwork='9'.repeat(64);
  const unstarted=await plant('uncertain','uncertain',{networkId:goneNetwork,network:null});
  const unacked=await supervisor.recover(principal,authority,unstarted.jobId);
  assert.equal(unacked.state,'uncertain');assert.equal(unacked.grant,'preserved');assert.equal(unacked.interval,'terminal_evidence_missing');assert.equal(unacked.replayed,false);assert.equal(creates,0);assert.equal(starts,0);
  assert.equal((await db.pool.query('SELECT state,physical_receipt FROM ac_capacity_grants WHERE id=$1',[unstarted.grant])).rows[0].state,'uncertain');
  assert.equal((await supervisor.recover(principal,authority,unstarted.jobId)).grant,'preserved');assert.equal(creates,0);
  const provenWorker='81'.repeat(32),provenTools='82'.repeat(32),provenNetwork='83'.repeat(32),createdState={Status:'created',Running:false,ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'0001-01-01T00:00:00Z',Pid:0};
  const proven=await plant('uncertain','uncertain',{worker:body(provenWorker,createdState),tools:body(provenTools,createdState),workerId:provenWorker,toolsId:provenTools,networkId:provenNetwork,network:null});
  const released=await supervisor.recover(principal,authority,proven.jobId);
  assert.equal(released.state,'released_unstarted');assert.equal(released.replayed,false);assert.deepEqual([...released.removed].sort(),[provenWorker,provenTools].sort());assert.equal(creates,0);assert.equal(starts,0);
  assert.equal((await db.pool.query('SELECT physical_receipt FROM ac_capacity_grants WHERE id=$1',[proven.grant])).rows[0].physical_receipt.executionStarted,false);
  assert.equal((await supervisor.recover(principal,authority,proven.jobId)).state,'released_unstarted');assert.equal(creates,0);
  const unproven=await plant('uncertain','reserved');
  const held=await supervisor.recover(principal,authority,unproven.jobId);
  assert.equal(held.interval,'network_unproven');assert.equal(held.grant,'preserved');assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[unproven.grant])).rows[0].state,'reserved');
  const published=await plant('uncertain','uncertain',{networkId:'a'.repeat(64),network:null,launch:true});
  const publishedRecovery=await supervisor.recover(principal,authority,published.jobId);
  assert.equal(publishedRecovery.interval,'terminal_evidence_missing');assert.equal(publishedRecovery.grant,'preserved');
  failInspect=true;const blind=await plant('uncertain','uncertain',{networkId:'b'.repeat(64),network:null});
  assert.equal((await supervisor.recover(principal,authority,blind.jobId)).interval,'docker_response_lost');
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[blind.grant])).rows[0].state,'uncertain');failInspect=false;
  await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);
  const successor=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  await assert.rejects(supervisor.recover(principal,authority,running.jobId),/STALE_MANAGER/);
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[running.grant])).rows[0].state,'uncertain');
  const other=new NativeExecutionSupervisor(db,{...config,signingKeyPem:generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}).toString()});
  Object.defineProperty(other,'docker',{value:{...docker,create:async()=>{creates++;throw new Refusal('DOCKER_CREATE_UNCERTAIN');}}});
  const foreign=await other.recover(principal,successor,running.jobId);
  assert.equal(foreign.interval,'supervisor_identity');assert.equal(foreign.grant,'preserved');assert.equal(foreign.replayed,false);
  const successorView=await supervisor.recover(principal,successor,running.jobId);
  assert.equal(successorView.state,'uncertain');assert.equal(successorView.grant,'preserved');assert.equal(creates,0);assert.equal(starts,0);
  const exitedWorker='c'.repeat(64),exitedTools='d'.repeat(64);
  const terminal=await plant('running','uncertain',{jobId:intent.operation_id,worker:body(exitedWorker,{Status:'exited',Running:false,ExitCode:137,FinishedAt:new Date().toISOString(),StartedAt:'2026-11-03T00:00:00Z',Pid:0}),tools:body(exitedTools,{Status:'exited',Running:false,ExitCode:0,FinishedAt:new Date().toISOString(),StartedAt:'2026-11-03T00:00:00Z',Pid:0}),workerId:exitedWorker,toolsId:exitedTools,networkId:networkId});
  await db.pool.query("UPDATE ac_operations SET state='uncertain',grant_id=$2,native_session_id=$3 WHERE id=$1",[intent.operation_id,terminal.grant,terminal.input.sessionId]);
  const first=await supervisor.recover(principal,successor,intent.operation_id);
  assert.equal(first.state,'acknowledged');assert.equal(first.interval,'ack_lost');assert.equal(first.replayed,false);assert.equal(creates,0);assert.equal(starts,0);
  const replay=await supervisor.recover(principal,successor,intent.operation_id);
  assert.equal(replay.state,'acknowledged');assert.deepEqual(replay.receipt,first.receipt);assert.equal(creates,0);
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[terminal.grant])).rows[0].state,'released');
  const quietWorker='e'.repeat(64),quietTools='f'.repeat(64);
  const quiet=await plant('running','uncertain',{worker:body(quietWorker,{Status:'exited',Running:false,ExitCode:0,FinishedAt:new Date().toISOString(),StartedAt:'2026-11-03T00:00:00Z',Pid:0}),tools:body(quietTools,{Status:'exited',Running:false,ExitCode:0,FinishedAt:new Date().toISOString(),StartedAt:'2026-11-03T00:00:00Z',Pid:0}),workerId:quietWorker,toolsId:quietTools,networkId:'ab'.repeat(32)});
  const unresolved=await supervisor.recover(principal,successor,quiet.jobId);
  assert.equal(unresolved.interval,'terminal_evidence_missing');assert.equal(unresolved.grant,'preserved');assert.equal(creates,0);assert.equal(starts,0);
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[quiet.grant])).rows[0].state,'uncertain');
 }finally{await db.close();await fixture.close();await rm(area,{recursive:true,force:true});}
});

test('native execution recovery stops running tools after the worker exits and keeps the grant until both are terminal',async()=>{
 const {ledger:db,memory}=executionSubstituteLedger(),area=await mkdtemp(join(tmpdir(),'ac-exec-tools-boundary-'));
 const repo=join(area,'repo'),spool=join(area,'spool'),accounts=join(area,'accounts');
 for(const path of [repo,spool,accounts]){await mkdir(path,{mode:0o700});await chmod(path,0o700);}
 const project=randomUUID(),principal='exec-tools-'+randomUUID(),account=randomUUID(),profile=randomUUID(),context=randomUUID(),instance=randomUUID(),intent=randomUUID();
 memory.insert('ac_projects',{id:project});memory.insert('ac_memberships',{project_id:project,principal_id:principal,role:'owner'});
 memory.insert('ac_contexts',{id:context,project_id:project,paused:false,archived:false});
 memory.insert('ac_managers',{context_id:context,instance_id:instance,epoch:1,lease_until:Date.now()+60_000});
 memory.insert('ac_admission_control',{id:1,enabled:true});
 memory.insert('ac_intents',{id:intent,context_id:context,principal_id:principal});
 const authority=Authority.parse({contextId:context,instanceId:instance,epoch:1});
 const keys=generateKeyPairSync('ed25519'),image='sha256:'+'c'.repeat(64);
 const config={id:'codex-native-execution',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:'d'.repeat(64),socketPath:'/no-operational-docker.sock',accountSubjects:[{accountId:account,subjectDigest:'a'.repeat(64)}],workerEnv:[],toolsEnv:[]};
 const supervisor=new NativeExecutionSupervisor(db,config,{assertAdmission:async()=>{}});
 const fingerprint=createHash('sha256').update(keys.publicKey.export({format:'der',type:'spki'})).digest('hex');
 const jobId=randomUUID(),grant=randomUUID(),session=randomUUID();
 const input=NativeExecutionRequest.parse({jobId,intentId:intent,grantId:grant,sessionId:session,base:'e'.repeat(40),role:'programmer',task:'synthetic metadata only',writePaths:['src/example.ts']});
 const hash=digest(input),workerId='f'.repeat(64),toolsId='1'.repeat(64);
 memory.insert('ac_capacity_grants',{id:grant,intent_id:intent,context_id:context,manager_epoch:authority.epoch,account_id:account,profile_id:profile,role:'programmer',resource_kind:'model',state:'uncertain',physical_receipt:null});
 memory.insert('ac_native_execution_jobs',{id:jobId,grant_id:grant,intent_id:intent,context_id:context,manager_epoch:authority.epoch,session_id:session,account_id:account,profile_id:profile,profile_digest:digest({fixture:true}),eligibility_revision:1,executor_digest:supervisor.executorDigest,key_fingerprint:fingerprint,input_digest:hash,base_id:input.base,role:'programmer',state:'running',worker_id:workerId,tools_id:toolsId,network_id:'2'.repeat(64),receipt:null});
 memory.insert('ac_operations',{id:jobId,intent_id:intent,grant_id:grant,native_session_id:session,manager_epoch:authority.epoch,state:'uncertain'});
 const root=join(spool,jobId);await mkdir(root,{mode:0o700});await chmod(root,0o700);await mkdir(join(root,'output'),{mode:0o700});await chmod(join(root,'output'),0o700);
 const request=join(root,'request.json');await writeFile(request,JSON.stringify(input),{mode:0o600});await chmod(request,0o600);
 const labels={'agent-control.job':jobId,'agent-control.launch':hash,'agent-control.contract':'native-execution-v1'};
 const containers=new Map<string,any>([
  ['ac-native-worker-'+jobId,{Id:workerId,Image:image,Config:{Labels:labels},State:{Status:'exited',Running:false,ExitCode:137,FinishedAt:new Date().toISOString(),StartedAt:'2026-11-03T00:00:00Z',Pid:0}}],
  ['ac-native-tools-'+jobId,{Id:toolsId,Image:image,Config:{Labels:labels},State:{Status:'running',Running:true,ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'2026-11-03T00:00:00Z',Pid:8}}],
 ]);
 let creates=0,starts=0,stopAttempts=0,failStop=true;const removed:string[]=[];
 const docker={
  inspect:async(name:string)=>containers.get(name)??null,
  inspectPrivateNetwork:async()=>null,
  stop:async(id:string)=>{stopAttempts++;if(failStop)throw new Refusal('DOCKER_STOP_UNCERTAIN');const found=[...containers.values()].find(item=>item?.Id===id);if(found)found.State={Status:'exited',Running:false,ExitCode:137,FinishedAt:new Date().toISOString(),StartedAt:'2026-11-03T00:00:00Z',Pid:0};},
  remove:async(id:string)=>{removed.push(id);},
  create:async()=>{creates++;throw new Refusal('DOCKER_CREATE_UNCERTAIN');},
  start:async()=>{starts++;throw new Refusal('DOCKER_START_UNCERTAIN');},
  createPrivateNetwork:async()=>{creates++;throw new Refusal('DOCKER_NETWORK_UNCERTAIN');}};
 Object.defineProperty(supervisor,'docker',{value:docker});
 try{
  const jobs=memory.tables.ac_native_execution_jobs.length;
  const lost=await supervisor.recover(principal,authority,jobId);
  assert.equal(lost.state,'uncertain');assert.equal(lost.grant,'preserved');assert.equal(lost.replayed,false);assert.equal(stopAttempts,1);assert.equal(creates,0);assert.equal(starts,0);assert.equal(removed.length,0);
  assert.equal(containers.get('ac-native-tools-'+jobId).State.Running,true);assert.equal(memory.one('ac_capacity_grants',grant).state,'uncertain');assert.equal(memory.one('ac_capacity_grants',grant).physical_receipt,null);
  failStop=false;
  const stopped=await supervisor.recover(principal,authority,jobId);
  assert.equal(stopped.state,'uncertain');assert.equal(stopped.grant,'preserved');assert.equal(stopped.replayed,false);assert.equal(stopAttempts,2);assert.equal(creates,0);assert.equal(starts,0);
  assert.equal(containers.get('ac-native-tools-'+jobId).State.Status,'exited');assert.equal(memory.one('ac_capacity_grants',grant).state,'uncertain');
  const successor=new NativeExecutionSupervisor(db,config,{assertAdmission:async()=>{}});Object.defineProperty(successor,'docker',{value:docker});
  const acknowledged=await successor.recover(principal,authority,jobId);
  assert.equal(acknowledged.state,'acknowledged');assert.equal(acknowledged.interval,'ack_lost');assert.equal(acknowledged.grant,'released');assert.equal(acknowledged.replayed,false);
  assert.equal(creates,0);assert.equal(starts,0);assert.equal(stopAttempts,2);assert.equal(removed.length,0);
  assert.equal(memory.one('ac_capacity_grants',grant).state,'released');assert.equal(memory.tables.ac_native_execution_jobs.length,jobs);
  const replay=await successor.recover(principal,authority,jobId);
  assert.equal(replay.state,'acknowledged');assert.deepEqual(replay.receipt,acknowledged.receipt);assert.equal(creates,0);assert.equal(starts,0);
 }finally{await rm(area,{recursive:true,force:true});}
});

test('native execution recovery interrupts an in-flight create or start and lets the successor read the same journal',async()=>{
 const {ledger:db,memory}=executionSubstituteLedger(),area=await mkdtemp(join(tmpdir(),'ac-exec-launch-boundary-'));
 const repo=join(area,'repo'),spool=join(area,'spool'),accounts=join(area,'accounts');
 for(const path of [repo,spool,accounts]){await mkdir(path,{mode:0o700});await chmod(path,0o700);}
 const project=randomUUID(),principal='exec-boundary-'+randomUUID(),account=randomUUID(),profile=randomUUID(),context=randomUUID(),instance=randomUUID(),intent=randomUUID();
 memory.insert('ac_projects',{id:project});memory.insert('ac_memberships',{project_id:project,principal_id:principal,role:'owner'});
 memory.insert('ac_contexts',{id:context,project_id:project,paused:false,archived:false});
 memory.insert('ac_managers',{context_id:context,instance_id:instance,epoch:1,lease_until:Date.now()+60_000});
 memory.insert('ac_admission_control',{id:1,enabled:true});
 memory.insert('ac_intents',{id:intent,context_id:context,principal_id:principal});
 const authority=Authority.parse({contextId:context,instanceId:instance,epoch:1});
 const keys=generateKeyPairSync('ed25519'),image='sha256:'+'c'.repeat(64);
 const config={id:'codex-native-execution',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:'d'.repeat(64),socketPath:'/no-operational-docker.sock',accountSubjects:[{accountId:account,subjectDigest:'a'.repeat(64)}],workerEnv:[],toolsEnv:[]};
 const supervisor=new NativeExecutionSupervisor(db,config,{assertAdmission:async()=>{}});
 (supervisor as unknown as {identity:(client:unknown,principal:string,authority:unknown,input:{grantId:string})=>Promise<Record<string,unknown>>}).identity=async(_client,_principal,_authority,input)=>memory.one('ac_capacity_grants',input.grantId);
 const containers=new Map<string,any>(),networks=new Map<string,any>();let creates=0,starts=0,phase='idle',inspectsDuringHold=0;let mode:'hold-network'|'hold-start'|'hold-start-running'='hold-network';const removed:string[]=[];
 let open:(value?:unknown)=>void=()=>{},fail:(error?:unknown)=>void=()=>{},entered=()=>{};
 let barrier=new Promise((resolve,reject)=>{open=resolve;fail=reject;});
 let arrived=new Promise<void>(resolve=>{entered=resolve;});
 const arm=()=>{barrier=new Promise((resolve,reject)=>{open=resolve;fail=reject;});arrived=new Promise<void>(resolve=>{entered=resolve;});phase='idle';inspectsDuringHold=0;};
 let sequence=0;const nextId=()=>`${(++sequence).toString(16).padStart(2,'0')}${'cd'.repeat(31)}`;
 const createdState={Status:'created',Running:false,ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:'0001-01-01T00:00:00Z',Pid:0};
 const docker={
  inspect:async(name:string)=>{if(phase==='network-held'||phase==='start-held')inspectsDuringHold++;return containers.get(name)??null;},
  inspectPrivateNetwork:async(id:string)=>networks.has(id)?networks.get(id):null,
  stop:async()=>{throw new Refusal('DOCKER_STOP_UNEXPECTED');},
  remove:async(id:string)=>{removed.push(id);for(const [name,item] of containers)if(item?.Id===id)containers.set(name,null);},
  createPrivateNetwork:async()=>{creates++;if(mode==='hold-network'){phase='network-held';entered();await barrier;throw new Refusal('DOCKER_NETWORK_UNCERTAIN');}const id=nextId();networks.set(id,null);return id;},
  create:async(name:string,configuration:any)=>{creates++;const id=nextId();containers.set(name,{Id:id,Image:configuration.Image,Config:{Labels:configuration.Labels},State:{...createdState}});return id;},
  start:async(id:string)=>{starts++;const found=[...containers.values()].find(item=>item?.Id===id);
   if(mode==='hold-start'||mode==='hold-start-running'){phase='start-held';entered();await barrier;if(mode==='hold-start-running'&&found)found.State={Status:'running',Running:true,ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',StartedAt:new Date().toISOString(),Pid:9};throw new Refusal('DOCKER_START_UNCERTAIN');}
   throw new Refusal('DOCKER_START_UNCERTAIN');}};
 Object.defineProperty(supervisor,'docker',{value:docker});
 const viewed=mock.method(ProviderEligibility.prototype,'view',async()=>({accountId:account,latest:{fresh:true,effectiveStatus:'documented_supported',authenticationMode:'subscription_oauth',executionMode:'central_isolated_cli',adapterId:config.id,adapterVersion:supervisor.executorDigest,revision:1},history:[]}));
 const homes=mock.method(AccountHomes.prototype,'inspectGranted',async()=>({accountId:account,projectId:project,ownerId:principal,uid:'1',device:'1',inode:'1'}));
 const snaps=mock.method(GitArtifacts.prototype,'snapshot',async()=>({}));
 const prepare=(jobId:string)=>{
  const grantId=randomUUID(),sessionId=randomUUID();
  memory.insert('ac_capacity_grants',{id:grantId,intent_id:intent,context_id:context,project_id:project,manager_epoch:authority.epoch,account_id:account,profile_id:profile,role:'programmer',model:'fixture-model',effort:'medium',resource_kind:'model',state:'reserved',physical_receipt:null});
  return {grantId,input:NativeExecutionRequest.parse({jobId,intentId:intent,grantId,sessionId,base:'e'.repeat(40),role:'programmer',task:'synthetic metadata only',writePaths:['src/example.ts']})};
 };
 const hold=async(launch:Promise<unknown>,jobId:string)=>{
  await arrived;const queued=supervisor.recover(principal,authority,jobId);let settled=false;const observed=queued.then(value=>{settled=true;return value;});
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(settled,false);assert.equal(inspectsDuringHold,0);
  phase='idle';open();
  await assert.rejects(launch,/DOCKER_(NETWORK|START)_UNCERTAIN/);
  return observed;
 };
 try{
  mode='hold-network';const lostJob=randomUUID(),lost=prepare(lostJob);
  const lostRecovery=await hold(supervisor.start(principal,authority,lost.input),lostJob);
  assert.equal(lostRecovery.state,'uncertain');assert.equal(lostRecovery.interval,'network_unproven');assert.equal(lostRecovery.grant,'preserved');assert.equal(lostRecovery.replayed,false);
  assert.equal(creates,1);assert.equal(starts,0);assert.equal(removed.length,0);assert.equal(memory.one('ac_capacity_grants',lost.grantId).state,'uncertain');assert.equal(memory.one('ac_capacity_grants',lost.grantId).physical_receipt,null);
  const successor=new NativeExecutionSupervisor(db,config,{assertAdmission:async()=>{}});Object.defineProperty(successor,'docker',{value:docker});
  const lostAgain=await successor.recover(principal,authority,lostJob);
  assert.equal(lostAgain.grant,'preserved');assert.equal(lostAgain.interval,'network_unproven');assert.equal(lostAgain.replayed,false);assert.equal(creates,1);assert.equal(starts,0);
  assert.equal(memory.tables.ac_native_execution_jobs.filter(row=>row.id===lostJob).length,1);
  arm();mode='hold-start-running';const runningJob=randomUUID(),running=prepare(runningJob);
  const runningRecovery=await hold(supervisor.start(principal,authority,running.input),runningJob);
  assert.equal(runningRecovery.interval,'before_terminal_evidence');assert.equal(runningRecovery.grant,'preserved');assert.equal(runningRecovery.replayed,false);assert.equal(removed.length,0);
  assert.equal(memory.one('ac_capacity_grants',running.grantId).state,'uncertain');assert.notEqual((memory.one('ac_capacity_grants',running.grantId).physical_receipt as {executionStarted?:boolean}|null)?.executionStarted,false);
  const createsAfterRun=creates,startsAfterRun=starts;
  const runningAgain=await successor.recover(principal,authority,runningJob);
  assert.equal(runningAgain.grant,'preserved');assert.equal(runningAgain.replayed,false);assert.equal(creates,createsAfterRun);assert.equal(starts,startsAfterRun);assert.equal(removed.length,0);
  arm();mode='hold-start';const freshJob=randomUUID(),fresh=prepare(freshJob);const beforeRelease=creates;
  const released=await hold(supervisor.start(principal,authority,fresh.input),freshJob);
  assert.equal(released.state,'released_unstarted');assert.equal(released.interval,'proven_not_started');assert.equal(released.grant,'released');assert.equal(released.replayed,false);
  assert.equal((memory.one('ac_capacity_grants',fresh.grantId).physical_receipt as {executionStarted:boolean}).executionStarted,false);
  assert.equal(creates,beforeRelease+3);assert.equal(starts,startsAfterRun+1);
  const releasedAgain=await successor.recover(principal,authority,freshJob);
  assert.equal(releasedAgain.state,'released_unstarted');assert.equal(releasedAgain.replayed,false);assert.equal(creates,beforeRelease+3);assert.equal(starts,startsAfterRun+1);
 }finally{viewed.mock.restore();homes.mock.restore();snaps.mock.restore();await rm(area,{recursive:true,force:true});}
});
