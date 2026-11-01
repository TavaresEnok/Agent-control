# frozen_string_literal: true

require_relative "boot"
address, namespace, queue = ARGV
raise "loopback only" unless /\A127\.0\.0\.1:\d+\z/.match?(address.to_s)
client = Temporalio::Client.connect(address, namespace, data_converter: TemporalService.data_converter)
Temporalio::Worker.new(client: client, task_queue: queue,
  workflows: [ Workflows::G0ProbeWorkflow ], activities: [ G0ProbeActivity.new ],
  graceful_shutdown_period: 1).run(shutdown_signals: [ "SIGTERM", "SIGINT" ])
