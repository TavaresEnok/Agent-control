import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {Ledger} from '../src/ledger.ts';
import {RemoteOperations,OpenSshTransport,type RemoteTransport,type RemoteHost} from '../src/remote.ts';
import {Refusal} from '../src/contracts.ts';

test('two pinned SSH hosts reconcile detached work, lost ack and paused takeover',
 {timeout:30000,skip:!process.env.AC_SSH_FIXTURE_ROOT?'SSH lab profile not enabled':false},async()=>{
 const root=process.env.AC_SSH_FIXTURE_ROOT!;
 const url=process.env.AC_TEST_DATABASE_URL;if(!url?.endsWith('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const metadata=JSON.parse(await readFile(root+'/metadata.json','utf8'));assert.equal(metadata.scope,'isolated-ssh-fixture');
 const project=metadata.projectId,principal='ssh-'+randomUUID(),db=new Ledger(url);await db.migrate();
 const credentialRef=randomUUID(),hosts=['a','b'].map(()=>randomUUID());let loseAck=true;
 const ssh=new OpenSshTransport(async id=>{assert.equal(id,credentialRef);return root+'/controller';},new Set(['ssh-host-a','ssh-host-b']));
 const transport:RemoteTransport={async exchange(host:RemoteHost,request:object){
  const result=await ssh.exchange(host,request);
  if(loseAck&&(request as {action:string}).action==='start'){loseAck=false;throw new Refusal('REMOTE_TRANSPORT_UNCERTAIN');}
  return result;
 }};
 const remote=new RemoteOperations(db,transport);
 try{
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2) ON CONFLICT DO NOTHING',[project,'SSH fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const context=await db.createContext(principal,project,randomUUID());let authority=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
  for(let i=0;i<2;i++){
   const name=i===0?'a':'b',publicKey=(await readFile(root+'/host-'+name+'/host_key.pub','utf8')).trim();
   const fingerprint=execFileSync('ssh-keygen',['-lf',root+'/host-'+name+'/host_key.pub','-E','sha256'],{encoding:'utf8'}).trim().split(/\s+/)[1];
   await remote.registerHost(principal,project,{id:hosts[i],label:'Synthetic host '+name,hostname:'ssh-host-'+name,port:2222,username:'node',
    publicKey,fingerprint,credentialRef,remoteRoot:'/projects/repo',allowedTasks:['fixture','slow','count'],maxConcurrent:2});
  }
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,
   action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:ssh-fixture'}},authority,'api');
  const op=randomUUID(),request={operationId:op,intentId:intent.id,contextId:context,hostId:hosts[0],taskId:'fixture'};
  await assert.rejects(remote.start(principal,request,authority),/REMOTE_TRANSPORT_UNCERTAIN/);
  assert.equal((await db.pool.query('SELECT state FROM ac_remote_operations WHERE id=$1',[op])).rows[0].state,'uncertain');
  let done:any;
  for(let i=0;i<40;i++){done=await remote.reconcile(principal,op,authority);if(done.state==='completed')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(done.state,'completed');assert.equal(done.exitCode,0);
  const count=async()=>{
   const countOp=randomUUID();await remote.start(principal,{...request,operationId:countOp,taskId:'count'},authority);
   for(let i=0;i<40;i++){const result=await remote.reconcile(principal,countOp,authority);if(result.state==='completed')return result.logSha256;await new Promise(r=>setTimeout(r,100));}
   throw Error('COUNT_NOT_COMPLETED');
  };
  const beforeReplay=await count();
  assert.deepEqual(await remote.start(principal,request,authority),done);
  assert.equal(await count(),beforeReplay,'replayed start must not repeat the physical effect');
  const slow=randomUUID();await remote.start(principal,{...request,operationId:slow,hostId:hosts[1],taskId:'slow'},authority);
  await db.pause(principal,context,true);
  await assert.rejects(remote.start(principal,{...request,operationId:randomUUID()},authority),/HUMAN_PAUSED/);
  const old=authority;await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);
  authority=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
  await assert.rejects(remote.reconcile(principal,slow,old),/STALE_MANAGER/);
  let recovered:any;
  for(let i=0;i<60;i++){recovered=await remote.reconcile(principal,slow,authority);if(recovered.state==='completed')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(recovered.state,'completed');assert.equal(recovered.epoch,old.epoch);
  assert.equal((await db.pool.query('SELECT paused FROM ac_contexts WHERE id=$1',[context])).rows[0].paused,true);
  await writeFile('.state/ssh-restart-marker.json',JSON.stringify({scope:'isolated-ssh-fixture',project,hostId:hosts[0],
   credentialRef,operationId:op,epoch:old.epoch,receipt:done}));
 }finally{await db.close();}
});
