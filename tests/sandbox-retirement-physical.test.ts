import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,readFile,chmod} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
import {Ledger} from '../src/ledger.ts';
import {SandboxBroker} from '../src/sandbox-broker.ts';
import {digest,Refusal} from '../src/contracts.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';

test('physical failed and canceled writers survive lost removal ACK and successor broker',{timeout:120000,skip:process.env.AC_R2_SANDBOX_PHYSICAL!=='1'},async()=>{
 const url=process.env.AC_TEST_DATABASE_URL!,root=process.env.AC_R2_SANDBOX_ROOT!;
 if(!url?.endsWith('/ac_implementation_test')||!root?.startsWith('/tmp/ac-r2-sandbox-')||process.getuid?.()!==0)throw Error('ISOLATED_ROOT_FIXTURE_REQUIRED');
 const image='sha256:9914706a4d692f9e87c9c17313efbf3f0544574e1ebc3ddf77512a54eb5cb7b3';
 const probe=resolve('scripts/sandbox-probe.mjs'),worker=join(root,'worker.mjs');
 await mkdir(root,{recursive:true,mode:0o755});await chmod(root,0o755);
 await writeFile(worker,"import {writeFileSync} from 'node:fs';writeFileSync('/work/written.txt','preserved');console.log('writable fixture log');if(process.argv[2]==='fail')process.exit(7);setInterval(()=>{},1000);",{mode:0o644});
 const sha=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');
 const config={hostRoot:root,probeHostPath:probe,probeSha256:await sha(probe),implementationPath:worker,implementationSha256:await sha(worker),imageId:image,socketPath:join(root,'unused.sock'),keyPath:join(root,'key'),databaseUrl:url};
 const key=Buffer.alloc(32,51),db=new Ledger(url),broker=new SandboxBroker(config,key),created:string[]=[];
 try{
  await db.migrate();const project=randomUUID(),principal='r2-physical-'+randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'R2 physical sandbox']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const capacity=await provisionCapacity(db,principal,project),context=await db.createContext(principal,project,randomUUID());
  await capacity.service.assignPolicy(principal,context,capacity.revision);
  let authority=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
  const parent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'fixture:r2'}},authority,'api');
  for(const mode of ['fail','cancel'] as const){
   const intent=randomUUID(),job=randomUUID(),run=randomUUID(),attempt=randomUUID();
   await db.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,parent_intent_id,parent_unit_id)
    SELECT $1,context_id,principal_id,digest,command,$2,$3,manager_epoch,plan_revision,id,$4 FROM ac_intents WHERE id=$5`,[intent,job,run,mode,parent.id]);
   await db.pool.query("INSERT INTO ac_operations(id,intent_id,state,manager_epoch,execution_attempt_id) VALUES($1,$2,'running',$3,$4)",[job,intent,authority.epoch,attempt]);
   const grant=await capacity.service.reserve(principal,{attemptId:attempt,intentId:intent,contextId:context,role:'programmer'},authority);
   await db.pool.query('UPDATE ac_operations SET grant_id=$2 WHERE id=$1',[job,grant.id]);
   await db.pool.query("INSERT INTO ac_worktree_writers(parent_intent_id,run_id,holder_intent_id,manager_epoch,state) VALUES($1,$2,$3,$4,'held')",[parent.id,run,intent,authority.epoch]);
   const work=join(root,job,'work');await mkdir(work,{recursive:true,mode:0o777});await chmod(work,0o777);
   const source={base:'a'.repeat(40),bundle:'',outputPath:'output.txt'};
   const value:any={schemaVersion:1,action:'reconcile',jobId:job,grantId:grant.id,authority,profile:'synthetic-implementation-v1',source,expiresAt:Date.now()+30000,signature:'0'.repeat(64)};
   const spec=(broker as any).specification(value,work);
   await db.pool.query("INSERT INTO ac_sandbox_jobs(id,context_id,grant_id,manager_epoch,profile,spec_digest,state) VALUES($1,$2,$3,$4,'synthetic-implementation-v1',$5,'running')",[job,context,grant.id,authority.epoch,spec]);
   await db.pool.query("UPDATE ac_capacity_grants SET state='running' WHERE id=$1",[grant.id]);
   const id=await broker.docker.create('ac-synthetic-'+job,{Image:image,User:'10001:10001',WorkingDir:'/work',Entrypoint:['node','/runner/probe.mjs',mode],Labels:{'ac.scope':'isolated-synthetic','ac.job':job,'ac.grant':grant.id,'ac.epoch':String(authority.epoch),'ac.spec':spec},HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:64,Memory:268435456,NanoCpus:1000000000,AutoRemove:false,Binds:[`${work}:/work:rw`,`${worker}:/runner/probe.mjs:ro`]}});created.push(id);
   await db.pool.query('UPDATE ac_sandbox_jobs SET container_id=$2 WHERE id=$1',[job,id]);await broker.docker.start(id);
   for(let i=0;i<100;i++){try{if(await readFile(join(work,'written.txt'),'utf8')==='preserved')break;}catch{}await new Promise(r=>setTimeout(r,50));}
   assert.equal(await readFile(join(work,'written.txt'),'utf8'),'preserved');
   if(mode==='cancel'){assert.equal((await broker.docker.inspect(id))?.State.Running,true);await db.pool.query("UPDATE ac_intents SET state='canceled' WHERE id=$1",[intent]);await broker.docker.stop(id);}
   let observed:any;for(let i=0;i<100;i++){observed=await broker.docker.inspect(id);if(observed?.State.Status==='exited')break;await new Promise(r=>setTimeout(r,50));}
   assert.equal(observed.State.Status,'exited');assert.notEqual(observed.State.ExitCode,0);
   const receipt=await (broker as any).reconcile(value,{state:'running'},spec,work);assert.equal(receipt.exitCode,observed.State.ExitCode);
   const saved=(await db.pool.query('SELECT state,physical_receipt FROM ac_capacity_grants WHERE id=$1',[grant.id])).rows[0];assert.equal(saved.state,'released');assert.equal(digest(saved.physical_receipt),digest(JSON.parse(JSON.stringify(receipt))));
   const remove=broker.docker.remove.bind(broker.docker);broker.docker.remove=async container=>{await remove(container);throw new Refusal('DOCKER_REMOVE_UNCERTAIN');};
   await assert.rejects((broker as any).retireManagedWriter(value,spec,work),/DOCKER_REMOVE_UNCERTAIN/);
   const pending=(await db.pool.query(`SELECT r.state retirement,w.state writer,r.log_sha256 FROM ac_sandbox_writer_retirements r JOIN ac_worktree_writers w ON w.parent_intent_id=r.parent_intent_id AND w.run_id=r.run_id WHERE r.job_id=$1`,[job])).rows[0];
   assert.equal(pending.retirement,'prepared');assert.equal(pending.writer,'held');assert.equal(await broker.docker.inspect(id),null);
   assert.equal(createHash('sha256').update(await readFile(join(root,job,'terminal-container.log'))).digest('hex'),pending.log_sha256);
   await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);
   const successor=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
   const requestFile=join(root,`successor-${job}.json`),publicConfig={...config,databaseUrl:undefined};
   const invoke=async()=>exec(process.execPath,['--import','tsx','tests/fixtures/sandbox-retirement-successor.ts',requestFile],{timeout:20000});
   await writeFile(requestFile,JSON.stringify({config:publicConfig,value,spec,work}),{mode:0o600});
   await assert.rejects(invoke(),/STALE_MANAGER/);
   value.authority=successor;await writeFile(requestFile,JSON.stringify({config:publicConfig,value,spec,work}),{mode:0o600});
   assert.deepEqual(JSON.parse((await invoke()).stdout),{jobId:job,state:'cleaned'});
   assert.deepEqual(JSON.parse((await invoke()).stdout),{jobId:job,state:'cleaned'});
   const done=(await db.pool.query(`SELECT r.state retirement,w.state writer,r.proof,w.proof_digest FROM ac_sandbox_writer_retirements r JOIN ac_worktree_writers w ON w.parent_intent_id=r.parent_intent_id AND w.run_id=r.run_id WHERE r.job_id=$1`,[job])).rows[0];
   assert.equal(done.retirement,'revoked');assert.equal(done.writer,'neutralized');assert.equal(digest(done.proof),done.proof_digest);assert.equal(done.proof.payload.logSha256,pending.log_sha256);
   assert.equal(await readFile(join(work,'written.txt'),'utf8'),'preserved');assert.equal(await broker.docker.inspect('ac-synthetic-'+job),null);
   broker.docker.remove=remove;authority=successor;
  }
 }finally{for(const id of created){const inspected=await broker.docker.inspect(id).catch(()=>null);if(inspected){if(inspected.State.Running)await broker.docker.stop(id);await broker.docker.remove(id);}}await broker.close();await db.close();}
});
