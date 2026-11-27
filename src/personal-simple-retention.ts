import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,readdir,readFile,realpath} from 'node:fs/promises';
import {basename,join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {Ledger} from './ledger.ts';
import type {Installation} from './installation.ts';
import {inventoryJobWork,releaseRegisteredDirectory} from './native-work-retention.ts';
import {releaseIdleSharedWorktrees} from './simple-worktree.ts';
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

export async function simpleJobRetention(config:Installation,apply:boolean){
 const boot=config.nativeBootstrap;
 if(boot?.state!=='active')return [];
 const root=boot.execution.hostRoot;
 const {ids}=await inventoryJobWork(root);
 const ledger=new Ledger(config.databaseUrl);
 const liveMounts=(await containers(false)).flatMap(c=>c.Mounts.map(m=>m.Source));
 const lines:string[]=[];
 try{
  const rows=await ledger.pool.query<{id:string;repo:string|null}>(`SELECT j.id,r.repo FROM (
    SELECT id,context_id,state FROM ac_native_execution_jobs UNION ALL
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
   if(apply)await docker(['image','rm',image.Id]);
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

export async function simpleTempRetention(config:Installation,apply:boolean){
 const root=await realpath(tmpdir()),mounts=await readFile('/proc/self/mountinfo','utf8');
 const protectedPaths=[config.dataDirectory,...[config.project,...config.projects].map(p=>p.repo),
  ...(await containers(true)).flatMap(c=>c.Mounts.map(m=>m.Source))];
 const lines:string[]=[];
 for(const entry of await readdir(root,{withFileTypes:true})){
  if(!entry.isDirectory()||!/^(?:ac-|chatisp-)[A-Za-z0-9._-]{1,120}$/.test(entry.name)||protectedName(entry.name)||/backup|verificacoes/i.test(entry.name))continue;
  const path=resolve(root,entry.name),info=await lstat(path,{bigint:true});
  if(info.uid!==BigInt(process.getuid!())||Date.now()-Number(info.mtimeMs)<day||protectedPaths.some(p=>overlap(p,path))||mountedInside(mounts,path)||await defaultProcessInside(path))continue;
  // Git checkouts may be unmerged worker branches. Registered worker worktrees
  // use the existing merge and clean-tree checks in artifact retention.
  if(await lstat(join(path,'.git')).then(s=>s.isFile(),()=>false))continue;
  if(apply)await releaseRegisteredDirectory(path,{dev:String(info.dev),ino:String(info.ino)});
  lines.push((apply?'Temporário removido ':'Temporário elegível ')+basename(path));
 }
 return lines;
}
