# frozen_string_literal: true

# AcPolicyEngineService — Motor de seleção de perfis e explicação de decisões (F1-B, F1-D)
#
# Implementa a seleção explicável de perfis de execução conforme política vigente (RF-08, RF-09):
# - Consulta a revisão de política ativa para a company
# - Avalia cadeia de substituição pelo papel da tarefa (assigned_role)
# - Filtra perfis com observações de cota impeditivas (RF-10)
# - Registra eventos append-only de auditoria para cada decisão (G1)
# - Retorna o perfil selecionado com justificação completa
class AcPolicyEngineService
  Result = Struct.new(:success?, :profile, :policy_revision, :reason, :rejected_profiles, keyword_init: true)

  def self.select_profile_for_task(task:, actor_type: "policy_service", actor_user: nil)
    new(company: task.company, project: task.project, task: task).select_profile(
      actor_type: actor_type,
      actor_user: actor_user
    )
  end

  def initialize(company:, project:, task:)
    @company = company
    @project = project
    @task = task
  end

  def select_profile(actor_type: "policy_service", actor_user: nil)
    policy_revision = find_active_policy
    unless policy_revision
      return Result.new(
        success?: false,
        profile: nil,
        policy_revision: nil,
        reason: "Nenhuma política publicada ativa encontrada para a company #{@company.id}",
        rejected_profiles: []
      )
    end

    role = @task.assigned_role.to_s
    candidates = policy_revision.ac_execution_profiles.for_role(role).order(:chain_position)

    if candidates.empty?
      return Result.new(
        success?: false,
        profile: nil,
        policy_revision: policy_revision,
        reason: "Nenhum perfil de execução cadastrado para o papel '#{role}' na política #{policy_revision.revision_number}",
        rejected_profiles: []
      )
    end

    rejected = []
    selected = nil

    candidates.each do |candidate|
      rejection_reason = evaluate_candidate(candidate)
      if rejection_reason
        rejected << { profile: candidate, reason: rejection_reason }

        AcDecisionAuditEvent.record_profile_rejection!(
          company: @company,
          project: @project,
          task: @task,
          profile: candidate,
          policy_revision: policy_revision,
          rejection_reason: rejection_reason,
          actor_type: actor_type,
          actor_user: actor_user
        )
      else
        selected = candidate
        break
      end
    end

    if selected
      AcDecisionAuditEvent.record_profile_selection!(
        company: @company,
        project: @project,
        task: @task,
        profile: selected,
        policy_revision: policy_revision,
        actor_type: actor_type,
        actor_user: actor_user,
        reason: "Perfil #{selected.profile_key} selecionado na posição #{selected.chain_position} para papel '#{role}'",
        alternatives_considered: rejected.map { |r| { profile_key: r[:profile].profile_key, reason: r[:reason] } }
      )

      Result.new(
        success?: true,
        profile: selected,
        policy_revision: policy_revision,
        reason: "Perfil selecionado com sucesso",
        rejected_profiles: rejected
      )
    else
      Result.new(
        success?: false,
        profile: nil,
        policy_revision: policy_revision,
        reason: "Todos os perfis para o papel '#{role}' foram recusados: #{rejected.map { |r| "#{r[:profile].profile_key} (#{r[:reason]})" }.join(', ')}",
        rejected_profiles: rejected
      )
    end
  end

  private

  def find_active_policy
    # Usa a política específica do plano se houver, ou a atual da company
    @task.ac_plan&.policy_revision ||
      AcPolicyRevision.where(company_id: @company.id, state: :published).order(revision_number: :desc).first
  end

  def evaluate_candidate(profile)
    verdict = profile.eligibility_verdict
    return verdict[:reasons].join("; ") unless verdict[:eligible]

    # Verificar se a credencial tem cota bloqueante
    if profile.agent_credential_id.present?
      blocking_obs = AcQuotaObservation.latest_for(
        agent_credential: profile.agent_credential,
        cli_adapter: profile.cli_adapter,
        model_scope: profile.model_id
      )

      if blocking_obs&.blocking?
        return "Cota indisponível: #{blocking_obs.state_description}"
      end
    end

    # Verificar requisitos de classe de risco (RF-18)
    if @task.requires_qa? && profile.effort_level == "low"
      return "Tarefa de risco elevado (#{@task.risk_class}) exige esforço superior a 'low'"
    end

    nil # elegível
  end
end
