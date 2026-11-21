import {join} from 'node:path';
import {Refusal} from './contracts.ts';
import type {Installation} from './installation.ts';
import {ManagerRegistry,localEndpointFactory} from './managers.ts';
import {ContextVault} from './context-vault.ts';
import type {Ledger} from './ledger.ts';
import type {CezarRuntime} from './cezar.ts';
import {assertManagerTransportAllowed} from './native-bootstrap.ts';
import {deliverPersonalPush,type PersonalPushNotice} from './personal-push.ts';

type PersonalTransportOptions={transportOnly?:boolean;semanticPlanning?:import('./semantic-planning.ts').SemanticPlanning;managerChat?:import('./personal-manager-chat.ts').PersonalManagerChat;dataDirectory?:string;projectLabel?:string;managerEconomy?:import('./manager-discipline.ts').ManagerEconomy};
/** Optional configured transport only: the personal conversation kept in Postgres. Cezar still owns dispatch;
 * no model login, inference or account activation occurs during bootstrap. A bench bootstrap cannot open this
 * transport: substitutes are injected by the caller. */
export async function startConfiguredManagerTransport(config:Installation,ledger:Ledger,runtime:CezarRuntime,personal?:PersonalTransportOptions):Promise<ManagerRegistry|undefined>{
 assertManagerTransportAllowed(config);
 const options=config.managerTransport;if(!options)return;
 const contexts=options.contexts.filter(item=>item.projectId===runtime.projectId);if(!contexts.length)return;
 if(!config.contextVault)throw new Refusal('VAULT_NOT_CONFIGURED');
 if(config.activation!=='personal')throw new Refusal('LOCAL_TRANSPORT_REQUIRES_PERSONAL');
 const repositories=[...new Set([config.project.repo,...config.projects.map(p=>p.repo),
  ...(await ledger.pool.query('SELECT repo FROM ac_project_repositories')).rows.map(r=>String(r.repo))])];
 return startLocalManagerTransport(config,ledger,runtime,repositories,personal);
}
/** Personal transcript in Postgres. Reads no token and opens no socket. */
async function startLocalManagerTransport(config:Installation,ledger:Ledger,runtime:CezarRuntime,repositories:string[],personal:PersonalTransportOptions|undefined):Promise<ManagerRegistry>{
 const options=config.managerTransport!;
 const contexts=options.contexts.filter(item=>item.projectId===runtime.projectId);
 if(!config.contextVault)throw new Refusal('VAULT_NOT_CONFIGURED');
 const identity=(await ledger.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0];
 if(!identity)throw new Refusal('INSTALLATION_IDENTITY_MISSING');
 const source=new ContextVault(ledger,identity.id,config.contextVault.directory,config.contextVault.masterFile,repositories);
 const pushDirectory=personal?.transportOnly===false?personal.dataDirectory:undefined;
 const personalPush=pushDirectory?(notice:PersonalPushNotice)=>deliverPersonalPush(pushDirectory,notice):undefined;
 const registry=new ManagerRegistry(ledger,runtime.projectId,localEndpointFactory(ledger,runtime,{
  transportOnly:personal?.transportOnly!==false,semanticPlanning:personal?.semanticPlanning,personalConversation:personal?.transportOnly===false,teamFeedRoot:personal?.transportOnly===false?join(config.dataDirectory,'native','execution-host'):undefined,dataDirectory:personal?.transportOnly===false?config.dataDirectory:undefined,managerChat:personal?.managerChat,projectLabel:personal?.projectLabel,managerEconomy:personal?.managerEconomy,deliverPersonalPush:personalPush}));
 try{
  for(const item of contexts){
   const {projectId,...request}=item;
   if(projectId!==runtime.projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
   const allowed=(await ledger.pool.query("SELECT 1 FROM ac_contexts x JOIN ac_memberships m ON m.project_id=x.project_id WHERE x.id=$1 AND x.project_id=$2 AND m.principal_id=$3 AND m.role='owner' AND NOT x.archived",[item.contextId,projectId,options.principal])).rowCount;
   if(!allowed)throw new Refusal('PROJECT_OWNER_REQUIRED',403);
   for(let attempt=0;;attempt++){
    try{await registry.startFromKeySource({...request,principal:options.principal},source);break;}
    catch(error){if(!(error instanceof Refusal)||error.code!=='MANAGER_ACTIVE'||attempt>=10)throw error;await new Promise(done=>setTimeout(done,3000));}
   }
  }
  if(personal?.transportOnly===false){
   // A stopped endpoint (a lost lease, a database blip) would leave the conversation dead until the gateway
   // restarts. Watch each context and restart its manager from the vault; the old lease expires in 15 seconds,
   // so a restart that still finds it live is retried on the next check.
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
 }catch(error){await registry.close();throw error;}
}
