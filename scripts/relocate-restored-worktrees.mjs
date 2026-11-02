// Repairs only Git pointer files in an authenticated synthetic restore copy.
import {readFile,writeFile,realpath,lstat,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(new URL('..',import.meta.url).pathname),argument=process.argv[2];
if(!argument)throw Error('RESTORED_DIRECTORY_REQUIRED');
const restored=await realpath(argument),allowed=await realpath(join(root,'.state/restores'));
if(!restored.startsWith(allowed+sep))throw Error('RESTORE_OUTSIDE_ISOLATED_AREA');
const manifest=JSON.parse(await readFile(join(restored,'MANIFEST.json'),'utf8'));
if(manifest.scope!=='isolated-synthetic-lab'||manifest.root!==root||!Array.isArray(manifest.files))throw Error('NOT_A_MATCHING_LAB_BACKUP');
const projects=await realpath(join(restored,'.state/projects')),plans=[],repositories=[];
let linkedWorktrees=0,nativeRunRecords=0;
function mapped(value){
 const original=value.trim();
 if(original.startsWith(projects+sep))return original;
 const prefix=[manifest.root,'/workspace'].find(p=>original.startsWith(p+sep));
 if(!prefix)throw Error('UNKNOWN_GIT_SOURCE_ROOT');
 const relative=original.slice(prefix.length+1);
 if(!relative.startsWith('.state/projects/'))throw Error('GIT_POINTER_OUTSIDE_PROJECTS');
 const target=resolve(restored,relative);
 if(!target.startsWith(projects+sep))throw Error('GIT_POINTER_OUTSIDE_COPY');
 return target;
}
async function regular(path){
 const info=await lstat(path);
 if(!path.startsWith(projects+sep)||!info.isFile()||info.isSymbolicLink()||await realpath(path)!==path)throw Error('UNSAFE_RESTORED_GIT_FILE');
 return readFile(path,'utf8');
}
for(const item of manifest.files.filter(item=>typeof item.path==='string'&&item.path.startsWith('.state/projects/')&&item.path.endsWith('/.git/config'))){
 const configPath=resolve(restored,item.path),config=await regular(configPath),gitDir=dirname(configPath),repository=dirname(gitDir);
 // These fixtures use ordinary standalone object stores. Unknown external config
 // or object references require an explicit importer, never a read of the source.
 if(/^\s*\[(?:include|includeIf|filter|submodule|credential|extensions)(?:\s|\])/im.test(config)||/^\s*(?:worktree\s*=|bare\s*=\s*true)/im.test(config))throw Error('UNSUPPORTED_RESTORED_GIT_CONFIG');
 const alternates=join(gitDir,'objects/info/alternates');
 try{if((await regular(alternates)).trim())throw Error('EXTERNAL_OBJECT_STORE_REFUSED');}catch(error){if(error.code!=='ENOENT')throw error;}
 const worktrees=join(gitDir,'worktrees');
 const entries=await readdir(worktrees).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
 for(const name of entries){
  if(!/^[A-Za-z0-9_-]+$/.test(name))throw Error('INVALID_WORKTREE_METADATA');
  const metadata=join(worktrees,name),pointer=join(metadata,'gitdir'),old=await regular(pointer),newGitFile=mapped(old);
  const linked=await regular(newGitFile),match=linked.match(/^gitdir: (.+)\n?$/);
  if(!match||mapped(match[1])!==metadata||resolve(metadata,(await regular(join(metadata,'commondir'))).trim())!==gitDir)
   throw Error('WORKTREE_BACKLINK_MISMATCH');
  plans.push({path:pointer,before:old,after:newGitFile+'\n'},{path:newGitFile,before:linked,after:'gitdir: '+metadata+'\n'});
  linkedWorktrees++;
 }
 const data=join(repository,'.ai/cezar');
 const lifecycle=await readdir(join(data,'lifecycle')).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
 if(lifecycle.length)throw Error('RESTORED_LIFECYCLE_RECONCILIATION_REQUIRED');
 for(const filename of ['runs.json','runs.json.bak']){
  const path=join(data,filename);
  const before=await regular(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(before===null)continue;
  const runs=JSON.parse(before);if(!Array.isArray(runs))throw Error('UNKNOWN_NATIVE_RUN_INDEX');
  for(const run of runs)if(run.worktreePath){
   if(!/^[a-f0-9-]{36}$/.test(run.id))throw Error('UNKNOWN_NATIVE_RUN_ID');
   const target=mapped(run.worktreePath);
   if(target!==join(repository,'.ai/cezar/worktrees',run.id))throw Error('NATIVE_WORKTREE_SCOPE_MISMATCH');
   run.worktreePath=target;nativeRunRecords++;
  }
  plans.push({path,before,after:JSON.stringify(runs)+'\n'});
 }
 repositories.push(repository);
}
// All pointers have been validated before the first write. No original Git path
// is followed, opened, or passed to Git.
for(const plan of plans)if(plan.before!==plan.after)await writeFile(plan.path,plan.after,{mode:0o600});
for(const repository of repositories){
 const output=execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','safe.directory='+repository,
  '-C',repository,'worktree','list','--porcelain'],{env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'},encoding:'utf8'});
 for(const line of output.split('\n'))if(line.startsWith('worktree ')&&!line.slice(9).startsWith(projects+sep))throw Error('GIT_WORKTREE_ESCAPES_COPY');
}
const fixturePath=join(restored,'.state/browser-fixture.json'),fixture=JSON.parse(await readFile(fixturePath,'utf8'));
fixture.repo=mapped(fixture.repo);await writeFile(fixturePath,JSON.stringify(fixture),{mode:0o600});
const report={scope:'isolated-synthetic-lab',repositories:repositories.length,linkedWorktrees,nativeRunRecords,
 files:plans.map(plan=>({path:plan.path.slice(restored.length+1),beforeSha256:createHash('sha256').update(plan.before).digest('hex'),
 afterSha256:createHash('sha256').update(plan.after).digest('hex')})),fixtureRepoRelocated:true,sourcePathsChanged:false};
await writeFile(join(restored,'WORKTREE_RELOCATION.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({repositories:report.repositories,linkedWorktrees:report.linkedWorktrees,nativeRunRecords,fixtureRepoRelocated:true,sourcePathsChanged:false}));
