import {execFile} from 'node:child_process';
import {lstat,readdir,realpath,stat} from 'node:fs/promises';
import {join,sep} from 'node:path';
import {promisify} from 'node:util';
import {Refusal} from './contracts.ts';

export type PersonalFolderRoot={id:string;label:string;path:string};
export type PersonalFolder={name:string;path:string;git:boolean;project:boolean};
const runGit=promisify(execFile);

/** Direct child folders of one allowed root. Never returns file contents. */
export async function listPersonalFolders(input:{roots:readonly PersonalFolderRoot[];projectRepos:readonly string[];root?:string;path?:string}){
 if(!input.root)return {roots:input.roots.map(({id,label})=>({id,label}))};
 const root=input.roots.find(item=>item.id===input.root);
 if(!root)throw new Refusal('PROJECT_ROOT_FORBIDDEN',403);
 const relative=normalizeRelative(input.path??'');
 const directory=await resolvePersonalFolder(root,relative);
 const projects=await canonicalRepos(input.projectRepos);
 const names=(await readdir(directory)).filter(name=>!name.startsWith('.')).sort((left,right)=>left.localeCompare(right,'en'));
 const folders:PersonalFolder[]=[];
 for(const name of names){
  if(folders.length>=500)break;
  const logical=relative?relative+'/'+name:name;
  const entry=join(directory,name);
  let info;try{info=await lstat(entry);}catch{continue;}
  if(!info.isDirectory()&&!info.isSymbolicLink())continue;
  let real:string;
  try{real=await realpath(entry);}catch{continue;}
  if(!insideRoot(root.path,real))continue;
  let directoryInfo;try{directoryInfo=await stat(real);}catch{continue;}
  if(!directoryInfo.isDirectory())continue;
  folders.push({name,path:logical,git:await gitRootWithBranch(real),project:projects.has(real)});
 }
 return {root:root.id,path:relative,folders};
}

/**
 * Absolute directory for a relative path. `..`, an absolute path and a symlink that
 * leaves the root are the same refusal. A symlink that stays inside the root is kept.
 */
export async function resolvePersonalFolder(root:PersonalFolderRoot,relative:string){
 if(root.path!==(await realpath(root.path).catch(()=>'')))throw new Refusal('PROJECT_ROOT_UNAVAILABLE');
 let current=root.path;
 if(!relative)return current;
 for(const part of relative.split('/')){
  if(!part||part==='.'||part==='..')throw new Refusal('PROJECT_PATH_FORBIDDEN',403);
  const next=join(current,part);
  let info;try{info=await lstat(next);}catch{throw new Refusal('PROJECT_PATH_FORBIDDEN',403);}
  if(!info.isDirectory()&&!info.isSymbolicLink())throw new Refusal('PROJECT_PATH_FORBIDDEN',403);
  let real:string;try{real=await realpath(next);}catch{throw new Refusal('PROJECT_PATH_FORBIDDEN',403);}
  if(!insideRoot(root.path,real))throw new Refusal('PROJECT_PATH_FORBIDDEN',403);
  let resolved;try{resolved=await stat(real);}catch{throw new Refusal('PROJECT_PATH_FORBIDDEN',403);}
  if(!resolved.isDirectory())throw new Refusal('PROJECT_PATH_FORBIDDEN',403);
  current=real;
 }
 return current;
}

function normalizeRelative(path:string){
 if(path.includes('\\')||path.startsWith('/')||/[\u0000-\u001f\u007f]/.test(path)||path.length>512)throw new Refusal('PROJECT_PATH_FORBIDDEN',403);
 const trimmed=path.replace(/\/+$/,'');
 if(!trimmed)return '';
 if(trimmed.split('/').some(part=>!part||part==='.'||part==='..'))throw new Refusal('PROJECT_PATH_FORBIDDEN',403);
 return trimmed;
}
function insideRoot(root:string,candidate:string){return candidate===root||candidate.startsWith(root+sep);}
/** Second check at registration: the canonical path must still sit inside the root. */
export async function assertRepositoryInsideRoot(root:string,repository:string){
 let rootReal:string,repoReal:string;
 try{rootReal=await realpath(root);repoReal=await realpath(repository);}
 catch{throw new Error('PROJECT_PATH_FORBIDDEN');}
 if(!insideRoot(rootReal,repoReal))throw new Error('PROJECT_PATH_FORBIDDEN');
}
async function canonicalRepos(repos:readonly string[]){
 const paths=new Set<string>();
 for(const repo of repos){try{paths.add(await realpath(repo));}catch{paths.add(repo);}}
 return paths;
}
async function gitRootWithBranch(folder:string){
 const git=async(args:string[])=>{
  try{return (await runGit('git',['--no-optional-locks','-C',folder,...args],{encoding:'utf8',timeout:5000,
   env:{PATH:process.env.PATH??'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}})).stdout.trim();}
  catch{return undefined;}
 };
 if(await git(['rev-parse','--is-inside-work-tree'])!=='true')return false;
 const top=await git(['rev-parse','--show-toplevel']);
 if(!top)return false;
 let topReal:string;try{topReal=await realpath(top);}catch{return false;}
 if(topReal!==folder)return false;
 return (await git(['symbolic-ref','--short','HEAD']))!==undefined;
}
