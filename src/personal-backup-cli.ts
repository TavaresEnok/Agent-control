import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Refusal} from './contracts.ts';
import {CommandRefusal,runPersonalBackup} from './personal-backup.ts';

import {RetentionDegradedRefusal,personalBackupDefaultDestination,runPersonalBackupRotate} from './personal-backup-rotate.ts';

export function runPersonalBackupCommand(args:string[]){
 const [installation,destination]=args;
 if(installation && !installation.startsWith('--') && (args.length===1 ||
   (args.length===2 && destination && resolve(destination)===personalBackupDefaultDestination(installation)))){
  return runPersonalBackupRotate(args);
 }
 return runPersonalBackup(args);
}

const messages:Record<string,string>={
 BACKUP_USAGE:'Uso: npm run personal:backup -- <instalação.json> [pasta-destino]',
 BACKUP_DESTINATION_INSIDE_DATA:'O destino não pode ficar dentro do diretório de dados.',
 BACKUP_DESTINATION_INSIDE_REPOSITORY:'O destino não pode ficar dentro de um repositório de projeto.',
 BACKUP_DESTINATION_NOT_EMPTY:'O destino já existe e não está vazio.',
 BACKUP_DUMP_FAILED:'Não foi possível gravar o database.dump.',
 BACKUP_RETENTION_DEGRADED:'O backup novo está íntegro, mas a retenção falhou: backups antigos continuam no disco.',
 BACKUP_DATABASE_URL:'A databaseUrl da instalação não pode ser usada no backup.',
};

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 runPersonalBackupCommand(process.argv.slice(2)).then(lines=>{for(const line of lines)console.log(line);},error=>{
  if(error instanceof RetentionDegradedRefusal)for(const line of error.lines)console.log(line);
  const code=error instanceof Refusal?error.code:'';
  console.error(messages[code]??'Backup falhou.');
  if(error instanceof CommandRefusal&&error.detail)console.error(error.detail);
  process.exit(error instanceof RetentionDegradedRefusal?3:1);
 });
}
