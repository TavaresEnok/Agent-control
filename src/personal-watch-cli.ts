import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Refusal} from './contracts.ts';
import {runPersonalWatch} from './personal-watch.ts';

const messages:Record<string,string>={
 WATCH_USAGE:'Uso: npm run personal:watch -- <instalação.json>',
 WATCH_PERSONAL_REQUIRED:'A vigia só roda numa instalação pessoal.',
};

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 runPersonalWatch(process.argv.slice(2)).then(line=>{console.log(line);},error=>{
  const code=error instanceof Refusal?error.code:'';
  console.error(messages[code]??'Vigia falhou.');
  process.exit(1);
 });
}
