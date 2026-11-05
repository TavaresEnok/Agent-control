import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createPublicKey,randomBytes,randomUUID,verify} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {NativeExecutionSupervisor} from '../src/native-execution-supervisor.ts';
import {DockerDaemon} from '../src/sandbox-broker.ts';
import {NativeImplementation} from '../src/native-implementation.ts';
import {GitArtifacts} from '../src/git.ts';
import {Quality} from '../src/quality.ts';
import {canonical,digest} from '../src/contracts.ts';

test('new controller reconciles native retirement after SIGKILL between physical removals',
 {timeout:60000,skip:process.env.AC_NATIVE_RETIREMENT_RESTART!=='1'},async()=>{
 const root=process.env.AC_NATIVE_RETIREMENT_ROOT,marker=process.env.AC_NATIVE_RETIREMENT_MARKER;
 if(!root?.endsWith('/.state/native-dispatch-physical')||!marker||dirname(marker)!==root||!/^native-crash-[a-z0-9-]+\.json$/.test(marker.split('/').at(-1)!))throw Error('ISOLATED_NATIVE_CRASH_MARKER_REQUIRED');
 const meta=await stat(marker);if(!meta.isFile()||meta.uid!==process.getuid?.()||(meta.mode&0o077)!==0||meta.nlink!==1)throw Error('INVALID_PRIVATE_FIXTURE');
 const f=JSON.parse(await readFile(marker,'utf8'));
 const url=new URL(f.url);if(url.hostname!=='db'||!/^\/ac_implementation_test_nativemulti_[a-f0-9]{20}$/.test(url.pathname))throw Error('ISOLATED_DATABASE_REQUIRED');
 const db=new Ledger(f.url),docker=new DockerDaemon();
 try{
  const rows=(await db.pool.query(`SELECT r.*,w.state writer_state,i.context_id FROM ac_native_writer_retirements r
   JOIN ac_worktree_writers w ON w.parent_intent_id=r.parent_intent_id AND w.run_id=r.run_id
   JOIN ac_intents i ON i.id=r.holder_intent_id WHERE r.state='prepared'`)).rows;
  assert(rows.length>=1&&rows.length<=2);assert(rows.every(row=>row.writer_state==='held'&&row.context_id===f.context));
  let partiallyRemoved=0;
  for(const row of rows){
   const worker=await docker.inspect(row.worker_id),tools=await docker.inspect(row.tools_id);
   if(!worker&&tools)partiallyRemoved++;
   else assert(worker&&tools,'only a single physically removed worker is expected');
   assert.equal((await db.pool.query('SELECT proof FROM ac_native_writer_retirements WHERE job_id=$1',[row.job_id])).rows[0].proof,null);
   for(const [name,sha] of [['worker-terminal.log',row.worker_log_sha256],['tools-terminal.log',row.tools_log_sha256]] as const)
    assert.equal(createHash('sha256').update(await readFile(join(f.supervisorConfig.hostRoot,row.job_id,name))).digest('hex'),sha);
  }
  assert.equal(partiallyRemoved,1,'real process must die after first physical removal');
  const unrelated=(await db.pool.query("SELECT worker_id,tools_id FROM ac_native_execution_jobs WHERE id<>ALL($1::uuid[]) AND worker_id IS NOT NULL AND tools_id IS NOT NULL",[rows.map(r=>r.job_id)])).rows;
  const intact=[] as string[];for(const row of unrelated)for(const id of [row.worker_id,row.tools_id])if(await docker.inspect(id))intact.push(id);
  await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[f.context]);
  const next=await db.acquire(f.principal,f.context,randomUUID(),'fixture-manager',60);
  const supervisor=new NativeExecutionSupervisor(db,f.supervisorConfig);
  const git=new GitArtifacts(f.supervisorConfig.repository),quality=new Quality(db,randomBytes(32),git);
  const implementation=new NativeImplementation(db,f.supervisorConfig.repository,quality,[supervisor]);
  const guarded=(supervisor as unknown as {docker:DockerDaemon}).docker,inspect=guarded.inspect.bind(guarded);
  const target=rows.find(row=>row.tools_id)!;
  const targetTools=await inspect(target.tools_id);assert(targetTools);
  guarded.inspect=async name=>name==='ac-native-tools-'+target.job_id?{...targetTools,State:{...targetTools.State,Running:true,Status:'running'}}:inspect(name);
  await assert.rejects(supervisor.retireManagedWriter(f.principal,next,target.job_id),/NATIVE_RETIREMENT_UNCONFIRMED/);
  guarded.inspect=async name=>name==='ac-native-tools-'+target.job_id?{...targetTools,Id:'f'.repeat(64)}:inspect(name);
  await assert.rejects(supervisor.retireManagedWriter(f.principal,next,target.job_id),/NATIVE_RETIREMENT_UNCONFIRMED/);
  guarded.inspect=async name=>{if(name==='ac-native-tools-'+target.job_id)throw Error('SYNTHETIC_DOCKER_INACCESSIBLE');return inspect(name);};
  await assert.rejects(supervisor.retireManagedWriter(f.principal,next,target.job_id),/SYNTHETIC_DOCKER_INACCESSIBLE/);
  guarded.inspect=inspect;
  const before=(await db.pool.query('SELECT r.state,r.proof,w.state writer_state FROM ac_native_writer_retirements r JOIN ac_worktree_writers w ON w.parent_intent_id=r.parent_intent_id AND w.run_id=r.run_id WHERE r.job_id=$1',[target.job_id])).rows[0];
  assert.equal(before.state,'prepared');assert.equal(before.proof,null);assert.equal(before.writer_state,'held');assert(await inspect(target.tools_id));
  for(const row of rows){
   await assert.rejects(supervisor.retireManagedWriter(f.principal,f.authority,row.job_id),/STALE_MANAGER/);
   const intent=(await db.pool.query('SELECT * FROM ac_intents WHERE id=$1',[row.holder_intent_id])).rows[0];
   assert.equal(await implementation.prepareRecovery(intent,next),true);
   assert.equal((await supervisor.retireManagedWriter(f.principal,next,row.job_id)).state,'neutralized');
   const saved=(await db.pool.query(`SELECT r.*,w.state writer_state,w.proof_digest,w.revocation_proof FROM ac_native_writer_retirements r
    JOIN ac_worktree_writers w ON w.parent_intent_id=r.parent_intent_id AND w.run_id=r.run_id WHERE r.job_id=$1`,[row.job_id])).rows[0];
   assert.equal(saved.state,'revoked');assert.equal(saved.writer_state,'neutralized');assert.equal(saved.proof_digest,digest(saved.proof));
   assert.deepEqual(saved.proof,saved.revocation_proof);
   assert(verify(null,Buffer.from('agent-control:native-writer-retirement:v1\n'+canonical(saved.proof.payload)),createPublicKey(f.supervisorConfig.signingKeyPem),Buffer.from(saved.proof.signature,'hex')));
   assert.equal(await docker.inspect(row.worker_id),null);assert.equal(await docker.inspect(row.tools_id),null);
   assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_audit WHERE kind='worktree.native_writer_revoked' AND detail->>'jobId'=$1",[row.job_id])).rows[0].n,1);
  }
  for(const id of intact)assert(await docker.inspect(id),'unrelated container must remain');
  console.log(JSON.stringify({prepared:rows.length,partialPairs:partiallyRemoved,unrelatedContainers:intact.length,oldManager:'rejected',newManager:'reconciled',replayedWorkers:0}));
 }finally{await db.close();}
});
