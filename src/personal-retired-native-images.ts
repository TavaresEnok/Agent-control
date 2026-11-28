import {randomUUID} from 'node:crypto';
import {chmod,readFile,readdir,readlink,rename,stat,unlink,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {Installation} from './installation.ts';
import {Ledger} from './ledger.ts';
import {nativeExecutionExecutorDigest} from './native-execution-contract.ts';
import {nativePlanningExecutorDigest} from './native-planning-contract.ts';

/** A retired execution pair is kept while any job under it is unfinished, or a reviewer, judge or QA job has not had its containers removed. */
export const OPEN_EXECUTION_JOBS_SQL=`SELECT count(*)::int n FROM ac_native_execution_jobs j WHERE j.executor_digest=$1 AND (j.state NOT IN ('completed','failed')
 OR (j.role IN ('reviewer','judge','qa') AND NOT EXISTS(SELECT 1 FROM ac_native_terminal_retirements t WHERE t.job_id=j.id AND t.state='removed')))`;

/** Days a retired executor must have started nothing before it leaves the installation. A gateway that was not restarted after a
 * rebuild still runs the old pair as active, so recent jobs under it mean it may still be launching. */
export const RETIRED_QUIET_DAYS=7;

/** Same as {@link OPEN_EXECUTION_JOBS_SQL}, plus any job created in the last `$2` days under that executor. */
const EXECUTION_IN_USE_SQL=`SELECT count(*)::int n FROM ac_native_execution_jobs j WHERE j.executor_digest=$1 AND (j.state NOT IN ('completed','failed')
 OR (j.role IN ('reviewer','judge','qa') AND NOT EXISTS(SELECT 1 FROM ac_native_terminal_retirements t WHERE t.job_id=j.id AND t.state='removed'))
 OR j.created_at>clock_timestamp()-($2::int*interval '1 day'))`;
/** A planning call names its executor (`selected_executor_digest`, or `executor_digest` for calls bound before the dispatcher):
 * one not published nor rejected, a native planning job not finished, or a call created in the last `$2` days keeps the image. */
const PLANNING_IN_USE_SQL=`SELECT count(*)::int n FROM ac_semantic_planning_calls c LEFT JOIN ac_native_planning_jobs j ON j.id=c.id
 WHERE (c.selected_executor_digest=$1 OR c.executor_digest=$1) AND (c.state NOT IN ('published','rejected')
 OR (j.id IS NOT NULL AND j.state NOT IN ('completed','failed')) OR c.created_at>clock_timestamp()-($2::int*interval '1 day'))`;

type Pair={workerImage:string;toolsImage:string};
export type RetiredNativeDeps={
 /** Jobs or calls under one executor digest that may still need its supervisor. Failure keeps every retired entry. */
 executionInUse?:(executorDigest:string)=>Promise<number>;
 planningInUse?:(executorDigest:string)=>Promise<number>;
 /** Start times of the gateway processes that serve this installation file. Failure keeps every retired entry. */
 gatewayStarts?:(installationFile:string)=>Promise<Date[]>;
 now?:()=>Date;
};

/** Start of every `server-main.ts serve <installationFile>` process, read from `proc` (start in clock ticks after boot, USER_HZ=100
 * on Linux). A gateway loads installation.json once, when it starts. The served file is looked up inside the process's own root
 * (`/proc/<pid>/root`), so a gateway in a container (`serve /data/installation.json` on the data volume) is matched by device and
 * inode. Doubt never means "no gateway": a serve process whose filesystem cannot be seen (another user, a container's root) is
 * counted, and a /proc mounted with `hidepid`, which hides other users' processes, is an error. */
export async function gatewayStartTimes(installationFile:string,proc='/proc'):Promise<Date[]>{
 const target=await stat(installationFile);
 if(process.getuid?.()!==0&&/ - proc \S+ \S*\bhidepid=(?!0\b|off\b)/m.test(await readFile(join(proc,'self','mountinfo'),'utf8')))throw new Error('PROC_HIDEPID');
 const boot=Number(/^btime (\d+)$/m.exec(await readFile(join(proc,'stat'),'utf8'))?.[1]);
 if(!Number.isSafeInteger(boot)||boot<=0)throw new Error('PROC_STAT_UNREADABLE');
 const starts:Date[]=[];
 for(const name of await readdir(proc)){
  if(!/^[1-9][0-9]*$/.test(name))continue;
  let argv:string[],fields:string[];
  try{
   argv=(await readFile(join(proc,name,'cmdline'),'utf8')).split('\0');
   const at=argv.findIndex(arg=>arg.endsWith('/server-main.ts')||arg==='server-main.ts');
   if(at<0||argv[at+1]!=='serve'||!argv[at+2])continue;
   const cwd=await readlink(join(proc,name,'cwd')).catch(()=>undefined);
   const file=argv[at+2]!;
   if(cwd!==undefined||file.startsWith('/')){
    try{
     const served=await stat(join(proc,name,'root',resolve(cwd??'/',file)));
     if(served.dev!==target.dev||served.ino!==target.ino)continue;
    }catch(error){
     // Absent in the process's own view: it serves another file. Any other failure (EACCES) cannot tell: counted.
     if((error as NodeJS.ErrnoException).code==='ENOENT'||(error as NodeJS.ErrnoException).code==='ENOTDIR')continue;
    }
   }
   const line=await readFile(join(proc,name,'stat'),'utf8');
   fields=line.slice(line.lastIndexOf(')')+2).split(' ');
  }catch{continue;/* the process ended while it was read */}
  const ticks=Number(fields[19]);
  if(!Number.isSafeInteger(ticks))throw new Error('PROC_STAT_UNREADABLE');
  starts.push(new Date((boot+ticks/100)*1000));
 }
 return starts;
}

function stampOf(now:Date){
 const pad=(value:number,width=2)=>value.toString().padStart(width,'0');
 return `${pad(now.getUTCFullYear(),4)}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

/** Drops from `installation.json` the retired native images (`execution.retiredImages`, `planning.retiredImageIds`) that no
 * non-terminal job or planning call can still need: every job and call is tied to its executor digest, which is a function of the
 * image(s). Only with `apply` the file is rewritten, atomically, after a private copy next to it. The image itself is not touched:
 * it becomes an unpinned AC image that the image retention proves and removes by id. Returns the new configuration when it changed. */
export async function retireNativeImages(config:Installation,installationFile:string,apply:boolean,deps:RetiredNativeDeps={}):Promise<{lines:string[];config?:Installation}>{
 const boot=config.nativeBootstrap as {planning?:{retiredImageIds?:string[]};execution?:{retiredImages?:Pair[]}}|undefined;
 const pairs:Pair[]=boot?.execution?.retiredImages??[],planning=boot?.planning?.retiredImageIds??[];
 if(!boot||(!pairs.length&&!planning.length))return {lines:['Imagens nativas aposentadas: nenhuma registrada.']};
 let ledger:Ledger|undefined;
 const count=async(sql:string,digest:string)=>{
  ledger??=new Ledger(config.databaseUrl,config.installationAuthority?.token);
  return Number((await ledger.pool.query<{n:number}>(sql,[digest,RETIRED_QUIET_DAYS])).rows[0]?.n??1);
 };
 // A gateway started before the last change of installation.json may still run a retired pair (or planning image) as its
 // active one: nothing is judged until it has been restarted on the current file.
 let stale:boolean;
 try{
  const changed=(await stat(installationFile)).mtimeMs;
  stale=(await (deps.gatewayStarts??gatewayStartTimes)(installationFile)).some(start=>start.getTime()<changed);
 }catch{return {lines:['Imagens nativas aposentadas preservadas: não foi possível saber quando o gateway em execução carregou a instalação.']};}
 if(stale)return {lines:['Imagens nativas aposentadas preservadas: o gateway em execução começou antes da última mudança de installation.json e ainda pode usar uma delas como ativa. Reinicie o gateway; a próxima retenção decide.']};
 const executionInUse=deps.executionInUse??(digest=>count(EXECUTION_IN_USE_SQL,digest));
 const planningInUse=deps.planningInUse??(digest=>count(PLANNING_IN_USE_SQL,digest));
 const keepPairs:Pair[]=[],dropPairs:Pair[]=[],keepPlanning:string[]=[],dropPlanning:string[]=[];
 try{
  for(const pair of pairs)((await executionInUse(nativeExecutionExecutorDigest(pair.workerImage,pair.toolsImage)))>0?keepPairs:dropPairs).push(pair);
  for(const id of planning)((await planningInUse(nativePlanningExecutorDigest(id)))>0?keepPlanning:dropPlanning).push(id);
 }catch{
  return {lines:['Imagens nativas aposentadas preservadas: o banco não respondeu sobre os jobs e chamadas que ainda as usam.']};
 }finally{await ledger?.close();}
 const lines:string[]=[];
 for(const pair of keepPairs)lines.push(`Par de execução aposentado preservado (job aberto ou iniciado há menos de ${RETIRED_QUIET_DAYS} dias): ${pair.workerImage} ${pair.toolsImage}.`);
 for(const id of keepPlanning)lines.push(`Imagem de planejamento aposentada preservada (chamada aberta ou iniciada há menos de ${RETIRED_QUIET_DAYS} dias): ${id}.`);
 if(!dropPairs.length&&!dropPlanning.length)return {lines:[...lines,'Imagens nativas aposentadas: nenhuma pode sair da instalação.']};
 const summary=`${dropPairs.length} par(es) de execução e ${dropPlanning.length} imagem(ns) de planejamento`;
 if(!apply)return {lines:[...lines,`Imagens nativas aposentadas sairiam da instalação: ${summary}; depois a retenção de imagens as prova e remove por id.`]};
 const original=await readFile(installationFile);
 const raw=JSON.parse(original.toString('utf8')) as {dataDirectory?:unknown;nativeBootstrap?:{planning?:Record<string,unknown>;execution?:Record<string,unknown>}};
 // The file must be the one this configuration came from, and say the same about the retired entries.
 if(raw.dataDirectory!==config.dataDirectory||JSON.stringify(raw.nativeBootstrap?.execution?.retiredImages??[])!==JSON.stringify(pairs)||
  JSON.stringify(raw.nativeBootstrap?.planning?.retiredImageIds??[])!==JSON.stringify(planning))
  return {lines:[...lines,'Imagens nativas aposentadas preservadas: installation.json mudou desde a leitura; a próxima retenção decide.']};
 const execution=raw.nativeBootstrap!.execution!,plan=raw.nativeBootstrap!.planning!;
 if(keepPairs.length)execution.retiredImages=keepPairs;else delete execution.retiredImages;
 if(keepPlanning.length)plan.retiredImageIds=keepPlanning;else delete plan.retiredImageIds;
 const parsed=Installation.safeParse(raw);
 if(!parsed.success)return {lines:[...lines,'Imagens nativas aposentadas preservadas: a instalação sem elas não passaria na validação.']};
 const stamp=stampOf((deps.now??(()=>new Date()))());
 let backup='';
 for(let index=1;;index++){
  backup=join(dirname(installationFile),`installation.json.before-retired-images-${stamp}${index===1?'':'-'+index}`);
  try{await writeFile(backup,original,{mode:0o600,flag:'wx'});break;}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||index>=100)throw error;}
 }
 await chmod(backup,0o600);
 const temporary=`${installationFile}.${randomUUID()}.tmp`;
 try{
  await writeFile(temporary,JSON.stringify(raw,null,2)+'\n',{mode:0o600,flag:'wx'});
  await chmod(temporary,0o600);
  // Last check before the swap: a concurrent writer (native setup) wins and this run gives up.
  if(!(await readFile(installationFile)).equals(original)){
   await unlink(temporary);
   return {lines:[...lines,'Imagens nativas aposentadas preservadas: installation.json mudou durante a retenção; a próxima decide.']};
  }
  await rename(temporary,installationFile);
 }catch(error){await unlink(temporary).catch(()=>undefined/* already renamed or never created */);throw error;}
 lines.push(`Imagens nativas aposentadas retiradas da instalação: ${summary}; backup em ${backup}. As inativas deixam de ser supervisionadas no próximo reinício do gateway (até lá, nenhuma outra sai da instalação); as imagens saem pela retenção de imagens, por id.`);
 return {lines,config:parsed.data};
}
