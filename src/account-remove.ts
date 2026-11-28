import {randomUUID} from 'node:crypto';
import {chmod,lstat,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises';
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
 * in progress), while the vigente policy of an active project names a profile of the account and no other enabled account of the
 * same provider serves that project, while a manager context of installation.json runs on one of its profiles, or when it is the
 * last account of a project's `allowedAccountIds` or of `nativeBootstrap.accounts`. Otherwise, in one transaction, the account
 * is disabled, its project access is revoked, its installation domain row goes and one `account.retired` audit row is written;
 * receipts, profiles and history stay. After the commit installation.json (backup first) stops listing the account, and its home
 * `<accountHomesDirectory>/<accountId>` is removed when it is the very directory the ledger registered: no link is followed and
 * nothing outside the accounts folder is touched.
 */

const USAGE='Uso: npm run gateway -- account-remove <instalação.json> <id-ou-nome-da-conta> [--sim]';
const messages:Record<string,string>={
 ACCOUNT_REMOVE_USAGE:USAGE,
 PERSONAL_ACTIVATION_REQUIRED:'A retirada de conta só roda numa instalação pessoal.',
 ACCOUNT_NOT_FOUND:'Conta não encontrada no banco.',
 ACCOUNT_AMBIGUOUS:'Há mais de uma conta com esse nome. Informe o UUID da conta.',
 ACCOUNT_REMOVE_ACTIVE:'A conta tem trabalho em curso. Espere terminar (ou encerre) e repita.',
 ACCOUNT_REMOVE_POLICY_IN_USE:'A política vigente de um projeto ativo ainda usa a conta e não há outra conta habilitada do mesmo provedor. Aplique antes um combo sem esse provedor (npm run personal:combo -- <instalação.json> <projeto> apply <combo>) e repita.',
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
 (SELECT count(*)::int FROM ac_readonly_quota_runs WHERE account_id=$1 AND state='uncertain') AS quota`;
async function liveWork(db:Pick<pg.Pool,'query'>,accountId:string){
 const row=(await db.query(liveSql,[accountId])).rows[0] as Record<string,number>;
 const names:Record<string,string>={grants:'vaga(s) de capacidade não liberada(s)',jobs:'job(s) nativo(s) em curso',qa:'job(s) de QA em curso',
  reservations:'reserva(s) da instalação abertas',refreshes:'renovação(ões) de login abertas',quota:'leitura(s) de cota em curso'};
 return Object.entries(names).filter(([key])=>row[key]).map(([key,text])=>`${row[key]} ${text}`).join(', ');
}

/** Active projects whose vigente policy (latest revision, or one assigned to an open context) names a profile of the account
 * while no other enabled account of the same provider has access to the project. */
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
  const other=await db.query(`SELECT 1 FROM ac_accounts a JOIN ac_account_access x ON x.account_id=a.id
   WHERE x.project_id=$1 AND a.provider=$2 AND a.enabled AND a.id<>$3 LIMIT 1`,[row.id,account.provider,account.id]);
  if(!other.rowCount)blocked.set(String(row.id),`${row.label} (${row.id})`);
 }
 return [...blocked.values()];
}

type FileEdit={next?:string;changes:string[];refusal?:Blocked};
/** The installation.json without the account. Nothing is written here. */
function editInstallation(original:string,accountId:string,profiles:Set<string>):FileEdit{
 const raw=JSON.parse(original) as {project?:{label?:string;allowedAccountIds?:string[]};projects?:{label?:string;allowedAccountIds?:string[]}[];
  nativeBootstrap?:{accounts?:{accountId?:string}[]};managerTransport?:{contexts?:{projectId?:string;profileId?:string}[]}};
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

export async function removeProviderAccount(installationPath:string,token:string,options:{apply:boolean;now?:Date}):Promise<AccountRemoveResult>{
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
  const will=(now:string,later:string)=>options.apply?now:later;

  say(`Conta ${account.label} (${account.provider}, ${accountId})${account.enabled?'':', já desabilitada'}.`);
  if(busy)say(`Trabalho em curso: ${busy}.`);
  if(uses.length)say(`Política vigente que ainda usa a conta, sem outra conta ${account.provider} habilitada: ${uses.join('; ')}.`);
  if(edit.refusal)say(accountRemoveFailureText(edit.refusal));
  say(`Banco: conta ${account.enabled?will('desabilitada','seria desabilitada'):'já desabilitada'}; ${access.length} acesso(s) de projeto ${will('revogado(s)','seriam revogados')}${access.length?` (${access.join(', ')})`:''}${domain?`; domínio da instalação ${will('retirado','seria retirado')}`:''}; recibos, perfis e histórico ficam.`);
  say(edit.changes.length?`installation.json: a conta ${will('sai','sairia')} de ${edit.changes.join(' e ')} (com backup).`:'installation.json: nada a mudar.');
  say('path' in home?`Home ${home.path}: ${homeState??will('removida','seria removida')}.`:`Home: ${home.skip}.`);

  if(!options.apply){
   say(`Prévia, nada foi alterado. Para aplicar: npm run gateway -- account-remove ${file} ${accountId} --sim`);
   return {accountId,label:account.label,applied:false,lines,restart};
  }

  // ---- Apply ----
  if(busy)throw new Blocked('ACCOUNT_REMOVE_ACTIVE',busy+'.');
  if(uses.length)throw new Blocked('ACCOUNT_REMOVE_POLICY_IN_USE',`Projeto(s): ${uses.join('; ')}.`);
  if(edit.refusal)throw edit.refusal;
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
   if(why)say(`Home ${home.path}: ${why}.`);
   else{
    // Moved aside first, then checked again: what is removed is the directory that was judged, never a link put in its place.
    const aside=join(dirname(home.path),`.retired-${accountId}-${randomUUID().slice(0,8)}`);
    await rename(home.path,aside);
    const info=await lstat(aside);
    if(info.isSymbolicLink()||!info.isDirectory()||String(info.dev)!==home.device||String(info.ino)!==home.inode)
     say(`Home ${home.path}: mudou durante a retirada; ficou em ${aside} e não foi removida.`);
    else{await rm(aside,{recursive:true});say(`Home ${home.path}: removida.`);}
   }
  }else say(`Home: ${home.skip}.`);
  return {accountId,label:account.label,applied:true,lines,...(backupPath?{backupPath}:{}),restart};
 }finally{await ledger.close();}
}

export async function runAccountRemoveCli(path:string|undefined,extra:readonly string[],options?:{now?:Date}):Promise<string[]>{
 const flags=extra.filter(item=>item.startsWith('--'));
 const positionals=extra.filter(item=>!item.startsWith('--'));
 if(!path||positionals.length!==1||flags.some(item=>item!=='--sim')||flags.length>1)throw new Refusal('ACCOUNT_REMOVE_USAGE',400);
 const result=await removeProviderAccount(path,positionals[0]!,{apply:flags.includes('--sim'),...options});
 return result.applied?[...result.lines,`Reinicie o gateway: ${result.restart}`]:result.lines;
}
