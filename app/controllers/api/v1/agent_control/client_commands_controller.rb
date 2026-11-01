# frozen_string_literal: true

module Api
  module V1
    module AgentControl
      class ClientCommandsController < ApplicationController
        def create
          intent_id = params[:intent_id]
          command_type = params[:command_type]
          payload = params[:payload]&.to_unsafe_h || {}

          if intent_id.blank? || command_type.blank?
            return render json: { error: "intent_id and command_type are required" }, status: :unprocessable_entity
          end

          result = AcCommandDeduplicationService.execute_idempotent!(
            intent_id: intent_id,
            company: current_company,
            command_type: command_type,
            payload: payload,
            user: current_user
          ) do |_command|
            handle_command(command_type, payload)
          end

          render json: result, status: :ok
        rescue AcCommandDeduplicationService::DuplicateProcessingError => e
          render json: { error: e.message }, status: :conflict
        rescue StandardError => e
          render json: { error: e.message }, status: :internal_server_error
        end

        private

        def handle_command(command_type, payload)
          case command_type.to_s
          when "setup_project_wizard"
            project_name = payload["project_name"].presence || "Novo Projeto Mobile"
            context_title = payload["context_title"].presence || "Contexto #{project_name}"

            project = ::Project.create!(
              company: current_company,
              name: project_name,
              owner: current_user
            )

            context = AcWorkContext.create!(
              company: current_company,
              project: project,
              title: context_title,
              external_id: "ctx-#{project.id}-#{SecureRandom.hex(4)}",
              state: "active"
            )

            plan = AcPlan.create!(
              company: current_company,
              project: project,
              ac_work_context: context,
              plan_key: "plan-#{project.id}-1",
              title: "Plano Inicial #{project.name}",
              objective: "Execução orientada pelo assistente móvel",
              version: 1,
              state: :active,
              content_hash: Digest::SHA256.hexdigest("plan_init_#{project.id}")
            )

            if payload["remote_environment_id"].present?
              env = AcRemoteEnvironment.where(company: current_company).find_by(id: payload["remote_environment_id"])
              context.update!(metadata: (context.metadata || {}).merge("remote_environment_id" => env.id)) if env
            end

            {
              project_id: project.id,
              project_name: project.name,
              context_id: context.id,
              plan_id: plan.id,
              status: "configured"
            }

          when "create_task"
            plan = AcPlan.where(company: current_company).find(payload["plan_id"])
            task = AcTask.create!(
              company: current_company,
              project: plan.project,
              ac_plan: plan,
              task_key: payload["task_key"] || "task-#{SecureRandom.hex(4)}",
              title: payload["title"] || "Nova Tarefa",
              scope: payload["scope"] || "Escopo padrão",
              position: payload["position"] || (plan.ac_tasks.count + 1),
              assigned_role: payload["assigned_role"] || "programmer",
              risk_class: payload["risk_class"] || "low",
              depends_on: payload["depends_on"] || [],
              state: "pending"
            )
            { task_id: task.id, task_key: task.task_key, state: task.state }

          when "advance_dag"
            plan = AcPlan.where(company: current_company).find(payload["plan_id"])
            ready = plan.advance_dag!
            { plan_id: plan.id, ready_tasks: ready.map(&:task_key) }

          when "pause_plan"
            plan = AcPlan.where(company: current_company).find(payload["plan_id"])
            reason = payload["reason"].presence || "Pausa operacional solicitada pelo operador"
            plan.pause!(reason: reason, user: current_user)
            { plan_id: plan.id, state: plan.state, paused: true, reason: reason }

          when "resume_plan"
            plan = AcPlan.where(company: current_company).find(payload["plan_id"])
            plan.resume!(user: current_user)
            { plan_id: plan.id, state: plan.state, paused: false }

          when "cancel_plan"
            plan = AcPlan.where(company: current_company).find(payload["plan_id"])
            reason = payload["reason"].presence || "Cancelamento operacional solicitado pelo operador"
            plan.cancel!(reason: reason, user: current_user)
            { plan_id: plan.id, state: plan.state, cancelled: true, reason: reason }

          when "dispatch_remote_operation"
            env = AcRemoteEnvironment.where(company: current_company).find(payload["environment_id"])
            op = AcRemoteGatewayService.dispatch_operation!(
              environment: env,
              operation_id: payload["operation_id"] || "op-#{SecureRandom.hex(6)}",
              command: payload["command"],
              working_directory: payload["working_directory"],
              artifact_hash: payload["artifact_hash"]
            )
            { operation_id: op.operation_id, state: op.state, exit_code: op.exit_code }

          else
            { acknowledged: true, command_type: command_type, processed_at: Time.current.iso8601 }
          end
        end
      end
    end
  end
end
