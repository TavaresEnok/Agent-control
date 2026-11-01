# frozen_string_literal: true

# Standalone Ruby: no Rails, credentials, database, gems or actual CLI required.
require_relative "../../../../app/services/agent_control/integration_eligibility"

guard = AgentControl::IntegrationEligibility
eligible = {
  status: "documented_supported", provider: "codex", mode: "local_private",
  authentication: "codex_managed_chatgpt", mitm: false, paid_api: false,
  plan: "SYNTHETIC eligible plan", holder: "SYNTHETIC owner",
  cli_version: "fixture-version", source: "https://learn.chatgpt.com/docs/app-server",
  assessed_at: "2026-10-31"
}.freeze
quota = { exhausted: false, remaining: 7, evidence: "SYNTHETIC" }.freeze
before = Marshal.dump(quota)
calls = []
spy = -> { calls << :executed; :fixture_result }
negative = %w[unsupported unsupported_for_mode requires_clarification not_assessed unknown].map { |s| eligible.merge(status: s) }
negative += [ nil, {}, eligible.merge(status: nil) ]
%w[grok claude antigravity gemini].each { |p| negative << eligible.merge(provider: p) }
negative += [ eligible.merge(mode: "hosted_private"), eligible.merge(authentication: "api_key"),
             eligible.merge(authentication: "copied_oauth"), eligible.merge(mitm: true),
             eligible.merge(mitm: nil), eligible.merge(paid_api: true), eligible.merge(paid_api: nil) ]
guard::REQUIRED_EVIDENCE.each { |k| negative << eligible.merge(k => " ") }
negative.each do |profile|
  begin
    guard.call(profile: profile, executor: spy)
    raise "ineligible profile reached executor"
  rescue guard::Rejected => e
    raise "missing visible reason" unless e.message.start_with?("integration_ineligible:")
  end
  raise "CLI/fallback effect occurred" unless calls.empty?
  raise "quota changed" unless before == Marshal.dump(quota)
end
raise "positive result lost" unless guard.call(profile: eligible, executor: spy) == :fixture_result
raise "positive called more than once" unless calls == [ :executed ]
raise "positive quota changed" unless before == Marshal.dump(quota)
# Executor failures propagate; the guard cannot turn them into quota exhaustion or retry.
begin
  guard.call(profile: eligible, executor: -> { raise IOError, "synthetic failure" })
  raise "executor error swallowed"
rescue IOError
  raise "error mutated quota" unless before == Marshal.dump(quota)
end
puts "PASS: #{negative.length} refusals before spy; one positive; error propagation; quota unchanged (fixture only)"
