import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod,readFile,readdir,realpath,rename,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Id,Refusal} from './contracts.ts';
import {Installation,loadInstallation} from './installation.ts';
import {Ledger} from './ledger.ts';
import {nativeBootstrapSchemaError} from './native-bootstrap.ts';
import {personalConnect} from './personal-connect.ts';
import {assertRepositoryInsideRoot} from './personal-folders.ts';
import {isPersonalRemoteCheckout} from './personal-ssh.ts';
import {Projects} from './projects.ts';

export type PersonalProjectAddResult={projectId:string;label:string;repository:string;restart:string};
export type PersonalProjectAccountsResult={
 projectId:string;
 label:string;
 allowedAccountIds:string[]|null;
 backupPath:string;
 restart:string;
};

const CONTAS_USAGE='Uso: npm run personal:project -- --contas <instalação.json> <id-ou-rótulo-do-projeto> <uuid>[,<uuid>...]|--todas';

const contasMessages:Record<string,string>={
 PROJECT_CONTAS_USAGE:CONTAS_USAGE,
 PERSONAL_ACTIVATION_REQUIRED:'A restrição de contas por projeto só roda numa instalação pessoal.',
 NOT_FOUND:'Projeto não encontrado.',
 PROJECT_AMBIGUOUS:'Há mais de um projeto com esse rótulo. Informe o UUID do projeto.',
 PROJECT_ACCOUNT_INVALID:'UUID de conta inválido. Informe UUIDs separados por vírgula ou --todas.',
 PROJECT_ACCOUNT_DUPLICATE:'A lista de contas permitidas contém UUID repetido.',
 PROJECT_ACCOUNT_LIMIT:'A lista aceita no máximo 8 contas permitidas por projeto.',
 PROJECT_ACCOUNT_INACTIVE:'A conta informada não existe ou não está ativa (ac_accounts.enabled) nesta instalação.',
 INVALID_INSTALLATION:'O arquivo de instalação ficou inválido após a alteração.',
};

export function personalProjectContasFailureText(error:unknown):string{
 const code=error instanceof Refusal?error.code:error instanceof Error?error.message:'';
 return contasMessages[code]??(code||'Não foi possível atualizar as contas permitidas do projeto.');
}

function stampOf(now:Date):string{
 const pad=(value:number,width=2)=>value.toString().padStart(width,'0');
 return `${pad(now.getUTCFullYear(),4)}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function parseContasSpec(spec:string|readonly string[]):string[]|null{
 if(spec==='--todas')return null;
 const rawParts=typeof spec==='string'?spec.split(','):spec;
 if(rawParts.length===0)throw new Refusal('PROJECT_CONTAS_USAGE',400);
 const parts=rawParts.map(item=>String(item).trim());
 if(parts.some(item=>item.length===0))throw new Refusal('PROJECT_CONTAS_USAGE',400);
 if(parts.length===1&&parts[0]==='--todas')return null;
 if(parts.some(item=>item.startsWith('--')||!Id.safeParse(item).success))throw new Refusal('PROJECT_ACCOUNT_INVALID',400);
 if(new Set(parts).size!==parts.length)throw new Refusal('PROJECT_ACCOUNT_DUPLICATE',400);
 if(parts.length>8)throw new Refusal('PROJECT_ACCOUNT_LIMIT',400);
 return parts;
}

export async function setPersonalProjectAccounts(
 installationPath:string,
 projectToken:string,
 accountsSpec:string|readonly string[],
 options?:{now?:Date},
):Promise<PersonalProjectAccountsResult>{
 const resolvedPath=resolve(installationPath);
 const config=await loadInstallation(resolvedPath);
 if(config.activation!=='personal')throw new Refusal('PERSONAL_ACTIVATION_REQUIRED',403);
 const service=basename(config.dataDirectory).replace(/[^A-Za-z0-9_-]/g,'-')||'gateway';
 const token=projectToken.trim();
 if(!token||token.startsWith('--'))throw new Refusal('PROJECT_CONTAS_USAGE',400);
 const hits=[config.project,...config.projects].filter(item=>item.id===token||item.label===token);
 if(hits.length===0)throw new Refusal('NOT_FOUND',404);
 if(hits.length>1)throw new Refusal('PROJECT_AMBIGUOUS',409);
 const selected=hits[0]!;
 const allowedAccountIds=parseContasSpec(accountsSpec);

 if(allowedAccountIds!==null){
  const ledger=new Ledger(config.databaseUrl,config.installationAuthority?.token);
  try{
   const rows=(await ledger.pool.query<{id:string;enabled:boolean;owner_id:string}>(
    'SELECT id::text AS id, enabled, owner_id FROM ac_accounts WHERE id = ANY($1::uuid[])',
    [allowedAccountIds],
   )).rows;
   const byId=new Map(rows.map(row=>[row.id,row]));
   for(const accountId of allowedAccountIds){
    const row=byId.get(accountId);
    if(!row||!row.enabled||(row.owner_id!==selected.owner&&row.owner_id!==config.project.owner)){
     throw new Refusal('PROJECT_ACCOUNT_INACTIVE',409);
    }
   }
  }finally{
   await ledger.close();
  }
 }

 const originalBytes=await readFile(resolvedPath);
 const raw=JSON.parse(originalBytes.toString('utf8')) as {
  project?:Record<string,unknown>;
  projects?:Record<string,unknown>[];
 };
 const applyToEntry=(entry:Record<string,unknown>)=>{
  const next={...entry};
  if(allowedAccountIds===null)delete next.allowedAccountIds;
  else next.allowedAccountIds=allowedAccountIds;
  return next;
 };
 if(raw.project&&raw.project.id===selected.id){
  raw.project=applyToEntry(raw.project);
 }
 if(Array.isArray(raw.projects)){
  raw.projects=raw.projects.map(entry=>entry&&entry.id===selected.id?applyToEntry(entry):entry);
 }
 const parsed=Installation.safeParse(raw);
 if(!parsed.success)throw new Refusal('INVALID_INSTALLATION',400);
 const backupPath=join(dirname(resolvedPath),`installation.json.before-contas-${stampOf(options?.now??new Date())}`);
 try{
  await writeFile(backupPath,originalBytes,{mode:0o600,flag:'wx'});
 }catch(error){
  if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
 }
 await chmod(backupPath,0o600);
 await writePrivate(resolvedPath,JSON.stringify(raw,null,2)+'\n');
 return {
  projectId:selected.id,
  label:selected.label,
  allowedAccountIds,
  backupPath,
  restart:`systemctl --user restart agent-control-gateway-${service}`,
 };
}

export async function runPersonalProjectContasCli(argv:readonly string[],options?:{now?:Date}):Promise<string[]>{
 const [flag,file,projectToken,accountsSpec,...extra]=argv;
 if(
  flag!=='--contas'
  ||!file
  ||!projectToken
  ||!accountsSpec
  ||extra.length>0
  ||file.startsWith('--')
  ||projectToken.startsWith('--')
  ||(accountsSpec.startsWith('--')&&accountsSpec!=='--todas')
 ){
  throw new Refusal('PROJECT_CONTAS_USAGE',400);
 }
 const result=await setPersonalProjectAccounts(file,projectToken,accountsSpec,options);
 const headline=result.allowedAccountIds===null
  ?`Restrição de contas removida do projeto ${result.label} (${result.projectId}). Todas as contas ativas estão liberadas.`
  :`Contas permitidas gravadas para o projeto ${result.label} (${result.projectId}): ${result.allowedAccountIds.join(', ')}.`;
 return [headline,`Backup: ${result.backupPath}`,result.restart];
}

/**
 * Attaches one Git repository to a personal installation that already exists.
 * Same database, same logins and the same conversation key.
 * Phase 3 calls this from the panel. A second run does not create another project.
 */
export async function addPersonalProject(installationPath:string,repository:string,label:string,options?:{insideRoot?:string}):Promise<PersonalProjectAddResult>{
 const clean=cleanLabel(label);
 const repo=await canonicalRepository(repository);
 if(options?.insideRoot)await assertRepositoryInsideRoot(options.insideRoot,repo);
 const config=await loadInstallation(installationPath);
 if(config.activation!=='personal')throw new Error('PERSONAL_ACTIVATION_REQUIRED');
 const service=basename(config.dataDirectory).replace(/[^A-Za-z0-9_-]/g,'-');
 if(!service)throw new Error('INVALID_SERVICE_NAME');
 let existing:Installation['project']|undefined;
 for(const project of [config.project,...config.projects]){
  if(await sameRepository(project.repo,repo)){existing={...project,repo};break;}
 }
 // The primary project is connected by personal-connect. A listed project that already has a conversation is refused.
 if(existing&&(existing.id===config.project.id||(config.managerTransport?.contexts??[]).some(item=>item.projectId===existing!.id)))
  throw new Error('REPOSITORY_ALREADY_IN_INSTALLATION');
 const data=await realpath(config.dataDirectory);
 // A remote project is a clone under dataDirectory/remote/<name>. The data directory still must not sit inside the clone.
 if(repo===data||data.startsWith(repo+sep)||(repo.startsWith(data+sep)&&!isPersonalRemoteCheckout(data,repo)))throw new Error('DATA_DIRECTORY_PATH_FORBIDDEN');
 const project=existing??{id:randomUUID(),label:clean,repo,owner:config.project.owner};
 const candidate=existing?config:{...config,projects:[...config.projects,project]};
 const schema=nativeBootstrapSchemaError(candidate);
 if(schema)throw new Error(schema);
 const parsed=Installation.safeParse(candidate);
 if(!parsed.success)throw new Error(parsed.error.issues[0]?.message??'INVALID_INSTALLATION');
 if(await belongsToAnotherInstallation(data,installationPath,repo))throw new Error('REPOSITORY_OF_ANOTHER_INSTALLATION');
 const ledger=new Ledger(config.databaseUrl,config.installationAuthority?.token);
 try{
  const row=(await ledger.pool.query('SELECT project_id FROM ac_project_repositories WHERE repo=$1',[repo])).rows[0] as {project_id:string}|undefined;
  const known=new Set([config.project.id,...config.projects.map(item=>item.id),project.id]);
  if(row&&!known.has(String(row.project_id)))throw new Error('REPOSITORY_OF_ANOTHER_INSTALLATION');
  if(options?.insideRoot)await assertRepositoryInsideRoot(options.insideRoot,repo);
  await backupInstallation(installationPath,clean);
  if(!existing){
   const raw=JSON.parse(await readFile(installationPath,'utf8')) as {projects?:Installation['project'][]};
   raw.projects=[...(raw.projects??[]),project];
   await writePrivate(installationPath,JSON.stringify(raw,null,2)+'\n');
  }
  await new Projects(ledger).register([project]);
 }finally{await ledger.close();}
 const connected=await personalConnect(installationPath);
 if(connected.state!=='connected')throw new Error('next' in connected?connected.next:'ACCOUNTS_REQUIRED');
 return {projectId:project.id,label:project.label,repository:repo,restart:`systemctl --user restart agent-control-gateway-${service}`};
}

function cleanLabel(label:string){
 const clean=label.trim();
 if(clean.length<1||clean.length>200||/[\u0000-\u001f\u007f]/.test(clean))throw new Error('LABEL_INVALID');
 return clean;
}
async function canonicalRepository(repository:string){
 let repo:string;
 try{repo=await realpath(repository);}catch{throw new Error('NOT_A_GIT_REPOSITORY');}
 const git=(args:string[])=>{
  try{return execFileSync('/usr/bin/git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
  catch{return undefined;}
 };
 const top=git(['rev-parse','--show-toplevel']);
 if(git(['rev-parse','--is-inside-work-tree'])!=='true'||!top)throw new Error('NOT_A_GIT_REPOSITORY');
 let topReal:string;
 try{topReal=await realpath(top);}catch{throw new Error('NOT_A_GIT_REPOSITORY');}
 if(topReal!==repo)throw new Error('NOT_A_GIT_REPOSITORY');
 if(git(['symbolic-ref','--short','HEAD'])===undefined)throw new Error('REPOSITORY_BRANCH_REQUIRED');
 return repo;
}
async function sameRepository(stored:string,repo:string){
 try{return await realpath(stored)===repo;}catch{return stored===repo;}
}
function overlaps(left:string,right:string){
 return left===right||left.startsWith(right+sep)||right.startsWith(left+sep);
}
/** Other installation files that sit next to this data directory. Parse failures are ignored. */
async function belongsToAnotherInstallation(dataDirectory:string,installationPath:string,repo:string){
 const parent=dirname(dataDirectory);
 let current=resolve(installationPath);
 try{current=await realpath(installationPath);}catch{/* the path given by the caller is enough */}
 let names:string[]=[];
 try{names=await readdir(parent);}catch{return false;}
 for(const file of [join(parent,'installation.json'),...names.map(name=>join(parent,name,'installation.json'))]){
  let text:string;
  try{text=await readFile(file,'utf8');}catch{continue;}
  let parsed:{project?:{repo?:unknown};projects?:{repo?:unknown}[];dataDirectory?:unknown};
  try{parsed=JSON.parse(text) as typeof parsed;}catch{continue;}
  let fileReal=file;
  try{fileReal=await realpath(file);}catch{/* a file we could read is still comparable as given */}
  if(fileReal===current)continue;
  const repos=[parsed.project?.repo,...(Array.isArray(parsed.projects)?parsed.projects.map(item=>item?.repo):[])].filter((item):item is string=>typeof item==='string');
  const paths=[...repos,...(typeof parsed.dataDirectory==='string'?[parsed.dataDirectory]:[])];
  if(paths.some(path=>overlaps(path,repo)))return true;
 }
 return false;
}
async function backupInstallation(installationPath:string,label:string){
 const safe=label.replace(/[^A-Za-z0-9_-]/g,'-').slice(0,60)||'projeto';
 const target=join(dirname(installationPath),'installation.json.before-add-'+safe);
 try{await writeFile(target,await readFile(installationPath),{mode:0o600,flag:'wx'});}
 catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 await chmod(target,0o600);
}
async function writePrivate(path:string,content:string){
 const temporary=path+'.'+randomUUID()+'.tmp';
 await writeFile(temporary,content,{mode:0o600,flag:'wx'});await chmod(temporary,0o600);await rename(temporary,path);
}

async function main(){
 const argv=process.argv.slice(2);
 if(argv[0]==='--contas'){
  try{
   const lines=await runPersonalProjectContasCli(argv);
   for(const line of lines)console.log(line);
  }catch(error){
   console.error(personalProjectContasFailureText(error));
   process.exit(1);
  }
  return;
 }
 const labelAt=argv.indexOf('--label'),label=labelAt<0?undefined:argv[labelAt+1];
 const positionals=argv.filter((arg,index)=>arg!=='--label'&&index!==labelAt+1);
 const [file,repository]=positionals;
 if(!file||!repository||!label||file.startsWith('--')||repository.startsWith('--')||positionals.length!==2){
  console.log('Uso: npm run personal:project -- --add <instalação.json> <repositório> --label <nome>');
  process.exit(1);
 }
 try{
  const result=await addPersonalProject(file,repository,label);
  console.log(`Projeto ${result.label} acrescentado.`);
  console.log(result.restart);
 }catch(error){
  console.log(error instanceof Error?error.message:String(error));
  process.exit(1);
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main();
