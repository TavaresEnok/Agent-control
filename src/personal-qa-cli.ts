import {basename,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Refusal} from './contracts.ts';
import {loadInstallation,type Installation} from './installation.ts';
import {assertInstallationMigrations} from './installation-readiness.ts';
import {Ledger} from './ledger.ts';
import {moduleCliFailureText,printClaudeQuotaWait,runPersonalModuleCli,type PersonalModuleCliDeps} from './personal-module-cli.ts';
import {clearPersonalQaConfig,parsePersonalQaConfig,readPersonalQaConfig,writePersonalQaConfig,type PersonalQaConfig} from './personal-qa-config.ts';

const usage='Uso: npm run personal:qa -- <instalação.json> <projeto> [show|set|clear|--esperar-cota|--corrigir <runId> <ACH-001...>|--medir-correcao <runId>|--reverificar <runId> <ACH-001...>|--descartar <runId>]\n  set --prepare \'["corepack","pnpm","install","--frozen-lockfile"]\' --test \'["corepack","pnpm","test"]\' [--timeout 600] [--services \'{"postgres":{"image":"postgres:16-alpine","database":"qa_test"}}\']';

function flag(args:string[],name:string){const index=args.indexOf(name);return index<0?undefined:args[index+1];}

function project(config:Installation,token:string){
 const hits=[config.project,...config.projects].filter(item=>item.id===token||item.label===token);
 if(hits.length!==1)throw new Refusal(hits.length?'QA_PROJECT_AMBIGUOUS':'QA_PROJECT_NOT_FOUND');
 return hits[0]!;
}

function jsonArg(value:string){try{return JSON.parse(value);}catch{throw new Refusal('QA_CONFIG_NOT_A_LIST');}}
function servicesArg(value:string){try{return JSON.parse(value);}catch{throw new Refusal('QA_SERVICES_INVALID');}}

function restart(config:Installation){
 return `Reinicie o gateway para aplicar o QA: systemctl --user restart agent-control-gateway-${basename(config.dataDirectory)}`;
}

/** show prints the file, set validates and writes it mode 600, clear deletes it; without a config action, runs the qa verification module. */
export async function runPersonalQaCli(argv:string[],deps?:PersonalModuleCliDeps){
 const [file,token,action,...rest]=argv;
 if(file&&token&&!file.startsWith('--')&&!token.startsWith('--')&&(action===undefined||action==='--esperar-cota'||action==='--corrigir'||action==='--medir-correcao'||action==='--reverificar'||action==='--descartar')){
  return runPersonalModuleCli('qa',argv,deps);
 }
 if(!file||!token||!action||file.startsWith('--')||token.startsWith('--')||!['show','set','clear'].includes(action))throw new Refusal('QA_USAGE');
 const config=await loadInstallation(file),selected=project(config,token);
 if(config.activation!=='personal')throw new Refusal('PERSONAL_ACTIVATION_REQUIRED',403);
 const ledger=new Ledger(config.databaseUrl,config.installationAuthority?.token);
 try{await assertInstallationMigrations(ledger);return await ledger.tx(async client=>{
  const activation=await client.query("SELECT 1 FROM ac_installation_activation WHERE id=1 AND mode='personal' FOR SHARE");
  if(!activation.rowCount)throw new Refusal('PERSONAL_ACTIVATION_REQUIRED',403);
  const membership=await client.query('SELECT role FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 FOR SHARE',[selected.id,selected.owner]);
  if(!membership.rowCount||(action!=='show'&&membership.rows[0].role==='viewer'))throw new Refusal('PROJECT_FORBIDDEN',403);
 if(action==='show'){
  const saved=await readPersonalQaConfig(config.dataDirectory,selected.id);
  return saved?[JSON.stringify(saved,null,2)]:['QA padrão: este projeto não tem arquivo de configuração. A verificação de conflito, JSON e sintaxe continua valendo.'];
 }
 if(action==='clear'){await clearPersonalQaConfig(config.dataDirectory,selected.id);return ['QA do projeto removido. O padrão volta a valer.',restart(config)];}
 const testFlag=flag(rest,'--test');
 if(!testFlag||testFlag.startsWith('--'))throw new Refusal('QA_USAGE');
 const prepareFlag=flag(rest,'--prepare'),timeoutFlag=flag(rest,'--timeout'),servicesFlag=flag(rest,'--services');
 const input:Record<string,unknown>={test:jsonArg(testFlag)};
 if(prepareFlag!==undefined)input.prepare=jsonArg(prepareFlag);
 if(timeoutFlag!==undefined)input.timeoutSeconds=Number(timeoutFlag);
 if(rest.includes('--services')){
  if(servicesFlag===undefined||servicesFlag.startsWith('--'))throw new Refusal('QA_SERVICES_INVALID');
  input.services=servicesArg(servicesFlag);
 }
 const parsed:PersonalQaConfig=parsePersonalQaConfig(input);
 const path=await writePersonalQaConfig(config.dataDirectory,selected.id,parsed);
 return ['QA gravado em '+path,restart(config)];
 });}finally{await ledger.close();}
}

const messages:Record<string,string>={
 QA_USAGE:usage,
 QA_CONFIG_NOT_A_LIST:'O comando tem que ser uma lista JSON de argumentos, não um texto de shell.',
 QA_COMMAND_NOT_ALLOWED:'O primeiro item tem que ser npm, npx, pnpm, corepack, yarn, node, make ou sh.',
 QA_TIMEOUT_OUT_OF_RANGE:'O tempo tem que ser um inteiro de 30 a 1800 segundos.',
 QA_PROJECT_NOT_FOUND:'Projeto não encontrado. Use o label ou o id.',
 QA_PROJECT_AMBIGUOUS:'Há mais de um projeto com esse label.',
 QA_CONFIG_INVALID:'A configuração de QA é inválida.',
 QA_CONFIG_TEST_REQUIRED:'O comando de teste é obrigatório.',
 QA_SERVICES_INVALID:'O serviço de QA é inválido. Por enquanto só postgres, com imagem postgres:15-alpine, postgres:16-alpine ou postgres:17-alpine.',
};
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const printed:string[]=[];
 runPersonalQaCli(process.argv.slice(2),{
  onQuotaWait: printClaudeQuotaWait,
  onResult(result){printed.push(result.runId,result.directory);console.log(result.runId);console.log(result.directory);},
 }).then(lines=>{if(printed.length===0)for(const line of lines)console.log(line);},error=>{
  const code=error instanceof Refusal?error.code:error instanceof Error?error.message:'QA_CONFIG_FAILED';
  console.error(messages[code]??moduleCliFailureText(error,'qa'));process.exit(1);
 });
}
