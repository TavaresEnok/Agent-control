# frozen_string_literal: true

module Api
  module V1
    module AgentControl
      class ApplicationController < ActionController::API
        before_action :resolve_company!

        private

        def resolve_company!
          company_id = params[:company_id] || request.headers["X-Company-Id"]
          @company = company_id.present? ? ::Company.find_by(id: company_id) : nil
          @company ||= ::Company.first
          render json: { error: "Company context required" }, status: :bad_request unless @company
        end

        def current_company
          @company
        end
      end
    end
  end
end
