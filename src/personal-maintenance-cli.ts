import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Refusal} from './contracts.ts';
import {runPersonalMaintenance} from './personal-maintenance.ts';

const messages:Record<string,string>={
 MAINTENANCE_USAGE:'Uso: npm run personal:maintenance -- <instalação.json>',
 MAINTENANCE_PERSONAL_REQUIRED:'A manutenção só roda numa instalação pessoal.',
};

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 runPersonalMaintenance(process.argv.slice(2)).then(lines=>{for(const line of lines)console.log(line);},error=>{
  const code=error instanceof Refusal?error.code:'';
  console.error(messages[code]??'A manutenção falhou.');
  process.exit(1);
 });
}
