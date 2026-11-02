import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Ledger} from '../src/ledger.ts';
import {OpenSshTransport} from '../src/remote.ts';

// Run only after ssh.test.ts and an external restart of ssh-host-a.
// The controller has no Docker socket, by design.
test('completed remote operation survives disposable SSH host restart',
 {timeout:20000,skip:process.env.AC_SSH_RESTART_VERIFY!=='1'},async()=>{
 const root=process.env.AC_SSH_FIXTURE_ROOT!;
 const url=process.env.AC_TEST_DATABASE_URL!;
 if(!root||!url.endsWith('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const marker=JSON.parse(await readFile('.state/ssh-restart-marker.json','utf8'));
 const metadata=JSON.parse(await readFile(root+'/metadata.json','utf8'));
 assert.equal(marker.scope,'isolated-ssh-fixture');assert.equal(marker.project,metadata.projectId);
 const db=new Ledger(url);
 try{
  const host=(await db.pool.query('SELECT * FROM ac_remote_hosts WHERE id=$1 AND project_id=$2',[marker.hostId,marker.project])).rows[0];
  assert.equal(host.hostname,'ssh-host-a');assert.equal(host.credential_ref,marker.credentialRef);
  const transport=new OpenSshTransport(async id=>{assert.equal(id,marker.credentialRef);return root+'/controller';},new Set(['ssh-host-a']));
  const inspected=await transport.exchange(host,{schemaVersion:1,action:'inspect',operationId:marker.operationId});
  assert.deepEqual(inspected,marker.receipt);
  const replay=await transport.exchange(host,{schemaVersion:1,action:'start',operationId:marker.operationId,
   projectId:marker.project,taskId:'fixture',root:host.remote_root,epoch:marker.epoch});
  assert.deepEqual(replay,marker.receipt);
 }finally{await db.close();}
});
