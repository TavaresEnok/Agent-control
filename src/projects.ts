import {realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Ledger} from './ledger.ts';
import {Refusal} from './contracts.ts';
import type {CezarRuntime} from './cezar.ts';
import {projectRepositoryIdentity,validateTrustedProjectPath} from './project-repository.ts';

export type ProjectDefinition={id:string;label:string;repo:string;owner:string};
export type ProjectSummary={id:string;label:string;role:'owner'|'operator'|'viewer'};
export class Projects {
 constructor(readonly ledger:Ledger,readonly projectRoots:readonly {id:string;path:string}[]=[]){}
 async register(definitions:readonly ProjectDefinition[],controlAdmin?:string){
  // Filesystem validation precedes the transaction; no runtime lock is acquired here.
  for(const project of definitions){
   if(await realpath(project.repo)!==project.repo)throw new Refusal('NON_CANONICAL_PROJECT_REPOSITORY');
   const git=await promisify(execFile)('git',['-C',project.repo,'rev-parse','--show-toplevel'],{encoding:'utf8',timeout:5000});
   if(git.stdout.trim()!==project.repo)throw new Refusal('PROJECT_REPOSITORY_ROOT_REQUIRED');
  }
  await this.ledger.tx(async c=>{
   // Serialize all project installation changes, including uniqueness checks.
   await c.query('SELECT pg_advisory_xact_lock(189234,37)');
   for(const p of definitions){
    const prior=(await c.query('SELECT p.label,r.repo FROM ac_projects p LEFT JOIN ac_project_repositories r ON r.project_id=p.id WHERE p.id=$1',[p.id])).rows[0];
    if(prior){
     if(prior.label!==p.label||(prior.repo&&prior.repo!==p.repo)||!(await c.query("SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner'",[p.id,p.owner])).rowCount)throw new Refusal('INSTALLATION_PROJECT_CONFLICT');
    }else{
     await c.query('INSERT INTO ac_projects(id,label) VALUES($1,$2)',[p.id,p.label]);
     await c.query("INSERT INTO ac_memberships(project_id,principal_id,role) VALUES($1,$2,'owner')",[p.id,p.owner]);
    }
    const other=await c.query('SELECT 1 FROM ac_project_repositories WHERE repo=$1 AND project_id<>$2',[p.repo,p.id]);
    if(other.rowCount)throw new Refusal('INSTALLATION_PROJECT_CONFLICT');
    await c.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2) ON CONFLICT(project_id) DO NOTHING',[p.id,p.repo]);
   }
   if(controlAdmin)await c.query('INSERT INTO ac_control_admins VALUES($1) ON CONFLICT DO NOTHING',[controlAdmin]);
  });
 }
 async list(principal:string):Promise<ProjectSummary[]>{
  return (await this.ledger.pool.query(`SELECT p.id,p.label,m.role FROM ac_projects p JOIN ac_project_repositories r ON r.project_id=p.id JOIN ac_memberships m ON m.project_id=p.id WHERE m.principal_id=$1 ORDER BY p.label,p.id`,[principal])).rows;
 }
 async listNative(principal:string){
  const rows=(await this.ledger.pool.query(`SELECT p.id,p.label,r.repo,r.registered_at FROM ac_projects p JOIN ac_project_repositories r ON r.project_id=p.id JOIN ac_memberships m ON m.project_id=p.id WHERE m.principal_id=$1 ORDER BY p.label,p.id`,[principal])).rows;
  return Promise.all(rows.map(async row=>{
   let status:'ok'|'missing'|'not-git'='missing';
   try{
    if(await realpath(row.repo)===row.repo){
     status='not-git';
     try{const git=await promisify(execFile)('git',['-C',row.repo,'rev-parse','--show-toplevel'],{encoding:'utf8',timeout:5000});if(git.stdout.trim()===row.repo)status='ok';}catch{}
    }
   }catch{}
   const addedAt=(row.registered_at as Date).toISOString();
   return {id:row.id as string,name:row.label as string,root:row.repo as string,addedAt,lastOpenedAt:addedAt,source:'local' as const,status};
  }));
 }
 async authorized(principal:string,id:string):Promise<{id:string;repo:string}|null>{
  const row=(await this.ledger.pool.query(`SELECT p.id,r.repo,i.repo_dev,i.repo_ino,i.git_dev,i.git_ino,i.root_id,i.root_path,i.relative_path FROM ac_projects p JOIN ac_project_repositories r ON r.project_id=p.id JOIN ac_memberships m ON m.project_id=p.id LEFT JOIN ac_project_repository_identity i ON i.project_id=p.id WHERE p.id=$1 AND m.principal_id=$2`,[id,principal])).rows[0];
  if(!row)return null;
  if(row.repo_dev!==null){
   try{if(!this.projectRoots.some(root=>root.id===row.root_id&&root.path===row.root_path)||await validateTrustedProjectPath(row.root_path,row.relative_path)!==row.repo)throw Error('root changed');
    const identity=await projectRepositoryIdentity(row.repo);if(identity.repoDev!==row.repo_dev||identity.repoIno!==row.repo_ino||identity.gitDev!==row.git_dev||identity.gitIno!==row.git_ino)throw Error('changed');}
   catch{throw new ProjectUnavailable('PROJECT_REPOSITORY_IDENTITY_CHANGED');}
  }
  return {id:row.id,repo:row.repo};
 }
}
export class ProjectUnavailable extends Error {}
/** Four lifetime advisory-lock clients leave four of Ledger's eight clients available.
 * Concurrent first requests share one promise and no transaction is held during startup. */
export class ProjectRuntimes {
 private readonly runtimes=new Map<string,Promise<CezarRuntime>>();
 private closing=false;
 constructor(private readonly create:(project:{id:string;repo:string})=>Promise<CezarRuntime>,readonly limit=4){if(!Number.isInteger(limit)||limit<1||limit>4)throw Error('INVALID_RUNTIME_LIMIT');}
 async get(project:{id:string;repo:string}){
  if(this.closing)throw new ProjectUnavailable('RUNTIME_SHUTTING_DOWN');
  const existing=this.runtimes.get(project.id);if(existing)return existing;
  if(this.runtimes.size>=this.limit)throw new ProjectUnavailable('PROJECT_RUNTIME_LIMIT');
  const pending=this.create(project);this.runtimes.set(project.id,pending);
  try{return await pending;}catch(error){this.runtimes.delete(project.id);throw error;}
 }
 async close(){this.closing=true;const all=await Promise.allSettled(this.runtimes.values());this.runtimes.clear();await Promise.all(all.flatMap(x=>x.status==='fulfilled'?[x.value.close()]:[]));}
}
