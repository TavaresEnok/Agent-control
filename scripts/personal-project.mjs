// Connects one Git repository to personal mode in a single command.
// It writes a private installation file outside the repository, initializes the ledger, registers the
// provider accounts, prepares the native runtime and creates the project conversation.
//
//   npm run personal:project -- <repositório> --db <postgresql://...> [--label nome] [--import-logins]
//
// The conversation lives in the installation's database. "--local" is still accepted from older notes.
//
// --add attaches another repository to an installation that already exists (same database, same logins,
// same conversation key). It does not create a database or copy a login.
//   npm run personal:project -- --add <instalação.json> <repositório> --label <nome>
//
// --remover takes a secondary project out of the installation. Without --sim it only previews (with sizes). With --sim it refuses
// while the project has an active job, a held grant or an exam in progress, backs up installation.json, archives the project in
// the ledger and revokes its account access. --apagar-dados also removes the job folders, qa-cache, verificacoes, registered
// artifacts, shared checkouts and Docker resources labelled com.agent-control.project=<id>. The repository is never removed.
//   npm run personal:project -- --remover <instalação.json> <id|rótulo> [--apagar-dados] [--sim]
//
// --import-logins copies (never moves) the CLI logins that already exist in this user's home
// (~/.claude/.credentials.json, ~/.grok/auth.json, ~/.codex/auth.json). Without it the script stops
// after writing the installation file and prints the account-add commands for a device login.
// The database must be empty and used by this project only. Images come from AC_NATIVE_*_IMAGE or,
// if unset, from the local tags ac-native-{planning,execution,tools}:personal.
import {spawnSync,execFileSync} from 'node:child_process';
import {access,mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {basename,join,resolve,sep} from 'node:path';
import net from 'node:net';

// A step succeeded only if it started (no spawn error), was not ended by a signal, and exited with exactly 0.
// `status` is null after a signal, and falsy-looking checks let that pass as success.
const exitCodeOf=result=>result.error||result.signal||typeof result.status!=='number'?1:result.status===0?0:result.status;
const finish=code=>process.exit(code);
const args=process.argv.slice(2),flag=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
if(args[0]==='--add'){
 const file=args[1],repo=args[2],label=flag('--label');
 if(!file||!repo||!label||file.startsWith('--')||repo.startsWith('--')){console.log('Uso: npm run personal:project -- --add <instalação.json> <repositório> --label <nome>');process.exit(1);}
 const root=resolve(import.meta.dirname,'..');
 const result=spawnSync(process.execPath,['--import','tsx','src/personal-project-add.ts',file,repo,'--label',label],{cwd:root,stdio:'inherit'});
 process.exit(exitCodeOf(result));
}
if(args[0]==='--remover'){
 const root=resolve(import.meta.dirname,'..');
 const result=spawnSync(process.execPath,['--import','tsx','src/personal-project-remove.ts',...args],{cwd:root,stdio:'inherit'});
 process.exit(exitCodeOf(result));
}
if(args[0]==='--contas'){
 const root=resolve(import.meta.dirname,'..');
 const result=spawnSync(process.execPath,['--import','tsx','src/personal-project-add.ts',...args],{cwd:root,stdio:'inherit'});
 process.exit(exitCodeOf(result));
}
const repoArg=args[0]&&!args[0].startsWith('--')?args[0]:undefined,db=flag('--db'),importLogins=args.includes('--import-logins');
if(!repoArg||!db){console.log('Uso: npm run personal:project -- <repositório> --db <postgresql://...> [--label nome] [--import-logins]');process.exit(repoArg||db?1:0);}
const root=resolve(import.meta.dirname,'..'),repo=await realpath(resolve(repoArg));
const git=(...a)=>execFileSync('git',['-C',repo,...a],{encoding:'utf8'}).trim();
if(git('rev-parse','--is-inside-work-tree')!=='true'||await realpath(git('rev-parse','--show-toplevel'))!==repo)throw Error('REPOSITORY_ROOT_REQUIRED');
git('symbolic-ref','--short','HEAD');git('rev-parse','HEAD'); // a checked-out branch with at least one commit
const label=(flag('--label')??basename(repo)).replace(/[^A-Za-z0-9_-]/g,'-').slice(0,60);
const data=join(homedir(),'.agent-control',label),installation=join(data,'installation.json');
if(data===repo||data.startsWith(repo+sep)||repo.startsWith(data+sep))throw Error('DATA_DIRECTORY_MUST_BE_OUTSIDE_REPOSITORY');
const say=line=>console.log('» '+line);
const run=(command,argv,env={})=>{const result=spawnSync(command,argv,{cwd:root,stdio:'inherit',env:{...process.env,...env}});const code=exitCodeOf(result);if(code)finish(code);};
const capture=(command,argv,env={})=>{const result=spawnSync(command,argv,{cwd:root,encoding:'utf8',env:{...process.env,...env}});if(exitCodeOf(result))throw Error(String(result.stderr||result.stdout||result.error?.message||(result.signal?`ended by ${result.signal}`:'')).trim().split('\n').pop()||'STEP_FAILED');return result.stdout.trim().split('\n').pop();};
const freePort=()=>new Promise(done=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>done(port));});});
const exists=path=>access(path).then(()=>true,()=>false);

await mkdir(data,{recursive:true,mode:0o700});
if(!await exists(installation)){
 let owner='';try{owner=git('config','user.email');}catch{}
 const port=await freePort();
 await writeFile(installation,JSON.stringify({schemaVersion:1,mode:'administration-only',activation:'personal',databaseUrl:db,dataDirectory:data,accountHomesDirectory:join(data,'accounts'),
  project:{id:randomUUID(),label,repo,owner:owner||process.env.USER||'owner'},
  http:{listen:'127.0.0.1',port,publicOrigin:`http://127.0.0.1:${port}`},
 },null,2)+'\n',{mode:0o600,flag:'wx'});
 say('instalação criada: '+installation);
}else say('instalação existente: '+installation);
const config=JSON.parse(await readFile(installation,'utf8'));
if(config.project.repo!==repo)throw Error('INSTALLATION_BELONGS_TO_ANOTHER_REPOSITORY');

const images={};
for(const [name,tag] of [['AC_NATIVE_PLANNING_IMAGE','ac-native-planning:personal'],['AC_NATIVE_WORKER_IMAGE','ac-native-execution:personal'],['AC_NATIVE_TOOLS_IMAGE','ac-native-tools:personal']]){
 images[name]=process.env[name]??(()=>{try{return execFileSync('docker',['image','inspect',tag,'--format','{{.Id}}'],{encoding:'utf8'}).trim();}catch{return '';}})();
 if(!/^sha256:[a-f0-9]{64}$/.test(images[name])){say(`imagem ausente: construa ${tag} (docs/USO-PESSOAL.md, "Imagens dos workers") ou exporte ${name}.`);process.exit(1);}
}
say('preparando o ledger');
run('node',['scripts/personal-setup.mjs',installation],images);

const logins=[['claude','Claude',join(homedir(),'.claude/.credentials.json')],['grok','Grok',join(homedir(),'.grok/auth.json')],['codex','Codex',join(homedir(),'.codex/auth.json')]];
const gateway=(...a)=>['--import','tsx','src/server-main.ts',...a];
const registered=JSON.parse(capture('node',gateway('native-setup',installation),images).replace(/^[^{]*/,'')||'{}');
if(registered.state==='account_required'){
 if(!importLogins){
  say('falta registrar as contas. Para um login novo por código, rode e siga a URL:');
  for(const [provider,name] of logins)console.log(`  npm run gateway -- account-add ${installation} ${provider} ${name}`);
  say('ou rode este comando de novo com --import-logins para copiar os logins que já existem neste usuário.');
  process.exit(0);
 }
 let added=0;
 for(const [provider,name,file] of logins){
  if(!await exists(file)){say(`${provider}: sem login em ${file}, pulando`);continue;}
  run('node',gateway('account-add',installation,provider,name,'--auth-file',file));added++;
 }
 if(!added){say('nenhum login encontrado para importar.');process.exit(1);}
 say('contas registradas; ativando o runtime nativo');
 run('node',['scripts/personal-setup.mjs',installation],images);
}

say('criando a conversa do projeto');
run('node',gateway('personal-connect',installation),images);

console.log(`
Pronto. A conversa fica no banco desta instalação.
  npm run personal:services -- ${installation} ${label}     (systemd, volta depois de um reboot)
ou, num terminal:
  npm run gateway -- serve ${installation}
Depois converse:
  npm run gateway -- say ${installation} "o que este repositório faz?"
QA: o padrão confere conflitos de merge, JSON e sintaxe de JavaScript. Para rodar os testes do projeto:
  npm run personal:qa -- ${installation} ${label} set --test '["npm","test"]'
Depois reinicie o gateway.`);
