import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {chmod,mkdtemp,readFile,realpath,rm,statfs,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createProjectAdminApi} from '../src/project-admin-api.ts';
import {createProjectGateway} from '../src/projects-api.ts';
import {ProjectAdmin} from '../src/project-admin.ts';
import type {OperatorProof} from '../src/operator.ts';
import {Operators,operatorMessage} from '../src/operator.ts';
import {Ledger} from '../src/ledger.ts';
import {Control} from '../src/control.ts';
import {RemoteOperations,type RemoteTransport} from '../src/remote.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {digest} from '../src/contracts.ts';

const proofHeader=Buffer.from(JSON.stringify({deviceId:'00000000-0000-4000-8000-000000000001',expiresAt:1,signature:'a'.repeat(128)})).toString('base64url');
const headers={'x-ac-operator-proof':proofHeader,'content-type':'application/json'};
const remoteUrl='http://localhost/api/v1/ac/project-admin/remote-source';
const legacyUrl='http://localhost/api/v1/ac/project-admin';
const handlerFor=(service:ProjectAdmin,timeout=20)=>createProjectAdminApi(service,{bodyTimeoutMs:timeout});
const posted=(body:BodyInit,url=remoteUrl,extra:Record<string,string>={})=>new Request(url,{method:'POST',headers:{...headers,...extra},body,duplex:'half'} as RequestInit & {duplex:'half'});

test('remote-source route is exact, post-only, and keeps the legacy 16 KiB ceiling',async()=>{
 const executed:unknown[]=[];
 const service={async view(){throw Error('view must not run');},async execute(_principal:string,command:unknown){executed.push(command);return {state:'applied',projectId:'00000000-0000-4000-8000-0000000000aa',reviewStatus:'not_reviewed'};}} as unknown as ProjectAdmin;
 const handler=handlerFor(service);
 const legacy=handlerFor(service);
 assert.equal((await handler(posted('{}',remoteUrl,{'content-type':'text/plain'}),'fixture')).status,415);
 assert.equal((await handler(posted('{}',remoteUrl,{'content-encoding':'gzip'}),'fixture')).status,415);
 assert.equal((await handler(new Request(remoteUrl,{method:'GET',headers}),'fixture')).status,405);
 assert.equal((await handler(new Request(remoteUrl+'/other',{method:'POST',headers,body:'{}'}),'fixture')).status,404);
 const register=await handler(posted(JSON.stringify({schemaVersion:1,action:'project.register',payload:{}})),'fixture');
 assert.equal(register.status,400);assert.equal(register.headers.get('cache-control'),'no-store');assert.equal(executed.length,0);
 const aborted=new AbortController();aborted.abort();
 const abortedResponse=await handler(new Request(remoteUrl,{method:'POST',headers,body:'{}',signal:aborted.signal}),'fixture');
 assert.equal(abortedResponse.status,400);assert.equal((await abortedResponse.json()).error,'REQUEST_ABORTED');
 const missingProof=await handler(new Request(remoteUrl,{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),'nobody');
 assert.equal(missingProof.status,403);assert.equal(missingProof.headers.get('cache-control'),'no-store');
 assert.equal(executed.length,0);
 assert.equal((await legacy(posted('x'.repeat(16385),legacyUrl),'fixture')).status,413);
 assert.equal((await handler(posted('x'.repeat(98305),remoteUrl,{'content-length':'98305'}),'fixture')).status,413);
 const chunk=new Uint8Array(32768);
 const chunked=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(chunk);controller.enqueue(chunk);controller.enqueue(chunk);controller.enqueue(new Uint8Array(8));controller.close();}});
 const chunkedResponse=await handler(posted(chunked,remoteUrl),'fixture');
 assert.equal(chunkedResponse.status,413);assert.equal(chunkedResponse.headers.get('cache-control'),'no-store');
 const lying=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(98305));controller.close();}});
 assert.equal((await handler(posted(lying,remoteUrl,{'content-length':'12'}),'fixture')).status,413);
 const stalled=new ReadableStream<Uint8Array>({start(){}});
 assert.equal((await handler(posted(stalled),'fixture')).status,408);
 const accepted=await handler(posted(JSON.stringify({schemaVersion:1,action:'project.materializeRemoteSource',payload:{projectId:'00000000-0000-4000-8000-0000000000aa'}})),'fixture');
 assert.equal(accepted.status,200);assert.equal(executed.length,1);
});

test('gateway authenticates the exact remote-source path and refuses its sibling',async()=>{
 let calls=0,selected=0;
 const gateway=createProjectGateway({projects:{authorized:async()=>{selected++;return null;}} as never,runtimes:{} as never,
  defaultProjectId:'00000000-0000-4000-8000-000000000001',appFor:()=>{throw Error('unexpected runtime');},publicFetch:async()=>new Response('public'),
  authenticate:async request=>request.headers.get('x-test-principal'),projectAdmin:async(_request,principal)=>{calls++;return Response.json({principal});}});
 assert.equal((await gateway(new Request(remoteUrl))).status,401);assert.equal(calls,0);
 const response=await gateway(new Request(remoteUrl,{method:'POST',headers:{'x-test-principal':'fixture'}}));
 assert.equal(response.status,200);assert.equal(calls,1);assert.equal(selected,0);
 assert.equal((await gateway(new Request(remoteUrl+'/extra',{headers:{'x-test-principal':'fixture'}}))).status,403);assert.equal(calls,1);
 assert.equal((await gateway(new Request(legacyUrl,{headers:{'x-test-principal':'fixture'}}))).status,200);assert.equal(calls,2);
});

async function privateTmpfs(){
 const created=await mkdtemp(join('/dev/shm','ac-rsp-'));
 const path=await realpath(created);
 await chmod(path,0o700);
 const filesystem=await statfs(path);
 if(filesystem.type!==0x01021994||Number(filesystem.blocks)*Number(filesystem.bsize)>128*1024*1024){
  await rm(path,{recursive:true,force:true});
  return undefined;
 }
 return path;
}

test('view lists only consistent owned exports and a changed authorization has no effect',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(base,'rspview'),db=new Ledger(isolated.url);
 const rootPath=await realpath(await mkdtemp(join(tmpdir(),'ac-rsp-view-'))),principal='rsp-'+randomUUID(),project=randomUUID();
 try{
  await db.migrate();
  const keys=generateKeyPairSync('ed25519'),deviceId=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Painel origem']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await new Operators(db).enroll(principal,principal,deviceId,keys.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const installation=(await db.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0].id as string;
  const proof=(value:Record<string,unknown>)=>{const data={deviceId,expiresAt:Date.now()+120000};return {...data,signature:sign(null,Buffer.from(operatorMessage(principal,value,data,installation)),keys.privateKey).toString('hex')};};
  const contextId=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,contextId,randomUUID(),'fixture',60);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:panel'}},authority,'api');
  const hostId=randomUUID(),operationId=randomUUID(),bundle=Buffer.from('panel-candidate');
  const sha=createHash('sha256').update(bundle).digest('hex'),commit='a'.repeat(40),tree='b'.repeat(40);
  const transport:RemoteTransport={async exchange(_host,raw){const {action:_action,...reply}=raw as Record<string,unknown>;return {...reply,bundle:bundle.toString('base64'),bundleSha256:sha};}};
  const remote=new RemoteOperations(db,transport);
  await remote.registerHost(principal,project,{id:hostId,label:'fixture',hostname:'secret.invalid',port:2222,username:'fixture',publicKey:'ssh-ed25519 '+'A'.repeat(64),
   fingerprint:'SHA256:'+'A'.repeat(43),credentialRef:randomUUID(),remoteRoot:'/secret/root',allowedTasks:['git-export'],maxConcurrent:2});
  const control=new Control(db);
  const authorized={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,action:'remote.source.authorize' as const,payload:{schemaVersion:1 as const,intentId:intent.id,hostId,commit,tree}};
  await control.execute(principal,authorized,proof(authorized));
  await remote.exportGit(principal,{operationId,intentId:intent.id,contextId,hostId,commit,tree},authority);
  const hiddenProject=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[hiddenProject,'Outro\nprojeto']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[hiddenProject,principal]);
  const hiddenContext=await db.createContext(principal,hiddenProject,randomUUID());
  const hiddenHost=randomUUID(),hiddenOperation=randomUUID();
  await remote.registerHost(principal,hiddenProject,{id:hiddenHost,label:'hidden',hostname:'hidden.invalid',port:2222,username:'fixture',publicKey:'ssh-ed25519 '+'B'.repeat(64),
   fingerprint:'SHA256:'+'B'.repeat(43),credentialRef:randomUUID(),remoteRoot:'/hidden',allowedTasks:['git-export'],maxConcurrent:1});
  const hiddenIntent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:hiddenContext,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:hidden'}},await db.acquire(principal,hiddenContext,randomUUID(),'fixture',60),'api');
  await db.pool.query(`INSERT INTO ac_remote_operations(id,context_id,host_id,task_id,request_digest,manager_epoch,state,intent_id,remote_receipt)
   VALUES($1,$2,$3,'git-export',$4,1,'completed',$5,$6)`,[hiddenOperation,hiddenContext,hiddenHost,digest({action:'git-export',operationId:hiddenOperation,intentId:hiddenIntent.id,contextId:hiddenContext,hostId:hiddenHost,commit,tree}),hiddenIntent.id,{commit,tree,bundleSha256:sha,hostname:'secret.invalid',bundle:bundle.toString('base64')}]);
  const authId=randomUUID();
  await db.pool.query(`INSERT INTO ac_control_intents(id,context_id,principal_id,payload_digest,action,result) VALUES($1,$2,$3,$4,'remote.source.authorize','{}')`,[authId,hiddenContext,principal,'d'.repeat(64)]);
  await db.pool.query(`INSERT INTO ac_remote_source_authorizations(control_intent_id,context_id,project_id,intent_id,host_id,commit_id,tree_id,commitment_digest,principal_id,operator_command,operator_proof,operator_public_key,installation_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}','{}','not-a-key',$10)`,[authId,hiddenContext,hiddenProject,hiddenIntent.id,hiddenHost,commit,tree,'e'.repeat(64),principal,installation]);
  const service=new ProjectAdmin(db,[{id:'fixture',label:'Fixture',path:rootPath}],join(rootPath,'private'));
  const view=await service.view(principal);
  assert.equal(JSON.stringify(view).includes('bundle'),false);
  assert.equal(JSON.stringify(view).includes('secret.invalid'),false);
  assert.equal(JSON.stringify(view).includes('/secret'),false);
  assert.equal(JSON.stringify(view).includes('ssh-ed25519'),false);
  assert.deepEqual(view.remoteSourceCandidates,[{projectId:project,contextId,operationId,hostId,label:'Painel origem',commit,tree,sha256:sha,state:'exported',reviewStatus:'not_reviewed'}]);
  const viewer='viewer-'+randomUUID();
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[viewer]);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'viewer')",[project,viewer]);
  assert.deepEqual((await service.view(viewer)).remoteSourceCandidates,[]);
  const stranger='stranger-'+randomUUID();
  assert.equal('remoteSourceCandidates' in await service.view(stranger),false);
  const original=(await db.pool.query('SELECT payload_digest FROM ac_control_intents WHERE id=$1',[authorized.intentId])).rows[0].payload_digest as string;
  await db.pool.query('UPDATE ac_control_intents SET payload_digest=$2 WHERE id=$1',[authorized.intentId,'c'.repeat(64)]);
  const stale=await service.view(principal);
  assert.equal(stale.remoteSourceCandidates?.length,1);
  const command={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.materializeRemoteSource' as const,
   payload:{projectId:project,contextId,operationId,hostId,commit,tree,bundle:bundle.toString('base64')}};
  const api=createProjectAdminApi(service);
  const header=Buffer.from(JSON.stringify(proof(command))).toString('base64url');
  const refused=await api(new Request(remoteUrl,{method:'POST',headers:{'content-type':'application/json','x-ac-operator-proof':header},body:JSON.stringify(command)}),principal);
  assert.equal(refused.status,403);assert.equal((await refused.json()).error,'REMOTE_SOURCE_AUTHORIZATION_INVALID');
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_remote_source_materializations')).rows[0].n,0);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_project_repositories')).rows[0].n,0);
  await db.pool.query('UPDATE ac_control_intents SET payload_digest=$2 WHERE id=$1',[authorized.intentId,original]);
  const otherProject=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[otherProject,'outro']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[otherProject,principal]);
  const crossed={...command,intentId:randomUUID(),deliveryAttemptId:randomUUID(),payload:{...command.payload,projectId:otherProject}};
  const crossedHeader=Buffer.from(JSON.stringify(proof(crossed))).toString('base64url');
  const crossedResponse=await api(new Request(remoteUrl,{method:'POST',headers:{'content-type':'application/json','x-ac-operator-proof':crossedHeader},body:JSON.stringify(crossed)}),principal);
  assert.equal(crossedResponse.status,409);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_remote_source_materializations')).rows[0].n,0);
  const missing=await api(new Request(remoteUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(command)}),principal);
  assert.equal(missing.status,403);assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_project_admin_intents')).rows[0].n,0);
 }finally{await db.close();await isolated.close();await rm(rootPath,{recursive:true,force:true});}
});

test('http materializes a git bundle between 16 and 64 KiB and preserves both body ceilings',async t=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const tmpfs=await privateTmpfs();
 if(!tmpfs)return t.skip('tmpfs de até 128 MiB indisponível; a materialização Git não foi executada');
 const isolated=await isolatedDatabase(base,'rsphttp'),db=new Ledger(isolated.url);
 const rootPath=await realpath(await mkdtemp(join(tmpdir(),'ac-rsp-http-'))),work=await mkdtemp(join(tmpdir(),'ac-rsp-src-'));
 const principal='rsp-'+randomUUID(),project=randomUUID();
 try{
  const source=join(work,'source');
  execFileSync('git',['init','-q','-b','agent-control-export',source]);
  await writeFile(join(source,'fixture.bin'),randomBytes(20000));
  execFileSync('git',['-C',source,'add','fixture.bin']);
  execFileSync('git',['-C',source,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','fixture']);
  const commit=execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const tree=execFileSync('git',['-C',source,'rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
  const bundlePath=join(work,'source.bundle');
  execFileSync('git',['-C',source,'bundle','create',bundlePath,'refs/heads/agent-control-export']);
  const bundle=await readFile(bundlePath);
  assert.equal(bundle.length>16384&&bundle.length<=65536,true);
  await db.migrate();
  const keys=generateKeyPairSync('ed25519'),deviceId=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Bundle HTTP']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await new Operators(db).enroll(principal,principal,deviceId,keys.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const installation=(await db.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0].id as string;
  const proof=(value:Record<string,unknown>):OperatorProof=>{const data={deviceId,expiresAt:Date.now()+120000};return {...data,signature:sign(null,Buffer.from(operatorMessage(principal,value,data,installation)),keys.privateKey).toString('hex')};};
  const contextId=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,contextId,randomUUID(),'fixture',60);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:http'}},authority,'api');
  const hostId=randomUUID(),operationId=randomUUID(),sha=createHash('sha256').update(bundle).digest('hex');
  const transport:RemoteTransport={async exchange(_host,raw){const {action:_action,...reply}=raw as Record<string,unknown>;return {...reply,bundle:bundle.toString('base64'),bundleSha256:sha};}};
  const remote=new RemoteOperations(db,transport);
  await remote.registerHost(principal,project,{id:hostId,label:'fixture',hostname:'fixture.invalid',port:2222,username:'fixture',publicKey:'ssh-ed25519 '+'C'.repeat(64),
   fingerprint:'SHA256:'+'C'.repeat(43),credentialRef:randomUUID(),remoteRoot:'/fixture',allowedTasks:['git-export'],maxConcurrent:2});
  const authorized={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,action:'remote.source.authorize' as const,payload:{schemaVersion:1 as const,intentId:intent.id,hostId,commit,tree}};
  await new Control(db).execute(principal,authorized,proof(authorized));
  await remote.exportGit(principal,{operationId,intentId:intent.id,contextId,hostId,commit,tree},authority);
  const service=new ProjectAdmin(db,[{id:'fixture',label:'Fixture',path:rootPath}],join(rootPath,'private'),{remoteSourceTmpfs:tmpfs});
  const before=await service.view(principal);
  assert.equal(before.remoteSourceCandidates?.[0]?.sha256,sha);
  assert.equal(before.remoteSourceCandidates?.[0]?.state,'exported');
  const command={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.materializeRemoteSource',payload:{projectId:project,contextId,operationId,hostId,commit,tree,bundle:bundle.toString('base64')}};
  const body=JSON.stringify(command);
  assert.equal(Buffer.byteLength(body)>16384&&Buffer.byteLength(body)<=98304,true);
  const api=createProjectAdminApi(service);
  const send=(target:string,value:Record<string,unknown>,actor=principal)=>{
   const header=Buffer.from(JSON.stringify(proof(value))).toString('base64url');
   return api(new Request(target,{method:'POST',headers:{'content-type':'application/json','x-ac-operator-proof':header},body:JSON.stringify(value)}),actor);
  };
  const legacy=await send(legacyUrl,command);
  assert.equal(legacy.status,413);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_remote_source_materializations')).rows[0].n,0);
  const forged={...proof(command),signature:'0'.repeat(128)};
  const forgedHeader=Buffer.from(JSON.stringify(forged)).toString('base64url');
  const invalid=await api(new Request(remoteUrl,{method:'POST',headers:{'content-type':'application/json','x-ac-operator-proof':forgedHeader},body}),principal);
  assert.equal(invalid.status,403);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_project_repositories WHERE project_id=$1',[project])).rows[0].n,0);
  const applied=await send(remoteUrl,command);
  assert.equal(applied.status,200);
  const result=await applied.json() as {state:string;projectId:string;reviewStatus:string;commit:string;tree:string};
  assert.deepEqual({state:result.state,projectId:result.projectId,reviewStatus:result.reviewStatus,commit:result.commit,tree:result.tree},{state:'applied',projectId:project,reviewStatus:'not_reviewed',commit,tree});
  const row=(await db.pool.query('SELECT project_id,operation_id,commit_id,tree_id,bundle_sha256,principal_id FROM ac_remote_source_materializations')).rows[0];
  assert.deepEqual({project_id:row.project_id,operation_id:row.operation_id,commit_id:row.commit_id,tree_id:row.tree_id,bundle_sha256:row.bundle_sha256,principal_id:row.principal_id},{project_id:project,operation_id:operationId,commit_id:commit,tree_id:tree,bundle_sha256:sha,principal_id:principal});
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_project_repository_identity WHERE project_id=$1',[project])).rows[0].n,1);
  assert.deepEqual(await readFile(join(rootPath,'remote-sources',project,'fixture.bin')),bundle.length?await readFile(join(source,'fixture.bin')):Buffer.alloc(0));
  const after=await service.view(principal);
  assert.deepEqual(after.remoteSourceCandidates,[]);
  assert.equal(after.remoteSources[0]?.reviewStatus,'not_reviewed');
  const replay=await send(remoteUrl,{...command,deliveryAttemptId:randomUUID()});
  assert.equal(replay.status,200);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_remote_source_materializations')).rows[0].n,1);
 }finally{await db.close();await isolated.close();await rm(rootPath,{recursive:true,force:true});await rm(work,{recursive:true,force:true});await rm(tmpfs,{recursive:true,force:true});}
});
