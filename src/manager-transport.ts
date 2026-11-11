import {realpath} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {z} from 'zod';
import {Refusal} from './contracts.ts';
import {readPrivateFile,type Installation} from './installation.ts';
import {ManagerRegistry,happierEndpointFactory} from './managers.ts';
import {ContextVault} from './context-vault.ts';
import {loadHappier} from './happier.ts';
import type {Control} from './control.ts';
import type {Ledger} from './ledger.ts';
import type {CezarRuntime} from './cezar.ts';
import {assertManagerTransportAllowed} from './native-bootstrap.ts';

/** Optional configured transport only. Cezar still owns dispatch; no model login,
 * inference or account activation occurs during bootstrap. Human signed typed
 * configuration RPCs remain available after the transport starts. A bench
 * bootstrap cannot open this transport: substitutes are injected by the caller. */
export async function startConfiguredManagerTransport(config:Installation,ledger:Ledger,runtime:CezarRuntime,configurationControl?:Control,personal?:{transportOnly?:boolean;semanticPlanning?:import('./semantic-planning.ts').SemanticPlanning;managerChat?:import('./personal-manager-chat.ts').PersonalManagerChat}):Promise<ManagerRegistry|undefined>{
 assertManagerTransportAllowed(config);
 const options=config.managerTransport;if(!options)return;
 const contexts=options.contexts.filter(item=>item.projectId===runtime.projectId);if(!contexts.length)return;
 if(!config.contextVault)throw new Refusal('VAULT_NOT_CONFIGURED');
 const repositories=[...new Set([config.project.repo,...config.projects.map(p=>p.repo),
  ...(await ledger.pool.query('SELECT repo FROM ac_project_repositories')).rows.map(r=>String(r.repo))])];
 if(resolve(options.tokenFile)!==options.tokenFile||await realpath(options.tokenFile)!==options.tokenFile||
  repositories.some(repo=>options.tokenFile===repo||options.tokenFile.startsWith(repo+sep)))throw new Refusal('UNSAFE_PRIVATE_FILE',403);
 const raw=await readPrivateFile(options.tokenFile,16384);let registry:ManagerRegistry|undefined;
 try{
  const token=raw.toString('utf8').trim();if(!token||/[\s\x00-\x1f\x7f]/.test(token))throw new Refusal('MANAGER_TOKEN_INVALID',400);
  const response=await fetch(config.happier.upstreamOrigin+'/v1/account/profile',{
   headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok||z.object({id:z.string()}).passthrough().parse(await response.json()).id!==options.principal)
   throw new Refusal('MANAGER_PRINCIPAL_MISMATCH',403);
  const identity=(await ledger.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0];
  if(!identity)throw new Refusal('INSTALLATION_IDENTITY_MISSING');
  const source=new ContextVault(ledger,identity.id,config.contextVault.directory,config.contextVault.masterFile,repositories);
  registry=new ManagerRegistry(ledger,runtime.projectId,happierEndpointFactory(ledger,runtime,await loadHappier(),{
   baseUrl:config.happier.upstreamOrigin,token,machineId:options.machineId,transportOnly:personal?.transportOnly!==false,semanticPlanning:personal?.semanticPlanning,configurationControl,personalConversation:personal?.transportOnly===false,teamFeedRoot:personal?.transportOnly===false?join(config.dataDirectory,'native','execution-host'):undefined,managerChat:personal?.managerChat}));
  for(const item of contexts){
   const {projectId,...request}=item;
   if(projectId!==runtime.projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
   const allowed=(await ledger.pool.query("SELECT 1 FROM ac_contexts x JOIN ac_memberships m ON m.project_id=x.project_id WHERE x.id=$1 AND x.project_id=$2 AND m.principal_id=$3 AND m.role='owner' AND NOT x.archived",[item.contextId,projectId,options.principal])).rowCount;
   if(!allowed)throw new Refusal('PROJECT_OWNER_REQUIRED',403);
   // After a crash or restart the previous lease is still live for at most 15 seconds; wait about twice that instead of failing the whole service.
   for(let attempt=0;;attempt++){
    try{await registry.startFromKeySource({...request,principal:options.principal},source);break;}
    catch(error){if(!(error instanceof Refusal)||error.code!=='MANAGER_ACTIVE'||attempt>=10)throw error;await new Promise(done=>setTimeout(done,3000));}
   }
  }
  if(personal?.transportOnly===false){
   // Personal mode: the Happier client does not reconnect by itself, and a restarted Happier server (or a network blip)
   // would leave the conversation dead until the gateway restarts. Watch each context and restart its manager from the
   // vault; the old lease expires in 15 seconds, so a restart that still finds it live is retried on the next check.
   const watched=contexts.map(({projectId:_,...request})=>request),active=registry;let checking=false;
   const watchdog=setInterval(()=>{if(checking)return;checking=true;void (async()=>{
    for(const request of watched){
     const state=await active.status(request.contextId).then(value=>value.state,()=>'revoked');
     if(state==='running'||state==='starting')continue;
     await active.restartFromKeySource({...request,principal:options.principal},source).then(
      ()=>console.error('MANAGER_RECONNECTED '+request.contextId),
      error=>{if(!(error instanceof Refusal)||!['MANAGER_ACTIVE','MANAGER_RESTART_IN_PROGRESS'].includes(error.code))console.error('MANAGER_RECONNECT_FAILED ('+(error instanceof Refusal?error.code:'UNCLASSIFIED')+') '+request.contextId);});
    }
   })().finally(()=>{checking=false;});},15000);
   watchdog.unref?.();
   const close=registry.close.bind(registry);
   registry.close=async()=>{clearInterval(watchdog);return close();};
  }
  return registry;
 }catch(error){await registry?.close();throw error;}finally{raw.fill(0);}
}
