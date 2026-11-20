import {withInstallationImageLock} from './personal-image-lock.ts';
import {execFile,spawn} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,readFile,readdir,readlink,realpath,rename,rm,stat,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {z} from 'zod';
import {releaseRegisteredDirectory} from './native-work-retention.ts';
import {Refusal} from './contracts.ts';
import {privateDirectory,readPrivateFile,type Installation} from './installation.ts';
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
export const IMAGE_MIN_AGE_MS=2*60*60*1000;
export const TEMP_IDLE_MS=24*60*60*1000;
const HISTORY_MAX=200;
const MARKER='.ac-retention-owner';
const imageIdPattern=/^sha256:[a-f0-9]{64}$/;
const token=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const ref=z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine(value=>!value.includes('..')&&!value.endsWith('/')&&!value.endsWith('.lock')&&!value.includes('//'));
const absolutePath=z.string().max(4096).refine(value=>isAbsolute(value)&&resolve(value)===value&&!value.includes('\0'));
const time=z.number().int().safe().nonnegative();
const Worktree=z.object({id:z.uuid(),projectId:z.uuid(),path:absolutePath,branch:ref,base:ref,identity:z.string().optional(),registeredAt:time,origin:z.enum(['new','existing'])}).strict();
const Image=z.object({id:z.uuid(),projectId:z.uuid(),module:z.enum(VERIFICATION_MODULES),imageId:z.string().regex(imageIdPattern),registeredAt:time}).strict();
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

export type CommandResult={code:number;stdout:string};
export type RetentionDeps={
 /** Runs `git` in `cwd` with a sanitized environment. Tests record and fake it. */
 git?:(cwd:string,args:string[])=>Promise<CommandResult>;
 /** Runs `docker` with fixed arguments. */
 docker?:(args:string[])=>Promise<CommandResult>;
 now?:()=>number;
 /** Whether any live process has its cwd, root or an open file at or under `path`. Throwing means "cannot prove": the artifact is kept. */
 processInside?:(path:string)=>Promise<boolean>;
 /** Images named by verification runs (`ac_verify_runs.collector_image`). Failure keeps every image. */
 verifyRunImages?:(config:Installation)=>Promise<string[]>;
 /** Directory that holds round temporaries. Defaults to the canonical system temporary directory. */
 tmpRoot?:string;
 /** Root of this product checkout, where `deploy/modules/<modulo>/digest.txt` pins the module images. */
 productRoot?:string;
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
  execFile(command,args,{...options,encoding:'utf8',maxBuffer:64*1024*1024,windowsHide:true},(error,stdout)=>{
   const code=error?(typeof (error as {code?:unknown}).code==='number'?(error as unknown as {code:number}).code:1):0;
   done({code,stdout:stdout??''});
  });
 });
}
/** Git never runs hooks, a file-system monitor or any user/system configuration, and never refreshes the index. */
const defaultGit=(cwd:string,args:string[])=>run('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{cwd,timeout:120_000,
 env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',LC_ALL:'C'}});
const defaultDocker=(args:string[])=>run('docker',args,{timeout:10*60*1000,env:process.env});

async function defaultProcessInside(path:string){
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

async function defaultVerifyRunImages(config:Installation){
 const pool=new pg.Pool({connectionString:config.databaseUrl,max:1,connectionTimeoutMillis:5000});
 try{return (await pool.query<{collector_image:string}>('SELECT DISTINCT collector_image FROM ac_verify_runs WHERE collector_image IS NOT NULL')).rows.map(row=>row.collector_image);}
 finally{await pool.end();}
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

type Listed={path:string;head?:string;branch?:string;detached:boolean;bare:boolean;locked:boolean;prunable:boolean;main:boolean};
async function listWorktrees(git:NonNullable<RetentionDeps['git']>,repo:string):Promise<Listed[]>{
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
 return (await lstat(full).catch(()=>undefined))?.isSymbolicLink()===true;
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

type WorktreeFacts={tip:string;idleHours:number};
/** Everything that must hold, in order, before `git worktree remove` may run. */
async function proveWorktree(config:Installation,entry:WorktreeEntry,deps:Required<Pick<RetentionDeps,'git'|'now'|'processInside'>>):Promise<Verdict<WorktreeFacts>|{ok:false;reason:string;absent:true}>{
 const owner=projectsOf(config).find(item=>item.id===entry.projectId);
 if(!owner)return no('projeto fora desta instalação');
 const repo=owner.repo;
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
 const status=await deps.git(entry.path,['status','--porcelain=v1','-z','--untracked-files=all','--ignored=matching']);
 if(status.code!==0)return no('não foi possível ler o estado do worktree');
 for(const line of status.stdout.split('\0')){
  if(!line)continue;
  if(!line.startsWith('!! '))return no('há mudanças ou arquivos não rastreados');
  if(!await disposableIgnored(entry.path,line.slice(3)))return no('há arquivos ignorados com conteúdo próprio');
 }
 let last=Math.max(entry.registeredAt,Number(await deps.git(repo,['log','-1','--format=%ct',tipId]).then(r=>r.stdout.trim()).catch(()=>'0'))*1000||0);
 for(const name of ['HEAD','index','logs/HEAD'])last=Math.max(last,(await stat(join(gitDir,name)).catch(()=>undefined))?.mtimeMs??0);
 const idle=deps.now()-last;
 if(idle<WORKTREE_IDLE_MS)return no(`atividade há ${hours(Math.max(idle,0))} h (mínimo ${hours(WORKTREE_IDLE_MS)} h)`);
 try{if(await deps.processInside(entry.path))return no('há processo usando o diretório');}catch{return no('não foi possível provar que nenhum processo usa o diretório');}
 return {ok:true,facts:{tip:tipId,idleHours:hours(idle)}};
}

// ---- Registration --------------------------------------------------------------------------------------------

/** Records a worker worktree so retention may later remove it. Also adopts an existing worktree: git itself must list it,
 * on a local branch, in the project's own repository, and the integration branch must exist. The caller names no prefix and no pattern. */
export async function registerWorkerWorktree(config:Installation,input:{projectId:string;path:string;branch:string;base:string;adopt?:boolean},deps:RetentionDeps={}){
 const entryInput=Worktree.omit({id:true,registeredAt:true,origin:true,identity:true}).safeParse({projectId:input.projectId,path:input.path,branch:input.branch,base:input.base});
 if(!entryInput.success||input.branch===input.base)throw new Refusal('RETENTION_REGISTRATION_INVALID',400);
 const owner=project(config,input.projectId),git=deps.git??defaultGit,now=(deps.now??Date.now)();
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
export async function registerCandidateImage(config:Installation,input:{projectId:string;module:(typeof VERIFICATION_MODULES)[number];imageId:string},deps:RetentionDeps={}){
 if(!imageIdPattern.test(input.imageId)||!(VERIFICATION_MODULES as readonly string[]).includes(input.module))throw new Refusal('RETENTION_REGISTRATION_INVALID',400);
 project(config,input.projectId);
 const inspected=await (deps.docker??defaultDocker)(['image','inspect','--format','{{.Id}}',input.imageId]);
 if(inspected.code!==0||inspected.stdout.trim()!==input.imageId)throw new Refusal('RETENTION_REGISTRATION_INVALID',400);
 const now=(deps.now??Date.now)();
 return mutateRegistry(config,registry=>{
  const same=registry.images.find(item=>item.imageId===input.imageId&&item.projectId===input.projectId);
  if(same){if(same.module!==input.module)throw new Refusal('RETENTION_REGISTRATION_CONFLICT',409);return same.id;}
  const id=randomUUID();
  registry.images.push({id,projectId:input.projectId,module:input.module,imageId:input.imageId,registeredAt:now});
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
 const info=await lstat(input.path).catch(()=>undefined);
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
 }catch(error){await unlink(join(input.path,MARKER)).catch(()=>{});throw error;}
 return id;
}

/** Marks a round as finished. The first end time wins; temporaries of the round become removable 24 h later. */
export async function closeRound(config:Installation,input:{projectId:string;roundId:string},deps:RetentionDeps={}){
 if(!token.safeParse(input.roundId).success)throw new Refusal('RETENTION_REGISTRATION_INVALID',400);
 project(config,input.projectId);
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

/** Every digest the installation or any of its project checkouts pins, or that a verification run recorded. Any read failure other than a missing file throws. */
async function protectedDigests(config:Installation,deps:RetentionDeps){
 const found=new Set<string>(digestsIn(JSON.stringify(config.nativeBootstrap??null)));
 const roots=new Set([deps.productRoot??here,...projectsOf(config).map(item=>item.repo)]);
 for(const root of roots)for(const module of VERIFICATION_MODULES){
  let text:string;
  try{text=await readFile(join(root,'deploy','modules',module,'digest.txt'),'utf8');}
  catch(error){if(errno(error,'ENOENT')||errno(error,'ENOTDIR'))continue;throw error;}
  for(const digest of digestsIn(text))found.add(digest);
 }
 for(const image of await (deps.verifyRunImages??defaultVerifyRunImages)(config))for(const digest of digestsIn(image))found.add(digest);
 return found;
}

type ImageFacts={digests:string[]};
async function proveImage(entry:ImageEntry,pinned:Set<string>,docker:NonNullable<RetentionDeps['docker']>,now:number):Promise<Verdict<ImageFacts>|{ok:false;reason:string;absent:true}>{
 const inspected=await docker(['image','inspect',entry.imageId]);
 if(inspected.code!==0){
  const alive=await docker(['version','--format','{{.Server.Version}}']);
  return alive.code===0?{ok:false,reason:'a imagem já não existe no Docker',absent:true}:no('Docker indisponível');
 }
 let digests:string[];
 try{
  const [image]=JSON.parse(inspected.stdout) as {Id?:string;RepoDigests?:string[]}[];
  if(image?.Id!==entry.imageId)return no('o id da imagem não é o registrado');
  digests=[image.Id,...(image.RepoDigests??[]).flatMap(item=>[...digestsIn(item)])];
 }catch{return no('resposta ilegível do Docker');}
 if(digests.some(digest=>pinned.has(digest)))return no('digest fixado ou referenciado por exame');
 const age=now-entry.registeredAt;
 if(age<IMAGE_MIN_AGE_MS)return no(`registrada há ${hours(Math.max(age,0))} h (mínimo ${hours(IMAGE_MIN_AGE_MS)} h)`);
 const containers=await docker(['container','ls','-a','--no-trunc','-q','--filter','ancestor='+entry.imageId]);
 if(containers.code!==0)return no('não foi possível listar contêineres');
 if(containers.stdout.trim())return no('há contêiner usando a imagem');
 return {ok:true,facts:{digests}};
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
async function mountedByContainer(docker:NonNullable<RetentionDeps['docker']>,path:string){
 const listed=await docker(['container','ls','-a','--no-trunc','-q']);
 if(listed.code!==0)throw new Error('docker unavailable');
 const ids=listed.stdout.split('\n').map(line=>line.trim()).filter(Boolean);
 if(!ids.length)return false;
 const inspected=await docker(['container','inspect','--format','{{range .Mounts}}{{println .Source}}{{end}}',...ids]);
 if(inspected.code!==0)throw new Error('docker inspect failed');
 return inspected.stdout.split('\n').some(source=>source===path||source.startsWith(path+sep)||(source!==''&&path.startsWith(source+sep)));
}

async function proveTemp(config:Installation,registry:ArtifactRegistry,entry:TempEntry,deps:Required<Pick<RetentionDeps,'now'|'processInside'|'docker'>>&{root:string}):Promise<Verdict<{idleHours:number;resumed:boolean}>|{ok:false;reason:string;absent:true}>{
 if(!projectsOf(config).some(item=>item.id===entry.projectId))return no('projeto fora desta instalação');
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
 const round=registry.rounds.find(item=>item.projectId===entry.projectId&&item.roundId===entry.roundId);
 if(!round)return no('rodada sem prova de encerramento');
 if(round.endedAt<entry.registeredAt)return no('encerramento anterior ao registro');
 const idle=deps.now()-round.endedAt;
 if(idle<TEMP_IDLE_MS)return no(`rodada encerrada há ${hours(Math.max(idle,0))} h (mínimo ${hours(TEMP_IDLE_MS)} h)`);
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
 const git=deps.git??defaultGit,docker=deps.docker??defaultDocker,now=deps.now??Date.now,processInside=deps.processInside??defaultProcessInside;
 const registry=await loadRegistry(config);
 const lines:string[]=[];
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
  try{
   const proof=await proveWorktree(config,entry,{git,now,processInside});
   if(!proof.ok){
    if('absent' in proof){
     if(apply)await forget('worktree',entry.id,'dropped');
     done('worktree');lines.push(`${label}: ${apply?'registro retirado':'registro seria retirado'} (${proof.reason}).`);
    }else kept('worktree',label,proof.reason);
    continue;
   }
   if(!apply){done('worktree');lines.push(`${label}: elegível (ramo ${entry.branch} integrado em ${entry.base}, limpo, ocioso há ${proof.facts.idleHours} h).`);continue;}
   // Judged again, so a change since the first look wins.
   const again=await proveWorktree(config,entry,{git,now,processInside});
   if(!again.ok){kept('worktree',label,'mudou durante a retenção: '+again.reason);continue;}
   const owner=project(config,entry.projectId);
   // No --force: git itself refuses a worktree with changes. The branch is never touched.
   const removed=await git(owner.repo,['worktree','remove',entry.path]);
   if(removed.code!==0){kept('worktree',label,'o git recusou a remoção');continue;}
   const branch=await git(owner.repo,['rev-parse','--verify','--quiet','refs/heads/'+entry.branch+'^{commit}']);
   await forget('worktree',entry.id,'removed');
   done('worktree');
   lines.push(`${label}: removido (ramo ${entry.branch} ${branch.code===0&&branch.stdout.trim()===again.facts.tip?'preservado':'NÃO confere após a remoção'}).`);
  }catch{kept('worktree',label,'falha ao verificar; repita depois');}
 }

 if(registry.images.length){
  let pinned:Set<string>|undefined;
  try{pinned=await protectedDigests(config,deps);}catch{pinned=undefined;}
  for(const entry of registry.images){
   const label=`imagem ${entry.imageId.slice(0,19)} (${entry.module})`;
   if(!pinned){kept('image',label,'não foi possível ler os digests fixados e os exames');continue;}
   try{
    const proof=await proveImage(entry,pinned,docker,now());
    if(!proof.ok){
     if('absent' in proof){
      if(apply)await forget('image',entry.id,'dropped');
      done('image');lines.push(`${label}: ${apply?'registro retirado':'registro seria retirado'} (${proof.reason}).`);
     }else kept('image',label,proof.reason);
     continue;
    }
    if(!apply){done('image');lines.push(`${label}: elegível (sem contêiner, sem digest fixado, sem exame que a cite).`);continue;}
    const removed=await withInstallationImageLock(config.dataDirectory,false,async()=>{
     const again=await proveImage(entry,await protectedDigests(config,deps),docker,now());
     if(!again.ok)return 'mudou durante a retenção: '+again.reason;
     const latest=await protectedDigests(config,deps);
     if(again.facts.digests.some(digest=>latest.has(digest)))return 'digest fixado ou referenciado por exame';
     return (await docker(['image','rm','--no-prune',entry.imageId])).code===0?undefined:'o Docker recusou a remoção';
    });
    if(removed){kept('image',label,removed);continue;}
    await forget('image',entry.id,'removed');
    done('image');lines.push(`${label}: removida.`);
   }catch{kept('image',label,'falha ao verificar; repita depois');}
  }
 }

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
