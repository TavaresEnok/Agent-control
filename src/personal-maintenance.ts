import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod,copyFile,readFile,rename,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {Refusal} from './contracts.ts';
import {loadInstallation} from './installation.ts';
import {nativeExecutionExecutorDigest} from './native-execution-contract.ts';

const imageId=/^sha256:[a-f0-9]{64}$/;
type Pair={workerImage:string;toolsImage:string};

export type MaintenanceDeps={
 /** Runs a fixed docker command and returns its exit code. */
 docker?:(args:string[])=>Promise<number>;
 /** Whether Docker still has this image. */
 imageExists?:(image:string)=>Promise<boolean>;
 /** Execution jobs of one executor that may still need their old supervisor. */
 openExecutionJobs?:(executorDigest:string)=>Promise<number>;
 /** Planning calls not yet finished. Planning rows do not name their image, so any open call keeps every retired planning image. */
 openPlanningJobs?:()=>Promise<number>;
};

/** A retired execution pair is kept while any job under it is unfinished, or a reviewer, judge or QA job has not had its containers removed. */
export const OPEN_EXECUTION_JOBS_SQL=`SELECT count(*)::int n FROM ac_native_execution_jobs j WHERE j.executor_digest=$1 AND (j.state NOT IN ('completed','failed')
 OR (j.role IN ('reviewer','judge','qa') AND NOT EXISTS(SELECT 1 FROM ac_native_terminal_retirements t WHERE t.job_id=j.id AND t.state='removed')))`;
export const OPEN_PLANNING_JOBS_SQL=`SELECT count(*)::int n FROM ac_native_planning_jobs WHERE state NOT IN ('completed','failed')`;

function run(command:string,args:string[],timeout:number){
 return new Promise<number>(resolvePromise=>{
  const child=spawn(command,args,{stdio:'ignore'});
  const timer=setTimeout(()=>child.kill(),timeout);
  child.on('error',()=>{clearTimeout(timer);resolvePromise(1);});
  child.on('close',code=>{clearTimeout(timer);resolvePromise(code??1);});
 });
}

/** Which retired images can go. Pure: the caller supplies the job counts. */
export function retiredPlan(boot:{planning:{imageId:string;retiredImageIds?:string[]};execution:{workerImage:string;toolsImage:string;retiredImages?:Pair[]};qa?:{image?:string}},
 openExecution:Map<string,number>,openPlanning:number){
 const keepPairs:Pair[]=[],dropPairs:Pair[]=[];
 for(const pair of boot.execution.retiredImages??[]){
  ((openExecution.get(nativeExecutionExecutorDigest(pair.workerImage,pair.toolsImage))??1)>0?keepPairs:dropPairs).push(pair);
 }
 const retiredPlanning=boot.planning.retiredImageIds??[];
 const keepPlanning=openPlanning>0?retiredPlanning:[];
 const dropPlanning=openPlanning>0?[]:retiredPlanning;
 const inUse=new Set([boot.planning.imageId,boot.execution.workerImage,boot.execution.toolsImage,boot.qa?.image,...keepPlanning,...keepPairs.flatMap(p=>[p.workerImage,p.toolsImage])].filter(Boolean));
 const removable=[...new Set([...dropPlanning,...dropPairs.flatMap(p=>[p.workerImage,p.toolsImage])])].filter(id=>imageId.test(id)&&!inUse.has(id));
 return {keepPairs,dropPairs,keepPlanning,dropPlanning,removable};
}

async function writeInstallationAtomically(file:string,raw:unknown){
 const temporary=`${file}.${randomUUID()}.tmp`;
 await writeFile(temporary,JSON.stringify(raw,null,2)+'\n',{mode:0o600,flag:'wx'});
 await chmod(temporary,0o600);
 await rename(temporary,file);
}

/** Weekly: old Docker build cache goes, and retired images no job still needs leave the installation and Docker.
 * Volumes, containers and images of other projects are never touched. The gateway keeps running. */
export async function runPersonalMaintenance(argv:string[],deps:MaintenanceDeps={}){
 const [installationArg]=argv;
 if(!installationArg||installationArg.startsWith('--')||argv.length!==1)throw new Refusal('MAINTENANCE_USAGE');
 const file=resolve(installationArg);
 const config=await loadInstallation(file);
 if(config.activation!=='personal')throw new Refusal('MAINTENANCE_PERSONAL_REQUIRED');
 const docker=deps.docker??(args=>run('docker',args,30*60*1000));
 const imageExists=deps.imageExists??(async image=>imageId.test(image)&&await run('docker',['image','inspect',image],30_000)===0);
 const lines:string[]=[];
 const cache=await docker(['builder','prune','-f','--filter','until=168h']);
 lines.push(cache===0?'Cache de build com mais de 7 dias apagado.':'Cache de build não pôde ser limpo.');
 const boot=config.nativeBootstrap;
 if(!boot||boot.state==='disabled'||boot.state==='bench'){lines.push('Sem runtime nativo: nenhuma imagem aposentada.');return lines;}
 let pool:pg.Pool|undefined;
 const query=async(sql:string,params:unknown[])=>{
  pool??=new pg.Pool({connectionString:config.databaseUrl,max:1,connectionTimeoutMillis:5000});
  return Number((await pool.query(sql,params)).rows[0]?.n??1);
 };
 try{
  const openExecution=new Map<string,number>();
  for(const pair of boot.execution.retiredImages??[]){
   const executor=nativeExecutionExecutorDigest(pair.workerImage,pair.toolsImage);
   openExecution.set(executor,await (deps.openExecutionJobs??(digest=>query(OPEN_EXECUTION_JOBS_SQL,[digest])))(executor));
  }
  const openPlanning=(boot.planning.retiredImageIds??[]).length?await (deps.openPlanningJobs??(()=>query(OPEN_PLANNING_JOBS_SQL,[])))():0;
  const plan=retiredPlan(boot,openExecution,openPlanning);
  if(plan.dropPairs.length||plan.dropPlanning.length){
   const raw=JSON.parse(await readFile(file,'utf8')) as {nativeBootstrap:{planning:Record<string,unknown>;execution:Record<string,unknown>}};
   const planning=raw.nativeBootstrap.planning,execution=raw.nativeBootstrap.execution;
   if(plan.keepPlanning.length)planning.retiredImageIds=plan.keepPlanning;else delete planning.retiredImageIds;
   if(plan.keepPairs.length)execution.retiredImages=plan.keepPairs;else delete execution.retiredImages;
   await copyFile(file,`${file}.before-maintenance`);
   await chmod(`${file}.before-maintenance`,0o600);
   await writeInstallationAtomically(file,raw);
   lines.push(`Imagens aposentadas retiradas da instalação: ${plan.dropPairs.length} par(es) de execução e ${plan.dropPlanning.length} de planejamento. Cópia anterior em installation.json.before-maintenance.`);
  }else lines.push('Nenhuma imagem aposentada pôde sair: ainda há jobs abertos ou não há imagens aposentadas.');
  let removed=0;
  for(const image of plan.removable){
   if(!await imageExists(image))continue;
   if(await docker(['image','rm',image])===0)removed++;
  }
  if(removed)lines.push(`${removed} imagem(ns) aposentada(s) apagada(s) do Docker.`);
 }finally{await pool?.end();}
 return lines;
}
