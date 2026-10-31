# frozen_string_literal: true

require_relative "boot"
client = IntegratedLab.connection!
Temporalio::Worker.new(client: client, task_queue: ENV.fetch("F0_INTEGRATED_NAMESPACE"),
  workflows: [Workflows::IntegratedIdleWorkflow], activities: [],
  graceful_shutdown_period: 1).run(shutdown_signals: ["SIGTERM", "SIGINT"])
