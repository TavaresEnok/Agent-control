# frozen_string_literal: true

module Api
  module V1
    module AgentControl
      class ClientCommandsController < ApplicationController
        SUPPORTED_COMMANDS = %w[setup_project_wizard create_task publish_plan start_plan advance_dag pause_plan resume_plan cancel_plan execute_remote_operation].freeze

        def create
          intent_id = params[:intent_id]
          command_type = params[:command_type]
          payload = params[:payload]&.to_unsafe_h || {}

          if intent_id.blank? || command_type.blank?
            return render json: { error: "intent_id and command_type are required" }, status: :unprocessable_entity
          end

          unless SUPPORTED_COMMANDS.include?(command_type.to_s)
            return render json: { error: "unsupported_command" }, status: :unprocessable_entity
          end

          result = AcCommandDeduplicationService.execute_idempotent!(
            intent_id: intent_id,
            company: current_company,
            command_type: command_type,
            payload: payload,
            user: current_user
          ) do |command|
            handle_command(command_type, payload, command)
          end

          render json: result, status: :ok
        rescue AcCommandDeduplicationService::DuplicateProcessingError, AcCommandDeduplicationService::IntentMismatchError,
               AcAdmissionService::UnauthorizedExecutionBypassError, ActiveRecord::StaleObjectError => e
          render json: { error: e.message }, status: :conflict
        rescue ArgumentError, KeyError, AcAdmissionService::TaskNotEligibleForAdmissionError => e
          render json: { error: e.message }, status: :unprocessable_entity
        end

        private

        def handle_command(command_type, payload, command)
          case command_type.to_s
          when "setup_project_wizard"
            role = payload["role"].presence || "programmer"
            effort = payload["effort_level"].presence || "medium"
            raise ArgumentError, "Invalid role" unless %w[programmer manager qa reviewer specialist integrator].include?(role)
            raise ArgumentError, "Invalid effort level" unless %w[low medium high].include?(effort)
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
              state: "active",
              metadata: { "role" => role, "effort_level" => effort }
            )

            plan = AcPlan.create!(
              company: current_company,
              project: project,
              ac_work_context: context,
              plan_key: "plan-#{project.id}-1",
              title: "Plano Inicial #{project.name}",
              objective: "Execução orientada pelo assistente móvel",
              version: 1,
              state: :draft
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
            profile = if payload["execution_profile_id"].present?
              AcExecutionProfile.where(company: current_company, state: "active").find(payload["execution_profile_id"])
            end
            role = payload["assigned_role"].presence || profile&.role || "programmer"
            effort = payload["effort_level"].presence || profile&.effort_level
            if profile && (profile.role != role || (effort && profile.effort_level != effort))
              raise ArgumentError, "Execution profile does not match role and effort"
            end
            if effort.present? && !%w[low medium high].include?(effort)
              raise ArgumentError, "Invalid effort level"
            end
            plan = AcPlan.where(company: current_company).find(payload["plan_id"])
            task = AcTask.create!(
              company: current_company,
              project: plan.project,
              ac_plan: plan,
              task_key: payload["task_key"] || "task-#{SecureRandom.hex(4)}",
              title: payload["title"] || "Nova Tarefa",
              scope: payload["scope"] || "Escopo padrão",
              position: payload["position"] || (plan.ac_tasks.count + 1),
              assigned_role: role,
              metadata: { "execution_profile_id" => profile&.id, "effort_level" => effort }.compact,
              risk_class: payload["risk_class"] || "low",
              depends_on: payload["depends_on"] || [],
              state: "pending"
            )
            { task_id: task.id, task_key: task.task_key, state: task.state }

          when "publish_plan"
            plan = AcPlan.where(company: current_company).find(payload["plan_id"])
            unless plan.project.accessible_by?(current_user) && (current_user == plan.project.owner ||
              current_user.company_memberships.active.where(company: current_company, role: "admin").exists?)
              raise Pundit::NotAuthorizedError, "Sem autorização para publicar o plano"
            end
            policy = AcPolicyRevision.where(company: current_company, state: "published").where.not(published_at: nil).find(payload["policy_revision_id"])
            raise ArgumentError, plan.errors.full_messages.to_sentence unless plan.publish!(policy_revision: policy)

            { plan_id: plan.id, state: plan.state, published_at: plan.published_at.iso8601 }

          when "start_plan"
            plan = AcPlan.where(company: current_company).find(payload["plan_id"])
            event = AcPlanLaunchService.record!(plan: plan, actor: current_user)
            { plan_id: plan.id, intent_id: event.id, status: "queued", workflow_version: 2 }

          when "execute_remote_operation"
            event = AcRemoteLaunchService.record!(company: current_company, actor: current_user,
              command_record: command, payload: payload)
            { operation_id: event.data["operation_id"], event_id: event.id, status: "queued", workflow_version: 2 }

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
          end
        end
      end
    end
  end
end
