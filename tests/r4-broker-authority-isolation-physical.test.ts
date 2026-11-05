import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {execFileSync,spawn,type ChildProcess} from 'node:child_process';
import {chmod,mkdir,mkdtemp,readFile,rm,writeFile,readlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {serve} from '@hono/node-server';
import pg from 'pg';
import {Ledger} from '../src/ledger.ts';
import {brokerMain} from '../src/sandbox-broker.ts';
import {SandboxClient} from '../src/sandbox-client.ts';
import {BrowserSessions} from '../src/sessions.ts';
import {createProjectGateway} from '../src/projects-api.ts';
import {ProjectEnvironments} from '../src/project-environments.ts';
import {ProjectAdmin} from '../src/project-admin.ts';
import {createProjectAdminApi} from '../src/project-admin-api.ts';
import {createProjectEnvironmentApi} from '../src/project-environments-api.ts';
import {Operators,operatorMessage} from '../src/operator.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';
import type {Authority} from '../src/contracts.ts';
const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000}).trim();
async function wait(check:()=>Promise<boolean>,label:string){for(let i=0;i<240;i++){if(await check())return;await new Promise(r=>setTimeout(r,100))}throw Error(label)}
async function stop(child:ChildProcess|undefined){if(!child||child.exitCode!==null)return;const exited=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGTERM');await exited}

test('two real broker workers attack central authority while signed owner environment administration succeeds',{timeout:120000},async()=>{
 if(process.env.AC_R4_BROKER_ISOLATION!=='1')throw Error('DISPOSABLE_BROKER_ISOLATION_OPT_IN_REQUIRED');
 if(process.getuid?.()!==0)throw Error('DISPOSABLE_BROKER_CONTROLLER_ROOT_REQUIRED');
 const id=randomUUID(),label='r4-broker-isolation-'+id,pgName='ac-'+label;
 const area=await mkdtemp(join(tmpdir(),'ac-'+label+'-'));
 const workerImage=docker('image','inspect','node:22-alpine','--format','{{.Id}}');assert.match(workerImage,/^sha256:[a-f0-9]{64}$/);
 let db:Ledger|undefined,broker:Awaited<ReturnType<typeof brokerMain>>|undefined,server:ReturnType<typeof serve>|undefined,heartbeat:ChildProcess|undefined,pgStarted=false,primary:unknown,lockLossChild:ChildProcess|undefined;
 const jobs:{jobId:string;grantId:string;authority:Authority;work:string}[]=[];
 try{
  docker('run','-d','--name',pgName,'--label',`agent-control.disposable=${label}`,'--tmpfs','/var/lib/postgresql/data','-p','127.0.0.1::5432','-e','POSTGRES_USER=ac_test','-e','POSTGRES_PASSWORD=synthetic-only','-e','POSTGRES_DB=ac_implementation_test','postgres:16-alpine');pgStarted=true;
  const port=Number(docker('inspect','--format','{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',pgName));
  const database=`postgresql://ac_test:synthetic-only@127.0.0.1:${port}/ac_implementation_test`;
  await wait(async()=>{const c=new pg.Client({connectionString:database,connectionTimeoutMillis:200});try{await c.connect();return true}catch{return false}finally{await c.end().catch(()=>{})}},'DISPOSABLE_PG_READY');
  db=new Ledger(database);await db.migrate();
  const principal='synthetic-owner-'+id,foreign='synthetic-foreign-'+id,project=randomUUID(),workerProject=randomUUID(),otherProject=randomUUID(),deviceId=randomUUID(),keys=generateKeyPairSync('ed25519');
  const projectsRoot=join(area,'projects'),repo=join(projectsRoot,'authorized'),spool=join(area,'spool'),control=join(area,'control');
  for(const path of [repo,spool,control])await mkdir(path,{recursive:true,mode:0o700});
  const git=(...args:string[])=>execFileSync('git',['-c','safe.directory='+repo,'-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q','-b','main');git('config','user.name','Synthetic isolation lab');git('config','user.email','fixture@example.invalid');await mkdir(join(repo,'src'));await writeFile(join(repo,'src/fixture.txt'),'legitimate tracked source\n');git('add','.');git('commit','-qm','synthetic base');git('branch','protected');const originalCommit=git('rev-parse','protected');
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2),($3,$4)',[project,'isolated owner project',otherProject,'isolated foreign project']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner'),($3,$4,'owner')",[project,principal,otherProject,foreign]);
  await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[workerProject,'isolated worker project']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[workerProject,principal]);
  const workerRepo=join(projectsRoot,'workers');execFileSync('git',['clone','-q',repo,workerRepo]);execFileSync('git',['-C',workerRepo,'branch','protected']);await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[workerProject,workerRepo]);
  const capacity=await provisionCapacity(db,principal,workerProject);
  await new Operators(db).enroll('synthetic-capacity-administrator',principal,deviceId,keys.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const administratorsBefore=(await db.pool.query('SELECT principal_id FROM ac_control_admins ORDER BY principal_id')).rows;assert.equal(administratorsBefore.some(row=>row.principal_id===principal),false);
  const installationId=(await db.pool.query('SELECT id FROM ac_installation_identity')).rows[0].id;
  const configCanary='SYNTHETIC_CENTRAL_'+randomUUID(),accountCanary='SYNTHETIC_ACCOUNT_'+randomUUID();
  const centralFile=join(control,'central-authority-canary'),accountFile=join(control,'synthetic-account-canary');await writeFile(centralFile,configCanary,{mode:0o600});await writeFile(accountFile,accountCanary,{mode:0o600});
  const heartbeatFile=join(control,'heartbeat');heartbeat=spawn(process.execPath,['-e',"const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),50)",heartbeatFile],{stdio:'ignore'});assert(heartbeat.pid);
  await wait(async()=>{try{return (await readFile(heartbeatFile)).length>0}catch{return false}},'HOST_PROCESS_READY');
  // Upstream bearer verification is explicitly synthetic. Cookie storage/revalidation,
  // global gateway dispatch, operator signature, membership and CAS are production code.
  const ownerToken=randomBytes(32).toString('hex');let origin='';
  // Port0 is resolved before constructing the origin-bound real session service.
  let authenticatedSessions:BrowserSessions|undefined;
  const gateway=createProjectGateway({projects:{} as never,runtimes:{} as never,defaultProjectId:project,appFor:()=>{throw Error('UNEXPECTED_PROJECT_RUNTIME')},publicFetch:async()=>Response.json({error:'NOT_EXPOSED'},{status:404}),projectAdmin:createProjectAdminApi(new ProjectAdmin(db,[{id:'lab',label:'Synthetic allowed roots',path:projectsRoot}],control)),projectEnvironments:createProjectEnvironmentApi(new ProjectEnvironments(db,[{id:'lab',path:projectsRoot}],control)),authenticate:async request=>{const owner=await authenticatedSessions!.authenticate(request);if(owner)authenticatedSessions!.checkOrigin(request);return owner}});
  server=serve({fetch:gateway,hostname:'127.0.0.1',port:0});await new Promise<void>(r=>server!.listening?r():server!.once('listening',r));const address=server.address();assert(address&&typeof address==='object');origin=`http://127.0.0.1:${address.port}`;
  authenticatedSessions=new BrowserSessions(db,randomBytes(32),async req=>req.headers.get('authorization')==='Bearer '+ownerToken?principal:null,{origin,secure:false,maxAgeSeconds:60});
  const issued=await authenticatedSessions.issue(new Request(origin+'/api/v1/ac/auth/session',{method:'POST',headers:{authorization:'Bearer '+ownerToken,origin}}));const cookie=issued.headers.get('set-cookie')!.split(';')[0]!;
  const probePath=join(area,'hostile-probe.mjs'),probe=await readFile(new URL('./fixtures/r4-broker-hostile-probe.mjs',import.meta.url));await writeFile(probePath,probe,{mode:0o644});
  const brokerConfig={databaseUrl:database,hostRoot:spool,probeHostPath:probePath,probeSha256:createHash('sha256').update(probe).digest('hex'),imageId:workerImage,socketPath:join(control,'broker.sock'),keyPath:join(control,'broker.key')};
  broker=await brokerMain(brokerConfig);
  const client=new SandboxClient(join(control,'broker.sock'),join(control,'broker.key'));
  for(let index=0;index<2;index++){
   const context=await db.createContext(principal,workerProject,randomUUID());await capacity.service.assignPolicy(principal,context,capacity.revision);const authority=await db.acquire(principal,context,randomUUID(),'synthetic-isolation-manager',60);
   const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:synthetic-isolation'}},authority,'api');
   const attempt=(await db.pool.query('SELECT execution_attempt_id FROM ac_operations WHERE id=$1',[intent.operation_id])).rows[0].execution_attempt_id;
   const grant=await capacity.service.reserve(principal,{attemptId:attempt,intentId:intent.id,contextId:context,role:'programmer'},authority);assert(grant);
   await db.pool.query('UPDATE ac_operations SET grant_id=$2 WHERE id=$1',[intent.operation_id,grant.id]);
   const work=join(spool,intent.operation_id,'work');await mkdir(work,{recursive:true,mode:0o755});jobs.push({jobId:intent.operation_id,grantId:grant.id,authority,work});
  }
  for(const [index,job] of jobs.entries()){
   const peer=jobs[1-index]!,ownCanary='SYNTHETIC_WORK_'+index+'_'+randomUUID();await writeFile(join(job.work,'own-canary'),ownCanary,{mode:0o644});
   await writeFile(join(job.work,'targets.json'),JSON.stringify({ownCanary,hostPid:heartbeat.pid,centralUrl:origin+'/api/v1/ac/project-admin/environments',foreignPaths:[centralFile,accountFile,join(repo,'src/fixture.txt'),join(repo,'.git/refs/heads/protected'),join(peer.work,'own-canary'),'/proc/'+heartbeat.pid+'/root'+centralFile,'/proc/1/root'+centralFile],sockets:['/var/run/docker.sock','/run/ac-broker/control.sock',join(control,'broker.sock')]}),{mode:0o644});
  }
  const starts=await Promise.all(jobs.map(job=>client.perform('start',job.jobId,job.grantId,job.authority))) as {containerId:string;state:string}[];assert(starts.every(s=>s.state==='running'));
  await wait(async()=>{const ready=await Promise.all(jobs.map(job=>readFile(join(job.work,'attack-ready.json')).then(()=>true,()=>false)));return ready.every(Boolean)},'BOTH_HOSTILE_WORKERS_READY');
  const observations=starts.map(start=>JSON.parse(docker('inspect',start.containerId))[0]);assert(observations.every(c=>c.State.Running));assert.notEqual(observations[0].State.Pid,observations[1].State.Pid);
  const namespaces=await Promise.all(observations.map(c=>readlink(`/proc/${c.State.Pid}/ns/pid`)));assert.notEqual(namespaces[0],namespaces[1]);
  for(const c of observations){assert.equal(c.HostConfig.NetworkMode,'none');assert.equal(c.HostConfig.ReadonlyRootfs,true);assert.deepEqual(c.Mounts.map((m:{Destination:string})=>m.Destination).sort(),['/runner/probe.mjs','/work']);}
  const requestUrl=origin+'/api/v1/ac/project-admin/environments';
  const command={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.environments.configure',payload:{projectId:project,expectedRevision:0,config:{sourceBranch:'refs/heads/main',environments:[{id:'protected',label:'Signed legitimate host administration',targetRef:'refs/heads/protected',authorizedDirectories:['src'],destinations:[{id:'local',label:'Existing repository',kind:'local_repository'}]}]}}};
  function proof(value:Record<string,unknown>,forged=false){const info={deviceId,expiresAt:Date.now()+60000};return Buffer.from(JSON.stringify({...info,signature:forged?'0'.repeat(128):sign(null,Buffer.from(operatorMessage(principal,value,info,installationId)),keys.privateKey).toString('hex')})).toString('base64url')}
  async function post(value:unknown,headers:Record<string,string>,url=requestUrl){const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',origin,...headers},body:JSON.stringify(value)});return {status:response.status,body:await response.json() as {error?:string;state?:string;revision?:number}}}
  assert.equal((await post(command,{})).status,401);
  const forged=await post(command,{cookie,'x-ac-operator-proof':proof(command,true)});assert.equal(forged.status,403);assert.equal(forged.body.error,'OPERATOR_SIGNATURE_INVALID');
  const cross={...command,intentId:randomUUID(),deliveryAttemptId:randomUUID(),payload:{...command.payload,projectId:otherProject}};const denied=await post(cross,{cookie,'x-ac-operator-proof':proof(cross)});assert.equal(denied.status,403);assert.equal(denied.body.error,'PROJECT_ENVIRONMENT_FORBIDDEN');
  const central={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.register',payload:{projectId:randomUUID(),label:'Forbidden central registration',rootId:'lab',relativePath:'authorized'}};const centralDenied=await post(central,{cookie,'x-ac-operator-proof':proof(central)},origin+'/api/v1/ac/project-admin');assert.equal(centralDenied.status,403);assert.equal(centralDenied.body.error,'CONTROL_ADMIN_REQUIRED');
  const busy={...command,intentId:randomUUID(),deliveryAttemptId:randomUUID(),payload:{...command.payload,projectId:workerProject}};const busyResult=await post(busy,{cookie,'x-ac-operator-proof':proof(busy)});assert.equal(busyResult.status,409);assert.equal(busyResult.body.error,'PROJECT_ENVIRONMENT_IN_USE');
  const beforeHeartbeat=(await readFile(heartbeatFile)).length;
  const applied=await post(command,{cookie,'x-ac-operator-proof':proof(command)});assert.equal(applied.status,200);assert.equal(applied.body.revision,1);
  assert(starts.every(start=>JSON.parse(docker('inspect',start.containerId))[0].State.Running),'both adversarial workers must overlap the authorized mutation');
  await wait(async()=>(await readFile(heartbeatFile)).length>beforeHeartbeat,'HOST_PROCESS_SURVIVED');
  for(const job of jobs)await writeFile(join(job.work,'release'),'released',{mode:0o644});
  for(const job of jobs){let receipt:any;await wait(async()=>{receipt=await client.perform('reconcile',job.jobId,job.grantId,job.authority);return receipt.exitCode!==undefined},'WORKER_TERMINAL_RECEIPT');assert.equal(receipt.exitCode,0);assert.deepEqual(receipt.probe,{visible:[],network:false,uid:10001});const result=JSON.parse(await readFile(join(job.work,'attack-ready.json'),'utf8'));assert.equal(result.checks.length,42);assert.equal(await readFile(join(job.work,'legitimate-output'),'utf8'),'authorized local worker output\n');}
  assert.equal(await readFile(centralFile,'utf8'),configCanary);assert.equal(await readFile(accountFile,'utf8'),accountCanary);assert.equal(await readFile(join(repo,'src/fixture.txt'),'utf8'),'legitimate tracked source\n');assert.equal(git('rev-parse','protected'),originalCommit);
  assert.deepEqual((await db.pool.query('SELECT principal_id FROM ac_control_admins ORDER BY principal_id')).rows,administratorsBefore);assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_project_admin_intents')).rows[0].n,0);assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_project_environment_revisions')).rows[0].n,1);assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_project_environment_revisions WHERE project_id=$1',[otherProject])).rows[0].n,0);assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_capacity_grants WHERE state<>\'released\'')).rows[0].n,0);
  for(const job of jobs)await client.perform('cleanup',job.jobId,job.grantId,job.authority);
  const priorExitCode=process.exitCode;await broker.stop();await new Promise(r=>setTimeout(r,50));assert.equal(process.exitCode,priorExitCode,'normal requested broker stop must preserve exit code');
  const childConfig=join(control,'lock-loss-child.json');await writeFile(childConfig,JSON.stringify({...brokerConfig,socketPath:join(control,'lock-loss.sock')}),{mode:0o600});
  lockLossChild=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/r4-broker-lock-loss.ts',import.meta.url)),childConfig],{stdio:['ignore','ignore','ignore','ipc']});
  const lostExit=new Promise<number|null>((resolve,reject)=>{lockLossChild!.once('error',reject);lockLossChild!.once('exit',resolve)});
  void lostExit.catch(()=>{});
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('LOCK_LOSS_CHILD_READY_TIMEOUT')),10000);lockLossChild!.once('message',value=>{clearTimeout(timer);assert.deepEqual(value,{state:'broker_lock_held'});resolve()});lockLossChild!.once('exit',()=>{clearTimeout(timer);reject(Error('LOCK_LOSS_CHILD_EXITED_EARLY'))})});
  const lock=(await db.pool.query('SELECT pid FROM pg_locks WHERE locktype=\'advisory\' AND classid=189234 AND objid=19 AND granted')).rows;assert.equal(lock.length,1);assert.equal((await db.pool.query('SELECT pg_terminate_backend($1) terminated',[lock[0].pid])).rows[0].terminated,true);assert.equal(await lostExit,1,'unexpected real lock loss must remain fatal');
  console.log('PASS broker lifecycle: explicit shutdown preserves exit code; terminating the actual PostgreSQL lock session exits isolated controller with code1');
  console.log(JSON.stringify({proof:'r4-composed-broker-isolation',workers:2,overlapping:true,assertionsPerWorker:42,refusedAttacksPerWorker:41,permittedLocalControlsPerWorker:1,authorizedHostMutation:'environment079 revision1',hostApiCounterprobes:['unauthenticated401','forged-signature403','cross-project403','owner-central-admin403','busy-worker-project409'],workerApiResult:'network-denied-not-authentication-proof',protectedGitUnchanged:true,canariesUnchanged:true,synthetic:true,nativeFullIsolation:false}));
 }catch(error){primary=error;}
 finally{
  const errors:unknown[]=[];const attempt=async(f:()=>Promise<unknown>)=>{try{await f()}catch(e){errors.push(e)}};
  await attempt(async()=>server&&await new Promise<void>((ok,fail)=>server!.close(e=>e?fail(e):ok())));await attempt(()=>stop(heartbeat));await attempt(()=>stop(lockLossChild));await attempt(async()=>broker?.stop());
  for(const job of jobs)await attempt(async()=>{const found=docker('ps','-aq','--no-trunc','--filter',`name=^/ac-synthetic-${job.jobId}$`,'--filter',`label=ac.job=${job.jobId}`);if(found){const body=JSON.parse(docker('inspect',found))[0];assert.equal(body.Config.Labels['ac.scope'],'isolated-synthetic');docker('rm','-f',found)}});
  await attempt(async()=>db?.close());
  if(pgStarted)await attempt(async()=>{assert.equal(docker('inspect','-f','{{index .Config.Labels "agent-control.disposable"}}',pgName),label);docker('rm','-f',pgName)});
  await attempt(()=>rm(area,{recursive:true,force:true}));
  if(errors.length)throw new AggregateError(primary?[primary,...errors]:errors,'DISPOSABLE_ISOLATION_CLEANUP_FAILED');
 }
 if(primary)throw primary;
});
