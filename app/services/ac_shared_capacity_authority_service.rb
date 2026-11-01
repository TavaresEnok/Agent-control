# frozen_string_literal: true

class AcSharedCapacityAuthorityService
  class Uncertain < AcCapacityGrant::LimitExceededError; end

  class << self
    def shared?(credential)
      identity(credential)["ownership"] == "shared"
    end

    def prepare!(task:, profile:, operation_id:, epoch:)
      raise Uncertain, "Reserva remota deve ser preparada fora de transação SQL" if AcSharedCapacityIntent.connection.transaction_open?
      credential = profile.agent_credential
      unless credential && credential.active? && credential.company_id == task.company_id &&
             profile.company_id == task.company_id && task.project.company_id == task.company_id && profile.eligible?
        raise Uncertain, "Perfil ou credencial não elegível"
      end
      quota = AcQuotaObservation.latest_for(agent_credential: credential, cli_adapter: profile.cli_adapter, model_scope: profile.model_id)
      unless quota&.available? && quota.confidence_level.to_s == "high" && quota.valid_until.present? && quota.valid_until > Time.current
        raise Uncertain, "Cota positiva vigente é obrigatória"
      end
      config = identity(credential)
      key = config["account_key"]
      host_id = settings.installation_id.to_s
      unless config["ownership"] == "shared" && key.to_s.match?(/\Asha256:[0-9a-f]{64}\z/) &&
             config["authority_id"].present? && config["authority_id"] == settings.authority_id && host_id.match?(/\A[a-zA-Z0-9_.:-]{1,100}\z/)
        raise Uncertain, "Identidade compartilhada não configurada"
      end
      broker_grant_id = "#{host_id}:#{Digest::SHA256.hexdigest(operation_id.to_s)}"
      intent = SessionAdmissionService.transaction do
        credential.reload
        raise Uncertain, "Credencial indisponível" unless credential.user_id.present? && credential.active?

        AcSharedCapacityIntent.create_or_find_by!(operation_id: operation_id) do |row|
          row.assign_attributes(company: task.company, ac_task: task, ac_execution_profile: profile, agent_credential: credential,
            account_key: key, host_id: host_id, authority_id: config["authority_id"], epoch: epoch.to_s, quantity: 1, broker_grant_id: broker_grant_id)
        end
      end
      unless [ intent.company_id, intent.ac_task_id, intent.ac_execution_profile_id, intent.agent_credential_id,
              intent.account_key, intent.host_id, intent.authority_id, intent.epoch, intent.quantity, intent.broker_grant_id ] ==
             [ task.company_id, task.id, profile.id, credential.id, key, host_id, config["authority_id"], epoch.to_s, 1, broker_grant_id ]
        raise Uncertain, "Intenção de capacidade divergente"
      end
      raise Uncertain, "Reserva já encerrada ou bloqueada" if %w[fenced released].include?(intent.state)

      result = client.get!(operation_id: operation_id, account_key: key)
      result = client.reserve!(operation_id: operation_id, account_key: key, quantity: 1, epoch: epoch) if %w[not_found denied].include?(result["state"])
      unless %w[reserved bound].include?(result["state"]) && result["quantity"] == 1 && result["epoch"] == intent.epoch &&
             (result["state"] != "bound" || result["grant_id"] == broker_grant_id)
        raise Uncertain, "Reserva remota indisponível ou divergente"
      end
      intent.with_lock do
        raise Uncertain, "Intenção bloqueada durante reconciliação" if %w[fenced released].include?(intent.state)
        intent.update!(state: result["state"])
      end
      intent
    rescue AcCapacityBrokerClient::Error => e
      raise Uncertain, "Reserva remota incerta: #{e.class}"
    end

    def grant_atomically!(company:, ac_task:, ac_execution_profile:, agent_credential:, operation_id:, epoch:,
                          policy_revision_id:, policy_revision_number:, quantity:, resource_type:, expires_in:)
      SessionAdmissionService.transaction do
        agent_credential.reload
        raise Uncertain, "Credencial indisponível" unless agent_credential.user_id.present? && agent_credential.active?

        intent = AcSharedCapacityIntent.lock.find_by(operation_id: operation_id)
        raise Uncertain, "Intenção de reserva ausente" unless intent
        unless %w[reserved bound].include?(intent.state) && intent.company_id == company.id && intent.ac_task_id == ac_task.id &&
               intent.ac_execution_profile_id == ac_execution_profile.id && intent.agent_credential_id == agent_credential.id &&
               intent.epoch == epoch.to_s && intent.quantity == quantity && resource_type.to_s == "inference_slot" &&
               agent_credential.active? && agent_credential.company_id == company.id && ac_task.company_id == company.id &&
               ac_task.project.company_id == company.id && ac_execution_profile.company_id == company.id &&
               ac_execution_profile.agent_credential_id == agent_credential.id && ac_execution_profile.eligible? &&
               identity(agent_credential)["ownership"] == "shared" && identity(agent_credential)["account_key"] == intent.account_key &&
               identity(agent_credential)["authority_id"] == intent.authority_id &&
               intent.host_id == settings.installation_id &&
               intent.authority_id == settings.authority_id &&
               ac_execution_profile.ac_policy_revision_id == policy_revision_id &&
               ac_execution_profile.ac_policy_revision.revision_number == policy_revision_number
          raise Uncertain, "Intenção de capacidade não corresponde à admissão"
        end
        existing = AcCapacityGrant.find_by(operation_id: operation_id)
        next existing if existing && existing.ac_task_id == ac_task.id && existing.ac_execution_profile_id == ac_execution_profile.id &&
          existing.epoch.to_s == epoch.to_s && %w[granted active].include?(existing.state.to_s)
        raise Uncertain, "Concessão divergente" if existing

        key = "project:#{ac_task.project_id}"
        limit = SessionConcurrencyLimit.for_projects.find_by(scope_id: ac_task.project_id)&.max_sessions || SessionAdmissionPolicy.scope_default("Project")
        occupied = SessionAdmission.occupied.joins(:session_admission_pool).where(session_admission_pools: { key: key }).count +
          AcCapacityGrant.active_or_granted.joins(:ac_task).where(ac_tasks: { project_id: ac_task.project_id }).sum(:quantity)
        budget = SessionAdmissionBudget.new([ key ])
        raise Uncertain, "Capacidade local esgotada" if occupied + quantity > limit || budget.clamp(quantity, key) < quantity

        AcCapacityGrant.create!(company: company, ac_task: ac_task, ac_execution_profile: ac_execution_profile,
          agent_credential: agent_credential, operation_id: operation_id, epoch: epoch, state: :granted,
          quantity: quantity, resource_type: resource_type, policy_revision_id: policy_revision_id,
          policy_revision_number: policy_revision_number, granted_at: Time.current, expires_at: Time.current + expires_in,
          reconciliation_data: { "authority" => "shared", "authority_id" => intent.authority_id, "account_key" => intent.account_key,
            "broker_grant_id" => intent.broker_grant_id, "broker_state" => "reserved" })
      end
    end

    def bind!(grant)
      return unless grant && grant.reconciliation_data["authority"] == "shared"
      raise Uncertain, "Bind remoto deve ocorrer fora de transação SQL" if AcSharedCapacityIntent.connection.transaction_open?

      intent = AcSharedCapacityIntent.find_by!(operation_id: grant.operation_id)
      validate_local_grant!(intent, grant)
      unless intent.authority_id == settings.authority_id &&
             intent.host_id == settings.installation_id
        raise Uncertain, "Autoridade ou host da reserva mudou"
      end
      result = client.get!(operation_id: intent.operation_id, account_key: intent.account_key)
      result = client.bind!(operation_id: intent.operation_id, account_key: intent.account_key, grant_id: intent.broker_grant_id) if result["state"] == "reserved"
      unless result["state"] == "bound" && result["grant_id"] == intent.broker_grant_id && result["quantity"] == intent.quantity && result["epoch"] == intent.epoch
        raise Uncertain, "Vínculo remoto não confirmado"
      end
      AcCapacityGrant.transaction do
        grant.lock!
        intent.lock!
        unless %w[reserved bound].include?(grant.reconciliation_data["broker_state"]) && %w[granted active].include?(grant.state.to_s)
          raise Uncertain, "Concessão local já está bloqueada para liberação"
        end
        grant.update!(reconciliation_data: grant.reconciliation_data.merge("broker_state" => "bound"))
        intent.update!(state: "bound")
      end
    rescue AcCapacityBrokerClient::Error => e
      raise Uncertain, "Vínculo remoto incerto: #{e.class}"
    end

    def ensure_bound!(execution:)
      grant = execution.ac_capacity_grant
      return true unless grant&.reconciliation_data&.dig("authority") == "shared"

      intent = AcSharedCapacityIntent.find_by(operation_id: execution.operation_id)
      raise Uncertain, "Intenção compartilhada ausente" unless intent
      validate_local_grant!(intent, grant)
      unless execution.ac_task_id == intent.ac_task_id && execution.ac_execution_profile_id == intent.ac_execution_profile_id &&
             execution.company_id == intent.company_id && execution.epoch.to_s == intent.epoch &&
             identity(grant.agent_credential)["ownership"] == "shared" &&
             identity(grant.agent_credential)["account_key"] == intent.account_key &&
             identity(grant.agent_credential)["authority_id"] == intent.authority_id &&
             intent.host_id == settings.installation_id &&
             intent.authority_id == settings.authority_id &&
             intent.state == "bound" && grant.reconciliation_data["broker_state"] == "bound" &&
             %w[granted active].include?(grant.state.to_s)
        raise Uncertain, "Vínculo compartilhado não está confirmado"
      end
      true
    end

    def release!(grant:, execution:, receipt:)
      raise Uncertain, "Liberação remota deve ocorrer fora de transação SQL" if AcSharedCapacityIntent.connection.transaction_open?
      intent = AcSharedCapacityIntent.find_by!(operation_id: grant.operation_id)
      validate_local_grant!(intent, grant)
      unless intent.authority_id == settings.authority_id &&
             intent.host_id == settings.installation_id
        raise Uncertain, "Autoridade ou host da reserva mudou"
      end
      result = client.get!(operation_id: intent.operation_id, account_key: intent.account_key)
      if result["state"] == "reserved"
        bind!(grant)
        result = client.get!(operation_id: intent.operation_id, account_key: intent.account_key)
      end
      unless result["quantity"] == intent.quantity && result["epoch"] == intent.epoch &&
             (result["state"] == "reserved" || result["grant_id"] == intent.broker_grant_id)
        raise Uncertain, "Identidade remota divergente"
      end
      if result["state"] != "released"
        result = client.release!(operation_id: intent.operation_id, account_key: intent.account_key,
          release_proof: { "execution_id" => execution.id, "runtime_id" => receipt["runtime_id"],
                           "epoch" => execution.epoch.to_s, "grant_id" => intent.broker_grant_id })
      end
      unless result["state"] == "released" && result["grant_id"] == intent.broker_grant_id &&
             result["quantity"] == intent.quantity && result["epoch"] == intent.epoch
        raise Uncertain, "Liberação remota não confirmada"
      end

      AcCapacityGrant.transaction do
        grant.lock!
        intent.lock!
        grant.update!(state: :released, released_at: Time.current,
          reconciliation_data: grant.reconciliation_data.merge("broker_state" => "released"))
        intent.update!(state: "released")
      end
    rescue AcCapacityBrokerClient::Error => e
      raise Uncertain, "Liberação remota incerta: #{e.class}"
    end

    def release_orphan!(operation_id:)
      raise Uncertain, "Reconciliação deve ocorrer fora de transação SQL" if AcSharedCapacityIntent.connection.transaction_open?
      intent = AcSharedCapacityIntent.find_by!(operation_id: operation_id)
      unless intent.authority_id == settings.authority_id &&
             intent.host_id == settings.installation_id
        raise Uncertain, "Autoridade ou host da reserva mudou"
      end
      result = client.get!(operation_id: intent.operation_id, account_key: intent.account_key)
      if result["state"] == "reserved"
        result = client.bind!(operation_id: intent.operation_id, account_key: intent.account_key, grant_id: intent.broker_grant_id)
      end
      unless %w[bound released].include?(result["state"]) && result["grant_id"] == intent.broker_grant_id &&
             result["quantity"] == intent.quantity && result["epoch"] == intent.epoch
        raise Uncertain, "Reserva órfã não confirmada"
      end
      unless result["state"] == "released"
        result = client.release!(operation_id: intent.operation_id, account_key: intent.account_key,
          release_proof: { "execution_id" => nil, "runtime_id" => nil, "epoch" => intent.epoch, "grant_id" => intent.broker_grant_id })
      end
      unless result["state"] == "released" && result["grant_id"] == intent.broker_grant_id &&
             result["quantity"] == intent.quantity && result["epoch"] == intent.epoch
        raise Uncertain, "Liberação órfã não confirmada"
      end
      intent.with_lock { intent.update!(state: "released") }
      true
    rescue AcCapacityBrokerClient::Error => e
      raise Uncertain, "Reconciliação órfã incerta: #{e.class}"
    end

    def client
      configured = Rails.application.config.try(:ac_capacity_broker_client)
      return configured if configured

      AcCapacityBrokerClient.new(endpoint: settings.endpoint, bearer_token: settings.client_bearer_token,
        signing_key: settings.client_signing_key, host_id: settings.installation_id, authority_id: settings.authority_id)
    rescue ArgumentError
      raise Uncertain, "Cliente do broker não configurado"
    end

    private

    def validate_local_grant!(intent, grant)
      unless [ grant.company_id, grant.ac_task_id, grant.ac_execution_profile_id, grant.agent_credential_id,
              grant.epoch.to_s, grant.quantity, grant.reconciliation_data["account_key"], grant.reconciliation_data["broker_grant_id"],
              grant.reconciliation_data["authority_id"] ] ==
             [ intent.company_id, intent.ac_task_id, intent.ac_execution_profile_id, intent.agent_credential_id,
              intent.epoch, intent.quantity, intent.account_key, intent.broker_grant_id, intent.authority_id ]
        raise Uncertain, "Concessão local diverge da intenção"
      end
    end

    def settings
      Rails.application.config.try(:ac_capacity_broker_client_settings) || Settings.agent_control.capacity_broker
    end

    def identity(credential)
      configs = AcCapacityBrokerConfig.identities
      value = configs.respond_to?(:[]) && (configs[credential&.id] || configs[credential&.id.to_s])
      value.is_a?(Hash) ? value.stringify_keys : {}
    end
  end
end
