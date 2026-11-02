import {lstat,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
export async function validateTrustedProjectPath(root:string,relative:string){
 if(resolve(root)!==root||await realpath(root)!==root||relative.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('PROJECT_ROOT_UNAVAILABLE');
 const uid=process.getuid?.();if(uid===undefined)throw Error('PROJECT_ROOT_UNAVAILABLE');
 let current=root;
 for(const part of ['',...relative.split('/')]){
  if(part)current=join(current,part);
  const info=await lstat(current);
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==uid||(info.mode&0o022)!==0)throw Error('PROJECT_PATH_FORBIDDEN');
 }
 return current;
}
/** Canonical identities detect replacement; they do not lock a hostile filesystem. */
export async function projectRepositoryIdentity(repo:string){
 if(resolve(repo)!==repo||await realpath(repo)!==repo)throw Error('PROJECT_REPOSITORY_IDENTITY_CHANGED');
 const git=join(repo,'.git'),repository=await lstat(repo,{bigint:true}),metadata=await lstat(git,{bigint:true});
 const uid=process.getuid?.();
 if(uid===undefined||repository.uid!==BigInt(uid)||metadata.uid!==BigInt(uid)||(repository.mode&0o022n)!==0n||(metadata.mode&0o022n)!==0n||
  !repository.isDirectory()||!metadata.isDirectory()||metadata.isSymbolicLink()||await realpath(git)!==git)throw Error('PROJECT_REPOSITORY_IDENTITY_CHANGED');
 return {repoDev:String(repository.dev),repoIno:String(repository.ino),gitDev:String(metadata.dev),gitIno:String(metadata.ino)};
}
