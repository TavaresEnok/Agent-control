import {Id,Refusal,digest} from './contracts.ts';
import type {Ledger} from './ledger.ts';
import {QualityPolicy} from './quality-policy.ts';
import type {AgentControlDiagnosticFinding} from '../upstream/cezar/packages/contract/src/agent-control-operations.ts';
import {projectNativeTerminalFailure, type NativeTerminalFailureSource} from './native-failure-diagnostics.ts';
import {readWorkflowVersionSnapshot, type WorkflowVersionSnapshot} from './workflow-versions.ts';

export type DiagnosticFinding=AgentControlDiagnosticFinding;
/** Only stored, context-scoped facts are reported; this service never initiates recovery. */
export class ContextDiagnostics{
 constructor(private readonly ledger:Ledger,private readonly projectId:string){Id.parse(projectId);}
 async read(principal:string,contextId:string){
  Id.parse(contextId);if(!principal)throw new Refusal('AUTH_REQUIRED',401);
  const c=await this.ledger.pool.connect();
  try{
   await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   await c.query("SET LOCAL statement_timeout = '2500ms'");
   const context=(await c.query(`SELECT x.id,x.project_id,x.paused,x.draining FROM ac_contexts x
    JOIN ac_memberships m ON m.project_id=x.project_id AND m.principal_id=$2
    WHERE x.id=$1 AND NOT x.archived`,[contextId,principal])).rows[0];
   if(!context)throw new Refusal('CONTEXT_FORBIDDEN',403);
   if(context.project_id!==this.projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
   const findings:DiagnosticFinding[]=[];
   if(context.paused)findings.push({code:'context_paused',meaning:'A pausa humana está ativa.',owner:'Operador do contexto',nextCondition:'Retomada explícita e autorizada.',evidence:[{kind:'context',id:contextId}]});
   if(context.draining)findings.push({code:'context_draining',meaning:'A drenagem impede admitir novos planos; planos aceitos podem continuar.',owner:'Operador do contexto',nextCondition:'Encerramento autorizado da drenagem para admitir novos planos.',evidence:[{kind:'context',id:contextId}]});
   const active=(await c.query(`SELECT EXISTS(SELECT 1 FROM ac_intents WHERE context_id=$1
    AND state NOT IN ('completed','done','review','failed','canceled','cancelled')) active`,[contextId])).rows[0].active;
   if(active){
    const admission=(await c.query('SELECT enabled FROM ac_admission_control WHERE id=1')).rows[0];
    if(admission?.enabled===false)findings.push({code:'admission_closed',meaning:'A admissão global está fechada para novos efeitos.',owner:'Administrador da instalação',nextCondition:'Reabertura explícita da admissão após resolver a causa registrada.',evidence:[{kind:'context',id:contextId}]});
    const manager=(await c.query('SELECT 1 FROM ac_managers WHERE context_id=$1 AND lease_until>clock_timestamp()',[contextId])).rowCount;
    if(!manager)findings.push({code:'manager_unavailable',meaning:'Há intenções pendentes sem concessão vigente de gerente.',owner:'Administrador do projeto',nextCondition:'Iniciar um gerente autorizado; depois reconciliar operações antigas antes de novos efeitos.',evidence:[{kind:'context',id:contextId}]});
   }
   const planning=await c.query(`SELECT id,state FROM ac_semantic_planning_calls WHERE context_id=$1
    AND state IN ('registered','uncertain','ready','rejected') ORDER BY created_at DESC,id LIMIT 101`,[contextId]);
   for(const row of planning.rows.slice(0,100)){
    const fact=row.state==='registered'?{code:'planning_pending' as const,meaning:'A geração da proposta aguarda admissão.',nextCondition:'Gerente autorizado e capacidade elegível para a mesma chamada.'}
     :row.state==='ready'?{code:'planning_publication_pending' as const,meaning:'A proposta foi conferida e aguarda publicação autorizada.',nextCondition:'Resolver pausa, cancelamento ou conflito de revisão preservando a proposta já gerada.'}
     :row.state==='rejected'?{code:'planning_rejected' as const,meaning:'A geração terminou sem uma proposta válida e confirmada.',nextCondition:'Reavaliar a causa e admitir nova solicitação explícita; não repetir o mesmo efeito incerto.'}
     :{code:'planning_result_uncertain' as const,meaning:'A geração ainda não possui resultado final reconciliado.',nextCondition:'Consultar o executor e recibo originais; não lançar outro modelo para esta mesma chamada.'};
    findings.push({...fact,owner:'Gerente e controlador de planejamento',evidence:[{kind:'semantic_planning',id:row.id}]});
   }
   const nativePlanning=await c.query(`SELECT id FROM ac_native_planning_jobs WHERE context_id=$1 AND state='uncertain' ORDER BY created_at,id LIMIT 101`,[contextId]);
   for(const row of nativePlanning.rows.slice(0,100))findings.push({code:'native_planning_uncertain',meaning:'O lançamento ou resultado do contêiner de planejamento ainda não está confirmado.',owner:'Supervisor de planejamento',nextCondition:'Observar o mesmo contêiner e sua saída; preservar a concessão até existir prova terminal.',evidence:[{kind:'native_planning_job',id:row.id}]});
   const nativeFailures=await c.query(`SELECT j.id,j.intent_id,j.role,j.state,j.receipt AS job_receipt,
    o.id AS operation_id,o.receipt AS operation_receipt,
    s.id AS stage_id,s.node_id AS stage_node,s.receipt AS stage_receipt,
    f.state AS finalizer_state,f.receipt AS finalizer_receipt
    FROM ac_native_execution_jobs j
    JOIN ac_intents i ON i.id=j.intent_id AND i.context_id=j.context_id
    LEFT JOIN ac_operations o ON j.role='programmer' AND o.id=j.id AND o.intent_id=j.intent_id
    LEFT JOIN ac_stage_operations s ON j.role IN ('qa','reviewer','judge') AND s.id=j.id AND s.intent_id=j.intent_id
    LEFT JOIN ac_native_artifact_finalizations f ON j.role='programmer' AND f.job_id=j.id AND f.context_id=j.context_id
    WHERE j.context_id=$1 AND j.state='failed'
    ORDER BY j.created_at,j.id LIMIT 101`,[contextId]);
   for(const row of nativeFailures.rows.slice(0,100)){
    const role=row.role as NativeTerminalFailureSource['role'];
    if(!['programmer','qa','reviewer','judge','specialist'].includes(role))continue;
    const source:NativeTerminalFailureSource={jobId:row.id,intentId:row.intent_id,contextId,role,state:row.state,
     jobReceipt:row.job_receipt,operationId:row.operation_id,operationReceipt:row.operation_receipt,
     stageId:row.stage_id,stageNode:row.stage_node,stageReceipt:row.stage_receipt,
     finalizerState:row.finalizer_state,finalizerReceipt:row.finalizer_receipt};
    const finding=projectNativeTerminalFailure(source);
    if(finding)findings.push(finding);
   }
   const advice=await c.query(`SELECT id,state,receipt->>'status' verdict FROM ac_specialist_advice WHERE context_id=$1
    AND (state IN ('running','uncertain') OR (state='completed' AND receipt->>'status'='rejected')) ORDER BY id LIMIT 101`,[contextId]);
   for(const row of advice.rows.slice(0,100))findings.push(row.state==='completed'
    ?{code:'specialist_rejected',meaning:'O especialista independente reprovou a orientação para esta implementação.',owner:'Gerente e responsável pelo plano',nextCondition:'Reavaliar a proposta preservando o parecer; a reprovação não autoriza lançar o escritor.',evidence:[{kind:'specialist',id:row.id}]}
    :{code:'specialist_uncertain',meaning:'A orientação do especialista ainda não tem conclusão confirmada.',owner:'Controlador de recuperação',nextCondition:'Conciliar o executor e o recibo originais antes de autorizar o escritor.',evidence:[{kind:'specialist',id:row.id}]});
   const administrative=await c.query(`SELECT id FROM ac_administrative_operations WHERE context_id=$1
    AND state IN ('running','uncertain') ORDER BY id LIMIT 101`,[contextId]);
   for(const row of administrative.rows.slice(0,100))findings.push({code:'administrative_effect_uncertain',meaning:'Uma operação administrativa mantém resultado não confirmado e ocupa a capacidade exclusiva.',owner:'Gerente e helper administrativo registrado',nextCondition:'Consultar a operação original e validar seu recibo assinado; não repetir o efeito.',evidence:[{kind:'administrative_operation',id:row.id}]});
   const cancellations=await c.query('SELECT intent_id,state FROM ac_plan_cancellations WHERE context_id=$1 ORDER BY requested_at,intent_id LIMIT 101',[contextId]);
   for(const row of cancellations.rows.slice(0,100))findings.push(row.state==='confirmed'
    ?{code:'cancellation_confirmed',meaning:'O cancelamento do plano foi confirmado no registro.',owner:'Controlador de execução',nextCondition:'Nenhuma condição adicional de cancelamento registrada.',evidence:[{kind:'cancellation',id:row.intent_id}]}
    :{code:'cancellation_requested',meaning:'Cancelamento solicitado; a confirmação ainda não consta.',owner:'Controlador de execução',nextCondition:'Conciliar efeitos e concessões; confirmar a parada quando houver prova.',evidence:[{kind:'cancellation',id:row.intent_id}]});
   const waits=await c.query('SELECT attempt_id FROM ac_capacity_waits WHERE context_id=$1 ORDER BY sequence LIMIT 101',[contextId]);
   for(const row of waits.rows.slice(0,100))findings.push({code:'capacity_wait',meaning:'Uma tentativa aguarda capacidade autorizada.',owner:'Controlador de capacidade',nextCondition:'Capacidade elegível e autorização disponíveis para a mesma tentativa.',evidence:[{kind:'capacity_wait',id:row.attempt_id}]});
   const operations=await c.query(`SELECT o.id,i.parent_intent_id FROM ac_operations o JOIN ac_intents i ON i.id=o.intent_id
    WHERE i.context_id=$1 AND o.state='uncertain' ORDER BY o.id LIMIT 101`,[contextId]);
   for(const row of operations.rows.slice(0,100))findings.push({code:row.parent_intent_id?'managed_effect_uncertain':'effect_uncertain',meaning:'O resultado físico da operação não está confirmado.',owner:'Controlador de recuperação',nextCondition:'Obter e conferir evidência física da operação original.',evidence:[{kind:'operation',id:row.id}]});
   const localGrants=await c.query(`SELECT o.id operation_id FROM ac_capacity_grants g
    LEFT JOIN ac_operations o ON o.id=(SELECT op.id FROM ac_operations op WHERE op.intent_id=g.intent_id AND op.grant_id=g.id LIMIT 1)
    WHERE g.context_id=$1 AND g.resource_kind='local_compositor' AND g.state='uncertain' ORDER BY g.id LIMIT 101`,[contextId]);
   for(const row of localGrants.rows.slice(0,100))findings.push({code:'managed_effect_uncertain',meaning:'Uma concessão do compositor local mantém resultado físico incerto.',owner:'Controlador de recuperação',nextCondition:'Conciliar a concessão e a evidência física antes de liberar capacidade.',evidence:row.operation_id?[{kind:'operation',id:row.operation_id}]:[{kind:'context',id:contextId}]});
   const stages=await c.query(`SELECT s.id FROM ac_stage_operations s JOIN ac_intents i ON i.id=s.intent_id
    WHERE i.context_id=$1 AND s.state='uncertain' ORDER BY s.id LIMIT 101`,[contextId]);
   for(const row of stages.rows.slice(0,100))findings.push({code:'stage_uncertain',meaning:'O resultado físico da etapa não está confirmado.',owner:'Controlador de recuperação',nextCondition:'Conciliar o recibo e a concessão da etapa original.',evidence:[{kind:'stage',id:row.id}]});
   const receipts=await c.query(`SELECT j.id FROM ac_sandbox_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id
    WHERE j.context_id=$1 AND j.state IN ('completed','failed') AND
     (g.state<>'released' OR j.receipt IS NULL OR g.physical_receipt IS NULL OR j.receipt IS DISTINCT FROM g.physical_receipt)
    ORDER BY j.id LIMIT 101`,[contextId]);
   for(const row of receipts.rows.slice(0,100))findings.push({code:'physical_receipt_unconfirmed',meaning:'Os registros do resultado físico não estão reconciliados.',owner:'Controlador de recuperação',nextCondition:'Conferir o job original e sua concessão com evidência física.',evidence:[{kind:'sandbox_job',id:row.id}]});
   const integrations=await c.query("SELECT id FROM ac_integration_intents WHERE context_id=$1 AND state='uncertain' ORDER BY id LIMIT 101",[contextId]);
   for(const row of integrations.rows.slice(0,100))findings.push({code:'integration_uncertain',meaning:'A integração aguarda confirmação do resultado.',owner:'Controlador de integração',nextCondition:'Conciliar a referência com o artefato e a política congelados.',evidence:[{kind:'integration',id:row.id}]});
   const approvals=await c.query(`SELECT DISTINCT a.id,s.id stage_id,p.snapshot,p.digest FROM ac_stage_operations s
    JOIN ac_intents i ON i.id=s.intent_id JOIN ac_artifacts a ON a.intent_id=i.id AND a.context_id=i.context_id
    JOIN ac_operations o ON o.intent_id=i.id AND o.state='completed' AND o.receipt->>'commit'=a.commit_id
      AND o.receipt->>'tree'=a.tree_id AND o.receipt->>'base'=a.base_id
    JOIN ac_execution_contracts x ON x.intent_id=i.id AND x.project_id=a.project_id AND x.quality_revision=a.policy_revision
    JOIN ac_quality_policies p ON p.project_id=a.project_id AND p.revision=a.policy_revision
    WHERE i.context_id=$1 AND s.node_id='integrate' AND s.state='registered'
    AND NOT EXISTS(SELECT 1 FROM ac_integration_approvals ap WHERE ap.artifact_id=a.id AND ap.target_ref=x.target_ref
      AND ap.artifact_digest=a.identity_digest AND ap.policy_revision=a.policy_revision) ORDER BY a.id,s.id LIMIT 101`,[contextId]);
   for(const row of approvals.rows.slice(0,100)){
    const policy=QualityPolicy.safeParse(row.snapshot);
    if(!policy.success||digest(policy.data)!==row.digest){findings.push({code:'policy_unknown',meaning:'Não foi possível verificar a política congelada.',owner:'Administrador do projeto',nextCondition:'Conciliar a política e sua integridade.',evidence:[{kind:'artifact',id:row.id}]});continue;}
    if(policy.data.requireHumanIntegration)findings.push({code:'approval_missing',meaning:'A aprovação exigida para este artefato e destino ainda não consta.',owner:'Aprovador autorizado',nextCondition:'Decisão autorizada sobre o artefato e destino congelados.',evidence:[{kind:'artifact',id:row.id},{kind:'stage',id:row.stage_id}]});
   }
   const truncated=[planning,nativePlanning,nativeFailures,advice,administrative,cancellations,waits,operations,localGrants,stages,receipts,integrations,approvals].some(r=>r.rows.length>100);
   await c.query('COMMIT');
   return {contextId,findings,truncated,assessment:findings.length?'observed':'unknown',
    ...(findings.length?{}:{explanation:'Nenhuma causa foi comprovada nos registros consultados; o estado de parada é desconhecido.'})};
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 }
 /** Same authorization and read-only transaction as read(). The closed diagnostics HTTP schema is unchanged. */
 async workflowVersions(principal:string,contextId:string):Promise<WorkflowVersionSnapshot>{
  Id.parse(contextId);if(!principal)throw new Refusal('AUTH_REQUIRED',401);
  const c=await this.ledger.pool.connect();
  try{
   await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   await c.query("SET LOCAL statement_timeout = '2500ms'");
   const context=(await c.query(`SELECT x.project_id FROM ac_contexts x
    JOIN ac_memberships m ON m.project_id=x.project_id AND m.principal_id=$2
    WHERE x.id=$1 AND NOT x.archived`,[contextId,principal])).rows[0];
   if(!context)throw new Refusal('CONTEXT_FORBIDDEN',403);
   if(context.project_id!==this.projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
   const report=await readWorkflowVersionSnapshot(c,contextId);
   await c.query('COMMIT');
   return report;
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 }
}
