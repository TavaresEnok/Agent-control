import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Refusal} from './contracts.ts';
import {runPersonalTimers} from './personal-timers.ts';

const messages:Record<string,string>={
 TIMERS_USAGE:'Uso: npm run personal:timers -- <instalação.json> [--remove]',
 TIMERS_PERSONAL_REQUIRED:'Os timers só são instalados numa instalação pessoal.',
 INVALID_SERVICE_NAME:'O diretório da instalação não serve de nome para o serviço.',
};

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 runPersonalTimers(process.argv.slice(2)).then(line=>{console.log(line);},error=>{
  const code=error instanceof Refusal?error.code:'';
  console.error(messages[code]??'Timers falhou.');
  process.exit(1);
 });
}
