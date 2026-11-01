# frozen_string_literal: true

require "test_helper"
require "tmpdir"
require "open3"

class AcContainerRuntimeFake
  Container = Struct.new(:json)
  attr_reader :containers, :created, :started, :stopped, :specs

  def initialize
    @containers = {}
    @created = @started = @stopped = 0
    @specs = []
  end

  def resolve_container(name)
    containers[name]
  end

  def create_container(spec)
    @created += 1
    specs << spec
    containers[spec.fetch(:container_name)] = Container.new({ "Id" => SecureRandom.hex(32),
      "Config" => { "Labels" => spec.fetch(:labels), "Image" => spec.fetch(:image) },
      "State" => { "Status" => "created", "ExitCode" => 0 } })
  end

  def start_container(name)
    @started += 1
    containers.fetch(name).json["State"] = { "Status" => "running", "ExitCode" => 0 }
  end

  def stop_container(name, _timeout)
    @stopped += 1
    finish(name, 137)
  end

  def finish(name, code)
    containers.fetch(name).json["State"] = { "Status" => "exited", "ExitCode" => code }
  end

  def container_logs(_name)
    { stdout: "", stderr: "" }
  end
end

class AcContainerRuntimeSupervisorTest < ActiveSupport::TestCase
  include AcSafetyFixtures

  setup do
    @root = Dir.mktmpdir("ac-runtime-")
    @old_roots = [ Rails.application.config.try(:ac_worktree_base_dir), Rails.application.config.try(:ac_evidence_base_dir), Rails.application.config.try(:ac_runtime_accounts) ]
    @repo = File.join(@root, "repo")
    git("init", "-b", "main", @repo)
    File.write(File.join(@repo, "value.txt"), "base\n")
    git("-C", @repo, "add", ".")
    git("-C", @repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Base")
    Rails.application.config.ac_worktree_base_dir = File.join(@root, "clones")
    Rails.application.config.ac_evidence_base_dir = File.join(@root, "evidence")
    FileUtils.mkdir_p(Rails.application.config.ac_evidence_base_dir)
    @auth = File.join(@root, "auth.json")
    File.write(@auth, "synthetic fixture")
    Rails.application.config.ac_runtime_accounts = { @credential.id.to_s => {
      "image" => "sha256:#{'a' * 64}", "argv" => [ "claude", "--model", "{model}", "--effort", "{effort}", "{prompt}" ],
      "auth_files" => { @auth => "/home/agent/.claude.json" } } }
    @context.update!(metadata: { "git_repo_path" => @repo })
    @execution = AcAdmissionService.admit_execution!(task: @task, operation_id: SecureRandom.uuid,
      requested_by: "test", origin: "test", epoch: "1", execution_profile: @profiles.fetch("programmer"))[:execution]
    AcWorktreeManagerService.acquire_lease!(execution: @execution)
    @runtime = AcContainerRuntimeFake.new
    @adapter = AcContainerRuntimeSupervisor.new(runtime: @runtime)
  end

  teardown do
    Rails.application.config.ac_worktree_base_dir, Rails.application.config.ac_evidence_base_dir, Rails.application.config.ac_runtime_accounts = @old_roots
    FileUtils.remove_entry(@root) if @root && File.directory?(@root)
  end

  test "duplicate dispatch preserves one object and a real failure cannot become exit zero" do
    first = dispatch
    assert_equal "running", first["state"]
    assert_not @adapter.verify_receipt!(execution: @execution, receipt: first.merge("state" => "completed", "exit_code" => 0))
    assert_equal first["runtime_id"], dispatch["runtime_id"]
    assert_equal 1, @runtime.created
    assert_equal 1, @runtime.started
    @runtime.finish(first["process_handle"], 17)
    failed = dispatch
    assert_equal "failed", failed["state"]
    assert_equal 17, failed["exit_code"]
    assert_equal 1, @runtime.started
    assert @adapter.verify_receipt!(execution: @execution, receipt: failed)
  end

  test "runtime mounts only its clone evidence and selected auth without host authority" do
    dispatch
    spec = @runtime.specs.last
    assert_equal "none", spec[:host_config]["NetworkMode"]
    assert_equal "1000:1000", spec[:user]
    assert spec[:host_config]["ReadonlyRootfs"]
    assert_equal [ "ALL" ], spec[:host_config]["CapDrop"]
    assert_equal 3, spec[:host_config]["Binds"].size
    assert_includes spec[:host_config]["Binds"], "#{@auth}:/home/agent/.claude.json:ro"
    assert_not spec[:env_vars].any? { |value| value.match?(/DB_PASSWORD|TEMPORAL|DOCKER_HOST/) }
    assert_not spec[:host_config]["Tmpfs"].key?("/evidence")
  end

  test "cancellation observes terminal runtime proof before reporting exit" do
    first = dispatch
    receipt = @adapter.cancel!(execution: @execution, operation_id: @execution.operation_id, epoch: "1")
    assert_equal first["runtime_id"], receipt["runtime_id"]
    assert_equal "failed", receipt["state"]
    assert_equal 137, receipt["exit_code"]
    assert_equal 1, @runtime.stopped
  end

  test "a FIFO review cannot hang the host receipt reader" do
    @execution.update!(ac_execution_profile: @profiles.fetch("reviewer"), metadata: @execution.metadata.merge(
      "source_artifact" => { "commit_sha" => git("-C", @repo, "rev-parse", "HEAD").strip,
        "base_commit_sha" => @execution.metadata["base_commit_sha"], "artifact_hash" => "unused" }))
    @execution.ac_capacity_grant.update!(ac_execution_profile: @profiles.fetch("reviewer"))
    first = dispatch
    spec = @runtime.specs.last
    assert_includes spec[:host_config]["Binds"], "#{@execution.worktree_path}:/work:ro"
    evidence = spec[:host_config]["Binds"].find { |value| value.end_with?(":/evidence:rw") }.delete_suffix(":/evidence:rw")
    assert system("mkfifo", File.join(evidence, "review.json"))
    @runtime.finish(first["process_handle"], 0)
    assert_raises(AcRuntimeSupervisorService::UnverifiedReceiptError) do
      @adapter.status!(execution: @execution, operation_id: @execution.operation_id, epoch: "1")
    end
  end

  test "cancel before dispatch proves absence without inventing an exit code" do
    @task.cancel!
    receipt = @adapter.cancel!(execution: @execution, operation_id: @execution.operation_id, epoch: "1")
    assert_equal "not_started", receipt["state"]
    assert_nil receipt["exit_code"]
    assert @adapter.verify_receipt!(execution: @execution, receipt: receipt)
    assert_equal 0, @runtime.created
  end

  private

  def dispatch
    @adapter.dispatch!(execution: @execution, operation_id: @execution.operation_id, epoch: "1")
  end

  def git(*args)
    out, err, result = Open3.capture3("git", *args)
    raise err unless result.success?
    out
  end
end
