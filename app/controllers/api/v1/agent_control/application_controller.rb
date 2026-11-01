# frozen_string_literal: true

module Api
  module V1
    module AgentControl
      class ApplicationController < Api::V1::ApplicationController
        skip_before_action :enforce_company_auth_policy, :dynamic_authorize!, :deny_read_only_mutation!
        before_action :resolve_company!
        before_action :enforce_company_auth_policy
        before_action :dynamic_authorize!
        before_action :deny_read_only_mutation!

        private

        def resolve_company!
          company_id = params[:company_id] || request.headers["X-Company-Id"]
          @company = if company_id.present?
            current_user.companies.find_by(id: company_id)
          else
            current_membership&.company || current_user.companies.first
          end
          render json: { error: "Empresa não encontrada ou acesso não autorizado" }, status: :forbidden unless @company
        end

        def current_company
          @company
        end

        def policy_context
          BaseContext.new(current_user, params, company: @company)
        end

        def dynamic_authorize!
          authorize :agent_control, policy_class: Api::V1::AgentControlPolicy
        end
      end
    end
  end
end
