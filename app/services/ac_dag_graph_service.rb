# frozen_string_literal: true

class AcDagGraphService
  class << self
    def build_graph(plan:)
      tasks = plan.ac_tasks.order(:position, :id).to_a
      task_map = tasks.index_by(&:task_key)

      nodes = tasks.map do |task|
        {
          id: task.id,
          task_key: task.task_key,
          title: task.title,
          scope: task.scope,
          state: task.state,
          assigned_role: task.assigned_role,
          risk_class: task.risk_class,
          position: task.position,
          attempt_count: task.attempt_count,
          max_attempts: AcTask::MAX_ATTEMPT_COUNT,
          approved_commit_sha: task.approved_commit_sha,
          depends_on: task.depends_on || [],
          flags: {
            waiting_dependencies: task.state == "waiting_dependencies",
            needs_changes: task.state == "needs_changes",
            review: task.state == "review",
            integrated: task.state == "integrated",
            terminal: %w[integrated failed cancelled].include?(task.state)
          }
        }
      end

      edges = []
      tasks.each do |task|
        (task.depends_on || []).each do |dep_key|
          parent = task_map[dep_key]
          if parent
            edges << {
              id: "#{parent.id}->#{task.id}",
              source: parent.id,
              source_key: parent.task_key,
              target: task.id,
              target_key: task.task_key,
              fulfilled: parent.state == "integrated"
            }
          end
        end
      end

      summary = {
        total_tasks: tasks.size,
        pending: tasks.count { |t| t.state == "pending" },
        running: tasks.count { |t| t.state == "running" },
        review: tasks.count { |t| t.state == "review" },
        integrated: tasks.count { |t| t.state == "integrated" },
        waiting_dependencies: tasks.count { |t| t.state == "waiting_dependencies" },
        needs_changes: tasks.count { |t| t.state == "needs_changes" },
        all_completed: plan.all_tasks_completed?,
        plan_state: plan.state,
        paused: plan.paused?
      }

      {
        plan: {
          id: plan.id,
          plan_key: plan.plan_key,
          title: plan.title,
          objective: plan.objective,
          version: plan.version,
          project_id: plan.project_id,
          state: plan.state,
          paused: plan.paused?
        },
        nodes: nodes,
        edges: edges,
        summary: summary,
        projection_timestamp: Time.current.iso8601
      }
    end
  end
end
