import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,readFile,realpath,stat} from 'node:fs/promises';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {defaultGit,defaultProcessInside,listWorktrees,mountedInside,type CommandResult,type Listed} from './personal-artifact-retention.ts';
import {storageSettings} from './storage-config.ts';

/**
 * Retention of the development worktrees of the Agent Control repository itself (`storage.productRepo`). A worktree leaves with
 * `git worktree remove` (its branch stays) only when it is integrated and nothing in it would be lost: its HEAD is on a branch other
 * than its own (a worker's unmerged tip keeps it, even though the branch would survive), it has no tracked change
 * and no untracked file outside the ignore rules (the worktree's own and the product's current `.gitignore`), no git operation is in
 * progress, and nobody touched it for `storage.worktreeIdleHours`. Anything else stays and is reported. `git worktree prune` runs only
 * when the entries it would drop have no directory any more.
 */

type Git=(cwd:string,args:string[])=>Promise<CommandResult>;
export type DevWorktreeDeps={
 git?:Git;
 now?:()=>number;
 processInside?:(path:string)=>Promise<boolean>;
 mountInfo?:()=>Promise<string>;
 /** Host paths mounted by any container, running or stopped. */
 containerMounts?:()=>Promise<string[]>;
 /** Checkout of the running product, never removed. */
 productRoot?:string;
};

const execute=promisify(execFile);
const here=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const inside=(path:string,root:string)=>path===root||path.startsWith(root+sep);
const inProgress=['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','REBASE_HEAD','BISECT_LOG','rebase-merge','rebase-apply','sequencer','index.lock'];

async function defaultContainerMounts(){
 const docker=async(args:string[])=>(await execute('docker',args,{timeout:120000,maxBuffer:16*1024*1024})).stdout.trim();
 const ids=(await docker(['container','ls','-a','-q'])).split(/\s+/).filter(Boolean);
 if(!ids.length)return [];
 return (JSON.parse(await docker(['container','inspect',...ids])) as {Mounts?:{Source:string}[]}[]).flatMap(c=>(c.Mounts??[]).map(m=>m.Source));
}

type Verdict={ok:true;idleHours:number}|{ok:false;reason:string};
const no=(reason:string):Verdict=>({ok:false,reason});

async function judge(repo:string,item:Listed,options:{git:Git;now:number;idleMs:number;excludes?:string;product:string;deps:Required<Pick<DevWorktreeDeps,'processInside'|'mountInfo'|'containerMounts'>>}):Promise<Verdict>{
 const {git}=options,path=item.path;
 if(item.locked)return no('worktree travado');
 if(inside(options.product,path))return no('é o checkout do produto em execução');
 if(!item.head||!/^[a-f0-9]{40,64}$/.test(item.head))return no('HEAD ilegível');
 const containing=await git(repo,['for-each-ref','--contains',item.head,'--format=%(refname)','refs/heads']);
 if(containing.code!==0)return no('não foi possível provar que o HEAD está num ramo');
 const branches=containing.stdout.split('\n').map(line=>line.trim()).filter(Boolean);
 if(!branches.length)return no(`commit ${item.head.slice(0,12)} fora de qualquer ramo`);
 if(!branches.some(ref=>ref!==item.branch))return no('ramo ainda não integrado em outro ramo');
 const info=await lstat(path).catch(()=>undefined/* unreadable: kept below */);
 if(!info?.isDirectory()||info.uid!==process.getuid?.()||await realpath(path).catch(()=>'')!==path)return no('diretório não é o registrado pelo git');
 const gitDir=(await git(path,['rev-parse','--absolute-git-dir'])).stdout.trim();
 if(!gitDir.startsWith('/'))return no('git dir ilegível');
 for(const name of inProgress)if(await lstat(join(gitDir,name)).then(()=>true,()=>false))return no('operação do git em andamento');
 // git status overlooks files hidden by index flags.
 const index=await git(path,['ls-files','-v','-z']);
 if(index.code!==0||index.stdout.split('\0').some(line=>line&&!line.startsWith('H ')))return no('índice com arquivos ocultos ou ilegível');
 const status=await git(path,['status','--porcelain=v1','-z','--untracked-files=no','--ignore-submodules=none']);
 if(status.code!==0)return no('não foi possível ler o estado');
 if(status.stdout.replace(/\0/g,''))return no('há mudança rastreada');
 const untracked=await git(path,['ls-files','-z','--others','--exclude-standard',...(options.excludes?['--exclude-from='+options.excludes]:[])]);
 if(untracked.code!==0)return no('não foi possível listar os arquivos não rastreados');
 const strays=untracked.stdout.split('\0').filter(Boolean);
 if(strays.length)return no(`${strays.length} arquivo(s) não rastreado(s) fora das regras de ignorar, por exemplo ${strays[0]}`);
 let last=Number((await git(repo,['log','-1','--format=%ct',item.head])).stdout.trim())*1000||0;
 for(const file of [join(gitDir,'HEAD'),join(gitDir,'index'),join(gitDir,'logs','HEAD'),path])last=Math.max(last,(await stat(file).catch(()=>undefined/* absent */))?.mtimeMs??0);
 const idle=options.now-last;
 if(idle<options.idleMs)return no(`atividade há ${Math.floor(Math.max(idle,0)/3600000)} h (mínimo ${options.idleMs/3600000} h)`);
 try{if(await options.deps.processInside(path))return no('há processo usando o diretório');}catch{return no('não foi possível provar que nenhum processo usa o diretório');}
 try{if(mountedInside(await options.deps.mountInfo(),path))return no('há montagem dentro do diretório');}catch{return no('não foi possível ler as montagens');}
 try{if((await options.deps.containerMounts()).some(source=>inside(source,path)||inside(path,source)))return no('há contêiner com o diretório montado');}catch{return no('não foi possível consultar os contêineres');}
 return {ok:true,idleHours:Math.floor(idle/3600000)};
}

type DevInstallation={storage?:unknown};

export async function devWorktreeRetention(config:DevInstallation,apply:boolean,deps:DevWorktreeDeps={}):Promise<string[]>{
 const storage=storageSettings(config),repo=storage.productRepo;
 if(!repo)return [];
 const git=deps.git??defaultGit,now=deps.now??Date.now;
 const checks={processInside:deps.processInside??defaultProcessInside,mountInfo:deps.mountInfo??(()=>readFile('/proc/self/mountinfo','utf8')),containerMounts:deps.containerMounts??defaultContainerMounts};
 // The product's current ignore rules also cover build outputs that older branches did not list yet.
 const excludes=await lstat(join(repo,'.gitignore')).then(info=>info.isFile()?join(repo,'.gitignore'):undefined,()=>undefined/* no .gitignore */);
 const options={git,idleMs:storage.worktreeIdleHours*3600000,excludes,product:deps.productRoot??here,deps:checks};
 const listed=await listWorktrees(git,repo);
 const lines:string[]=[];
 let removed=0,kept=0,missing=0,strayRecords=0;
 for(const item of listed){
  if(item.main||item.bare)continue;
  const label=`worktree do produto ${item.path}`;
  if(item.prunable){
   // Only a definite ENOENT counts as "no directory".
   if(await lstat(item.path).then(()=>false,error=>(error as NodeJS.ErrnoException).code==='ENOENT'))missing++;
   else{strayRecords++;lines.push(`${label}: preservado (o git o marca como removível, mas a pasta responde).`);}
   continue;
  }
  try{
   const verdict=await judge(repo,item,{...options,now:now()});
   if(!verdict.ok){kept++;lines.push(`${label}: preservado (${verdict.reason}).`);continue;}
   const branch=item.branch?.replace(/^refs\/heads\//,'');
   if(!apply){removed++;lines.push(`${label}: elegível (${branch?'ramo '+branch+' integrado':'HEAD destacado contido em ramo'}, sem mudança, parado há ${verdict.idleHours} h).`);continue;}
   // Judged again right before, so a change since the first look wins. The checks above stand in for git's own refusal of
   // untracked files that only the product's current rules ignore, hence --force (a locked worktree is still refused).
   const again=await judge(repo,item,{...options,now:now()});
   if(!again.ok){kept++;lines.push(`${label}: preservado (mudou durante a retenção: ${again.reason}).`);continue;}
   const result=await git(repo,['worktree','remove','--force','--',item.path]);
   if(result.code!==0){kept++;lines.push(`${label}: preservado (o git recusou a remoção).`);continue;}
   const tip=branch?await git(repo,['rev-parse','--verify','--quiet','refs/heads/'+branch]):undefined;
   removed++;
   lines.push(`${label}: removido (${branch?`ramo ${branch} ${tip?.code===0&&tip.stdout.trim()===item.head?'preservado':'NÃO confere após a remoção'}`:'HEAD destacado já contido em ramo'}).`);
  }catch{kept++;lines.push(`${label}: preservado (falha ao verificar; repita depois).`);}
 }
 if(missing&&!strayRecords){
  if(apply){
   const pruned=await git(repo,['worktree','prune']);
   lines.push(pruned.code===0?`${missing} registro(s) de worktree sem pasta podado(s) com git worktree prune.`:'git worktree prune falhou; os registros sem pasta ficam.');
  }else lines.push(`${missing} registro(s) de worktree sem pasta seriam podados com git worktree prune.`);
 }else if(missing)lines.push(`${missing} registro(s) de worktree sem pasta ficam: há registro removível cuja pasta ainda responde.`);
 lines.push(`Worktrees do produto (${repo}): ${removed} ${apply?'removido(s)':'elegível(is)'}, ${kept} preservado(s).`);
 return lines;
}
