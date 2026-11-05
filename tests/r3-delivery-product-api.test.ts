import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ProjectAdmin} from '../src/project-admin.ts';
import {createProjectAdminApi} from '../src/project-admin-api.ts';
import {createProjectGateway} from '../src/projects-api.ts';
import {Refusal} from '../src/contracts.ts';
import {remoteImplementationWritePaths} from '../src/remote-write-paths.ts';
import {configuredRemoteDevelopment} from '../src/remote-development-config.ts';
import {remoteDevelopmentLab} from './fixtures/r3-delivery-lab.ts';

test('R3 configured signed product API prepares, launches and registers exact remote output under live manager authority', {timeout:120000},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const lab=await remoteDevelopmentLab(base);
 try{
  const privateDirectory=join(lab.root,'private');await mkdir(privateDirectory,{mode:0o700});const verifierKeyFile=join(privateDirectory,'verifier.key');await writeFile(verifierKeyFile,lab.verifierKey,{mode:0o600});
  const host=(await lab.db.pool.query('SELECT * FROM ac_remote_hosts WHERE id=$1',[lab.hostId])).rows[0];
  let authority:typeof lab.authority|undefined=lab.authority;
  const provider=configuredRemoteDevelopment(lab.db,{mode:'synthetic-fixed-task-v1',transport:{allowedHosts:['127.0.0.1'],credentials:[{id:host.credential_ref,path:join(lab.root,'controller')}]},
   projects:[{projectId:lab.projectId,verifierKeyFile,tmpfsRoot:lab.scratch,profiles:[{profileId:lab.profiles.programmer,hostId:lab.hostId,taskId:'implement',writePaths:['src/example.ts']}]}]},async(projectId,contextId)=>{assert.equal(projectId,lab.projectId);assert.equal(contextId,lab.contextId);return authority;});
  assert.equal(configuredRemoteDevelopment(lab.db,undefined,()=>undefined),undefined);
  const admin=new ProjectAdmin(lab.db,[{id:'fixture',label:'Fixture',path:lab.root}],privateDirectory,{remoteDevelopment:provider,remoteReturnTransport:lab.ssh,remoteSourceTmpfs:lab.scratch});
  const gateway=createProjectGateway({projects:{} as never,runtimes:{} as never,defaultProjectId:lab.projectId,appFor:()=>{throw Error('unexpected native runtime');},publicFetch:async()=>new Response('public'),authenticate:async request=>request.headers.get('x-test-principal'),projectAdmin:createProjectAdminApi(admin)});
  const endpoint='http://localhost/api/v1/ac/project-admin/remote-development';
  const post=(value:Record<string,unknown>,valid=true)=>new Request(endpoint,{method:'POST',headers:{'content-type':'application/json','x-test-principal':lab.principal,
   'x-ac-operator-proof':Buffer.from(JSON.stringify(valid?lab.proof(value):{...lab.proof(value),signature:'0'.repeat(128)})).toString('base64url')},body:JSON.stringify(value)});
  const workspaceId=randomUUID(),scope={projectId:lab.projectId,contextId:lab.contextId,workspaceId};
  const prepare={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.prepareRemoteDevelopment',payload:{...scope,hostId:lab.hostId,sourceOperationId:lab.sourceOperationId}};
  const initial=await admin.view(lab.principal);assert.equal(initial.remoteDevelopment.configured,true);assert.equal(initial.remoteDevelopment.candidates[0]?.sourceOperationId,lab.sourceOperationId);
  assert.equal(JSON.stringify(initial.remoteDevelopment).includes(join(lab.root,'controller')),false);assert.equal(JSON.stringify(initial.remoteDevelopment).includes('127.0.0.1'),false);
  assert.equal((await gateway(new Request(endpoint,{method:'POST'}))).status,401);
  assert.equal((await gateway(post(prepare,false))).status,403);
  assert.equal((await gateway(post({...prepare,intentId:randomUUID(),payload:{...prepare.payload,taskId:'arbitrary-command'}}))).status,400);
  // Eight human authority transactions reach a barrier before each requests a
  // shared adapter connection. The former outer Ledger.tx consumes all slots.
  const resolve=provider!.resolve;let entrants=0,unblock!:()=>void;
  const barrier=new Promise<void>(resolve=>{unblock=resolve;});
  provider!.resolve=async()=>{
   if(++entrants===8)unblock();
   await barrier;
   await lab.db.pool.query({text:'SELECT 1',query_timeout:2000});
   throw new Refusal('CONCURRENT_ADAPTER_CONNECTION_AVAILABLE');
  };
  const concurrent=await Promise.all(Array.from({length:8},()=>gateway(post({...prepare,intentId:randomUUID(),deliveryAttemptId:randomUUID(),payload:{...prepare.payload,workspaceId:randomUUID()}}))));
  assert.equal(entrants,8);
  for(const response of concurrent){assert.equal(response.status,409);assert.equal((await response.json()).error,'CONCURRENT_ADAPTER_CONNECTION_AVAILABLE');}
  assert.equal(lab.db.pool.waitingCount,0);
  console.log(JSON.stringify({proof:'r4-api-pool-counterproof',simultaneousAuthorityTransactions:entrants,sharedPoolMax:8,barrierReleased:true,httpStatuses:concurrent.map(response=>response.status),sharedPoolWaiters:lab.db.pool.waitingCount}));
  provider!.resolve=resolve;
  const preparedReplies=await Promise.all([gateway(post(prepare)),gateway(post({...prepare,deliveryAttemptId:randomUUID()}))]);
  const preparedResults=await Promise.all(preparedReplies.map(async reply=>{assert.equal(reply.status,200);return reply.json();}));
  assert.equal(preparedResults[0].state,'prepared');assert.deepEqual(preparedResults[0],preparedResults[1]);
  const conflict=await gateway(post({...prepare,payload:{...prepare.payload,workspaceId:randomUUID()}}));assert.equal(conflict.status,409);assert.equal((await conflict.json()).error,'PROJECT_ADMIN_INTENT_CONFLICT');
  const noManager={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.launchRemoteDevelopment',payload:scope};
  authority=undefined;const denied=await gateway(post(noManager));assert.equal(denied.status,409);assert.equal((await denied.json()).error,'REMOTE_DEVELOPMENT_MANAGER_NOT_ACTIVE');
  assert.equal((await lab.db.pool.query('SELECT count(*)::int n FROM ac_remote_development_implementations')).rows[0].n,0);
  authority=lab.authority;
  const launched=await gateway(post(noManager));assert.equal(launched.status,200);assert.equal((await launched.json()).state,'launched');
  const replay=await gateway(post({...noManager,deliveryAttemptId:randomUUID()}));assert.equal(replay.status,200);
  let completed=false;
  for(let i=0;i<150;i++){
   const state=await lab.remote.reconcile(lab.principal,lab.intent.operation_id,lab.authority);if(state.state==='completed'){completed=true;break;}
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert(completed);
  const register={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.registerRemoteArtifact',payload:scope};
  assert.equal((await gateway(post({...register,intentId:randomUUID(),payload:{...scope,artifactId:randomUUID()}}))).status,400);
  const registered=await gateway(post(register));assert.equal(registered.status,200);const result=await registered.json();assert.equal(result.state,'registered');assert.equal(result.workspaceId,workspaceId);assert.equal(result.reviewStatus,'not_reviewed');assert(result.artifactId);
  const final=await admin.view(lab.principal);assert.equal(final.remoteDevelopment.candidates.length,0);assert.equal(final.remoteDevelopment.workspaces[0]?.artifactId,result.artifactId);assert.equal(final.remoteDevelopment.workspaces[0]?.emissionPhase,'emitting');
  assert.equal((await lab.db.pool.query('SELECT count(*)::int n FROM ac_project_admin_intents WHERE action LIKE $1',["project.%Remote%"])).rows[0].n,4); // source materialization + three explicit actions
  assert.equal((await lab.db.pool.query('SELECT count(*)::int n FROM ac_verification_evidence')).rows[0].n,0);
  console.log(JSON.stringify({proof:'r3-remote-development-product-api',entry:'signed authenticated gateway',mode:'synthetic-fixed-task-v1',liveManagerRequired:true,sourcePreparation:true,physicalLaunch:true,qualityRegistration:true,arbitraryTaskAccepted:false,approval:'not_reviewed'}));
 }finally{await lab.close();}
});


test('configured remote write paths constrain canonical native intent paths before emission',()=>{
 assert.deepEqual(remoteImplementationWritePaths(['src/example.ts'],['src/']),['src/example.ts']);
 assert.deepEqual(remoteImplementationWritePaths(['src/'],['src/']),['src/']);
 for(const path of ['outside.ts','src-other/example.ts','src/../outside','src/./example.ts','src//example.ts','/src/example.ts','src/.git/config','src\\example.ts','src/\x00evil']){
  assert.throws(()=>remoteImplementationWritePaths([path],['src/']),/REMOTE_IMPLEMENTATION_WRITE_PATH_FORBIDDEN/);
 }
 assert.throws(()=>remoteImplementationWritePaths(['src/'],['src/example.ts']),/REMOTE_IMPLEMENTATION_WRITE_PATH_FORBIDDEN/);
 for(const policy of ['src/../','src//','/src/','src/.git/'])assert.throws(()=>remoteImplementationWritePaths(['src/example.ts'],[policy]),/REMOTE_IMPLEMENTATION_WRITE_PATH_FORBIDDEN/);
});
