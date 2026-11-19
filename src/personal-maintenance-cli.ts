import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Refusal} from './contracts.ts';
import {runPersonalMaintenance} from './personal-maintenance.ts';

const messages:Record<string,string>={
 MAINTENANCE_USAGE:'Uso: npm run personal:maintenance -- <instalação.json> [--recuperar-exame <jobId> [--historico-confirmado]]',
 MAINTENANCE_PERSONAL_REQUIRED:'A manutenção só roda numa instalação pessoal.',
 MAINTENANCE_NATIVE_REQUIRED:'A instalação não tem runtime nativo ativo.',
 MAINTENANCE_EXAM_NOT_FOUND:'Exame interrompido não encontrado nesta instalação.',
 MAINTENANCE_EXAM_PRINCIPAL_MISMATCH:'Este exame pertence a outro principal e não pode ser recuperado por esta instalação.',
 MAINTENANCE_EXAM_NOT_ELIGIBLE:'Este job não é um exame pessoal de leitura interrompido antes do launch.',
 MAINTENANCE_CONTEXT_BUSY:'O contexto do exame está com a locação ocupada (ex.: gateway em execução). Pare o gateway temporariamente (`systemctl --user stop <unidade-do-gateway>`), repita este comando e inicie o gateway novamente (`systemctl --user start <unidade-do-gateway>`).',
 NATIVE_EXECUTION_HISTORICAL_CONFIRMATION_REQUIRED:'A intenção antiga não distingue exame e criação de design. Use --historico-confirmado apenas com o UUID já identificado como exame de leitura.',
 MAINTENANCE_SUPERVISOR_UNAVAILABLE:'Nenhum supervisor configurado na instalação corresponde ao digest e à chave deste exame.',
 NATIVE_EXECUTION_RECEIPT_MISMATCH:'O recibo físico ou terminal do exame está ausente, inválido ou contraditório.',
 NATIVE_RETIREMENT_UNCONFIRMED:'Não foi possível comprovar a ausência física de execução ou consolidar a retirada do exame.',
 NATIVE_EXECUTION_SCOPE_MISMATCH:'O escopo do job não corresponde ao titular ou ao contexto autorizado.',
 NATIVE_EXECUTION_REPLAY_MISMATCH:'A identidade do supervisor ou a época do job não confere com a instalação.',
 NATIVE_EXECUTION_GRANT_MISMATCH:'O grant do exame não corresponde ao vínculo do job.',
 NATIVE_EXECUTION_NOT_ELIGIBLE:'A conta ou o perfil do exame não corresponde ao supervisor da instalação.',
 NATIVE_EXECUTION_REPOSITORY_MISMATCH:'O repositório registrado para o projeto não confere com a instalação.',
 PERSONAL_ACTIVATION_REQUIRED:'A instalação não está no modo pessoal.',
 PLAN_CANCELLATION_REQUESTED:'O exame possui cancelamento pendente e deve seguir o fluxo de cancelamento.',
 DOCKER_UNCERTAIN:'O Docker não confirmou a ausência física dos recursos do exame.',
 DOCKER_NETWORK_UNCERTAIN:'O Docker não confirmou a ausência física da rede do exame.',
};

export function maintenanceCliFailureText(error:unknown):string{
 const code=error instanceof Refusal?error.code:'';
 return messages[code]??'A manutenção falhou.';
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 runPersonalMaintenance(process.argv.slice(2)).then(lines=>{for(const line of lines)console.log(line);},error=>{
  console.error(maintenanceCliFailureText(error));
  process.exit(1);
 });
}
