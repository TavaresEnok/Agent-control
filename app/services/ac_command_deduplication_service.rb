# frozen_string_literal: true

class AcCommandDeduplicationService
  class DuplicateProcessingError < StandardError; end
  class IntentMismatchError < StandardError; end

  class << self
    def execute_idempotent!(intent_id:, company:, command_type:, payload: {}, user: nil)
      raise ArgumentError, "intent_id is required" if intent_id.to_s.strip.empty?

      payload = (payload || {}).deep_stringify_keys
      AcClientCommand.transaction do
        command = AcClientCommand.lock.find_by(company: company, intent_id: intent_id)
        if command
          unless command.user_id == user&.id && command.command_type == command_type.to_s && command.payload == payload
            raise IntentMismatchError, "Intent already belongs to a different command"
          end
          unless command.processed?
            raise DuplicateProcessingError, "Command outcome is unresolved"
          end

          next { deduplicated: true, status: "processed", intent_id: command.intent_id, result: command.result }
        end

        command = AcClientCommand.create!(company: company, user: user, intent_id: intent_id,
                                          command_type: command_type.to_s, payload: payload, state: "processing")
        result = yield(command)
        command.mark_processed!(result_payload: result)
        { deduplicated: false, status: "processed", intent_id: command.intent_id, result: command.result }
      end
    rescue ActiveRecord::RecordNotUnique
      raise unless AcClientCommand.exists?(company: company, intent_id: intent_id)

      retry
    end
  end
end
