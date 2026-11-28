import {DISK_BLOCK_PERCENT,diskUsedPercent,installationVolumes,readSpaceVerdict,SPACE_REFRESH_MS} from './personal-disk.ts';
import {measureSpace,writeSpaceRecord} from './personal-space.ts';
import {PERSONAL_EGRESS_DISABLED,PERSONAL_EGRESS_DISABLED_MESSAGE} from './personal-egress.ts';
import {runPersonalMaintenance} from './personal-maintenance.ts';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod, readFile, rename, writeFile} from 'node:fs/promises';
import pg from 'pg';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Refusal} from './contracts.ts';
import {loadInstallation, type Installation} from './installation.ts';
import {deliverPersonalPush} from './personal-push.ts';
import {diskNotice,spaceNotice,dueNotices,ERROR_WINDOW_MINUTES,loginNotices,agentConfigNotices,personalAccountRoot,repeatedErrorNotices,type HealthNotice} from './personal-health.ts';
import {containFailure} from './failure-log.ts';
import {checkPersonalDockerDependencies} from './personal-docker-dependencies.ts';

const hourMs=60*60*1000;
const imageId=/^sha256:[a-f0-9]{64}$/;

export const gatewayDownNotice='Agent Control fora do ar no servidor.';
export const gatewayUpNotice='Agent Control voltou.';
export const imagesRebuiltNotice='Imagens do Agent Control reconstruídas.';

type WatchState={consecutiveFailures:number;downNotified:boolean;lastImageRebuildAt:string|null;sent:Record<string,string>};
export type PersonalWatchDeps={
 dockerDependencies?:typeof checkPersonalDockerDependencies;
 retention?:(file:string,apply:boolean)=>Promise<unknown>;
 now?:()=>Date;
 probe?:(url:string)=>Promise<boolean>;
 notify?:(dataDirectory:string,body:string)=>Promise<void>;
 images?:(config:Installation)=>readonly string[];
 inspectImage?:(image:string)=>Promise<boolean>;
 rebuildImages?:(installationFile:string)=>Promise<void>;
 restartGateway?:(unit:string)=>Promise<void>;
 /** Gateway log lines from the last few minutes. */
 recentLog?:(unit:string,minutes:number)=>Promise<string>;
 /** Highest percent in use among the installation's volumes. */
 diskUsedPercent?:()=>Promise<number>;
 /** Space budget notices; by default measures again (personal:espaco) when the last reading is older than SPACE_REFRESH_MS. */
 space?:(config:Installation,installationFile:string,now:Date)=>Promise<HealthNotice[]>;
 /** Health notices about logins. */
 logins?:(config:Installation,installationFile:string,now:Date)=>Promise<HealthNotice[]>;
};

const emptyState=():WatchState=>({consecutiveFailures:0,downNotified:false,lastImageRebuildAt:null,sent:{}});

export function personalServiceName(installationFile:string){
 const name=basename(dirname(resolve(installationFile))).replace(/[^A-Za-z0-9_-]/g,'-');
 if(!name)throw new Refusal('INVALID_SERVICE_NAME');
 return name;
}

/** Current planning, worker, tools and QA images. Retired digests are not required. */
export function personalWatchImages(config:Installation):string[]{
 const boot=config.nativeBootstrap;
 if(!boot||boot.state==='disabled'||boot.state==='bench')return [];
 return [...new Set([boot.planning.imageId,boot.execution.workerImage,boot.execution.toolsImage,boot.qa.image])];
}

function parseState(value:unknown):WatchState{
 if(!value||typeof value!=='object')return emptyState();
 const row=value as Record<string,unknown>;
 const failures=row.consecutiveFailures;
 const down=row.downNotified;
 const at=row.lastImageRebuildAt;
 if(typeof failures!=='number'||!Number.isInteger(failures)||failures<0||failures>1_000_000)return emptyState();
 if(typeof down!=='boolean')return emptyState();
 if(at!==null&&(typeof at!=='string'||Number.isNaN(Date.parse(at))))return emptyState();
 const sent:Record<string,string>={};
 if(row.sent&&typeof row.sent==='object')for(const [key,value] of Object.entries(row.sent as Record<string,unknown>).slice(0,200))if(typeof value==='string'&&!Number.isNaN(Date.parse(value)))sent[key.slice(0,200)]=value;
 return {consecutiveFailures:failures,downNotified:down,lastImageRebuildAt:at,sent};
}

async function readState(path:string){
 let text:string;
 try{text=await readFile(path,'utf8');}
 catch(error){
  if((error as NodeJS.ErrnoException).code==='ENOENT')return emptyState();
  throw error;
 }
 try{return parseState(JSON.parse(text) as unknown);}
 catch{return emptyState();}
}

async function writeState(path:string,state:WatchState){
 const temporary=`${path}.${randomUUID()}.tmp`;
 await writeFile(temporary,JSON.stringify(state)+'\n',{mode:0o600,flag:'wx'});
 await chmod(temporary,0o600);
 await rename(temporary,path);
 await chmod(path,0o600);
}

async function defaultProbe(url:string){
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),5000);
 try{
  const response=await fetch(url,{signal:controller.signal,redirect:'manual'});
  // Any answer below 500 means the gateway process is up; the health route itself asks for a session.
  return response.status<500;
 }catch{return false;}
 finally{clearTimeout(timer);}
}

/** Direct Web Push. The gateway is not on this path, so a down gateway can still notify. */
async function defaultNotify(dataDirectory:string,body:string){
 await deliverPersonalPush(dataDirectory,{messageId:'watch-'+randomUUID(),title:'Agent Control',body,url:'/'});
}

function runCommand(command:string,args:string[],timeout:number,inherit:boolean,cwd?:string,env?:NodeJS.ProcessEnv){
 return new Promise<void>((resolvePromise,reject)=>{
  const child=spawn(command,args,{cwd,env,stdio:inherit?'inherit':'ignore'});
  const timer=setTimeout(()=>{child.kill();reject(new Error('TIMEOUT'));},timeout);
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('close',code=>{clearTimeout(timer);if(code===0)resolvePromise();else reject(new Error(String(code??1)));});
 });
}

async function defaultInspect(image:string){
 if(!imageId.test(image))return false;
 try{await runCommand('docker',['image','inspect',image],30_000,false);return true;}
 catch{return false;}
}

async function defaultRebuild(installationFile:string){
 const root=fileURLToPath(new URL('..',import.meta.url));
 await runCommand('npm',['run','personal:images','--',installationFile],60*60*1000,true,root,process.env);
}

async function defaultRestart(unit:string){
 if(!/^agent-control-gateway-[A-Za-z0-9_-]+$/.test(unit))throw new Error('INVALID_GATEWAY_UNIT');
 await runCommand('systemctl',['--user','restart',unit],120_000,true);
}

async function defaultRecentLog(unit:string,minutes:number){
 if(!/^agent-control-gateway-[A-Za-z0-9_-]+$/.test(unit))return '';
 return new Promise<string>(resolvePromise=>{
  const child=spawn('journalctl',['--user','-u',unit,'--since',`-${minutes}min`,'--no-pager','-o','cat'],{stdio:['ignore','pipe','ignore']});
  let text='';
  const timer=setTimeout(()=>child.kill(),30_000);
  child.stdout.on('data',chunk=>{if(text.length<8_000_000)text+=chunk;});
  child.on('error',()=>{clearTimeout(timer);resolvePromise('');});
  child.on('close',()=>{clearTimeout(timer);resolvePromise(text);});
 });
}

async function defaultLogins(config:Installation,installationFile:string,now:Date){
 const accountRoot=personalAccountRoot(config);
 const pool=new pg.Pool({connectionString:config.databaseUrl,max:1,connectionTimeoutMillis:5000});
 try{
  const rows=(await pool.query("SELECT id,provider FROM ac_accounts WHERE enabled AND mode='subscription_cli'")).rows as {id:string;provider:string}[];
  return [...await loginNotices(accountRoot,rows,now,installationFile),...await agentConfigNotices(accountRoot,rows)];
 }finally{await pool.end();}
}

function due(at:string|null,now:Date){
 if(!at)return true;
 const then=Date.parse(at);
 if(Number.isNaN(then))return true;
 return now.getTime()-then>=hourMs;
}

/** Keeps <dataDirectory>/space-last.json fresh for the launch gate and turns its verdict into a notice. */
export async function defaultSpace(config:Installation,installationFile:string,now:Date,measure=(c:Installation)=>measureSpace(c,{now:()=>now})):Promise<HealthNotice[]>{
 let verdict=await readSpaceVerdict(config.dataDirectory,now.getTime());
 const age='measuredAt' in verdict&&verdict.measuredAt?now.getTime()-Date.parse(verdict.measuredAt):Infinity;
 if(!(verdict.state==='ok'||verdict.state==='alerta'||verdict.state==='acima')||!(age<SPACE_REFRESH_MS)){
  await writeSpaceRecord(config.dataDirectory,await measure(config));
  verdict=await readSpaceVerdict(config.dataDirectory,now.getTime());
 }
 const notice=spaceNotice(verdict,installationFile);
 return notice?[notice]:[];
}

/** One check. Two health failures notify; recovery notifies once. At most one image rebuild per hour. */
export async function runPersonalWatch(argv:string[],deps:PersonalWatchDeps={}){
 const [installationArg]=argv;
 if(!installationArg||installationArg.startsWith('--')||argv.length!==1)throw new Refusal('WATCH_USAGE');
 const installationFile=resolve(installationArg);
 const config=await loadInstallation(installationFile);
 if(config.activation!=='personal')throw new Refusal('WATCH_PERSONAL_REQUIRED');
 const now=(deps.now??(()=>new Date()))();
 const probe=deps.probe??defaultProbe;
 const notify=deps.notify??defaultNotify;
 const inspect=deps.inspectImage??defaultInspect;
 const rebuild=deps.rebuildImages??defaultRebuild;
 const restart=deps.restartGateway??defaultRestart;
 const statePath=join(config.dataDirectory,'watch-state.json');
 // Sampled first: a full disk can break every write below, and the figure must predate the cleanup.
 let usedPercent:number|undefined;
 try{usedPercent=await (deps.diskUsedPercent?.()??diskUsedPercent(installationVolumes(config)));}catch{/* health checks can continue while a volume is unavailable */}
 let retentionFailed=false,stateUnsaved=false,summary='',tail='';
 // A failed write (ENOSPC included) must not stop alerts or the cleanup that frees the space.
 const persist=async(value:WatchState)=>{try{await writeState(statePath,value);return true;}catch{stateUnsaved=true;return false;}};
 try{
 const state=await readState(statePath).catch(async error=>{
  const alert=usedPercent===undefined?undefined:diskNotice(usedPercent);
  if(alert)await notify(config.dataDirectory,alert.text).catch(containFailure('WATCH_DISK_ALERT_NOT_SENT',undefined));
  throw error;
 });
 const dependencies=await (deps.dockerDependencies??checkPersonalDockerDependencies)(config.dockerDependencies);
 const up=await probe(`http://127.0.0.1:${config.http.port}/api/v1/ac/health`);
 let healthNotice:string|null=null;
 if(up){
  if(state.downNotified)healthNotice=gatewayUpNotice;
  state.consecutiveFailures=0;
  state.downNotified=healthNotice?false:state.downNotified;
 }else{
  state.consecutiveFailures+=1;
  if(state.consecutiveFailures>=2&&!state.downNotified)healthNotice=gatewayDownNotice;
 }
 if(healthNotice===gatewayDownNotice)state.downNotified=true;
 if(healthNotice===gatewayUpNotice)state.downNotified=false;
 if(healthNotice){
  try{await notify(config.dataDirectory,healthNotice);}
  catch{state.downNotified=healthNotice===gatewayUpNotice;healthNotice=null;/* not sent: the next check tries again, and the later checks still run */}
 }
 await persist(state);
 const wanted=(deps.images??personalWatchImages)(config).filter(image=>imageId.test(image));
 let imageStatus:'ok'|'skipped'|'rebuilt'|'failed'='ok';
 if(wanted.length>0&&dependencies.failed)imageStatus='skipped';
 else if(wanted.length>0){
  let missing=false;
  for(const image of wanted){
   let present=false;
   try{present=await inspect(image);}catch{present=false;}
   if(!present)missing=true;
  }
  if(!missing)imageStatus='ok';
  else if(usedPercent===undefined||usedPercent>=DISK_BLOCK_PERCENT||!due(state.lastImageRebuildAt,now))imageStatus='skipped';
  else{
   state.lastImageRebuildAt=now.toISOString();
   // Without a recorded attempt the hourly limit cannot hold, so no rebuild.
   if(!await persist(state))imageStatus='skipped';
   else try{
    await rebuild(installationFile);
    await restart(`agent-control-gateway-${personalServiceName(installationFile)}`);
    try{await notify(config.dataDirectory,imagesRebuiltNotice);}catch{/* rebuild already happened */}
    imageStatus='rebuilt';
   }catch{imageStatus='failed';}
  }
 }
 // Repeated errors, a full disk and logins about to expire. Each notice repeats at most at its own pace.
 const health:HealthNotice[]=[...dependencies.notices];
 try{
  const log=await (deps.recentLog??defaultRecentLog)(`agent-control-gateway-${personalServiceName(installationFile)}`,ERROR_WINDOW_MINUTES);
  health.push(...repeatedErrorNotices(log));
  if(log.includes(`[${PERSONAL_EGRESS_DISABLED}] Warning: ${PERSONAL_EGRESS_DISABLED_MESSAGE}`))
   health.push({key:'egress',text:PERSONAL_EGRESS_DISABLED_MESSAGE,repeatMs:hourMs});
 }catch{/* no log, no notice */}
 if(usedPercent!==undefined){const disk=diskNotice(usedPercent);if(disk)health.push(disk);}
 try{health.push(...await (deps.space??defaultSpace)(config,installationFile,now));}catch{/* a failed measurement leaves the last reading; the gate only warns once it expires */}
 try{health.push(...await (deps.logins??defaultLogins)(config,installationFile,now));}catch{/* database or files unavailable */}
 const planned=dueNotices(health,state.sent,now);
 state.sent=planned.sent;
 const delivered:HealthNotice[]=[];
 for(const item of planned.due){
  try{await notify(config.dataDirectory,item.text);state.sent[item.key]=now.toISOString();delivered.push(item);}
  catch{/* not recorded, so the next check tries again */}
 }
 await persist(state);
 const tags=[healthNotice===gatewayDownNotice?'down':'',healthNotice===gatewayUpNotice?'up':'',imageStatus==='rebuilt'?'images':'',...delivered.map(item=>item.key.split(':')[0]!)].filter(Boolean);
 const notice=tags.length?` notice=${tags.join('+')}`:'';
 const dockerStatus=dependencies.failed?' docker=failed':config.dockerDependencies?' docker=ok':'';
 summary=`watch gateway=${up?'up':'down'} failures=${state.consecutiveFailures} images=${imageStatus}${dockerStatus}`;tail=notice;
 }finally{
  // Always, after the alerts: the figure above was taken before this frees anything.
  try{
   if((config.retention?.automatic??'preview')!=='off'){
    if(deps.retention)await deps.retention(installationFile,config.retention?.automatic==='apply');
    else await runPersonalMaintenance([installationFile,'--retencao-automatica',...(config.retention?.automatic==='apply'?['--aplicar']:[])]);
   }
  }catch{retentionFailed=true;}
 }
 return `${summary}${retentionFailed?' retention=failed':''}${stateUnsaved?' state=unsaved':''}${tail}`;
}
