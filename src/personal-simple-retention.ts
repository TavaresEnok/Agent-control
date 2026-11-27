import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,opendir,readdir,readFile,realpath,unlink} from 'node:fs/promises';
import {basename,join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {withInstallationImageLock} from './personal-image-lock.ts';
import {Ledger} from './ledger.ts';
import type {Installation} from './installation.ts';
import {inventoryJobWork,releaseRegisteredDirectory} from './native-work-retention.ts';
import {releaseIdleSharedWorktrees,removeSimpleWorktree,worktreeGit} from './simple-worktree.ts';
import {terminalWorkLockKey} from './native-execution-shared.ts';
import {defaultProcessInside,mountedInside,protectedDigests} from './personal-artifact-retention.ts';

const execute=promisify(execFile);
const docker=async(args:string[])=>(await execute('docker',args,{timeout:600000,maxBuffer:16*1024*1024})).stdout.trim();
const words=(s:string)=>s.split(/\s+/).filter(Boolean);
const overlap=(a:string,b:string)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep);
const day=86400000;
const protectedName=(name:string)=>name.includes('agent-control-exam-tools:simple')||/chatisp.*homolog|ac-test-db-journal|(?:^|[/:_-])design(?:[/:_-]|$)/i.test(name);

async function containers(all:boolean){
 const ids=words(await docker(['container','ls',...(all?['-a']:[]),'-q']));
 return ids.length?JSON.parse(await docker(['container','inspect',...ids])) as {Image:string;Mounts:{Source:string}[]}[]:[];
}

const activeMounts=async()=>(await containers(false)).flatMap(c=>c.Mounts.map(m=>m.Source));
type JobInstallation=Pick<Installation,'project'|'projects'|'databaseUrl'|'dataDirectory'>&{
 nativeBootstrap?:{state:'active';execution:{hostRoot:string}}|{state:'bench'|'disabled'|'configured'};
};
export async function simpleJobRetention(config:JobInstallation,apply:boolean,mounts:()=>Promise<string[]>=activeMounts){
 const boot=config.nativeBootstrap;
 if(boot?.state!=='active')return [];
 const root=boot.execution.hostRoot;
 const {ids}=await inventoryJobWork(root);
 const ledger=new Ledger(config.databaseUrl);
 const liveMounts=await mounts();
 const lines:string[]=[];
 try{
  const rows=await ledger.pool.query<{id:string;repo:string|null}>(`SELECT j.id,r.repo FROM (
    SELECT j.id,j.context_id,j.state FROM ac_native_execution_jobs j
    WHERE j.role <> 'programmer' OR j.receipt#>'{payload,artifact}' = 'null'::jsonb
     OR j.receipt#>'{payload,executionStarted}' = 'false'::jsonb OR EXISTS (
     SELECT 1 FROM ac_artifacts a WHERE a.context_id=j.context_id AND a.intent_id=j.intent_id
      AND a.implementation_grant_id=j.grant_id AND a.implementation_session_id=j.session_id
      AND a.commit_id=j.receipt#>>'{payload,artifact,commit}' AND a.tree_id=j.receipt#>>'{payload,artifact,tree}'
      AND a.base_id=j.base_id)
    UNION ALL
    SELECT id,context_id,state FROM ac_native_qa_jobs) j JOIN ac_contexts x ON x.id=j.context_id
    LEFT JOIN ac_project_repositories r ON r.project_id=x.project_id
    WHERE j.id=ANY($1::uuid[]) AND j.state IN ('completed','failed','canceled','cancelled')`,[ids]);
  for(const {id,repo} of rows.rows){
   await ledger.tx(async c=>{
    if(!(await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) ok',[terminalWorkLockKey(id)])).rows[0].ok)return;
    for(const leaf of ['work','review-artifact']){
     const path=join(root,id,leaf);
     const stat=await lstat(path,{bigint:true}).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
     if(!stat?.isDirectory()||await realpath(path)!==path||liveMounts.some(m=>overlap(m,path)))continue;
     if(apply){
      const linked=await lstat(join(path,'.git')).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
      if(linked?.isFile()){
       if(!repo||![config.project,...config.projects].some(project=>project.repo===repo))continue;
       await execute('git',['-C',repo,'worktree','remove','--force','--',path]);
      }
      else await releaseRegisteredDirectory(path,{dev:String(stat.dev),ino:String(stat.ino)});
     }
     lines.push((apply?'Removido ':'Elegível ')+path);
    }
   });
  }
  for(const project of [config.project,...config.projects])lines.push(...await releaseIdleSharedWorktrees(config.dataDirectory,project.repo,apply));
  return lines;
 }finally{await ledger.close();}
}

type Image={Id:string;RepoTags:string[]|null;RepoDigests:string[]|null;Config:{Labels?:Record<string,string>|null;Entrypoint?:string[]|null;Cmd?:string[]|null}};
export function removableSimpleImage(image:Image,pins:Set<string>,used:Set<string>){
 const names=[...(image.RepoTags??[]),...(image.RepoDigests??[])];
 const owned=names.some(n=>/^(?:localhost:\d+\/)?(?:ac-|agent-control-)/.test(n))||/\/(?:opt\/banco\/collector\.rb|(?:qa|prontidao|desempenho|arquitetura|dependencias|conformidade|documentacao)-entrypoint\.sh)/.test(JSON.stringify(image.Config.Entrypoint));
 return owned&&!used.has(image.Id)&&!pins.has(image.Id)&&!names.some(n=>protectedName(n)||pins.has(n)||pins.has(n.split('@').at(-1)!))
  && !protectedName(JSON.stringify(image.Config));
}

export function oldTestVolume(volume:{Name:string;CreatedAt:string;Labels?:Record<string,string>|null},now:number){
 const project=volume.Labels?.['com.docker.compose.project']??'';
 const logical=volume.Labels?.['com.docker.compose.volume']??'';
 return !protectedName(volume.Name+' '+project)&&now-Date.parse(volume.CreatedAt)>day&&
  (/^ac-(?:test|lab|implementation|continuation)(?:-|$)/.test(project)&&/^(?:sandbox-pg|test-db|test-postgres)$/.test(logical)||
  /^ac-(?:test-db|test-pg|qa-db)-[a-z0-9-]+$/.test(volume.Name));
}

export async function simpleDockerRetention(config:Installation,apply:boolean){
 return withInstallationImageLock(config.dataDirectory,false,()=>retainDockerResources(config,apply));
}

async function retainDockerResources(config:Installation,apply:boolean){
 const lines:string[]=[];
 const guards=await protectedDigests(config,{},async args=>({stdout:await docker(args),code:0}));
 const pins=new Set([...guards.pinned,...guards.retired,...guards.foreign]);
 const used=new Set((await containers(true)).map(c=>c.Image));
 const ids=[...new Set(words(await docker(['image','ls','-aq','--no-trunc'])))];
 const images:Image[]=ids.length?JSON.parse(await docker(['image','inspect',...ids])):[];
 for(const image of images){
  if(!removableSimpleImage(image,pins,used))continue;
  // Never force removal. With multiple tags, deleting by ID fails safely; avoid
  // dropping a tag that has since moved to a newer build.
  try{
   if(apply){
    const fresh=await protectedDigests(config,{},async args=>({stdout:await docker(args),code:0}));
    const [current]=JSON.parse(await docker(['image','inspect',image.Id]));
    const currentPins=new Set([...fresh.pinned,...fresh.foreign,...fresh.retired]);
    if(!removableSimpleImage(current,currentPins,used))continue;
    await docker(['image','rm',image.Id]);
   }
   lines.push((apply?'Imagem removida ':'Imagem elegível ')+image.Id);
  }catch{lines.push('Imagem preservada pelo Docker '+image.Id);}
 }
 for(const name of words(await docker(['volume','ls','-q','--filter','dangling=true']))){
  const [volume]=JSON.parse(await docker(['volume','inspect',name]));
  if(!oldTestVolume(volume,Date.now()))continue;
  if(apply)await docker(['volume','rm',name]);
  lines.push((apply?'Volume removido ':'Volume elegível ')+name);
 }
 lines.push(apply?await docker(['builder','prune','--all','--force']):'Cache de build sem uso elegível.');
 return lines;
}

const protectedTempName=(name:string)=>protectedName(name)||/backup|verifica[cç][oõ]es|^PG_VERSION$|^basebackup|\.(?:dump|sql|backup)(?:\.|$)/i.test(name);
export async function discardableTempContents(path:string,device:bigint,cutoff:number,reviewRoot?:'clone'|'worktree',cleanCheckout=false):Promise<boolean>{
 const entries=await opendir(path);
 for await(const entry of entries){
  const gitMetadata=entry.name==='.git';
  if(gitMetadata&&!(reviewRoot==='clone'&&entry.isDirectory()||reviewRoot==='worktree'&&entry.isFile()))return false;
  // The clean clone's tracked files (including SQL migrations) are in the project.
  // Standalone temporaries and the contents of .git keep the protected-name checks.
  const tracked=!gitMetadata&&(cleanCheckout||reviewRoot==='clone');
  if(!tracked&&protectedTempName(entry.name))return false;
  const child=join(path,entry.name),info=await lstat(child,{bigint:true});
  if(info.dev!==device||info.uid!==BigInt(process.getuid!())||Number(info.mtimeMs)>cutoff)return false;
  if(info.isDirectory()&&!await discardableTempContents(child,device,cutoff,undefined,tracked))return false;
 }
 return true;
}

type TempInstallation=Pick<Installation,'dataDirectory'|'project'|'projects'>;

async function oldReviewerRepository(config:TempInstallation,path:string){
 const git=await lstat(join(path,'.git')).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
 if(git?.isDirectory()){
  // A standalone clone can own other worktrees or unpublished branches.
  const checkouts=await worktreeGit(path,['worktree','list','--porcelain','-z']);
  if(checkouts.split('\0\0').filter(Boolean).length!==1)return;
  if(await worktreeGit(path,['status','--porcelain','-z','--untracked-files=all','--ignored']))return;
  const tips=(await worktreeGit(path,['rev-parse','HEAD','--all'])).trim().split(/\s+/);
  for(const project of [config.project,...config.projects]){
   try{
    if(await worktreeGit(project.repo,['rev-list','--max-count=1',...tips,'--not','--all']))continue;
    return {kind:'clone' as const};
   }catch{continue;}
  }
  return;
 }
 if(!git?.isFile())return;
 for(const project of [config.project,...config.projects]){
  const list=await worktreeGit(project.repo,['worktree','list','--porcelain','-z']).catch(()=>'' /* absent project cannot own the checkout */);
  const record=list.split('\0\0').slice(1).find(row=>row.startsWith('worktree '+path+'\0'));
  if(!record||record.includes('\0locked')||record.includes('\0prunable'))continue;
  const tip=record.split('\0').find(field=>field.startsWith('HEAD '))?.slice(5);
  if(!tip||!/^([a-f0-9]{40})$/.test(tip))continue;
  const status=await worktreeGit(path,['status','--porcelain','-z','--untracked-files=all','--ignored']);
  if(status)continue;
  try{await worktreeGit(project.repo,['merge-base','--is-ancestor',tip,'HEAD']);}catch{continue;}
  return {kind:'worktree' as const,repo:project.repo};
 }
}

export async function simpleTempRetention(config:TempInstallation,apply:boolean){
 const root=await realpath(tmpdir()),mounts=await readFile('/proc/self/mountinfo','utf8');
 const protectedPaths=[config.dataDirectory,...[config.project,...config.projects].map(p=>p.repo),
  ...(await containers(true)).flatMap(c=>c.Mounts.map(m=>m.Source))];
 const lines:string[]=[];
 for(const entry of await readdir(root,{withFileTypes:true})){
  if(!(entry.isDirectory()||entry.isFile())||!/^(?:ac-|chatisp-)[A-Za-z0-9._-]{1,120}$/.test(entry.name)||protectedTempName(entry.name))continue;
  const path=resolve(root,entry.name),info=await lstat(path,{bigint:true});
  if(info.uid!==BigInt(process.getuid!())||Date.now()-Number(info.mtimeMs)<day||protectedPaths.some(p=>overlap(p,path))||mountedInside(mounts,path)||await defaultProcessInside(path))continue;
  // Git checkouts may be unmerged worker branches. Registered worker worktrees
  // use the existing merge and clean-tree checks in artifact retention.
  if(entry.isDirectory()){
   const review=/(?:review|revis[aã]o|revisor)/i.test(entry.name)?await oldReviewerRepository(config,path).catch(()=>undefined):undefined;
   if(!await discardableTempContents(path,info.dev,Date.now()-day,review?.kind).catch(()=>false /* unreadable content must be preserved */))continue;
   if(apply){
    if(review?.kind==='worktree')await removeSimpleWorktree(review.repo,path);
    else await releaseRegisteredDirectory(path,{dev:String(info.dev),ino:String(info.ino)});
   }
  }else{
   if(/\.(?:tar|gz|xz|zst|zip|7z|oci)(?:\.|$)/i.test(entry.name))continue;
   const current=await lstat(path,{bigint:true});
   if(current.dev!==info.dev||current.ino!==info.ino||current.mtimeNs!==info.mtimeNs)continue;
   if(apply)await unlink(path);
  }
  lines.push((apply?'Temporário removido ':'Temporário elegível ')+basename(path));
 }
 return lines;
}
