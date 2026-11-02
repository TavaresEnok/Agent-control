import {realpath} from 'node:fs/promises';
import {isAbsolute,resolve,sep} from 'node:path';
import {z} from 'zod';
import {AccountHomes} from './account-homes.ts';
import {Id,Refusal} from './contracts.ts';
import {readPrivateFile,privateDirectory,type Installation} from './installation.ts';
import type {Ledger} from './ledger.ts';

const Descriptor=z.object({accountId:Id,projectId:Id}).strict();
/** Local provisioning only: no CLI, credentials, environment export or login. */
export async function executeAccountHome(command:'provider-home-initialize'|'provider-home-inspect',config:Installation,ledger:Ledger,descriptorPath:string){
 const root=config.accountHomesDirectory;
 if(!root)throw new Refusal('ACCOUNT_HOMES_NOT_CONFIGURED',403);
 const repositories=[...new Set([config.project.repo,...config.projects.map(p=>p.repo),
  ...(await ledger.pool.query('SELECT repo FROM ac_project_repositories')).rows.map(r=>String(r.repo))])];
 if(!isAbsolute(descriptorPath)||resolve(descriptorPath)!==descriptorPath||await realpath(descriptorPath)!==descriptorPath||
  repositories.some(repo=>descriptorPath===repo||descriptorPath.startsWith(repo+sep)))throw new Refusal('UNSAFE_PRIVATE_FILE',403);
 const bytes=await readPrivateFile(descriptorPath,4096);
 try{
  const input=Descriptor.parse(JSON.parse(bytes.toString('utf8')));
  if(command==='provider-home-initialize'){
   // Authorize before creating any directories; AccountHomes revalidates again.
   if(!(await ledger.pool.query(`SELECT 1 FROM ac_accounts a JOIN ac_account_access x ON x.account_id=a.id
    JOIN ac_memberships m ON m.project_id=x.project_id WHERE a.id=$1 AND a.owner_id=$2 AND x.project_id=$3
    AND m.principal_id=$2 AND m.role='owner'`,[input.accountId,config.project.owner,input.projectId])).rowCount)
    throw new Refusal('ACCOUNT_FORBIDDEN',403);
   await privateDirectory(config.dataDirectory);await privateDirectory(root);
  }
  const service=new AccountHomes(ledger,root,repositories);
  const metadata=command==='provider-home-initialize'
   ?await service.initialize(config.project.owner,input.projectId,input.accountId)
   :await service.inspect(config.project.owner,input.projectId,input.accountId);
  return {state:command==='provider-home-initialize'?'home_initialized' as const:'home_inspected' as const,
   accountId:metadata.accountId,authenticationPerformed:false,inferenceEnabled:false};
 }finally{bytes.fill(0);}
}
