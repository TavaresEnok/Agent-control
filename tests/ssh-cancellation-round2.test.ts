import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {Ledger} from '../src/ledger.ts';
import {RemoteOperations,OpenSshTransport,type RemoteTransport} from '../src/remote.ts';
import {Refusal} from '../src/contracts.ts';

test('two disposable SSH hosts reconcile cancellation after lost acknowledgement', {timeout:30000,skip:!process.env.AC_SSH_FIXTURE_ROOT},async()=>{
 const root=process.env.AC_SSH_FIXTURE_ROOT!,url=process.env.AC_TEST_DATABASE_URL;
 if(!url?.endsWith('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const metadata=JSON.parse(await readFile(root+'/metadata.json','utf8'));assert.equal(metadata.scope,'isolated-ssh-fixture');
 const project=metadata.projectId,principal='ssh-cancel-'+randomUUID(),db=new Ledger(url),credentialRef=randomUUID();await db.migrate();
 const ssh=new OpenSshTransport(async()=>root+'/controller',new Set(['ssh-host-a','ssh-host-b']));let loseAck=false;
 const transport:RemoteTransport={async exchange(host,request){const reply=await ssh.exchange(host,request);if(loseAck&&(request as {action:string}).action==='cancel'){loseAck=false;throw new Refusal('REMOTE_TRANSPORT_UNCERTAIN');}return reply;}};
 const remote=new RemoteOperations(db,transport);
 try{
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2) ON CONFLICT DO NOTHING',[project,'SSH fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const context=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
  for(const name of ['a','b']){
   const hostId=randomUUID(),publicKey=(await readFile(`${root}/host-${name}/host_key.pub`,'utf8')).trim();
   const fingerprint=execFileSync('ssh-keygen',['-lf',`${root}/host-${name}/host_key.pub`,'-E','sha256'],{encoding:'utf8'}).trim().split(/\s+/)[1];
   await remote.registerHost(principal,project,{id:hostId,label:`Synthetic host ${name}`,hostname:`ssh-host-${name}`,port:2222,username:'node',publicKey,fingerprint,credentialRef,remoteRoot:'/projects/repo',allowedTasks:['slow'],maxConcurrent:1});
   const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:ssh-cancel'}},authority,'api');
   const request={operationId:randomUUID(),intentId:intent.id,contextId:context,hostId,taskId:'slow'};
   await remote.start(principal,request,authority);
   let running:any;for(let i=0;i<20;i++){running=await remote.reconcile(principal,request.operationId,authority);if(running.state==='running')break;await new Promise(r=>setTimeout(r,50));}assert.equal(running.state,'running');
   await db.pool.query('INSERT INTO ac_plan_cancellations(intent_id,context_id,requested_by,plan_revision) VALUES($1,$2,$3,$4)',[intent.id,context,principal,intent.plan_revision]);
   loseAck=true;await assert.rejects(remote.cancel(principal,request.operationId,authority),/REMOTE_TRANSPORT_UNCERTAIN/);
   let result:any;for(let i=0;i<30;i++){result=await remote.start(principal,request,authority);if(result.state==='canceled_confirmed')break;await new Promise(r=>setTimeout(r,100));}
   assert.equal(result.state,'canceled_confirmed');assert.equal(result.operationId,request.operationId);assert.equal(result.epoch,authority.epoch);assert.match(result.logSha256,/^[a-f0-9]{64}$/);assert.ok(result.exitCode<0);
   assert.deepEqual(await remote.cancel(principal,request.operationId,authority),result);
  }
 }finally{await db.close();}
});
