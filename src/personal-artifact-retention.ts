import {execFile,spawn} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,mkdir,open,readFile,readdir,readlink,realpath,rename,rm,stat,statfs,unlink,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {basename,dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {z} from 'zod';
import {releaseRegisteredDirectory} from './native-work-retention.ts';
import {Refusal} from './contracts.ts';
import {privateDirectory,readPrivateFile,simpleIsolation,type Installation} from './installation.ts';
import {VERIFICATION_MODULES} from './ledger.ts';

/**
 * Retention of three kinds of artifact the product itself created: worker worktrees, candidate module images and
 * round temporaries under /tmp/ac-*. Nothing is removed on a name, a prefix or an age alone.
 *
 * Ownership comes from a private registry (`<dataDirectory>/artifact-retention/registry.json`) written by
 * `registerWorkerWorktree`, `registerCandidateImage` and `registerRoundTemp`. Every removal then re-proves, right before
 * acting: that the artifact is the registered one (git registration, image id, directory identity plus an owner marker),
 * that it is finished (branch integrated and clean, image unused and unpinned, round closed) and that it has been idle
 * long enough. Anything that cannot be proved is preserved. There is no `git worktree prune`, no `git branch -d`,
 * no `docker prune`, no `docker image rm -f` and no recursive delete of anything but a verified registered directory.
 */

export const WORKTREE_IDLE_MS=2*60*60*1000;
export const IMAGE_MIN_AGE_MS=24*60*60*1000;
export const TEMP_IDLE_MS=24*60*60*1000;
/** A round with registered temporaries but no run row at all (interrupted before the row existed) is only judged ended after this long. */
export const ORPHAN_ROUND_MS=7*24*60*60*1000;
const HISTORY_MAX=200;
const MARKER='.ac-retention-owner';
const imageIdPattern=/^sha256:[a-f0-9]{64}$/;
const token=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const ref=z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine(value=>!value.includes('..')&&!value.endsWith('/')&&!value.endsWith('.lock')&&!value.includes('//'));
const absolutePath=z.string().max(4096).refine(value=>isAbsolute(value)&&resolve(value)===value&&!value.includes('\0'));
const time=z.number().int().safe().nonnegative();
const Worktree=z.object({id:z.uuid(),projectId:z.uuid(),path:absolutePath,branch:ref,base:ref,identity:z.string().optional(),quarantine:absolutePath.optional(),registeredAt:time,origin:z.enum(['new','existing'])}).strict();
/** Kinds of candidate image: the verification modules plus the native runtime images (planning, execution, tools) that `personal:images` replaces. */
export const CANDIDATE_IMAGE_KINDS=[...VERIFICATION_MODULES,'native-runtime','simple-tools'] as const;
export type CandidateImageKind=(typeof CANDIDATE_IMAGE_KINDS)[number];
const Image=z.object({id:z.uuid(),projectId:z.uuid(),module:z.enum(CANDIDATE_IMAGE_KINDS),imageId:z.string().regex(imageIdPattern),daemonId:z.string().min(1).max(256).optional(),registeredAt:time}).strict();
/** `removing` is the removal journal, written outside the directory before its contents start to go. The owner marker lives inside
 * the tree and may be deleted before an interruption; the journal (same identity plus the birth time taken right before) lets the
 * next run finish that exact directory, and nothing else. */
const Removing=z.object({since:time,birth:z.string().regex(/^\d+$/)}).strict();
const Temp=z.object({id:z.uuid(),projectId:z.uuid(),roundId:token,path:absolutePath,dev:z.string().regex(/^\d+$/),ino:z.string().regex(/^\d+$/),nonceDigest:z.string().regex(/^[a-f0-9]{64}$/),registeredAt:time,
 removing:Removing.optional()}).strict();
const Round=z.object({projectId:z.uuid(),roundId:token,endedAt:time}).strict();
const History=z.object({at:time,kind:z.enum(['worktree','image','temp']),id:z.uuid(),action:z.enum(['removed','dropped'])}).strict();
const Registry=z.object({schemaVersion:z.literal(1),worktrees:z.array(Worktree).max(5000),images:z.array(Image).max(5000),temps:z.array(Temp).max(5000),
 rounds:z.array(Round).max(5000),history:z.array(History).max(HISTORY_MAX)}).strict();
export type ArtifactRegistry=z.infer<typeof Registry>;
type WorktreeEntry=z.infer<typeof Worktree>;
type ImageEntry=z.infer<typeof Image>;
type TempEntry=z.infer<typeof Temp>;

export type CommandResult={code:number;stdout:string;stderr?:string};
export type RetentionDeps={
 /** Runs `git` in `cwd` with a sanitized environment. Tests record and fake it. */
 git?:(cwd:string,args:string[])=>Promise<CommandResult>;
 /** Runs `docker` with fixed arguments. */
 docker?:(args:string[])=>Promise<CommandResult>;
 now?:()=>number;
 /** Whether any live process has its cwd, root or an open file at or under `path`. Throwing means "cannot prove": the artifact is kept. */
 processInside?:(path:string)=>Promise<boolean>;
 /** Text of `/proc/self/mountinfo`. Throwing or unparseable text means "cannot prove": the worktree is kept. */
 mountInfo?:()=>Promise<string>;
 /** Images that verification runs keep (`ac_verify_runs.collector_image`, see {@link defaultVerifyRunImages}). `commonCovers`:
  * the pinned common image is present and covers the modules 2 to 9. Failure keeps every image. */
 verifyRunImages?:(config:Installation,options:{commonCovers:boolean})=>Promise<string[]>;
 /** What the database says about each round id of a project: `terminal` (done/failed), `running`, or `missing` (no run row).
  * Failure or any other answer keeps everything. The default reads `ac_verify_runs` scoped to the project. */
 roundStatus?:(config:Installation,rounds:{projectId:string;roundId:string}[])=>Promise<Map<string,'terminal'|'running'|'missing'>>;
 /** Directory that holds round temporaries. Defaults to the canonical system temporary directory. */
 tmpRoot?:string;
 /** Root of this product checkout, where `deploy/modules/<modulo>/digest.txt` pins the module images. */
 productRoot?:string;
 /** Directory of the per-daemon reference registry that every installation sharing one Docker daemon publishes its pins to.
  * Defaults to `AC_DOCKER_REFS_DIR` or `~/.agent-control-docker-refs`. */
 sharedRefsRoot?:string;
 /** Free bytes of the file system that holds Docker's data, or undefined when it cannot be measured. Used only to report the space actually recovered. */
 freeBytes?:()=>Promise<number|undefined>;
};

const empty=():ArtifactRegistry=>({schemaVersion:1,worktrees:[],images:[],temps:[],rounds:[],history:[]});
const projectsOf=(config:Installation)=>[config.project,...config.projects];
const registryDirectory=(config:Installation)=>join(config.dataDirectory,'artifact-retention');
const registryFile=(config:Installation)=>join(registryDirectory(config),'registry.json');
const errno=(error:unknown,code:string)=>(error as NodeJS.ErrnoException)?.code===code;
const identity=(info:{dev:number|bigint;ino:number|bigint})=>({dev:String(info.dev),ino:String(info.ino)});
const hours=(ms:number)=>Math.floor(ms/3600000);

function run(command:string,args:string[],options:{cwd?:string;env:NodeJS.ProcessEnv;timeout:number}){
 return new Promise<CommandResult>(done=>{
  execFile(command,args,{...options,encoding:'utf8',maxBuffer:64*1024*1024,windowsHide:true},(error,stdout,stderr)=>{
   const code=error?(typeof (error as {code?:unknown}).code==='number'?(error as unknown as {code:number}).code:1):0;
   done({code,stdout:stdout??'',stderr:(stderr??'').slice(0,4000)});
  });
 });
}
/** Git never runs hooks, a file-system monitor or any user/system configuration, and never refreshes the index. */
export const defaultGit=(cwd:string,args:string[])=>run('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{cwd,timeout:120_000,
 env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',LC_ALL:'C'}});
const defaultDocker=(args:string[])=>run('docker',args,{timeout:10*60*1000,env:process.env});

export async function defaultProcessInside(path:string){
 const prefix=path+sep;
 const inside=(target:string)=>target===path||target.startsWith(prefix);
 for(const name of await readdir('/proc')){
  if(!/^[1-9][0-9]*$/.test(name))continue;
  const base='/proc/'+name;
  try{
   for(const link of ['cwd','root'])if(inside(await readlink(join(base,link))))return true;
   for(const fd of await readdir(join(base,'fd'))){
    const target=await readlink(join(base,'fd',fd)).catch(()=>'');
    if(inside(target))return true;
   }
  }catch(error){
   if(errno(error,'ENOENT')||errno(error,'ESRCH'))continue;
   // A process we may not inspect (another user, a privileged or non-dumpable one such as a container's) cannot be seen from here.
   // Containers are therefore checked separately through Docker, by their bind mounts.
   if(errno(error,'EACCES')||errno(error,'EPERM'))continue;
   throw error;
  }
 }
 return false;
}

/** Images that the verification runs keep (`ac_verify_runs.collector_image`):
 * - every run not finished (`running`, the only non-terminal status; `done` and `failed` are terminal), and every run whose
 *   collector container still waits for its removal (`collector_start_pending`);
 * - per project and module, the most recent finished run, the one a remeasurement (`--medir`) repeats with its own image. When
 *   the pinned common image covers the modules 2 to 9 (`commonCovers`), their finished runs keep nothing: a remeasurement of
 *   a run whose image is gone is refused (VERIFY_RECHECK_IMAGE_GONE) and a new exam runs on the common image. Module 1 is
 *   never covered.
 * Older finished runs keep nothing. `excludeProject`: the runs of a project being removed no longer pin anything. */
export const VERIFY_RUN_IMAGES_SQL=`SELECT collector_image FROM ac_verify_runs
 WHERE collector_image IS NOT NULL AND ($1::uuid IS NULL OR project_id<>$1::uuid) AND (status NOT IN ('done','failed') OR collector_start_pending)
 UNION
 SELECT collector_image FROM (SELECT DISTINCT ON (project_id,module) collector_image FROM ac_verify_runs
  WHERE collector_image IS NOT NULL AND status IN ('done','failed') AND ($1::uuid IS NULL OR project_id<>$1::uuid) AND (module='verify' OR NOT $2::boolean)
  ORDER BY project_id,module,created_at DESC,id DESC) latest`;
export async function defaultVerifyRunImages(config:Installation,excludeProject?:string,commonCovers=false){
 const pool=new pg.Pool({connectionString:config.databaseUrl,max:1,connectionTimeoutMillis:5000});
 try{return (await pool.query<{collector_image:string}>(VERIFY_RUN_IMAGES_SQL,[excludeProject??null,commonCovers])).rows.map(row=>row.collector_image);}
 finally{await pool.end();}
}

async function defaultRoundStatus(config:Installation,rounds:{projectId:string;roundId:string}[]){
 const result=new Map<string,'terminal'|'running'|'missing'>();
 const pool=new pg.Pool({connectionString:config.databaseUrl,max:1,connectionTimeoutMillis:5000});
 try{
  for(const round of rounds){
   if(!z.uuid().safeParse(round.roundId).success)continue; // not a run id: nobody can vouch for it
   const row=(await pool.query<{project_id:string;status:string}>('SELECT project_id::text AS project_id,status FROM ac_verify_runs WHERE id=$1',[round.roundId])).rows[0];
   if(!row)result.set(round.projectId+':'+round.roundId,'missing');
   else if(row.project_id!==round.projectId)continue; // another project's run: unknown here
   else result.set(round.projectId+':'+round.roundId,row.status==='done'||row.status==='failed'?'terminal':'running');
  }
  return result;
 }finally{await pool.end();}
}

// ---- Registry ------------------------------------------------------------------------------------------------

async function loadRegistry(config:Installation):Promise<ArtifactRegistry>{
 let bytes:Buffer;
 try{bytes=await readPrivateFile(registryFile(config),4*1024*1024,{canonical:true});}
 catch(error){
  if(errno(error,'ENOENT'))return empty();
  throw new Refusal('RETENTION_REGISTRY_INVALID',409);
 }
 try{return Registry.parse(JSON.parse(bytes.toString('utf8')));}
 catch{throw new Refusal('RETENTION_REGISTRY_INVALID',409);}
 finally{bytes.fill(0);}
}
async function saveRegistry(config:Installation,registry:ArtifactRegistry){
 const file=registryFile(config),temporary=`${file}.${randomUUID()}.tmp`;
 await writeFile(temporary,JSON.stringify(Registry.parse(registry),null,1)+'\n',{mode:0o600,flag:'wx'});
 await rename(temporary,file);
}
async function mutateRegistry<T>(config:Installation,change:(registry:ArtifactRegistry)=>T):Promise<T>{
 await privateDirectory(config.dataDirectory);
 await privateDirectory(registryDirectory(config));
 const directory=await open(registryDirectory(config),constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_RDONLY);
 try{
  await new Promise<void>((ok,fail)=>{
   const flock=spawn('/usr/bin/flock',['--exclusive','--wait','5','3'],{stdio:['ignore','ignore','ignore',directory.fd]});
   flock.on('error',fail);
   flock.on('close',code=>code===0?ok():fail(new Refusal('RETENTION_REGISTRY_BUSY',409)));
  });
  const registry=await loadRegistry(config);
  const result=change(registry);
  const active=new Set(registry.temps.map(temp=>temp.projectId+':'+temp.roundId));
  const referenced=registry.rounds.filter(round=>active.has(round.projectId+':'+round.roundId));
  const recent=registry.rounds.filter(round=>!active.has(round.projectId+':'+round.roundId));
  registry.rounds=referenced.concat(recent.slice(Math.max(0,recent.length-Math.min(HISTORY_MAX,5000-referenced.length))));
  await saveRegistry(config,registry);
  return result;
 }finally{await directory.close();}
}
function project(config:Installation,projectId:string){
 const found=projectsOf(config).find(item=>item.id===projectId);
 if(!found)throw new Refusal('RETENTION_PROJECT_UNKNOWN',404);
 return found;
}
const remember=(registry:ArtifactRegistry,kind:'worktree'|'image'|'temp',id:string,action:'removed'|'dropped',at:number)=>{
 registry.history.push({at,kind,id,action});
 if(registry.history.length>HISTORY_MAX)registry.history.splice(0,registry.history.length-HISTORY_MAX);
};

// ---- Git helpers ---------------------------------------------------------------------------------------------

export type Listed={path:string;head?:string;branch?:string;detached:boolean;bare:boolean;locked:boolean;prunable:boolean;main:boolean};
export async function listWorktrees(git:NonNullable<RetentionDeps['git']>,repo:string):Promise<Listed[]>{
 const out=await git(repo,['worktree','list','--porcelain']);
 if(out.code!==0)throw new Error('git worktree list failed');
 return out.stdout.split('\n\n').filter(block=>block.trim()).map((block,index)=>{
  const item:Listed={path:'',detached:false,bare:false,locked:false,prunable:false,main:index===0};
  for(const line of block.split('\n')){
   if(line.startsWith('worktree '))item.path=line.slice(9);
   else if(line.startsWith('HEAD '))item.head=line.slice(5);
   else if(line.startsWith('branch '))item.branch=line.slice(7);
   else if(line==='detached')item.detached=true;
   else if(line==='bare')item.bare=true;
   else if(line==='locked'||line.startsWith('locked '))item.locked=true;
   else if(line==='prunable'||line.startsWith('prunable '))item.prunable=true;
  }
  return item;
 });
}
const inProgress=['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','REBASE_HEAD','BISECT_LOG','rebase-merge','rebase-apply','sequencer','index.lock'];

/** An ignored entry is disposable only when removing it cannot lose data: a symbolic link, whose removal deletes the link and never
 * its target (git removes links without following them). Its name proves nothing: `dist/`, `coverage/` or `node_modules/` may hold the
 * only copy of something. Any ignored regular file or directory keeps the worktree; git lists an ignored directory with a final `/`. */
async function disposableIgnored(root:string,relative:string){
 if(!relative||relative.endsWith('/')||relative.startsWith('/')||relative.split('/').some(part=>!part||part==='.'||part==='..'))return false;
 const full=join(root,relative);
 if(dirname(full)!==root&&await realpath(dirname(full)).catch(()=>'')!==dirname(full))return false;
 return (await lstat(full).catch(()=>undefined/* absent or unreadable means not present here */))?.isSymbolicLink()===true;
}

type Verdict<T>={ok:true;facts:T}|{ok:false;reason:string};
const no=(reason:string):{ok:false;reason:string}=>({ok:false,reason});

async function worktreeIdentity(path:string,gitDir:string){
 const ids=await Promise.all([path,gitDir].map(async dir=>{
  const stat=await lstat(dir,{bigint:true});
  if(!stat.isDirectory()||!isAbsolute(dir)||dir!==await realpath(dir))throw Error('Invalid worktree identity');
  return [stat.dev,stat.ino,stat.birthtimeNs].join(':');
 }));
 return ids.join('/');
}

/** Mount points in `/proc/self/mountinfo` (field 5, octal-escaped). Bind mounts, including of single files, appear there too. */
export function mountPoints(text:string):string[]{
 const points:string[]=[];
 for(const line of text.split('\n')){
  if(!line)continue;
  const field=line.split(' ')[4];
  if(!field||!field.startsWith('/')||!line.includes(' - '))throw new Error('mountinfo illegible');
  points.push(field.replace(/\\([0-7]{3})/g,(_,octal)=>String.fromCharCode(parseInt(octal,8))));
 }
 if(!points.length)throw new Error('mountinfo empty');
 return points;
}
/** True when `path` itself or anything below it is a mount point. A mount ABOVE `path` is harmless. */
export const mountedInside=(text:string,path:string)=>mountPoints(text).some(point=>point===path||point.startsWith(path.endsWith('/')?path:path+'/'));
const defaultMountInfo=()=>readFile('/proc/self/mountinfo','utf8');

type WorktreeFacts={tip:string;idleHours:number;repo:string;retired:boolean};
/** Repository that owns a registered worktree of a project no longer in the installation, read from the worktree itself. */
async function retiredWorktreeRepo(git:NonNullable<RetentionDeps['git']>,path:string){
 const common=await git(path,['rev-parse','--path-format=absolute','--git-common-dir']).catch(()=>undefined/* unreadable: cannot prove */);
 const dir=common?.code===0?common.stdout.trim():'';
 return isAbsolute(dir)&&basename(dir)==='.git'?dirname(dir):undefined;
}
/** Everything that must hold, in order, before `git worktree remove` may run. */
async function proveWorktree(config:Installation,entry:WorktreeEntry,deps:Required<Pick<RetentionDeps,'git'|'now'|'processInside'|'mountInfo'|'docker'>>):Promise<Verdict<WorktreeFacts>|{ok:false;reason:string;absent:true}>{
 const owner=projectsOf(config).find(item=>item.id===entry.projectId);
 // A project removed from the installation is retired: its registered worktree is judged against the repository it belongs to.
 const repo=owner?.repo??await retiredWorktreeRepo(deps.git,entry.path);
 if(!repo)return no('projeto retirado e repositório do worktree ilegível');
 const main=await deps.git(repo,['symbolic-ref','--quiet','--short','HEAD']);
 if(main.code!==0||main.stdout.trim()!==entry.base)return no('base não corresponde ao ramo do checkout da instalação');
 let listed:Listed[];
 try{listed=await listWorktrees(deps.git,repo);}catch{return no('não foi possível ler os worktrees do repositório');}
 const found=listed.find(item=>item.path===entry.path);
 const exists=await lstat(entry.path).then(()=>true,error=>errno(error,'ENOENT')?false:null);
 if(exists===null)return no('não foi possível inspecionar o diretório');
 if(!found&&exists===false)return {ok:false,reason:'já não existe no git nem no disco',absent:true};
 if(!found)return no('o git não registra este diretório como worktree do projeto');
 if(found.main||found.bare||resolve(entry.path)===resolve(repo))return no('é o worktree principal');
 if(found.locked)return no('worktree travado');
 if(found.prunable||!exists)return no('diretório ausente; registro do git exige revisão manual');
 if(found.detached||found.branch!=='refs/heads/'+entry.branch)return no('o worktree não está no ramo registrado');
 const info=await lstat(entry.path);
 if(info.isSymbolicLink()||!info.isDirectory()||info.uid!==process.getuid?.()||await realpath(entry.path)!==entry.path)return no('diretório não é o registrado');
 const tip=await deps.git(repo,['rev-parse','--verify','--quiet','refs/heads/'+entry.branch+'^{commit}']);
 if(tip.code!==0||!/^[a-f0-9]{40,64}$/.test(tip.stdout.trim())||tip.stdout.trim()!==found.head)return no('o ramo e o HEAD do worktree divergem');
 const base=await deps.git(repo,['rev-parse','--verify','--quiet','refs/heads/'+entry.base+'^{commit}']);
 if(base.code!==0)return no('ramo de integração ausente');
 const tipId=tip.stdout.trim();
 const ancestor=await deps.git(repo,['merge-base','--is-ancestor',tipId,base.stdout.trim()]);
 if(ancestor.code!==0)return no(ancestor.code===1?`ramo ainda não integrado em ${entry.base}`:'não foi possível provar a integração');
 const gitDir=(await deps.git(entry.path,['rev-parse','--absolute-git-dir'])).stdout.trim();
 if(!gitDir||!isAbsolute(gitDir))return no('git dir ilegível');
 if(await worktreeIdentity(entry.path,gitDir)!==entry.identity)return no('identidade do worktree mudou');
 for(const name of inProgress)if(await lstat(join(gitDir,name)).then(()=>true,()=>false))return no('operação do git em andamento');
 // Git status and worktree remove can both overlook files hidden by index flags.
 const index=await deps.git(entry.path,['ls-files','-v','-z']);
 if(index.code!==0||index.stdout.split('\0').some(line=>line&&!line.startsWith('H ')))return no('índice contém arquivos ocultos ou não pôde ser verificado');
 const status=await deps.git(entry.path,['status','--porcelain=v1','-z','--untracked-files=all','--ignored=matching','--ignore-submodules=none']);
 if(status.code!==0)return no('não foi possível ler o estado do worktree');
 for(const line of status.stdout.split('\0')){
  if(!line)continue;
  if(!line.startsWith('!! '))return no('há mudanças ou arquivos não rastreados');
  if(!await disposableIgnored(entry.path,line.slice(3)))return no('há arquivos ignorados com conteúdo próprio');
 }
 let last=Math.max(entry.registeredAt,Number(await deps.git(repo,['log','-1','--format=%ct',tipId]).then(r=>r.stdout.trim()).catch(()=>'0'))*1000||0);
 for(const name of ['HEAD','index','logs/HEAD'])last=Math.max(last,(await stat(join(gitDir,name)).catch(()=>undefined/* absent or unreadable means not present here */))?.mtimeMs??0);
 const idle=deps.now()-last;
 if(idle<WORKTREE_IDLE_MS)return no(`atividade há ${hours(Math.max(idle,0))} h (mínimo ${hours(WORKTREE_IDLE_MS)} h)`);
 try{if(await deps.processInside(entry.path))return no('há processo usando o diretório');}catch{return no('não foi possível provar que nenhum processo usa o diretório');}
 try{if(await mountedByContainer(deps.docker,entry.path))return no('há contêiner com este diretório montado');}catch{return no('não foi possível provar que nenhum contêiner monta o diretório');}
 try{if(mountedInside(await deps.mountInfo(),entry.path))return no('há montagem (inclusive bind mount) dentro do diretório');}catch{return no('não foi possível ler as montagens do sistema');}
 return {ok:true,facts:{tip:tipId,idleHours:hours(idle),repo,retired:!owner}};
}

// ---- Registration --------------------------------------------------------------------------------------------

/** Records a worker worktree so retention may later remove it. Also adopts an existing worktree: git itself must list it,
 * on a local branch, in the project's own repository, and the integration branch must exist. The caller names no prefix and no pattern. */
export async function registerWorkerWorktree(config:Installation,input:{projectId:string;path:string;branch:string;base:string;adopt?:boolean},deps:RetentionDeps={}){
 const entryInput=Worktree.omit({id:true,registeredAt:true,origin:true,identity:true,quarantine:true}).safeParse({projectId:input.projectId,path:input.path,branch:input.branch,base:input.base});
 if(!entryInput.success||input.branch===input.base)throw new Refusal('RETENTION_REGISTRATION_INVALID',400);
 const owner=project(config,input.projectId),git=deps.git??defaultGit,now=(deps.now??Date.now)();
 const main=await git(owner.repo,['symbolic-ref','--quiet','--short','HEAD']);
 if(main.code!==0||main.stdout.trim()!==input.base)throw new Refusal('RETENTION_REGISTRATION_INVALID',400);
 const listed=await listWorktrees(git,owner.repo).catch(()=>{throw new Refusal('RETENTION_REGISTRATION_INVALID',400);});
 const found=listed.find(item=>item.path===input.path);
 if(!found||found.main||found.bare||found.detached||found.branch!=='refs/heads/'+input.branch||await realpath(input.path).catch(()=>'')!==input.path)throw new Refusal('RETENTION_REGISTRATION_INVALID',400);
 if((await git(owner.repo,['rev-parse','--verify','--quiet','refs/heads/'+input.base+'^{commit}'])).code!==0)throw new Refusal('RETENTION_REGISTRATION_INVALID',400);
 const gitDir=await git(input.path,['rev-parse','--absolute-git-dir']);
 if(gitDir.code!==0)throw new Refusal('RETENTION_REGISTRATION_INVALID',400);
 const identity=await worktreeIdentity(input.path,gitDir.stdout.trim());
 return mutateRegistry(config,registry=>{
  const same=registry.worktrees.find(item=>item.path===input.path&&item.projectId===input.projectId);
  if(same){if(same.identity!==identity||same.branch!==input.branch||same.base!==input.base)throw new Refusal('RETENTION_REGISTRATION_CONFLICT',409);return same.id;}
  const id=randomUUID();
  registry.worktrees.push({id,identity,projectId:input.projectId,path:input.path,branch:input.branch,base:input.base,registeredAt:now,origin:input.adopt?'existing':'new'});
  return id;
 });
}

/** Records a module image built as a candidate. The image must exist locally with exactly this id. Being pinned is checked again at removal. */
export async function registerCandidateImage(config:Installation,input:{projectId:string;module:CandidateImageKind;imageId:string},deps:RetentionDeps={}){
 if(!imageIdPattern.test(input.imageId)||!(CANDIDATE_IMAGE_KINDS as readonly string[]).includes(input.module))throw new Refusal('RETENTION_REGISTRATION_INVALID',400);
 project(config,input.projectId);
 const docker=deps.docker??defaultDocker;
 const daemonId=await dockerDaemonId(docker);
 if(!daemonId)throw new Refusal('RETENTION_REGISTRATION_INVALID',400);
 const inspected=await docker(['image','inspect','--format','{{.Id}}',input.imageId]);
 if(inspected.code!==0||inspected.stdout.trim()!==input.imageId||await dockerDaemonId(docker)!==daemonId)throw new Refusal('RETENTION_REGISTRATION_INVALID',400);
 const now=(deps.now??Date.now)();
 return mutateRegistry(config,registry=>{
  const same=registry.images.find(item=>item.imageId===input.imageId&&item.projectId===input.projectId);
  if(same){if(same.module!==input.module||same.daemonId!==daemonId)throw new Refusal('RETENTION_REGISTRATION_CONFLICT',409);return same.id;}
  const id=randomUUID();
  registry.images.push({id,projectId:input.projectId,module:input.module,imageId:input.imageId,daemonId,registeredAt:now});
  return id;
 });
}

function tempRoot(deps:RetentionDeps){return deps.tmpRoot??tmpdir();}
function validTempPath(path:string,root:string){return dirname(path)===root&&/^ac-[A-Za-z0-9._-]{1,120}$/.test(basename(path));}

/** Records a directory under the temporary root that belongs to a round, and plants an owner marker inside it.
 * Only a directory that carries the marker and whose identity matches the registry can ever be removed. */
export async function registerRoundTemp(config:Installation,input:{projectId:string;roundId:string;path:string},deps:RetentionDeps={}){
 const root=await realpath(tempRoot(deps));
 if(!token.safeParse(input.roundId).success||!validTempPath(input.path,root))throw new Refusal('RETENTION_REGISTRATION_INVALID',400);
 project(config,input.projectId);
 const info=await lstat(input.path).catch(()=>undefined/* absent path is refused just below */);
 if(!info||info.isSymbolicLink()||!info.isDirectory()||info.uid!==process.getuid?.()||await realpath(input.path)!==input.path)throw new Refusal('RETENTION_REGISTRATION_INVALID',400);
 const {dev,ino}=identity(info),now=(deps.now??Date.now)();
 const id=randomUUID(),nonce=randomBytes(32).toString('hex');
 const existing=(await loadRegistry(config)).temps.find(item=>item.path===input.path);
 if(existing){
  if(existing.projectId!==input.projectId||existing.roundId!==input.roundId||existing.dev!==dev||existing.ino!==ino)throw new Refusal('RETENTION_REGISTRATION_CONFLICT',409);
  return existing.id;
 }
 const marker=await open(join(input.path,MARKER),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 try{await marker.writeFile(JSON.stringify({schemaVersion:1,entryId:id,nonce}));await marker.sync();}finally{await marker.close();}
 try{
  await mutateRegistry(config,registry=>{
   registry.temps.push({id,projectId:input.projectId,roundId:input.roundId,path:input.path,dev,ino,nonceDigest:createHash('sha256').update(nonce).digest('hex'),registeredAt:now});
  });
 }catch(error){await unlink(join(input.path,MARKER)).catch(()=>{/* best-effort cleanup; the original error is what the caller sees */});throw error;}
 return id;
}

/** Marks a round as finished. The first end time wins; temporaries of the round become removable 24 h later. */
export async function closeRound(config:Installation,input:{projectId:string;roundId:string},deps:RetentionDeps={}){
 project(config,input.projectId);
 return recordRoundEnd(config,input,deps);
}
/** Records the end of a round without requiring the project to be configured (retention of a retired project). */
async function recordRoundEnd(config:Installation,input:{projectId:string;roundId:string},deps:RetentionDeps){
 if(!token.safeParse(input.roundId).success)throw new Refusal('RETENTION_REGISTRATION_INVALID',400);
 const now=(deps.now??Date.now)();
 return mutateRegistry(config,registry=>{
  const same=registry.rounds.find(item=>item.projectId===input.projectId&&item.roundId===input.roundId);
  if(same)return same.endedAt;
  registry.rounds.push({projectId:input.projectId,roundId:input.roundId,endedAt:now});
  return now;
 });
}

// ---- Images --------------------------------------------------------------------------------------------------

const digestsIn=(text:string)=>new Set(text.match(/sha256:[a-f0-9]{64}/g)??[]);
const here=resolve(dirname(fileURLToPath(import.meta.url)),'..');

/** Digests that protect an image. `pinned`: the installation or any of its project checkouts pins them, or a verification run recorded them.
 * `retired`: images the native bootstrap still lists as retired (`execution.retiredImages`, `planning.retiredImageIds`) because a job may still need them.
 * `foreign`: digests pinned by OTHER installations on the same Docker daemon, read from the per-daemon reference registry.
 * Any read failure other than a missing file throws, including an unreadable reference file of another installation. */
/** `releasedProject`: the project being removed, whose own registered images are judged by every other pin.
 * `publish:false` reads the other installations' pins without rewriting this installation's own file: a removal preview must
 * not announce a reduced pin set while the project it leaves out is still installed. `apply` lets expired foreign files go. */
export async function protectedDigests(config:Installation,deps:RetentionDeps,docker:NonNullable<RetentionDeps['docker']>,options:{apply?:boolean;releasedProject?:string;publish?:boolean}={}){
 const releasedProject=options.releasedProject;
 const pinned=new Set<string>(digestsIn(JSON.stringify(config)));
 const retired=new Set<string>();
 const boot=config.nativeBootstrap as {planning?:{retiredImageIds?:string[]};execution?:{retiredImages?:{workerImage?:string;toolsImage?:string}[]}}|undefined;
 for(const text of [...(boot?.planning?.retiredImageIds??[]),...(boot?.execution?.retiredImages??[]).flatMap(pair=>[pair.workerImage??'',pair.toolsImage??''])])for(const digest of digestsIn(text))retired.add(digest);
 const owners=projectsOf(config);
 for(const entry of (await loadRegistry(config)).images){
  // The images of a project being removed are judged by every other pin, not kept merely because their owner is gone.
  if(entry.projectId===releasedProject)continue;
  const owner=owners.find(project=>project.id===entry.projectId);
  // A retired project (absent from the installation) no longer pins its candidates: they go like any unpinned image.
  if(owner?.economy?.imageRetention===false)pinned.add(entry.imageId);
 }
 const roots=new Set([deps.productRoot??here,...projectsOf(config).map(item=>item.repo)]);
 const installed=join(config.dataDirectory,'verify-image.json');
 const simple=join(config.dataDirectory,'simple-tools-image.json');
 const readPin=async(file:string)=>{
  let text:string;
  try{
   const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   try{
    const info=await handle.stat();
    if(!info.isFile()||info.size>65536)throw new Refusal('RETENTION_IMAGE_PIN_INVALID');
    text=await handle.readFile('utf8');
   }finally{await handle.close();}
  }catch(error){if(errno(error,'ENOENT'))return undefined;throw error;}
  if(file===installed||file===simple)text=JSON.parse(text).image;
  if(typeof text!=='string'||!digestsIn(text).size)throw new Refusal('RETENTION_IMAGE_PIN_INVALID');
  for(const digest of digestsIn(text))pinned.add(digest);
  return text;
 };
 const common=await readPin(simple);
 // In the simple isolation the modules 2 to 9 run first on the common image that `personal:tools-image` proved and pinned; their own
 // pins are only the fallback. While that image is present, the module pins no longer keep their images (exams still running keep
 // theirs through `verifyRunImages`). Without the common image on the daemon, the fallback is needed: they stay.
 const commonCovers=simpleIsolation(config)&&common!==undefined&&imageIdPattern.test(common)&&await localImage(docker,common);
 const files=[installed,...[...roots].flatMap(root=>[join(root,'deploy','design-image-digest.txt'),...(commonCovers?[]:VERIFICATION_MODULES.map(module=>join(root,'deploy','modules',module,'digest.txt')))])];
 for(const file of files)await readPin(file);
 for(const image of await (deps.verifyRunImages??((current,{commonCovers})=>defaultVerifyRunImages(current,releasedProject,commonCovers)))(config,{commonCovers}))for(const digest of digestsIn(image))pinned.add(digest);
 let foreign:Set<string>;
 try{foreign=await shareDaemonReferences(config,deps,docker,[...pinned],[...retired],options.apply===true,options.publish??true);}catch{throw new SharedReferencesUnreadable();}
 return {pinned,retired,foreign};
}

/** Whether the daemon has this exact image id. Any failure answers no, which keeps the module pins. */
async function localImage(docker:NonNullable<RetentionDeps['docker']>,image:string){
 try{const found=await docker(['image','inspect','--format','{{.Id}}',image]);return found.code===0&&found.stdout.trim()===image;}
 catch{return false;/* unknown: the module pins keep protecting */}
}

// ---- Per-daemon reference registry -----------------------------------------------------------------------------
// Several installations may share one Docker daemon. An image that installation B pins (without a container) is invisible to A's
// own pins and containers. Every installation therefore publishes the digests it pins under `<root>/<daemonId>/<installation>.json`
// on each retention run, and a removal also honours everything the OTHER files list. An unreadable file keeps every image.

class SharedReferencesUnreadable extends Error{constructor(){super('shared daemon references unreadable');}}
const SharedRefs=z.object({schemaVersion:z.literal(1),dataDirectory:absolutePath,publishedAt:time,installationFile:absolutePath.optional(),productRoot:absolutePath.optional(),pinned:z.array(z.string().regex(imageIdPattern)).max(5000)}).strict();
const SHARED_REFS_REFRESH_MS=60*60*1000;
/** A reference file not republished for this long, or whose installation directory is gone, no longer pins anything. */
export const SHARED_REFS_EXPIRY_MS=7*24*60*60*1000;
const sharedRefsRoot=(deps:RetentionDeps)=>deps.sharedRefsRoot??process.env.AC_DOCKER_REFS_DIR??join(homedir(),'.agent-control-docker-refs');
const installationKey=(config:Installation)=>createHash('sha256').update(resolve(config.dataDirectory)).digest('hex').slice(0,32);

async function shareDaemonReferences(config:Installation,deps:RetentionDeps,docker:NonNullable<RetentionDeps['docker']>,pinned:string[],retired:string[],apply=false,publish=true){
 const daemonId=await dockerDaemonId(docker);
 if(!daemonId)return new Set<string>();// no daemon identity: proveImage refuses every image anyway
 const directory=join(sharedRefsRoot(deps),daemonId),own=installationKey(config)+'.json';
 if(publish)await mkdir(directory,{recursive:true,mode:0o755});
 const mine=[...new Set([...pinned,...retired])].filter(digest=>imageIdPattern.test(digest)).sort();
 const file=join(directory,own);
 const now=(deps.now??Date.now)();
 let fresh=false;
 try{
  const current=SharedRefs.parse(JSON.parse(await readFile(file,'utf8')));
  fresh=current.dataDirectory===resolve(config.dataDirectory)&&now-current.publishedAt<SHARED_REFS_REFRESH_MS&&now>=current.publishedAt&&JSON.stringify(current.pinned)===JSON.stringify(mine);
 }catch{fresh=false;}
 if(publish&&!fresh){
  const temporary=`${file}.${randomUUID()}.tmp`;
  await writeFile(temporary,JSON.stringify({schemaVersion:1,dataDirectory:resolve(config.dataDirectory),publishedAt:now,pinned:mine})+'\n',{mode:0o644,flag:'wx'});
  await rename(temporary,file);
 }
 const foreign=new Set<string>();
 let names:string[];
 try{names=await readdir(directory);}catch(error){if(!publish&&errno(error,'ENOENT'))return foreign;throw error;}
 for(const name of names){
  if(name===own||!name.endsWith('.json'))continue;
  // Any entry that is not a well-formed inventory means an owner without a usable inventory: nothing may be removed.
  const parsed=SharedRefs.parse(JSON.parse(await readFile(join(directory,name),'utf8')));
  // Expired: the installation's directory no longer exists (a finished test or a removed installation), or it stopped republishing.
  // Only a definite ENOENT counts as gone; any other doubt keeps the pins.
  const gone=await lstat(parsed.dataDirectory).then(()=>false,error=>errno(error,'ENOENT'));
  if(gone||now-parsed.publishedAt>SHARED_REFS_EXPIRY_MS){
   if(apply){
    // Read again right before: a file republished in the meantime is kept.
    const again=await readFile(join(directory,name),'utf8').then(text=>SharedRefs.safeParse(JSON.parse(text)),()=>undefined/* already gone */);
    if(again?.success&&again.data.publishedAt===parsed.publishedAt)await unlink(join(directory,name)).catch(()=>undefined/* removed by another run */);
   }
   continue;
  }
  for(const digest of parsed.pinned)foreign.add(digest);
 }
 return foreign;
}

/** Republishes this installation's pins for the other installations on the daemon, without removing anything. The maintenance
 * calls it when retention is off, so a reference file never expires while its installation still runs. Best effort. */
export async function publishDaemonReferences(config:Installation,deps:RetentionDeps={}){
 await publishOwnReferences(config,deps,deps.docker??defaultDocker,false);
}

/** Keeps this installation's published pins fresh even when it has no candidate image of its own, so others can see them. */
async function publishOwnReferences(config:Installation,deps:RetentionDeps,docker:NonNullable<RetentionDeps['docker']>,apply:boolean){
 try{await protectedDigests(config,deps,docker,{apply});}catch{/* best effort: a failed publication only means others keep treating this installation as unknown */}
}

/** Free bytes where Docker keeps its data (`docker info`'s DockerRootDir), measured with statfs. Undefined when unreadable (rootless, remote daemon). */
async function defaultFreeBytes(docker:NonNullable<RetentionDeps['docker']>){
 const info=await docker(['info','--format','{{.DockerRootDir}}']);
 const dir=info.stdout.trim();
 if(info.code!==0||!isAbsolute(dir))return undefined;
 const fs=await statfs(dir);
 return Number(fs.bavail)*Number(fs.bsize);
}

async function dockerDaemonId(docker:NonNullable<RetentionDeps['docker']>){
 const result=await docker(['info','--format','{{.ID}}']);
 const id=result.stdout.trim();
 return result.code===0&&/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,255}$/.test(id)?id:undefined;
}

type ImageFacts={digests:string[];size:number|undefined};
/** Judged again right before removal. Every doubt preserves; `docker image rm` is later run by id and never forced. */
/** Refusals that mean "someone else keeps this image": a pin of the installation, a retired image still referenced, another installation. */
const PIN_REASONS={retired:'imagem aposentada ainda referenciada pela instalação',foreign:'digest fixado por outra instalação neste daemon',pinned:'digest fixado ou referenciado por exame'} as const;
const pinReasons=new Set<string>(Object.values(PIN_REASONS));

async function proveImage(entry:ImageEntry,guard:{pinned:Set<string>;retired:Set<string>;foreign:Set<string>},docker:NonNullable<RetentionDeps['docker']>,now:number,minAge=IMAGE_MIN_AGE_MS):Promise<Verdict<ImageFacts>|{ok:false;reason:string;absent:true}>{
 if(!entry.daemonId)return no('registro antigo sem identidade do daemon Docker');
 const daemonId=await dockerDaemonId(docker);
 if(!daemonId)return no('identidade do daemon Docker indisponível');
 if(daemonId!==entry.daemonId)return no('daemon Docker diferente do registro');
 const inspected=await docker(['image','inspect',entry.imageId]);
 if(inspected.code!==0){
  // Only an unequivocal answer from the daemon means "no such image": its own not-found message AND a successful full listing without the id.
  // A timeout, a broken connection or any other operational error says nothing about the image, so the record stays and the next run tries again.
  if(!/no such image/i.test(inspected.stderr??''))return no('falha operacional ao inspecionar a imagem');
  const listing=await docker(['image','ls','-a','-q','--no-trunc']);
  if(listing.code!==0)return no('falha operacional ao listar as imagens');
  if(listing.stdout.split('\n').some(line=>line.trim()===entry.imageId))return no('o Docker respondeu que a imagem não existe, mas a listagem a mostra');
  return {ok:false,reason:'a imagem já não existe no Docker',absent:true};
 }
 let digests:string[],size:number|undefined;
 try{
  const [image]=JSON.parse(inspected.stdout) as {Id?:string;RepoTags?:string[];RepoDigests?:string[];Size?:number}[];
  if(image?.Id!==entry.imageId)return no('o id da imagem não é o registrado');
  digests=[image.Id,...(image.RepoDigests??[]).flatMap(item=>[...digestsIn(item)])];
  size=Number.isSafeInteger(image.Size)&&image.Size!>=0?image.Size:undefined;
 }catch{return no('resposta ilegível do Docker');}
 if(digests.some(digest=>guard.retired.has(digest)))return no(PIN_REASONS.retired);
 if(digests.some(digest=>guard.foreign.has(digest)))return no(PIN_REASONS.foreign);
 if(digests.some(digest=>guard.pinned.has(digest)))return no(PIN_REASONS.pinned);
 const age=now-entry.registeredAt;
 if(age<minAge)return no(`registrada há ${hours(Math.max(age,0))} h (mínimo ${hours(minAge)} h)`);
 // Any container, running or stopped, created from this image or from one built on it.
 const containers=await docker(['container','ls','-a','--no-trunc','-q','--filter','ancestor='+entry.imageId]);
 if(containers.code!==0)return no('não foi possível listar contêineres');
 if(containers.stdout.trim())return no('há contêiner usando a imagem');
 // Second, independent look: the image id every existing container was created from.
 const every=await docker(['container','ls','-a','--no-trunc','-q']);
 if(every.code!==0)return no('não foi possível listar contêineres');
 const ids=every.stdout.split('\n').map(line=>line.trim()).filter(Boolean);
 if(ids.length){
  const used=await docker(['container','inspect','--format','{{.Image}}',...ids]);
  if(used.code!==0)return no('não foi possível inspecionar contêineres');
  if(used.stdout.split('\n').some(line=>line.trim()===entry.imageId))return no('há contêiner usando a imagem');
 }
 return {ok:true,facts:{digests,size}};
}

// ---- Temporaries ---------------------------------------------------------------------------------------------

async function sameDeviceTree(path:string,dev:string){
 const stack=[path];
 let seen=0;
 while(stack.length){
  const directory=stack.pop()!;
  for(const item of await readdir(directory,{withFileTypes:true})){
   if(++seen>500_000)return false;
   if(!item.isDirectory())continue;
   const child=join(directory,item.name),info=await lstat(child);
   if(String(info.dev)!==dev)return false;
   stack.push(child);
  }
 }
 return true;
}

/** Whether any container, running or not, bind-mounts something at or under `path`. Throws when Docker cannot answer. */
export async function mountedByContainer(docker:NonNullable<RetentionDeps['docker']>,path:string){
 const listed=await docker(['container','ls','-a','--no-trunc','-q']);
 if(listed.code!==0)throw new Error('docker unavailable');
 const ids=listed.stdout.split('\n').map(line=>line.trim()).filter(Boolean);
 if(!ids.length)return false;
 const inspected=await docker(['container','inspect','--format','{{range .Mounts}}{{println .Source}}{{end}}',...ids]);
 if(inspected.code!==0)throw new Error('docker inspect failed');
 return inspected.stdout.split('\n').some(source=>source===path||source.startsWith(path+sep)||(source!==''&&path.startsWith(source+sep)));
}

/** `released`: the project is being removed, so the end of its round is not asked for. A retired project's temporaries
 * keep every other proof (marker, identity, idleness, no process or mount). */
async function proveTemp(config:Installation,registry:ArtifactRegistry,entry:TempEntry,deps:Required<Pick<RetentionDeps,'now'|'processInside'|'docker'>>&{root:string;released?:boolean}):Promise<Verdict<{idleHours:number;resumed:boolean}>|{ok:false;reason:string;absent:true}>{
 if(!validTempPath(entry.path,deps.root))return no('caminho fora do diretório temporário');
 const info=await lstat(entry.path,{bigint:true}).catch(error=>errno(error,'ENOENT')?null:undefined);
 if(info===null)return {ok:false,reason:'o diretório já não existe',absent:true};
 if(!info)return no('não foi possível inspecionar o diretório');
 const id=identity(info);
 if(info.isSymbolicLink()||!info.isDirectory()||info.uid!==BigInt(process.getuid?.()??-1)||id.dev!==entry.dev||id.ino!==entry.ino||await realpath(entry.path)!==entry.path)return no('o diretório não é o registrado');
 if(entry.removing&&String(info.birthtimeNs)!==entry.removing.birth)return no('o diretório não é o que começou a ser removido');
 let marker:{entryId?:unknown;nonce?:unknown}|undefined;
 try{
  const handle=await open(join(entry.path,MARKER),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const markerInfo=await handle.stat();
   if(!markerInfo.isFile()||markerInfo.uid!==process.getuid?.()||markerInfo.size>4096)return no('marca de propriedade inválida');
   marker=JSON.parse(await handle.readFile('utf8'));
  }finally{await handle.close();}
 }catch(error){
  // Only the journal of an interrupted removal of this very directory stands in for a marker that the removal itself deleted.
  if(!(entry.removing&&errno(error,'ENOENT')))return no('marca de propriedade ausente');
 }
 if(marker&&(marker.entryId!==entry.id||typeof marker.nonce!=='string'||createHash('sha256').update(marker.nonce).digest('hex')!==entry.nonceDigest))return no('marca de propriedade não confere');
 let idle=0;
 if(!deps.released){
  const round=registry.rounds.find(item=>item.projectId===entry.projectId&&item.roundId===entry.roundId);
  if(!round)return no('rodada sem prova de encerramento');
  if(round.endedAt<entry.registeredAt)return no('encerramento anterior ao registro');
  idle=deps.now()-round.endedAt;
  if(idle<TEMP_IDLE_MS)return no(`rodada encerrada há ${hours(Math.max(idle,0))} h (mínimo ${hours(TEMP_IDLE_MS)} h)`);
 }
 try{if(!await sameDeviceTree(entry.path,entry.dev))return no('há montagem ou árvore grande demais dentro do diretório');}catch{return no('não foi possível varrer o diretório');}
 try{if(await deps.processInside(entry.path))return no('há processo usando o diretório');}catch{return no('não foi possível provar que nenhum processo usa o diretório');}
 try{if(await mountedByContainer(deps.docker,entry.path))return no('há contêiner com este diretório montado');}catch{return no('não foi possível provar que nenhum contêiner monta o diretório');}
 return {ok:true,facts:{idleHours:hours(idle),resumed:!!entry.removing}};
}

// ---- Entry point ---------------------------------------------------------------------------------------------

/** Retention of worker worktrees, candidate module images and round temporaries. Without `apply` nothing changes, not even the registry.
 * Each artifact is judged on its own, so one failure never stops the others. */
export async function runPersonalArtifactRetention(config:Installation,apply:boolean,deps:RetentionDeps={}):Promise<string[]>{
 if(typeof apply!=='boolean')throw new Refusal('MAINTENANCE_USAGE');
 if(config.activation!=='personal')throw new Refusal('MAINTENANCE_PERSONAL_REQUIRED');
 const git=deps.git??defaultGit,docker=deps.docker??defaultDocker,now=deps.now??Date.now,processInside=deps.processInside??defaultProcessInside,mountInfo=deps.mountInfo??defaultMountInfo;
 let registry=await loadRegistry(config);
 const lines:string[]=[];
 // Durable end of rounds: a crash between the terminal transition and `endRound`, or before the run row existed, leaves
 // temporaries whose round was never closed. The database, not the process memory, decides; any doubt keeps them.
 const unclosed=new Map<string,{projectId:string;roundId:string;first:number}>();
 for(const temp of registry.temps){
  const key=temp.projectId+':'+temp.roundId;
  if(registry.rounds.some(round=>round.projectId===temp.projectId&&round.roundId===temp.roundId))continue;
  const seen=unclosed.get(key);
  if(!seen||temp.registeredAt<seen.first)unclosed.set(key,{projectId:temp.projectId,roundId:temp.roundId,first:temp.registeredAt});
 }
 if(unclosed.size){
  let states:Map<string,'terminal'|'running'|'missing'>|undefined;
  try{states=await (deps.roundStatus??defaultRoundStatus)(config,[...unclosed.values()].filter(round=>projectsOf(config).some(item=>item.id===round.projectId)).map(({projectId,roundId})=>({projectId,roundId})));}catch{states=undefined;}
  for(const [key,round] of unclosed){
   const label=`rodada ${round.roundId}`;
   // A retired project (removed from the installation) runs nothing any more: its open rounds are over.
   const retired=!projectsOf(config).some(item=>item.id===round.projectId);
   const state=retired?'terminal':states?.get(key);
   const orphan=state==='missing'&&now()-round.first>=ORPHAN_ROUND_MS;
   if(state!=='terminal'&&!orphan){
    lines.push(`${label}: sem encerramento registrado, preservada (${!states?'banco indisponível':state==='running'?'execução ainda em andamento':state==='missing'?'sem linha de execução, aguardando '+hours(ORPHAN_ROUND_MS)+' h':'estado desconhecido'}).`);
    continue;
   }
   if(!apply){lines.push(`${label}: encerramento seria registrado (${retired?'projeto retirado':state==='terminal'?'execução terminal no banco':'sem linha de execução há mais de '+hours(ORPHAN_ROUND_MS)+' h'}).`);continue;}
   try{await recordRoundEnd(config,{projectId:round.projectId,roundId:round.roundId},{now});lines.push(`${label}: encerramento registrado (${retired?'projeto retirado':state==='terminal'?'execução terminal no banco':'sem linha de execução'}); os temporários envelhecem 24 h a partir de agora.`);}
   catch{lines.push(`${label}: encerramento não pôde ser registrado, preservada.`);}
  }
  if(apply)registry=await loadRegistry(config);
 }
 const total={worktree:{done:0,kept:0},image:{done:0,kept:0},temp:{done:0,kept:0}};
 const done=(kind:keyof typeof total)=>{total[kind].done++;};
 const kept=(kind:keyof typeof total,label:string,reason:string)=>{total[kind].kept++;lines.push(`${label}: preservado (${reason}).`);};
 const forget=async(kind:'worktree'|'image'|'temp',id:string,action:'removed'|'dropped')=>{
  await mutateRegistry(config,current=>{
   const list=kind==='worktree'?current.worktrees:kind==='image'?current.images:current.temps;
   const index=list.findIndex(item=>item.id===id);
   if(index>=0)list.splice(index,1);
   remember(current,kind,id,action,now());
  });
 };

 for(const entry of registry.worktrees){
  const label=`worktree ${entry.path}`;
  if(entry.quarantine){kept('worktree',label,`quarentena registrada em ${entry.quarantine}; verificação manual necessária`);continue;}
  try{
   const proof=await proveWorktree(config,entry,{git,now,processInside,mountInfo,docker});
   if(!proof.ok){
    if('absent' in proof){
     if(apply)await forget('worktree',entry.id,'dropped');
     done('worktree');lines.push(`${label}: ${apply?'registro retirado':'registro seria retirado'} (${proof.reason}).`);
    }else kept('worktree',label,proof.reason);
    continue;
   }
   if(!apply){done('worktree');lines.push(`${label}: elegível (ramo ${entry.branch} integrado em ${entry.base}, limpo, ocioso há ${proof.facts.idleHours} h).`);continue;}
   // Judged again, so a change since the first look wins.
   const again=await proveWorktree(config,entry,{git,now,processInside,mountInfo,docker});
   if(!again.ok){kept('worktree',label,'mudou durante a retenção: '+again.reason);continue;}
   const owner={repo:again.facts.repo};
   // Swap protection: the directory is first renamed (same parent, atomic) to a private name, so the path that was proved can no
   // longer be replaced or have a mount placed on it by name. It is then judged again at the new path, by inode and by mountinfo,
   // and only then removed. Any doubt moves it back and keeps it. No --force: git itself refuses a worktree with changes.
   const quarantine=join(dirname(entry.path),`.ac-retention-${randomUUID()}`);
   const before=await lstat(entry.path,{bigint:true});
   await mutateRegistry(config,current=>{const stored=current.worktrees.find(item=>item.id===entry.id);if(!stored||stored.path!==entry.path||stored.quarantine)throw new Refusal('RETENTION_REGISTRY_CHANGED',409);stored.quarantine=quarantine;});
   const moved=await git(owner.repo,['worktree','move',entry.path,quarantine]);
   if(moved.code!==0){await mutateRegistry(config,current=>{const stored=current.worktrees.find(item=>item.id===entry.id);if(stored?.quarantine===quarantine)delete stored.quarantine;});kept('worktree',label,'não foi possível isolar o diretório antes da remoção');continue;}
   const restore=async(reason:string)=>{
    const back=await git(owner.repo,['worktree','move',quarantine,entry.path]);
    if(back.code===0)await mutateRegistry(config,current=>{const stored=current.worktrees.find(item=>item.id===entry.id);if(stored?.quarantine===quarantine)delete stored.quarantine;});
    kept('worktree',label,back.code===0?reason:`${reason}; ATENÇÃO: diretório preservado em ${quarantine}`);
   };
   let verdict:string|undefined;
   try{
    const info=await lstat(quarantine,{bigint:true});
    if(info.isSymbolicLink()||!info.isDirectory()||info.dev!==before.dev||info.ino!==before.ino)verdict='o diretório isolado não é o provado';
    else if(await realpath(quarantine)!==quarantine)verdict='caminho isolado não é canônico';
    else if(mountedInside(await mountInfo(),quarantine))verdict='há montagem (inclusive bind mount) dentro do diretório';
    else if(await mountedByContainer(docker,quarantine))verdict='há contêiner com este diretório montado';
    else if(await processInside(quarantine))verdict='há processo usando o diretório';
   }catch{verdict='não foi possível verificar o diretório isolado';}
   if(verdict){await restore(verdict);continue;}
   const removed=await git(owner.repo,['worktree','remove',quarantine]);
   if(removed.code!==0){await restore('o git recusou a remoção');continue;}
   const branch=await git(owner.repo,['rev-parse','--verify','--quiet','refs/heads/'+entry.branch+'^{commit}']);
   await forget('worktree',entry.id,'removed');
   done('worktree');
   lines.push(`${label}: removido${again.facts.retired?' (projeto retirado)':''} (ramo ${entry.branch} ${branch.code===0&&branch.stdout.trim()===again.facts.tip?'preservado':'NÃO confere após a remoção'}).`);
  }catch{kept('worktree',label,'falha ao verificar; repita depois');}
 }

 let imageBytes=0,freeBefore:number|undefined,freeAfter:number|undefined;
 const measure=async()=>{try{return await (deps.freeBytes??(()=>defaultFreeBytes(docker)))();}catch{return undefined;}};
 if(!registry.images.length)await publishOwnReferences(config,deps,docker,apply);
 if(registry.images.length){
  let guard:{pinned:Set<string>;retired:Set<string>;foreign:Set<string>}|undefined,sharedFailed=false;
  try{guard=await protectedDigests(config,deps,docker,{apply});}
  catch(error){guard=undefined;sharedFailed=error instanceof SharedReferencesUnreadable;}
  if(apply)freeBefore=await measure();
  for(const entry of registry.images){
   const label=`imagem ${entry.imageId.slice(0,19)} (${entry.module})`;
   if(!guard){kept('image',label,sharedFailed?'referências compartilhadas do daemon ilegíveis':'não foi possível ler os digests fixados e os exames');continue;}
   try{
    // Retired project (absent from the installation): its candidates are judged like any other, with no project option to keep them.
    if(projectsOf(config).find(item=>item.id===entry.projectId)?.economy?.imageRetention===false){kept('image',label,'retenção de imagens desligada neste projeto');continue;}
    const proof=await proveImage(entry,guard,docker,now());
    if(!proof.ok){
     if('absent' in proof){
      if(apply)await forget('image',entry.id,'dropped');
      done('image');lines.push(`${label}: ${apply?'registro retirado':'registro seria retirado'} (${proof.reason}).`);
     }else kept('image',label,proof.reason);
     continue;
    }
    const nominal=proof.facts.size===undefined?'tamanho desconhecido':`${(proof.facts.size/1e9).toFixed(3)} GB nominais`;
    if(!apply){done('image');imageBytes+=proof.facts.size??0;lines.push(`${label}: elegível (sem pin, sem contêiner, registrada há mais de ${hours(IMAGE_MIN_AGE_MS)} h; ${nominal}).`);continue;}
    // Judged again with fresh pins and containers, so a change since the first look wins.
    const fresh=await protectedDigests(config,deps,docker,{apply});
    const again=await proveImage(entry,fresh,docker,now());
    if(!again.ok){kept('image',label,'mudou durante a retenção: '+again.reason);continue;}
    // By id, no --force: Docker itself refuses an image that has children, several tags or a container.
    const removed=await docker(['image','rm',entry.imageId]);
    if(removed.code!==0){kept('image',label,'o Docker recusou a remoção');continue;}
    const gone=await docker(['image','inspect','--format','{{.Id}}',entry.imageId]);
    if(gone.code===0){kept('image',label,'a imagem continua no Docker após a remoção');continue;}
    await forget('image',entry.id,'removed');
    done('image');imageBytes+=again.facts.size??0;
    lines.push(`${label}: removida (${again.facts.size===undefined?'tamanho desconhecido':`${(again.facts.size/1e9).toFixed(3)} GB nominais`}).`);
   }catch{kept('image',label,'falha ao verificar; repita depois');}
  }
  if(apply&&total.image.done)freeAfter=await measure();
 }
 const effective=!apply?'não medido (prévia)':freeBefore===undefined||freeAfter===undefined?(total.image.done?'não medido (espaço livre do Docker indisponível)':'0.000 GB (nada removido)')
  :freeAfter>=freeBefore?`${((freeAfter-freeBefore)/1e9).toFixed(3)} GB (diferença do espaço livre medida em torno das remoções)`:'não mensurável (o espaço livre diminuiu por outra atividade)';
 lines.push(`imagens: ${apply?'removidas':'elegíveis'} ${total.image.done}, ${(imageBytes/1e9).toFixed(3)} GB de tamanho nominal (camadas compartilhadas podem liberar menos); espaço efetivamente recuperado: ${effective}.`);

 let root:string|undefined;
 try{root=await realpath(tempRoot(deps));}catch{root=undefined;}
 for(const entry of registry.temps){
  const label=`temporário ${entry.path}`;
  if(!root){kept('temp',label,'diretório temporário indisponível');continue;}
  try{
   const proof=await proveTemp(config,registry,entry,{now,processInside,docker,root});
   if(!proof.ok){
    if('absent' in proof){
     if(apply)await forget('temp',entry.id,'dropped');
     done('temp');lines.push(`${label}: ${apply?'registro retirado':'registro seria retirado'} (${proof.reason}).`);
    }else kept('temp',label,proof.reason);
    continue;
   }
   const resumed=proof.facts.resumed?', retomando remoção interrompida':'';
   if(!apply){done('temp');lines.push(`${label}: elegível (rodada ${entry.roundId} encerrada há ${proof.facts.idleHours} h${resumed}).`);continue;}
   const again=await proveTemp(config,registry,entry,{now,processInside,docker,root});
   if(!again.ok){kept('temp',label,'mudou durante a retenção: '+again.reason);continue;}
   if(!entry.removing){
    // Journal first, outside the tree: from here on an interruption can be resumed even after the marker is gone.
    const birth=String((await lstat(entry.path,{bigint:true})).birthtimeNs);
    const journal=await mutateRegistry(config,current=>{
     const stored=current.temps.find(item=>item.id===entry.id);
     if(!stored||stored.dev!==entry.dev||stored.ino!==entry.ino)throw new Refusal('RETENTION_REGISTRY_CHANGED',409);
     return stored.removing??={since:now(),birth};
    });
    if(journal.birth!==birth)throw new Refusal('RETENTION_REGISTRY_CHANGED',409);
   }
   await releaseRegisteredDirectory(entry.path,entry);
   await forget('temp',entry.id,'removed');
   done('temp');lines.push(`${label}: removido${resumed}.`);
  }catch{kept('temp',label,'falha ao remover; repita depois');}
 }
 // Directories that look like ours but carry no registry proof are never touched. Only their number is reported.
 if(root){
  const known=new Set(registry.temps.map(entry=>entry.path));
  const strangers=(await readdir(root).catch(()=>[] as string[])).filter(name=>/^ac-/.test(name)&&!known.has(join(root!,name)));
  if(strangers.length)lines.push(`${strangers.length} item(ns) ac-* no diretório temporário sem registro de propriedade: preservado(s).`);
 }
 const verb=apply?'removido(s)':'elegível(is)';
 lines.push(`${apply?'Retenção de artefatos aplicada':'Prévia, nada foi alterado'}: worktrees ${total.worktree.done} ${verb} e ${total.worktree.kept} preservado(s); imagens ${total.image.done} ${verb} e ${total.image.kept} preservada(s); temporários ${total.temp.done} ${verb} e ${total.temp.kept} preservado(s).`);
 return lines;
}

/** Artifacts a removed project left in the registry: its worktrees, candidate images, round temporaries and rounds. Without
 * `apply` nothing changes. Only the age rules and the "owner is still installed" rule are lifted; every proof that the artifact
 * is ours and unused is still required, the worktree goes with a plain `git worktree remove` (git refuses changes) and the image by
 * id without force. Whatever cannot be proved stays in the registry and is reported. The installation's own published pins are
 * refreshed afterwards, so other installations on the daemon stop honouring the project's images. */
export async function releaseProjectArtifacts(config:Installation,projectId:string,repo:string|undefined,apply:boolean,deps:RetentionDeps={}):Promise<{lines:string[];kept:number}>{
 if(!z.uuid().safeParse(projectId).success)throw new Refusal('PROJECT_ID_INVALID',400);
 if(projectsOf(config).some(item=>item.id===projectId))throw new Refusal('PROJECT_STILL_INSTALLED',409);
 const git=deps.git??defaultGit,docker=deps.docker??defaultDocker,now=deps.now??Date.now,processInside=deps.processInside??defaultProcessInside,mountInfo=deps.mountInfo??defaultMountInfo;
 const registry=await loadRegistry(config);
 const lines:string[]=[];
 let kept=0;
 const keep=(label:string,reason:string)=>{kept++;lines.push(`${label}: preservado (${reason}).`);};
 const forget=(kind:'worktree'|'image'|'temp',id:string,action:'removed'|'dropped')=>mutateRegistry(config,current=>{
  const list=kind==='worktree'?current.worktrees:kind==='image'?current.images:current.temps;
  const index=list.findIndex(item=>item.id===id);
  if(index>=0)list.splice(index,1);
  remember(current,kind,id,action,now());
 });
 const verb=apply?'removido':'seria removido';

 for(const entry of registry.worktrees.filter(item=>item.projectId===projectId)){
  const label=`worktree ${entry.path}`;
  try{
   const info=await lstat(entry.path,{bigint:true}).catch(error=>errno(error,'ENOENT')?null:Promise.reject(error));
   if(info===null){if(apply)await forget('worktree',entry.id,'dropped');lines.push(`${label}: registro ${apply?'retirado':'seria retirado'} (o diretório já não existe).`);continue;}
   if(entry.quarantine){keep(label,`quarentena registrada em ${entry.quarantine}; verificação manual necessária`);continue;}
   if(!repo){keep(label,'repositório do projeto desconhecido');continue;}
   if(info.isSymbolicLink()||!info.isDirectory()||await realpath(entry.path)!==entry.path){keep(label,'o caminho não é um diretório canônico');continue;}
   if(mountedInside(await mountInfo(),entry.path)){keep(label,'há montagem dentro do diretório');continue;}
   if(await mountedByContainer(docker,entry.path)){keep(label,'há contêiner com este diretório montado');continue;}
   if(await processInside(entry.path)){keep(label,'há processo usando o diretório');continue;}
   if(!apply){lines.push(`${label}: ${verb} (git worktree remove, sem --force; o ramo ${entry.branch} fica).`);continue;}
   const removed=await git(repo,['worktree','remove',entry.path]);
   if(removed.code!==0){keep(label,'o git recusou a remoção (há mudança ou arquivo fora do controle)');continue;}
   await forget('worktree',entry.id,'removed');
   lines.push(`${label}: removido (o ramo ${entry.branch} fica).`);
  }catch{keep(label,'falha ao verificar; repita depois');}
 }

 const images=registry.images.filter(item=>item.projectId===projectId);
 if(images.length){
  let guard:Awaited<ReturnType<typeof protectedDigests>>|undefined;
  try{guard=await protectedDigests(config,deps,docker,{releasedProject:projectId,apply,publish:apply});}catch{guard=undefined;}
  for(const entry of images){
   const label=`imagem ${entry.imageId.slice(0,19)} (${entry.module})`;
   if(!guard){keep(label,'não foi possível ler os digests fixados, os exames e as referências compartilhadas');continue;}
   try{
    const proof=await proveImage(entry,guard,docker,now(),0);
    if(!proof.ok){
     if('absent' in proof){if(apply)await forget('image',entry.id,'dropped');lines.push(`${label}: registro ${apply?'retirado':'seria retirado'} (${proof.reason}).`);}
     // A pin outside the removed project keeps the image: the common image retention takes it once the pin goes, so it does not hold
     // the removal (nor the repository link) open.
     else if(pinReasons.has(proof.reason))lines.push(`${label}: fica no Docker (${proof.reason}); a retenção de imagens a retira quando o pin sair.`);
     else keep(label,proof.reason);
     continue;
    }
    const size=proof.facts.size===undefined?'tamanho desconhecido':`${(proof.facts.size/1e9).toFixed(3)} GB nominais`;
    if(!apply){lines.push(`${label}: ${verb} (${size}).`);continue;}
    const again=await proveImage(entry,await protectedDigests(config,deps,docker,{releasedProject:projectId,apply:true}),docker,now(),0);
    if(!again.ok){keep(label,'mudou durante a remoção: '+again.reason);continue;}
    const removed=await docker(['image','rm',entry.imageId]);
    if(removed.code!==0){keep(label,'o Docker recusou a remoção');continue;}
    if((await docker(['image','inspect','--format','{{.Id}}',entry.imageId])).code===0){keep(label,'a imagem continua no Docker após a remoção');continue;}
    await forget('image',entry.id,'removed');
    lines.push(`${label}: removida (${size}).`);
   }catch{keep(label,'falha ao verificar; repita depois');}
  }
 }

 let root:string|undefined;
 try{root=await realpath(tempRoot(deps));}catch{root=undefined;}
 for(const entry of registry.temps.filter(item=>item.projectId===projectId)){
  const label=`temporário ${entry.path}`;
  if(!root){keep(label,'diretório temporário indisponível');continue;}
  try{
   const proof=await proveTemp(config,registry,entry,{now,processInside,docker,root,released:true});
   if(!proof.ok){
    if('absent' in proof){if(apply)await forget('temp',entry.id,'dropped');lines.push(`${label}: registro ${apply?'retirado':'seria retirado'} (${proof.reason}).`);}
    else keep(label,proof.reason);
    continue;
   }
   if(!apply){lines.push(`${label}: ${verb}.`);continue;}
   if(!entry.removing){
    const birth=String((await lstat(entry.path,{bigint:true})).birthtimeNs);
    const journal=await mutateRegistry(config,current=>{
     const stored=current.temps.find(item=>item.id===entry.id);
     if(!stored||stored.dev!==entry.dev||stored.ino!==entry.ino)throw new Refusal('RETENTION_REGISTRY_CHANGED',409);
     return stored.removing??={since:now(),birth};
    });
    if(journal.birth!==birth)throw new Refusal('RETENTION_REGISTRY_CHANGED',409);
   }
   await releaseRegisteredDirectory(entry.path,entry);
   await forget('temp',entry.id,'removed');
   lines.push(`${label}: removido.`);
  }catch{keep(label,'falha ao remover; repita depois');}
 }

 const rounds=registry.rounds.filter(item=>item.projectId===projectId).length;
 if(rounds){
  if(apply)await mutateRegistry(config,current=>{
   // A round still referenced by a kept temporary stays, so that temporary keeps its proof of ending.
   const held=new Set(current.temps.filter(item=>item.projectId===projectId).map(item=>item.roundId));
   current.rounds=current.rounds.filter(item=>item.projectId!==projectId||held.has(item.roundId));
  });
  lines.push(`rodadas registradas do projeto: ${rounds} ${apply?'retirada(s) do registro (as que ainda têm temporário preservado ficam)':'seriam retiradas do registro'}.`);
 }
 if(apply)await publishOwnReferences(config,deps,docker,true);
 return {lines,kept};
}
