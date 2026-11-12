import {chmod,readFile,rename,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname,join} from 'node:path';
import {resolvePersonalFolder,type PersonalFolderRoot} from './personal-folders.ts';
import {Refusal} from './contracts.ts';
import {Installation,loadInstallation} from './installation.ts';
import type {Ledger} from './ledger.ts';

let personalProjectBusy=false;

export type PersonalProjectCreateResult={projectId:string;restarting:boolean;restartRequired:boolean};

/** One project create or archive at a time. The remote clone uses the same lock. */
export async function withPersonalProjectCreation<T>(work:()=>Promise<T>):Promise<T>{
 if(personalProjectBusy)throw new Refusal('PROJECT_CREATION_BUSY',409);
 personalProjectBusy=true;
 try{return await work();}
 finally{personalProjectBusy=false;}
}

/**
 * Resolves a folder inside an allowed root and attaches it with the phase 2 module.
 * A second call while the first has not finished is refused. The process restart,
 * when systemd is supervising, is scheduled by the caller after the response.
 */
export async function createPersonalProject(input:{
 installationPath:string;roots:readonly PersonalFolderRoot[];rootId:string;relativePath:string;label:string;underSystemd:boolean;
 addPersonalProject:(installationPath:string,repository:string,label:string,insideRoot:string)=>Promise<{projectId:string}>;
}):Promise<PersonalProjectCreateResult>{
 const root=input.roots.find(item=>item.id===input.rootId);
 if(!root)throw new Refusal('PROJECT_ROOT_FORBIDDEN',403);
 const label=input.label.trim();
 if(label.length<1||label.length>200||/[\u0000-\u001f\u007f]/.test(label))throw new Refusal('LABEL_INVALID',400);
 return withPersonalProjectCreation(async()=>{
  try{
   const repository=await resolvePersonalFolder(root,input.relativePath);
   const created=await input.addPersonalProject(input.installationPath,repository,label,root.path);
   const restarting=input.underSystemd;
   return {projectId:created.projectId,restarting,restartRequired:!restarting};
  }catch(error){
   if(error instanceof Refusal)throw error;
   if(error instanceof Error&&/^[A-Z][A-Z0-9_]{2,80}$/.test(error.message))throw new Refusal(error.message,error.message==='DATA_DIRECTORY_PATH_FORBIDDEN'||error.message==='PERSONAL_ACTIVATION_REQUIRED'||error.message==='PROJECT_PATH_FORBIDDEN'?403:409);
   throw error;
  }
 });
}

/** Removes a secondary project from the installation and archives its contexts. Repository files and the Happier conversation stay. */
export async function archivePersonalProject(input:{installationPath:string;projectId:string;ledger:Ledger;underSystemd:boolean}):Promise<PersonalProjectCreateResult>{
 return withPersonalProjectCreation(async()=>{
  const config=await loadInstallation(input.installationPath);
  if(input.projectId===config.project.id)throw new Refusal('PRIMARY_PROJECT_FORBIDDEN',403);
  const inFile=config.projects.some(project=>project.id===input.projectId);
  const inDb=Boolean((await input.ledger.pool.query('SELECT 1 FROM ac_projects WHERE id=$1',[input.projectId])).rowCount);
  if(!inFile&&!inDb)throw new Refusal('PROJECT_NOT_FOUND',404);
  if(inFile){
   const raw=JSON.parse(await readFile(input.installationPath,'utf8')) as {projects?:unknown;managerTransport?:Installation['managerTransport']};
   raw.projects=config.projects.filter(project=>project.id!==input.projectId);
   if(config.managerTransport)raw.managerTransport={...config.managerTransport,contexts:config.managerTransport.contexts.filter(item=>item.projectId!==input.projectId)};
   if(!Installation.safeParse(raw).success)throw new Refusal('INVALID_INSTALLATION',409);
   await backupArchive(input.installationPath);
   await writePrivate(input.installationPath,JSON.stringify(raw,null,2)+'\n');
  }
  if(inDb)await input.ledger.tx(async client=>{
   await client.query('UPDATE ac_contexts SET archived=true WHERE project_id=$1 AND NOT archived',[input.projectId]);
   await client.query('DELETE FROM ac_project_repositories WHERE project_id=$1',[input.projectId]);
  });
  const restarting=input.underSystemd;
  return {projectId:input.projectId,restarting,restartRequired:!restarting};
 });
}

async function backupArchive(installationPath:string){
 const target=join(dirname(installationPath),'installation.json.before-archive');
 try{await writeFile(target,await readFile(installationPath),{mode:0o600,flag:'wx'});}
 catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 await chmod(target,0o600);
}
async function writePrivate(path:string,content:string){
 const temporary=path+'.'+randomUUID()+'.tmp';
 await writeFile(temporary,content,{mode:0o600,flag:'wx'});await chmod(temporary,0o600);await rename(temporary,path);
}
