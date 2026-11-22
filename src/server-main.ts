import {useDockerFilterSocket} from './docker-env.ts';
import {installationVolumes} from './personal-disk.ts';
// Configured administration gateway. Native adapters stay disabled unless a
// discriminated opt-in is valid. Configured opt-in does not activate accounts
// or inference. Bench mode is refused here because it requires injected substitutes.
import {serve} from '@hono/node-server';
import {z} from 'zod';
import {join} from 'node:path';
import {Installation,readPrivateFile,loadInstallation,sessionKey,initializeInstallation,prepareInstallationOperator,privateDirectory,syncInstallationActivation} from './installation.ts';
import {Refusal} from './contracts.ts';
import {Ledger} from './ledger.ts';
import {Projects,ProjectRuntimes} from './projects.ts';
import {createProjectGateway} from './projects-api.ts';
import {BrowserSessions} from './sessions.ts';
import {ProjectAdmin} from './project-admin.ts';
import {ProjectEnvironments} from './project-environments.ts';
import {createProjectEnvironmentApi} from './project-environments-api.ts';
import {WorkflowGraphs} from './workflow-graph-service.ts';
import {createWorkflowGraphApi} from './workflow-graph-api.ts';
import {createProjectAdminApi} from './project-admin-api.ts';
import {InstallationAuthority} from './installation-authority.ts';
import {createInstallationAuthorityApi} from './installation-authority-api.ts';
import {remoteReturnTransport} from './remote-return-config.ts';
import {configuredRemoteDevelopment} from './remote-development-config.ts';
import {prepareWorkflowRuntimeRegistration,startWorkflowRuntimeRegistration} from './workflow-runtime-bootstrap.ts';
import {Control} from './control.ts';
import {bootstrapRecoveryInventory} from './recovery-bootstrap.ts';
import {nativeReviewVerifierDigest} from './native-verification.ts';
import {managerEconomyOf} from './manager-discipline.ts';
import {startConfiguredManagerTransport} from './manager-transport.ts';
import type {ManagerRegistry} from './managers.ts';
/** The primary project keeps today's active-bootstrap gate. Any other project
 * stays administration-only until it has a conversation and a policy, and a miss does not stop its siblings. */
async function personalProjectMayExecute(ledger:Ledger,projectId:string,primary:boolean){
 if(primary)return true;
 const ready=await ledger.pool.query(`SELECT 1 FROM ac_project_repositories r WHERE r.project_id=$1
  AND EXISTS (SELECT 1 FROM ac_contexts x WHERE x.project_id=r.project_id AND NOT x.archived)
  AND (EXISTS (SELECT 1 FROM ac_policy_revisions p WHERE p.project_id=r.project_id)
    OR EXISTS (SELECT 1 FROM ac_quality_policies q WHERE q.project_id=r.project_id))`,[projectId]);
 return Boolean(ready.rowCount);
}
async function main(){
 // AC_DOCKER_SOCKET: the API client and every Docker CLI child go through the filter (src/docker-filter.ts).
 useDockerFilterSocket();
 const [command,path,...extra]=process.argv.slice(2);
 // Retention planning must be dispatched before any installation file is opened.
 if(command==='retention-plan'){
  const {executeRetentionPlan}=await import('./retention-cli.ts');
  const result=await executeRetentionPlan(path,extra);
  if(result.exitCode===1){console.error(result.code);process.exitCode=1;return;}
  console.log(JSON.stringify(result.plan));
  process.exitCode=result.exitCode;
  return;
 }
 if(command==='account-add'){
  const [provider,label,flag,authFile]=extra;
  if(!path||!provider||!label||(flag!==undefined&&flag!=='--auth-file')||(flag==='--auth-file'&&!authFile)||extra.length>(flag?4:2))throw Error('INVALID_INSTALLATION_COMMAND');
  const config=await loadInstallation(path);
  const ledger=new Ledger(config.databaseUrl,config.installationAuthority?.token);
  try{const {addProviderAccount}=await import('./account-add.ts');console.log(JSON.stringify(await addProviderAccount(config,ledger,{provider,label,authFile})));}
  finally{await ledger.close();}
  return;
 }
 if(command==='pair'){
  if(!path||extra.length)throw Error('INVALID_INSTALLATION_COMMAND');
  const config=await loadInstallation(path);
  if(config.activation!=='personal')throw Error('PERSONAL_ACTIVATION_REQUIRED');
  const {createPairCode}=await import('./personal-pair.ts');
  const issued=await createPairCode(config.dataDirectory);
  console.log(issued.code);
  console.log('Válido até '+new Date(issued.expiresAt).toISOString());
  return;
 }
 if(command==='password'){
  const remove=extra.includes('--remove');
  const args=extra.filter(item=>item!=='--remove');
  if(!path||extra.some(item=>item.startsWith('--')&&item!=='--remove')||(remove?args.length>1:args.length!==1))throw Error('INVALID_INSTALLATION_COMMAND');
  const config=await loadInstallation(path);
  if(config.activation!=='personal')throw Error('PERSONAL_ACTIVATION_REQUIRED');
  const {promptPanelPassword,removePanelLogin,savePanelLogin}=await import('./personal-password.ts');
  if(remove){await removePanelLogin(config.dataDirectory);console.log('Credencial apagada.');return;}
  const user=args[0]!.trim().toLowerCase();
  if(!/^[a-z0-9._-]{3,40}$/.test(user))throw Error('INVALID_PANEL_USER');
  const password=await promptPanelPassword();
  const saved=await savePanelLogin(config.dataDirectory,user,password);
  console.log('Senha gravada para '+saved.user+'.');
  return;
 }
 if(command==='personal-connect'){
  // "--local" is still accepted from older scripts; the conversation is always local now.
  if(!path||extra.some(item=>item!=='--local'))throw Error('INVALID_INSTALLATION_COMMAND');
  const {personalConnect}=await import('./personal-connect.ts');console.log(JSON.stringify(await personalConnect(path)));return;
 }
 if(command==='say'||command==='chat-log'){
  if(!path||(command==='say'?extra.length<1||extra.length>2:extra.length>1))throw Error('INVALID_INSTALLATION_COMMAND');
  const {personalSay}=await import('./personal-connect.ts');await personalSay(path,command==='say'?extra[0]:undefined,command==='say'?(extra[1]?Number(extra[1]):undefined):(extra[0]?Number(extra[0]):undefined));return;
 }
 if(command==='native-setup'){
  if(!path||extra.length)throw Error('INVALID_INSTALLATION_COMMAND');
  const {nativeSetup}=await import('./native-setup.ts');
  console.log(JSON.stringify(await nativeSetup(path)));
  return;
 }
 // Retention dry-run. One private descriptor. No installation, ledger, vault, provider CLI, or deletion.
 // Rotation apply never opens the installation, the ledger or the descriptor's key bytes.
 // Usage: context-key-rotate-apply <descriptor> [--confirm-apply]
 if(command==='context-key-rotate-apply'){
  const confirm=extra[0]==='--confirm-apply';
  if(!path||extra.length!==(confirm?1:0))throw Error('INVALID_INSTALLATION_COMMAND');
  const {executeContextKeyRotateApply}=await import('./context-vault-cli.ts');
  const result=await executeContextKeyRotateApply(path,confirm);
  if(result.exitCode===1){console.error(result.code);process.exitCode=1;return;}
  console.log(JSON.stringify(result.report));
  process.exitCode=result.exitCode;
  return;
 }
 const descriptorCommands=['context-key-authorize','context-key-import','context-key-rotate-plan','vault-backup','vault-restore','provider-home-initialize','provider-home-inspect','config-export','config-read','recovery'];
 const descriptorCommand=descriptorCommands.includes(command);
 if(!path||!(descriptorCommand||['initialize','inspect','operator-bootstrap','serve','vault-initialize'].includes(command))||extra.length!==(descriptorCommand?1:0))throw Error('INVALID_INSTALLATION_COMMAND');
 // Inventory dry-run. The installation path is not opened. No ledger and no vault.
 if(command==='context-key-rotate-plan'){
  const {executeContextKeyRotatePlan}=await import('./context-vault-cli.ts');
  const result=await executeContextKeyRotatePlan(extra[0]!);
  if(result.exitCode===1){console.error(result.code);process.exitCode=1;return;}
  console.log(JSON.stringify(result.plan));
  process.exitCode=result.exitCode;
  return;
 }
 // Inspection must be able to report a missing root rather than abort before
 // its read-only checks. The private file and config schema remain mandatory.
 const config=command==='inspect'?Installation.parse(JSON.parse((await readPrivateFile(path)).toString('utf8'))):await loadInstallation(path);
 const localWorkflowRuntime=command==='serve'?await prepareWorkflowRuntimeRegistration(config.workflowRuntime):undefined;
 const ledger=new Ledger(config.databaseUrl,config.installationAuthority?.token,localWorkflowRuntime?.identity,installationVolumes(config));
 let workflowRegistration:Awaited<ReturnType<typeof startWorkflowRuntimeRegistration>>|undefined;
 const managerTransports=new Map<string,ManagerRegistry>();
 const configurationControls=new Map<string,Control>();
 const closeManagers=async()=>{const results=await Promise.allSettled([...managerTransports.values()].map(registry=>registry.close()));managerTransports.clear();if(results.some(result=>result.status==='rejected'))throw Error('MANAGER_TRANSPORT_SHUTDOWN_FAILED');};
 let bootstrapSession:{shutdown():Promise<unknown>}|undefined;
 let bootstrapReport:{state:string;executionEnabled:boolean;inferenceEnabled:boolean}|undefined;
 const shutdownBootstrap=async()=>{await bootstrapSession?.shutdown();};
 let runtimes:ProjectRuntimes|undefined,serving=false,stopAbandonedVerifyRuns=()=>{};
 const shutdownAbort=new AbortController();
 try{
  if(command==='inspect'){
   const {inspectInstallationReadiness}=await import('./installation-readiness.ts');
   const report=await inspectInstallationReadiness(ledger,config);
   console.log(JSON.stringify(report));
   if(report.checks.some(check=>check.status!=='ok'))process.exitCode=2;
   return;
  }
  if(command==='initialize'){console.log(JSON.stringify(await initializeInstallation(config,ledger)));return;}
  if(command==='operator-bootstrap'){console.log(JSON.stringify(await prepareInstallationOperator(config,ledger)));return;}
  if(command==='recovery'){
   const {executeRecoveryCommand}=await import('./recovery-cli.ts');
   console.log(JSON.stringify(await executeRecoveryCommand(config,ledger,extra[0]!)));return;
  }
  if(command==='config-export'||command==='config-read'){
   const {executeConfigExport,executeConfigRead}=await import('./config-export-cli.ts');
   console.log(JSON.stringify(await (command==='config-export'?executeConfigExport(config,ledger,extra[0]!):executeConfigRead(config,ledger,extra[0]!))));return;
  }
  if(command==='provider-home-initialize'||command==='provider-home-inspect'){
   const {executeAccountHome}=await import('./account-homes-cli.ts');console.log(JSON.stringify(await executeAccountHome(command,config,ledger,extra[0])));return;
  }
  if(command==='vault-initialize'){const {initializeContextVault}=await import('./context-vault-cli.ts');console.log(JSON.stringify(await initializeContextVault(config,ledger)));return;}
  if(command==='context-key-authorize'||command==='context-key-import'){
   const {executeContextKey}=await import('./context-vault-cli.ts');console.log(JSON.stringify(await executeContextKey(command,config,ledger,extra[0])));return;
  }
  if(command==='vault-backup'||command==='vault-restore'){
   const {executeVaultBackup}=await import('./context-vault-cli.ts');console.log(JSON.stringify(await executeVaultBackup(command,config,ledger,extra[0])));return;
  }
  // Attach the pre-provisioned recovery inventory before starting any runtime.
  await bootstrapRecoveryInventory(ledger,config.recoveryInventory);
  // Serving does not silently migrate schemas or create projects/credentials.
  const registered=(await ledger.pool.query("SELECT 1 FROM ac_projects p JOIN ac_memberships m ON m.project_id=p.id JOIN ac_project_repositories r ON r.project_id=p.id WHERE p.id=$1 AND m.principal_id=$2 AND m.role='owner' AND r.repo=$3",[config.project.id,config.project.owner,config.project.repo])).rowCount;
  if(!registered)throw Error('INSTALLATION_NOT_INITIALIZED');
  await syncInstallationActivation(ledger,config.activation);
  if(localWorkflowRuntime)workflowRegistration=await startWorkflowRuntimeRegistration(ledger,localWorkflowRuntime,[config.project,...config.projects],()=>console.error('WORKFLOW_RUNTIME_REGISTRATION_UNAVAILABLE'));
  const {prepareNativeBootstrap,nativeBootstrapRuntimeAttachment}=await import('./native-bootstrap.ts');
  const prepared=await prepareNativeBootstrap(config,{query:(sql,params)=>ledger.pool.query(sql,params as never[])});
  bootstrapSession=prepared.session;bootstrapReport=prepared.report;
  if(prepared.report.state!=='active'&&(prepared.report.executionEnabled||prepared.report.inferenceEnabled||prepared.report.realAccountsEnabled))throw Error('NATIVE_BOOTSTRAP_ACTIVATION_BLOCKED');
  if(prepared.report.state==='active'&&config.activation!=='personal')throw Error('PERSONAL_ACTIVATION_REQUIRED');
  const personalRuntime=prepared.report.state==='active'?await (await import('./personal-runtime.ts')).composePersonalRuntime(config,ledger):undefined;
  const {configureCodexQuotaRegistry}=await import('./codex-quota-registry.ts');
  const quotaRegistry=await configureCodexQuotaRegistry(ledger,config.codexQuota??{state:'disabled'});
  await quotaRegistry.reconcile();
  if(config.activation==='personal'){const {registerStageReporter}=await import('./personal-team-feed.ts');registerStageReporter(ledger.pool,{executionHost:join(config.dataDirectory,'native','execution-host')});}
  const nativeHome=join(config.dataDirectory,'cezar');await privateDirectory(nativeHome);
  process.env.CEZ_HOME=nativeHome;
  for(const name of ['CEZ_AUTONAME','CEZ_AUTOMATIONS','CEZ_SKILLS_AUTO_UPDATE','CEZ_TELEMETRY'])process.env[name]='0';
  process.env.CEZ_NO_BANNER='1';process.env.DO_NOT_TRACK='1';process.env.CEZ_SINGLE_PROJECT='0';
  process.env.CEZ_DRY_RUN='1';
  const {CezarRuntime}=await import('./cezar.ts'),{createApi}=await import('./api.ts');
  const key=await sessionKey(config);
  const {personalCodeLogin,personalPasswordLogin}=await import('./personal-login.ts');
  // No bearer token opens the API: the panel signs in with the owner's password or a pair code, and the
  // cookie names the principal. A cookie that still carries a bearer from an older login is refused.
  const verify=async(_request:Request):Promise<string|null>=>null;
  const sessions=new BrowserSessions(ledger,key,verify,{origin:config.http.publicOrigin,secure:config.http.publicOrigin.startsWith('https:'),maxAgeSeconds:config.sessionMaxAgeSeconds});key.fill(0);
  runtimes=new ProjectRuntimes(async project=>{
   const nativeBootstrap=project.id===config.project.id?nativeBootstrapRuntimeAttachment(project.id,prepared.report,prepared.resources):undefined;
   // Execution follows an active personal bootstrap and that project's own checkout.
   // A project without a conversation or a policy stays administration-only.
   const bound=personalRuntime?.byProject.get(project.id);
   const execute=Boolean(bound&&prepared.report.state==='active'&&await personalProjectMayExecute(ledger,project.id,project.id===config.project.id));
   const runtime=new CezarRuntime(ledger,project.repo,project.id,execute&&bound?bound.engineering:undefined,undefined,undefined,{...(nativeBootstrap?{nativeBootstrap}:{}),...(execute&&bound&&personalRuntime?{nativePlanning:personalRuntime.planning,nativeExecutions:personalRuntime.executions,nativeImplementation:bound.implementation}:{})});
   try{
    await runtime.start(execute?'execution':'administration-only');
    const control=new Control(ledger,quotaRegistry.adapters,project.id,undefined,{reviewDigest:runtime.engineering?.options.nativeVerification?nativeReviewVerifierDigest:undefined,qaDigest:runtime.engineering?.options.nativeQa?.verifierDigest,nativeExecutionEnabled:runtime.nativeExecutionReady});
    const registry=await startConfiguredManagerTransport(config,ledger,runtime,{transportOnly:prepared.report.state!=='active',semanticPlanning:personalRuntime?.semantic,managerChat:personalRuntime?.managerChat,...(config.activation==='personal'?{dataDirectory:config.dataDirectory,projectLabel:[config.project,...config.projects].find(item=>item.id===runtime.projectId)?.label,managerEconomy:managerEconomyOf([config.project,...config.projects].find(item=>item.id===runtime.projectId)?.economy)}:{})});
    configurationControls.set(project.id,control);if(registry)managerTransports.set(project.id,registry);return runtime;
   }catch(error){await runtime.close();throw error;}
  });
  let stopGateway=()=>{};
  const personalPanel=config.activation==='personal'?{roots:config.projectRoots,projectRepos:[config.project.repo,...config.projects.map(project=>project.repo)],installationPath:path,dataDirectory:config.dataDirectory,projectId:config.project.id,owner:config.project.owner,scheduleRestart(){setTimeout(()=>stopGateway(),1000);}}:undefined;
  const pairCodeLogin=config.activation==='personal'?personalCodeLogin(config,ledger,sessions):undefined;
  const passwordLogin=config.activation==='personal'?personalPasswordLogin(config,ledger,sessions):undefined;
  const appFor=(runtime:InstanceType<typeof CezarRuntime>)=>createApi(ledger,runtime,verify,contextId=>managerTransports.get(runtime.projectId)?.authority(contextId),{sessions,providerAdapters:quotaRegistry.adapters,managerStatus:async contextId=>{const status=await managerTransports.get(runtime.projectId)?.status(contextId);const active=prepared.report.state==='active';return status?{...status,executionEnabled:active,semanticManagerEnabled:active}:undefined;},quotaRegistry,configurationControl:configurationControls.get(runtime.projectId),personalAccounts:config.activation==='personal'?{add:(_principal,input)=>import('./account-add.ts').then(m=>m.addProviderAccount(config,ledger,input)),status:(_principal,accountId)=>import('./account-add.ts').then(m=>m.providerLogin(accountId)),readConversation:(principal,query)=>{const registry=managerTransports.get(runtime.projectId);if(!registry)throw new Refusal('CONVERSATION_UNAVAILABLE',503);return registry.readPanelConversation(principal,query.after,query.limit);},sendMessage:(principal,input)=>{const registry=managerTransports.get(runtime.projectId);if(!registry)throw new Refusal('CONVERSATION_UNAVAILABLE',503);return registry.enqueuePanelMessage(principal,input.text,input.localId);}} :undefined,personalPanel,pairCodeLogin,passwordLogin,...(config.activation==='personal'&&personalRuntime?{personalVerification:(()=>{
   const bound=personalRuntime;
   if(!bound)throw new Error('PERSONAL_RUNTIME_REQUIRED');
   const executions=bound.executions;
   const gitHead=async(repo:string)=>{
    const {execFile}=await import('node:child_process');
    const {promisify}=await import('node:util');
    const {stdout}=await promisify(execFile)('/usr/bin/git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8',timeout:10000,maxBuffer:8192,
     env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}});
    const commit=stdout.trim();
    if(!/^[a-f0-9]{40}$/.test(commit))throw new Refusal('INVALID_CONTRACT',400);
    return commit;
   };
   const releaseGrant=async(principal:string,authority:{contextId:string;instanceId:string;epoch:number},grantId:string,how:'not_started'|'exited')=>{
    const {Capacity}=await import('./capacity.ts');
    const capacity=new Capacity(ledger);
    const states=how==='not_started'?['not_started','exited'] as const:['exited','not_started'] as const;
    try{await capacity.transition(principal,grantId,authority,'released',{processId:grantId,state:states[0]});}
    catch(error){
     if(!(error instanceof Refusal)||error.code!=='PROCESS_MUST_EXIT')throw error;
     await capacity.transition(principal,grantId,authority,'released',{processId:grantId,state:states[1]});
    }
   };
   return {
    start:async(principal,panel,body)=>{
     const found=await ledger.pool.query('SELECT id::text AS id, policy_revision FROM ac_contexts WHERE project_id=$1 AND NOT archived AND NOT EXISTS (SELECT 1 FROM ac_exam_contexts e WHERE e.context_id=ac_contexts.id) ORDER BY created_at LIMIT 1',[panel.projectId]);
     const row=found.rows[0] as {id?:unknown;policy_revision?:unknown}|undefined;
     if(typeof row?.id!=='string')throw new Refusal('VERIFY_CONTEXT_REQUIRED',409);
     const authority=managerTransports.get(runtime.projectId)?.authority(row.id);
     if(!authority)throw new Refusal('AUTHORITY_REQUIRED',409);
     const project=[config.project,...config.projects].find(item=>item.id===panel.projectId);
     if(!project)throw new Refusal('VERIFY_CONTEXT_REQUIRED',409);
     const policyRevision=Number(row.policy_revision);
     if(!Number.isInteger(policyRevision)||policyRevision<1)throw new Refusal('VERIFY_CONTEXT_REQUIRED',409);
     const commit=await gitHead(project.repo);
     const {readCurrentVerifyDatabase}=await import('./verify-db.ts');
     const databasesDirectory=(await readCurrentVerifyDatabase(config.dataDirectory))?.directory;
     if(!databasesDirectory)throw new Refusal('VERIFY_DB_REQUIRED',409);
     let image:string;
     try{
      const {readFile}=await import('node:fs/promises');
      const parsed=JSON.parse(await readFile(join(config.dataDirectory,'verify-image.json'),'utf8')) as {image?:unknown};
      if(!parsed||typeof parsed!=='object'||typeof parsed.image!=='string'||parsed.image.length<1)throw new Refusal('VERIFY_IMAGE_UNPINNED',409);
      image=parsed.image;
     }catch(error){
      if(error instanceof Refusal)throw error;
      const code=error&&typeof error==='object'&&'code' in error?(error as {code?:unknown}).code:undefined;
      if(code==='ENOENT'||error instanceof SyntaxError)throw new Refusal('VERIFY_IMAGE_UNPINNED',409);
      throw error;
     }
     const {createCapacityNativeWorker}=await import('./verify-native-launch.ts');
     const {beginPersonalVerification,examRunOptions}=await import('./verify-command.ts');
     const examOptions=examRunOptions(project.economy);
     const {personalAccountRoot}=await import('./personal-health.ts');
     const allowedAccountIds=project.allowedAccountIds!==undefined
      ?project.allowedAccountIds.filter(id=>executions.some(s=>s.active&&s.supportsAccount(id)))
      :undefined;
     if(allowedAccountIds!==undefined&&allowedAccountIds.length===0)throw new Refusal('PROJECT_ACCOUNTS_UNAVAILABLE',409);
     const allowedSet=allowedAccountIds?new Set(allowedAccountIds):undefined;
     const scopedExecutions=allowedSet
      ?executions.map(s=>({
       get active(){return s.active;},
       supportsAccount:(id:string)=>allowedSet.has(id)&&s.supportsAccount(id),
       start:s.start.bind(s),
       reconcile:s.reconcile.bind(s),
       retireTerminal:s.retireTerminal.bind(s),
       stop:s.stop.bind(s),
      }))
      :executions;
     const worker=createCapacityNativeWorker({supervisors:scopedExecutions,ledger,principal,authority,base:commit,releaseGrant:(grantId,how)=>releaseGrant(principal,authority,grantId,how),pollBackoff:examOptions.pollBackoff});
     return beginPersonalVerification({projectId:panel.projectId,mapEnabled:examOptions.mapEnabled,batch:examOptions.batch,dataDirectory:panel.dataDirectory,repoPath:project.repo,...(body.url?{url:body.url}:{}),...(allowedAccountIds?{allowedAccountIds}:{}),ledger,principal,authority,policyRevision,commit,worker,databasesDirectory,image,installationPath:path,accountRoot:personalAccountRoot(config)});
    },
    recheck:async(principal,authority,input)=>{
     const project=[config.project,...config.projects].find(item=>item.id===input.projectId);
     if(!project)throw new Refusal('NOT_FOUND',404);
     const commit=await gitHead(project.repo);
     const {createRecheckNativeWorker,reservePersonalRecheckReviewer,EXAM_DEADLINE_MS}=await import('./verify-native-launch.ts');
     const {examRunOptions}=await import('./verify-command.ts');
     const {recheckFindings}=await import('./verify-remediate.ts');
     const examOptions=examRunOptions(project.economy);
     const allowedAccountIds=project.allowedAccountIds!==undefined
      ?project.allowedAccountIds.filter(id=>executions.some(s=>s.active&&s.supportsAccount(id)))
      :undefined;
     if(allowedAccountIds!==undefined&&allowedAccountIds.length===0)throw new Refusal('PROJECT_ACCOUNTS_UNAVAILABLE',409);
     const allowedSet=allowedAccountIds?new Set(allowedAccountIds):undefined;
     const scopedExecutions=allowedSet
      ?executions.map(s=>({
       get active(){return s.active;},
       supportsAccount:(id:string)=>allowedSet.has(id)&&s.supportsAccount(id),
       start:s.start.bind(s),
       reconcile:s.reconcile.bind(s),
       retireTerminal:s.retireTerminal.bind(s),
       stop:s.stop.bind(s),
      }))
      :executions;
     const release=(grantId:string,how:'not_started'|'exited')=>releaseGrant(principal,authority,grantId,how);
     const recheckAbort=new AbortController();
     const signal=AbortSignal.any([shutdownAbort.signal,recheckAbort.signal]);
     const deadlineAt=Date.now()+EXAM_DEADLINE_MS;
     const worker=createRecheckNativeWorker({supervisors:scopedExecutions,principal,authority,base:commit,pollBackoff:examOptions.pollBackoff,reserveReviewer:(intentId,avoidProviders,exclusion)=>reservePersonalRecheckReviewer({ledger,principal,authority,intentId,...(allowedAccountIds?{allowedAccounts:allowedAccountIds}:{}),avoidProviders,exclusion,pollBackoff:examOptions.pollBackoff,deadlineMs:EXAM_DEADLINE_MS,deadlineAt,signal,releaseGrant:release}),releaseGrant:release});
     try{return await recheckFindings(ledger,principal,authority,{...input,worker});}
     finally{recheckAbort.abort();}
    },
   };
  })()}:{})});
  const projects=new Projects(ledger,config.projectRoots),activeRuntimes=runtimes;
  const defaultRuntime=await activeRuntimes.get({id:config.project.id,repo:config.project.repo});
  const defaultApp=appFor(defaultRuntime);
  const gateway=createProjectGateway({projects,runtimes:activeRuntimes,defaultProjectId:config.project.id,appFor,
   projectAdmin:createProjectAdminApi(new ProjectAdmin(ledger,config.projectRoots,config.dataDirectory,{remoteReturnTransport:remoteReturnTransport(config.remoteReturn),remoteDevelopment:configuredRemoteDevelopment(ledger,config.remoteDevelopment,(projectId,contextId)=>managerTransports.get(projectId)?.authority(contextId))})),
   workflowGraphs:createWorkflowGraphApi(new WorkflowGraphs(ledger,config.projectRoots,config.dataDirectory)),
   projectEnvironments:createProjectEnvironmentApi(new ProjectEnvironments(ledger,config.projectRoots,config.dataDirectory)),
   installationAuthority:createInstallationAuthorityApi(new InstallationAuthority(ledger)),
   publicFetch:async request=>defaultApp.fetch(request),authenticate:async request=>{
    const bearer=request.headers.get('authorization');
    const principal=bearer?await verify(request):await sessions.authenticate(request)??await verify(request);
    if(principal&&!bearer)sessions.checkOrigin(request);
    return principal;
   }});
  if(config.activation==='personal'){try{const {failAbandonedVerifyRuns,watchAbandonedVerifyRuns}=await import('./verify-abandon.ts');try{await failAbandonedVerifyRuns(ledger,config.dataDirectory);}catch{console.error('VERIFY_ABANDON_FAILED');}stopAbandonedVerifyRuns=watchAbandonedVerifyRuns(ledger,config.dataDirectory);}catch{console.error('VERIFY_ABANDON_FAILED');}}
  const server=serve({fetch:gateway,hostname:config.http.listen,port:config.http.port},()=>console.log(JSON.stringify({state:prepared.report.state==='active'?'personal_ready':'administration_ready',mode:config.mode,projectId:config.project.id,executionEnabled:prepared.report.executionEnabled,inferenceEnabled:prepared.report.inferenceEnabled,nativeBootstrap:bootstrapReport,workflowRuntime:workflowRegistration?.report})));
  serving=true;
  let closing=false;
  const close=()=>{if(closing)return;closing=true;shutdownAbort.abort();stopAbandonedVerifyRuns();server.close();void (async()=>{let failed=false;try{await closeManagers();}catch{failed=true;}try{await activeRuntimes.close();}catch{failed=true;}try{await shutdownBootstrap();}catch{failed=true;}try{await workflowRegistration?.close();}catch{failed=true;}finally{try{await ledger.close();}catch{failed=true;}}if(failed)console.error('INSTALLATION_SHUTDOWN_FAILED');process.exit(failed?1:0);})();};
  stopGateway=close;
  process.once('SIGTERM',close);process.once('SIGINT',close);
 }finally{if(!serving){stopAbandonedVerifyRuns();try{await shutdownBootstrap();}finally{try{await closeManagers();}finally{try{await runtimes?.close();}finally{try{await workflowRegistration?.close();}finally{await ledger.close();}}}}}}
}
main().catch(error=>{
 // Only a refusal code or an upper-case error identifier is shown; free text may carry paths or secrets.
 const raw=String((error as {code?:unknown})?.code??(error as Error)?.message??''),code=/^[A-Z][A-Z0-9_]{2,80}$/.test(raw)?raw:(error as Error)?.name==='ZodError'?'INVALID_CONFIGURATION_SHAPE':'UNCLASSIFIED';
 console.error('INSTALLATION_COMMAND_FAILED ('+code+'): inspect private configuration, initialization and service availability; secrets are not logged.');process.exitCode=1;});
