import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {mkdtemp,readFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {Control} from '../src/control.ts';
import {Operators,operatorMessage} from '../src/operator.ts';
import {RemoteOperations,OpenSshTransport,type RemoteTransport} from '../src/remote.ts';
import {ProjectAdmin} from '../src/project-admin.ts';
import {Projects} from '../src/projects.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('signed source authorization, SSH export and project materialization preserve provenance on both hosts', {timeout:60000,skip:!process.env.AC_REMOTE_GIT_IDENTITIES},async()=>{
 const root=process.env.AC_SSH_FIXTURE_ROOT!,base=process.env.AC_TEST_DATABASE_URL!;
 const identities=JSON.parse(process.env.AC_REMOTE_GIT_IDENTITIES!) as {commit:string;tree:string}[];assert.equal(identities.length,2);
 assert.notEqual(identities[0].commit,identities[1].commit,'fixture commits must differ');
 assert.notEqual(identities[0].tree,identities[1].tree,'fixture trees must differ');
 const metadata=JSON.parse(await readFile(root+'/metadata.json','utf8'));assert.equal(metadata.scope,'isolated-ssh-fixture');
 for(let i=0;i<2;i++){
  const name=i===0?'a':'b',project=metadata.projectId,principal='source-flow-'+randomUUID();
  const isolated=await isolatedDatabase(base,'sshsourceflow'),db=new Ledger(isolated.url);
  const destination=await realpath(await mkdtemp(join(tmpdir(),'ac-ssh-source-'))),tmpfs=await realpath(await mkdtemp('/dev/shm/ac-ssh-source-'));
  try{
   await db.migrate();await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'synthetic remote project']);
   await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
   await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
   const keys=generateKeyPairSync('ed25519'),deviceId=randomUUID();await new Operators(db).enroll(principal,principal,deviceId,keys.publicKey.export({format:'der',type:'spki'}).toString('base64'));
   const installation=(await db.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0].id;
   const proof=(command:Record<string,unknown>)=>{const data={deviceId,expiresAt:Date.now()+120000};return {...data,signature:sign(null,Buffer.from(operatorMessage(principal,command,data,installation)),keys.privateKey).toString('hex')};};
   const contextId=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,contextId,randomUUID(),'fixture',60);
   const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:source-flow'}},authority,'api');
   const credentialRef=randomUUID(),hostId=randomUUID(),publicPath=`${root}/host-${name}/host_key.pub`;
   const fingerprint=execFileSync('ssh-keygen',['-lf',publicPath,'-E','sha256'],{encoding:'utf8'}).trim().split(/\s+/)[1];
   const ssh=new OpenSshTransport(async()=>root+'/controller',new Set([`ssh-host-${name}`]));let lose=true;
   const transport:RemoteTransport={async exchange(host,request){const value=await ssh.exchange(host,request);if(lose){lose=false;throw Error('SYNTHETIC_EXPORT_ACK_LOST');}return value;}};
   const remote=new RemoteOperations(db,transport);
   await remote.registerHost(principal,project,{id:hostId,label:`synthetic host ${name}`,hostname:`ssh-host-${name}`,port:2222,username:'node',publicKey:(await readFile(publicPath,'utf8')).trim(),fingerprint,credentialRef,remoteRoot:'/projects/repo',allowedTasks:['git-export'],maxConcurrent:1});
   const {commit,tree}=identities[i],otherTree=identities[1-i].tree;const control=new Control(db),authorized={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,action:'remote.source.authorize' as const,payload:{schemaVersion:1 as const,intentId:intent.id,hostId,commit,tree}};
   const auth=await control.execute(principal,authorized,proof(authorized));assert.deepEqual(await control.execute(principal,{...authorized,deliveryAttemptId:randomUUID()},proof(authorized)),auth);
   const changedAuth={...authorized,payload:{...authorized.payload,tree:'0'.repeat(40)}};await assert.rejects(control.execute(principal,changedAuth,proof(changedAuth)),/CONTROL_INTENT_CONFLICT/);
   const request={operationId:randomUUID(),intentId:intent.id,contextId,hostId,commit,tree};
   await assert.rejects(remote.exportGit(principal,request,authority),/SYNTHETIC_EXPORT_ACK_LOST/);
   const output=await remote.exportGit(principal,request,authority),replay=await remote.exportGit(principal,request,authority);
   assert.equal(output.sha256,replay.sha256);assert.equal(output.snapshot.sourceAuthorizationId,authorized.intentId);assert.equal(output.snapshot.reviewStatus,'not_reviewed');
   await assert.rejects(remote.exportGit(principal,{...request,tree:otherTree},authority),/REMOTE_SOURCE_AUTHORIZATION_REQUIRED/);
   const serviceRoots=[{id:'fixture',label:'Fixture',path:destination}],service=new ProjectAdmin(db,serviceRoots,join(destination,'private'),{remoteSourceTmpfs:tmpfs});
   const command={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.materializeRemoteSource' as const,payload:{projectId:project,contextId,operationId:request.operationId,hostId,commit,tree,bundle:output.bundle.toString('base64')}};
   const divergent={...command,intentId:randomUUID(),payload:{...command.payload,tree:otherTree}};await assert.rejects(service.execute(principal,divergent,proof(divergent)),/REMOTE_SOURCE_IDENTITY_MISMATCH/);
   const wrongHost={...command,intentId:randomUUID(),payload:{...command.payload,hostId:randomUUID()}};await assert.rejects(service.execute(principal,wrongHost,proof(wrongHost)),/REMOTE_SOURCE_IDENTITY_MISMATCH/);
   const result=await service.execute(principal,command,proof(command));assert.equal(result.reviewStatus,'not_reviewed');
   assert.deepEqual(await service.execute(principal,{...command,deliveryAttemptId:randomUUID()},proof(command)),result);
   const changed={...command,payload:{...command.payload,bundle:Buffer.from('different').toString('base64')}};await assert.rejects(service.execute(principal,changed,proof(changed)),/PROJECT_ADMIN_INTENT_CONFLICT/);
   const repo=join(destination,'remote-sources',project);assert.equal((await new Projects(db,serviceRoots).authorized(principal,project))?.repo,repo);
   assert.equal(execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),commit);
   assert.equal(execFileSync('git',['-C',repo,'rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),tree);
   assert.equal(await readFile(join(repo,'fixture.txt'),'utf8'),`synthetic host ${name}\n`);
   execFileSync('git',['-C',repo,'fsck','--strict']);
   assert.deepEqual((await service.view(principal)).remoteSources,[{projectId:project,hostId,commit,tree,state:'materialized',reviewStatus:'not_reviewed'}]);
   assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_artifacts WHERE project_id=$1',[project])).rows[0].n,0);
   const rows=(await db.pool.query('SELECT * FROM ac_remote_source_materializations WHERE project_id=$1',[project])).rows;assert.equal(rows.length,1);
   assert.equal(rows[0].context_id,contextId);assert.equal(rows[0].operation_id,request.operationId);assert.equal(rows[0].host_id,hostId);
   assert.equal(rows[0].authorization_id,authorized.intentId);assert.equal(rows[0].commit_id,commit);assert.equal(rows[0].tree_id,tree);assert.equal(rows[0].bundle_sha256,output.sha256);
   await assert.rejects(db.pool.query('UPDATE ac_remote_source_materializations SET tree_id=$1 WHERE project_id=$2',[tree,project]),/POLICY_REVISION_IMMUTABLE/);
  }finally{await db.close();await isolated.close();await rm(destination,{recursive:true,force:true});await rm(tmpfs,{recursive:true,force:true});}
 }
});
