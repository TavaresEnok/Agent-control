import {spawnSync} from 'node:child_process';
import {readFile,writeFile,chmod} from 'node:fs/promises';
const installation=process.argv[2];
function run(args){
 const result=spawnSync('node',['--import','tsx','src/server-main.ts',...args],{stdio:'inherit'});
 if(result.status)process.exit(result.status);
}
if(!installation){
 console.log(`Uso: npm run personal:setup -- <instalação.json>
O arquivo precisa existir, com mode 0600, activation "personal" e databaseUrl.
Depois deste comando: pareie o Happier e adicione as contas com
  npm run gateway -- account-add <instalação.json> codex "Codex"
  npm run gateway -- account-add <instalação.json> claude "Claude"`);
 process.exit(0);
}
const raw=JSON.parse(await readFile(installation,'utf8'));
raw.activation='personal';
await writeFile(installation,JSON.stringify(raw,null,2)+'\n',{mode:0o600});
await chmod(installation,0o600);
run(['initialize',installation]);
run(['operator-bootstrap',installation]);
if(raw.contextVault)run(['vault-initialize',installation]);
run(['native-setup',installation]);
console.log('Próximo passo: pareie o Happier e adicione as contas com npm run gateway -- account-add.');
