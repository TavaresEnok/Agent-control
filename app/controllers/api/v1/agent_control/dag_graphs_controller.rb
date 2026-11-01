# frozen_string_literal: true

module Api
  module V1
    module AgentControl
      class DagGraphsController < ApplicationController
        def show
          plan_id = params[:plan_id] || params[:id]
          plan = AcPlan.where(company: current_company).find(plan_id)

          graph = AcDagGraphService.build_graph(plan: plan)
          render json: graph, status: :ok
        rescue ActiveRecord::RecordNotFound
          render json: { error: "Plan not found" }, status: :not_found
        end
      end
    end
  end
end
