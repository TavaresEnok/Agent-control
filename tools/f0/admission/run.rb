# frozen_string_literal: true

require_relative "boot"
require "minitest"
require "json"
require "digest"
require "fileutils"

abort "Run the complete SQL suite without filters" unless ARGV.empty?
report = { scope: "F0/G0 SQL only; mocked Temporal/runtime and isolated capacity boundary; G0-E3/T07 pending",
  shared_capacity: "not tested; see tools/validation/shared_broker_probe.rb for the separate TLS broker probe",
  capacity_boundary: "lab fakes permit only an isolated schema without Agent Control tables; grant query represents zero AC fixtures and does not test AC SQL",
  status: "not_run",
  ruby: RUBY_VERSION, imported_sha256: AdmissionLab::IMPORTS.to_h { |p| [ p, Digest::SHA256.file(File.join(AdmissionLab::ROOT, p)).hexdigest ] } }
report[:migration_sha256] = AdmissionLab::MIGRATIONS.to_h do |name|
  path = "db/migrate/#{name}.rb"
  [ path, Digest::SHA256.file(File.join(AdmissionLab::ROOT, path)).hexdigest ]
end
report[:gems] = Gem.loaded_specs.transform_values { |spec| spec.version.to_s }
gemfile = Bundler.default_gemfile.to_s
report[:bundle_gemfile_sha256] = Digest::SHA256.file(gemfile).hexdigest
lockfile = "#{gemfile}.lock"
report[:bundle_lock_sha256] = Digest::SHA256.file(lockfile).hexdigest if File.file?(lockfile)
report[:harness_sha256] = (Dir[File.join(__dir__, "*.rb")] +
  Dir[File.join(AdmissionLab::ROOT, "tools/f0/admission/tests/*.rb")] +
  [ File.join(__dir__, "Gemfile") ]).sort.to_h do |path|
  [ path.delete_prefix(AdmissionLab::ROOT + "/"), Digest::SHA256.file(path).hexdigest ]
end
ok = false
begin
  AdmissionLab.prepare!
  require File.join(AdmissionLab::ROOT, "tools/f0/admission/tests/sql_test")
  ok = Minitest.run([])
  report[:status] = ok ? "passed" : "failed"
rescue StandardError => e
  report[:status] = "error"
  report[:error_class] = e.class.name # Never serialize connection arguments/secrets.
  warn "SQL harness failed: #{e.class}"
ensure
  report[:gems] = Gem.loaded_specs.transform_values { |spec| spec.version.to_s }
  # Capture a small sanitized receipt BEFORE dropping the disposable schema.
  directory = File.join(AdmissionLab::ROOT, "docs/validation/artifacts/admission")
  FileUtils.mkdir_p(directory)
  path = File.join(directory, "sql-#{Time.now.utc.strftime('%Y%m%dT%H%M%S')}-#{Process.pid}.json")
  File.write(path, JSON.pretty_generate(report) + "\n")
  begin
    AdmissionLab.cleanup!
  rescue StandardError => e
    ok = false
    report[:cleanup_error_class] = e.class.name
    report[:status] = "error"
    File.write(path, JSON.pretty_generate(report) + "\n")
  end
end
exit(ok ? 0 : 1)
