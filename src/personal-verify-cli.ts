import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Refusal} from './contracts.ts';
import {beginPersonalVerification,resolvePersonalVerification} from './verify-command.ts';

const messages:Record<string,string>={
 VERIFY_USAGE:'Uso: npm run personal:verify -- <instalação.json> <projectId> [--url <homologação>]',
 PERSONAL_ACTIVATION_REQUIRED:'A verificação só roda numa instalação pessoal.',
 NOT_FOUND:'Projeto não encontrado.',
 VERIFY_CONTEXT_REQUIRED:'O projeto não tem um contexto para verificar.',
 VERIFY_DB_REQUIRED:'As bases de vulnerabilidade ainda não estão no servidor.',
 VERIFY_WORKER_UNAVAILABLE:'O runtime pessoal não está ativo.',
 VERIFY_EXTERNAL_TARGET:'A homologação tem que ficar em localhost, 127.0.0.1 ou um nome .local.',
 VERIFY_TARGET_ESCAPE:'A homologação aponta para outro destino.',
 VERIFY_TOOLS_FAILED:'As ferramentas de verificação falharam.',
 VERIFY_COMMIT_INVALID:'Não foi possível ler o commit do repositório.',
 VERIFY_IMAGE_UNPINNED:'A imagem de verificação não está fixada.',
};

function fail(error:unknown):never{
 const code=error instanceof Refusal?error.code:error instanceof Error?error.message:'';
 console.error(messages[code]??(code||'A verificação falhou.'));
 process.exit(1);
 throw error instanceof Error?error:new Error('A verificação falhou.');
}

async function main(){
 const resolved=await resolvePersonalVerification(process.argv.slice(2));
 let job=Promise.resolve();
 try{
  const started=await beginPersonalVerification({...resolved.input,observe(pending){job=pending;}});
  console.log('Verificação '+started.id+' começou.');
  await job;
  console.log('Verificação '+started.id+' concluída.');
 }catch(error){
  await resolved.close();
  fail(error);
 }
 await resolved.close();
 process.exit(0);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main().catch(fail);
}
