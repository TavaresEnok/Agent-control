// Configured administration gateway. Native adapters stay disabled unless a
// discriminated opt-in is valid. Configured opt-in does not activate accounts
// or inference. Bench mode is refused here because it requires injected substitutes.
import {serve} from '@hono/node-server';
import {z} from 'zod';
import {join} from 'node:path';
import {Installation,readPrivateFile,loadInstallation,sessionKey,initializeInstallation,prepareInstallationOperator,privateDirectory} from './installation.ts';
import {Ledger} from './ledger.ts';
import {Projects,ProjectRuntimes} from './projects.ts';
import {createProjectGateway} from './projects-api.ts';
import {BrowserSessions} from './sessions.ts';
import {HappierAuthRelay} from './auth-relay.ts';
import {ProjectAdmin} from './project-admin.ts';
import {createProjectAdminApi} from './project-admin-api.ts';
import {startConfiguredManagerTransport} from './manager-transport.ts';
import type {ManagerRegistry} from './managers.ts';
async function main(){
 const [command,path,...extra]=process.argv.slice(2);
 // Retention dry-run. One private descriptor. No installation, ledger, vault, provider CLI, or deletion.
 if(command==='retention-plan'){
  const {executeRetentionPlan}=await import('./retention-cli.ts');
  const result=await executeRetentionPlan(path,extra);
  if(result.exitCode===1){console.error(result.code);process.exitCode=1;return;}
  console.log(JSON.stringify(result.plan));
  process.exitCode=result.exitCode;
  return;
 }
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
 const descriptorCommand=['context-key-authorize','context-key-import','context-key-rotate-plan','vault-backup','vault-restore','provider-home-initialize','provider-home-inspect','import-stage','import-deliver','import-archive','export-context'].includes(command);
 if(!path||!['initialize','inspect','operator-bootstrap','serve','vault-initialize','context-key-authorize','context-key-import','context-key-rotate-plan','vault-backup','vault-restore','provider-home-initialize','provider-home-inspect','import-stage','import-deliver','import-archive','export-context'].includes(command)||extra.length!==(descriptorCommand?1:0))throw Error('INVALID_INSTALLATION_COMMAND');
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
 const ledger=new Ledger(config.databaseUrl);
 const managerTransports=new Map<string,ManagerRegistry>();
 const closeManagers=async()=>{const results=await Promise.allSettled([...managerTransports.values()].map(registry=>registry.close()));managerTransports.clear();if(results.some(result=>result.status==='rejected'))throw Error('MANAGER_TRANSPORT_SHUTDOWN_FAILED');};
 let bootstrapSession:{shutdown():Promise<unknown>}|undefined;
 let bootstrapReport:{state:string;executionEnabled:false;inferenceEnabled:false}|undefined;
 const shutdownBootstrap=async()=>{await bootstrapSession?.shutdown();};
 let runtimes:ProjectRuntimes|undefined,serving=false;
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
  if(command==='export-context'){const {exportContext}=await import('./context-export-cli.ts');console.log(JSON.stringify(await exportContext(config,ledger,extra[0])));return;}
  if(command==='import-stage'||command==='import-deliver'||command==='import-archive'){
   const {executeImport}=await import('./import-cli.ts');console.log(JSON.stringify(await executeImport(command,config,ledger,extra[0])));return;
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
  // Serving does not silently migrate schemas or create projects/credentials.
  const registered=(await ledger.pool.query("SELECT 1 FROM ac_projects p JOIN ac_memberships m ON m.project_id=p.id JOIN ac_project_repositories r ON r.project_id=p.id WHERE p.id=$1 AND m.principal_id=$2 AND m.role='owner' AND r.repo=$3",[config.project.id,config.project.owner,config.project.repo])).rowCount;
  if(!registered)throw Error('INSTALLATION_NOT_INITIALIZED');
  const {prepareNativeBootstrap,nativeBootstrapRuntimeAttachment}=await import('./native-bootstrap.ts');
  const prepared=await prepareNativeBootstrap(config,{query:(sql,params)=>ledger.pool.query(sql,params as never[])});
  bootstrapSession=prepared.session;bootstrapReport=prepared.report;
  if(prepared.report.executionEnabled||prepared.report.inferenceEnabled||prepared.report.realAccountsEnabled)throw Error('NATIVE_BOOTSTRAP_ACTIVATION_BLOCKED');
  const nativeHome=join(config.dataDirectory,'cezar');await privateDirectory(nativeHome);
  process.env.CEZ_HOME=nativeHome;
  for(const name of ['CEZ_AUTONAME','CEZ_AUTOMATIONS','CEZ_SKILLS_AUTO_UPDATE','CEZ_TELEMETRY'])process.env[name]='0';
  process.env.CEZ_NO_BANNER='1';process.env.DO_NOT_TRACK='1';process.env.CEZ_SINGLE_PROJECT='0';
  process.env.CEZ_DRY_RUN='1';
  const {CezarRuntime}=await import('./cezar.ts'),{createApi}=await import('./api.ts');
  const key=await sessionKey(config);
  const verify=async(request:Request)=>{
   const authorization=request.headers.get('authorization');if(!authorization?.startsWith('Bearer '))return null;
   try{
    const response=await fetch(config.happier.upstreamOrigin+'/v1/account/profile',{headers:{authorization},redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!response.ok)return null;return z.object({id:z.string().min(1).max(200)}).parse(await response.json()).id;
   }catch{return null;}
  };
  const sessions=new BrowserSessions(ledger,key,verify,{origin:config.http.publicOrigin,secure:config.http.publicOrigin.startsWith('https:'),maxAgeSeconds:config.sessionMaxAgeSeconds});key.fill(0);
  runtimes=new ProjectRuntimes(async project=>{
   const nativeBootstrap=project.id===config.project.id?nativeBootstrapRuntimeAttachment(project.id,prepared.report):undefined;
   const runtime=new CezarRuntime(ledger,project.repo,project.id,undefined,undefined,undefined,nativeBootstrap?{nativeBootstrap}:undefined);
   try{await runtime.start('administration-only');const registry=await startConfiguredManagerTransport(config,ledger,runtime);if(registry)managerTransports.set(project.id,registry);return runtime;}catch(error){await runtime.close();throw error;}
  });
  const access=async(principal:string,sessionId:string,request?:Request)=>request?
   sessions.verifyHappierSession(request,principal,sessionId,config.happier.upstreamOrigin):false;
  const relay=new HappierAuthRelay(sessions,{upstreamUrl:config.happier.upstreamOrigin,webUrl:config.happier.webOrigin,publicServerUrl:config.happier.publicServerOrigin});
  const appFor=(runtime:InstanceType<typeof CezarRuntime>)=>createApi(ledger,runtime,verify,contextId=>managerTransports.get(runtime.projectId)?.authority(contextId),config.happier.webOrigin,access,sessions,relay,[],undefined,async contextId=>{const status=await managerTransports.get(runtime.projectId)?.status(contextId);return status?{...status,executionEnabled:false,semanticManagerEnabled:false}:undefined;});
  const projects=new Projects(ledger,config.projectRoots),activeRuntimes=runtimes;
  const defaultRuntime=await activeRuntimes.get({id:config.project.id,repo:config.project.repo});
  const defaultApp=appFor(defaultRuntime);
  const gateway=createProjectGateway({projects,runtimes:activeRuntimes,defaultProjectId:config.project.id,appFor,
   projectAdmin:createProjectAdminApi(new ProjectAdmin(ledger,config.projectRoots,config.dataDirectory)),
   publicFetch:async request=>defaultApp.fetch(request),authenticate:async request=>{
    const bearer=request.headers.get('authorization');
    const principal=bearer?await verify(request):await sessions.authenticate(request)??await verify(request);
    if(principal&&!bearer)sessions.checkOrigin(request);
    return principal;
   }});
  const server=serve({fetch:gateway,hostname:config.http.listen,port:config.http.port},()=>console.log(JSON.stringify({state:'administration_ready',mode:config.mode,projectId:config.project.id,executionEnabled:false,inferenceEnabled:false,nativeBootstrap:bootstrapReport})));
  serving=true;
  let closing=false;
  const close=()=>{if(closing)return;closing=true;server.close();void (async()=>{let failed=false;try{await closeManagers();}catch{failed=true;}try{await activeRuntimes.close();}catch{failed=true;}try{await shutdownBootstrap();}catch{failed=true;}finally{try{await ledger.close();}catch{failed=true;}}if(failed)console.error('INSTALLATION_SHUTDOWN_FAILED');process.exit(failed?1:0);})();};
  process.once('SIGTERM',close);process.once('SIGINT',close);
 }finally{if(!serving){try{await shutdownBootstrap();}finally{try{await closeManagers();}finally{try{await runtimes?.close();}finally{await ledger.close();}}}}}
}
main().catch(()=>{console.error('INSTALLATION_COMMAND_FAILED: inspect private configuration, initialization and service availability; secrets are not logged.');process.exitCode=1;});
