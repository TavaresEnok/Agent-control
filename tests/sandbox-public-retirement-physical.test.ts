import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,readFile,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {SandboxClient} from '../src/sandbox-client.ts';
import {DockerDaemon} from '../src/sandbox-broker.ts';
import {digest} from '../src/contracts.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';

test('public broker socket starts and retires failed and canceled writers across broker crash',{timeout:120000,skip:process.env.AC_R2_SANDBOX_PHYSICAL!=='1'},async()=>{
 const url=process.env.AC_TEST_DATABASE_URL!,root=process.env.AC_R2_SANDBOX_ROOT!;
 if(!/^\/ac_r2_sandbox_[a-z0-9]+$/.test(new URL(url).pathname)||!root?.startsWith('/tmp/ac-r2-sandbox-')||process.getuid?.()!==0)throw Error('ISOLATED_ROOT_FIXTURE_REQUIRED');
 await mkdir(root,{recursive:true,mode:0o755});await chmod(root,0o755);
 const repo=join(root,'source'),worker=join(root,'worker.mjs'),hostRoot=join(root,'jobs'),socket=join(root,'run','socket'),key=join(root,'run','key');
 await mkdir(repo);const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
 git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');await writeFile(join(repo,'base.txt'),'base');git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');git('bundle','create',join(root,'source.bundle'),'HEAD');
 await writeFile(worker,"import {writeFileSync} from 'node:fs';writeFileSync('/work/written.txt','preserved');console.log('writable fixture log');if(process.argv[3]==='fail.txt')process.exit(7);setInterval(()=>{},1000);",{mode:0o644});
 const probe=resolve('scripts/sandbox-probe.mjs'),sha=async(p:string)=>createHash('sha256').update(await readFile(p)).digest('hex');
 const config={hostRoot,probeHostPath:probe,probeSha256:await sha(probe),implementationPath:worker,implementationSha256:await sha(worker),imageId:'sha256:9914706a4d692f9e87c9c17313efbf3f0544574e1ebc3ddf77512a54eb5cb7b3',socketPath:socket,keyPath:key};
 const configPath=join(root,'broker.json');await writeFile(configPath,JSON.stringify(config));const db=new Ledger(url),client=new SandboxClient(socket,key),docker=new DockerDaemon(),created:string[]=[];let child:ChildProcess|undefined;
 const start=async(crash:boolean)=>{let output='';const proc=spawn(process.execPath,['--import','tsx','tests/fixtures/sandbox-public-broker.ts',configPath],{env:{...process.env,AC_R2_CRASH_REMOVE:crash?'1':'0'},stdio:['ignore','pipe','pipe']});child=proc;proc.stdout!.on('data',b=>output+=String(b));proc.stderr!.on('data',b=>output+=String(b));
  for(let i=0;i<200;i++){if(output.includes('BROKER_READY'))return proc;if(proc.exitCode!==null)throw Error('BROKER_FAILED '+output);await new Promise(r=>setTimeout(r,50));}throw Error('BROKER_TIMEOUT '+output);};
 const stop=async(proc:ChildProcess)=>{if(proc.exitCode!==null)return;const done=new Promise<void>(r=>proc.once('exit',()=>r()));proc.kill('SIGTERM');await done;};
 try{
  await db.migrate();const project=randomUUID(),principal='r2-public-'+randomUUID();await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'R2 public sandbox']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const capacity=await provisionCapacity(db,principal,project),context=await db.createContext(principal,project,randomUUID());await capacity.service.assignPolicy(principal,context,capacity.revision);let authority=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
  const parent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'fixture:r2'}},authority,'api');
  for(const mode of ['fail','cancel'] as const){
   const intent=randomUUID(),job=randomUUID(),run=randomUUID(),attempt=randomUUID(),outputPath=mode+'.txt';
   await db.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,parent_intent_id,parent_unit_id)
    SELECT $1,context_id,principal_id,digest,command,$2,$3,manager_epoch,plan_revision,id,$4 FROM ac_intents WHERE id=$5`,[intent,job,run,mode,parent.id]);
   await db.pool.query("INSERT INTO ac_operations(id,intent_id,state,manager_epoch,execution_attempt_id) VALUES($1,$2,'uncertain',$3,$4)",[job,intent,authority.epoch,attempt]);
   const grant=await capacity.service.reserve(principal,{attemptId:attempt,intentId:intent,contextId:context,role:'programmer'},authority);await db.pool.query('UPDATE ac_operations SET grant_id=$2 WHERE id=$1',[job,grant.id]);
   await db.pool.query("INSERT INTO ac_worktree_writers(parent_intent_id,run_id,holder_intent_id,manager_epoch,state) VALUES($1,$2,$3,$4,'held')",[parent.id,run,intent,authority.epoch]);
   const input={kind:'task',writePaths:[outputPath],sources:[]};await db.pool.query('INSERT INTO ac_managed_delivery_inputs VALUES($1,$2,$3,$4)',[intent,base,input,digest(input)]);
   const execution={profile:'synthetic-implementation-v1' as const,source:{base,bundle:(await readFile(join(root,'source.bundle'))).toString('base64'),outputPath}};
   await db.pool.query('INSERT INTO ac_execution_launches(operation_id,context_id,manager_epoch,snapshot,digest) VALUES($1,$2,$3,$4,$5)',[job,context,authority.epoch,execution,digest(execution)]);
   let proc=await start(true);const initial:any=await client.perform('start',job,grant.id,authority,execution);assert.equal(initial.state,'running');created.push(initial.containerId);const inspected=await docker.inspect(initial.containerId);assert(inspected);
   assert.equal(inspected.Mounts.some(m=>m.Source===socket||m.Source===key||m.Destination==='/var/run/docker.sock'),false);
   assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[grant.id])).rows[0].state,'running');
   const work=join(hostRoot,job,'work');for(let i=0;i<100;i++){try{if(await readFile(join(work,'written.txt'),'utf8')==='preserved')break;}catch{}await new Promise(r=>setTimeout(r,50));}assert.equal(await readFile(join(work,'written.txt'),'utf8'),'preserved');
   if(mode==='cancel'){await db.pool.query("UPDATE ac_intents SET state='canceled' WHERE id=$1",[intent]);await client.perform('stop',job,grant.id,authority,execution);}
   let receipt:any;for(let i=0;i<100;i++){receipt=await client.perform('reconcile',job,grant.id,authority,execution);if(typeof receipt.exitCode==='number')break;await new Promise(r=>setTimeout(r,50));}assert.notEqual(receipt.exitCode,0);if(mode==='fail')assert.equal(receipt.exitCode,7);
   await assert.rejects(client.perform('cleanup',job,grant.id,authority,execution),/SANDBOX_RESPONSE_UNCERTAIN/);if(proc.exitCode===null)await new Promise<void>(r=>proc.once('exit',()=>r()));assert.equal(proc.exitCode,77);
   const before=(await db.pool.query(`SELECT r.state retirement,w.state writer,r.log_sha256 FROM ac_sandbox_writer_retirements r JOIN ac_worktree_writers w ON w.parent_intent_id=r.parent_intent_id AND w.run_id=r.run_id WHERE r.job_id=$1`,[job])).rows[0];assert.equal(before.retirement,'prepared');assert.equal(before.writer,'held');assert.equal(await docker.inspect(initial.containerId),null);
   const logs=await readFile(join(hostRoot,job,'terminal-container.log'));assert(logs.includes('writable fixture log'));assert.equal(await sha(join(hostRoot,job,'terminal-container.log')),before.log_sha256);
   assert.equal(await sha(join(hostRoot,job,'source.bundle')),await sha(join(root,'source.bundle')));
   await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);const successor=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);proc=await start(false);
   await assert.rejects(client.perform('cleanup',job,grant.id,authority,execution),/STALE_MANAGER/);
   assert.deepEqual(await client.perform('cleanup',job,grant.id,successor,execution),{jobId:job,state:'cleaned'});assert.deepEqual(await client.perform('cleanup',job,grant.id,successor,execution),{jobId:job,state:'cleaned'});
   const after=(await db.pool.query(`SELECT r.state retirement,w.state writer,r.proof,w.proof_digest FROM ac_sandbox_writer_retirements r JOIN ac_worktree_writers w ON w.parent_intent_id=r.parent_intent_id AND w.run_id=r.run_id WHERE r.job_id=$1`,[job])).rows[0];assert.equal(after.retirement,'revoked');assert.equal(after.writer,'neutralized');assert.equal(digest(after.proof),after.proof_digest);assert.equal(await readFile(join(work,'written.txt'),'utf8'),'preserved');await stop(proc);authority=successor;
  }
 }finally{if(child)await stop(child);for(const id of created){const c=await docker.inspect(id).catch(()=>null);if(c){if(c.State.Running)await docker.stop(id);await docker.remove(id);}}await db.close();}
});
