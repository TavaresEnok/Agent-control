import {test,mock} from 'node:test';
import {ProviderEligibility} from '../src/provider-eligibility.ts';
import {AccountHomes} from '../src/account-homes.ts';
import assert from 'node:assert/strict';
import {createHash,createHmac,generateKeyPairSync,randomBytes,randomUUID,verify} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {NativeImplementation} from '../src/native-implementation.ts';
import {NativeExecutionSupervisor,NativeExecutionRequest} from '../src/native-execution-supervisor.ts';
import {NativeVerification,nativeReviewVerifierDigest} from '../src/native-verification.ts';
import type {NativeQa} from '../src/native-qa.ts';
import {Templates} from '../src/templates.ts';
import {ProjectTemplates} from '../src/project-templates.ts';
import {authorizeExplicitQaWaiver} from '../src/quality.ts';
import {DockerDaemon} from '../src/sandbox-broker.ts';
import {canonical,digest,Refusal} from '../src/contracts.ts';
import {ManagerPlans,type ManagerPlan} from '../src/planning.ts';
import {engineeringNativePlanWorkflowPrefix} from '../src/workflows.ts';
import {executionRecipe,nativeExecutionRecipe,nativeManagedTaskText,ManagedRecipe} from '../src/managed-plan.ts';
import {VerificationReceipt} from '../src/quality.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {claimWorktreeWriter} from '../src/worktree-lease.ts';
import {provisionEngineering} from './fixtures/provision-engineering.ts';

/** PostgreSQL and Ruby come from deploy/compose.lab.yml. This file does not
 * download binaries, start pg_ctl, or bind another interpreter over /usr/bin/ruby. */
const labDatabase=process.env.AC_TEST_DATABASE_URL;
const labReady=Boolean(labDatabase&&existsSync('/usr/bin/ruby')&&process.env.AC_TEAM_GRAPH_IMAGE&&process.env.AC_TEAM_GRAPH_NETWORK);
const labSkip=labReady?false:'AC_TEST_DATABASE_URL and /usr/bin/ruby from deploy/compose.lab.yml are required';

const policyBody={schemaVersion:1 as const,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:false,verifierDigest:'ab'.repeat(32)};
function task(id:string,dependsOn:string[]=[],writePaths=[`src/${id}/a.ts`,`src/${id}/b.ts`],acceptanceRefs=['acceptance:real-tests']){
 return {id,objectiveRef:`message:${id}`,acceptanceRefs,inputRefs:[],outputRefs:[`output:${id}`],dependsOn,writePaths,qualityRevision:1,targetRef:'refs/heads/protected',maxCorrections:0};
}
function plan(contextId:string,tasks:ReturnType<typeof task>[]):ManagerPlan{
 return {schemaVersion:1,contextId,objectiveRef:'message:objective',sourceMessageRef:'message:request',parallelism:4,constraintRefs:[],tasks};
}

for(const waiverMode of ['disabled'] as const) test(`synthetic physical native graph ${waiverMode}`,{timeout:180000,skip:labSkip},async()=>{
 const waiverEnabled=waiverMode!=='disabled';
 const baseUrl=labDatabase;if(!baseUrl)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(baseUrl,'nativemulti'),db=new Ledger(fixture.url);
 const physicalMode=process.env.AC_NATIVE_RETIREMENT_PHYSICAL==='1';
 const physicalRoot=process.env.AC_NATIVE_RETIREMENT_ROOT;
 if(physicalMode&&(!physicalRoot||!physicalRoot.endsWith('/.state/native-dispatch-physical')))throw Error('ISOLATED_NATIVE_RETIREMENT_ROOT_REQUIRED');
 const area=await mkdtemp(join(physicalMode?physicalRoot!:tmpdir(),'native-multi-'));
 let runtime:CezarRuntime|undefined,heartbeat:ReturnType<typeof setInterval>|undefined;
 try{
  await db.migrate();
  const project=randomUUID(),principal='native-multi-'+randomUUID();
  const repo=join(area,'repo'),spool=join(area,'native'),accounts=join(area,'accounts');
  for(const path of [spool,accounts])await mkdir(path,{mode:0o700});
  execFileSync('git',['init','-q','-b','main',repo],{stdio:'ignore'});
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  git('config','user.name','Fixture');git('config','user.email','fixture@invalid');
  await mkdir(join(repo,'src'));await writeFile(join(repo,'src/.gitkeep'),'');
  git('add','.');git('commit','-qm','base');const original=git('rev-parse','HEAD');git('update-ref','refs/heads/protected',original);
  await mkdir(join(repo,'.ai/cezar'),{recursive:true});
  await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[],worktreeRetention:0}));
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'native multitask']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
  const {revision,options}=await provisionEngineering(db,principal,project,repo,1,false,false);
  const qaDigest=createHash('sha256').update('native-multitask-qa-substitute-v1').digest('hex');
  const qualityRevision=await options.quality.publish(principal,project,1,{schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:waiverEnabled,requireHumanIntegration:false,verifierDigest:nativeReviewVerifierDigest,qaVerifierDigest:qaDigest});
  assert.equal(qualityRevision,2);
  const context=await db.createContext(principal,project,randomUUID());
  await new Capacity(db).assignPolicy(principal,context,revision);
  const authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  const template={workflow:'engineering-native-v1' as const,qualityRevision,targetRef:'refs/heads/protected',writePaths:['src'],execution:'plan' as const};
  if(waiverEnabled){
   const templateId=randomUUID(),catalog=new ProjectTemplates(db);
   await catalog.publish(principal,context,{templateId,expectedRevision:0,name:'Fluxo com dispensa',template,digest:digest(template)});
   await catalog.apply(principal,context,{templateId,revision:1,expectedRevision:1,expectedContextRevision:0});
   const authorize=(id:string)=>db.tx(c=>authorizeExplicitQaWaiver(c,principal,context,{policyRevision:qualityRevision,templateId:id,templateRevision:1,taskId:'alpha',riskRule:'explicit-low'}));
   if(waiverMode==='valid'||waiverMode==='ambiguous')await authorize(templateId);
   if(waiverMode==='mismatch'||waiverMode==='ambiguous'){
    const otherId=randomUUID();
    await catalog.publish(principal,context,{templateId:otherId,expectedRevision:0,name:'Outro fluxo',template,digest:digest(template)});
    await authorize(otherId);
   }
  }else await new Templates(db).publish(principal,context,0,template);
  const account=(await db.pool.query('SELECT account_id AS id FROM ac_account_access WHERE project_id=$1',[project])).rows[0].id as string;
  const keys=generateKeyPairSync('ed25519'),modelImage=process.env.AC_TEAM_GRAPH_IMAGE!;if(!/^sha256:[a-f0-9]{64}$/.test(modelImage))throw Error('SYNTHETIC_IMAGE_REQUIRED');
  const supervisorConfig={id:'fixture-model-native',workerImage:modelImage,toolsImage:modelImage,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:process.env.AC_TEAM_GRAPH_NETWORK!,accountSubjects:[{accountId:account,subjectDigest:'c'.repeat(64)}],workerEnv:['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','NODE_VERSION=22.23.3','YARN_VERSION=1.22.22'],toolsEnv:['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','NODE_VERSION=22.23.3','YARN_VERSION=1.22.22']};
  await mkdir(join(accounts,account),{mode:0o700});
  const providerNetwork=JSON.parse(execFileSync('docker',['network','inspect',supervisorConfig.providerNetworkId],{encoding:'utf8'}))[0];assert.equal(providerNetwork.Internal,true);assert.equal(providerNetwork.Labels['agent-control.fixture'],'ac-team-20261105-graph');
  const supervisor=new NativeExecutionSupervisor(db,supervisorConfig);
  if(process.env.AC_NATIVE_RETIREMENT_CRASH==='1'){
   const marker=process.env.AC_NATIVE_RETIREMENT_MARKER;
   if(!physicalMode||!marker||dirname(marker)!==physicalRoot||!/^native-crash-[a-z0-9-]+\.json$/.test(marker.split('/').at(-1)!))throw Error('ISOLATED_NATIVE_CRASH_MARKER_REQUIRED');
   await writeFile(marker,JSON.stringify({url:fixture.url,principal,context,authority,supervisorConfig}),{mode:0o600,flag:'wx'});
  }
  // The database is disposable and contains synthetic identity metadata only.
  await db.pool.query('ALTER TABLE ac_accounts DISABLE TRIGGER ac_dormant_provider_mode_guard');
  await db.pool.query('ALTER TABLE ac_accounts DROP CONSTRAINT ac_accounts_dormant_check');
  await db.pool.query("UPDATE ac_accounts SET provider='codex',mode='subscription_cli',resource_identity=$2 WHERE id=$1",[account,'codex:'+'c'.repeat(64)]);
  await db.pool.query(`INSERT INTO ac_provider_eligibility_assessments(account_id,revision,project_id,principal_id,request_digest,request_snapshot,provider,account_mode,plan,adapter_id,adapter_version,authentication_mode,execution_mode,source_url,status,reason,reviewed_at,valid_for_seconds,expires_at)
   VALUES($1,1,$2,$3,$4,'{}','codex','subscription_cli','fixture',$5,$6,'subscription_oauth','central_isolated_cli','https://example.invalid/fixture','documented_supported','synthetic fixture',now(),3600,now()+interval '3600 seconds')`,[account,project,principal,'a'.repeat(64),supervisorConfig.id,supervisor.executorDigest]);
  mock.method(ProviderEligibility.prototype,'view',async()=>({accountId:account,latest:{fresh:true,effectiveStatus:'documented_supported',provider:'codex',authenticationMode:'subscription_oauth',executionMode:'central_isolated_cli',adapterId:supervisorConfig.id,adapterVersion:supervisor.executorDigest,revision:1},history:[]}));
  mock.method(AccountHomes.prototype,'inspectGranted',async()=>({accountId:account,projectId:project,ownerId:principal,uid:'1',device:'1',inode:'1'}));
  const reserve=Capacity.prototype.reserve;let turn=Promise.resolve();
  mock.method(Capacity.prototype,'reserve',async function(this:Capacity,...args:Parameters<Capacity['reserve']>){
   let release!:()=>void;const previous=turn;turn=new Promise<void>(resolve=>{release=resolve;});await previous;
   try{await db.pool.query("UPDATE ac_accounts SET mode='synthetic' WHERE id=$1",[account]);return await reserve.apply(this,args);}
   finally{await db.pool.query("UPDATE ac_accounts SET mode='subscription_cli' WHERE id=$1",[account]);release();}
  });
  const nativeQa={ledger:db,quality:options.quality,verifierDigest:qaDigest,reconcileContext:async()=>{},async run(owner:string,intent:{id:string;context_id:string},a:typeof authority,stage:{id:string;session_id:string},grantId:string,artifact:{id:string;policy_revision:number;commit_id:string;tree_id:string;base_id:string}){
   const receipt=VerificationReceipt.parse({schemaVersion:1,id:randomUUID(),artifactId:artifact.id,kind:'qa',sessionId:stage.session_id,grantId,policyRevision:artifact.policy_revision,commit:artifact.commit_id,tree:artifact.tree_id,base:artifact.base_id,status:'passed',exitCode:0,verifierDigest:qaDigest,logSha256:createHash('sha256').update('substitute-pass').digest('hex'),commandDigest:digest({executor:'native-multitask-qa-substitute-v1'}),verifierVersion:'native-multitask-qa-substitute-v1'});
   const signature=createHmac('sha256',options.verifierKey).update(canonical(receipt)).digest('hex');
   const physicalReceipt={state:'exited',exitCode:0,source:'native-multitask-qa-substitute'};
   await db.tx(async c=>{await db.authorize(c,owner,a.contextId);await db.fence(c,a,true);
    const released=await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1 AND state='reserved' AND role='qa' RETURNING id",[grantId,physicalReceipt]);
    if(!released.rowCount)throw new Refusal('GRANT_RECONCILIATION_REQUIRED');
    await c.query("UPDATE ac_stage_operations SET state='completed',receipt=$2,finished_at=clock_timestamp() WHERE id=$1",[stage.id,{verification:receipt,signature}]);
   });
   await options.quality.record(owner,receipt,signature,a);return receipt;
  }} as unknown as NativeQa;
  const retire=supervisor.retireManagedWriter.bind(supervisor);supervisor.retireManagedWriter=async (...args)=>{const result=await retire(...args);const row=(await db.pool.query('SELECT network_id FROM ac_native_execution_jobs WHERE id=$1',[args[2]])).rows[0];if(row?.network_id){const inspect=JSON.parse(execFileSync('docker',['network','inspect',row.network_id],{encoding:'utf8'}))[0];assert.equal(inspect.Labels['agent-control.job'],args[2]);assert.equal(Object.keys(inspect.Containers??{}).length,0);execFileSync('docker',['network','rm',row.network_id]);}return result;};
  const realStart=supervisor.start.bind(supervisor);supervisor.start=async (...args)=>{try{return await realStart(...args);}catch(error){console.error('REAL_START_FAILED',error);throw error;}};
  const native=new NativeImplementation(db,repo,options.quality,[supervisor]);
  const nativeVerification=new NativeVerification(db,options.quality,[supervisor],options.verifierKey);
  runtime=new CezarRuntime(db,repo,project,{...options,allowedTargets:['refs/heads/protected'],nativeQa,nativeVerification},undefined,undefined,{nativeExecutions:[supervisor],nativeImplementation:native});
  await runtime.start();heartbeat=setInterval(()=>{void db.heartbeat(authority).catch(()=>{});},5000);
  const proposal=await new ManagerPlans(db).publish(principal,authority,0,plan(context,[
   {...task('alpha'),qualityRevision},
  ]));
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'managed-synthetic-v1',messageRef:'encrypted:fixture',proposalRevision:proposal.revision,proposalDigest:proposal.digest,native:true}},authority,'api');
  await runtime.dispatch(intent,authority);
  let done=false,failure='';
  for(let i=0;i<200;i++){
   const run=runtime.store.getRun(intent.run_id);
   if(run?.status==='failed'){failure=JSON.stringify({error:run.error,steps:run.steps.map(step=>({id:step.id,status:step.status,error:step.error}))});break;}
   if(run?.status==='done'){done=true;break;}
   await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.equal(failure,'');assert(done,'NATIVE_MULTITASK_NOT_COMPLETE');
  await runtime.observe(intent,authority);
  const children=(await db.pool.query('SELECT i.parent_unit_id,i.id,o.receipt,o.state,o.native_session_id,o.grant_id FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id WHERE i.parent_intent_id=$1',[intent.id])).rows;
  assert.equal(children.length,1);assert(children.every(row=>row.state==='completed'));
  const retired=(await db.pool.query('SELECT * FROM ac_worktree_writers WHERE parent_intent_id=$1',[intent.id])).rows;
  assert.equal(retired.length,1);
  assert(retired.every(row=>row.state==='neutralized'));
  const jobs=(await db.pool.query('SELECT id,role,state,receipt FROM ac_native_execution_jobs ORDER BY role')).rows;assert.deepEqual(jobs.map(j=>j.role),['programmer','reviewer']);assert(jobs.every(j=>j.state==='completed'&&j.receipt));
  console.log(JSON.stringify({fixture:'synthetic-native-graph',jobs:jobs.map(j=>({id:j.id,role:j.role})),writer:'neutralized',modelCalls:0,capacity:'substituted',qa:'substituted',recovery:'not exercised'}));
  const target=git('rev-parse','refs/heads/protected');assert.notEqual(target,original);
 }finally{mock.restoreAll();if(heartbeat)clearInterval(heartbeat);await runtime?.close();
  for(const job of (await db.pool.query("SELECT id,worker_id,tools_id,network_id FROM ac_native_execution_jobs")).rows){for(const id of [job.worker_id,job.tools_id])if(id){try{const info=JSON.parse(execFileSync('docker',['inspect',id],{encoding:'utf8',stdio:['ignore','pipe','ignore']}))[0];if(info.Config.Labels?.['agent-control.job']===job.id&&info.Image===process.env.AC_TEAM_GRAPH_IMAGE)execFileSync('docker',['rm','-f',id],{stdio:'ignore'});}catch{}}if(job.network_id){try{const info=JSON.parse(execFileSync('docker',['network','inspect',job.network_id],{encoding:'utf8',stdio:['ignore','pipe','ignore']}))[0];if(info.Labels?.['agent-control.job']===job.id&&Object.keys(info.Containers??{}).length===0)execFileSync('docker',['network','rm',job.network_id],{stdio:'ignore'});}catch{}}}
  await db.close();await fixture.close();await rm(area,{recursive:true,force:true});}
});
