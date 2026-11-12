import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Refusal} from './contracts.ts';
import {CommandRefusal,runPersonalRestoreCheck} from './personal-backup.ts';

const messages:Record<string,string>={
 RESTORE_USAGE:'Uso: npm run personal:restore-check -- <pasta-do-backup>',
 RESTORE_NOT_A_BACKUP:'Essa pasta não é um backup do Agent Control.',
 RESTORE_MANIFEST_MISMATCH:'O MANIFEST.txt não confere.',
 RESTORE_DUMP_UNREADABLE:'O database.dump não é legível.',
 BACKUP_DATABASE_URL:'A databaseUrl da instalação não pode ser usada na conferência.',
};

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 runPersonalRestoreCheck(process.argv.slice(2)).then(lines=>{for(const line of lines)console.log(line);},error=>{
  const code=error instanceof Refusal?error.code:'';
  console.error(messages[code]??'A conferência falhou.');
  if(error instanceof CommandRefusal&&error.detail)console.error(error.detail);
  process.exit(1);
 });
}
