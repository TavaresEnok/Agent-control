import {mock,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createPublicKey,generateKeyPairSync,randomUUID,verify} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chmod,lstat,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {Capacity} from '../src/capacity.ts';
import {NativeExecutionSupervisor,NativeExecutionRequest} from '../src/native-execution-supervisor.ts';
import {reconcileNativeResourceAdmissions,NativeResourceDockerDaemon} from '../src/native-resource-envelope.ts';
import {OPEN_EXECUTION_JOBS_SQL,runPersonalMaintenance} from '../src/personal-maintenance.ts';
import {nativePlanningExecutorDigest} from '../src/native-planning-contract.ts';
import {nativeExecutionExecutorDigest} from '../src/native-execution-contract.ts';
import {NativeQaContract,nativeQaContractDigest} from '../src/native-qa-contract.ts';
import {nativeReviewVerifierDigest} from '../src/native-review-contract.ts';
import {Authority,canonical,digest} from '../src/contracts.ts';
import {ProviderEligibility} from '../src/provider-eligibility.ts';
import {AccountHomes} from '../src/account-homes.ts';
import {GitArtifacts} from '../src/git.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const exec=promisify(execFile);

async function insertDesignExamIntent(db:Ledger,principal:string,contextId:string,epoch:number,projectId:string,commit:string){
 const intentId=randomUUID();
 const command={
  schemaVersion:1 as const,
  intentId,
  deliveryAttemptId:randomUUID(),
  contextId,
  policyRevision:0,
  action:'plan.start' as const,
  payload:{workflow:'design-readonly-v1' as const,messageRef:`design:${projectId}:${commit}`.slice(0,200),projectId,commit},
 };
 await db.pool.query(
  `INSERT INTO ac_intents (id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision)
   VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,0)`,
  [intentId,contextId,principal,digest(command),JSON.stringify(command),randomUUID(),randomUUID(),epoch],
 );
 return {id:intentId,command};
}

test('interrupted specialist exam reconciles and retires across co-owner gateway without re-execution and preserves strict isolation',{skip:!process.env.AC_TEST_DATABASE_URL},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'interrupted_exam');
 const db=new Ledger(fixture.url);
 const area=await mkdtemp(join(tmpdir(),'ac-interrupted-exam-'));
 let runtime:CezarRuntime|undefined;
 let viewedMock:ReturnType<typeof mock.method>|undefined;
 let homesMock:ReturnType<typeof mock.method>|undefined;
 let snapshotMock:ReturnType<typeof mock.method>|undefined;
 try{
  await db.migrate();
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  const capacity=new Capacity(db);
  const project=randomUUID(),otherProject=randomUUID();
  const appPrincipal='app',gatewayPrincipal='happier:owner-'+randomUUID(),operatorPrincipal='operator-'+randomUUID(),foreignOwner='foreign-owner-'+randomUUID();
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

  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Interrupted Exam Fixture']);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[otherProject,'Foreign Project']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner'),($1,$3,'owner'),($1,$4,'operator'),($5,$6,'owner')",[project,appPrincipal,gatewayPrincipal,operatorPrincipal,otherProject,foreignOwner]);
  await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2),($3,$4)',[project,repo,otherProject,otherRepo]);

  const subject=digest({provider:'codex',subject:'fixture-codex-sub'});
  await capacity.addAccount(appPrincipal,project,{id:account,provider:'codex',label:'personal fixture',resourceIdentity:'codex:'+subject,mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/fixture',maxConcurrent:2});
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'gpt-6.1-terra','medium','specialist',true)",[profile,account]);
  const progProfile=randomUUID();
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'gpt-6.1-terra','medium','programmer',true)",[progProfile,account]);
  await capacity.addAccount(foreignOwner,otherProject,{id:foreignAccount,provider:'codex',label:'foreign fixture',resourceIdentity:'codex:'+'f'.repeat(64),mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/foreign',maxConcurrent:1});

  const otherContext=await db.createContext(appPrincipal,project,randomUUID());
  const exam=await db.ensureExamContext(appPrincipal,project,'design');
  const context=exam.contextId;
  const foreignContext=await db.createContext(foreignOwner,otherProject,randomUUID());
  const authority=await db.acquire(gatewayPrincipal,context,randomUUID(),'gateway-manager',60);
  const otherAuthority=await db.acquire(gatewayPrincipal,otherContext,randomUUID(),'other-manager',60);
  const foreignAuthority=await db.acquire(foreignOwner,foreignContext,randomUUID(),'foreign-manager',60);

  await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),appPrincipal]);
  const examIntent=await insertDesignExamIntent(db,appPrincipal,context,authority.epoch,project,headCommit);
  await insertDesignExamIntent(db,appPrincipal,otherContext,otherAuthority.epoch,project,headCommit);

  const execKeys=generateKeyPairSync('ed25519'),planKeys=generateKeyPairSync('ed25519'),reviewKeys=generateKeyPairSync('ed25519');
  const execPem=execKeys.privateKey.export({format:'pem',type:'pkcs8'}).toString();
  const planKeyFile=join(keysDir,'plan.pem'),execKeyFile=join(keysDir,'exec.pem'),reviewKeyFile=join(keysDir,'review.pem');
  await writeFile(planKeyFile,planKeys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),{mode:0o600});
  await writeFile(execKeyFile,execPem,{mode:0o600});
  await writeFile(reviewKeyFile,reviewKeys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),{mode:0o600});
  const fingerprintOf=(key:import('node:crypto').KeyObject)=>createHash('sha256').update(key.export({format:'der',type:'spki'})).digest('hex');
  const execFingerprint=fingerprintOf(execKeys.publicKey);
  const image='sha256:'+'c'.repeat(64);
  const config={id:'codex-native-execution',provider:'codex' as const,workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem:execPem,providerNetworkId:'d'.repeat(64),socketPath:'/no-operational-docker.sock',accountSubjects:[{accountId:account,subjectDigest:subject}],workerEnv:[],toolsEnv:[]};
  const supervisor=new NativeExecutionSupervisor(db,config,{assertAdmission:async()=>{}});

  const inspectCalls:string[]=[];
  const containers=new Map<string,any>(),networksByName=new Map<string,any>();
  let creates=0,starts=0,stops=0;
  const docker={
   inspect:async(name:string)=>{inspectCalls.push(name);return containers.get(name)??null;},
   inspectNamedPrivateNetwork:async(name:string)=>networksByName.get(name)??null,
   stop:async()=>{stops++;},
   remove:async()=>{},
   logs:async()=>Buffer.from(''),
   imagePresent:async()=>true,
   createPrivateNetwork:async()=>{creates++;return 'e'.repeat(64);},
   create:async()=>{creates++;return 'f'.repeat(64);},
   start:async()=>{starts++;},
   inspectPrivateNetwork:async()=>null,
   removePrivateNetwork:async(id:string)=>{for(const [name,net] of networksByName)if(net?.Id===id)networksByName.delete(name);},
  };
  Object.defineProperty(supervisor,'docker',{value:docker});

  const makeInterruptedSpecialist=async(withSpool:boolean)=>{
   const jobId=randomUUID(),grantId=randomUUID(),sessionId=randomUUID(),attemptId=randomUUID();
   const input=NativeExecutionRequest.parse({jobId,intentId:examIntent.id,grantId,sessionId,base:headCommit,role:'specialist',task:'synthetic interrupted exam',artifactId:randomUUID(),outputSchema:{type:'object'},writePaths:[]});
   const inputDigest=digest(input),physical={state:'not_started',processId:'interrupted-prelaunch',executionStarted:false};
   await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state,physical_receipt)
    VALUES($1,$2,$3,$4,$5,$6,$7,'specialist',$8,1,1,$9,false,'released',$10)`,[grantId,attemptId,examIntent.id,context,authority.epoch,account,profile,project,inputDigest,physical]);
   await db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,'specialist','uncertain')`,[jobId,grantId,examIntent.id,context,authority.epoch,sessionId,account,profile,digest({accountId:account,profileId:profile,model:'gpt-6.1-terra',effort:'medium',role:'specialist'}),supervisor.executorDigest,execFingerprint,inputDigest,headCommit]);
   if(withSpool){
    const root=join(spool,jobId);await mkdir(root,{mode:0o700});await writeFile(join(root,'request.json'),JSON.stringify(input),{mode:0o600});
   }
   return {jobId,grantId,sessionId,input,physical};
  };

  // Job A: spool request.json exists; Job B: spool directory already absent (ENOENT); Job C: direct recover() target.
  const jobA=await makeInterruptedSpecialist(true);
  const jobB=await makeInterruptedSpecialist(false);
  const jobC=await makeInterruptedSpecialist(false);
  const jobAdm=await makeInterruptedSpecialist(false);

  // Simulate an orphaned admission tied to jobAdm's already-released grant on a NativeResourceDockerDaemon root.
  const admissionId=randomUUID();
  const resourceDocker=new NativeResourceDockerDaemon({stateRoot:spool,installationId:'exam-fixture',authorityEpoch:authority.epoch,resourceAuthority:{authorityId:'ac-r3-resources-exam',anchorId:'a'.repeat(64),cpuQuotaMicros:50000,cpuPeriodMicros:100000,memoryBytes:16777216,pidsLimit:16,maxJobs:4}});
  resourceDocker.callResource=async(action:string)=>{
   if(action==='cancel_admission')return {proof:'no_groups_no_create_claims'};
   if(action==='inspect')return {absent:true};
   throw new Error('UNEXPECTED_HOST_ACTION_'+action);
  };
  resourceDocker.inspectNamedPrivateNetwork=async()=>null;
  await db.pool.query(`INSERT INTO ac_native_resource_admissions(job_id,grant_id,context_id,manager_epoch,authority_id,names,admission_id,state_root,state,reason)
   VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'waiting','physical_capacity')`,[jobAdm.jobId,jobAdm.grantId,context,authority.epoch,resourceDocker.authorityId,JSON.stringify(['ac-native-tools-'+jobAdm.jobId,'ac-native-worker-'+jobAdm.jobId]),admissionId,resourceDocker.stateRoot]);

  // Write synthetic installation.json for personal:maintenance proof (marking current executor pair as retired to observe OPEN_EXECUTION_JOBS_SQL directly).
  const currentImage='sha256:'+'0'.repeat(64);
  const qaContract=NativeQaContract.parse({schemaVersion:1,id:'qa-synthetic',image:currentImage,argv:['/bin/true'],environment:[],timeoutMs:15000,memoryBytes:268435456,pids:64,nanoCpus:1000000000});
  const installationFile=join(area,'installation.json');
  await writeFile(installationFile,JSON.stringify({
   schemaVersion:1,
   mode:'administration-only',
   activation:'personal',
   databaseUrl:fixture.url,
   dataDirectory:dataDir,
   contextVault:{directory:vaultDir,masterFile:vaultMaster},
   project:{id:project,label:'Synthetic Personal Exam',repo,owner:appPrincipal},
   managerTransport:{principal:gatewayPrincipal,tokenFile,machineId:'machine-fixture',transport:'local',contexts:[{projectId:project,contextId:context,sessionId:'sess-1',profileId:profile,keyVersion:1,encryptionVariant:'dataKey'}]},
   nativeBootstrap:{
    state:'active',contract:'native-bootstrap-configured-v1',projectId:project,contextId:context,epoch:authority.epoch,instanceId:authority.instanceId,source:'authorized-endpoint',
    accounts:[{accountId:account,subjectDigest:subject}],
    planning:{id:'codex-native-planning',imageId:currentImage,executorDigest:nativePlanningExecutorDigest(currentImage),signingKeyFile:planKeyFile,keyFingerprint:fingerprintOf(planKeys.publicKey),hostRoot:planHost,accountRoot:planAccounts},
    execution:{id:'codex-native-execution',workerImage:currentImage,toolsImage:currentImage,retiredImages:[{workerImage:image,toolsImage:image}],executorDigest:nativeExecutionExecutorDigest(currentImage,currentImage),signingKeyFile:execKeyFile,keyFingerprint:fingerprintOf(execKeys.publicKey),hostRoot:spool,accountRoot:accounts,providerNetworkId:'d'.repeat(64),workerEnv:[],toolsEnv:[]},
    qa:qaContract,qaDigest:nativeQaContractDigest(qaContract),
    review:{signingKeyFile:reviewKeyFile,keyFingerprint:fingerprintOf(reviewKeys.publicKey),verifierDigest:nativeReviewVerifierDigest},
   },
   http:{listen:'127.0.0.1',port:43101,publicOrigin:'http://127.0.0.1:43101'},
   happier:{upstreamOrigin:'http://127.0.0.1:43102',webOrigin:'http://127.0.0.1:43103',publicServerOrigin:'http://127.0.0.1:43104'},
  }),{mode:0o600});

  // Strict isolation counter-proofs before modifying job states:
  await assert.rejects(supervisor.recover(operatorPrincipal,authority,jobA.jobId),/NATIVE_EXECUTION_SCOPE_MISMATCH/);
  await assert.rejects(supervisor.reconcileRegistered(operatorPrincipal,authority,jobB.jobId),/NATIVE_EXECUTION_SCOPE_MISMATCH/);
  await assert.rejects(supervisor.retireTerminal(operatorPrincipal,authority,jobA.jobId),/NATIVE_EXECUTION_SCOPE_MISMATCH/);
  await assert.rejects(supervisor.recover(foreignOwner,authority,jobA.jobId),/FORBIDDEN/);
  await assert.rejects(supervisor.recover(gatewayPrincipal,otherAuthority,jobA.jobId),/NATIVE_EXECUTION_JOB_NOT_FOUND/);
  await assert.rejects(supervisor.recover(gatewayPrincipal,foreignAuthority,jobA.jobId),/CONTEXT_FORBIDDEN/);
  // Co-owner cannot start a new execution on an 'app'-owned intent:
  await assert.rejects(supervisor.start(gatewayPrincipal,authority,{...jobA.input,jobId:randomUUID()}),/NATIVE_EXECUTION_SCOPE_MISMATCH/);
  // Operator cannot settle or cancel another owner's admission via reconcileNativeResourceAdmissions:
  await reconcileNativeResourceAdmissions({docker:resourceDocker,ledger:db,principal:operatorPrincipal,authority,recoverJob:async()=>{throw Error('OPERATOR_MUST_NOT_RECOVER');},recoverSource:'ac_native_execution_jobs'});
  assert.equal((await db.pool.query('SELECT state FROM ac_native_resource_admissions WHERE job_id=$1',[jobAdm.jobId])).rows[0].state,'waiting');
  assert.equal((await db.pool.query('SELECT state FROM ac_native_execution_jobs WHERE id=$1',[jobAdm.jobId])).rows[0].state,'uncertain');

  // Physical counter-proof: while a residual named private network exists for jobC, jobC MUST remain uncertain and retirement MUST be refused.
  networksByName.set('ac-native-exec-'+jobC.jobId,{Name:'ac-native-exec-'+jobC.jobId,Id:'not-matching-hex',Internal:true,Labels:{},Containers:{a:1}});
  assert.equal((await supervisor.recover(gatewayPrincipal,authority,jobC.jobId)).state,'uncertain');
  assert.equal((await db.pool.query('SELECT state FROM ac_native_execution_jobs WHERE id=$1',[jobC.jobId])).rows[0].state,'uncertain');
  await assert.rejects(supervisor.retireTerminal(gatewayPrincipal,authority,jobC.jobId),/NATIVE_RETIREMENT_UNCONFIRMED/);
  networksByName.delete('ac-native-exec-'+jobC.jobId);

  // Clean recovery of jobC via recover() as gateway co-owner:
  const recoveredC=await supervisor.recover(gatewayPrincipal,authority,jobC.jobId);
  assert.equal(recoveredC.state,'released_unstarted');
  assert.equal(recoveredC.interval,'proven_not_started');
  assert.equal(recoveredC.grant,'released');
  assert.equal(recoveredC.replayed,false);
  assert.ok(recoveredC.receipt);

  // Before gateway reconciliation, OPEN_EXECUTION_JOBS_SQL still sees jobA, jobB, jobAdm (uncertain) and jobC (failed without terminal retirement).
  assert.equal((await db.pool.query(OPEN_EXECUTION_JOBS_SQL,[supervisor.executorDigest])).rows[0].n,4);
  const blockedMaint=await runPersonalMaintenance([installationFile],{docker:async()=>0,imageExists:async()=>true,refreshDatabases:async()=>{}});
  assert.ok(blockedMaint.some(line=>line.includes('Nenhuma imagem aposentada pôde sair')));

  // Resource admission reconciler settles the orphaned admission for jobAdm's released grant via co-owner principal:
  const resourceSupervisor=new NativeExecutionSupervisor(db,config,{assertAdmission:async()=>{}});
  Object.defineProperty(resourceSupervisor,'docker',{value:resourceDocker});
  await reconcileNativeResourceAdmissions({docker:resourceDocker,ledger:db,principal:gatewayPrincipal,authority,recoverJob:id=>resourceSupervisor.reconcileRegistered(gatewayPrincipal,authority,id),recoverSource:'ac_native_execution_jobs'});
  assert.equal((await db.pool.query('SELECT state FROM ac_native_resource_admissions WHERE job_id=$1',[jobAdm.jobId])).rows[0].state,'canceled');
  assert.equal((await db.pool.query('SELECT state FROM ac_native_execution_jobs WHERE id=$1',[jobAdm.jobId])).rows[0].state,'failed');

  // Gateway reconciliation settles remaining jobA & jobB, writes terminal retirements for all jobs, without re-executing or stopping containers.
  runtime=new CezarRuntime(db,repo,project,undefined,undefined,undefined,{nativeExecutions:[supervisor]});
  await runtime.start('administration-only');
  await runtime.reconcileCancellations(authority,gatewayPrincipal);

  assert.equal(creates,0);
  assert.equal(starts,0);
  assert.equal(stops,0);

  for(const job of [jobA,jobB,jobC,jobAdm]){
   const row=(await db.pool.query('SELECT state,receipt,worker_id,tools_id,network_id,launch_digest FROM ac_native_execution_jobs WHERE id=$1',[job.jobId])).rows[0];
   assert.equal(row.state,'failed');
   assert.equal(row.worker_id,null);
   assert.equal(row.tools_id,null);
   assert.equal(row.network_id,null);
   assert.equal(row.launch_digest,null);
   assert.equal(row.receipt?.payload?.executionStarted,false);
   assert.equal(row.receipt?.payload?.physicalDigest,digest(job.physical));
   assert.equal(verify(null,Buffer.from('agent-control:native-execution-receipt:v1\n'+canonical(row.receipt.payload)),createPublicKey(execPem),Buffer.from(row.receipt.signature,'hex')),true);
   const grantRow=(await db.pool.query('SELECT state,physical_receipt FROM ac_capacity_grants WHERE id=$1',[job.grantId])).rows[0];
   assert.equal(grantRow.state,'released');
   assert.deepEqual(grantRow.physical_receipt,job.physical);
   const retirement=(await db.pool.query('SELECT binding,state,proof FROM ac_native_terminal_retirements WHERE job_id=$1',[job.jobId])).rows[0];
   assert.ok(retirement);
   assert.equal(retirement.state,'removed');
   assert.equal(retirement.binding.kind,'native-unstarted-retired');
   assert.equal(retirement.binding.executionStarted,false);
   assert.equal(retirement.proof.payload.kind,'native-unstarted-retired');
   assert.equal(retirement.proof.payload.executionStarted,false);
   assert.equal(verify(null,Buffer.from('agent-control:native-terminal-retirement:v1\n'+canonical(retirement.proof.payload)),createPublicKey(execPem),Buffer.from(retirement.proof.signature,'hex')),true);
  }
  await assert.doesNotReject(lstat(join(spool,jobA.jobId,'request.json')));

  // Re-running reconcileCancellations is completely idempotent and no longer touches already-retired jobs:
  const inspectCountBefore=inspectCalls.length;
  await runtime.reconcileCancellations(authority,gatewayPrincipal);
  assert.equal(inspectCalls.length,inspectCountBefore);
  assert.equal(creates,0);
  assert.equal(starts,0);

  // Maintenance now reports 0 open jobs and removes retiredImages cleanly on the synthetic installation:
  assert.equal((await db.pool.query(OPEN_EXECUTION_JOBS_SQL,[supervisor.executorDigest])).rows[0].n,0);
  const removedImages:string[]=[];
  const cleanMaint=await runPersonalMaintenance([installationFile],{docker:async args=>{if(args[0]==='image'&&args[1]==='rm')removedImages.push(args[2]!);return 0;},imageExists:async()=>true,refreshDatabases:async()=>{}});
  assert.ok(cleanMaint.some(line=>line.includes('1 par(es) de execução')));
  assert.deepEqual(removedImages,[image]);
  const updatedInstall=JSON.parse(await readFile(installationFile,'utf8'));
  assert.equal(updatedInstall.nativeBootstrap.execution.retiredImages,undefined);

  // Forward prevention proof: a pre-launch failure after inserting ac_native_execution_jobs settles the job to 'failed' with signed unstarted receipt and releases the grant.
  await db.pool.query('UPDATE ac_accounts SET enabled=true WHERE id=$1',[account]);
  await capacity.observeQuota(appPrincipal,account,{status:'available',source:'https://example.invalid/fixture',ttlSeconds:3600});
  const prelaunchJobId=randomUUID(),prelaunchSession=randomUUID(),prelaunchGrantId=randomUUID();
  const prelaunchInput=NativeExecutionRequest.parse({jobId:prelaunchJobId,intentId:examIntent.id,grantId:prelaunchGrantId,sessionId:prelaunchSession,base:headCommit,role:'specialist',task:'synthetic prelaunch failure',artifactId:randomUUID(),outputSchema:{type:'object'},writePaths:[]});
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,'specialist',$8,1,1,$9,false,'reserved')`,[prelaunchGrantId,randomUUID(),examIntent.id,context,authority.epoch,account,profile,project,digest(prelaunchInput)]);
  const codexAccountRoot=join(accounts,account),codexHome=join(codexAccountRoot,'.codex');
  await mkdir(codexHome,{recursive:true,mode:0o700});await chmod(codexAccountRoot,0o700);await chmod(codexHome,0o700);
  await writeFile(join(codexHome,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{account_id:'fixture-codex-sub',access_token:'fixture-access',refresh_token:'fixture-refresh'}}),{mode:0o600});
  viewedMock=mock.method(ProviderEligibility.prototype,'view',async()=>({accountId:account,latest:{fresh:true,effectiveStatus:'documented_supported',authenticationMode:'synthetic',executionMode:'synthetic',adapterId:config.id,adapterVersion:supervisor.executorDigest,revision:1},history:[]}));
  homesMock=mock.method(AccountHomes.prototype,'inspectGranted',async()=>({accountId:account,projectId:project,ownerId:appPrincipal,uid:'1',device:'1',inode:'1'}));
  snapshotMock=mock.method(GitArtifacts.prototype,'snapshot',async()=>{throw new Error('SYNTHETIC_SNAPSHOT_ABORT');});
  await assert.rejects(supervisor.start(appPrincipal,authority,prelaunchInput),/SYNTHETIC_SNAPSHOT_ABORT/);
  const prelaunchJob=(await db.pool.query('SELECT state,receipt FROM ac_native_execution_jobs WHERE id=$1',[prelaunchJobId])).rows[0];
  const prelaunchGrantRow=(await db.pool.query('SELECT state,physical_receipt FROM ac_capacity_grants WHERE id=$1',[prelaunchGrantId])).rows[0];
  assert.equal(prelaunchJob.state,'failed');
  assert.equal(prelaunchJob.receipt?.payload?.executionStarted,false);
  assert.equal(prelaunchGrantRow.state,'released');
  assert.equal(prelaunchGrantRow.physical_receipt?.executionStarted,false);
  await assert.rejects(lstat(join(spool,prelaunchJobId)),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
 }finally{
  viewedMock?.mock.restore();
  homesMock?.mock.restore();
  snapshotMock?.mock.restore();
  await runtime?.close();
  await db.close();
  await fixture.close();
  await rm(area,{recursive:true,force:true});
 }
});

test('cross-context forged intent reference in supervisor is always rejected even for co-owners',{skip:!process.env.AC_TEST_DATABASE_URL},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'cross_ctx_exec');
 const db=new Ledger(fixture.url);
 const area=await mkdtemp(join(tmpdir(),'ac-cross-context-exec-'));
 try{
  await db.migrate();
  const project=randomUUID(),ownerA='owner-a-'+randomUUID(),ownerB='owner-b-'+randomUUID(),account=randomUUID(),profile=randomUUID();
  const repo=join(area,'repo'),spool=join(area,'spool'),accounts=join(area,'accounts');
  for(const dir of [repo,spool,accounts])await mkdir(dir,{recursive:true,mode:0o700});
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Cross Context Isolation']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner'),($1,$3,'owner')",[project,ownerA,ownerB]);
  await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
  const capacity=new Capacity(db),subject='a'.repeat(64);
  await capacity.addAccount(ownerA,project,{id:account,provider:'codex',label:'fixture',resourceIdentity:'codex:'+subject,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/fixture',maxConcurrent:1});
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'gpt-6.1-terra','medium','specialist',true)",[profile,account]);
  const ctx1=await db.createContext(ownerA,project,randomUUID()),ctx2=await db.createContext(ownerA,project,randomUUID());
  const auth1=await db.acquire(ownerB,ctx1,randomUUID(),'mgr-1',60),auth2=await db.acquire(ownerB,ctx2,randomUUID(),'mgr-2',60);
  await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),ownerA]);
  const intentCtx2=await insertDesignExamIntent(db,ownerA,ctx2,auth2.epoch,project,'e'.repeat(40));
  const keys=generateKeyPairSync('ed25519'),image='sha256:'+'c'.repeat(64);
  const execFingerprint=createHash('sha256').update(keys.publicKey.export({format:'der',type:'spki'})).digest('hex');
  const supervisor=new NativeExecutionSupervisor(db,{id:'codex-native-execution',provider:'codex',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:'d'.repeat(64),socketPath:'/no-operational-docker.sock',accountSubjects:[{accountId:account,subjectDigest:subject}],workerEnv:[],toolsEnv:[]},{assertAdmission:async()=>{}});
  const jobId=randomUUID(),grantId=randomUUID(),sessionId=randomUUID();
  const input=NativeExecutionRequest.parse({jobId,intentId:intentCtx2.id,grantId,sessionId,base:'e'.repeat(40),role:'specialist',task:'forged cross-context reference',artifactId:randomUUID(),outputSchema:{type:'object'},writePaths:[]});
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state,physical_receipt)
   VALUES($1,$2,$3,$4,$5,$6,$7,'specialist',$8,1,1,$9,false,'released',$10)`,[grantId,randomUUID(),intentCtx2.id,ctx1,auth1.epoch,account,profile,project,digest(input),{state:'not_started',executionStarted:false}]);
  await db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,'specialist','uncertain')`,[jobId,grantId,intentCtx2.id,ctx1,auth1.epoch,sessionId,account,profile,digest({}),supervisor.executorDigest,execFingerprint,digest(input),'e'.repeat(40)]);
  await assert.rejects(supervisor.recover(ownerB,auth1,jobId),/NATIVE_EXECUTION_JOB_NOT_FOUND/);
  await assert.rejects(supervisor.reconcile(ownerB,auth1,input),/NATIVE_EXECUTION_SCOPE_MISMATCH/);
 }finally{
  await db.close();
  await fixture.close();
  await rm(area,{recursive:true,force:true});
 }
});
