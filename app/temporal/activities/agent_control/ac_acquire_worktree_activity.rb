# frozen_string_literal: true

module Activities
  module AgentControl
    # Atividade para isolamento de worktree e alocação de escritor único (§11.3.2)
    class AcAcquireWorktreeActivity < Activities::Base
      activity_name "ac_acquire_worktree_activity"

      def run(input)
        execution_id = input.execution_id
        execution = AcExecution.find(execution_id)

        token = AcWorktreeManagerService.acquire_lease!(execution: execution)
        execution.reload

        {
          "lease_token" => token,
          "worktree_path" => execution.worktree_path,
          "execution_id" => execution.id
        }
      end
    end
  end
end
