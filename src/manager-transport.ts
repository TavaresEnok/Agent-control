import {realpath} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {z} from 'zod';
import {Refusal} from './contracts.ts';
import {readPrivateFile,type Installation} from './installation.ts';
import {ManagerRegistry,happierEndpointFactory} from './managers.ts';
import {ContextVault} from './context-vault.ts';
import {loadHappier} from './happier.ts';
import type {Ledger} from './ledger.ts';
import type {CezarRuntime} from './cezar.ts';

/** Optional configured transport only. Cezar still owns dispatch; no model login,
 * inference, unpause, policy edit or account activation occurs here. */
export async function startConfiguredManagerTransport(config:Installation,ledger:Ledger,runtime:CezarRuntime):Promise<ManagerRegistry|undefined>{
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
   baseUrl:config.happier.upstreamOrigin,token,machineId:options.machineId,transportOnly:true}));
  for(const item of contexts){
   const {projectId,...request}=item;
   if(projectId!==runtime.projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
   const allowed=(await ledger.pool.query("SELECT 1 FROM ac_contexts x JOIN ac_memberships m ON m.project_id=x.project_id WHERE x.id=$1 AND x.project_id=$2 AND m.principal_id=$3 AND m.role='owner' AND NOT x.archived",[item.contextId,projectId,options.principal])).rowCount;
   if(!allowed)throw new Refusal('PROJECT_OWNER_REQUIRED',403);
   await registry.startFromKeySource({...request,principal:options.principal},source);
  }
  return registry;
 }catch(error){await registry?.close();throw error;}finally{raw.fill(0);}
}
