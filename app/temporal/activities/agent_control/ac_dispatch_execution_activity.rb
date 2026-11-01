# frozen_string_literal: true

module Activities
  module AgentControl
    # Atividade para despacho idempotente do processo e registro de supervisor (§11.3, §11.3.1)
    class AcDispatchExecutionActivity < Activities::Base
      activity_name "ac_dispatch_execution_activity"

      def run(input)
        execution_id = input.execution_id
        reported_epoch = input.epoch
        execution = AcExecution.find_by(id: execution_id)

        # Valida autoridade de execução — bloqueia bypass (§10.2.1)
        AcAdmissionService.validate_execution_authority!(
          execution_id: execution_id,
          operation_id: execution&.operation_id,
          reported_epoch: reported_epoch
        )

        # Idempotência de processo (§11.3.1): se já possui handle registrado, reutiliza
        handle = execution.process_handle.presence || "ac-proc-#{execution.id}-ep#{reported_epoch}-#{SecureRandom.hex(4)}"

        # Execução física real quando houver comando configurado (§11.3.1, [BUG-P0-02])
        task = execution.ac_task
        worktree = execution.worktree_path
        cmd = execution.metadata&.dig("command") || task&.inputs&.dig("command")

        if cmd.present? && worktree.present? && Dir.exist?(worktree)
          stdin, stdout, stderr, wait_thr = Open3.popen3(cmd, chdir: worktree)
          stdin.close
          pid = wait_thr.pid
          handle = "pid-#{pid}"

          execution.update!(
            process_handle: handle,
            metadata: (execution.metadata || {}).merge(
              "pid" => pid,
              "command" => cmd
            )
          )
        end

        execution.mark_running!(handle: handle) unless execution.state_running?

        {
          "execution_id" => execution.id,
          "process_handle" => execution.process_handle,
          "state" => execution.state,
          "started_at" => execution.started_at&.iso8601
        }
      end
    end
  end
end
