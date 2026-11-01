# frozen_string_literal: true

module Api
  module V1
    module AgentControl
      class TemplatesController < ApplicationController
        def index
          render json: templates.order(:template_key, version: :desc)
        end

        def show
          render json: templates.find(params[:id])
        end

        def create
          template = nil
          @company.with_lock do
            key = params.require(:template_key)
            version = AcTemplate.where(company: @company, template_key: key).maximum(:version).to_i + 1
            template = templates.create!(template_key: key, version: version, title: params.require(:title), definition: definition)
          end
          render json: template, status: :created
        end

        def update
          prior = templates.find(params[:id])
          template = nil
          @company.with_lock do
            version = AcTemplate.where(company: @company, template_key: prior.template_key).maximum(:version).to_i + 1
            template = templates.create!(template_key: prior.template_key, version: version, title: params.require(:title), definition: definition)
          end
          render json: template, status: :created
        end

        def destroy
          templates.find(params[:id]).update!(deleted_at: Time.current)
          head :no_content
        end

        private

        def templates
          AcTemplate.where(company: @company, deleted_at: nil)
        end

        def definition
          params.require(:definition).permit(tasks: [ :task_key, :title, { depends_on: [] } ]).to_h
        end

        def dynamic_authorize!
          authorize :agent_control, (request.get? || request.head?) ? :show? : :create?, policy_class: Api::V1::AgentControlPolicy
        end
      end
    end
  end
end
