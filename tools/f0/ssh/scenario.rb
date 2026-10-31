# frozen_string_literal: true
require_relative "boot"
require "base64"
require "digest"
require "fileutils"

def check(value, message)
  raise message unless value
end

def save(name, value)
  File.write("/evidence/#{name}.json", JSON.pretty_generate(value) + "\n")
end

config = JSON.parse(File.read("/lab/config.json"), symbolize_names: true)
factory = -> { Coder::SshRunner.new(nil, transport: AgentControl::OpenSshTransport.new(**config)) }
runner = factory.call
remote = ->(command, **opts) {
  result = runner.exec(workspace_name: "disposable", command: command, **opts)
  check(result[:exit_code] == 0 && !result[:truncated], result.inspect)
  result[:stdout]
}

# A mismatched fingerprint is rejected locally, before even spawning SSH.
begin
  AgentControl::OpenSshTransport.new(**config.merge(fingerprint: "SHA256:wrong"))
  raise "wrong fingerprint accepted"
rescue ArgumentError => e
  save("negative-fingerprint", error: e.message)
end
# A valid pin for a DIFFERENT key passes local validation, but the actual
# server must reject it before the requested write. No ssh-keyscan/TOFU.
wrong = JSON.parse(File.read("/lab/wrong-config.json"), symbolize_names: true)
denied = Coder::SshRunner.new(nil, transport: AgentControl::OpenSshTransport.new(**wrong)).exec(
  workspace_name: "disposable", command: "touch /lab/home/forbidden")
save("negative-server-pin", denied)
check(denied[:exit_code] == 255, "server pin was not denied")
remote.call("test ! -e /lab/home/forbidden")
quoted = %q(printf '%s' 'spaces and "double" and '\''single'\''')
check(remote.call(quoted) == %q(spaces and "double" and 'single'), "command quoting changed")

# Synthetic central-only marker, not a real credential. No marker in argv,
# stdin, config, Git bundle or remote job command.
ENV["F0_SYNTHETIC_AI_SECRET"] = "central-only-#{SecureRandom.hex(24)}"
# Every check must pass before the final receipt can assert absence.
remote.call(%q(test -z "${F0_SYNTHETIC_AI_SECRET:-}" && test -z "${SSH_AUTH_SOCK:-}" && test ! -d /root/.codex && test ! -d /lab/home/.codex))
encoded = remote.call("set -eu; git -C /lab/home/source bundle create /lab/home/source.bundle --all; base64 /lab/home/source.bundle")
File.binwrite("/lab/source.bundle", Base64.decode64(encoded))
git_env = { "PATH" => "/usr/bin:/bin", "HOME" => "/lab", "GIT_CONFIG_NOSYSTEM" => "1", "GIT_CONFIG_GLOBAL" => "/dev/null" }
git = ->(*args) {
  out, err, status = Open3.capture3(git_env, "git", *args, unsetenv_others: true)
  check(status.success?, err)
  out.strip
}
git.call("clone", "/lab/source.bundle", "/lab/materialized")
initial_sha = git.call("-C", "/lab/materialized", "rev-parse", "HEAD")
check(remote.call("git -C /lab/home/source rev-parse HEAD").strip == initial_sha, "source SHA differs")
File.write("/lab/materialized/value.txt", "after\n")
git.call("-C", "/lab/materialized", "add", "value.txt")
git.call("-C", "/lab/materialized", "-c", "user.name=Central fixture", "-c", "user.email=central@invalid", "commit", "-m", "Laboratory change")
sha = git.call("-C", "/lab/materialized", "rev-parse", "HEAD")
git.call("-C", "/lab/materialized", "bundle", "create", "/lab/change.bundle", "--all")
bundle = File.binread("/lab/change.bundle")
digest = Digest::SHA256.hexdigest(bundle)
remote.call("set -eu; base64 -d > /lab/home/#{digest}.bundle; echo '#{digest}  /lab/home/#{digest}.bundle' | sha256sum -c -", stdin_data: Base64.strict_encode64(bundle))
command = <<~SH
  set -eu
  cd /lab/home/source
  git fetch /lab/home/#{digest}.bundle HEAD
  git checkout --detach #{sha}
  echo execution >> /lab/home/execution-counter
  sleep 2
  sh test.sh
  observed=$(git rev-parse HEAD)
  test "$observed" = #{sha}
  printf '\n---aixle_job_result---\nobserved_sha=%s\nartifact_sha256=#{digest}\n' "$observed"
SH
handle = runner.exec_detached(workspace_name: "disposable", command: command)
save("job", handle)
# Every poll uses a new transport and a new OpenSSH process; never reissue.
deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 45
loop do
  status = factory.call.job_status(workspace_name: "disposable", job_id: handle[:job_id])
  save("status", status)
  if status[:state] != "running"
    check(status[:state] == "exited" && status[:exit_code] == 0, status.inspect)
    check(status.dig(:result, "observed_sha") == sha, "remote SHA differs: #{status.inspect}")
    check(status.dig(:result, "artifact_sha256") == digest, "remote artifact digest differs")
    break
  end
  check(Process.clock_gettime(Process::CLOCK_MONOTONIC) < deadline, "job poll deadline")
  sleep 0.2
end
check(remote.call("wc -l < /lab/home/execution-counter").strip == "1", "command repeated")
save("result", status: "PASS", initial_sha: initial_sha, central_sha: sha,
  artifact_sha256: digest, job_id: handle[:job_id], executions: 1,
  synthetic_secret_absent: true, forced_channel_drop: "NOT RUN",
  boundary: "real SshRunner/OpenSSH/journal; standalone Settings; no CoderPrepareRepo/MCP/SQL/AI authentication")
FileUtils.cp("/lab/change.bundle", "/evidence/change.bundle")
FileUtils.cp("/lab/source.bundle", "/evidence/source.bundle")
