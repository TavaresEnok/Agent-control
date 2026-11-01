# frozen_string_literal: true

module Api
  module V1
    module AgentControl
      class ApplicationController < ActionController::API
        include AuthConcern

        before_action :authenticate_user!
        before_action :resolve_company!

        private

        def resolve_company!
          company_id = params[:company_id] || request.headers["X-Company-Id"]
          if company_id.present?
            @company = current_user.companies.find_by(id: company_id)
          else
            @company = current_company || current_user.companies.first
          end

          unless @company
            render json: { error: "Empresa não encontrada ou acesso não autorizado" }, status: :forbidden
            return false
          end
        end

        def current_company
          @company
        end
      end
    end
  end
end
