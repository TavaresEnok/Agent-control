import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Refusal} from './contracts.ts';
import {CommandRefusal,runPersonalBackup} from './personal-backup.ts';

const messages:Record<string,string>={
 BACKUP_USAGE:'Uso: npm run personal:backup -- <instalação.json> <pasta-destino>',
 BACKUP_DESTINATION_INSIDE_DATA:'O destino não pode ficar dentro do diretório de dados.',
 BACKUP_DESTINATION_INSIDE_REPOSITORY:'O destino não pode ficar dentro de um repositório de projeto.',
 BACKUP_DESTINATION_NOT_EMPTY:'O destino já existe e não está vazio.',
 BACKUP_DUMP_FAILED:'Não foi possível gravar o database.dump.',
 BACKUP_DATABASE_URL:'A databaseUrl da instalação não pode ser usada no backup.',
};

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 runPersonalBackup(process.argv.slice(2)).then(lines=>{for(const line of lines)console.log(line);},error=>{
  const code=error instanceof Refusal?error.code:'';
  console.error(messages[code]??'Backup falhou.');
  if(error instanceof CommandRefusal&&error.detail)console.error(error.detail);
  process.exit(1);
 });
}
