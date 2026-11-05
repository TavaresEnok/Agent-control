import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {NativeExecutionSupervisor} from '../src/native-execution-supervisor.ts';
import {NativeImplementation} from '../src/native-implementation.ts';
import {NativeVerification,nativeReviewVerifierDigest} from '../src/native-verification.ts';
import {NativeQa,NativeQaContract,nativeQaContractDigest,assertCompleteQaLogs} from '../src/native-qa.ts';
import {authorizeNativeSyntheticFixture} from '../src/native-synthetic-fixture.ts';
import {ProviderEligibility} from '../src/provider-eligibility.ts';
import {AccountHomes} from '../src/account-homes.ts';
import {Templates} from '../src/templates.ts';
import {ManagerPlans} from '../src/planning.ts';
import {ProjectEnvironments} from '../src/project-environments.ts';
import {Operators,operatorMessage} from '../src/operator.ts';
import {digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {provisionEngineering} from './fixtures/provision-engineering.ts';
import {installGraphAllocator} from './fixtures/r2-graph-allocator.ts';
import {cleanupGraphResources} from './fixtures/native-graph-cleanup.ts';
import {provisionFlowResources,retireFlowResources,assertFlowResourceLimits,type FlowResourceEnvelope} from './fixtures/r3-flow-resources.ts';

/** Actual effects; only model behavior and subnet allocation are deterministic.
 * No Happier/planner/cancellation duplicate, provider login or official inference. */
test('native programmer artifact containing a known capability is quarantined and writer retired',{timeout:180000},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL,image=process.env.AC_R3_FLOW_IMAGE,network=process.env.AC_R3_FLOW_NETWORK,label=process.env.AC_R3_FLOW_LABEL;
 if(!base||!image||!network||!label||process.env.AC_R3_FLOW_TOOLS_KIND!=='codex-exec-server')throw Error('R4_CORRECTION_ISOLATED_RUNNER_REQUIRED');
 const database=await isolatedDatabase(base,'r4nativecorr'),db=new Ledger(database.url),area=await mkdtemp('/tmp/ac-r4-native-correction-');
 let runtime:CezarRuntime|undefined,resources:FlowResourceEnvelope|undefined,heartbeat:ReturnType<typeof setInterval>|undefined,primary:unknown;
 try{
  installGraphAllocator();await db.migrate();resources=await provisionFlowResources(area,image);await assertFlowResourceLimits(resources);
  const project=randomUUID(),principal='r4-correction-'+randomUUID(),repo=join(area,'repo'),spool=join(area,'execution'),homes=join(area,'homes'),qaRoot=join(area,'qa');
  for(const path of [spool,homes,qaRoot])await mkdir(path,{mode:0o700});
  execFileSync('git',['init','-q','-b','main',repo]);await chmod(repo,0o700);await chmod(join(repo,'.git'),0o700);
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();git('config','user.name','Correction lab');git('config','user.email','lab@example.invalid');
  await mkdir(join(repo,'src'),{mode:0o700});await writeFile(join(repo,'src/.gitkeep'),'');git('add','.');git('commit','-qm','base');const original=git('rev-parse','HEAD');git('branch','protected');
  await mkdir(join(repo,'.ai/cezar'),{recursive:true});await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[],worktreeRetention:0}));
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,label]);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);await db.pool.query('INSERT INTO ac_project_repositories VALUES($1,$2)',[project,repo]);
  const {revision,options}=await provisionEngineering(db,principal,project,repo),capacity=new Capacity(db),context=await db.createContext(principal,project,randomUUID());await capacity.assignPolicy(principal,context,revision);
  const account=(await db.pool.query('SELECT account_id FROM ac_account_access WHERE project_id=$1',[project])).rows[0].account_id as string,subject='c'.repeat(64);
  await db.pool.query('UPDATE ac_accounts SET resource_identity=$2 WHERE id=$1',[account,'synthetic-engineering:'+subject]);await new AccountHomes(db,homes,[repo]).initialize(principal,project,account);
  const capability=await authorizeNativeSyntheticFixture({contract:'native-synthetic-fixture-v1',projectId:project,contextId:context,provider:'synthetic-engineering',label,workerImage:image,toolsImage:image,providerNetworkId:network});
  const signing=generateKeyPairSync('ed25519'),supervisor=new NativeExecutionSupervisor(db,{id:'r4-correction-execution',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:homes,repository:repo,protectedRepositories:[],signingKeyPem:signing.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:network,accountSubjects:[{accountId:account,subjectDigest:subject}],workerEnv:['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','NODE_VERSION=22.23.3','YARN_VERSION=1.22.22'],toolsEnv:['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','NODE_VERSION=22.23.3','YARN_VERSION=1.22.22'],syntheticFixture:capability,resourceEnvelope:resources});
  await new ProviderEligibility(db).publish(principal,project,{accountId:account,expectedRevision:0,plan:'deterministic correction lab',adapterId:'r4-correction-execution',adapterVersion:supervisor.executorDigest,authenticationMode:'synthetic',executionMode:'synthetic',sourceURL:'https://example.invalid/r4-correction',status:'documented_supported',reason:'Disposable deterministic test',reviewedAt:new Date().toISOString(),validForSeconds:3600});
  const profiles=(await db.pool.query('SELECT model FROM ac_profiles WHERE account_id=$1',[account])).rows;for(const profile of profiles)await capacity.observeModelQuota(principal,account,profile.model,{status:'available',source:'synthetic://r4-correction',ttlSeconds:3600});
  const qaCode="const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');const box={module:{exports:{}}};vm.runInNewContext(fs.readFileSync('/work/src/sum.ts','utf8'),box);const actual=box.module.exports(2,3);console.log('T21_REPRO sum(2,3)='+actual+' expected=5');assert.equal(actual,5,'reproducible sum defect');";
  const qaContract=NativeQaContract.parse({schemaVersion:1,id:'r4-correction-qa',image,argv:['/usr/local/bin/node','-e',qaCode],environment:['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','NODE_VERSION=22.23.3','YARN_VERSION=1.22.22','HOME=/tmp'],timeoutMs:15000,memoryBytes:268435456,pids:64,nanoCpus:1000000000});
  const qualityRevision=await options.quality.publish(principal,project,1,{schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:false,requireJudge:false,verifierDigest:nativeReviewVerifierDigest,qaVerifierDigest:nativeQaContractDigest(qaContract)});
  await new Templates(db).publish(principal,context,0,{workflow:'engineering-native-v1',qualityRevision,targetRef:'refs/heads/protected',writePaths:['src'],execution:'plan'});
  const authority=await db.acquire(principal,context,randomUUID(),'r4-correction-manager',60);heartbeat=setInterval(()=>{void db.heartbeat(authority).catch(()=>{});},2000);
  const human=generateKeyPairSync('ed25519'),deviceId=randomUUID();await new Operators(db).enroll('synthetic-engineering-admin',principal,deviceId,human.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const environment={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.environments.configure' as const,payload:{projectId:project,expectedRevision:0,config:{sourceBranch:'refs/heads/main',environments:[{id:'lab',label:'Correction lab',targetRef:'refs/heads/protected',authorizedDirectories:['src'],destinations:[{id:'local',label:'Local',kind:'local_repository' as const}]}]}}};
  const installation=(await db.pool.query('SELECT id FROM ac_installation_identity')).rows[0].id,p={deviceId,expiresAt:Date.now()+120000};await new ProjectEnvironments(db,[{id:'lab',path:area}],join(area,'private')).configure(principal,environment,{...p,signature:sign(null,Buffer.from(operatorMessage(principal,environment,p,installation)),human.privateKey).toString('hex')});
  const nativeQa=new NativeQa(db,options.quality,repo,qaRoot,qaContract,options.verifierKey,undefined,undefined,resources),nativeImplementation=new NativeImplementation(db,repo,options.quality,[supervisor]),nativeVerification=new NativeVerification(db,options.quality,[supervisor],options.verifierKey);
  runtime=new CezarRuntime(db,repo,project,{...options,nativeQa,nativeVerification,allowedTargets:['refs/heads/protected']},undefined,undefined,{nativeExecutions:[supervisor],nativeImplementation});await runtime.start();
  const plan={schemaVersion:1 as const,contextId:context,objectiveRef:'message:sum',sourceMessageRef:'message:sum',parallelism:1,constraintRefs:[],tasks:[{id:'sum',objectiveRef:'message:sum',acceptanceRefs:['acceptance:sum-2-3-is-5'],inputRefs:[],outputRefs:['output:sum'],dependsOn:[],writePaths:['src/sum.ts'],qualityRevision,targetRef:'refs/heads/protected',maxCorrections:1}]};
  const proposal=await new ManagerPlans(db).publish(principal,authority,0,plan),intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:revision,action:'plan.start',payload:{workflow:'managed-synthetic-v1',messageRef:'message:sum',proposalRevision:proposal.revision,proposalDigest:proposal.digest,native:true}},authority,'api');
  const frozen=(await db.pool.query('SELECT recipe,recipe_digest FROM ac_managed_executions WHERE parent_intent_id=$1',[intent.id])).rows[0];assert.equal(frozen.recipe.schemaVersion,4);assert.equal(digest(frozen.recipe),frozen.recipe_digest);
  await runtime.dispatch(intent,authority);const deadline=Date.now()+120000;
  while(!['done','failed'].includes(runtime.store.getRun(intent.run_id)?.status??'')){if(Date.now()>deadline)throw Error('T21_GRAPH_TIMEOUT '+JSON.stringify(runtime.store.getRun(intent.run_id)?.error));await new Promise(resolve=>setTimeout(resolve,250));}
  assert.equal(runtime.store.getRun(intent.run_id)?.status,'failed');
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_artifacts a JOIN ac_intents i ON i.id=a.intent_id WHERE i.parent_intent_id=$1',[intent.id])).rows[0].n,0);
  assert.equal(git('rev-parse','protected'),original);
  const job=(await db.pool.query("SELECT j.*,o.receipt operation_receipt FROM ac_native_execution_jobs j JOIN ac_intents i ON i.id=j.intent_id JOIN ac_operations o ON o.id=j.id WHERE i.parent_intent_id=$1 AND j.role='programmer'",[intent.id])).rows[0];assert(job);assert.equal(job.state,'completed');
  const sourceRepo=join(spool,job.id,'work'),candidate=job.operation_receipt.commit,token=(await readFile(join(spool,job.id,'worker-token'),'utf8')).trim();assert(candidate);assert(token.length>=32);
  const candidateBytes=execFileSync('git',['-C',sourceRepo,'show',candidate+':src/sum.ts']);assert(candidateBytes.includes(Buffer.from(token)),'NEGATIVE_ARTIFACT_MUST_REALLY_CONTAIN_CANARY');
  const retirement=(await db.pool.query('SELECT state FROM ac_native_writer_retirements WHERE job_id=$1',[job.id])).rows[0];assert.equal(retirement?.state,'revoked');
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_capacity_grants WHERE context_id=$1 AND state<>'released'",[context])).rows[0].n,0);
  console.log('R5_ARTIFACT_SECRET_PROOF '+JSON.stringify({nativeProgrammer:true,syntheticInference:true,actualCanaryInGitObject:true,registeredArtifacts:0,targetUnchanged:true,writerRetired:true,activeGrants:0,secretPrinted:false}));

 }catch(error){primary=error;throw error;}
 finally{
  if(heartbeat)clearInterval(heartbeat);const errors:{phase:string;error:unknown}[]=[];
  const attempt=async(phase:string,action:()=>Promise<unknown>|unknown)=>{try{await action();}catch(error){errors.push({phase,error});}};
  await attempt('runtime',()=>runtime?.close());await attempt('graph',()=>cleanupGraphResources(db,image));
  if(resources)await attempt('resource-authority',()=>retireFlowResources(resources!,area));
  await attempt('mocks',()=>mock.restoreAll());await attempt('ledger',()=>db.close());await attempt('database',()=>database.close());await attempt('directory',()=>rm(area,{recursive:true,force:true}));
  if(errors.length&&!primary)throw new AggregateError(errors.map(item=>item.error),'T21_FIXTURE_CLEANUP_FAILED');
  if(errors.length&&primary)console.error('T21_CLEANUP_FAILED_AFTER_PRIMARY '+JSON.stringify(errors.map(item=>({phase:item.phase,error:item.error instanceof Error?item.error.name:'UNKNOWN'}))));
 }
});
