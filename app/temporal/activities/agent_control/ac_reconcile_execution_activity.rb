# frozen_string_literal: true

module Activities
  module AgentControl
    # Atividade para reconciliação do término de processo com validação de época (§11.3)
    class AcReconcileExecutionActivity < Activities::Base
      activity_name "ac_reconcile_execution_activity"

      def run(input)
        execution_id = input.execution_id
        reported_epoch = input.epoch
        exit_code = input.exit_code || 0
        output = input.output || {}
        error = input.error || {}

        execution = AcExecution.find(execution_id)

        # Se um processo físico foi lançado e nenhum exit_code explícito foi fornecido (§11.3, [BUG-P0-02], DEF-01)
        if execution.metadata&.dig("pid").present? && input.exit_code.nil?
          pid = execution.metadata["pid"].to_i
          exit_path = execution.metadata["exit_path"]
          log_path = execution.metadata["log_path"]
          timeout_seconds = (execution.metadata["timeout_seconds"] || 15).to_i
          deadline = Time.current + timeout_seconds.seconds

          # Aguarda término do subprocesso ou gravação do arquivo de status
          while Time.current < deadline
            break if exit_path.present? && File.exist?(exit_path)

            begin
              Process.kill(0, pid)
              sleep 0.05
            rescue Errno::ESRCH
              break
            rescue Errno::EPERM
              sleep 0.05
            end
          end

          if exit_path.present? && File.exist?(exit_path)
            raw_exit = File.read(exit_path).strip
            exit_code = raw_exit.present? ? raw_exit.to_i : 0
          else
            still_alive = begin
              Process.kill(0, pid)
              true
            rescue Errno::ESRCH
              false
            rescue Errno::EPERM
              true
            end

            if still_alive
              begin
                Process.kill("-TERM", pid) rescue (Process.kill("TERM", pid) rescue nil)
                sleep 0.1
                Process.kill("-KILL", pid) rescue (Process.kill("KILL", pid) rescue nil)
              rescue Errno::ESRCH, Errno::EPERM
                # já finalizado
              end
              exit_code = 124
              error = error.merge("message" => "Execution timed out after #{timeout_seconds}s")
            else
              exit_code = 137
              error = error.merge("message" => "Process terminated abruptly without exit status")
            end
          end

          if log_path.present? && File.exist?(log_path)
            output = output.merge("stdout" => File.read(log_path).last(65536))
          end
        end

        # Reconciliação com validação estrita de época (§11.3)
        execution.reconcile_outcome!(
          exit_code: exit_code,
          reported_epoch: reported_epoch,
          output: output,
          error: error
        )

        task = execution.ac_task
        if exit_code == 0
          task.update!(state: :review) if task.respond_to?(:state) && task.state != "completed"
        else
          task.update!(state: :failed) if task.respond_to?(:state)
        end

        {
          "execution_id" => execution.id,
          "state" => execution.state,
          "exit_code" => execution.exit_code,
          "finished_at" => execution.finished_at&.iso8601
        }
      end
    end
  end
end
