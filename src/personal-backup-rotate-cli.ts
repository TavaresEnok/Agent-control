import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Refusal} from './contracts.ts';
import {CommandRefusal} from './personal-backup.ts';
import {OffsiteCopyRefusal,runPersonalBackupRotate} from './personal-backup-rotate.ts';

const messages:Record<string,string>={
 BACKUP_ROTATE_USAGE:'Uso: npm run personal:backup-rotate -- <instalação.json> <pasta>',
 BACKUP_USAGE:'Uso: npm run personal:backup-rotate -- <instalação.json> <pasta>',
 BACKUP_DESTINATION_INSIDE_DATA:'O destino não pode ficar dentro do diretório de dados.',
 BACKUP_DESTINATION_INSIDE_REPOSITORY:'O destino não pode ficar dentro de um repositório de projeto.',
 BACKUP_DESTINATION_NOT_EMPTY:'O destino já existe e não está vazio.',
 BACKUP_ROTATE_NOT_A_DIRECTORY:'A pasta de destino não é um diretório.',
 BACKUP_DUMP_FAILED:'Não foi possível gravar o database.dump.',
 BACKUP_DATABASE_URL:'A databaseUrl da instalação não pode ser usada no backup.',
 BACKUP_OFFSITE_FAILED:'A cópia externa falhou. Nada foi apagado.',
 BACKUP_OFFSITE_INVALID:'A cópia externa falhou. Nada foi apagado.',
};

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 runPersonalBackupRotate(process.argv.slice(2)).then(lines=>{for(const line of lines)console.log(line);},error=>{
  if(error instanceof OffsiteCopyRefusal)for(const line of error.lines)console.log(line);
  const code=error instanceof Refusal?error.code:'';
  console.error(messages[code]??'Backup falhou.');
  if(error instanceof CommandRefusal&&error.detail)console.error(error.detail);
  process.exit(1);
 });
}
