import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Refusal} from './contracts.ts';
import {runPersonalRestoreProof} from './personal-restore-proof.ts';

const messages:Record<string,string>={
 RESTORE_PROOF_USAGE:'Uso: npm run personal:restore-proof -- <instalação.json> <pasta-dos-backups>',
 RESTORE_PROOF_PERSONAL_REQUIRED:'A prova de restauração só roda numa instalação pessoal.',
 RESTORE_PROOF_NO_BACKUP:'Nenhum backup datado na pasta.',
 RESTORE_MANIFEST_MISMATCH:'O MANIFEST.txt do backup não confere.',
 RESTORE_PROOF_RESTORE_FAILED:'O pg_restore falhou no banco descartável.',
 RESTORE_PROOF_EMPTY:'O banco restaurado não tem projetos.',
};

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 runPersonalRestoreProof(process.argv.slice(2)).then(lines=>{for(const line of lines)console.log(line);},error=>{
  const code=error instanceof Refusal?error.code:'';
  console.error(messages[code]??'A prova de restauração falhou.');
  process.exit(1);
 });
}
