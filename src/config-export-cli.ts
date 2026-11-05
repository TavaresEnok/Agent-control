import {realpath,stat} from 'node:fs/promises';
import {dirname,isAbsolute,resolve,sep} from 'node:path';
import {z} from 'zod';
import {Id,Refusal} from './contracts.ts';
import {readPrivateFile,type Installation} from './installation.ts';
import {writeConfiguration,readConfiguration} from './config-export.ts';
import type {Ledger} from './ledger.ts';
const Descriptor=z.object({action:z.enum(['export','read']),projectId:Id,artifactFile:z.string().min(1),keyFile:z.string().min(1)}).strict();
async function descriptor(config:Installation,ledger:Ledger,path:string,action:'export'|'read'){
 const repositories=[...new Set([config.project.repo,...config.projects.map(p=>p.repo),...(await ledger.pool.query('SELECT repo FROM ac_project_repositories')).rows.map(r=>String(r.repo))])];
 if(!isAbsolute(path)||resolve(path)!==path||await realpath(path)!==path||repositories.some(repo=>path===repo||path.startsWith(repo+sep)))throw new Refusal('UNSAFE_PRIVATE_FILE',403);
 const bytes=await readPrivateFile(path,4096,{canonical:true});try{const d=Descriptor.parse(JSON.parse(bytes.toString('utf8')));if(d.action!==action)throw new Refusal('CONFIG_EXPORT_COMMAND_MISMATCH',400);const principal=config.project.owner;
  if(![config.project,...config.projects].some(p=>p.id===d.projectId))throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
  if(!(await ledger.pool.query("SELECT 1 FROM ac_control_admins a JOIN ac_memberships m ON m.principal_id=a.principal_id WHERE a.principal_id=$1 AND m.project_id=$2 AND m.role='owner'",[principal,d.projectId])).rowCount)throw new Refusal('CONFIG_EXPORT_FORBIDDEN',403);
  const projectIds=[config.project,...config.projects].map(p=>p.id);if(Number((await ledger.pool.query("SELECT count(*) n FROM ac_memberships WHERE principal_id=$1 AND role='owner' AND project_id=ANY($2::uuid[])",[principal,projectIds])).rows[0].n)!==projectIds.length)throw new Refusal('CONFIG_EXPORT_FORBIDDEN',403);
  for(const candidate of [d.artifactFile,d.keyFile])if(!isAbsolute(candidate)||resolve(candidate)!==candidate||repositories.some(repo=>candidate===repo||candidate.startsWith(repo+sep)))throw new Refusal('UNSAFE_PRIVATE_FILE',403);
  for(const parent of [dirname(path),dirname(d.artifactFile),dirname(d.keyFile)]){const info=await stat(parent);if(await realpath(parent)!==parent||!info.isDirectory()||(info.mode&0o077)!==0||info.uid!==process.getuid?.())throw new Refusal('UNSAFE_PRIVATE_DIRECTORY',403);}
  return {d,principal,repositories};
 }finally{bytes.fill(0);}
}
export async function executeConfigExport(config:Installation,ledger:Ledger,descriptorPath:string){const {d,principal,repositories}=await descriptor(config,ledger,descriptorPath,'export');return writeConfiguration(ledger,principal,d.projectId,d.artifactFile,d.keyFile,repositories,config);}
/** Local inspection only: never restores, activates or writes configuration. */
export async function executeConfigRead(config:Installation,ledger:Ledger,descriptorPath:string){const {d}=await descriptor(config,ledger,descriptorPath,'read');const dto=await readConfiguration(d.artifactFile,d.keyFile);if(dto.project.id!==d.projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);const project=z.object({id:Id}).passthrough();const projectIds=[project.parse(dto.installation.project).id,...dto.installation.projects.map(p=>project.parse(p).id)];if(new Set(projectIds).size!==projectIds.length||Number((await ledger.pool.query("SELECT count(*) n FROM ac_memberships WHERE principal_id=$1 AND role='owner' AND project_id=ANY($2::uuid[])",[config.project.owner,projectIds])).rows[0].n)!==projectIds.length)throw new Refusal('CONFIG_EXPORT_FORBIDDEN',403);return dto;}
