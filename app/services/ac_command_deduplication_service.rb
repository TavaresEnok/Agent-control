# frozen_string_literal: true

class AcCommandDeduplicationService
  class DuplicateProcessingError < StandardError; end

  class << self
    def execute_idempotent!(intent_id:, company:, command_type:, payload: {}, user: nil)
      raise ArgumentError, "intent_id is required" if intent_id.to_s.strip.empty?

      # Busca ou inicia o registro do comando do cliente com bloqueio transacional
      command = nil

      ActiveRecord::Base.transaction do
        command = AcClientCommand.lock.find_by(intent_id: intent_id)

        if command
          if command.processed?
            # Já concluído anteriormente: retorna resposta deduplicada (§11.2, §11.3)
            return {
              deduplicated: true,
              status: "processed",
              intent_id: command.intent_id,
              result: command.result
            }
          elsif command.state == "processing"
            # Concorrência simultânea com o mesmo intent_id
            raise DuplicateProcessingError, "Command with intent_id '#{intent_id}' is currently processing"
          else
            command.mark_processing!
          end
        else
          command = AcClientCommand.create!(
            company: company,
            user: user,
            intent_id: intent_id,
            command_type: command_type.to_s,
            payload: payload || {},
            state: "processing"
          )
        end
      end

      # Executa o bloco de lógica
      begin
        result = yield(command)
        command.mark_processed!(result_payload: result)

        {
          deduplicated: false,
          status: "processed",
          intent_id: command.intent_id,
          result: command.result
        }
      rescue StandardError => e
        command.mark_failed!(error_message: e.message)
        raise e
      end
    end
  end
end
