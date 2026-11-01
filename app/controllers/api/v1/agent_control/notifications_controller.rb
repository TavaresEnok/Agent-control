# frozen_string_literal: true

module Api
  module V1
    module AgentControl
      class NotificationsController < ApplicationController
        skip_before_action :deny_read_only_mutation!, only: :read

        def index
          receipts = AcNotificationReceipt.joins(:trigger_event)
            .where(user: current_user, trigger_events: { company_id: @company.id, source: "agent_control.notification", project_id: Project.for_user(current_user).select(:id) })
            .includes(:trigger_event).order(created_at: :desc).limit(100)
          render json: receipts.map { |receipt| serialize(receipt) }
        end

        def create
          project = Project.for_user(current_user).where(company: @company).find(params.require(:project_id))
          recipient = User.joins(:company_memberships).where(company_memberships: { company_id: @company.id, state: "active" }).find(params.require(:recipient_id))
          event = AcNotificationService.record!(company: @company, project: project, actor: current_user,
            recipient: recipient, intent_id: params.require(:intent_id), kind: params.require(:kind),
            title: params.require(:title), body: params.require(:body))
          render json: { id: event.id, relay_state: event.relay_state }, status: :accepted
        rescue ArgumentError => e
          render json: { error: e.message }, status: :unprocessable_entity
        rescue AcNotificationService::ConflictError => e
          render json: { error: e.message }, status: :conflict
        end

        def read
          receipt = AcNotificationReceipt.joins(:trigger_event)
            .where(user: current_user, trigger_events: { company_id: @company.id, source: "agent_control.notification", project_id: Project.for_user(current_user).select(:id) }).find(params[:id])
          receipt.update!(read_at: receipt.read_at || Time.current)
          render json: serialize(receipt)
        end

        private

        def serialize(receipt)
          { id: receipt.id, event_id: receipt.trigger_event_id, kind: receipt.trigger_event.data["kind"],
            title: receipt.trigger_event.data["title"], body: receipt.trigger_event.data["body"],
            read_at: receipt.read_at, created_at: receipt.created_at }
        end

        def dynamic_authorize!
          authorize :agent_control, request.get? || action_name == "read" ? :show? : :create?, policy_class: Api::V1::AgentControlPolicy
        end
      end
    end
  end
end
