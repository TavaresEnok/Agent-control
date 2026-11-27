import {execFile,spawn} from 'node:child_process';
import {isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {promisify} from 'node:util';
import {loadInstallation} from './installation.ts';
import {personalServiceName} from './personal-watch.ts';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const exec=promisify(execFile);
const usage='Uso: npm run personal:update -- <instalação.json> [nome-do-serviço]';

function run(command:string,args:string[]){
 return new Promise<void>((done,fail)=>{
  const child=spawn(command,args,{cwd:root,stdio:'inherit'});
  child.once('error',fail);
  child.once('close',code=>code===0?done():fail(new Error('COMMAND_FAILED')));
 });
}

type UpdateDeps={
 backup?:(file:string)=>Promise<void>;
 initialize?:(file:string)=>Promise<void>;
 systemctl?:(args:string[])=>Promise<string>;
 wait?:(ms:number)=>Promise<void>;
 now?:()=>number;
 panel?:(url:string)=>Promise<boolean>;
};
const systemctl=async(args:string[])=>(await exec('systemctl',['--user',...args],{timeout:args[0]==='restart'?120_000:5_000})).stdout;

async function gatewayProperties(unit:string,properties:string,control:typeof systemctl){
 const output=await control(['show',unit,`--property=${properties}`]);
 return new Map(output.split('\n').filter(line=>line.includes('=')).map(line=>{
  const delimiter=line.indexOf('=');
  return [line.slice(0,delimiter),line.slice(delimiter+1)];
 }));
}

async function checkGatewayTarget(unit:string,file:string,control:typeof systemctl){
 const row=await gatewayProperties(unit,'LoadState,WorkingDirectory,ExecStart',control);
 const command=row.get('ExecStart')??'';
 const executable=/^\{ path=(.+?) ; argv\[\]=/.exec(command)?.[1];
 // systemctl show prints the argv for the loaded unit, including any drop-ins.
 const expected=`{ path=${executable} ; argv[]=${executable} --import tsx ${join(root,'src/server-main.ts')} serve ${file} ; ignore_errors=no ;`;
 if(row.get('LoadState')!=='loaded'||row.get('WorkingDirectory')!==root||!executable||!isAbsolute(executable)||!command.startsWith(expected))
  throw new Error('GATEWAY_TARGET_MISMATCH');
}

async function panelResponds(url:string){
 const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(5_000)});
 await response.body?.cancel();
 return response.status===200&&/^text\/html(?:;|$)/i.test(response.headers.get('content-type')??'');
}

async function waitForGateway(unit:string,deps:UpdateDeps){
 const now=deps.now??(()=>performance.now());
 const wait=deps.wait??sleep;
 const show=async()=>{
  const row=await gatewayProperties(unit,'LoadState,ActiveState,SubState,MainPID,NRestarts',deps.systemctl??systemctl);
  if(row.get('LoadState')!=='loaded'||row.get('NRestarts')!=='0'||
   row.get('ActiveState')==='failed'||row.get('SubState')==='auto-restart')throw new Error('GATEWAY_UNSTABLE');
  const pid=row.get('MainPID')??'';
  return row.get('ActiveState')==='active'&&row.get('SubState')==='running'&&/^[1-9][0-9]*$/.test(pid)?pid:undefined;
 };
 const deadline=now()+60_000;
 let pid:string|undefined,activeSince=0;
 while(now()<deadline){
  const current=await show();
  if(pid&&current!==pid)throw new Error('GATEWAY_UNSTABLE');
  if(!pid&&current){pid=current;activeSince=now();}
  if(pid&&now()-activeSince>=15_000){
   return async()=>{if(await show()!==pid)throw new Error('GATEWAY_UNSTABLE');};
  }
  await wait(1000);
 }
 throw new Error('GATEWAY_TIMEOUT');
}

async function stage(action:()=>Promise<unknown>,failure:string){
 try{await action();}catch{throw new Error(failure);}
}

export async function runPersonalUpdate(args:string[],deps:UpdateDeps={}){
 const [installation,name]=args;
 if(!installation||installation.startsWith('-')||args.length>2||(name!==undefined&&(!name||name.startsWith('-'))))throw new Error(usage);
 const file=resolve(installation);
 const config=await loadInstallation(file).catch(()=>{throw new Error('Instalação inválida. Confira o caminho, o JSON e as permissões do arquivo.');});
 if(config.activation!=='personal')throw new Error('A atualização exige uma instalação pessoal.');
 const unit=`agent-control-gateway-${name?.replace(/[^A-Za-z0-9_-]/g,'-')??personalServiceName(file)}.service`;
 const journal=`journalctl --user -u ${unit} -n 80`;
 const control=deps.systemctl??systemctl;
 const checkTarget=()=>stage(()=>checkGatewayTarget(unit,file,control),
  `Não foi possível confirmar a unidade ${unit} para este checkout e arquivo de instalação. Confira systemctl --user cat ${unit} e o nome usado em personal:services.`);
 await checkTarget();
 await stage(()=> (deps.backup??(path=>run('npm',['run','personal:backup','--',path])))(file),
  'Backup ou restore-check falhou. Confira o diagnóstico acima, o destino do backup e o acesso ao banco, depois rode personal:update novamente.');
 await stage(()=> (deps.initialize??(path=>run(process.execPath,['--import','tsx','src/server-main.ts','initialize',path])))(file),
  'Initialize falhou. Confira o erro da migração e o acesso ao banco. O backup foi conferido. Corrija a causa antes de tentar novamente.');
 await checkTarget();
 await stage(()=>control(['restart',unit]),
  `O reinício de ${unit} falhou após a migração. Confira a unidade instalada e rode ${journal}.`);
 const gatewayFailure=`O gateway não ficou estável após a migração. Rode ${journal}, corrija a falha e confira a unidade antes de usar o painel.`;
 const checkStable=await waitForGateway(unit,deps).catch(()=>{throw new Error(gatewayFailure);});
 const url=`http://${config.http.listen}:${config.http.port}/`;
 await stage(async()=>{
  if(!await (deps.panel??panelResponds)(url))throw new Error('PANEL_UNAVAILABLE');
 },`O painel não serviu HTML em ${url}. Confira o build do painel e rode ${journal}.`);
 await stage(checkStable,gatewayFailure);
 return `Atualização concluída. Gateway estável e painel disponível em ${url}.`;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 runPersonalUpdate(process.argv.slice(2)).then(console.log,error=>{
  console.error(error instanceof Error?error.message:'A atualização falhou.');
  process.exitCode=1;
 });
}
