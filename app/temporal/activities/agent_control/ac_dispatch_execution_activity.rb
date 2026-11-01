# frozen_string_literal: true

require "shellwords"

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
          log_path = File.join(worktree, ".ac_execution.log")
          exit_path = File.join(worktree, ".ac_execution.exit")

          # Envelopa execução shell para desacoplar streams e capturar código de retorno real
          # Cria grupo de processos próprio (pgroup: true) para encerramento seguro e isolado
          wrapped_cmd = "( #{cmd} ) > #{Shellwords.escape(log_path)} 2>&1; echo $? > #{Shellwords.escape(exit_path)}"
          pid = Process.spawn("bash", "-c", wrapped_cmd, chdir: worktree, pgroup: true)
          Process.detach(pid)
          handle = "pid-#{pid}"

          execution.update!(
            process_handle: handle,
            metadata: (execution.metadata || {}).merge(
              "pid" => pid,
              "pgid" => pid,
              "command" => cmd,
              "log_path" => log_path,
              "exit_path" => exit_path
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
