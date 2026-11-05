import {isAbsolute} from 'node:path';
import {z} from 'zod';
import {Id,Refusal,type Authority} from './contracts.ts';
import {Ledger} from './ledger.ts';
import {RemoteReturnConfig,remoteReturnTransport} from './remote-return-config.ts';
import {RemoteDevelopment} from './remote-development.ts';
import type {RemoteDevelopmentAdministration} from './remote-development-admin.ts';
import {Quality} from './quality.ts';
import {GitArtifacts} from './git.ts';
import {RemoteWritePath} from './remote-write-paths.ts';
export const RemoteDevelopmentConfig=z.object({mode:z.literal('synthetic-fixed-task-v1'),transport:RemoteReturnConfig,
 projects:z.array(z.object({projectId:Id,verifierKeyFile:z.string().refine(isAbsolute),tmpfsRoot:z.string().refine(isAbsolute),
  profiles:z.array(z.object({profileId:Id,hostId:Id,taskId:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),writePaths:z.array(RemoteWritePath).min(1).max(64)}).strict()).min(1).max(64)}).strict()).min(1).max(32)
}).strict().refine(value=>new Set(value.projects.map(item=>item.projectId)).size===value.projects.length&&value.projects.every(item=>new Set(item.profiles.map(profile=>profile.profileId)).size===item.profiles.length));
/** Explicit configured product entry. Absence is disabled. Authority is resolved
 * from the active manager registry for each request, never from caller JSON.
 */
export function configuredRemoteDevelopment(ledger:Ledger,raw:z.input<typeof RemoteDevelopmentConfig>|undefined,
 authority:(projectId:string,contextId:string)=>Promise<Authority|undefined>|Authority|undefined):RemoteDevelopmentAdministration|undefined{
 if(!raw)return undefined;
 const config=RemoteDevelopmentConfig.parse(raw),transport=remoteReturnTransport(config.transport)!;
 return {supports:(projectId,hostId)=>config.projects.some(project=>project.projectId===projectId&&project.profiles.some(profile=>profile.hostId===hostId)),async resolve(projectId,contextId){
  const project=config.projects.find(item=>item.projectId===projectId);
  if(!project)throw new Refusal('REMOTE_DEVELOPMENT_PROJECT_NOT_CONFIGURED');
  const live=await authority(projectId,contextId);
  if(!live||live.contextId!==contextId)throw new Refusal('REMOTE_DEVELOPMENT_MANAGER_NOT_ACTIVE');
  const repository=(await ledger.pool.query('SELECT r.repo FROM ac_project_repositories r JOIN ac_contexts x ON x.project_id=r.project_id AND x.id=$2 WHERE r.project_id=$1 AND NOT x.archived',[projectId,contextId])).rows[0];
  if(!repository)throw new Refusal('REMOTE_DEVELOPMENT_SCOPE_MISMATCH');
  const {readPrivateFile}=await import('./installation.ts');
  const key=await readPrivateFile(project.verifierKeyFile,32);
  if(key.length!==32){key.fill(0);throw new Refusal('REMOTE_DEVELOPMENT_VERIFIER_KEY_INVALID');}
  const quality=new Quality(ledger,Buffer.from(key),new GitArtifacts(repository.repo));key.fill(0);
  const development=new RemoteDevelopment(ledger,transport,{implementationProfiles:new Map(project.profiles.map(({profileId,...binding})=>[profileId,binding]))});
  return {development,authority:live,quality,tmpfsRoot:project.tmpfsRoot};
 }};
}
