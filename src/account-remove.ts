import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod,lstat,open,readdir,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve,sep} from 'node:path';
import type pg from 'pg';
import {Id,Refusal} from './contracts.ts';
import {Installation,loadInstallation} from './installation.ts';
import {Ledger} from './ledger.ts';
import {snapshotProfileIds} from './personal-combos.ts';
import {personalAccountRoot} from './personal-health.ts';

/**
 * Retires one provider account of a personal installation, by the product path.
 *
 * Without `apply` it only reports what would change. With `apply` it refuses while the account has live work (a capacity grant
 * not released, a native or QA job `uncertain`/`running`, an installation reservation or refresh still open, a read-only quota run
 * in progress, a planning job or a quota collection open), while the vigente policy of an active project names a profile of the
 * account (unless it also names an enabled profile of another enabled account of the same provider), while a running container
 * mounts its home (or Docker cannot say), while a manager context of installation.json runs on one of its profiles, or when it is the
 * last account of a project's `allowedAccountIds` or of `nativeBootstrap.accounts`. Otherwise, in one transaction, the account
 * is disabled, its project access is revoked, its installation domain row goes and one `account.retired` audit row is written;
 * receipts, profiles and history stay. After the commit installation.json (backup first, and only if it did not change meanwhile)
 * stops listing the account (allowedAccountIds, nativeBootstrap.accounts, codexQuota.bindings), and its home
 * `<accountHomesDirectory>/<accountId>` is emptied when it is the very directory the ledger registered: credentials and files go,
 * the empty directory stays (see {@link emptyHome}), no link is followed and nothing outside the accounts folder is touched.
 */

const USAGE='Uso: npm run gateway -- account-remove <instalação.json> <id-ou-nome-da-conta> [--sim]';
const messages:Record<string,string>={
 ACCOUNT_REMOVE_USAGE:USAGE,
 PERSONAL_ACTIVATION_REQUIRED:'A retirada de conta só roda numa instalação pessoal.',
 ACCOUNT_NOT_FOUND:'Conta não encontrada no banco.',
 ACCOUNT_AMBIGUOUS:'Há mais de uma conta com esse nome. Informe o UUID da conta.',
 ACCOUNT_REMOVE_ACTIVE:'A conta tem trabalho em curso. Espere terminar (ou encerre) e repita.',
 ACCOUNT_REMOVE_POLICY_IN_USE:'A política vigente de um projeto ativo ainda usa perfis da conta. Reaplique antes o combo nesse projeto (npm run personal:combo -- <instalação.json> <projeto> apply <combo>) e repita.',
 ACCOUNT_REMOVE_HOME_MOUNTED:'Um contêiner em execução monta a home da conta, ou o Docker não respondeu. Espere terminar e repita.',
 INSTALLATION_CHANGED:'O installation.json mudou durante a retirada e não foi regravado. O banco já foi atualizado; rode o mesmo comando de novo.',
 ACCOUNT_REMOVE_MANAGER_IN_USE:'Um contexto do gerente no installation.json usa um perfil dessa conta.',
 ACCOUNT_REMOVE_LAST_ALLOWED:'A conta é a única em allowedAccountIds de um projeto. Acrescente outra conta a esse projeto antes.',
 ACCOUNT_REMOVE_LAST_BOOTSTRAP:'A conta é a única em nativeBootstrap.accounts. Registre outra conta e rode native-setup antes.',
 INVALID_INSTALLATION:'O arquivo de instalação ficaria inválido sem a conta.',
};
class Blocked extends Refusal{constructor(code:string,readonly detail:string){super(code,409);}}
export function accountRemoveFailureText(error:unknown):string{
 const code=error instanceof Refusal?error.code:error instanceof Error?error.message:'';
 const base=messages[code]??(code||'Não foi possível retirar a conta.');
 return error instanceof Blocked&&error.detail?`${base} ${error.detail}`:base;
}

export type AccountRemoveResult={accountId:string;label:string;applied:boolean;lines:string[];backupPath?:string;restart:string};
type Account={id:string;provider:string;label:string;enabled:boolean;mode:string};

const errno=(error:unknown,code:string)=>(error as NodeJS.ErrnoException)?.code===code;
const overlaps=(a:string,b:string)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep);
function stampOf(now:Date){
 const pad=(value:number,width=2)=>value.toString().padStart(width,'0');
 return `${pad(now.getUTCFullYear(),4)}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

async function findAccount(ledger:Ledger,owner:string,token:string):Promise<Account>{
 const byId=Id.safeParse(token).success;
 const rows=(await ledger.pool.query<Account>(`SELECT id::text AS id,provider,label,enabled,mode FROM ac_accounts
  WHERE owner_id=$2 AND mode<>'synthetic' AND ${byId?'id=$1::uuid':'label=$1'} ORDER BY enabled DESC,id`,[token,owner])).rows;
 if(!rows.length)throw new Refusal('ACCOUNT_NOT_FOUND',404);
 if(rows.length===1)return rows[0]!;
 const enabled=rows.filter(row=>row.enabled);
 if(enabled.length===1)return enabled[0]!;
 throw new Refusal('ACCOUNT_AMBIGUOUS',409);
}

const liveSql=`SELECT
 (SELECT count(*)::int FROM ac_capacity_grants WHERE account_id=$1 AND state<>'released') AS grants,
 (SELECT count(*)::int FROM ac_native_execution_jobs WHERE account_id=$1 AND state IN ('uncertain','running')) AS jobs,
 (SELECT count(*)::int FROM ac_native_qa_jobs q JOIN ac_capacity_grants g ON g.id=q.grant_id WHERE g.account_id=$1 AND q.state IN ('uncertain','running')) AS qa,
 (SELECT count(*)::int FROM ac_installation_reservations WHERE account_id=$1 AND state<>'released') AS reservations,
 (SELECT count(*)::int FROM ac_installation_refreshes WHERE account_id=$1 AND state<>'finished') AS refreshes,
 (SELECT count(*)::int FROM ac_native_planning_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id WHERE g.account_id=$1 AND j.state IN ('prepared','uncertain','running')) AS planning,
 (SELECT count(*)::int FROM ac_readonly_quota_runs WHERE account_id=$1 AND state='uncertain') AS quota,
 (SELECT count(*)::int FROM ac_provider_bindings WHERE account_id=$1 AND lease_until>clock_timestamp()) AS bindings,
 (SELECT count(*)::int FROM ac_provider_observations WHERE account_id=$1 AND state='collecting') AS observations`;
async function liveWork(db:Pick<pg.Pool,'query'>,accountId:string){
 const row=(await db.query(liveSql,[accountId])).rows[0] as Record<string,number>;
 const names:Record<string,string>={grants:'vaga(s) de capacidade não liberada(s)',jobs:'job(s) nativo(s) em curso',qa:'job(s) de QA em curso',
  planning:'job(s) de planejamento em curso',reservations:'reserva(s) da instalação abertas',refreshes:'renovação(ões) de login abertas',
  quota:'leitura(s) de cota em curso',bindings:'coleta(s) de cota com licença ativa',observations:'observação(ões) de cota em coleta'};
 return Object.entries(names).filter(([key])=>row[key]).map(([key,text])=>`${row[key]} ${text}`).join(', ');
}

/** Active projects whose vigente policy (latest revision, or one assigned to an open context) names a profile of the account,
 * unless the same policy also names an enabled profile of another enabled account of the same provider that serves the project. */
async function policyUses(db:Pick<pg.Pool,'query'>,account:Account){
 const archived=Boolean((await db.query("SELECT 1 FROM information_schema.columns WHERE table_name='ac_projects' AND column_name='archived_at' AND table_schema=current_schema()")).rowCount);
 const profiles=new Set((await db.query('SELECT id::text AS id FROM ac_profiles WHERE account_id=$1',[account.id])).rows.map(row=>String(row.id)));
 if(!profiles.size)return [] as string[];
 const rows=(await db.query(`SELECT p.id::text AS id,p.label,r.snapshot FROM ac_policy_revisions r JOIN ac_projects p ON p.id=r.project_id JOIN (
   SELECT project_id,max(revision) AS revision FROM ac_policy_revisions GROUP BY project_id
   UNION SELECT project_id,capacity_policy_revision FROM ac_contexts WHERE NOT archived AND capacity_policy_revision IS NOT NULL
  ) live ON live.project_id=r.project_id AND live.revision=r.revision${archived?' WHERE p.archived_at IS NULL':''}`)).rows;
 const blocked=new Map<string,string>();
 for(const row of rows){
  if(blocked.has(String(row.id))||!snapshotProfileIds(row.snapshot).some(id=>profiles.has(id)))continue;
  const other=await db.query(`SELECT 1 FROM ac_profiles p JOIN ac_accounts a ON a.id=p.account_id JOIN ac_account_access x ON x.account_id=a.id
   WHERE x.project_id=$1 AND a.provider=$2 AND a.enabled AND p.enabled AND a.id<>$3 AND p.id=ANY($4::uuid[]) LIMIT 1`,
   [row.id,account.provider,account.id,snapshotProfileIds(row.snapshot)]);
  if(!other.rowCount)blocked.set(String(row.id),`${row.label} (${row.id})`);
 }
 return [...blocked.values()];
}

type FileEdit={next?:string;changes:string[];refusal?:Blocked};
/** The installation.json without the account. Nothing is written here. */
function editInstallation(original:string,accountId:string,profiles:Set<string>):FileEdit{
 const raw=JSON.parse(original) as {project?:{label?:string;allowedAccountIds?:string[]};projects?:{label?:string;allowedAccountIds?:string[]}[];
  nativeBootstrap?:{accounts?:{accountId?:string}[]};codexQuota?:{state?:string;bindings?:{accountId?:string}[]};managerTransport?:{contexts?:{projectId?:string;profileId?:string}[]}};
 const changes:string[]=[];
 const manager=raw.managerTransport?.contexts?.filter(item=>typeof item?.profileId==='string'&&profiles.has(item.profileId))??[];
 if(manager.length)return {changes,refusal:new Blocked('ACCOUNT_REMOVE_MANAGER_IN_USE',`Projeto(s): ${manager.map(item=>item.projectId).join(', ')}.`)};
 for(const project of [raw.project,...(raw.projects??[])]){
  if(!project?.allowedAccountIds?.includes(accountId))continue;
  project.allowedAccountIds=project.allowedAccountIds.filter(id=>id!==accountId);
  if(!project.allowedAccountIds.length)return {changes,refusal:new Blocked('ACCOUNT_REMOVE_LAST_ALLOWED',`Projeto: ${project.label??''}.`)};
  changes.push(`allowedAccountIds do projeto ${project.label??''}`);
 }
 const boot=raw.nativeBootstrap;
 if(boot?.accounts?.some(item=>item?.accountId===accountId)){
  boot.accounts=boot.accounts.filter(item=>item?.accountId!==accountId);
  if(!boot.accounts.length)return {changes,refusal:new Blocked('ACCOUNT_REMOVE_LAST_BOOTSTRAP','')};
  changes.push('nativeBootstrap.accounts');
 }
 const quota=raw.codexQuota;
 if(quota?.bindings?.some(item=>item?.accountId===accountId)){
  quota.bindings=quota.bindings.filter(item=>item?.accountId!==accountId);
  // The schema asks for at least one binding: with none left the quota registry is simply off.
  if(!quota.bindings.length){raw.codexQuota={state:'disabled'};changes.push('codexQuota (que fica desligado)');}
  else changes.push('codexQuota.bindings');
 }
 if(!changes.length)return {changes};
 if(!Installation.safeParse(raw).success)return {changes,refusal:new Blocked('INVALID_INSTALLATION','')};
 return {next:JSON.stringify(raw,null,2)+'\n',changes};
}

type Home={path:string;device:string;inode:string;uid:string}|{skip:string};
async function homeOf(db:Pick<pg.Pool,'query'>,config:Installation,accountId:string):Promise<Home>{
 const row=(await db.query('SELECT root_path,home_device,home_inode,owner_uid FROM ac_account_homes WHERE account_id=$1',[accountId])).rows[0];
 if(!row)return {skip:'sem home registrada no banco; nada a remover'};
 const root=resolve(personalAccountRoot(config));
 if(row.root_path!==root)return {skip:`registrada em ${row.root_path}, fora da pasta de contas ${root}; não é removida`};
 const repos=[config.project.repo,...config.projects.map(item=>item.repo)];
 const path=join(root,accountId);
 if(repos.some(repo=>overlaps(resolve(repo),path)))return {skip:'sobrepõe um repositório; não é removida'};
 return {path,device:String(row.home_device),inode:String(row.home_inode),uid:String(row.owner_uid)};
}
/** The registered home, only when it is still the same directory: no link, same device, inode and owner, root not a link. */
async function checkHome(home:{path:string;device:string;inode:string;uid:string}):Promise<string|undefined>{
 const root=dirname(home.path);
 const rootInfo=await lstat(root).catch(()=>undefined/* absent root: checked below */);
 if(!rootInfo||rootInfo.isSymbolicLink()||!rootInfo.isDirectory()||await realpath(root)!==root)return 'a pasta de contas não é um diretório próprio';
 const info=await lstat(home.path).catch(error=>{if(errno(error,'ENOENT'))return undefined;throw error;});
 if(!info)return 'já não existe';
 if(info.isSymbolicLink()||!info.isDirectory())return 'não é um diretório (link ou arquivo); não é removida';
 if(String(info.dev)!==home.device||String(info.ino)!==home.inode||String(info.uid)!==home.uid||info.uid!==process.getuid?.())
  return 'não é o diretório que o banco registrou; não é removida';
 return undefined;
}

export type DockerRun=(args:string[])=>Promise<{code:number;stdout:string}>;
const defaultDocker:DockerRun=args=>new Promise(done=>execFile('docker',args,{encoding:'utf8',maxBuffer:16*1024*1024,timeout:60_000},
 (error,stdout)=>done({code:error?(typeof (error as {code?:unknown}).code==='number'?(error as unknown as {code:number}).code:1):0,stdout:stdout??''})));
/** Running containers that mount the home or something inside it. Undefined when Docker cannot answer. */
async function homeMounts(docker:DockerRun,home:string):Promise<string[]|undefined>{
 const listed=await docker(['container','ls','-q','--no-trunc']);
 if(listed.code!==0)return undefined;
 const ids=[...new Set(listed.stdout.split('\n').map(line=>line.trim()).filter(Boolean))];
 if(!ids.length)return [];
 const inspected=await docker(['container','inspect','--format','{{.Id}}{{range .Mounts}} {{.Source}}{{end}}',...ids]);
 if(inspected.code!==0)return undefined;
 const found:string[]=[];
 for(const line of inspected.stdout.split('\n')){
  const [id,...sources]=line.trim().split(' ');
  if(id&&sources.some(source=>source===home||source.startsWith(home+sep)))found.push(id.slice(0,12));
 }
 return found;
}

/** Removes everything inside the registered home and keeps the empty directory. ac_account_homes is immutable and unique on
 * (device, inode): freeing the inode would let the file system hand it to the next account's home and refuse that registration.
 * The directory is opened without following links and checked by its descriptor; entries are removed through that descriptor,
 * so a link put in place of the home is never followed, and links inside are unlinked, not followed. */
async function emptyHome(home:{path:string;device:string;inode:string;uid:string}):Promise<string>{
 const handle=await open(home.path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW).catch(()=>undefined/* gone or a link */);
 if(!handle)return 'mudou durante a retirada; não foi esvaziada';
 try{
  const info=await handle.stat();
  if(!info.isDirectory()||String(info.dev)!==home.device||String(info.ino)!==home.inode||String(info.uid)!==home.uid)
   return 'mudou durante a retirada; não foi esvaziada';
  const anchored=join('/proc/self/fd',String(handle.fd));
  for(const name of await readdir(anchored))await rm(join(anchored,name),{recursive:true,force:true});
  return 'credenciais e arquivos removidos; o diretório vazio fica registrado';
 }finally{await handle.close();}
}

export async function removeProviderAccount(installationPath:string,token:string,options:{apply:boolean;now?:Date;docker?:DockerRun}):Promise<AccountRemoveResult>{
 const file=resolve(installationPath);
 const config=await loadInstallation(file);
 if(config.activation!=='personal')throw new Refusal('PERSONAL_ACTIVATION_REQUIRED',403);
 const clean=token.trim();
 if(!clean||clean.startsWith('--'))throw new Refusal('ACCOUNT_REMOVE_USAGE',400);
 const service=basename(config.dataDirectory).replace(/[^A-Za-z0-9_-]/g,'-')||'gateway';
 const restart=`systemctl --user restart agent-control-gateway-${service}`;
 const lines:string[]=[];
 const say=(line:string)=>lines.push(line);
 const ledger=new Ledger(config.databaseUrl,config.installationAuthority?.token);
 try{
  const account=await findAccount(ledger,config.project.owner,clean);
  const accountId=account.id;
  const access=(await ledger.pool.query('SELECT p.label FROM ac_account_access x JOIN ac_projects p ON p.id=x.project_id WHERE x.account_id=$1 ORDER BY p.label',[accountId])).rows.map(row=>String(row.label));
  const domain=Boolean((await ledger.pool.query('SELECT 1 FROM ac_installation_accounts WHERE account_id=$1',[accountId])).rowCount);
  const profiles=new Set((await ledger.pool.query('SELECT id::text AS id FROM ac_profiles WHERE account_id=$1',[accountId])).rows.map(row=>String(row.id)));
  const busy=await liveWork(ledger.pool,accountId);
  const uses=await policyUses(ledger.pool,account);
  const original=await readFile(file,'utf8');
  const edit=editInstallation(original,accountId,profiles);
  const home=await homeOf(ledger.pool,config,accountId);
  const homeState='path' in home?await checkHome(home):home.skip;
  const docker=options.docker??defaultDocker;
  const mounted='path' in home&&!homeState?await homeMounts(docker,home.path):[];
  const mountText=mounted===undefined?'o Docker não respondeu':mounted.length?`montada pelo(s) contêiner(es) ${mounted.join(', ')}`:'';
  const will=(now:string,later:string)=>options.apply?now:later;

  say(`Conta ${account.label} (${account.provider}, ${accountId})${account.enabled?'':', já desabilitada'}.`);
  if(busy)say(`Trabalho em curso: ${busy}.`);
  if(uses.length)say(`Política vigente que ainda usa a conta, sem outra conta ${account.provider} habilitada: ${uses.join('; ')}.`);
  if(edit.refusal)say(accountRemoveFailureText(edit.refusal));
  say(`Banco: conta ${account.enabled?will('desabilitada','seria desabilitada'):'já desabilitada'}; ${access.length} acesso(s) de projeto ${will('revogado(s)','seriam revogados')}${access.length?` (${access.join(', ')})`:''}${domain?`; domínio da instalação ${will('retirado','seria retirado')}`:''}; recibos, perfis e histórico ficam.`);
  say(edit.changes.length?`installation.json: a conta ${will('sai','sairia')} de ${edit.changes.join(' e ')} (com backup).`:'installation.json: nada a mudar.');
  say('path' in home?`Home ${home.path}: ${homeState??(mountText?`${mountText}; a retirada é recusada`:will('esvaziada','seria esvaziada (credenciais e arquivos saem; o diretório vazio fica)'))}.`:`Home: ${home.skip}.`);

  if(!options.apply){
   say(`Prévia, nada foi alterado. Para aplicar: npm run gateway -- account-remove ${file} ${accountId} --sim`);
   return {accountId,label:account.label,applied:false,lines,restart};
  }

  // ---- Apply ----
  if(busy)throw new Blocked('ACCOUNT_REMOVE_ACTIVE',busy+'.');
  if(uses.length)throw new Blocked('ACCOUNT_REMOVE_POLICY_IN_USE',`Projeto(s): ${uses.join('; ')}.`);
  if(edit.refusal)throw edit.refusal;
  if(mountText)throw new Blocked('ACCOUNT_REMOVE_HOME_MOUNTED',`Home ${'path' in home?home.path:''}: ${mountText}.`);
  lines.length=0;
  say(`Conta ${account.label} (${account.provider}, ${accountId}).`);
  await ledger.tx(async c=>{
   // Same locks as a capacity reservation, then the facts are judged again inside the transaction.
   await c.query('SELECT id FROM ac_capacity_config WHERE id=1 FOR UPDATE');
   await c.query('SELECT id FROM ac_accounts WHERE id=$1 FOR UPDATE',[accountId]);
   const late=await liveWork(c,accountId);
   if(late)throw new Blocked('ACCOUNT_REMOVE_ACTIVE',late+'.');
   const lateUses=await policyUses(c,account);
   if(lateUses.length)throw new Blocked('ACCOUNT_REMOVE_POLICY_IN_USE',`Projeto(s): ${lateUses.join('; ')}.`);
   await c.query('UPDATE ac_accounts SET enabled=false,revision=revision+1 WHERE id=$1 AND enabled',[accountId]);
   const revoked=(await c.query('DELETE FROM ac_account_access WHERE account_id=$1 RETURNING project_id::text AS project_id',[accountId])).rows.map(row=>String(row.project_id));
   const domains=(await c.query('DELETE FROM ac_installation_accounts WHERE account_id=$1 RETURNING domain_id::text AS domain_id',[accountId])).rows.map(row=>String(row.domain_id));
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES(NULL,'account.retired',$1)",
    [{accountId,provider:account.provider,label:account.label,wasEnabled:account.enabled,revokedProjects:revoked,installationDomains:domains}]);
  });
  say(`Banco: conta desabilitada, ${access.length} acesso(s) de projeto revogado(s)${domain?', domínio da instalação retirado':''}; recibos, perfis e histórico ficam.`);

  let backupPath:string|undefined;
  if(edit.next){
   // A change made while the ledger was updated wins: nothing is written and the rerun (idempotent) edits the new file.
   if(await readFile(file,'utf8')!==original)throw new Refusal('INSTALLATION_CHANGED',409);
   const stamp=stampOf(options.now??new Date());
   for(let index=1;;index++){
    backupPath=join(dirname(file),`installation.json.before-account-remove-${stamp}${index===1?'':'-'+index}`);
    try{await writeFile(backupPath,original,{mode:0o600,flag:'wx'});break;}
    catch(error){if(!errno(error,'EEXIST')||index>=100)throw error;}
   }
   await chmod(backupPath,0o600);
   const temporary=file+'.'+randomUUID()+'.tmp';
   await writeFile(temporary,edit.next,{mode:0o600,flag:'wx'});await chmod(temporary,0o600);await rename(temporary,file);
   say(`installation.json: conta retirada de ${edit.changes.join(' e ')}; backup em ${backupPath}.`);
  }else say('installation.json: nada a mudar.');

  if('path' in home){
   const why=await checkHome(home);
   const late=why?[]:await homeMounts(docker,home.path);
   if(why)say(`Home ${home.path}: ${why}.`);
   else if(late===undefined||late.length)
    say(`Home ${home.path}: ${late===undefined?'o Docker não respondeu':`montada pelo(s) contêiner(es) ${late.join(', ')}`}; não foi removida. Rode o mesmo comando de novo quando terminar.`);
   else say(`Home ${home.path}: ${await emptyHome(home)}.`);
  }else say(`Home: ${home.skip}.`);
  return {accountId,label:account.label,applied:true,lines,...(backupPath?{backupPath}:{}),restart};
 }finally{await ledger.close();}
}

export async function runAccountRemoveCli(path:string|undefined,extra:readonly string[],options?:{now?:Date;docker?:DockerRun}):Promise<string[]>{
 const flags=extra.filter(item=>item.startsWith('--'));
 const positionals=extra.filter(item=>!item.startsWith('--'));
 if(!path||positionals.length!==1||flags.some(item=>item!=='--sim')||flags.length>1)throw new Refusal('ACCOUNT_REMOVE_USAGE',400);
 const result=await removeProviderAccount(path,positionals[0]!,{apply:flags.includes('--sim'),...options});
 return result.applied?[...result.lines,`Reinicie o gateway: ${result.restart}`]:result.lines;
}
