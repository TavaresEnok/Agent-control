import {resolvePersonalFolder,type PersonalFolderRoot} from './personal-folders.ts';
import {Refusal} from './contracts.ts';

let personalProjectBusy=false;

export type PersonalProjectCreateResult={projectId:string;restarting:boolean;restartRequired:boolean};

/**
 * Resolves a folder inside an allowed root and attaches it with the phase 2 module.
 * A second call while the first has not finished is refused. The process restart,
 * when systemd is supervising, is scheduled by the caller after the response.
 */
export async function createPersonalProject(input:{
 installationPath:string;roots:readonly PersonalFolderRoot[];rootId:string;relativePath:string;label:string;underSystemd:boolean;
 addPersonalProject:(installationPath:string,repository:string,label:string)=>Promise<{projectId:string}>;
}):Promise<PersonalProjectCreateResult>{
 const root=input.roots.find(item=>item.id===input.rootId);
 if(!root)throw new Refusal('PROJECT_ROOT_FORBIDDEN',403);
 const label=input.label.trim();
 if(label.length<1||label.length>200||/[\u0000-\u001f\u007f]/.test(label))throw new Refusal('LABEL_INVALID',400);
 if(personalProjectBusy)throw new Refusal('PROJECT_CREATION_BUSY',409);
 personalProjectBusy=true;
 try{
  const repository=await resolvePersonalFolder(root,input.relativePath);
  const created=await input.addPersonalProject(input.installationPath,repository,label);
  const restarting=input.underSystemd;
  return {projectId:created.projectId,restarting,restartRequired:!restarting};
 }catch(error){
  if(error instanceof Refusal)throw error;
  if(error instanceof Error&&/^[A-Z][A-Z0-9_]{2,80}$/.test(error.message))throw new Refusal(error.message,error.message==='DATA_DIRECTORY_PATH_FORBIDDEN'||error.message==='PERSONAL_ACTIVATION_REQUIRED'?403:409);
  throw error;
 }finally{personalProjectBusy=false;}
}
