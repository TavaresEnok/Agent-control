import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmod,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {RemoteGitMaterializer,sourceSnapshot,verifyGitExport} from '../src/remote-git.ts';
import {Ledger} from '../src/ledger.ts';
import {RemoteOperations,OpenSshTransport,type RemoteTransport} from '../src/remote.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('source snapshot rejects tampered persisted identity and never claims review',()=>{
 const expected={operationId:randomUUID(),contextId:randomUUID(),intentId:randomUUID(),hostId:randomUUID(),projectId:randomUUID(),
  commit:'1'.repeat(40),tree:'2'.repeat(40),requestDigest:'3'.repeat(64),bundleSha256:'4'.repeat(64)};
 const row={id:expected.operationId,context_id:expected.contextId,intent_id:expected.intentId,host_id:expected.hostId,request_digest:expected.requestDigest,
  task_id:'git-export',state:'completed',remote_receipt:{commit:expected.commit,tree:expected.tree,bundleSha256:expected.bundleSha256}};
 assert.deepEqual(sourceSnapshot(row,expected),{schemaVersion:1,kind:'source_snapshot',reviewStatus:'not_reviewed',...expected});
 for(const field of ['id','context_id','intent_id','host_id'] as const)assert.throws(()=>sourceSnapshot({...row,[field]:randomUUID()},expected),/REMOTE_GIT_REPLAY_MISMATCH/);
 assert.throws(()=>sourceSnapshot({...row,request_digest:'changed'},expected),/REMOTE_GIT_REPLAY_MISMATCH/);
 for(const field of ['commit','tree','bundleSha256'] as const)assert.throws(()=>sourceSnapshot({...row,remote_receipt:{...row.remote_receipt,[field]:'5'.repeat(field==='bundleSha256'?64:40)}},expected),/REMOTE_GIT_REPLAY_MISMATCH/);
});

test('bounded configured repository export verifies commit, tree, hash and idempotent materialization',async()=>{
 const temp=await mkdtemp(join('/dev/shm','ac-remote-git-'));
 try{
  const repo=join(temp,'source');execFileSync('git',['init',repo]);
  await writeFile(join(repo,'fixture.txt'),'synthetic remote content\n');
  execFileSync('git',['-C',repo,'add','fixture.txt']);
  execFileSync('git',['-C',repo,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);
  const rev=(revision:string)=>execFileSync('git',['-C',repo,'rev-parse',revision],{encoding:'utf8'}).trim();
  const commit=rev('HEAD'),tree=rev('HEAD^{tree}'),projectId=randomUUID(),operationId=randomUUID();
  const helper=resolve('services/remote-git/helper.py');
  const call=(request:object,enabled=true)=>execFileSync('python3',['-c',
   'import importlib.util,json,sys;s=importlib.util.spec_from_file_location("helper",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps(m.export(json.loads(sys.argv[2]),json.loads(sys.argv[3]))))',
   helper,JSON.stringify({projects:{[projectId]:repo},gitExportProjects:enabled?[projectId]:[]}),JSON.stringify(request)],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
  const request={schemaVersion:1,action:'git-export',operationId,projectId,commit,tree};
  const reply=JSON.parse(call(request));const expected={operationId,projectId,commit,tree};
  const checked=verifyGitExport(reply,expected),again=verifyGitExport(JSON.parse(call(request)),expected);
  assert.equal(checked.sha256,again.sha256);
  assert.throws(()=>verifyGitExport({...reply,bundleSha256:'0'.repeat(64)},expected),/REMOTE_GIT_BUNDLE_MISMATCH/);
  assert.throws(()=>verifyGitExport(reply,{...expected,tree:'0'.repeat(40)}),/REMOTE_GIT_IDENTITY_MISMATCH/);
  assert.throws(()=>call({...request,tree:'0'.repeat(40)}));assert.throws(()=>call({...request,command:'id'}));assert.throws(()=>call(request,false));
  const materializedRoot=join(temp,'materialized');await mkdir(materializedRoot,{mode:0o700});
  const materializer=new RemoteGitMaterializer(materializedRoot);
  const result=await materializer.materialize(operationId,commit,tree,checked.bundle);
  assert.deepEqual(await materializer.materialize(operationId,commit,tree,checked.bundle),result);
  assert.equal(execFileSync('git',['-C',result.repository,'rev-parse',commit+'^{tree}'],{encoding:'utf8'}).trim(),tree);
  await assert.rejects(materializer.materialize(randomUUID(),commit,tree,Buffer.from('bad bundle')),/REMOTE_GIT_MATERIALIZATION_FAILED/);
  const linkId=randomUUID();await symlink(result.repository,join(materializedRoot,linkId));
  await assert.rejects(materializer.materialize(linkId,commit,tree,checked.bundle),/REMOTE_GIT_DESTINATION_UNSAFE/);
  const lockedId=randomUUID();await mkdir(join(materializedRoot,'.'+lockedId+'.lock'));
  await assert.rejects(materializer.materialize(lockedId,commit,tree,checked.bundle),/REMOTE_GIT_OPERATION_BUSY/);
  await chmod(materializedRoot,0o755);await assert.rejects(materializer.materialize(randomUUID(),commit,tree,checked.bundle),/REMOTE_GIT_ROOT_UNSAFE/);await chmod(materializedRoot,0o700);
  const concurrentId=randomUUID(),concurrent=await Promise.allSettled([materializer.materialize(concurrentId,commit,tree,checked.bundle),materializer.materialize(concurrentId,commit,tree,checked.bundle)]);
  assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);
  assert.match(String((concurrent.find(x=>x.status==='rejected') as PromiseRejectedResult).reason),/REMOTE_GIT_OPERATION_BUSY/);
  await writeFile(join(repo,'compressible.bin'),Buffer.alloc(20*1024*1024));execFileSync('git',['-C',repo,'add','compressible.bin']);
  execFileSync('git',['-C',repo,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','compressible fixture']);
  const compact={...request,operationId:randomUUID(),commit:rev('HEAD'),tree:rev('HEAD^{tree}')};
  const packed=verifyGitExport(JSON.parse(call(compact)),compact);assert(packed.bundle.length<65536);
  await materializer.materialize(compact.operationId,compact.commit,compact.tree,packed.bundle);
  await writeFile(join(repo,'large.bin'),randomBytes(100000));execFileSync('git',['-C',repo,'add','large.bin']);
  execFileSync('git',['-C',repo,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','oversized fixture']);
  assert.throws(()=>call({...request,commit:rev('HEAD'),tree:rev('HEAD^{tree}')}));
 }finally{await rm(temp,{recursive:true,force:true});}
});

test('two pinned SSH fixture hosts export only their configured commit and tree',
 {skip:!process.env.AC_REMOTE_GIT_IDENTITIES?'SSH Git fixture not enabled':false,timeout:60000},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL,root=process.env.AC_SSH_FIXTURE_ROOT;if(!base||!root)throw Error('ISOLATED_DATABASE_REQUIRED');
 const identities=JSON.parse(process.env.AC_REMOTE_GIT_IDENTITIES!) as {commit:string;tree:string}[];
 assert.equal(identities.length,2);
 const metadata=JSON.parse(await readFile(root+'/metadata.json','utf8'));assert.equal(metadata.scope,'isolated-ssh-fixture');
 const database=await isolatedDatabase(base,'remotegitssh'),ledger=new Ledger(database.url),principal='ssh-git-'+randomUUID(),credentialRef=randomUUID();
 const temporary=await mkdtemp(join('/dev/shm','ac-ssh-git-'));
 try{
  await ledger.migrate();await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[metadata.projectId,'synthetic ssh git']);
  await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[metadata.projectId,principal]);
  const contextId=await ledger.createContext(principal,metadata.projectId,randomUUID()),authority=await ledger.acquire(principal,contextId,randomUUID(),'fixture',60);
  const intent=await ledger.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,
   action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:ssh-git-fixture'}},authority,'api');
  const transport=new OpenSshTransport(async id=>{assert.equal(id,credentialRef);return root+'/controller';},new Set(['ssh-host-a','ssh-host-b']));
  const remote=new RemoteOperations(ledger,transport),materializer=new RemoteGitMaterializer(temporary);
  for(let i=0;i<2;i++){
   const name=i===0?'a':'b',hostId=randomUUID(),publicPath=root+'/host-'+name+'/host_key.pub';
   const fingerprint=execFileSync('ssh-keygen',['-lf',publicPath,'-E','sha256'],{encoding:'utf8'}).trim().split(/\s+/)[1];
   await remote.registerHost(principal,metadata.projectId,{id:hostId,label:'synthetic ssh '+name,hostname:'ssh-host-'+name,port:2222,username:'node',
    publicKey:(await readFile(publicPath,'utf8')).trim(),fingerprint,credentialRef,remoteRoot:'/projects/repo',allowedTasks:['git-export'],maxConcurrent:2});
   const request={operationId:randomUUID(),intentId:intent.id,contextId,hostId,...identities[i]};
   const output=await remote.exportGit(principal,request,authority),replayed=await remote.exportGit(principal,request,authority);
   assert.equal(output.sha256,replayed.sha256);
   await materializer.materialize(request.operationId,request.commit,request.tree,output.bundle);
   await assert.rejects(remote.exportGit(principal,{...request,tree:'0'.repeat(request.tree.length)},authority),/REMOTE_OPERATION_ID_CONFLICT/);
  }
 }finally{await rm(temporary,{recursive:true,force:true});await ledger.close();await database.close();}
});

test('remote export is bound to an authorized active intent and immutable operation identity',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const database=await isolatedDatabase(base,'remotegit'),ledger=new Ledger(database.url);
 const principal='remote-git-'+randomUUID(),project=randomUUID(),hostId=randomUUID();
 try{
  await ledger.migrate();await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'synthetic remote git']);
  await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const contextId=await ledger.createContext(principal,project,randomUUID()),authority=await ledger.acquire(principal,contextId,randomUUID(),'fixture',60);
  const intent=await ledger.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,
   action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
  const bytes=Buffer.from('synthetic bundle'),hash=(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');let calls=0;
  const transport:RemoteTransport={async exchange(_host,raw){calls++;return {...raw as object,bundle:bytes.toString('base64'),bundleSha256:hash};}};
  // Real protocol response does not repeat the action.
  const cleanTransport:RemoteTransport={async exchange(host,raw){const {action,...reply}=await transport.exchange(host,raw) as Record<string,unknown>;return reply;}};
  const remote=new RemoteOperations(ledger,cleanTransport);
  await remote.registerHost(principal,project,{id:hostId,label:'fixture',hostname:'fixture.invalid',port:2222,username:'fixture',
   publicKey:'ssh-ed25519 '+'A'.repeat(64),fingerprint:'SHA256:'+'A'.repeat(43),credentialRef:randomUUID(),remoteRoot:'/fixture',allowedTasks:['git-export'],maxConcurrent:2});
  const input={operationId:randomUUID(),intentId:intent.id,contextId,hostId,commit:'1'.repeat(40),tree:'2'.repeat(40)};
  assert.equal((await remote.exportGit(principal,input,authority)).sha256,hash);
  assert.equal((await remote.exportGit(principal,input,authority)).sha256,hash);assert.equal(calls,2);
  await assert.rejects(remote.exportGit(principal,{...input,tree:'3'.repeat(40)},authority),/REMOTE_OPERATION_ID_CONFLICT/);
  await assert.rejects(remote.exportGit('wrong-principal',input,authority),/FORBIDDEN/);
  const nonOwner='remote-git-reader-'+randomUUID();await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'operator')",[project,nonOwner]);
  await assert.rejects(remote.exportGit(nonOwner,input,authority),/PROJECT_OWNER_REQUIRED/);
  await ledger.pause(principal,contextId,true);await assert.rejects(remote.exportGit(principal,input,authority),/HUMAN_PAUSED/);
  assert.equal((await ledger.pool.query("SELECT count(*)::int n FROM ac_audit WHERE kind='remote.git.exported' AND context_id=$1",[contextId])).rows[0].n,1);
 }finally{await ledger.close();await database.close();}
});
