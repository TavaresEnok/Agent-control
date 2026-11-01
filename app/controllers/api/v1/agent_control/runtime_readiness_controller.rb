# frozen_string_literal: true

module Api
  module V1
    module AgentControl
      class RuntimeReadinessController < ApplicationController
        def show
          render json: AcRuntimeConfigurationLoader.readiness(company: current_company)
        end
      end
    end
  end
end
