# frozen_string_literal: true

class AcNotificationService
  class ConflictError < StandardError; end

  def self.record_operational!(record:, kind:, transition:)
    project = record.project
    title = {
      "plan_paused" => "Plano pausado", "plan_cancelled" => "Plano cancelado",
      "task_failed" => "Tarefa falhou", "task_needs_changes" => "Tarefa precisa de ajustes",
      "task_approved" => "Tarefa aprovada", "task_integrated" => "Tarefa integrada"
    }.fetch(kind)
    record!(company: record.company, project: project, actor: nil, recipient: project.owner,
      intent_id: "#{record.class.name}:#{record.id}:#{transition}", kind: kind,
      title: title, body: "#{title} (#{record.id}).")
  end

  def self.record!(company:, project:, actor:, recipient:, intent_id:, kind:, title:, body:)
    permitted = if actor
      project.accessible_by?(actor) && project.accessible_by?(recipient)
    else
      project.owner_id == recipient&.id
    end
    unless project.company_id == company.id && permitted && intent_id.to_s.match?(/\A[A-Za-z0-9_.:-]{1,128}\z/) &&
           kind.to_s.match?(/\A[a-z][a-z0-9_]{0,63}\z/) && title.is_a?(String) &&
           title.length.between?(1, 200) && body.is_a?(String) && body.length.between?(1, 2000)
      raise ArgumentError, "Notificação inválida"
    end

    dedup_key = "agent-control-notification:#{company.id}:#{Digest::SHA256.hexdigest(intent_id)}"
    data = { "kind" => kind, "title" => title, "body" => body, "recipient_id" => recipient.id }
    TriggerEvent.transaction do
      event = TriggerEvent.create_or_find_by!(dedup_key: dedup_key) do |row|
        row.company = company
        row.project = project
        row.actor = actor
        row.event_type = "agent_control.notification"
        row.source = "agent_control.notification"
        row.data = data
        row.relay_state = "pending"
        row.occurred_at = Time.current
      end
      unless event.company_id == company.id && event.project_id == project.id && event.actor_id == actor&.id && event.data == data
        raise ConflictError, "Intenção já usada para outra notificação"
      end

      AcNotificationReceipt.create_or_find_by!(trigger_event: event, user: recipient)
      event
    end
  end
end
