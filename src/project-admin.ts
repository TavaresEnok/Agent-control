import {lstat,realpath} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import {Id,Refusal,digest} from './contracts.ts';
import {Operators,type OperatorProof} from './operator.ts';
import {Ledger} from './ledger.ts';
import {projectRepositoryIdentity} from './project-repository.ts';
import {materializeRemoteProjectSource,RemoteSourceMaterializationPayload} from './remote-source-materialization.ts';

export const ProjectRoot=z.object({id:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),label:z.string().min(1).max(100),path:z.string().min(1)}).strict();
export type ProjectRoot=z.infer<typeof ProjectRoot>;
const RelativePath=z.string().min(1).max(512).refine(path=>!path.startsWith('/')&&!path.includes('\\')&&!/[\x00-\x1f\x7f]/.test(path)&&
 path.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'&&part!=='.git'));
const AdminBase={schemaVersion:z.literal(1),intentId:Id,deliveryAttemptId:Id};
export const ProjectAdminCommand=z.discriminatedUnion('action',[
 z.object({...AdminBase,action:z.literal('project.register'),payload:z.object({projectId:Id,label:z.string().min(1).max(200).refine(value=>value.trim().length>0),rootId:ProjectRoot.shape.id,relativePath:RelativePath}).strict()}).strict(),
 z.object({...AdminBase,action:z.literal('project.materializeRemoteSource'),payload:RemoteSourceMaterializationPayload}).strict(),
]);
export type ProjectAdminOptions={remoteSourceTmpfs?:string;beforeRemoteSourceRegister?:()=>Promise<void>};

/** No directory enumeration; every component must be a real directory beneath a trusted startup root. */
async function repository(root:ProjectRoot,relative:string){
 if(resolve(root.path)!==root.path||await realpath(root.path)!==root.path)throw new Refusal('PROJECT_ROOT_UNAVAILABLE');
 const rootInfo=await lstat(root.path),uid=process.getuid?.();
 if(uid===undefined||rootInfo.uid!==uid||(rootInfo.mode&0o022)!==0||!rootInfo.isDirectory())throw new Refusal('PROJECT_ROOT_UNAVAILABLE');
 let target=root.path;
 for(const component of relative.split('/')){
  target=join(target,component);
  const info=await lstat(target);if(info.isSymbolicLink()||!info.isDirectory()||info.uid!==uid||(info.mode&0o022)!==0)throw new Refusal('PROJECT_PATH_FORBIDDEN',403);
 }
 const canonical=await realpath(target);
 if(canonical!==target||!canonical.startsWith(root.path+sep))throw new Refusal('PROJECT_PATH_FORBIDDEN',403);
 const identity=await projectRepositoryIdentity(canonical);
 const result=await promisify(execFile)('git',['--no-optional-locks','-C',canonical,'rev-parse','--show-toplevel'],{encoding:'utf8',timeout:5000,
  env:{PATH:process.env.PATH??'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}});
 if(result.stdout.trim()!==canonical)throw new Refusal('PROJECT_REPOSITORY_ROOT_REQUIRED');
 return {repo:canonical,identity};
}
export class ProjectAdmin{
 constructor(readonly ledger:Ledger,readonly roots:readonly ProjectRoot[],readonly privateDirectory:string,readonly options:ProjectAdminOptions={}){}
 async view(principal:string){
  const admin=!!(await this.ledger.pool.query('SELECT 1 FROM ac_control_admins WHERE principal_id=$1',[principal])).rowCount;
  const installation=(await this.ledger.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0];
  if(!installation)throw new Refusal('INSTALLATION_IDENTITY_MISSING');
  const devices=(await this.ledger.pool.query("SELECT id FROM ac_operator_keys WHERE principal_id=$1 AND state='active'",[principal])).rows.map(row=>row.id);
  const remoteSources=(await this.ledger.pool.query(`SELECT m.project_id AS "projectId",m.host_id AS "hostId",m.commit_id AS commit,m.tree_id AS tree,
   'materialized'::text AS state,'not_reviewed'::text AS "reviewStatus" FROM ac_remote_source_materializations m
   JOIN ac_memberships mb ON mb.project_id=m.project_id AND mb.principal_id=$1 ORDER BY m.created_at DESC,m.id LIMIT 100`,[principal])).rows;
  return {principalId:principal,installationId:installation.id,operatorDeviceIds:devices,canRegister:admin,server:{kind:'local',remoteManagement:false},roots:admin?this.roots.map(({id,label})=>({id,label})):[],remoteSources};
 }
 async execute(principal:string,raw:unknown,proof:OperatorProof){
  const command=ProjectAdminCommand.parse(raw);
  const authorize=async(c:import('pg').PoolClient)=>{
   if(!(await c.query('SELECT 1 FROM ac_control_admins WHERE principal_id=$1 FOR SHARE',[principal])).rowCount)throw new Refusal('CONTROL_ADMIN_REQUIRED',403);
   await new Operators(this.ledger).verify(c,principal,command,proof);
  };
  // Authenticate before touching the filesystem, and again in the committing transaction.
  const {deliveryAttemptId,...semantic}=command,hash=digest({principal,...semantic});
  const delivery=async(c:import('pg').PoolClient)=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))',[deliveryAttemptId]);
   const prior=(await c.query('SELECT intent_id FROM ac_project_admin_deliveries WHERE id=$1',[deliveryAttemptId])).rows[0];
   if(prior&&prior.intent_id!==command.intentId)throw new Refusal('PROJECT_ADMIN_DELIVERY_CONFLICT');
   if(!prior)await c.query('INSERT INTO ac_project_admin_deliveries(id,intent_id) VALUES($1,$2)',[deliveryAttemptId,command.intentId]);
  };
  const replay=await this.ledger.tx(async c=>{
   await authorize(c);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,2))',[command.intentId]);
   const prior=(await c.query('SELECT payload_digest,result FROM ac_project_admin_intents WHERE id=$1',[command.intentId])).rows[0];
   if(prior&&prior.payload_digest!==hash)throw new Refusal('PROJECT_ADMIN_INTENT_CONFLICT');
   if(prior)await delivery(c);
   return prior?.result;
  });
  if(replay)return replay;
  if(command.action==='project.materializeRemoteSource')return materializeRemoteProjectSource(this,principal,command,hash,authorize,delivery);
  const root=this.roots.find(item=>item.id===command.payload.rootId);
  if(!root)throw new Refusal('PROJECT_ROOT_FORBIDDEN',403);
  const privatePath=resolve(this.privateDirectory),candidate=resolve(root.path,command.payload.relativePath);
  if(privatePath!==this.privateDirectory||candidate===privatePath||candidate.startsWith(privatePath+sep)||privatePath.startsWith(candidate+sep))throw new Refusal('PROJECT_PRIVATE_DIRECTORY_CONFLICT',403);
  let checked:Awaited<ReturnType<typeof repository>>;
  try{checked=await repository(root,command.payload.relativePath);}catch(error){if(error instanceof Refusal)throw error;throw new Refusal('PROJECT_REPOSITORY_UNAVAILABLE');}
  const {repo,identity}=checked;
  if(privatePath!==this.privateDirectory||repo===privatePath||repo.startsWith(privatePath+sep)||privatePath.startsWith(repo+sep))throw new Refusal('PROJECT_PRIVATE_DIRECTORY_CONFLICT',403);
  try{const second=await projectRepositoryIdentity(repo);if(JSON.stringify(identity)!==JSON.stringify(second))throw Error('changed');}
  catch{throw new Refusal('PROJECT_REPOSITORY_UNAVAILABLE');}
  return this.ledger.tx(async c=>{
   await authorize(c);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,2))',[command.intentId]);
   await c.query('SELECT pg_advisory_xact_lock(189234,37)');
   const prior=(await c.query('SELECT payload_digest,result FROM ac_project_admin_intents WHERE id=$1',[command.intentId])).rows[0];
   if(prior){if(prior.payload_digest!==hash)throw new Refusal('PROJECT_ADMIN_INTENT_CONFLICT');await delivery(c);return prior.result;}
   if(!(await c.query('SELECT enabled FROM ac_admission_control WHERE id=1 FOR SHARE')).rows[0]?.enabled)throw new Refusal('ADMISSION_CLOSED');
   if((await c.query('SELECT 1 FROM ac_projects WHERE id=$1',[command.payload.projectId])).rowCount||
      (await c.query('SELECT 1 FROM ac_project_repositories WHERE repo=$1',[repo])).rowCount)throw new Refusal('INSTALLATION_PROJECT_CONFLICT');
   await c.query('INSERT INTO ac_projects(id,label) VALUES($1,$2)',[command.payload.projectId,command.payload.label]);
   await c.query("INSERT INTO ac_memberships(project_id,principal_id,role) VALUES($1,$2,'owner')",[command.payload.projectId,principal]);
   await c.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[command.payload.projectId,repo]);
   await c.query('INSERT INTO ac_project_repository_identity(project_id,repo_dev,repo_ino,git_dev,git_ino,root_id,root_path,relative_path) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[command.payload.projectId,identity.repoDev,identity.repoIno,identity.gitDev,identity.gitIno,root.id,root.path,command.payload.relativePath]);
   const result={state:'applied',projectId:command.payload.projectId};
   await c.query('INSERT INTO ac_project_admin_intents(id,principal_id,payload_digest,action,result) VALUES($1,$2,$3,$4,$5)',[command.intentId,principal,hash,command.action,result]);
   await delivery(c);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES(NULL,'project.register',$1)",[{projectId:command.payload.projectId,principal,rootId:root.id,intentId:command.intentId}]);
   return result;
  });
 }
}
