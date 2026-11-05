import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {Operators,operatorMessage} from '../src/operator.ts';
import {Projects} from '../src/projects.ts';
import {projectRepositoryIdentity} from '../src/project-repository.ts';
import {WorkflowGraphs} from '../src/workflow-graph-service.ts';
test('signed graph saves and replays immutable revisions',async()=>{
 const url=process.env.AC_R5_GRAPH_DATABASE_URL;if(!url?.endsWith('/ac_r5_mobile_graph'))throw Error('DISPOSABLE_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();const root=await mkdtemp('/tmp/ac-r5-graph-');const repo=join(root,'repo');
 try{
  await mkdir(repo,{mode:0o700});execFileSync('git',['init',repo],{stdio:'ignore'});await chmod(join(repo,'.git'),0o700);
  const projectId=randomUUID(),principal='graph-'+randomUUID(),deviceId=randomUUID(),key=generateKeyPairSync('ed25519');
  await new Projects(db).register([{id:projectId,label:'graph',repo,owner:principal}],principal);
  const identity=await projectRepositoryIdentity(repo);
  await db.pool.query('INSERT INTO ac_project_repository_identity VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[projectId,identity.repoDev,identity.repoIno,identity.gitDev,identity.gitIno,'lab',root,'repo']);
  await new Operators(db).enroll(principal,principal,deviceId,key.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const installation=(await db.pool.query('SELECT id FROM ac_installation_identity WHERE singleton')).rows[0].id;
  const cmd={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'workflow.graph.save' as const,payload:{projectId,name:'test',expectedRevision:0,graph:{nodes:[{id:'start',type:'start'},{id:'work',type:'agent',prompt:'do it'},{id:'end',type:'end'}],edges:[{from:'start',to:'work'},{from:'work.done',to:'end'}]}}};
  const proof=(command:typeof cmd)=>{const p={deviceId,expiresAt:Date.now()+120000};return {...p,signature:sign(null,Buffer.from(operatorMessage(principal,command,p,installation)),key.privateKey).toString('hex')};};
  const service=new WorkflowGraphs(db,[{id:'lab',path:root}],join(root,'private'));
  const result=await service.save(principal,cmd,proof(cmd));assert.equal(result.revision,1);
  const replay={...cmd,deliveryAttemptId:randomUUID()};assert.deepEqual(await service.save(principal,replay,proof(replay)),result);
  assert.equal((await service.view(principal,projectId,'test')).revision,1);
  assert.equal(JSON.parse(await readFile(join(repo,'.ai/cezar/workflows/test.yaml'),'utf8')).version,2);
  const stale={...cmd,intentId:randomUUID(),deliveryAttemptId:randomUUID()};
  await assert.rejects(service.save(principal,stale,proof(stale)),/WORKFLOW_REVISION_CONFLICT/);
  const pending={...cmd,intentId:randomUUID(),deliveryAttemptId:randomUUID(),payload:{...cmd.payload,name:'pending'}};
  const pendingFile=join(repo,'.ai/cezar/workflows/pending.yaml');await writeFile(pendingFile,'foreign',{mode:0o600});
  await assert.rejects(service.save(principal,pending,proof(pending)),/WORKFLOW_FILE_CONFLICT/);
  assert.equal((await db.pool.query('SELECT state FROM ac_workflow_graph_intents WHERE id=$1',[pending.intentId])).rows[0].state,'pending');
  await rm(pendingFile);assert.equal((await service.save(principal,pending,proof(pending))).revision,1);
  await assert.rejects(db.pool.query("UPDATE ac_workflow_graph_revisions SET published_by='changed' WHERE project_id=$1",[projectId]));
 }finally{await db.pool.end();await rm(root,{recursive:true,force:true});}
});
