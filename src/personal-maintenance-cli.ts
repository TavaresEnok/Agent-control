import {artifactCliMessages,ARTIFACT_USAGE} from './personal-artifact-commands.ts';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Refusal} from './contracts.ts';
import {ModuleExamRecoveryPreserved,type ModuleExamRecoveryReason} from './native-execution-supervisor.ts';
import {runPersonalMaintenance} from './personal-maintenance.ts';

const messages:Record<string,string>={
 ...artifactCliMessages,
 MAINTENANCE_USAGE:'Uso: npm run personal:maintenance -- <instalação.json> [--abandonar-design <jobId> | --recuperar-exame-passivo <jobId> | --liberar-work-exames (--projeto <id> [--limite N] [--apos <id>] | --job <id>...) [--aplicar] | --retencao-automatica [--aplicar]]\n'+ARTIFACT_USAGE,
 MAINTENANCE_PERSONAL_REQUIRED:'A manutenção só roda numa instalação pessoal.',
 MAINTENANCE_NATIVE_REQUIRED:'A instalação não tem runtime nativo ativo.',
 MAINTENANCE_EXAM_NOT_FOUND:'Tentativa de design não encontrada nesta instalação.',
 MAINTENANCE_EXAM_PRINCIPAL_MISMATCH:'Esta tentativa pertence a outro principal e não pode ser retirada por esta instalação.',
 MAINTENANCE_EXAM_NOT_ELIGIBLE:'Este job não é uma tentativa pessoal de design elegível para retirada.',
 MAINTENANCE_CONTEXT_BUSY:'O contexto está com a locação ocupada (ex.: gateway em execução). Pare o gateway temporariamente (`systemctl --user stop <unidade-do-gateway>`), repita este comando e inicie o gateway novamente (`systemctl --user start <unidade-do-gateway>`).',
 NATIVE_EXECUTION_HISTORICAL_CONFIRMATION_REQUIRED:'A intenção antiga não distingue exame e criação de design; somente o dono local pode solicitar a retirada explícita.',
 MAINTENANCE_SUPERVISOR_UNAVAILABLE:'Nenhum supervisor configurado na instalação corresponde ao digest e à chave desta tentativa.',
 NATIVE_EXECUTION_RECEIPT_MISMATCH:'O recibo físico ou terminal da tentativa está ausente, inválido ou contraditório.',
 NATIVE_RETIREMENT_UNCONFIRMED:'Não foi possível comprovar a ausência física de execução ou consolidar a retirada da tentativa.',
 NATIVE_EXECUTION_SCOPE_MISMATCH:'O escopo do job não corresponde ao titular ou ao contexto autorizado.',
 NATIVE_EXECUTION_REPLAY_MISMATCH:'A identidade do supervisor ou a época do job não confere com a instalação.',
 NATIVE_EXECUTION_GRANT_MISMATCH:'O grant da tentativa não corresponde ao vínculo do job.',
 NATIVE_EXECUTION_NOT_ELIGIBLE:'A conta ou o perfil da tentativa não corresponde ao supervisor da instalação.',
 NATIVE_EXECUTION_REPOSITORY_MISMATCH:'O repositório registrado para o projeto não confere com a instalação.',
 PERSONAL_ACTIVATION_REQUIRED:'A instalação não está no modo pessoal.',
 PLAN_CANCELLATION_REQUESTED:'A tentativa possui cancelamento pendente e deve seguir o fluxo de cancelamento.',
 DOCKER_UNCERTAIN:'O Docker não confirmou a ausência física dos recursos da tentativa.',
 DOCKER_NETWORK_UNCERTAIN:'O Docker não confirmou a ausência física da rede da tentativa.',
};

const preservedReasons:Record<ModuleExamRecoveryReason,string>={
 supervisor_identity:'a chave ou o executor do supervisor não corresponde ao job',
 docker_uncertain:'o Docker não respondeu de forma conclusiva',
 intent_open:'a intenção do exame ou a execução do módulo ainda não terminou',
 sibling_unresolved:'outra tentativa ou reserva do mesmo exame ainda está aberta',
 job_state:'o job não está incerto nem retirado por esta recuperação',
 journal_started:'o diário do job indica que um worker, um launch ou um recibo existe',
 request_unproven:'o pedido privado do exame passivo não pôde ser comprovado',
 launch_present:'há arquivo de launch publicado ou pendente',
 spool_touched:'a pasta de trabalho da tentativa contém saída ou logs',
 worker_present:'existe contêiner worker desta tentativa',
 tools_absent:'o contêiner de ferramentas esperado não existe',
 tools_mismatch:'o contêiner de ferramentas não confere com a identidade do launch',
 tools_started:'o contêiner de ferramentas já foi iniciado ou terminou',
 tools_registered:'o ID do contêiner de ferramentas já estava registrado; não é perda da resposta de criação',
 removal_unproven:'o contêiner de ferramentas sumiu sem prova de que esta recuperação o removeu',
 network_unproven:'a rede privada não está registrada ou não existe',
 network_mismatch:'a rede privada não confere com a identidade do job',
 network_attached:'a rede privada tem endpoints conectados',
 grant_state:'a reserva não está aberta',
 retirement_conflict:'o diário de retirada está em conflito com o job',
 residual_resources:'restou algum recurso físico da tentativa',
};

export function maintenanceCliFailureText(error:unknown):string{
 if(error instanceof ModuleExamRecoveryPreserved)return `A reserva da tentativa foi mantida: ${preservedReasons[error.reason]}.${error.removed.length?` Contêineres já removidos: ${error.removed.join(', ')}.`:''} Nada foi iniciado.`;
 const code=error instanceof Refusal?error.code:'';
 return messages[code]??'A manutenção falhou.';
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 runPersonalMaintenance(process.argv.slice(2)).then(lines=>{for(const line of lines)console.log(line);},error=>{
  console.error(maintenanceCliFailureText(error));
  process.exit(1);
 });
}
