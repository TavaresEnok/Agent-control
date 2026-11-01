# frozen_string_literal: true

require "test_helper"
require "tmpdir"

module Activities
  module AgentControl
    class AcProcessExecutionReconciliationTest < ActiveSupport::TestCase
      setup do
        @company = create(:company)
        @user = create(:user, company: @company)
        @project = create(:project, company: @company, owner: @user)
        @context = AcWorkContext.create!(
          company: @company,
          project: @project,
          title: "Process Context",
          external_id: "ctx-proc-#{SecureRandom.hex(4)}"
        )
        @plan = AcPlan.create!(
          company: @company,
          project: @project,
          ac_work_context: @context,
          plan_key: "plan-proc-#{SecureRandom.hex(4)}",
          title: "Plan Process Test",
          objective: "Process Execution and Reconciliation",
          version: 1
        )
        @task = AcTask.create!(
          company: @company,
          project: @project,
          ac_plan: @plan,
          task_key: "task-proc-01",
          title: "Task Process",
          scope: "Process scope",
          position: 1,
          risk_class: :low,
          assigned_role: :programmer,
          state: :pending
        )
        @policy = AcPolicyRevision.create!(
          company: @company,
          revision_number: 1,
          content_hash: "hash_proc_1",
          content: {
            "model_chain" => ["gpt-5.2"],
            "effort_limits" => { "max" => "high" },
            "active_accounts" => [],
            "chain_rules" => []
          },
          validation_result: { "valid" => true, "errors" => [] },
          state: :published,
          apply_mode: :next_attempts
        )
        @credential = create(:agent_credential, user: @user, company: @company, agent_type: "codex")
        @profile = AcExecutionProfile.create!(
          company: @company,
          ac_policy_revision: @policy,
          profile_key: "prof-codex-proc",
          role: :programmer,
          cli_adapter: :codex_cli,
          model_id: "gpt-5.2",
          effort_level: :medium,
          agent_credential: @credential,
          chain_position: 1,
          state: :active
        )
        @worktree_dir = Dir.mktmpdir("ac_proc_wt")

        admission = AcAdmissionService.admit_execution!(
          task: @task,
          operation_id: "op-proc-#{SecureRandom.hex(4)}",
          requested_by: "system_test",
          execution_profile: @profile,
          epoch: "1"
        )
        @execution = admission[:execution]
        @execution.update!(
          worktree_path: @worktree_dir,
          worktree_lease_token: "lease-token-123"
        )

        @dispatch_activity = AcDispatchExecutionActivity.new
        @reconcile_activity = AcReconcileExecutionActivity.new
      end

      teardown do
        FileUtils.remove_entry(@worktree_dir) if @worktree_dir && Dir.exist?(@worktree_dir)
      end

      test "DEF-01: executes normal command, captures output and settles with exit code 0" do
        @execution.update!(metadata: { "command" => "echo 'Agent Control autonomous execution test'" })

        disp_res = @dispatch_activity.execute({
          execution_id: @execution.id,
          epoch: "1"
        })
        assert disp_res["process_handle"].start_with?("pid-")

        rec_res = @reconcile_activity.execute({
          execution_id: @execution.id,
          epoch: "1"
        })

        assert_equal 0, rec_res["exit_code"]
        assert_equal "completed", rec_res["state"]
        @execution.reload
        assert_includes @execution.output_payload["stdout"], "Agent Control autonomous execution test"
        assert_equal "review", @task.reload.state
      end

      test "DEF-01: captures real non-zero exit code and marks task as failed" do
        @execution.update!(metadata: { "command" => "bash -c 'echo \"Fatal failure occurred\" >&2; exit 42'" })

        @dispatch_activity.execute({
          execution_id: @execution.id,
          epoch: "1"
        })

        rec_res = @reconcile_activity.execute({
          execution_id: @execution.id,
          epoch: "1"
        })

        assert_equal 42, rec_res["exit_code"], "Código de saída real deve ser capturado sem falso zero"
        assert_equal "failed", rec_res["state"]
        @execution.reload
        assert_includes @execution.output_payload["stdout"], "Fatal failure occurred"
        assert_equal "failed", @task.reload.state
      end

      test "DEF-01: handles large output (>64KB) without pipe deadlock" do
        # Gera 100.000 caracteres no stdout via Ruby da imagem
        @execution.update!(metadata: { "command" => "ruby -e 'puts \"A\" * 100000'" })

        @dispatch_activity.execute({
          execution_id: @execution.id,
          epoch: "1"
        })

        rec_res = @reconcile_activity.execute({
          execution_id: @execution.id,
          epoch: "1"
        })

        assert_equal 0, rec_res["exit_code"], "Processo com mais de 64KB não deve travar no pipe buffer"
        assert_equal "completed", rec_res["state"]
      end

      test "DEF-01: enforces timeout on long running command and terminates process with exit 124" do
        @execution.update!(metadata: {
          "command" => "sleep 10",
          "timeout_seconds" => 1
        })

        @dispatch_activity.execute({
          execution_id: @execution.id,
          epoch: "1"
        })

        pid = @execution.reload.metadata["pid"].to_i
        assert pid > 0

        rec_res = @reconcile_activity.execute({
          execution_id: @execution.id,
          epoch: "1"
        })

        assert_equal 124, rec_res["exit_code"], "Timeout deve retornar exit 124"
        assert_equal "failed", rec_res["state"]
        assert_equal "failed", @task.reload.state

        # Confirma que o processo foi realmente morto
        sleep 0.1
        assert_raises(Errno::ESRCH) do
          Process.kill(0, pid)
        end
      end

      test "DEF-01: release_lease! terminates active process before destroying directory" do
        @execution.update!(metadata: { "command" => "sleep 30" })

        @dispatch_activity.execute({
          execution_id: @execution.id,
          epoch: "1"
        })

        pid = @execution.reload.metadata["pid"].to_i
        assert pid > 0
        # Confirma que processo está vivo
        assert_nothing_raised do
          Process.kill(0, pid)
        end

        # Libera a lease da worktree
        AcWorktreeManagerService.release_lease!(execution: @execution)

        # Processo deve ter sido encerrado
        sleep 0.1
        assert_raises(Errno::ESRCH) do
          Process.kill(0, pid)
        end
        assert_nil @execution.reload.worktree_lease_token
      end
    end
  end
end
