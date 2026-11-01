# frozen_string_literal: true

require "uri"

# This creates synthetic database rows and containers only in the named lab.
begin
  probe_database = URI.parse(ENV.fetch("DATABASE_URL", ""))
rescue URI::InvalidURIError
  abort "Probe requires the explicitly named disposable database"
end
unless %w[postgres postgresql].include?(probe_database.scheme) && probe_database.path == "/ac_runtime_probe_test" &&
       probe_database.query.nil? && probe_database.fragment.nil?
  abort "Probe requires the explicitly named disposable ac_runtime_probe_test database"
end

ENV['SKIP_COVERAGE'] = '1'
require_relative "../../test/test_helper"
require 'tmpdir'
require 'open3'
class AcRealDockerProbe < ActiveSupport::TestCase
  include AcSafetyFixtures
  setup do
    WebMock.allow_net_connect!
    @lab = Dir.mktmpdir('probe-', '/var/lib/agent-control-lab/runtime')
    @repo = File.join(@lab, 'repo')
    git('init', '-b', 'main', @repo)
    File.write(File.join(@repo, 'value.txt'), "base\n")
    git('-C', @repo, 'add', '.')
    git('-C', @repo, '-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-m', 'Base')
    @old = [ Rails.application.config.try(:ac_worktree_base_dir), Rails.application.config.try(:ac_evidence_base_dir), Rails.application.config.try(:ac_runtime_accounts) ]
    Rails.application.config.ac_worktree_base_dir = File.join(@lab, 'worktrees')
    Rails.application.config.ac_evidence_base_dir = File.join(@lab, 'evidence')
    FileUtils.mkdir_p(Rails.application.config.ac_evidence_base_dir)
    auth = File.join(@lab, 'auth.json')
    File.write(auth, '{}'); File.chmod(0o600, auth); File.chown(1000, 1000, auth)
    Rails.application.config.ac_runtime_accounts = { @credential.id.to_s => {
      'image' => File.read('/tmp/ac-synthetic-worker-image').strip,
      'argv' => [ 'claude', '--model', '{model}', '--effort', '{effort}', '{prompt}' ], 'auth_files' => { auth => '/home/agent/.claude.json' }, 'uid' => '1000:1000', 'network' => 'none', 'agent_type' => 'claude_code', 'auth_mode' => 'subscription',
      'attestation' => { 'status'=>'documented_supported', 'mode'=>'subscription', 'cli_adapter'=>'claude_code', 'credential_id'=>@credential.id.to_s, 'source'=>'https://example.invalid/probe', 'observed_at'=>1.minute.ago.iso8601, 'valid_until'=>1.hour.from_now.iso8601 },
      'cli_adapter' => 'claude_code' } }
    @context.update!(metadata: { 'git_repo_path' => @repo })
    @execution = AcAdmissionService.admit_execution!(task: @task, operation_id: SecureRandom.uuid, requested_by: 'probe', origin: 'probe', epoch: '1', execution_profile: @profiles.fetch('programmer'))[:execution]
    AcWorktreeManagerService.acquire_lease!(execution: @execution)
    @adapter = AcContainerRuntimeSupervisor.new
  end
  teardown do
    if @execution
      begin
        Docker::Container.get(@adapter.send(:identity, @execution)).delete(force: true)
      rescue Docker::Error::NotFoundError
        nil # Absence is expected when setup failed before dispatch.
      end
    end
    Rails.application.config.ac_worktree_base_dir, Rails.application.config.ac_evidence_base_dir, Rails.application.config.ac_runtime_accounts = @old if @old
    FileUtils.remove_entry(@lab) if @lab && File.directory?(@lab)
    WebMock.disable_net_connect!(allow_localhost: true)
  end
  test 'real duplicate dispatch then restart observer sees the committed artifact' do
    first = dispatch
    assert_equal first['runtime_id'], dispatch['runtime_id']
    @adapter = AcContainerRuntimeSupervisor.new
    done = terminal
    assert_equal 'completed', done['state']
    assert_equal 0, done['exit_code']
    assert done.dig('output', 'commit_sha').present?
    assert_includes File.read(File.join(@execution.worktree_path, 'value.txt')), 'worker-change'
    data = Docker::Container.get(first['process_handle']).json
    assert_equal '1000:1000', data.dig('Config', 'User')
    assert data.dig('HostConfig', 'ReadonlyRootfs')
    assert_equal 'none', data.dig('HostConfig', 'NetworkMode')
    assert_equal [ 'ALL' ], data.dig('HostConfig', 'CapDrop')
    assert_not(data.dig('Mounts').any? { |m| m['Source'].include?('docker.sock') })
  end
  test 'real exit 17 is retained and never restarted as success' do
    Rails.application.config.ac_runtime_accounts[@credential.id.to_s]['argv'].insert(1, '--probe-failure')
    dispatch
    done = terminal
    assert_equal 'failed', done['state']; assert_equal 17, done['exit_code']
    assert_equal done['runtime_id'], dispatch['runtime_id']
    assert_equal 'failed', dispatch['state']
  end
  test 'real running writer cancellation returns a terminal receipt' do
    Rails.application.config.ac_runtime_accounts[@credential.id.to_s]['argv'].insert(1, '--probe-cancel')
    first = dispatch
    assert_equal 'running', first['state']
    done = @adapter.cancel!(execution: @execution, operation_id: @execution.operation_id, epoch: '1')
    assert_equal 'failed', done['state']; assert done['exit_code'].positive?
  end
  test 'real reviewer mount rejects writes and evidence survives process exit' do
    base = @execution.metadata['base_commit_sha']
    artifact = { 'commit_sha' => base, 'base_commit_sha' => base, 'artifact_hash' => AcArtifactIdentity.digest(repo: @repo, commit: base, base: base) }
    @execution.update!(ac_execution_profile: @profiles.fetch('reviewer'), metadata: @execution.metadata.merge('source_artifact' => artifact))
    @execution.ac_capacity_grant.update!(ac_execution_profile: @profiles.fetch('reviewer'))
    dispatch
    done = terminal
    assert_equal 'completed', done['state']
    assert_equal 'approved', done.dig('output', 'review', 'verdict')
    assert_equal artifact['artifact_hash'], done.dig('output', 'review', 'artifact_hash')
    assert_not File.exist?(File.join(@execution.worktree_path, 'forbidden-write'))
  end
  def dispatch
    @adapter.dispatch!(execution: @execution, operation_id: @execution.operation_id, epoch: '1')
  end
  def terminal
    80.times do
      receipt = @adapter.status!(execution: @execution, operation_id: @execution.operation_id, epoch: '1')
      return receipt if %w[completed failed].include?(receipt['state'])
      sleep 0.25
    end
    flunk 'runtime did not reach terminal'
  end
  def git(*args)
    out, err, status = Open3.capture3('git', *args); raise err unless status.success?; out
  end
end
