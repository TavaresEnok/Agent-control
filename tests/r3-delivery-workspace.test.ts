import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {labGit,remoteDevelopmentLab} from './fixtures/r3-delivery-lab.ts';

test('R3 direct remote workspace uses one Docker writer, seals exact output, registers through real Capacity and Quality', {timeout:120000},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const lab=await remoteDevelopmentLab(base);
 try{
  const workspaceId=randomUUID(),input={workspaceId,contextId:lab.contextId,intentId:lab.intent.id,hostId:lab.hostId,sourceOperationId:lab.sourceOperationId};
  const prepared=await lab.development.prepare(lab.principal,input,lab.authority);
  assert.equal(prepared.commit,lab.source);assert.equal(labGit(lab.bare,'rev-parse','refs/heads/agent-control-export'),lab.source);
  assert.deepEqual(await lab.development.prepare(lab.principal,input,lab.authority),prepared);
  await assert.rejects(lab.development.prepare(lab.principal,{...input,sourceOperationId:randomUUID()},lab.authority),/REMOTE_WORKSPACE_SOURCE_REQUIRED/);
  const started=await lab.development.launchImplementation(lab.principal,{workspaceId,taskId:'implement',sessionId:randomUUID()},lab.authority);assert.equal(started.workspaceId,workspaceId);
  const host=(await lab.db.pool.query('SELECT * FROM ac_remote_hosts WHERE id=$1',[lab.hostId])).rows[0];
  // A different execution UUID cannot claim the existing writable clone.
  await assert.rejects(lab.ssh.exchange(host,{schemaVersion:1,action:'start',operationId:randomUUID(),projectId:lab.projectId,taskId:'implement',root:prepared.repository,epoch:lab.authority.epoch,workspaceId}),/REMOTE_TRANSPORT_UNCERTAIN/);
  let terminal:Record<string,unknown>|undefined;
  for(let i=0;i<150;i++){
   const value=await lab.remote.reconcile(lab.principal,lab.intent.operation_id,lab.authority);
   if(value.state==='completed'||value.state==='failed'){terminal=value;break;}
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(terminal?.state,'completed');assert.equal(terminal?.groupRemovalConfirmed,true);
  const snapshot=await lab.development.snapshot(lab.principal,{workspaceId,executionOperationId:lab.intent.operation_id,contextId:lab.contextId},lab.authority);
  assert.equal(snapshot.reviewStatus,'not_reviewed');assert.notEqual(snapshot.commit,lab.source);assert.equal(snapshot.base,lab.source);
  assert.equal(labGit(prepared.repository,'show',snapshot.commit+':src/example.ts'),'export const value = 2;');
  assert.equal(await readFile(join(prepared.repository,'private-untracked-secret'),'utf8'),'synthetic-private-canary');
  assert.equal(labGit(prepared.repository,'ls-tree','-r','--name-only',snapshot.commit).includes('private-untracked-secret'),false);
  // Even a later administrative HEAD mutation cannot change the sealed snapshot.
  await writeFile(join(prepared.repository,'src/example.ts'),'export const value = 999;\n');labGit(prepared.repository,'add','--update');labGit(prepared.repository,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','later administrative mutation');
  const replay=await lab.development.snapshot(lab.principal,{workspaceId,executionOperationId:lab.intent.operation_id,contextId:lab.contextId},lab.authority);assert.equal(replay.commit,snapshot.commit);assert.equal(replay.tree,snapshot.tree);
  const artifact=await lab.development.registerArtifact(lab.principal,{workspaceId,artifactId:randomUUID()},lab.authority,lab.quality,lab.scratch);
  assert.equal(artifact.commit_id,snapshot.commit);assert.equal(artifact.tree_id,snapshot.tree);assert.equal(artifact.base_id,lab.source);
  assert.equal(labGit(lab.local,'rev-parse','HEAD'),lab.source);assert.equal(labGit(lab.bare,'rev-parse','refs/heads/agent-control-export'),lab.source);
  const grant=(await lab.db.pool.query('SELECT state,physical_receipt FROM ac_capacity_grants WHERE id=$1',[artifact.implementation_grant_id])).rows[0];assert.equal(grant.state,'released');assert.equal(grant.physical_receipt.processId,lab.intent.operation_id);
  await assert.rejects(lab.db.tx(c=>lab.quality.assertReady(c,artifact.id,lab.authority)),/VERIFICATION_NOT_PASSED|QA_MISSING/);
  assert.equal((await lab.db.pool.query('SELECT count(*)::int n FROM ac_verification_evidence WHERE artifact_id=$1',[artifact.id])).rows[0].n,0);
  console.log(JSON.stringify({proof:'r3-direct-remote-development',workspaceId,commit:artifact.commit_id,tree:artifact.tree_id,source:lab.source,writer:'real SSH Docker fixed executable',artifactRegistration:'Capacity+Quality APIs',untrackedExported:false,sealedReplay:true,qualityStatus:'not_reviewed'}));
 }finally{await lab.close();}
});
