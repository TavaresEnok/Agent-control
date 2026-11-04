import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createPrivateKey,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {chmod,lstat,mkdtemp,mkdir,readFile,readdir,realpath,rm,statfs,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Ledger} from '../src/ledger.ts';
import {Control} from '../src/control.ts';
import {Operators,operatorMessage,type OperatorProof} from '../src/operator.ts';
import {RemoteOperations,type RemoteTransport} from '../src/remote.ts';
import {ProjectAdmin} from '../src/project-admin.ts';
import {Projects} from '../src/projects.ts';
import {sourceSnapshot} from '../src/remote-git.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {digest} from '../src/contracts.ts';

if(process.env.AC_RSM_CHILD==='1'){
 await runMaterializationChild();
 process.exit(0);
}

async function runMaterializationChild(){
 const job=JSON.parse(await readFile(process.env.AC_RSM_JOB??'','utf8')) as {databaseUrl:string;principal:string;deviceId:string;privateKeyPem:string;roots:{id:string;label:string;path:string}[];privateDirectory:string;tmpfs:string;command:Record<string,unknown>};
 const db=new Ledger(job.databaseUrl);
 const key=createPrivateKey(job.privateKeyPem);
 const installation=(await db.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0].id as string;
 const proof=(value:Record<string,unknown>)=>{const data={deviceId:job.deviceId,expiresAt:Date.now()+120000};return {...data,signature:sign(null,Buffer.from(operatorMessage(job.principal,value,data,installation)),key).toString('hex')};};
 const service=new ProjectAdmin(db,job.roots,job.privateDirectory,{remoteSourceTmpfs:job.tmpfs,beforeRemoteSourceRegister:async()=>{process.kill(process.pid,'SIGKILL');}});
 try{await service.execute(job.principal,job.command,proof(job.command));console.error('CHILD_REGISTERED');process.exit(2);}
 catch(error){console.error(error);process.exit(1);}
 finally{await db.close();}
}

async function privateTmpfs(){
 const created=await mkdtemp(join('/dev/shm','ac-rsm-'));
 const path=await realpath(created);
 await chmod(path,0o700);
 const filesystem=await statfs(path);
 if(filesystem.type!==0x01021994||Number(filesystem.blocks)*Number(filesystem.bsize)>128*1024*1024){
  await rm(path,{recursive:true,force:true});
  return undefined;
 }
 return path;
}

test('signed materialization refuses a missing or invalid authorization and a divergent snapshot',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(base,'rsmrefuse'),db=new Ledger(isolated.url);
 const rootPath=await realpath(await mkdtemp(join(tmpdir(),'ac-rsm-root-'))),principal='rsm-'+randomUUID(),project=randomUUID();
 try{
  await db.migrate();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'remote source']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  const keys=generateKeyPairSync('ed25519'),deviceId=randomUUID();
  await new Operators(db).enroll(principal,principal,deviceId,keys.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const installation=(await db.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0].id;
  const proof=(command:Record<string,unknown>)=>{const data={deviceId,expiresAt:Date.now()+120000};return {...data,signature:sign(null,Buffer.from(operatorMessage(principal,command,data,installation)),keys.privateKey).toString('hex')};};
  const contextId=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,contextId,randomUUID(),'fixture',60);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
  const hostId=randomUUID();
  const remote=new RemoteOperations(db,{async exchange(){throw Error('unused');}});
  await remote.registerHost(principal,project,{id:hostId,label:'fixture',hostname:'fixture.invalid',port:2222,username:'fixture',publicKey:'ssh-ed25519 '+'A'.repeat(64),
   fingerprint:'SHA256:'+'A'.repeat(43),credentialRef:randomUUID(),remoteRoot:'/fixture',allowedTasks:['git-export'],maxConcurrent:2});
  const commit='1'.repeat(40),tree='2'.repeat(40),bundle=Buffer.from('synthetic-bundle');
  const operationId=randomUUID();
  const requestDigest=digest({action:'git-export',operationId,intentId:intent.id,contextId,hostId,commit,tree});
  await db.pool.query(`INSERT INTO ac_remote_operations(id,context_id,host_id,task_id,request_digest,manager_epoch,state,intent_id,remote_receipt)
   VALUES($1,$2,$3,'git-export',$4,$5,'completed',$6,$7)`,[operationId,contextId,hostId,requestDigest,authority.epoch,intent.id,{commit,tree,bundleSha256:createHash('sha256').update(bundle).digest('hex')}]);
  const service=new ProjectAdmin(db,[{id:'fixture',label:'Fixture',path:rootPath}],join(rootPath,'private'));
  const command=(extra:Record<string,unknown>={})=>({schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.materializeRemoteSource' as const,
   payload:{projectId:project,contextId,operationId,hostId,commit,tree,bundle:bundle.toString('base64'),...extra}});
  const missing=command();
  await assert.rejects(service.execute(principal,missing,proof(missing)),/REMOTE_SOURCE_AUTHORIZATION_REQUIRED/);
  const bad=command();
  await assert.rejects(service.execute(principal,bad,{...proof(bad),signature:'0'.repeat(128)}),/OPERATOR_SIGNATURE_INVALID/);
  const outsider='outsider-'+randomUUID(),outsiderKeys=generateKeyPairSync('ed25519'),outsiderDevice=randomUUID();
  await new Operators(db).enroll(principal,outsider,outsiderDevice,outsiderKeys.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const outsiderProof=(value:Record<string,unknown>)=>{const data={deviceId:outsiderDevice,expiresAt:Date.now()+120000};return {...data,signature:sign(null,Buffer.from(operatorMessage(outsider,value,data,installation)),outsiderKeys.privateKey).toString('hex')};};
  await assert.rejects(service.execute(outsider,missing,outsiderProof(missing)),/CONTROL_ADMIN_REQUIRED/);
  const adminOnly='admin-'+randomUUID();
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[adminOnly]);
  const adminKeys=generateKeyPairSync('ed25519'),adminDevice=randomUUID();
  await new Operators(db).enroll(principal,adminOnly,adminDevice,adminKeys.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const adminProof=(value:Record<string,unknown>)=>{const data={deviceId:adminDevice,expiresAt:Date.now()+120000};return {...data,signature:sign(null,Buffer.from(operatorMessage(adminOnly,value,data,installation)),adminKeys.privateKey).toString('hex')};};
  await assert.rejects(service.execute(adminOnly,missing,adminProof(missing)),/PROJECT_OWNER_REQUIRED/);
  const authId=randomUUID();
  await db.pool.query(`INSERT INTO ac_control_intents(id,context_id,principal_id,payload_digest,action,result) VALUES($1,$2,$3,$4,'remote.source.authorize','{}')`,[authId,contextId,principal,'a'.repeat(64)]);
  await db.pool.query(`INSERT INTO ac_remote_source_authorizations(control_intent_id,context_id,project_id,intent_id,host_id,commit_id,tree_id,commitment_digest,principal_id,operator_command,operator_proof,operator_public_key,installation_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}','{}','not-a-key',$10)`,[authId,contextId,project,intent.id,hostId,commit,tree,'b'.repeat(64),principal,installation]);
  await assert.rejects(service.execute(principal,missing,proof(missing)),/REMOTE_SOURCE_AUTHORIZATION_INVALID/);
  const otherTree=command({tree:'3'.repeat(40)});
  await assert.rejects(service.execute(principal,otherTree,proof(otherTree)),/REMOTE_SOURCE_IDENTITY_MISMATCH/);
  const otherHost=command({hostId:randomUUID()});
  await assert.rejects(service.execute(principal,otherHost,proof(otherHost)),/REMOTE_SOURCE_IDENTITY_MISMATCH/);
  const otherProject=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[otherProject,'other']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[otherProject,principal]);
  const other=command({projectId:otherProject});
  await assert.rejects(service.execute(principal,other,proof(other)),/REMOTE_SOURCE_IDENTITY_MISMATCH/);
  const huge=command({bundle:Buffer.alloc(65537).toString('base64')});
  await assert.rejects(service.execute(principal,huge,proof(huge)),/REMOTE_SOURCE_BUNDLE_TOO_LARGE/);
 }finally{await db.close();await isolated.close();await rm(rootPath,{recursive:true,force:true});}
});

test('materialization refuses an unsafe root, another repository identity and a conflicting destination',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(base,'rsmsafe'),db=new Ledger(isolated.url);
 const rootPath=await realpath(await mkdtemp(join(tmpdir(),'ac-rsm-safe-')));
 const principal='rsm-'+randomUUID(),project=randomUUID();
 try{
  await db.migrate();
  const repo=join(rootPath,'repository');await mkdir(repo);execFileSync('git',['init','-q',repo]);
  const keys=generateKeyPairSync('ed25519'),deviceId=randomUUID();
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await new Operators(db).enroll(principal,principal,deviceId,keys.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const installation=(await db.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0].id;
  const proof=(value:Record<string,unknown>)=>{const data={deviceId,expiresAt:Date.now()+120000};return {...data,signature:sign(null,Buffer.from(operatorMessage(principal,value,data,installation)),keys.privateKey).toString('hex')};};
  const roots=[{id:'fixture',label:'Fixture',path:rootPath}],service=new ProjectAdmin(db,roots,join(rootPath,'private'));
  const registered={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.register',payload:{projectId:project,label:'Bound',rootId:'fixture',relativePath:'repository'}};
  await service.execute(principal,registered,proof(registered));
  const contextId=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,contextId,randomUUID(),'fixture',60);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
  const hostId=randomUUID(),commit='4'.repeat(40),tree='5'.repeat(40),bundle=Buffer.from('bound-bundle'),operationId=randomUUID();
  await new RemoteOperations(db,{async exchange(){throw Error('unused');}}).registerHost(principal,project,{id:hostId,label:'fixture',hostname:'fixture.invalid',port:2222,username:'fixture',publicKey:'ssh-ed25519 '+'B'.repeat(64),
   fingerprint:'SHA256:'+'B'.repeat(43),credentialRef:randomUUID(),remoteRoot:'/fixture',allowedTasks:['git-export'],maxConcurrent:2});
  const control=new Control(db),authorized={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,action:'remote.source.authorize' as const,
   payload:{schemaVersion:1 as const,intentId:intent.id,hostId,commit,tree}};
  await control.execute(principal,authorized,proof(authorized));
  await db.pool.query(`INSERT INTO ac_remote_operations(id,context_id,host_id,task_id,request_digest,manager_epoch,state,intent_id,remote_receipt)
   VALUES($1,$2,$3,'git-export',$4,$5,'completed',$6,$7)`,[operationId,contextId,hostId,digest({action:'git-export',operationId,intentId:intent.id,contextId,hostId,commit,tree}),authority.epoch,intent.id,{commit,tree,bundleSha256:createHash('sha256').update(bundle).digest('hex')}]);
  const materialize={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.materializeRemoteSource' as const,
   payload:{projectId:project,contextId,operationId,hostId,commit,tree,bundle:bundle.toString('base64')}};
  await assert.rejects(service.execute(principal,materialize,proof(materialize)),/PROJECT_REPOSITORY_ALREADY_BOUND/);
  const fresh=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[fresh,'fresh']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[fresh,principal]);
  const freshContext=await db.createContext(principal,fresh,randomUUID()),freshAuthority=await db.acquire(principal,freshContext,randomUUID(),'fixture',60);
  const freshIntent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:freshContext,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fresh'}},freshAuthority,'api');
  const freshHost=randomUUID(),freshOperation=randomUUID();
  await new RemoteOperations(db,{async exchange(){throw Error('unused');}}).registerHost(principal,fresh,{id:freshHost,label:'fresh',hostname:'fresh.invalid',port:2222,username:'fixture',publicKey:'ssh-ed25519 '+'C'.repeat(64),
   fingerprint:'SHA256:'+'C'.repeat(43),credentialRef:randomUUID(),remoteRoot:'/fixture',allowedTasks:['git-export'],maxConcurrent:2});
  const freshAuth={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:freshContext,action:'remote.source.authorize' as const,
   payload:{schemaVersion:1 as const,intentId:freshIntent.id,hostId:freshHost,commit,tree}};
  await control.execute(principal,freshAuth,proof(freshAuth));
  await db.pool.query(`INSERT INTO ac_remote_operations(id,context_id,host_id,task_id,request_digest,manager_epoch,state,intent_id,remote_receipt)
   VALUES($1,$2,$3,'git-export',$4,$5,'completed',$6,$7)`,[freshOperation,freshContext,freshHost,digest({action:'git-export',operationId:freshOperation,intentId:freshIntent.id,contextId:freshContext,hostId:freshHost,commit,tree}),freshAuthority.epoch,freshIntent.id,{commit,tree,bundleSha256:createHash('sha256').update(bundle).digest('hex')}]);
  const conflictDir=join(rootPath,'remote-sources',fresh);await mkdir(join(rootPath,'remote-sources'));await mkdir(conflictDir);execFileSync('git',['init','-q',conflictDir]);
  await writeFile(join(conflictDir,'other.txt'),'other\n');
  execFileSync('git',['-C',conflictDir,'add','other.txt']);
  execFileSync('git',['-C',conflictDir,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','other']);
  const conflicting={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.materializeRemoteSource' as const,
   payload:{projectId:fresh,contextId:freshContext,operationId:freshOperation,hostId:freshHost,commit,tree,bundle:bundle.toString('base64')}};
  await assert.rejects(service.execute(principal,conflicting,proof(conflicting)),/REMOTE_SOURCE_DESTINATION_CONFLICT/);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_project_repository_identity WHERE project_id=$1',[fresh])).rows[0].n,0);
  await chmod(rootPath,0o777);
  const unsafeProject=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[unsafeProject,'unsafe']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[unsafeProject,principal]);
  const unsafeContext=await db.createContext(principal,unsafeProject,randomUUID()),unsafeAuthority=await db.acquire(principal,unsafeContext,randomUUID(),'fixture',60);
  const unsafeIntent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:unsafeContext,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:unsafe'}},unsafeAuthority,'api');
  const unsafeHost=randomUUID(),unsafeOperation=randomUUID();
  await new RemoteOperations(db,{async exchange(){throw Error('unused');}}).registerHost(principal,unsafeProject,{id:unsafeHost,label:'unsafe',hostname:'unsafe.invalid',port:2222,username:'fixture',publicKey:'ssh-ed25519 '+'D'.repeat(64),
   fingerprint:'SHA256:'+'D'.repeat(43),credentialRef:randomUUID(),remoteRoot:'/fixture',allowedTasks:['git-export'],maxConcurrent:2});
  const unsafeAuth={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:unsafeContext,action:'remote.source.authorize' as const,
   payload:{schemaVersion:1 as const,intentId:unsafeIntent.id,hostId:unsafeHost,commit,tree}};
  await control.execute(principal,unsafeAuth,proof(unsafeAuth));
  await db.pool.query(`INSERT INTO ac_remote_operations(id,context_id,host_id,task_id,request_digest,manager_epoch,state,intent_id,remote_receipt)
   VALUES($1,$2,$3,'git-export',$4,$5,'completed',$6,$7)`,[unsafeOperation,unsafeContext,unsafeHost,digest({action:'git-export',operationId:unsafeOperation,intentId:unsafeIntent.id,contextId:unsafeContext,hostId:unsafeHost,commit,tree}),unsafeAuthority.epoch,unsafeIntent.id,{commit,tree,bundleSha256:createHash('sha256').update(bundle).digest('hex')}]);
  const unsafe={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.materializeRemoteSource' as const,
   payload:{projectId:unsafeProject,contextId:unsafeContext,operationId:unsafeOperation,hostId:unsafeHost,commit,tree,bundle:bundle.toString('base64')}};
  await assert.rejects(service.execute(principal,unsafe,proof(unsafe)),/PROJECT_ROOT_UNAVAILABLE/);
 }finally{await chmod(rootPath,0o755).catch(()=>{});await db.close();await isolated.close();await rm(rootPath,{recursive:true,force:true});}
});

async function exportedFixture(db:Ledger,principal:string,project:string,rootPath:string,bundle:Buffer,commit:string,tree:string){
 const keys=generateKeyPairSync('ed25519'),deviceId=randomUUID();
 await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'materialized']);
 await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
 await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
 await new Operators(db).enroll(principal,principal,deviceId,keys.publicKey.export({format:'der',type:'spki'}).toString('base64'));
 const installation=(await db.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0].id;
 const proof=(value:Record<string,unknown>)=>{const data={deviceId,expiresAt:Date.now()+120000};return {...data,signature:sign(null,Buffer.from(operatorMessage(principal,value,data,installation)),keys.privateKey).toString('hex')};};
 const contextId=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,contextId,randomUUID(),'fixture',60);
 const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:materialize'}},authority,'api');
 const hostId=randomUUID(),operationId=randomUUID(),sha=createHash('sha256').update(bundle).digest('hex');
 const transport:RemoteTransport={async exchange(_host,raw){const {action,...reply}=raw as Record<string,unknown>;return {...reply,bundle:bundle.toString('base64'),bundleSha256:sha};}};
 const remote=new RemoteOperations(db,transport);
 await remote.registerHost(principal,project,{id:hostId,label:'fixture',hostname:'fixture.invalid',port:2222,username:'fixture',publicKey:'ssh-ed25519 '+'E'.repeat(64),
  fingerprint:'SHA256:'+'E'.repeat(43),credentialRef:randomUUID(),remoteRoot:'/fixture',allowedTasks:['git-export'],maxConcurrent:2});
 const control=new Control(db),authorized={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,action:'remote.source.authorize' as const,
  payload:{schemaVersion:1 as const,intentId:intent.id,hostId,commit,tree}};
 await control.execute(principal,authorized,proof(authorized));
 const exported=await remote.exportGit(principal,{operationId,intentId:intent.id,contextId,hostId,commit,tree},authority);
 assert.equal(exported.snapshot.reviewStatus,'not_reviewed');
 return {proof,contextId,hostId,operationId,commit,tree,bundle,installation,deviceId,privateKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),serviceRoots:[{id:'fixture',label:'Fixture',path:rootPath}] as const,publicKey:'ssh-ed25519 '+'E'.repeat(64)};
}

async function recordExport(db:Ledger,principal:string,project:string,bundle:Buffer,commit:string,tree:string,proof:(value:Record<string,unknown>)=>OperatorProof){
 await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'materialized-more']);
 await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
 const contextId=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,contextId,randomUUID(),'fixture',60);
 const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:materialize-more'}},authority,'api');
 const hostId=randomUUID(),operationId=randomUUID(),sha=createHash('sha256').update(bundle).digest('hex');
 const transport:RemoteTransport={async exchange(_host,raw){const {action,...reply}=raw as Record<string,unknown>;return {...reply,bundle:bundle.toString('base64'),bundleSha256:sha};}};
 const remote=new RemoteOperations(db,transport);
 await remote.registerHost(principal,project,{id:hostId,label:'fixture',hostname:'fixture.invalid',port:2222,username:'fixture',publicKey:'ssh-ed25519 '+'F'.repeat(64),
  fingerprint:'SHA256:'+'F'.repeat(43),credentialRef:randomUUID(),remoteRoot:'/fixture',allowedTasks:['git-export'],maxConcurrent:2});
 const control=new Control(db),authorized={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,action:'remote.source.authorize' as const,
  payload:{schemaVersion:1 as const,intentId:intent.id,hostId,commit,tree}};
 await control.execute(principal,authorized,proof(authorized));
 await remote.exportGit(principal,{operationId,intentId:intent.id,contextId,hostId,commit,tree},authority);
 return {contextId,hostId,operationId};
}

function materializeCommand(project:string,fixture:{contextId:string;operationId:string;hostId:string},commit:string,tree:string,bundle:Buffer){
 return {schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.materializeRemoteSource' as const,
  payload:{projectId:project,contextId:fixture.contextId,operationId:fixture.operationId,hostId:fixture.hostId,commit,tree,bundle:bundle.toString('base64')}};
}

async function deadPid(){
 const sleeper=spawn(process.execPath,['-e','setTimeout(()=>{},30000)']);
 const pid=sleeper.pid;
 if(!pid)throw Error('DEAD_PID_UNAVAILABLE');
 sleeper.kill('SIGKILL');
 await new Promise(resolve=>sleeper.once('exit',resolve));
 return pid;
}

async function overlapWinner(service:ProjectAdmin,principal:string,command:ReturnType<typeof materializeCommand>,proof:(value:Record<string,unknown>)=>OperatorProof){
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 let holding=false;
 const gated=new ProjectAdmin(service.ledger,service.roots,service.privateDirectory,{...service.options,beforeRemoteSourceRegister:async()=>{holding=true;await gate;}});
 const second={...command,deliveryAttemptId:randomUUID()};
 const first=gated.execute(principal,command,proof(command));
 const other=gated.execute(principal,second,proof(command));
 const seen:unknown[]=[];
 void first.then(value=>seen.push(value),error=>seen.push(error));
 void other.then(value=>seen.push(value),error=>seen.push(error));
 for(let i=0;i<200&&!(holding&&seen.length);i++)await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(holding,true);
 assert.match(String(seen[0]),/REMOTE_SOURCE_MATERIALIZATION_BUSY/);
 release();
 const settled=await Promise.allSettled([first,other]);
 assert.equal(settled.filter(item=>item.status==='fulfilled').length,1);
 const winner=(settled.find(item=>item.status==='fulfilled') as PromiseFulfilledResult<{reviewStatus:string}>).value;
 assert.equal(winner.reviewStatus,'not_reviewed');
 return winner;
}

test('authorized snapshot becomes the project repository with immutable provenance and crash recovery',async t=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const tmpfs=await privateTmpfs();
 if(!tmpfs)return t.skip('tmpfs de até 128 MiB indisponível; a materialização Git não foi executada');
 const isolated=await isolatedDatabase(base,'rsmpub'),db=new Ledger(isolated.url);
 const rootPath=await realpath(await mkdtemp(join(tmpdir(),'ac-rsm-pub-'))),work=await mkdtemp(join(tmpdir(),'ac-rsm-src-'));
 const principal='rsm-'+randomUUID(),project=randomUUID();
 try{
  const source=join(work,'source');
  execFileSync('git',['init','-q','-b','agent-control-export',source]);
  await writeFile(join(source,'fixture.txt'),'synthetic remote content\n');
  execFileSync('git',['-C',source,'add','fixture.txt']);
  execFileSync('git',['-C',source,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','fixture']);
  const commit=execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const tree=execFileSync('git',['-C',source,'rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
  const bundlePath=join(work,'source.bundle');
  execFileSync('git',['-C',source,'bundle','create',bundlePath,'refs/heads/agent-control-export']);
  const bundle=await readFile(bundlePath);
  await db.migrate();
  const fixture=await exportedFixture(db,principal,project,rootPath,bundle,commit,tree);
  let crash=true;
  const service=new ProjectAdmin(db,fixture.serviceRoots,join(rootPath,'private'),{remoteSourceTmpfs:tmpfs,beforeRemoteSourceRegister:async()=>{if(crash){crash=false;throw Error('REMOTE_SOURCE_MATERIALIZATION_INTERRUPTED');}}});
  const command={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.materializeRemoteSource' as const,
   payload:{projectId:project,contextId:fixture.contextId,operationId:fixture.operationId,hostId:fixture.hostId,commit,tree,bundle:bundle.toString('base64')}};
  await assert.rejects(service.execute(principal,command,fixture.proof(command)),/REMOTE_SOURCE_MATERIALIZATION_INTERRUPTED/);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_project_repository_identity WHERE project_id=$1',[project])).rows[0].n,0);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_remote_source_materializations')).rows[0].n,0);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_project_repositories WHERE project_id=$1',[project])).rows[0].n,0);
  const resumed=new ProjectAdmin(db,fixture.serviceRoots,join(rootPath,'private'),{remoteSourceTmpfs:tmpfs});
  const result=await resumed.execute(principal,command,fixture.proof(command));
  assert.equal(result.reviewStatus,'not_reviewed');
  assert.deepEqual(await resumed.execute(principal,{...command,deliveryAttemptId:randomUUID()},fixture.proof(command)),result);
  const changed={...command,payload:{...command.payload,bundle:Buffer.from('different').toString('base64')}};
  await assert.rejects(resumed.execute(principal,changed,fixture.proof(changed)),/PROJECT_ADMIN_INTENT_CONFLICT/);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_remote_source_materializations WHERE project_id=$1',[project])).rows[0].n,1);
  assert.equal(await readFile(join(rootPath,'remote-sources',project,'fixture.txt'),'utf8'),'synthetic remote content\n');
  const row=(await db.pool.query('SELECT * FROM ac_remote_operations WHERE id=$1',[fixture.operationId])).rows[0];
  assert.equal(sourceSnapshot(row,{operationId:fixture.operationId,contextId:fixture.contextId,intentId:row.intent_id,hostId:fixture.hostId,projectId:project,commit,tree,requestDigest:row.request_digest,bundleSha256:row.remote_receipt.bundleSha256}).reviewStatus,'not_reviewed');
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_artifacts WHERE project_id=$1',[project])).rows[0].n,0);
  await assert.rejects(db.pool.query('UPDATE ac_remote_source_materializations SET principal_id=$1',[principal]),/POLICY_REVISION_IMMUTABLE/);
  const view=await resumed.view(principal);
  assert.equal(JSON.stringify(view).includes(fixture.publicKey),false);
  assert.equal(JSON.stringify(view).includes('bundle'),false);
  assert.deepEqual(view.remoteSources,[{projectId:project,hostId:fixture.hostId,commit,tree,state:'materialized',reviewStatus:'not_reviewed'}]);
  assert.equal((await resumed.view('stranger-'+randomUUID())).remoteSources.length,0);
  assert.equal((await new Projects(db,fixture.serviceRoots).authorized(principal,project))?.repo,join(rootPath,'remote-sources',project));
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_audit WHERE kind='project.remote_source.materialized'")).rows[0].n,1);
 }finally{await db.close();await isolated.close();await rm(rootPath,{recursive:true,force:true});await rm(work,{recursive:true,force:true});await rm(tmpfs,{recursive:true,force:true});}
});

test('two concurrent materializations of one project leave a single binding',async t=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const tmpfs=await privateTmpfs();
 if(!tmpfs)return t.skip('tmpfs de até 128 MiB indisponível; a materialização Git não foi executada');
 const isolated=await isolatedDatabase(base,'rsmrace'),db=new Ledger(isolated.url);
 const rootPath=await realpath(await mkdtemp(join(tmpdir(),'ac-rsm-race-'))),work=await mkdtemp(join(tmpdir(),'ac-rsm-race-src-'));
 const principal='rsm-'+randomUUID(),project=randomUUID();
 try{
  const source=join(work,'source');
  execFileSync('git',['init','-q','-b','agent-control-export',source]);
  await writeFile(join(source,'fixture.txt'),'race\n');
  execFileSync('git',['-C',source,'add','fixture.txt']);
  execFileSync('git',['-C',source,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','race']);
  const commit=execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const tree=execFileSync('git',['-C',source,'rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
  const bundlePath=join(work,'source.bundle');
  execFileSync('git',['-C',source,'bundle','create',bundlePath,'refs/heads/agent-control-export']);
  const bundle=await readFile(bundlePath);
  await db.migrate();
  const fixture=await exportedFixture(db,principal,project,rootPath,bundle,commit,tree);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  let holding=false;
  const service=new ProjectAdmin(db,fixture.serviceRoots,join(rootPath,'private'),{remoteSourceTmpfs:tmpfs,beforeRemoteSourceRegister:async()=>{holding=true;await gate;}});
  const command={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.materializeRemoteSource' as const,
   payload:{projectId:project,contextId:fixture.contextId,operationId:fixture.operationId,hostId:fixture.hostId,commit,tree,bundle:bundle.toString('base64')}};
  const second={...command,deliveryAttemptId:randomUUID()};
  const first=service.execute(principal,command,fixture.proof(command));
  const other=service.execute(principal,second,fixture.proof(command));
  const seen:unknown[]=[];
  void first.then(value=>seen.push(value),error=>seen.push(error));
  void other.then(value=>seen.push(value),error=>seen.push(error));
  for(let i=0;i<100&&!(holding&&seen.length);i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(holding,true);
  assert.match(String(seen[0]),/REMOTE_SOURCE_MATERIALIZATION_BUSY/);
  release();
  const settled=await Promise.allSettled([first,other]);
  assert.equal(settled.filter(item=>item.status==='fulfilled').length,1);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_remote_source_materializations')).rows[0].n,1);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_project_repository_identity WHERE project_id=$1',[project])).rows[0].n,1);
  const winner=settled.find(item=>item.status==='fulfilled') as PromiseFulfilledResult<{state:string}>;
  assert.deepEqual(await service.execute(principal,{...command,deliveryAttemptId:randomUUID()},fixture.proof(command)),winner.value);
 }finally{await db.close();await isolated.close();await rm(rootPath,{recursive:true,force:true});await rm(work,{recursive:true,force:true});await rm(tmpfs,{recursive:true,force:true});}
});

async function makeBundle(directory:string,content:string){
 await mkdir(directory,{recursive:true});
 const source=join(directory,'source');
 execFileSync('git',['init','-q','-b','agent-control-export',source]);
 await writeFile(join(source,'fixture.txt'),content);
 execFileSync('git',['-C',source,'add','fixture.txt']);
 execFileSync('git',['-C',source,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','fixture']);
 const commit=execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const tree=execFileSync('git',['-C',source,'rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
 const bundlePath=join(directory,'source.bundle');
 execFileSync('git',['-C',source,'bundle','create',bundlePath,'refs/heads/agent-control-export']);
 return {commit,tree,bundle:await readFile(bundlePath)};
}

test('a killed process resumes once and an incomplete lock is reclaimed without a second binding',async t=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const tmpfs=await privateTmpfs();
 if(!tmpfs)return t.skip('tmpfs de até 128 MiB indisponível; a materialização Git não foi executada');
 const isolated=await isolatedDatabase(base,'rsmkill'),db=new Ledger(isolated.url);
 const rootPath=await realpath(await mkdtemp(join(tmpdir(),'ac-rsm-kill-'))),work=await mkdtemp(join(tmpdir(),'ac-rsm-kill-src-'));
 const principal='rsm-'+randomUUID(),project=randomUUID(),jobPath=join(tmpdir(),`ac-rsm-job-${randomUUID()}.json`);
 try{
  const killed=await makeBundle(join(work,'killed'),'published-before-kill\n');
  await db.migrate();
  const fixture=await exportedFixture(db,principal,project,rootPath,killed.bundle,killed.commit,killed.tree);
  const command=materializeCommand(project,fixture,killed.commit,killed.tree,killed.bundle);
  const databaseUrl=new URL(isolated.url);databaseUrl.searchParams.set('application_name','rsm-publish-kill');
  await writeFile(jobPath,JSON.stringify({databaseUrl:databaseUrl.href,principal,deviceId:fixture.deviceId,privateKeyPem:fixture.privateKeyPem,roots:fixture.serviceRoots,privateDirectory:join(rootPath,'private'),tmpfs,command}),{mode:0o600});
  const stderr:Buffer[]=[];
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(import.meta.url)],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:{...process.env,AC_RSM_CHILD:'1',AC_RSM_JOB:jobPath},stdio:['ignore','ignore','pipe']});
  child.stderr?.on('data',chunk=>stderr.push(Buffer.from(chunk)));
  const exit=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{
   const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('CHILD_TIMEOUT'));},60000);
   child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
  });
  assert.equal(exit.signal,'SIGKILL',Buffer.concat(stderr).toString());
  for(let i=0;i<40;i++){
   const client=await db.pool.connect();
   let acquired=false;
   try{
    const locked=await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,59)) AS ok',[project]);
    acquired=locked.rows[0]?.ok===true||locked.rows[0]?.ok==='t';
    if(acquired)break;
   }finally{if(acquired)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,59))',[project]);client.release();}
   if(i===39)throw Error('CHILD_LOCK_STILL_HELD');
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  const owner=JSON.parse(await readFile(join(rootPath,'.remote-source-locks',project,'owner'),'utf8')) as {pid:number;intentId:string;token:string};
  assert.equal(owner.pid,child.pid);
  assert.equal(owner.intentId,command.intentId);
  assert.equal(Number.isInteger(owner.pid)&&owner.token.length>=16,true);
  assert.throws(()=>process.kill(owner.pid,0),{code:'ESRCH'});
  assert.equal(await readFile(join(rootPath,'remote-sources',project,'fixture.txt'),'utf8'),'published-before-kill\n');
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM ac_project_repository_identity WHERE project_id=$1',[project])).rows[0].n,0);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM ac_remote_source_materializations WHERE project_id=$1',[project])).rows[0].n,0);
  const resumed=new ProjectAdmin(db,fixture.serviceRoots,join(rootPath,'private'),{remoteSourceTmpfs:tmpfs});
  const winner=await overlapWinner(resumed,principal,command,fixture.proof);
  assert.equal(winner.reviewStatus,'not_reviewed');
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM ac_remote_source_materializations WHERE project_id=$1',[project])).rows[0].n,1);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM ac_project_repository_identity WHERE project_id=$1',[project])).rows[0].n,1);
  assert.equal(await readFile(join(rootPath,'remote-sources',project,'fixture.txt'),'utf8'),'published-before-kill\n');
  assert.equal(execFileSync('git',['-C',join(rootPath,'remote-sources',project),'rev-parse','HEAD'],{encoding:'utf8'}).trim(),killed.commit);
  const truncated=await makeBundle(join(work,'truncated'),'truncated-owner\n');
  const projectB=randomUUID(),exportedB=await recordExport(db,principal,projectB,truncated.bundle,truncated.commit,truncated.tree,fixture.proof);
  await mkdir(join(rootPath,'.remote-source-locks',projectB),{mode:0o700});
  await writeFile(join(rootPath,'.remote-source-locks',projectB,'owner'),'{',{mode:0o600});
  const commandB=materializeCommand(projectB,exportedB,truncated.commit,truncated.tree,truncated.bundle);
  await overlapWinner(new ProjectAdmin(db,fixture.serviceRoots,join(rootPath,'private'),{remoteSourceTmpfs:tmpfs}),principal,commandB,fixture.proof);
  assert.equal(await readFile(join(rootPath,'remote-sources',projectB,'fixture.txt'),'utf8'),'truncated-owner\n');
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM ac_remote_source_materializations WHERE project_id=$1',[projectB])).rows[0].n,1);
  const missing=await makeBundle(join(work,'missing'),'missing-owner\n');
  const projectC=randomUUID(),exportedC=await recordExport(db,principal,projectC,missing.bundle,missing.commit,missing.tree,fixture.proof);
  await mkdir(join(rootPath,'.remote-source-locks',projectC),{mode:0o700});
  const commandC=materializeCommand(projectC,exportedC,missing.commit,missing.tree,missing.bundle);
  const quiet=new ProjectAdmin(db,fixture.serviceRoots,join(rootPath,'private'),{remoteSourceTmpfs:tmpfs});
  assert.equal((await quiet.execute(principal,commandC,fixture.proof(commandC))).reviewStatus,'not_reviewed');
  assert.equal(await readFile(join(rootPath,'remote-sources',projectC,'fixture.txt'),'utf8'),'missing-owner\n');
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM ac_project_repository_identity WHERE project_id=$1',[projectC])).rows[0].n,1);
  assert.equal(await readFile(join(rootPath,'remote-sources',project,'fixture.txt'),'utf8'),'published-before-kill\n');
 }finally{await db.close();await isolated.close();await rm(rootPath,{recursive:true,force:true});await rm(work,{recursive:true,force:true});await rm(tmpfs,{recursive:true,force:true});await rm(jobPath,{force:true});}
});

async function stageProject(db:Ledger,principal:string,project:string,rootPath:string,proof:(value:Record<string,unknown>)=>OperatorProof,mark:string){
 const commit='a'.repeat(40),tree='b'.repeat(40),bundle=Buffer.from(`unsafe-${mark}`);
 await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,mark]);
 await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
 const contextId=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,contextId,randomUUID(),'fixture',60);
 const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:'+mark}},authority,'api');
 const hostId=randomUUID(),operationId=randomUUID();
 await new RemoteOperations(db,{async exchange(){throw Error('unused');}}).registerHost(principal,project,{id:hostId,label:mark,hostname:mark+'.invalid',port:2222,username:'fixture',publicKey:'ssh-ed25519 '+mark.slice(0,1).repeat(64),
  fingerprint:'SHA256:'+mark.slice(0,1).repeat(43),credentialRef:randomUUID(),remoteRoot:'/fixture',allowedTasks:['git-export'],maxConcurrent:2});
 const authorized={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,action:'remote.source.authorize' as const,payload:{schemaVersion:1 as const,intentId:intent.id,hostId,commit,tree}};
 await new Control(db).execute(principal,authorized,proof(authorized));
 await db.pool.query(`INSERT INTO ac_remote_operations(id,context_id,host_id,task_id,request_digest,manager_epoch,state,intent_id,remote_receipt)
  VALUES($1,$2,$3,'git-export',$4,$5,'completed',$6,$7)`,[operationId,contextId,hostId,digest({action:'git-export',operationId,intentId:intent.id,contextId,hostId,commit,tree}),authority.epoch,intent.id,{commit,tree,bundleSha256:createHash('sha256').update(bundle).digest('hex')}]);
 const service=new ProjectAdmin(db,[{id:'fixture',label:'Fixture',path:rootPath}],join(rootPath,'private'));
 return {service,command:materializeCommand(project,{contextId,operationId,hostId},commit,tree,bundle)};
}

test('unsafe symlinks and writable descendants are refused before any outside change',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(base,'rsmpath'),db=new Ledger(isolated.url);
 const principal='rsm-'+randomUUID();
 const roots:string[]=[],outsides:string[]=[];
 try{
  await db.migrate();
  const keys=generateKeyPairSync('ed25519'),deviceId=randomUUID();
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await new Operators(db).enroll(principal,principal,deviceId,keys.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const installation=(await db.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0].id as string;
  const proof=(value:Record<string,unknown>)=>{const data={deviceId,expiresAt:Date.now()+120000};return {...data,signature:sign(null,Buffer.from(operatorMessage(principal,value,data,installation)),keys.privateKey).toString('hex')};};
  const freshRoot=async()=>{const path=await realpath(await mkdtemp(join(tmpdir(),'ac-rsm-leaf-')));roots.push(path);return path;};
  const outsideDir=async()=>{const path=await realpath(await mkdtemp(join(tmpdir(),'ac-rsm-out-')));outsides.push(path);return path;};
  const untouched=async(outside:string,sentinel:string,mode:number)=>{
   assert.equal(await readFile(join(outside,'sentinel'),'utf8'),sentinel);
   assert.equal((await lstat(outside)).mode&0o777,mode);
   assert.deepEqual(await readdir(outside),['sentinel']);
   assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM ac_project_repository_identity')).rows[0].n,0);
  };
  const rootA=await freshRoot(),outsideA=await outsideDir();
  await chmod(outsideA,0o750);await writeFile(join(outsideA,'sentinel'),'keep-staging');await symlink(outsideA,join(rootA,'.remote-source-staging'));
  const stagedA=await stageProject(db,principal,randomUUID(),rootA,proof,'A');
  await assert.rejects(stagedA.service.execute(principal,stagedA.command,proof(stagedA.command)),/PROJECT_PATH_FORBIDDEN/);
  await untouched(outsideA,'keep-staging',0o750);
  assert.equal((await lstat(join(rootA,'.remote-source-staging'))).isSymbolicLink(),true);
  await assert.rejects(lstat(join(rootA,'.remote-source-locks')),{code:'ENOENT'});
  await assert.rejects(lstat(join(rootA,'remote-sources')),{code:'ENOENT'});
  const rootB=await freshRoot(),outsideB=await outsideDir();
  await chmod(outsideB,0o750);await writeFile(join(outsideB,'sentinel'),'keep-locks');await symlink(outsideB,join(rootB,'.remote-source-locks'));
  const stagedB=await stageProject(db,principal,randomUUID(),rootB,proof,'B');
  await assert.rejects(stagedB.service.execute(principal,stagedB.command,proof(stagedB.command)),/PROJECT_PATH_FORBIDDEN/);
  await untouched(outsideB,'keep-locks',0o750);
  assert.equal((await lstat(join(rootB,'.remote-source-locks'))).isSymbolicLink(),true);
  const rootC=await freshRoot(),outsideC=await outsideDir();
  await chmod(outsideC,0o705);await writeFile(join(outsideC,'sentinel'),'keep-publish');await symlink(outsideC,join(rootC,'remote-sources'));
  const stagedC=await stageProject(db,principal,randomUUID(),rootC,proof,'C');
  await assert.rejects(stagedC.service.execute(principal,stagedC.command,proof(stagedC.command)),/PROJECT_PATH_FORBIDDEN/);
  await untouched(outsideC,'keep-publish',0o705);
  assert.equal((await lstat(join(rootC,'remote-sources'))).isSymbolicLink(),true);
  const rootD=await freshRoot();
  await mkdir(join(rootD,'remote-sources'),{mode:0o700});await chmod(join(rootD,'remote-sources'),0o777);await writeFile(join(rootD,'remote-sources','sentinel'),'writable-child');
  const stagedD=await stageProject(db,principal,randomUUID(),rootD,proof,'D');
  await assert.rejects(stagedD.service.execute(principal,stagedD.command,proof(stagedD.command)),/PROJECT_PATH_FORBIDDEN/);
  assert.equal((await lstat(join(rootD,'remote-sources'))).mode&0o777,0o777);
  assert.equal(await readFile(join(rootD,'remote-sources','sentinel'),'utf8'),'writable-child');
  await assert.rejects(lstat(join(rootD,'.remote-source-locks')),{code:'ENOENT'});
  const projectE=randomUUID(),rootE=await freshRoot();
  await mkdir(join(rootE,'.remote-source-locks'),{mode:0o700});
  await mkdir(join(rootE,'.remote-source-locks',projectE),{mode:0o700});
  await chmod(join(rootE,'.remote-source-locks',projectE),0o777);
  await writeFile(join(rootE,'.remote-source-locks',projectE,'sentinel'),'writable-lock');
  const stagedE=await stageProject(db,principal,projectE,rootE,proof,'E');
  await assert.rejects(stagedE.service.execute(principal,stagedE.command,proof(stagedE.command)),/PROJECT_PATH_FORBIDDEN/);
  assert.equal((await lstat(join(rootE,'.remote-source-locks',projectE))).mode&0o777,0o777);
  assert.equal(await readFile(join(rootE,'.remote-source-locks',projectE,'sentinel'),'utf8'),'writable-lock');
  await assert.rejects(lstat(join(rootE,'remote-sources')),{code:'ENOENT'});
  const projectF=randomUUID(),rootF=await freshRoot(),pid=await deadPid();
  await mkdir(join(rootF,'.remote-source-locks',projectF),{recursive:true});
  await chmod(join(rootF,'.remote-source-locks'),0o700);
  await chmod(join(rootF,'.remote-source-locks',projectF),0o700);
  const foreign={intentId:randomUUID(),pid,token:randomUUID()};
  await writeFile(join(rootF,'.remote-source-locks',projectF,'owner'),JSON.stringify(foreign),{mode:0o600});
  const stagedF=await stageProject(db,principal,projectF,rootF,proof,'F');
  await assert.rejects(stagedF.service.execute(principal,stagedF.command,proof(stagedF.command)),/REMOTE_SOURCE_MATERIALIZATION_BUSY/);
  assert.deepEqual(JSON.parse(await readFile(join(rootF,'.remote-source-locks',projectF,'owner'),'utf8')),foreign);
  await assert.rejects(lstat(join(rootF,'remote-sources',projectF)),{code:'ENOENT'});
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM ac_project_repository_identity')).rows[0].n,0);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM ac_remote_source_materializations')).rows[0].n,0);
 }finally{await db.close();await isolated.close();await Promise.all(roots.map(path=>rm(path,{recursive:true,force:true})));await Promise.all(outsides.map(path=>rm(path,{recursive:true,force:true})));}
});
