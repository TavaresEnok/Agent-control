import {mock,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createPublicKey,generateKeyPairSync,randomUUID,verify} from 'node:crypto';
import {execFile,spawnSync} from 'node:child_process';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {promisify} from 'node:util';
import {chmod,lstat,mkdir,mkdtemp,readFile,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {Capacity} from '../src/capacity.ts';
import {NativeExecutionSupervisor,NativeExecutionRequest,UnstartedExamRetirementPending} from '../src/native-execution-supervisor.ts';
import {createDesignNativeWorker} from '../src/design-native-launch.ts';
import {designCliFailureText} from '../src/personal-design-cli.ts';
import {releaseDesignGrant} from '../src/design-command.ts';
import {isProviderLimit} from '../src/quota-exhaustion.ts';
import {authorizeNativeSyntheticFixture} from '../src/native-synthetic-fixture.ts';
import {reconcileNativeResourceAdmissions,NativeResourceDockerDaemon} from '../src/native-resource-envelope.ts';
import {OPEN_EXECUTION_JOBS_SQL,runPersonalMaintenance} from '../src/personal-maintenance.ts';
import {maintenanceCliFailureText} from '../src/personal-maintenance-cli.ts';
import {nativePlanningExecutorDigest} from '../src/native-planning-contract.ts';
import {nativeExecutionExecutorDigest} from '../src/native-execution-contract.ts';
import {NativeQaContract,nativeQaContractDigest} from '../src/native-qa-contract.ts';
import {nativeReviewVerifierDigest} from '../src/native-review-contract.ts';
import {Authority,Refusal,canonical,digest} from '../src/contracts.ts';
import {AccountHomes} from '../src/account-homes.ts';
import {GitArtifacts} from '../src/git.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const exec=promisify(execFile);

async function insertDesignExamIntent(db:Ledger,principal:string,contextId:string,epoch:number,projectId:string,commit:string,marked=false,workflow='design-readonly-v1'){
 const intentId=randomUUID();
 const command={
  schemaVersion:1 as const,
  intentId,
  deliveryAttemptId:randomUUID(),
  contextId,
  policyRevision:0,
  action:'plan.start' as const,
  payload:{workflow,messageRef:`${marked?'design-exam':'design'}:${projectId}:${commit}`,projectId,commit},
 };
 await db.pool.query(
  `INSERT INTO ac_intents (id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision)
   VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,0)`,
  [intentId,contextId,principal,digest(command),JSON.stringify(command),randomUUID(),randomUUID(),epoch],
 );
 return {id:intentId,command};
}

async function startFakeDockerSocket(socketPath:string,state:{
 containers:Map<string,Record<string,unknown>>;
 networks:Map<string,Record<string,unknown>>;
 images?:Set<string>;
 malformedNetwork?:boolean;
 onMutate?:(method:string,url:string)=>void;
}){
 const server=createServer((req:IncomingMessage,res:ServerResponse)=>{
  const url=req.url??'';
  const method=req.method??'GET';
  res.setHeader('content-type','application/json');
  if(method==='GET'&&url.startsWith('/v1.44/containers/')&&url.endsWith('/json')){
   const name=decodeURIComponent(url.slice('/v1.44/containers/'.length,-'/json'.length));
   const found=state.containers.get(name);
   if(!found){res.statusCode=404;res.end(JSON.stringify({message:'no such container'}));return;}
   res.statusCode=200;res.end(JSON.stringify(found));return;
  }
  if(method==='GET'&&url.startsWith('/v1.44/networks/')){
   if(state.malformedNetwork){res.statusCode=200;res.end('{');return;}
   const name=decodeURIComponent(url.slice('/v1.44/networks/'.length));
   const found=state.networks.get(name);
   if(!found){res.statusCode=404;res.end(JSON.stringify({message:'network not found'}));return;}
   res.statusCode=200;res.end(JSON.stringify(found));return;
  }
  if(method==='GET'&&url.startsWith('/v1.44/images/')&&url.endsWith('/json')){
   const image=decodeURIComponent(url.slice('/v1.44/images/'.length,-'/json'.length));
   if(state.images&&!state.images.has(image)){res.statusCode=404;res.end(JSON.stringify({message:'no such image'}));return;}
   res.statusCode=200;res.end(JSON.stringify({Id:image}));return;
  }
  state.onMutate?.(method,url);
  res.statusCode=500;res.end(JSON.stringify({message:'unexpected mutation '+method+' '+url}));
 });
 await new Promise<void>(resolve=>server.listen(socketPath,resolve));
 return ()=>new Promise<void>(resolve=>server.close(()=>resolve()));
}

test('historical interrupted exam in main context is recovered explicitly via personal:maintenance without co-owner bypass or re-execution',{skip:!process.env.AC_TEST_DATABASE_URL},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'hist_exam_cli');
 const db=new Ledger(fixture.url);
 const area=await mkdtemp(join(tmpdir(),'ac-hist-exam-'));
 let runtime:CezarRuntime|undefined;
 let closeSocket:(()=>Promise<void>)|undefined;
 let homesMock:ReturnType<typeof mock.method>|undefined;
 let snapshotMock:ReturnType<typeof mock.method>|undefined;
 try{
  await db.migrate();
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  const capacity=new Capacity(db);
  const project=randomUUID(),otherProject=randomUUID();
  const appPrincipal='app',gatewayPrincipal='happier:owner-'+randomUUID(),thirdCoOwner='coowner-'+randomUUID(),operatorPrincipal='operator-'+randomUUID();
  const account=randomUUID(),profile=randomUUID(),foreignAccount=randomUUID();
  const repo=join(area,'repo'),otherRepo=join(area,'other-repo'),dataDir=join(area,'data');
  const spool=join(dataDir,'exec-host'),accounts=join(dataDir,'accounts'),planHost=join(dataDir,'plan-host'),planAccounts=join(dataDir,'plan-accounts');
  const keysDir=join(dataDir,'keys'),vaultDir=join(dataDir,'vault'),vaultMaster=join(dataDir,'vault-master'),tokenFile=join(dataDir,'happier-token');
  for(const dir of [repo,otherRepo,dataDir,spool,accounts,planHost,planAccounts,keysDir,vaultDir]){
   await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700);
  }
  await writeFile(vaultMaster,'master-fixture',{mode:0o600});
  await writeFile(tokenFile,'token-fixture',{mode:0o600});
  await exec('git',['init',repo]);await exec('git',['-C',repo,'config','user.name','Synthetic Fixture']);await exec('git',['-C',repo,'config','user.email','fixture@example.invalid']);
  await writeFile(join(repo,'README.md'),'fixture\n');await exec('git',['-C',repo,'add','.']);await exec('git',['-C',repo,'commit','-m','base']);
  const headCommit=(await exec('git',['-C',repo,'rev-parse','HEAD'])).stdout.trim();

  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Historical Exam Fixture']);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[otherProject,'Foreign Project']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner'),($1,$3,'owner'),($1,$4,'owner'),($1,$5,'operator'),($6,$7,'owner')",
   [project,appPrincipal,gatewayPrincipal,thirdCoOwner,operatorPrincipal,otherProject,'foreign-owner']);
  await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2),($3,$4)',[project,repo,otherProject,otherRepo]);

  const subject=digest({provider:'claude',subject:'fixture-claude-sub'});
  await capacity.addAccount(appPrincipal,project,{id:account,provider:'claude',label:'personal claude fixture',resourceIdentity:'claude:'+subject,mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/fixture',maxConcurrent:2});
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'claude-sonnet-5-5','medium','specialist',true)",[profile,account]);
  await capacity.addAccount('foreign-owner',otherProject,{id:foreignAccount,provider:'claude',label:'foreign fixture',resourceIdentity:'claude:'+'f'.repeat(64),mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/foreign',maxConcurrent:1});

  // Historical main context (not in ac_exam_contexts); gateway holds lease under gatewayPrincipal.
  const mainContext=await db.createContext(gatewayPrincipal,project,randomUUID());
  const gatewayAuthority=await db.acquire(gatewayPrincipal,mainContext,randomUUID(),'gateway-manager',60);
  await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),appPrincipal]);
  const examIntent=await insertDesignExamIntent(db,appPrincipal,mainContext,gatewayAuthority.epoch,project,headCommit);
  const coOwnerIntent=await insertDesignExamIntent(db,thirdCoOwner,mainContext,gatewayAuthority.epoch,project,headCommit);

  const execKeys=generateKeyPairSync('ed25519'),planKeys=generateKeyPairSync('ed25519'),reviewKeys=generateKeyPairSync('ed25519');
  const execPem=execKeys.privateKey.export({format:'pem',type:'pkcs8'}).toString();
  const planKeyFile=join(keysDir,'plan.pem'),execKeyFile=join(keysDir,'exec.pem'),reviewKeyFile=join(keysDir,'review.pem');
  await writeFile(planKeyFile,planKeys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),{mode:0o600});
  await writeFile(execKeyFile,execPem,{mode:0o600});
  await writeFile(reviewKeyFile,reviewKeys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),{mode:0o600});
  const fingerprintOf=(key:import('node:crypto').KeyObject)=>createHash('sha256').update(key.export({format:'der',type:'spki'})).digest('hex');
  const execFingerprint=fingerprintOf(execKeys.publicKey);
  const retiredImage='sha256:'+'c'.repeat(64),currentImage='sha256:'+'0'.repeat(64);
  const sockPath=join(area,'docker.sock');
  const dockerMutations:string[]=[];
  const dockerState={containers:new Map<string,Record<string,unknown>>(),networks:new Map<string,Record<string,unknown>>(),images:new Set([retiredImage,currentImage]),malformedNetwork:false,onMutate:(m:string,u:string)=>dockerMutations.push(`${m} ${u}`)};
  closeSocket=await startFakeDockerSocket(sockPath,dockerState);

  const supervisorConfig={id:'codex-native-execution',provider:'claude' as const,workerImage:retiredImage,toolsImage:retiredImage,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem:execPem,providerNetworkId:'d'.repeat(64),socketPath:sockPath,accountSubjects:[{accountId:account,subjectDigest:subject}],workerEnv:[],toolsEnv:[]};
  const supervisor=new NativeExecutionSupervisor(db,supervisorConfig,{assertAdmission:async()=>{}});

  // Reproduce exact historical job: state=uncertain, role=specialist, no worker/tools/network/launch, grant=released, physical_receipt from exam_login_stale, no spool dir.
  const histJobId=randomUUID(),histGrantId=randomUUID(),histSessionId=randomUUID();
  const histInput=NativeExecutionRequest.parse({jobId:histJobId,intentId:examIntent.id,grantId:histGrantId,sessionId:histSessionId,base:headCommit,role:'specialist',task:'historical design exam',artifactId:randomUUID(),outputSchema:{type:'object'},writePaths:[]});
  const histInputDigest=digest(histInput);
  const histPhysical={executionStarted:false,jobId:histJobId,containerId:null,networkId:null,synthetic:false,modelInference:false,reason:'exam_login_stale'};
  const profileDigest=digest({accountId:account,profileId:profile,model:'claude-sonnet-5-5',effort:'medium',role:'specialist'});
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state,physical_receipt)
   VALUES($1,$2,$3,$4,$5,$6,$7,'specialist',$8,1,1,$9,false,'released',$10)`,[histGrantId,randomUUID(),examIntent.id,mainContext,gatewayAuthority.epoch,account,profile,project,histInputDigest,histPhysical]);
  await db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,'specialist','uncertain')`,[histJobId,histGrantId,examIntent.id,mainContext,gatewayAuthority.epoch,histSessionId,account,profile,profileDigest,supervisor.executorDigest,execFingerprint,histInputDigest,headCommit]);

  // Also insert a co-owner-owned job in the same context to verify installation rejects recovering another co-owner's job.
  const coJobId=randomUUID(),coGrantId=randomUUID(),coSessionId=randomUUID();
  const coInput=NativeExecutionRequest.parse({jobId:coJobId,intentId:coOwnerIntent.id,grantId:coGrantId,sessionId:coSessionId,base:headCommit,role:'specialist',task:'co-owner exam',artifactId:randomUUID(),outputSchema:{type:'object'},writePaths:[]});
  const coPhysical={executionStarted:false,jobId:coJobId,containerId:null,networkId:null,synthetic:false,modelInference:false,reason:'exam_login_stale'};
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state,physical_receipt)
   VALUES($1,$2,$3,$4,$5,$6,$7,'specialist',$8,1,1,$9,false,'released',$10)`,[coGrantId,randomUUID(),coOwnerIntent.id,mainContext,gatewayAuthority.epoch,account,profile,project,digest(coInput),coPhysical]);
  await db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,'specialist','uncertain')`,[coJobId,coGrantId,coOwnerIntent.id,mainContext,gatewayAuthority.epoch,coSessionId,account,profile,profileDigest,supervisor.executorDigest,execFingerprint,digest(coInput),headCommit]);

  const qaContract=NativeQaContract.parse({schemaVersion:1,id:'qa-synthetic',image:currentImage,argv:['/bin/true'],environment:[],timeoutMs:15000,memoryBytes:268435456,pids:64,nanoCpus:1000000000});
  const installationFile=join(area,'installation.json');
  await writeFile(installationFile,JSON.stringify({
   schemaVersion:1,mode:'administration-only',activation:'personal',databaseUrl:fixture.url,dataDirectory:dataDir,
   contextVault:{directory:vaultDir,masterFile:vaultMaster},
   project:{id:project,label:'Historical Exam Project',repo,owner:appPrincipal},
   managerTransport:{principal:gatewayPrincipal,tokenFile,machineId:'machine-fixture',transport:'local',contexts:[{projectId:project,contextId:mainContext,sessionId:'sess-1',profileId:profile,keyVersion:1,encryptionVariant:'dataKey'}]},
   nativeBootstrap:{
    state:'active',contract:'native-bootstrap-configured-v1',projectId:project,contextId:mainContext,epoch:gatewayAuthority.epoch,instanceId:gatewayAuthority.instanceId,source:'authorized-endpoint',
    accounts:[{accountId:account,subjectDigest:subject}],
    planning:{id:'codex-native-planning',imageId:currentImage,executorDigest:nativePlanningExecutorDigest(currentImage),signingKeyFile:planKeyFile,keyFingerprint:fingerprintOf(planKeys.publicKey),hostRoot:planHost,accountRoot:planAccounts},
    execution:{id:'codex-native-execution',workerImage:currentImage,toolsImage:currentImage,retiredImages:[{workerImage:retiredImage,toolsImage:retiredImage}],executorDigest:nativeExecutionExecutorDigest(currentImage,currentImage),signingKeyFile:execKeyFile,keyFingerprint:fingerprintOf(execKeys.publicKey),hostRoot:spool,accountRoot:accounts,providerNetworkId:'d'.repeat(64),workerEnv:[],toolsEnv:[]},
    qa:qaContract,qaDigest:nativeQaContractDigest(qaContract),
    review:{signingKeyFile:reviewKeyFile,keyFingerprint:fingerprintOf(reviewKeys.publicKey),verifierDigest:nativeReviewVerifierDigest},
   },
   http:{listen:'127.0.0.1',port:43111,publicOrigin:'http://127.0.0.1:43111'},
   happier:{upstreamOrigin:'http://127.0.0.1:43112',webOrigin:'http://127.0.0.1:43113',publicServerOrigin:'http://127.0.0.1:43114'},
  }),{mode:0o600});

  // 1) Automatic gateway reconciliation must match selection and execution scope: never throw SCOPE_MISMATCH and never retain app-owned job.
  runtime=new CezarRuntime(db,repo,project,undefined,undefined,undefined,{nativeExecutions:[supervisor]});
  await runtime.start('administration-only');
  await runtime.reconcileCancellations(gatewayAuthority,gatewayPrincipal);
  const retained=(await db.pool.query(`SELECT v.active FROM ac_reconciliation_visits v JOIN ac_reconciliation_entries e ON e.seq=v.seq WHERE e.row_id=$1`,[histJobId])).rows;
  assert.equal(retained.some(r=>r.active),false);
  assert.equal((await db.pool.query('SELECT state FROM ac_native_execution_jobs WHERE id=$1',[histJobId])).rows[0].state,'uncertain');

  // 2) A normal pre-journal admission remains visible for another authorized principal.
  const admJobId=randomUUID(),admGrantId=randomUUID(),admSessionId=randomUUID();
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,'specialist',$8,1,1,$9,false,'reserved')`,[admGrantId,randomUUID(),examIntent.id,mainContext,gatewayAuthority.epoch,account,profile,project,digest({adm:1})]);
  const resourceDocker=new NativeResourceDockerDaemon({stateRoot:spool,installationId:'exam-fixture',authorityEpoch:gatewayAuthority.epoch,resourceAuthority:{authorityId:'ac-r3-resources-exam',anchorId:'a'.repeat(64),cpuQuotaMicros:50000,cpuPeriodMicros:100000,memoryBytes:16777216,pidsLimit:16,maxJobs:4}});
  resourceDocker.callResource=async()=>{throw Error('FOREIGN_ADMISSION_MUST_NOT_CANCEL');};
  await db.pool.query(`INSERT INTO ac_native_resource_admissions(job_id,grant_id,context_id,manager_epoch,authority_id,names,admission_id,state_root,state,reason)
   VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'waiting','physical_capacity')`,[admJobId,admGrantId,mainContext,gatewayAuthority.epoch,resourceDocker.authorityId,JSON.stringify(['ac-native-tools-'+admJobId,'ac-native-worker-'+admJobId]),randomUUID(),resourceDocker.stateRoot]);
  for(const recoverSource of ['ac_native_execution_jobs','ac_native_planning_jobs','ac_native_qa_jobs'] as const){
   await reconcileNativeResourceAdmissions({docker:resourceDocker,ledger:db,principal:gatewayPrincipal,authority:gatewayAuthority,recoverSource,recoverJob:async()=>{throw Error('FOREIGN_JOB_MUST_NOT_RECOVER');}});
  }
  assert.equal(Number((await db.pool.query(`SELECT count(*) n FROM ac_reconciliation_visits v JOIN ac_reconciliation_entries e ON e.seq=v.seq WHERE e.row_id=$1 AND v.active`,[admJobId])).rows[0].n),3);
  assert.equal((await db.pool.query('SELECT state FROM ac_native_resource_admissions WHERE job_id=$1',[admJobId])).rows[0].state,'waiting');
  await db.pool.query('DELETE FROM ac_native_resource_admissions WHERE job_id=$1',[admJobId]);
  await db.pool.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1",[admGrantId,{state:'not_started',executionStarted:false}]);

  // Existing planning and QA journals for another authorized principal still
  // reach their own recovery callbacks, not just the pre-journal branch.
  for(const source of ['ac_native_planning_jobs','ac_native_qa_jobs'] as const){
   const otherIntent=await insertDesignExamIntent(db,appPrincipal,mainContext,gatewayAuthority.epoch,project,headCommit,false,'baseline-synthetic-v1');
   await db.pool.query("UPDATE ac_intents SET state='failed' WHERE id=$1",[otherIntent.id]);
   const job=randomUUID(),grant=randomUUID(),session=randomUUID(),attempt=randomUUID();
   await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
    VALUES($1,$2,$3,$4,$5,$6,$7,'specialist',$8,1,1,$9,false,'uncertain')`,[grant,attempt,otherIntent.id,mainContext,gatewayAuthority.epoch,account,profile,project,digest({source})]);
   if(source==='ac_native_planning_jobs'){
    await db.pool.query(`INSERT INTO ac_semantic_planning_calls(id,context_id,intent_id,principal_id,input_digest,executor_id,executor_digest,expected_revision,attempt_id,session_id,state)
     VALUES($1,$2,$3,$4,$5,'fixture',$5,0,$6,$7,'uncertain')`,[job,mainContext,otherIntent.id,appPrincipal,'a'.repeat(64),randomUUID(),session]);
    await db.pool.query(`INSERT INTO ac_native_planning_jobs(id,grant_id,context_id,input_digest,launch_digest,container_name,state) VALUES($1,$2,$3,$4,$4,$5,'uncertain')`,[job,grant,mainContext,'a'.repeat(64),'fixture-'+job]);
   }else{
    const artifact=randomUUID();
    await db.pool.query("INSERT INTO ac_quality_policies(project_id,revision,snapshot,digest) VALUES($1,1,'{}',$2) ON CONFLICT DO NOTHING",[project,'a'.repeat(64)]);
    await db.pool.query(`INSERT INTO ac_artifacts(id,context_id,intent_id,implementation_grant_id,implementation_session_id,project_id,policy_revision,commit_id,tree_id,base_id,identity_digest,risk)
     VALUES($1,$2,$3,$4,$5,$6,1,$7,$7,$7,$8,'low')`,[artifact,mainContext,otherIntent.id,grant,randomUUID(),project,headCommit,'a'.repeat(64)]);
    await db.pool.query(`INSERT INTO ac_stage_operations(id,intent_id,node_id,session_id,attempt_id,grant_id,manager_epoch,state) VALUES($1,$2,'qa',$3,$4,$5,$6,'uncertain')`,[job,otherIntent.id,session,randomUUID(),grant,gatewayAuthority.epoch]);
    await db.pool.query(`INSERT INTO ac_native_qa_jobs(id,context_id,intent_id,artifact_id,grant_id,session_id,manager_epoch,request_digest,contract_digest,state,deadline_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,'uncertain',clock_timestamp())`,[job,mainContext,otherIntent.id,artifact,grant,session,gatewayAuthority.epoch,'a'.repeat(64)]);
   }
   await db.pool.query(`INSERT INTO ac_native_resource_admissions(job_id,grant_id,context_id,manager_epoch,authority_id,names,admission_id,state_root,state,reason)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'waiting','physical_capacity')`,[job,grant,mainContext,gatewayAuthority.epoch,resourceDocker.authorityId,JSON.stringify(['fixture-'+job]),randomUUID(),resourceDocker.stateRoot]);
   const recovered:string[]=[];
   await reconcileNativeResourceAdmissions({docker:resourceDocker,ledger:db,principal:gatewayPrincipal,authority:gatewayAuthority,recoverSource:source,recoverJob:async id=>{recovered.push(id);}});
   assert.deepEqual(recovered,[job]);
  }

  // 3) Third co-owner and gateway co-owner are refused on all supervisor methods for app's job.
  for(const nonOwner of [gatewayPrincipal,thirdCoOwner,operatorPrincipal]){
   await assert.rejects(supervisor.recoverUnstartedExam(nonOwner,gatewayAuthority,histJobId),/NATIVE_EXECUTION_SCOPE_MISMATCH/);
   await assert.rejects(supervisor.recover(nonOwner,gatewayAuthority,histJobId),/NATIVE_EXECUTION_SCOPE_MISMATCH/);
   await assert.rejects(supervisor.reconcile(nonOwner,gatewayAuthority,histInput),/NATIVE_EXECUTION_SCOPE_MISMATCH/);
   await assert.rejects(supervisor.reconcileCancellation(nonOwner,gatewayAuthority,histJobId),/NATIVE_EXECUTION_SCOPE_MISMATCH/);
   await assert.rejects(supervisor.retireTerminal(nonOwner,gatewayAuthority,histJobId),/NATIVE_EXECUTION_SCOPE_MISMATCH/);
  }

  // Redirect only the Docker HTTP transport in the CLI subprocess. The
  // entry point, argument parsing, installation, lease and supervisor are real.
  const dockerPreload=join(area,'fake-docker.cjs');
  await writeFile(dockerPreload,`
   const http = require('node:http');
   const request = http.request;
   http.request = (options, ...args) => request(
    options.socketPath === '/var/run/docker.sock' ? {...options, socketPath: ${JSON.stringify(sockPath)}} : options,
    ...args
   );
   require('node:module').syncBuiltinESMExports();
  `);
  const cli=(...args:string[])=>exec(process.execPath,['scripts/personal-maintenance.mjs',installationFile,...args],{
   env:{...process.env,NODE_OPTIONS:'--require='+dockerPreload},
  });

  // 4) While gateway holds the lease, explicit CLI / maintenance recovery refuses clearly as busy without changing state.
  await assert.rejects(
   runPersonalMaintenance([installationFile,'--abandonar-design',histJobId]),
   (err:unknown)=>err instanceof Refusal&&err.code==='MAINTENANCE_CONTEXT_BUSY',
  );
  const busyCli=spawnSync(process.execPath,['scripts/personal-maintenance.mjs',installationFile,'--abandonar-design',histJobId],{encoding:'utf8'});
  assert.equal(busyCli.status,1);
  assert.match(busyCli.stderr,/systemctl --user stop/);
  assert.match(busyCli.stderr,/systemctl --user start/);

  // Invalid CLI flags / inferred principal / co-owner job are refused via CLI.
  const badArgCli=spawnSync(process.execPath,['scripts/personal-maintenance.mjs',installationFile,'--abandonar-design','not-a-uuid'],{encoding:'utf8'});
  assert.equal(badArgCli.status,1);
  assert.match(badArgCli.stderr,/Uso:/);
  const coOwnerCli=spawnSync(process.execPath,['scripts/personal-maintenance.mjs',installationFile,'--abandonar-design',coJobId],{encoding:'utf8'});
  assert.equal(coOwnerCli.status,1);
  assert.match(coOwnerCli.stderr,/outro principal/);

  // 5) Gateway releases lease -> explicit product command recovers historical job idempotently without re-execution.
  await db.releaseLease(gatewayAuthority);
  const examAuthority=await db.acquire(appPrincipal,mainContext,randomUUID(),'fixture',60);
  await assert.rejects(supervisor.recoverUnstartedExam(appPrincipal,examAuthority,histJobId),/NATIVE_EXECUTION_HISTORICAL_CONFIRMATION_REQUIRED/);
  await db.releaseLease(examAuthority);
  const {stdout}=await cli('--abandonar-design',histJobId);
  assert.ok(stdout.includes(histJobId)&&stdout.includes('failed')&&stdout.includes('removed'));
  assert.deepEqual(dockerMutations,[]);

  const jobRow=(await db.pool.query('SELECT state,receipt,worker_id,tools_id,network_id,launch_digest FROM ac_native_execution_jobs WHERE id=$1',[histJobId])).rows[0];
  assert.equal(jobRow.state,'failed');
  assert.equal(jobRow.worker_id,null);
  assert.equal(jobRow.tools_id,null);
  assert.equal(jobRow.network_id,null);
  assert.equal(jobRow.launch_digest,null);
  assert.equal(jobRow.receipt?.payload?.executionStarted,false);
  assert.equal(jobRow.receipt?.payload?.physicalDigest,digest(histPhysical));
  assert.equal(verify(null,Buffer.from('agent-control:native-execution-receipt:v1\n'+canonical(jobRow.receipt.payload)),createPublicKey(execPem),Buffer.from(jobRow.receipt.signature,'hex')),true);
  const grantRow=(await db.pool.query('SELECT state,physical_receipt FROM ac_capacity_grants WHERE id=$1',[histGrantId])).rows[0];
  assert.equal(grantRow.state,'released');
  assert.deepEqual(grantRow.physical_receipt,histPhysical);
  const retirement=(await db.pool.query('SELECT binding,state,proof FROM ac_native_terminal_retirements WHERE job_id=$1',[histJobId])).rows[0];
  assert.equal(retirement.state,'removed');
  assert.equal(retirement.binding.kind,'native-unstarted-retired');
  assert.equal(retirement.binding.executionStarted,false);
  assert.equal(verify(null,Buffer.from('agent-control:native-terminal-retirement:v1\n'+canonical(retirement.proof.payload)),createPublicKey(execPem),Buffer.from(retirement.proof.signature,'hex')),true);
  const intentRow=(await db.pool.query('SELECT state FROM ac_intents WHERE id=$1',[examIntent.id])).rows[0];
  assert.equal(intentRow.state,'failed');
  // Lease released after maintenance command.
  assert.equal((await db.pool.query('SELECT lease_until<=clock_timestamp() expired FROM ac_managers WHERE context_id=$1',[mainContext])).rows[0].expired,true);

  // Idempotent second invocation does not duplicate native.terminal_retired audit rows and keeps identical receipt/proof.
  const auditCountBefore=(await db.pool.query("SELECT count(*)::int n FROM ac_audit WHERE context_id=$1 AND kind='native.terminal_retired'",[mainContext])).rows[0].n;
  await cli('--abandonar-design',histJobId);
  const auditCountAfter=(await db.pool.query("SELECT count(*)::int n FROM ac_audit WHERE context_id=$1 AND kind='native.terminal_retired'",[mainContext])).rows[0].n;
  assert.equal(auditCountAfter,auditCountBefore);
  await mkdir(join(spool,histJobId),{mode:0o700});
  await writeFile(join(spool,histJobId,'request.json'),JSON.stringify({...histInput,task:'divergente'}),{mode:0o600});
  await assert.rejects(cli('--abandonar-design',histJobId));
  await rm(join(spool,histJobId),{recursive:true});

  // Clean up coJobId so OPEN_EXECUTION_JOBS_SQL reflects only retired status and retiredImages can be dropped cleanly.
  await db.pool.query("DELETE FROM ac_native_execution_jobs WHERE id=$1",[coJobId]);
  assert.equal((await db.pool.query(OPEN_EXECUTION_JOBS_SQL,[supervisor.executorDigest])).rows[0].n,0);
  const removedImages:string[]=[];
  const cleanMaint=await runPersonalMaintenance([installationFile],{docker:async args=>{if(args[0]==='image'&&args[1]==='rm')removedImages.push(args[2]!);return 0;},imageExists:async()=>true,refreshDatabases:async()=>{}});
  assert.ok(cleanMaint.some(line=>line.includes('1 par(es) de execução')));
  assert.deepEqual(removedImages,[retiredImage]);
  await cli('--abandonar-design',histJobId);
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_audit WHERE context_id=$1 AND kind='native.terminal_retired'",[mainContext])).rows[0].n,auditCountBefore);
  const histRoot=join(spool,histJobId),histRequest=join(histRoot,'request.json');
  await mkdir(histRoot,{mode:0o700});
  await writeFile(histRequest,JSON.stringify(histInput),{mode:0o600});
  await cli('--abandonar-design',histJobId);
  await writeFile(histRequest,JSON.stringify({...histInput,task:'divergente'}),{mode:0o600});
  await assert.rejects(cli('--abandonar-design',histJobId));
  await writeFile(histRequest,JSON.stringify({...histInput,sessionId:randomUUID()}),{mode:0o600});
  await assert.rejects(cli('--abandonar-design',histJobId));
  await writeFile(histRequest,'{invalid',{mode:0o600});
  await assert.rejects(cli('--abandonar-design',histJobId));
  await rm(histRequest);
  await symlink(join(area,'missing-target'),histRequest);
  await assert.rejects(cli('--abandonar-design',histJobId));
  await rm(histRequest);
  await cli('--abandonar-design',histJobId);
  await chmod(histRoot,0o755);
  await assert.rejects(cli('--abandonar-design',histJobId));
  await chmod(histRoot,0o700);
  await rm(histRoot,{recursive:true});
  await rename(spool,spool+'-unavailable');
  try{await assert.rejects(cli('--abandonar-design',histJobId));}
  finally{await rename(spool+'-unavailable',spool);}
  // Corrupting a durable proof after image rotation must not yield success.
  const storedProof=(await db.pool.query('SELECT proof FROM ac_native_terminal_retirements WHERE job_id=$1',[histJobId])).rows[0].proof;
  // Only this disposable synthetic database is modified to exercise verification.
  await db.pool.query('ALTER TABLE ac_native_terminal_retirements DISABLE TRIGGER ac_native_terminal_retirement_guard');
  await db.pool.query("UPDATE ac_native_terminal_retirements SET proof=$2 WHERE job_id=$1",[histJobId,{...storedProof,signature:'0'.repeat(128)}]);
  await assert.rejects(cli('--abandonar-design',histJobId));
  await db.pool.query("UPDATE ac_native_terminal_retirements SET proof=$2 WHERE job_id=$1",[histJobId,storedProof]);
  await db.pool.query('ALTER TABLE ac_native_terminal_retirements ENABLE TRIGGER ac_native_terminal_retirement_guard');
  assert.equal(maintenanceCliFailureText(new Refusal('MAINTENANCE_CONTEXT_BUSY')).includes('systemctl --user stop'),true);

  // 6) Forward prevention: failure at releaseBeforeLaunch settles future pre-launch exam jobs when bindings and proof suffice.
  await db.pool.query('UPDATE ac_accounts SET enabled=true WHERE id=$1',[account]);
  await capacity.observeQuota(appPrincipal,account,{status:'available',source:'https://example.invalid/fixture',ttlSeconds:3600});
  const appAuth=await db.acquire(appPrincipal,mainContext,randomUUID(),'personal-design',60);
  const futureIntent=await insertDesignExamIntent(db,appPrincipal,mainContext,appAuth.epoch,project,headCommit,true);
  const futureGrantId=randomUUID();
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,'specialist',$8,1,1,$9,false,'reserved')`,[futureGrantId,randomUUID(),futureIntent.id,mainContext,appAuth.epoch,account,profile,project,digest({fixture:true})]);
  const claudeAccountRoot=join(accounts,account);
  await mkdir(claudeAccountRoot,{recursive:true,mode:0o700});await chmod(claudeAccountRoot,0o700);
  await writeFile(join(claudeAccountRoot,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'old-tok-secret-123',refreshToken:'ref-tok-secret-123',expiresAt:Date.now()-10_000}}),{mode:0o600});
  homesMock=mock.method(AccountHomes.prototype,'inspectGranted',async()=>({accountId:account,projectId:project,ownerId:appPrincipal,uid:'1',device:'1',inode:'1'}));
  snapshotMock=mock.method(GitArtifacts.prototype,'snapshot',async()=>{throw new Error('UNEXPECTED_SNAPSHOT');});
  const futureSupervisor=new NativeExecutionSupervisor(db,{...supervisorConfig,workerImage:currentImage,toolsImage:currentImage,examLoginRenew:async()=>{throw new Error('EXAM_LOGIN_RENEW_FAILED');}},{assertAdmission:async()=>{}});
  dockerState.malformedNetwork=true;
  let futureJobId='';
  const worker=createDesignNativeWorker({supervisors:[{active:true,supportsAccount:id=>id===account,
   start:async(principal,authority,request)=>{futureJobId=request.jobId;return futureSupervisor.start(principal,authority,request);},
   reconcile:(principal,authority,request)=>futureSupervisor.reconcile(principal,authority,request),
   retireTerminal:(principal,authority,id)=>futureSupervisor.retireTerminal(principal,authority,id)}],principal:appPrincipal,authority:appAuth,ledger:db,base:headCommit,
   releaseGrant:(grantId,how)=>releaseDesignGrant(db,appPrincipal,appAuth,grantId,how)});
  await assert.rejects(worker.run({role:'specialist',provider:'claude',accountId:account,profileId:profile,model:'claude-sonnet-5-5',grantId:futureGrantId,intentId:futureIntent.id,task:'future prelaunch exam failure',repo,writePaths:[]}),(err:unknown)=>{
   assert.ok(err instanceof UnstartedExamRetirementPending);
   assert.equal(err.jobId,futureJobId);
   assert.equal(isProviderLimit(err.code),false);
   assert.match(designCliFailureText(err),new RegExp(`--abandonar-design ${futureJobId}`));
   return true;
  });
  const futureJob=(await db.pool.query('SELECT state,receipt FROM ac_native_execution_jobs WHERE id=$1',[futureJobId])).rows[0];
  const futureGrant=(await db.pool.query('SELECT state,physical_receipt FROM ac_capacity_grants WHERE id=$1',[futureGrantId])).rows[0];
  const futureRet=(await db.pool.query('SELECT state FROM ac_native_terminal_retirements WHERE job_id=$1',[futureJobId])).rows[0];
  assert.equal(futureJob.state,'uncertain');
  assert.equal(futureJob.receipt,null);
  assert.equal(futureGrant.state,'released');
  assert.equal(futureGrant.physical_receipt?.reason,'exam_login_stale');
  assert.equal(futureRet,undefined);
  assert.equal((await db.pool.query('SELECT state FROM ac_intents WHERE id=$1',[futureIntent.id])).rows[0].state,'accepted');
  dockerState.malformedNetwork=false;
  await db.releaseLease(appAuth);
  await cli('--abandonar-design',futureJobId);
  assert.equal((await db.pool.query('SELECT state FROM ac_native_terminal_retirements WHERE job_id=$1',[futureJobId])).rows[0].state,'removed');
  assert.equal((await db.pool.query('SELECT state FROM ac_intents WHERE id=$1',[futureIntent.id])).rows[0].state,'failed');
  await assert.rejects(lstat(join(spool,futureJobId)),(err:NodeJS.ErrnoException)=>err.code==='ENOENT');
  const settledAuthority=await db.acquire(appPrincipal,mainContext,randomUUID(),'fixture-settled',60);
  const settledIntent=await insertDesignExamIntent(db,appPrincipal,mainContext,settledAuthority.epoch,project,headCommit,true);
  const settledJobId=randomUUID(),settledGrantId=randomUUID();
  const settledInput=NativeExecutionRequest.parse({jobId:settledJobId,intentId:settledIntent.id,grantId:settledGrantId,sessionId:randomUUID(),base:headCommit,role:'specialist',task:'settled exam',artifactId:randomUUID(),outputSchema:{type:'object'},writePaths:[]});
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,'specialist',$8,1,1,$9,false,'reserved')`,[settledGrantId,randomUUID(),settledIntent.id,mainContext,settledAuthority.epoch,account,profile,project,digest(settledInput)]);
  await assert.rejects(futureSupervisor.start(appPrincipal,settledAuthority,settledInput),(err:unknown)=>err instanceof Refusal&&err.code==='EXAM_LOGIN_STALE');
  assert.equal((await db.pool.query('SELECT state FROM ac_native_terminal_retirements WHERE job_id=$1',[settledJobId])).rows[0].state,'removed');
  assert.equal(isProviderLimit('PROVIDER_USAGE_LIMIT'),true);
  await db.releaseLease(settledAuthority);
 }finally{
  homesMock?.mock.restore();
  snapshotMock?.mock.restore();
  await runtime?.close();
  await closeSocket?.();
  await db.close();
  await fixture.close();
  await rm(area,{recursive:true,force:true});
 }
});

test('recoverUnstartedExam refuses contradictory receipts, swapped grants, non-exam roles, residual Docker/launch state, and wrong-context syntheticFixture',{skip:!process.env.AC_TEST_DATABASE_URL},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'unstarted_neg');
 const db=new Ledger(fixture.url);
 const area=await mkdtemp(join(tmpdir(),'ac-unstarted-neg-'));
 let closeSocket:(()=>Promise<void>)|undefined;
 try{
  await db.migrate();
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  const project=randomUUID(),owner='app',account=randomUUID(),otherAccount=randomUUID(),profile=randomUUID(),otherProfile=randomUUID();
  const repo=join(area,'repo'),spool=join(area,'spool'),accounts=join(area,'accounts');
  for(const dir of [repo,spool,accounts])await mkdir(dir,{recursive:true,mode:0o700});
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Negative Proof Isolation']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,owner]);
  await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
  const capacity=new Capacity(db),subject='a'.repeat(64),otherSubject='b'.repeat(64);
  await capacity.addAccount(owner,project,{id:account,provider:'claude',label:'fixture-1',resourceIdentity:'claude:'+subject,mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/1',maxConcurrent:1});
  await capacity.addAccount(owner,project,{id:otherAccount,provider:'claude',label:'fixture-2',resourceIdentity:'claude:'+otherSubject,mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/2',maxConcurrent:1});
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'claude-sonnet-5-5','medium','specialist',true)",[profile,account]);
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'claude-sonnet-5-5','medium','programmer',true)",[otherProfile,otherAccount]);
  const ctx1=await db.createContext(owner,project,randomUUID()),ctx2=await db.createContext(owner,project,randomUUID());
  const auth1=await db.acquire(owner,ctx1,randomUUID(),'mgr-1',60),auth2=await db.acquire(owner,ctx2,randomUUID(),'mgr-2',60);
  await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),owner]);
  const intent1=await insertDesignExamIntent(db,owner,ctx1,auth1.epoch,project,'e'.repeat(40),true);
  const intent2=await insertDesignExamIntent(db,owner,ctx2,auth2.epoch,project,'e'.repeat(40),true);
  const progIntent=await db.accept(owner,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:ctx1,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},auth1,'api');

  const keys=generateKeyPairSync('ed25519'),image='sha256:'+'c'.repeat(64);
  const execFingerprint=createHash('sha256').update(keys.publicKey.export({format:'der',type:'spki'})).digest('hex');
  const sockPath=join(area,'docker.sock');
  const dockerState={containers:new Map<string,Record<string,unknown>>(),networks:new Map<string,Record<string,unknown>>()};
  closeSocket=await startFakeDockerSocket(sockPath,dockerState);
  const supervisor=new NativeExecutionSupervisor(db,{id:'codex-native-execution',provider:'claude',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:'d'.repeat(64),socketPath:sockPath,accountSubjects:[{accountId:account,subjectDigest:subject},{accountId:otherAccount,subjectDigest:otherSubject}],workerEnv:[],toolsEnv:[]},{assertAdmission:async()=>{}});
  const profDigest=digest({accountId:account,profileId:profile,model:'claude-sonnet-5-5',effort:'medium',role:'specialist'});

  const insertPair=async(opts:{physical?: (jobId:string)=>unknown;grantIntent?:string;grantAccount?:string;grantProfile?:string;grantRole?:string;grantState?:string;jobRole?:string;jobIntent?:string;jobProfDigest?:string;context?:typeof auth1;task?:string;jobReceipt?:unknown})=>{
   const jobId=randomUUID(),grantId=randomUUID(),sessionId=randomUUID();
   const scope=opts.context??auth1;
   const intentId=opts.jobIntent??(await insertDesignExamIntent(db,owner,scope.contextId,scope.epoch,project,'e'.repeat(40),true)).id;
   const input=NativeExecutionRequest.parse({jobId,intentId,grantId,sessionId,base:'e'.repeat(40),role:(opts.jobRole??'specialist') as 'specialist'|'programmer',task:opts.task??'neg case',...(opts.jobRole==='programmer'?{writePaths:['src/a.ts']}:{artifactId:randomUUID(),outputSchema:{type:'object'},writePaths:[]})});
   await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state,physical_receipt)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,1,$10,false,$11,$12)`,
    [grantId,randomUUID(),opts.grantIntent??intentId,scope.contextId,scope.epoch,opts.grantAccount??account,opts.grantProfile??profile,opts.grantRole??'specialist',project,digest(input),opts.grantState??'released',opts.physical?opts.physical(jobId):validShape(jobId)]);
   await db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state,receipt)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,$14,'uncertain',$15)`,
    [jobId,grantId,intentId,scope.contextId,scope.epoch,sessionId,account,profile,opts.jobProfDigest??profDigest,supervisor.executorDigest,execFingerprint,digest(input),'e'.repeat(40),opts.jobRole??'specialist',opts.jobReceipt??null]);
   return {jobId,grantId,input};
  };

  // Contradictory / missing / absence-only / wrong-job receipts:
  const validShape=(jobId:string)=>({executionStarted:false,jobId,containerId:null,networkId:null,synthetic:false,modelInference:false,reason:'exam_login_stale'});
  const missingReceipt=await insertPair({physical:()=>null});
  const startedTrue=await insertPair({physical:jobId=>({executionStarted:true,jobId,containerId:null,networkId:null,synthetic:false,modelInference:false,reason:'exam_login_stale'})});
  const inferenceTrue=await insertPair({physical:jobId=>({executionStarted:false,jobId,containerId:null,networkId:null,synthetic:false,modelInference:true,reason:'exam_login_stale'})});
  const wrongJobReceipt=await insertPair({physical:()=>validShape(randomUUID())});
  const syntheticTrue=await insertPair({physical:jobId=>({executionStarted:false,jobId,containerId:null,networkId:null,synthetic:true,modelInference:false,reason:'exam_login_stale'})});
  const sweepOnlyReceipt=await insertPair({physical:()=>({source:'personal-startup-sweep',containersAbsent:true,jobs:[]})});
  const containerSet=await insertPair({physical:jobId=>({executionStarted:false,jobId,containerId:'f'.repeat(64),networkId:null,synthetic:false,modelInference:false,reason:'exam_login_stale'})});
  for(const c of [missingReceipt,startedTrue,inferenceTrue,wrongJobReceipt,syntheticTrue,sweepOnlyReceipt,containerSet]){
   await assert.rejects(supervisor.recoverUnstartedExam(owner,auth1,c.jobId),/NATIVE_EXECUTION_RECEIPT_MISMATCH/);
  }

  // Swapped grant / wrong role / wrong workflow / profile digest mismatch:
  const validJob=await insertPair({jobIntent:intent1.id});
  // Swapped grant intent:
  const swappedGrant=await insertPair({grantIntent:intent2.id});
  await assert.rejects(supervisor.recoverUnstartedExam(owner,auth1,swappedGrant.jobId),/NATIVE_EXECUTION_GRANT_MISMATCH/);
  const swappedAccount=await insertPair({grantAccount:otherAccount,grantProfile:otherProfile,grantRole:'programmer'});
  await assert.rejects(supervisor.recoverUnstartedExam(owner,auth1,swappedAccount.jobId),/NATIVE_EXECUTION_GRANT_MISMATCH/);
  const progJob=await insertPair({jobIntent:progIntent.id,grantIntent:progIntent.id,jobRole:'programmer',grantRole:'programmer',grantAccount:otherAccount,grantProfile:otherProfile});
  await assert.rejects(supervisor.recoverUnstartedExam(owner,auth1,progJob.jobId),/NATIVE_EXECUTION_SCOPE_MISMATCH/);
  const badDigest=await insertPair({jobProfDigest:'9'.repeat(64)});
  await assert.rejects(supervisor.recoverUnstartedExam(owner,auth1,badDigest.jobId),/NATIVE_EXECUTION_NOT_ELIGIBLE/);

  const contradictoryJob=await insertPair({jobReceipt:{payload:{executionStarted:true}}});
  await assert.rejects(supervisor.recoverUnstartedExam(owner,auth1,contradictoryJob.jobId),/NATIVE_RETIREMENT_UNCONFIRMED/);

  const creation=await insertDesignExamIntent(db,owner,ctx1,auth1.epoch,project,'e'.repeat(40));
  const createJob=await insertPair({jobIntent:creation.id,task:'Pedido de criação. Fixture'});
  await mkdir(join(spool,createJob.jobId),{mode:0o700});
  await writeFile(join(spool,createJob.jobId,'request.json'),JSON.stringify(createJob.input),{mode:0o600});
  await assert.rejects(supervisor.recoverUnstartedExam(owner,auth1,createJob.jobId),/NATIVE_EXECUTION_HISTORICAL_CONFIRMATION_REQUIRED/);
  await supervisor.recoverUnstartedExam(owner,auth1,createJob.jobId,{projectId:project,repository:repo,explicitDesignWithdrawal:true});
  assert.equal((await db.pool.query('SELECT state FROM ac_intents WHERE id=$1',[creation.id])).rows[0].state,'failed');
  const otherCreation=await insertPair({task:'Pedido de criação. Sem request'});
  await supervisor.recoverUnstartedExam(owner,auth1,otherCreation.jobId,{projectId:project,repository:repo,explicitDesignWithdrawal:true});
  const parentIntent=await insertDesignExamIntent(db,owner,ctx1,auth1.epoch,project,'e'.repeat(40));
  const parentJob=await insertPair({jobIntent:parentIntent.id});
  await db.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,parent_intent_id,parent_unit_id)
   SELECT $2,context_id,principal_id,$3,command,$4,$5,manager_epoch,plan_revision,id,'fixture-child' FROM ac_intents WHERE id=$1`,[parentIntent.id,randomUUID(),'a'.repeat(64),randomUUID(),randomUUID()]);
  await assert.rejects(supervisor.recoverUnstartedExam(owner,auth1,parentJob.jobId,{projectId:project,repository:repo,explicitDesignWithdrawal:true}),/NATIVE_RETIREMENT_UNCONFIRMED/);
  const multipleIntent=await insertDesignExamIntent(db,owner,ctx1,auth1.epoch,project,'e'.repeat(40));
  const multipleJob=await insertPair({jobIntent:multipleIntent.id});
  await insertPair({jobIntent:multipleIntent.id});
  await assert.rejects(supervisor.recoverUnstartedExam(owner,auth1,multipleJob.jobId,{projectId:project,repository:repo,explicitDesignWithdrawal:true}),/NATIVE_RETIREMENT_UNCONFIRMED/);
  const badRequest=await insertPair({task:'Pedido de criação. Original'});
  await mkdir(join(spool,badRequest.jobId),{mode:0o700});
  await writeFile(join(spool,badRequest.jobId,'request.json'),JSON.stringify({...badRequest.input,task:'Pedido de criação. Alterado'}),{mode:0o600});
  await assert.rejects(supervisor.recoverUnstartedExam(owner,auth1,badRequest.jobId,{projectId:project,repository:repo,explicitDesignWithdrawal:true}),/NATIVE_EXECUTION_REPLAY_MISMATCH/);

  // Residual Docker network (even empty with matching labels) must be refused and NOT deleted:
  const netName='ac-native-exec-'+validJob.jobId;
  dockerState.networks.set(netName,{Id:'e'.repeat(64),Name:netName,Internal:true,Labels:{'agent-control.contract':'native-execution-v1','agent-control.job':validJob.jobId,'agent-control.launch':digest(validJob.input)},Containers:{}});
  await assert.rejects(supervisor.recoverUnstartedExam(owner,auth1,validJob.jobId),/NATIVE_RETIREMENT_UNCONFIRMED/);
  assert.equal(dockerState.networks.has(netName),true);
  dockerState.networks.delete(netName);

  // Residual launch.pending must be refused:
  await mkdir(join(spool,validJob.jobId,'input'),{recursive:true,mode:0o700});
  await writeFile(join(spool,validJob.jobId,'input','launch.pending'),'{}',{mode:0o600});
  await assert.rejects(supervisor.recoverUnstartedExam(owner,auth1,validJob.jobId),/NATIVE_RETIREMENT_UNCONFIRMED/);
  await rm(join(spool,validJob.jobId),{recursive:true,force:true});

  // Plan cancellation blocks recoverUnstartedExam so normal cancellation flow is never bypassed:
  await db.pool.query('INSERT INTO ac_plan_cancellations(intent_id,context_id,requested_by,plan_revision) VALUES($1,$2,$3,0)',[intent1.id,ctx1,owner]);
  await assert.rejects(supervisor.recoverUnstartedExam(owner,auth1,validJob.jobId),/PLAN_CANCELLATION_REQUESTED/);

  // Cross-context forged intent reference rejected on recover and reconcile:
  const forgedJob=await insertPair({jobIntent:intent2.id,grantIntent:intent2.id});
  await assert.rejects(supervisor.recover(owner,auth1,forgedJob.jobId),/NATIVE_EXECUTION_JOB_NOT_FOUND/);
  await assert.rejects(supervisor.reconcile(owner,auth1,forgedJob.input),/NATIVE_EXECUTION_SCOPE_MISMATCH/);

  // syntheticFixture capability bound to ctx1 is rejected in ctx2 on paths WITHOUT request.json!
  const dockerPath=join(area,'docker');
  const fixtureLabel='ac-r3-flow-ctx1';
  const providerNetworkId='d'.repeat(64);
  const imageEvidence=JSON.stringify([{Id:image,Config:{Labels:{'agent-control.synthetic-fixture':fixtureLabel}}}]);
  const networkEvidence=JSON.stringify([{Id:providerNetworkId,Internal:true,Labels:{'agent-control.synthetic-fixture':fixtureLabel}}]);
  await writeFile(dockerPath,`#!/bin/sh
case "$1:$2:$3" in
  image:inspect:${image}) printf '%s\n' '${imageEvidence}' ;;
  network:inspect:${providerNetworkId}) printf '%s\n' '${networkEvidence}' ;;
  *) exit 1 ;;
esac
`,{mode:0o700});
  const previousPath=process.env.PATH;
  let capability;
  try{
   process.env.PATH=area;
   capability=await authorizeNativeSyntheticFixture({contract:'native-synthetic-fixture-v1',projectId:project,contextId:ctx1,provider:'synthetic-engineering',label:fixtureLabel,workerImage:image,toolsImage:image,providerNetworkId});
  }finally{
   if(previousPath===undefined)delete process.env.PATH;
   else process.env.PATH=previousPath;
  }
  const synthSupervisor=new NativeExecutionSupervisor(db,{id:'synth-exec',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:'d'.repeat(64),socketPath:sockPath,accountSubjects:[{accountId:account,subjectDigest:subject}],workerEnv:[],toolsEnv:[],syntheticFixture:capability},{assertAdmission:async()=>{}});
  const {jobId:ctx2JobId}=await insertPair({jobIntent:intent2.id,context:auth2});
  await assert.rejects(synthSupervisor.recoverUnstartedExam(owner,auth2,ctx2JobId),/SYNTHETIC_FIXTURE_CAPABILITY_INVALID/);
  await assert.rejects(synthSupervisor.recover(owner,auth2,ctx2JobId),/SYNTHETIC_FIXTURE_CAPABILITY_INVALID/);
 }finally{
  await closeSocket?.();
  await db.close();
  await fixture.close();
  await rm(area,{recursive:true,force:true});
 }
});

test('normal programmer cancellation reconciliation via CezarRuntime stays preserved',{skip:!process.env.AC_TEST_DATABASE_URL},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'norm_cancel');
 const db=new Ledger(fixture.url);
 const area=await mkdtemp(join(tmpdir(),'ac-norm-cancel-'));
 let runtime:CezarRuntime|undefined;
 try{
  await db.migrate();
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  const capacity=new Capacity(db),project=randomUUID(),principal='prog-'+randomUUID(),account=randomUUID(),profile=randomUUID();
  const repo=join(area,'repo'),spool=join(area,'spool'),accounts=join(area,'accounts');
  for(const dir of [repo,spool,accounts])await mkdir(dir,{mode:0o700});
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Normal Cancel Preservation']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
  const subject='a'.repeat(64);
  await capacity.addAccount(principal,project,{id:account,provider:'codex',label:'fixture',resourceIdentity:'codex:'+subject,mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/fixture',maxConcurrent:1});
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'gpt-5.4','medium','programmer',true)",[profile,account]);
  const context=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,context,randomUUID(),'fixture-mgr',60);
  await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),principal]);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
  const grant=randomUUID(),keys=generateKeyPairSync('ed25519'),image='sha256:'+'c'.repeat(64);
  const supervisor=new NativeExecutionSupervisor(db,{id:'codex-native-execution',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:'d'.repeat(64),socketPath:'/no-operational-docker.sock',accountSubjects:[{accountId:account,subjectDigest:subject}],workerEnv:[],toolsEnv:[]});
  const input=NativeExecutionRequest.parse({jobId:intent.operation_id,intentId:intent.id,grantId:grant,sessionId:randomUUID(),base:'e'.repeat(40),role:'programmer',task:'cancel me',writePaths:['src/a.ts']});
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,'programmer',$8,1,1,$9,false,'uncertain')`,[grant,randomUUID(),intent.id,context,authority.epoch,account,profile,project,digest(input)]);
  const workerId='f'.repeat(64),toolsId='1'.repeat(64),network='2'.repeat(64),hash=digest(input);
  await db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state,worker_id,tools_id,network_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,'programmer','running',$14,$15,$16)`,
   [input.jobId,grant,intent.id,context,authority.epoch,input.sessionId,account,profile,digest({fixture:true}),supervisor.executorDigest,supervisor.keyFingerprint,hash,input.base,workerId,toolsId,network]);
  await db.pool.query("UPDATE ac_operations SET state='uncertain',grant_id=$2,native_session_id=$3 WHERE id=$1",[input.jobId,grant,input.sessionId]);
  const root=join(spool,input.jobId);await mkdir(join(root,'output'),{recursive:true,mode:0o700});
  await writeFile(join(root,'request.json'),JSON.stringify(input),{mode:0o600});
  const labels={'agent-control.job':input.jobId,'agent-control.launch':hash,'agent-control.contract':'native-execution-v1'};
  const makeContainer=(id:string)=>({Id:id,Image:image,Config:{Labels:labels},State:{Status:'running',Running:true,ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z'}});
  const w=makeContainer(workerId),t=makeContainer(toolsId);
  const containers=new Map<string,any>([['ac-native-worker-'+input.jobId,w],[workerId,w],['ac-native-tools-'+input.jobId,t],[toolsId,t]]);
  Object.defineProperty(supervisor,'docker',{value:{
   inspect:async(name:string)=>containers.get(name)??null,
   stop:async(id:string)=>{const item=id===workerId?w:t;item.State={Status:'exited',Running:false,ExitCode:137,FinishedAt:new Date().toISOString()};},
   logs:async()=>Buffer.from(''),
   remove:async(id:string)=>{for(const [name,item] of [...containers])if(item?.Id===id)containers.delete(name);},
   inspectPrivateNetwork:async()=>null,
   removePrivateNetwork:async()=>{},
  }});
  await db.pool.query('INSERT INTO ac_plan_cancellations(intent_id,context_id,requested_by,plan_revision) VALUES($1,$2,$3,$4)',[intent.id,context,principal,intent.plan_revision]);
  runtime=new CezarRuntime(db,repo,project,undefined,undefined,undefined,{nativeExecutions:[supervisor]});
  await runtime.start('administration-only');
  await runtime.reconcileCancellations(authority,principal);
  assert.equal((await db.pool.query('SELECT state FROM ac_plan_cancellations WHERE intent_id=$1',[intent.id])).rows[0].state,'confirmed');
  assert.equal((await db.pool.query('SELECT receipt FROM ac_operations WHERE id=$1',[input.jobId])).rows[0].receipt.cancellation,true);
  assert.equal((await db.pool.query('SELECT state FROM ac_native_terminal_retirements WHERE job_id=$1',[input.jobId])).rows[0].state,'removed');
 }finally{
  await runtime?.close();
  await db.close();
  await fixture.close();
  await rm(area,{recursive:true,force:true});
 }
});
