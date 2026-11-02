import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {DockerDaemon,SandboxBroker} from '../src/sandbox-broker.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';
import type {Command} from '../src/contracts.ts';

test('broker startup neutralizes a persisted writer before admitting work',
 {timeout:15000,skip:!process.env.AC_SANDBOX_DATABASE_URL},async()=>{
 const url=process.env.AC_SANDBOX_DATABASE_URL!;
 if(!url.endsWith('/ac_sandbox_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();
 const project=randomUUID(),principal='broker-recovery-'+randomUUID();
 await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Synthetic broker recovery']);
 await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
 const capacity=await provisionCapacity(db,principal,project);
 const context=await db.createContext(principal,project,randomUUID());
 await capacity.service.assignPolicy(principal,context,capacity.revision);
 const authority=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
 const command:Command={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,
  policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:broker-recovery'}};
 const intent=await db.accept(principal,command,authority,'api');
 const attempt=(await db.pool.query('SELECT execution_attempt_id FROM ac_operations WHERE id=$1',[intent.operation_id])).rows[0].execution_attempt_id;
 const grant=await capacity.service.reserve(principal,{attemptId:attempt,intentId:intent.id,contextId:context,role:'programmer'},authority);
 const imageId='sha256:'+'a'.repeat(64),containerId='b'.repeat(64),spec='c'.repeat(64),root='/workspace/.state/sandbox';
 class FakeDocker extends DockerDaemon{
  stopped:string[]=[];
  override async inspect(name:string){if(name!=='ac-synthetic-'+intent.operation_id)return null;return {
   Id:containerId,Image:imageId,Config:{User:'10001:10001',Labels:{'ac.scope':'isolated-synthetic','ac.job':intent.operation_id,
    'ac.grant':grant.id,'ac.epoch':String(authority.epoch),'ac.spec':spec}},
   State:{Status:'running',Running:true,ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z'},
   HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],
    PidsLimit:64,Memory:268435456,NanoCpus:1000000000},
   Mounts:[{Source:`${root}/${intent.operation_id}/work`,Destination:'/work',RW:true},
    {Source:'/workspace/scripts/sandbox-probe.mjs',Destination:'/runner/probe.mjs',RW:false}]
  };}
  override async stop(id:string){this.stopped.push(id);}
 }
 const docker=new FakeDocker();const broker=new SandboxBroker({hostRoot:root,probeHostPath:'/workspace/scripts/sandbox-probe.mjs',
  probeSha256:'d'.repeat(64),imageId,socketPath:'/run/ac-broker/test.sock',keyPath:'/run/ac-broker/test.key',databaseUrl:url},
  Buffer.alloc(32),docker);
 try{
  await db.pool.query('INSERT INTO ac_sandbox_jobs(id,context_id,grant_id,manager_epoch,profile,spec_digest,state) VALUES($1,$2,$3,$4,$5,$6,$7)',
   [intent.operation_id,context,grant.id,authority.epoch,'synthetic-probe-v1',spec,'running']);
  await broker.neutralizePersistedJobs();
  assert.deepEqual(docker.stopped,[containerId]);
 }finally{
  await db.pool.query('DELETE FROM ac_sandbox_jobs WHERE id=$1',[intent.operation_id]);
  await broker.close();await db.close();
 }
});
