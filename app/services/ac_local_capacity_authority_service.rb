# frozen_string_literal: true

# Uses the admission writer lock also held by the legacy queue. A shared account
# across installations needs a broker reservation and is deliberately refused here.
class AcLocalCapacityAuthorityService
  class << self
    def grant_atomically!(company:, ac_task:, ac_execution_profile:, agent_credential:, operation_id:, epoch:,
                          policy_revision_id:, policy_revision_number:, quantity:, resource_type:, expires_in:)
      unless resource_type.to_s == "inference_slot" && quantity.is_a?(Integer) && quantity.positive? &&
             agent_credential&.company_id == company.id && agent_credential.active? && ac_task.company_id == company.id &&
             ac_execution_profile.company_id == company.id && ac_execution_profile.agent_credential_id == agent_credential.id &&
             ac_execution_profile.ac_policy_revision_id == policy_revision_id &&
             ac_execution_profile.ac_policy_revision&.revision_number == policy_revision_number
        raise AcCapacityGrant::LimitExceededError, "Recurso ou identidade de capacidade inválida"
      end
      SessionAdmissionService.transaction do
        limit = account_limit!(agent_credential)
        existing = AcCapacityGrant.find_by(operation_id: operation_id)
        if existing
          expected = [ company.id, ac_task.id, ac_execution_profile.id, agent_credential.id, epoch.to_s, quantity, resource_type.to_s,
                      policy_revision_id, policy_revision_number ]
          actual = [ existing.company_id, existing.ac_task_id, existing.ac_execution_profile_id, existing.agent_credential_id,
                    existing.epoch.to_s, existing.quantity, existing.resource_type.to_s, existing.policy_revision_id,
                    existing.policy_revision_number ]
          unless actual == expected && %w[granted active].include?(existing.state.to_s)
            raise AcCapacityGrant::LimitExceededError, "Operação já vinculada a outra concessão"
          end
          unless existing.reconciliation_data&.dig("account_key") == account_key(agent_credential)
            raise AcCapacityGrant::LimitExceededError, "Identidade da concessão mudou; reconciliação obrigatória"
          end
          next existing
        end

        if account_occupancy(agent_credential) + quantity > limit
          raise AcCapacityGrant::LimitExceededError, "Capacidade da conta esgotada"
        end
        project = ac_task.project
        raise AcCapacityGrant::LimitExceededError, "Projeto obrigatório" unless project && project.company_id == company.id

        key = "project:#{project.id}"
        project_limit = SessionConcurrencyLimit.for_projects.find_by(scope_id: project.id)&.max_sessions ||
                        SessionAdmissionPolicy.scope_default("Project")
        occupied = SessionAdmission.occupied.joins(:session_admission_pool).where(session_admission_pools: { key: key }).count +
                   AcCapacityGrant.active_or_granted.joins(:ac_task).where(ac_tasks: { project_id: project.id }).sum(:quantity)
        budget = SessionAdmissionBudget.new([ key ])
        if occupied + quantity > project_limit || budget.clamp(quantity, key) < quantity
          raise AcCapacityGrant::LimitExceededError, "Capacidade do projeto ou empresa esgotada"
        end
        AcCapacityGrant.create!(company: company, ac_task: ac_task, ac_execution_profile: ac_execution_profile,
          agent_credential: agent_credential, operation_id: operation_id, epoch: epoch, state: :granted,
          quantity: quantity, resource_type: resource_type, policy_revision_id: policy_revision_id,
          policy_revision_number: policy_revision_number, granted_at: Time.current, expires_at: Time.current + expires_in,
          reconciliation_data: { "authority" => "local", "account_key" => account_key(agent_credential) })
      end
    end

    def account_key(credential)
      identities = Rails.application.config.try(:ac_capacity_account_identities)
      identity = identities.respond_to?(:[]) && (identities[credential.id] || identities[credential.id.to_s])
      key = identity.is_a?(Hash) && (identity["account_key"] || identity[:account_key])
      authority = identity.is_a?(Hash) && (identity["authority_id"] || identity[:authority_id])
      ownership = identity.is_a?(Hash) && (identity["ownership"] || identity[:ownership])
      local_authority = Rails.application.config.try(:ac_capacity_authority_id)
      unless key.is_a?(String) && key.match?(/\Asha256:[0-9a-f]{64}\z/) &&
             local_authority.is_a?(String) && local_authority.present? && authority == local_authority &&
             ownership == "exclusive_local"
        raise AcCapacityGrant::LimitExceededError, "Identidade canônica e exclusividade local não configuradas"
      end

      key
    end

    def account_limit!(credential)
      limits = Rails.application.config.try(:ac_local_capacity_accounts)
      config = limits.respond_to?(:[]) && limits[account_key(credential)]
      limit = config.is_a?(Hash) && (config["limit"] || config[:limit])
      mode = config.is_a?(Hash) && (config["mode"] || config[:mode])
      unless mode == "local" && limit.is_a?(Integer) && limit.positive?
        raise AcCapacityGrant::LimitExceededError, "Limite local finito ou exclusividade da conta não configurado"
      end
      limit
    end

    def account_occupancy(credential)
      key = account_key(credential)
      grants = AcCapacityGrant.active_or_granted.includes(:agent_credential).sum do |grant|
        actual = account_key(grant.agent_credential)
        unless grant.reconciliation_data&.dig("account_key") == actual
          raise AcCapacityGrant::LimitExceededError, "Identidade da concessão mudou; reconciliação obrigatória"
        end
        actual == key ? grant.quantity : 0
      end
      sessions = SessionAdmission.occupied.includes(terminal_session: :user).map(&:terminal_session)
      grants + sessions.count do |session|
        selected = session.session_credential
        begin
          selected.nil? || account_key(selected) == key
        rescue AcCapacityGrant::LimitExceededError
          true
        end
      end
    end

    def permit_legacy_session?(session)
      credential = session.session_credential
      unless credential
        return !AcCapacityGrant.active_or_granted.exists?
      end
      return true unless AcCapacityGrant.active_or_granted.exists?

      account_occupancy(credential) < account_limit!(credential)
    rescue AcCapacityGrant::LimitExceededError
      false
    end
  end
end
