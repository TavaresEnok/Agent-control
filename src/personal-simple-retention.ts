import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,readdir,readFile,readlink,realpath,rename} from 'node:fs/promises';
import {join,sep} from 'node:path';
import {withInstallationImageLock} from './personal-image-lock.ts';
import {Ledger} from './ledger.ts';
import type {Installation} from './installation.ts';
import {inventoryJobWork,releaseRegisteredDirectory} from './native-work-retention.ts';
import {releaseIdleSharedWorktrees} from './simple-worktree.ts';
import {terminalWorkLockKey} from './native-execution-shared.ts';
import {mountedInside,protectedDigests,type RetentionDeps} from './personal-artifact-retention.ts';
import {commonToolTag} from './simple-tools-image.ts';
import {storageSettings} from './storage-config.ts';
import {Id} from './contracts.ts';

export {discardableTempContents,simpleTempRetention} from './temp-retention.ts';

const execute=promisify(execFile);
const docker=async(args:string[])=>(await execute('docker',args,{timeout:600000,maxBuffer:16*1024*1024})).stdout.trim();
const words=(s:string)=>s.split(/\s+/).filter(Boolean);
const overlap=(a:string,b:string)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep);
const day=86400000;

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


// ---- Job directories --------------------------------------------------------------------------------------------

/** Job directories removed per pass, so one pass after a long pause stays short. The rest follow on the next passes. */
export const JOB_DIRECTORY_BATCH=300;
const condemnedJob=/^\.removendo-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Paths at or under `root` that a live process holds as cwd, root or open file. One walk of /proc for the whole pass. */
async function openPathsUnder(root:string){
 const found:string[]=[];
 for(const pid of await readdir('/proc')){
  if(!/^[1-9][0-9]*$/.test(pid))continue;
  try{
   const targets=await Promise.all(['cwd','root'].map(link=>readlink(join('/proc',pid,link)).catch(()=>'')));
   for(const fd of await readdir(join('/proc',pid,'fd')).catch(()=>[] as string[]))targets.push(await readlink(join('/proc',pid,'fd',fd)).catch(()=>''));
   found.push(...targets.filter(target=>overlap(target,root)));
  }catch{/* the process ended */}
 }
 return found;
}

export type JobDirectoryDeps={
 docker?:(args:string[])=>Promise<string>;
 now?:()=>number;
 /** Paths under the host root held by live processes. */
 openPaths?:(root:string)=>Promise<string[]>;
 mountInfo?:()=>Promise<string>;
 /** Calls `each` for every id whose job is terminal in the database, under that job's terminal-work lock. The default reads
  * `ac_native_execution_jobs` and `ac_native_qa_jobs`; a job without a row is never passed. */
 terminalJobs?:(config:JobInstallation,ids:string[],each:(id:string)=>Promise<void>)=>Promise<void>;
 limit?:number;
};

async function defaultTerminalJobs(config:JobInstallation,ids:string[],each:(id:string)=>Promise<void>){
 const ledger=new Ledger(config.databaseUrl);
 try{
  const rows=(await ledger.pool.query<{id:string}>(`SELECT id::text FROM ac_native_execution_jobs WHERE id=ANY($1::uuid[]) AND state IN ('completed','failed')
   UNION SELECT id::text FROM ac_native_qa_jobs WHERE id=ANY($1::uuid[]) AND state IN ('completed','failed')`,[ids])).rows;
  for(const {id} of rows)await ledger.tx(async c=>{
   if((await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) ok',[terminalWorkLockKey(id)])).rows[0].ok)await each(id);
  });
 }finally{await ledger.close();}
}

/** Whole directories of native jobs that are terminal in the database and untouched for `storage.jobDirRetentionDays`. The receipt
 * stays in the database; `work/` and `review-artifact/` must already be gone (the work retention goes first). A job with no row,
 * a live container, a mount, an open file or anything newer stays. The directory is first renamed to `.removendo-<id>` in the
 * host root, so an interrupted removal is finished on the next pass and never mistaken for a live job. */
export async function simpleJobDirectoryRetention(config:JobInstallation&{storage?:unknown},apply:boolean,deps:JobDirectoryDeps={}){
 const boot=config.nativeBootstrap;
 if(boot?.state!=='active')return [];
 const root=boot.execution.hostRoot,now=deps.now??Date.now,run=deps.docker??docker;
 const retentionMs=storageSettings(config).jobDirRetentionDays*86400000;
 const names=await readdir(root);
 const lines:string[]=[];
 for(const name of names){
  if(!condemnedJob.test(name))continue;
  const path=join(root,name),info=await lstat(path,{bigint:true});
  if(!info.isDirectory())continue;
  if(apply)await releaseRegisteredDirectory(path,{dev:String(info.dev),ino:String(info.ino)}).then(()=>lines.push('Pasta de job removida (retomada) '+name),()=>lines.push('Pasta de job em remoção preservada (falha ao remover) '+name));
  else lines.push('Pasta de job em remoção, será concluída '+name);
 }
 const ids=names.filter(name=>Id.safeParse(name).success).sort();
 if(!ids.length)return lines;
 const containerIds=words(await run(['container','ls','-a','-q','--no-trunc']));
 const inspected=containerIds.length?JSON.parse(await run(['container','inspect',...containerIds])) as {Name:string;Mounts?:{Source:string}[]}[]:[];
 const mounts=inspected.flatMap(c=>(c.Mounts??[]).map(m=>m.Source)),names2=new Set(inspected.map(c=>c.Name.replace(/^\//,'')));
 const held=await (deps.openPaths??openPathsUnder)(root);
 const mountText=await (deps.mountInfo??(()=>readFile('/proc/self/mountinfo','utf8')))();
 const old:string[]=[];
 for(const id of ids){
  const path=join(root,id);
  const info=await lstat(path).catch(()=>undefined/* gone meanwhile */);
  if(!info?.isDirectory()||info.uid!==process.getuid?.())continue;
  let newest=info.mtimeMs,busy=false;
  for(const child of await readdir(path).catch(()=>['work']/* unreadable: treated as busy */)){
   if(child==='work'||child==='review-artifact'){busy=true;break;}
   newest=Math.max(newest,(await lstat(join(path,child)).catch(()=>undefined))?.mtimeMs??Infinity);
  }
  if(busy||now()-newest<retentionMs)continue;
  if([...names2].some(name=>name.endsWith('-'+id))||mounts.some(source=>overlap(source,path))||held.some(target=>overlap(target,path))||mountedInside(mountText,path))continue;
  old.push(id);
 }
 const limit=deps.limit??JOB_DIRECTORY_BATCH;
 let done=0,failed=0;
 await (deps.terminalJobs??defaultTerminalJobs)(config,old,async id=>{
  if(done>=limit)return;
  const path=join(root,id);
  if(!apply){done++;return;}
  try{
   const info=await lstat(path,{bigint:true});
   if(!info.isDirectory()||await realpath(path)!==path)return;
   const condemned=join(root,'.removendo-'+id);
   await rename(path,condemned);
   const moved=await lstat(condemned,{bigint:true});
   if(moved.dev!==info.dev||moved.ino!==info.ino)throw Error('job directory changed');
   await releaseRegisteredDirectory(condemned,{dev:String(moved.dev),ino:String(moved.ino)});
   done++;
  }catch{failed++;}
 });
 if(done||failed||old.length)lines.push(`Pastas de job terminais com mais de ${storageSettings(config).jobDirRetentionDays} dia(s): ${done} ${apply?'removida(s)':'elegível(is)'}${failed?`, ${failed} preservada(s) por falha ao remover`:''}${old.length>limit?`; as demais seguem nas próximas passagens`:''}. O recibo fica no banco.`);
 return lines;
}

// ---- Docker ------------------------------------------------------------------------------------------------------

type Image={Id:string;Created?:string;RepoTags:string[]|null;RepoDigests:string[]|null;Config:{Labels?:Record<string,string>|null;Entrypoint?:string[]|null;Cmd?:string[]|null}};
const ownedImageName=/^(?:localhost:\d+\/)?(?:ac-|agent-control-)/;
const moduleEntrypoint=/\/(?:opt\/banco\/collector\.rb|(?:qa|prontidao|desempenho|arquitetura|dependencias|conformidade|documentacao)-entrypoint\.sh)/;
/** Stopped containers, unused volumes and unpinned images of the AC leave only after this long. */
export const DOCKER_MIN_AGE_MS=day;

/** An image of the AC (by name or module entrypoint) that no pin, no container and no configuration names, built more than 24 h ago.
 * Protection comes from the pins (module digest.txt files, design-image-digest.txt, the native bootstrap including its retired
 * images, verification runs, other installations on the daemon) and from use, never from a name. Removal is by id, never forced. */
export function removableSimpleImage(image:Image,pins:Set<string>,used:Set<string>,now=Date.now()){
 const names=[...(image.RepoTags??[]),...(image.RepoDigests??[])];
 const owned=names.some(n=>ownedImageName.test(n))||moduleEntrypoint.test(JSON.stringify(image.Config.Entrypoint));
 const created=Date.parse(image.Created??'');
 return owned&&Number.isFinite(created)&&now-created>DOCKER_MIN_AGE_MS&&!used.has(image.Id)&&!pins.has(image.Id)&&!names.some(n=>pins.has(n)||pins.has(n.split('@').at(-1)!));
}

type Container={Id:string;Name:string;Image:string;Created:string;State:{Status:string;Running:boolean;FinishedAt?:string};Config:{Labels?:Record<string,string>|null};Mounts?:{Source:string}[]};
const ownedContainerName=/^\/?ac-(?:native-worker|native-tools|perf)-[A-Za-z0-9_.-]+$/;
const nativeJob=/^\/?ac-native-(?:worker|tools)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const acLabel=(labels:Record<string,string>|null|undefined)=>Object.keys(labels??{}).some(key=>key.startsWith('com.agent-control.'));

/** A stopped container of the AC (label `com.agent-control.*` or a known AC name) stopped more than 24 h ago and not a configured
 * dependency of the installation. Running containers are never touched. */
export function removableSimpleContainer(container:Container,keep:ReadonlySet<string>,now:number){
 const name=container.Name.replace(/^\//,'');
 if(container.State.Running||!['exited','created','dead'].includes(container.State.Status)||keep.has(name))return false;
 if(!acLabel(container.Config.Labels)&&!ownedContainerName.test(container.Name))return false;
 const finished=Date.parse(container.State.FinishedAt??''),since=Number.isFinite(finished)&&finished>0?finished:Date.parse(container.Created);
 return Number.isFinite(since)&&now-since>DOCKER_MIN_AGE_MS;
}

/** A volume that no container uses (the caller lists only dangling volumes), created more than 24 h ago, and labelled by the AC:
 * `com.agent-control.*`, or a compose test database of the AC. A volume without a label is never attributed to the AC. */
export function removableSimpleVolume(volume:{Name:string;CreatedAt:string;Labels?:Record<string,string>|null},now:number){
 const project=volume.Labels?.['com.docker.compose.project']??'';
 const logical=volume.Labels?.['com.docker.compose.volume']??'';
 const test=/^ac-(?:test|lab|implementation|continuation)(?:-|$)/.test(project)&&/^(?:sandbox-pg|test-db|test-postgres)$/.test(logical);
 return now-Date.parse(volume.CreatedAt)>DOCKER_MIN_AGE_MS&&(acLabel(volume.Labels)||test);
}
/** Kept for callers of the former name: the compose test databases are one case of {@link removableSimpleVolume}. */
export const oldTestVolume=removableSimpleVolume;

export type SimpleDockerDeps={
 /** Runs `docker` and returns stdout; throws on a non-zero exit (with `stderr` on the error). */
 docker?:(args:string[])=>Promise<string>;
 now?:()=>number;
 /** Passed to the pin reader (product root, shared references, verification runs). */
 retention?:RetentionDeps;
 /** Which of these native job ids are terminal in the database. The default reads the ledger; failure keeps every native container. */
 terminalJobs?:(config:Installation,ids:string[])=>Promise<Set<string>>;
};

async function defaultTerminalJobIds(config:Installation,ids:string[]){
 const ledger=new Ledger(config.databaseUrl);
 try{
  return new Set((await ledger.pool.query<{id:string}>(`SELECT id::text FROM ac_native_execution_jobs WHERE id=ANY($1::uuid[]) AND state IN ('completed','failed')
   UNION SELECT id::text FROM ac_native_qa_jobs WHERE id=ANY($1::uuid[]) AND state IN ('completed','failed')`,[ids])).rows.map(row=>row.id));
 }finally{await ledger.close();}
}

export async function simpleDockerRetention(config:Installation,apply:boolean,deps:SimpleDockerDeps={}){
 return withInstallationImageLock(config.dataDirectory,false,()=>retainDockerResources(config,apply,deps));
}

async function inspectAll(run:(args:string[])=>Promise<string>):Promise<Container[]>{
 const ids=words(await run(['container','ls','-a','-q','--no-trunc']));
 return ids.length?JSON.parse(await run(['container','inspect',...ids])):[];
}

async function retainDockerResources(config:Installation,apply:boolean,deps:SimpleDockerDeps){
 const run=deps.docker??docker,now=deps.now??Date.now,lines:string[]=[];
 const result=async(args:string[])=>({stdout:await run(args),code:0});
 // Stopped containers first: they hold images and volumes.
 const keep=new Set(config.dockerDependencies?.containers??[]);
 let containers=await inspectAll(run);
 const candidates=containers.filter(c=>removableSimpleContainer(c,keep,now()));
 const jobIds=[...new Set(candidates.map(c=>nativeJob.exec(c.Name)?.[1]).filter((id):id is string=>!!id))];
 // A native job container is removed only when the database says its job is over; recovery may still need it otherwise.
 const terminal=jobIds.length?await (deps.terminalJobs??defaultTerminalJobIds)(config,jobIds).catch(()=>new Set<string>()):new Set<string>();
 for(const container of candidates){
  const label=container.Name.replace(/^\//,'');
  const job=nativeJob.exec(container.Name)?.[1];
  if(job&&!terminal.has(job)){lines.push(`Contêiner parado preservado (job ainda não terminal no banco) ${label}`);continue;}
  try{
   if(apply){
    const [current]=JSON.parse(await run(['container','inspect',container.Id])) as Container[];
    if(!current||current.Id!==container.Id||!removableSimpleContainer(current,keep,now()))continue;
    // No --force and no --volumes: Docker refuses a running container, and volumes follow their own rule below.
    await run(['container','rm',container.Id]);
   }
   lines.push((apply?'Contêiner parado removido ':'Contêiner parado elegível ')+label);
  }catch{lines.push('Contêiner preservado pelo Docker '+label);}
 }
 if(apply)containers=await inspectAll(run);
 const guards=await protectedDigests(config,deps.retention??{},result,{apply});
 const pins=new Set([...guards.pinned,...guards.retired,...guards.foreign]);
 // The common tools image is configured by tag when no digest file exists: whatever the tag names now is in use.
 const toolsPin=async()=>{
  try{return (await run(['image','inspect','--format','{{.Id}}',commonToolTag])).trim();}
  catch(error){if(/no such image/i.test(String((error as {stderr?:unknown}).stderr??'')))return '';throw error;}
 };
 const tools=await toolsPin();
 if(tools)pins.add(tools);
 const used=new Set(containers.map(c=>c.Image));
 const ids=[...new Set(words(await run(['image','ls','-aq','--no-trunc'])))];
 const images:Image[]=ids.length?JSON.parse(await run(['image','inspect',...ids])):[];
 for(const image of images){
  if(!removableSimpleImage(image,pins,used,now()))continue;
  // Never force removal. With multiple tags, deleting by ID fails safely; avoid
  // dropping a tag that has since moved to a newer build.
  try{
   if(apply){
    const fresh=await protectedDigests(config,deps.retention??{},result,{apply});
    const [current]=JSON.parse(await run(['image','inspect',image.Id]));
    const currentPins=new Set([...fresh.pinned,...fresh.foreign,...fresh.retired]);
    const currentTools=await toolsPin();
    if(currentTools)currentPins.add(currentTools);
    const currentUsed=new Set((await inspectAll(run)).map(c=>c.Image));
    if(!removableSimpleImage(current,currentPins,currentUsed,now()))continue;
    await run(['image','rm',image.Id]);
   }
   lines.push((apply?'Imagem removida ':'Imagem elegível ')+image.Id);
  }catch{lines.push('Imagem preservada pelo Docker '+image.Id);}
 }
 for(const name of words(await run(['volume','ls','-q','--filter','dangling=true']))){
  const [volume]=JSON.parse(await run(['volume','inspect',name]));
  if(!removableSimpleVolume(volume,now()))continue;
  try{
   // Docker itself refuses a volume that a container started using meanwhile.
   if(apply)await run(['volume','rm',name]);
   lines.push((apply?'Volume removido ':'Volume elegível ')+name);
  }catch{lines.push('Volume preservado pelo Docker '+name);}
 }
 // The daemon is shared with other projects: its build cache is never pruned here. Only the builder dedicated to the
 // installation is cleaned, by the weekly maintenance.
 lines.push('Cache de build: o do daemon compartilhado não é tocado; só o builder dedicado da instalação é limpo na manutenção semanal.');
 return lines;
}
