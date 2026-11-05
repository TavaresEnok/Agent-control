import type {AgentControlDiagnosticFinding} from '../upstream/cezar/packages/contract/src/agent-control-operations.ts';
import {capacityWaitExclusions} from './observability.ts';

type Finding=AgentControlDiagnosticFinding;
export function remoteDiagnostic(row:{id:string;intent_id:string|null;state:string}):Finding|null{
 if(!['registered','uncertain','failed','canceled_confirmed'].includes(row.state))return null;
 const evidence:Finding['evidence']=[{kind:'remote_operation',id:row.id}];if(row.intent_id)evidence.push({kind:'intent',id:row.intent_id});
 if(row.state==='failed')return {code:'remote_execution_failed',meaning:'A operação SSH original está registrada como falha terminal; a causa detalhada não foi comprovada por esta consulta.',owner:'Supervisor remoto e controlador de recuperação',nextCondition:'Conferir identidade imutável, recibo e logs autorizados da operação original antes de decidir nova solicitação.',evidence};
 if(row.state==='canceled_confirmed')return {code:'remote_execution_canceled',meaning:'O registro da operação SSH confirma cancelamento.',owner:'Supervisor remoto',nextCondition:'Conferir a conciliação da mesma operação e de suas concessões; não relançar o efeito cancelado.',evidence};
 return {code:'remote_effect_uncertain',meaning:'A operação SSH ainda não possui resultado terminal conciliado.',owner:'Supervisor remoto e controlador de recuperação',nextCondition:'Consultar o grupo original, confirmar identidade e recibo e preservar a reserva enquanto a ausência física não for comprovada.',evidence};
}
export function nativeQaDiagnostic(row:{id:string;intent_id:string;state:string;stop_reason:string|null;receipt:unknown;artifact_id:string;grant_id:string;session_id:string;contract_digest:string}):Finding|null{
 const receipt=row.receipt&&typeof row.receipt==='object'&&!Array.isArray(row.receipt)?row.receipt as Record<string,unknown>:null;
 const coherent=receipt?.jobId===row.id&&receipt?.artifactId===row.artifact_id&&receipt?.grantId===row.grant_id&&receipt?.sessionId===row.session_id&&receipt?.contractDigest===row.contract_digest&&typeof receipt?.logSha256==='string'&&/^[a-f0-9]{64}$/.test(receipt.logSha256)&&typeof receipt?.exitCode==='number'&&Number.isInteger(receipt.exitCode)&&typeof receipt?.logsAvailable==='boolean';
 const status=coherent?receipt?.status:undefined;
 const code=receipt?.exitCode;
 const semantics=status==='passed'?row.state==='completed'&&row.stop_reason===null&&code===0&&receipt?.logsAvailable===true
  :status==='failed'?row.state==='failed'&&row.stop_reason===null&&code!==0&&![126,127,137,143].includes(code as number)&&receipt?.logsAvailable===true
  :status==='canceled'?row.state==='failed'&&row.stop_reason==='canceled'
  :status==='missing_result'?row.state==='failed'&&row.stop_reason!=='canceled':false;
 const evidence:Finding['evidence']=[{kind:'native_qa_job',id:row.id},{kind:'intent',id:row.intent_id}];
 const owner='Supervisor de QA e controlador de recuperação';
 if(row.state==='uncertain'||row.state==='running'&&row.stop_reason)return {code:'native_qa_uncertain',meaning:'O QA ainda aguarda confirmação do grupo físico e de seu resultado ou parada solicitada.',owner,nextCondition:'Inspecionar o contêiner original e conferir seu recibo antes de retirar a concessão ou autorizar outra tentativa.',evidence};
 if(row.state==='running'||status==='passed'&&semantics)return null;
 if(!['failed','completed'].includes(row.state))return null;
 const nextCondition='Conferir o recibo e os logs autorizados do mesmo job, conciliar a retirada física e reavaliar o plano sem converter ausência de resultado em aprovação.';
 if(semantics){
  if(status==='canceled')return {code:'native_qa_canceled',meaning:'O job terminal de QA registra cancelamento; não registra aprovação do artefato.',owner,nextCondition,evidence};
  if(row.stop_reason==='timeout')return {code:'native_qa_timeout',meaning:'O job terminal de QA registra encerramento por prazo; isto não identifica um teste reprovado.',owner,nextCondition,evidence};
  if(status==='missing_result')return {code:'native_qa_missing_result',meaning:'O QA terminou sem resultado de teste verificável; isto não comprova aprovação nem reprovação do artefato.',owner,nextCondition,evidence};
  if(status==='failed')return {code:'native_qa_failed',meaning:'O recibo armazenado do QA registra resultado reprovado com logs disponíveis; sua assinatura não é verificada por esta leitura.',owner,nextCondition,evidence};
 }
 return {code:'native_qa_unknown',meaning:'O QA tem estado terminal, mas seu recibo não comprova uma causa de teste válida.',owner,nextCondition,evidence};
}
const WAIT_REASONS=['NO_ELIGIBLE_CAPACITY','ORIGINAL_RESERVE_NOT_NEEDED','CAPACITY_BUSY','CAPACITY_QUEUED','GLOBAL_CAPACITY_LIMIT','CONTEXT_CAPACITY_LIMIT','ACCOUNT_CAPACITY_LIMIT'] as const;
export function waitDiagnostic(row:{attempt_id:string;intent_id:string;reason:unknown;exclusions:unknown}):Finding{
 const reason=typeof row.reason==='string'&&WAIT_REASONS.includes(row.reason as typeof WAIT_REASONS[number])?row.reason as typeof WAIT_REASONS[number]:'unknown';
 const exclusions=capacityWaitExclusions(row.exclusions)??[];
 return {code:'capacity_wait',meaning:reason==='unknown'?'Uma tentativa aguarda capacidade; o motivo detalhado não foi comprovado.':'Uma tentativa aguarda capacidade autorizada conforme o motivo estruturado registrado.',owner:'Controlador de capacidade',nextCondition:'Reavaliar a mesma tentativa quando houver capacidade e perfil elegíveis; conciliar as exclusões registradas sem assumir quota esgotada a partir de indisponibilidade.',evidence:[{kind:'capacity_wait',id:row.attempt_id},{kind:'intent',id:row.intent_id}],capacityWait:{reason,exclusions}};
}
