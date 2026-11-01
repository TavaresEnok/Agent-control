# frozen_string_literal: true

# Write a failure receipt even if Bundler/guard/boot fails. No Rails or .env boot.
# Avoid activating default gems (especially JSON) before the frozen Bundler boot.
root = File.expand_path("../../..", __dir__)
directory = File.join(root, "docs/validation/artifacts/integrated", "run-#{Time.now.utc.strftime('%Y%m%dT%H%M%S')}-#{Random.urandom(8).unpack1('H*')}")
Dir.mkdir(directory, 0o700)
report = { status: "FAIL", gate: "G0 PENDENTE", physical_execution: "attempted", errors: [] }
scenario = nil
begin
  raise "Usage: run.rb CLI EXPECTED_CLI_SHA256 /lab-runtime" unless ARGV.size == 3
  require_relative "scenario"
  paths = AdmissionLab::IMPORTS + AdmissionLab::MIGRATIONS.map { |n| "db/migrate/#{n}.rb" } +
    %w[app/services/temporal_service.rb app/temporal/workflows/base.rb app/temporal/temporal_input.rb UPSTREAM.json] +
    Dir.glob("{tools,test}/f0/{integrated,admission}/**/*", base: root).select { |p| File.file?(File.join(root, p)) }
  IntegratedLab.write(File.join(directory, "manifest.json"), sources_sha256: paths.uniq.sort.to_h { |p| [ p, Digest::SHA256.file(File.join(root, p)).hexdigest ] },
    lock_origin: "docs/validation/artifacts/admission-lote2-host-20261031/Gemfile.lock.txt",
    inherited_database_identity: AdmissionLab::IDENTITY, socket: AdmissionLab::SOCKET,
    scope: "F0/G0 integrated lab only; synthetic peripheral models/auth/registry; G0 PENDENTE")
  scenario = IntegratedScenario.new(directory, ARGV[2], ARGV[0], ARGV[1])
  scenario.run
  report[:status] = "EVIDENCE_CAPTURED_PENDING_CLEANUP"
rescue StandardError, LoadError, SystemExit => e
  report[:errors] << { class: e.class.name, message: e.message }
ensure
  require "json"
  require "digest"
  # Durable primary receipt before destructive cleanup, including on failure.
  File.open(File.join(directory, "result.json"), "w", 0o600) do |file|
    file.write(JSON.pretty_generate(report) + "\n"); file.flush; file.fsync
  end
  capture_hashes = lambda do
    Dir.glob(File.join(directory, "**/*")).select { |p| File.file?(p) && File.basename(p) != "sha256.json" }.sort.to_h do |p|
      [ p.delete_prefix(directory + "/"), Digest::SHA256.file(p).hexdigest ]
    end
  end
  File.write(File.join(directory, "sha256-before-cleanup.json"), JSON.pretty_generate(capture_hashes.call) + "\n")
  begin
    scenario&.cleanup
    report[:cleanup_status] = "completed"
    report[:status] = "PASS" if report[:status] == "EVIDENCE_CAPTURED_PENDING_CLEANUP"
  rescue StandardError => e
    report[:cleanup_status] = "failed"
    report[:status] = "FAIL"
    report[:errors] << { cleanup: e.class.name, message: e.message }
  end
  File.write(File.join(directory, "result.json"), JSON.pretty_generate(report) + "\n")
  File.write(File.join(directory, "sha256.json"), JSON.pretty_generate(capture_hashes.call) + "\n")
end
puts "#{report[:status]}: integrated candidate; G0 PENDENTE; receipts #{directory}"
exit(report[:status] == "PASS" ? 0 : 1)
