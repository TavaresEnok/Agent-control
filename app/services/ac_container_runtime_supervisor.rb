# frozen_string_literal: true

require "digest"
require "open3"
require "fileutils"
require "find"

# An execution owns a named runtime object before it starts. Reconciliation uses
# that identity, not a PID; an uncertain runtime response never permits a restart.
class AcContainerRuntimeSupervisor
  def initialize(runtime: nil)
    @runtime = runtime || ContainerRuntime.build("docker")
  end

  def dispatch!(execution:, operation_id:, epoch:)
    AcExecutionFence.synchronize(execution) do
      unless %w[granted preparing running].include?(execution.state.to_s)
        raise AcRuntimeSupervisorService::UnverifiedReceiptError, "Estado da execução não permite despacho"
      end
      AcAdmissionService.validate_execution_authority!(execution_id: execution.id, operation_id: operation_id, reported_epoch: epoch)
      config = account_config!(execution)
      profile = execution.ac_execution_profile
      credential = profile.agent_credential
      unless credential && credential.company_id == execution.company_id && credential.active? && profile.eligible?
        raise AcRuntimeSupervisorService::UnavailableError, "Perfil ou credencial não é elegível"
      end
      begin
        AcRuntimeConfigurationLoader.validate_account!(execution.ac_execution_profile.agent_credential_id.to_s, config,
          networks: Array(Rails.application.config.try(:ac_worker_networks)))
      rescue AcRuntimeConfigurationLoader::InvalidConfiguration
        raise AcRuntimeSupervisorService::UnavailableError, "Configuração da conta não está pronta"
      end
      name = identity(execution)
      container = lookup(name)
      unless container
        begin
          container = @runtime.create_container(spec(execution, config))
        rescue StandardError
          container = lookup(name)
          raise unless container
        end
      end
      verify_container!(execution, container)
      # Docker's created state is pre-start; exited is a retained terminal result.
      if container.json.dig("State", "Status") == "created"
        AcAdmissionService.validate_execution_authority!(execution_id: execution.id,
          operation_id: operation_id, reported_epoch: epoch)
        @runtime.start_container(name)
      end
      status!(execution: execution, operation_id: operation_id, epoch: epoch)
    end
  end

  def cancel!(execution:, operation_id:, epoch:)
    container = lookup(identity(execution))
    return absence_receipt(execution) if container.nil? && fenced?(execution)
    raise AcRuntimeSupervisorService::UnverifiedReceiptError, "Objeto de runtime não localizado para cancelar" unless container

    verify_container!(execution, container)
    @runtime.stop_container(identity(execution), 10) unless %w[exited dead].include?(container.json.dig("State", "Status"))
    status!(execution: execution, operation_id: operation_id, epoch: epoch)
  end

  def status!(execution:, operation_id:, epoch:)
    container = lookup(identity(execution))
    return absence_receipt(execution) if container.nil? && fenced?(execution)
    raise AcRuntimeSupervisorService::UnverifiedReceiptError, "Runtime sem recibo da operação" unless container

    verify_container!(execution, container)
    data = container.json
    state = data.fetch("State")
    terminal = %w[exited dead].include?(state["Status"])
    code = terminal ? state["ExitCode"] : nil
    receipt = {
      "operation_id" => operation_id, "epoch" => epoch.to_s,
      "process_handle" => identity(execution), "account_id" => execution.ac_execution_profile.agent_credential_id,
      "model" => execution.ac_execution_profile.model_id, "effort" => execution.ac_execution_profile.effort_level.to_s,
      "state" => terminal ? (code == 0 ? "completed" : "failed") : "running", "exit_code" => code,
      "runtime_id" => data.fetch("Id"), "output" => {}, "error" => {}
    }
    if terminal && !execution.ac_task.cancelled? && !execution.ac_task.ac_plan.abandoned?
      logs = @runtime.container_logs(identity(execution))
      receipt["error"] = { "stderr" => AcQuotaService.new(company: execution.company).send(:redact_secrets, logs[:stderr].to_s).truncate(2000) }
      receipt["output"] = artifact_output(execution) if code == 0
      if %w[reviewer qa].include?(execution.ac_execution_profile.role.to_s) && code == 0
        evidence = evidence_path(execution, account_config!(execution))
        raw = File.open(File.join(evidence, "review.json"), File::RDONLY | File::NOFOLLOW | File::NONBLOCK) do |file|
          raise AcRuntimeSupervisorService::UnverifiedReceiptError, "Parecer excessivamente grande" if file.stat.size > 1_048_576
          raise AcRuntimeSupervisorService::UnverifiedReceiptError, "Parecer não é arquivo regular" unless file.stat.file?
          file.read
        end
        review = JSON.parse(raw.to_s)
        raise AcRuntimeSupervisorService::UnverifiedReceiptError, "Parecer estruturado ausente" unless review.is_a?(Hash)

        receipt["output"]["review"] = review
      end
    end
    receipt
  rescue JSON::ParserError
    raise AcRuntimeSupervisorService::UnverifiedReceiptError, "Parecer inválido"
  end

  def verify_receipt!(execution:, receipt:)
    container = lookup(identity(execution))
    return fenced?(execution) && receipt == absence_receipt(execution) if container.nil?
    return false unless container

    verify_container!(execution, container)
    data = container.json
    terminal = %w[exited dead].include?(data.dig("State", "Status"))
    code = terminal ? data.dig("State", "ExitCode") : nil
    expected_state = terminal ? (code == 0 ? "completed" : "failed") : "running"
    receipt["state"] == expected_state && receipt["exit_code"] == code && receipt["process_handle"] == identity(execution) &&
      receipt["runtime_id"] == data["Id"] && receipt["account_id"] == execution.ac_execution_profile.agent_credential_id &&
      receipt["model"] == execution.ac_execution_profile.model_id && receipt["effort"] == execution.ac_execution_profile.effort_level.to_s &&
      (receipt["exit_code"].nil? || receipt["exit_code"] == data.dig("State", "ExitCode"))
  end

  private

  def fenced?(execution)
    task = execution.ac_task.reload
    task.cancelled? || task.ac_plan.reload.abandoned? || execution.ac_execution_profile.ac_policy_revision.reload.revoked?
  end

  def absence_receipt(execution)
    { "operation_id" => execution.operation_id, "epoch" => execution.epoch.to_s,
      "process_handle" => identity(execution), "state" => "not_started", "exit_code" => nil,
      "runtime_id" => nil, "account_id" => execution.ac_execution_profile.agent_credential_id }
  end

  def identity(execution)
    "ac-execution-#{Digest::SHA256.hexdigest([ execution.company_id, execution.operation_id, execution.epoch ].join(':'))}"
  end

  def lookup(name)
    @runtime.resolve_container(name)
  rescue ContainerRuntime::ContainerUnreachableError
    raise
  rescue StandardError => e
    # DockerRuntime resolves a missing object as nil; transport failures remain
    # uncertain. Never turn an arbitrary control-plane error into absence.
    raise AcRuntimeSupervisorService::UnavailableError, e.message
  end

  def account_config!(execution)
    profiles = Rails.application.config.try(:ac_runtime_accounts) || {}
    profile = profiles[execution.ac_execution_profile.agent_credential_id.to_s]
    credential = execution.ac_execution_profile.agent_credential
    binding = profile.is_a?(Hash) && profile["attestation"].is_a?(Hash) &&
      profile["cli_adapter"] == execution.ac_execution_profile.cli_adapter.to_s && profile["agent_type"] == credential&.agent_type &&
      profile["auth_mode"] == "subscription" && profile["attestation"]["status"] == "documented_supported" &&
      profile["attestation"]["mode"] == "subscription" && profile["attestation"]["credential_id"].to_s == credential&.id.to_s
    unless binding && profile["image"].to_s.match?(/(?:@|\A)sha256:[a-f0-9]{64}\z/) &&
           profile["argv"].is_a?(Array) && profile["argv"].all? { |v| v.is_a?(String) } && profile["argv"].any?
      raise AcRuntimeSupervisorService::UnavailableError, "Imagem fixada e comando da conta não configurados"
    end
    cli = execution.ac_execution_profile.cli_adapter.to_s
    expected = { "codex_cli" => "codex", "claude_code" => "claude", "grok_cli" => "grok" }.fetch(cli)
    argv = profile.fetch("argv")
    unless File.basename(argv.first) == expected && argv.each_cons(2).any? { |flag, value| flag == "--model" && value == "{model}" } && argv.include?("{prompt}")
      raise AcRuntimeSupervisorService::UnavailableError, "Comando não fixa CLI, modelo e prompt do perfil"
    end
    effort_ok = if cli == "codex_cli"
      argv.each_cons(2).any? { |flag, value| %w[-c --config].include?(flag) && value == 'model_reasoning_effort="{effort}"' }
    else
      flag = cli == "claude_code" ? "--effort" : "--reasoning-effort"
      argv.each_cons(2).any? { |key, value| key == flag && value == "{effort}" }
    end
    network = profile.fetch("network", "none")
    allowed_networks = [ "none" ] + Array(Rails.application.config.try(:ac_worker_networks))
    unless effort_ok && allowed_networks.include?(network) && network != "host" && !network.to_s.start_with?("container:")
      raise AcRuntimeSupervisorService::UnavailableError, "Esforço ou rede do runtime não autorizado"
    end
    profile
  end

  def spec(execution, config)
    path = File.realpath(execution.worktree_path)
    root = File.realpath(Rails.application.config.try(:ac_worktree_base_dir) || Settings.agent_control.worktree_base_dir)
    unless path.start_with?(root + "/") && execution.worktree_lease_token.present?
      raise AcRuntimeSupervisorService::UnverifiedReceiptError, "Worktree sem posse ou fora da raiz"
    end
    prepare_worktree_ownership!(path, config)
    profile = execution.ac_execution_profile
    readonly = %w[reviewer qa].include?(profile.role.to_s)
    mounts = [ "#{path}:/work:#{readonly ? 'ro' : 'rw'}", "#{evidence_path(execution, config)}:/evidence:rw" ]
    config.fetch("auth_files", {}).each do |source, target|
      unless File.file?(source) && !File.symlink?(source) && target.to_s.start_with?("/home/agent/") && !target.to_s.split("/").include?("..")
        raise AcRuntimeSupervisorService::UnavailableError, "Montagem de autenticação inválida"
      end
      mounts << "#{File.realpath(source)}:#{target}:ro"
    end
    tokens = { "{model}" => profile.model_id, "{effort}" => profile.effort_level.to_s,
               "{prompt}" => execution.ac_task.inputs["prompt"].presence || execution.ac_task.scope }
    tokens["{prompt}"] = execution_prompt(execution, tokens["{prompt}"])
    argv = config.fetch("argv").map { |arg| tokens.reduce(arg) { |value, (token, replacement)| value.gsub(token) { replacement.to_s } } }
    {
      image: config.fetch("image"), container_name: identity(execution), working_dir: "/work",
      cmd: argv, env_vars: [ "HOME=/home/agent", "CI=true", "MITM_DISABLED=true", "OPENAI_API_KEY=", "ANTHROPIC_API_KEY=", "XAI_API_KEY=", "OPENROUTER_API_KEY=", "CODEX_API_KEY=", "OPENAI_BASE_URL=" ],
      labels: labels(execution),
      host_config: { "Binds" => mounts, "ReadonlyRootfs" => true, "CapDrop" => [ "ALL" ],
                     "SecurityOpt" => [ "no-new-privileges", "seccomp=#{File.read(Rails.root.join("docker/security/seccomp-agent-control.json"))}" ], "NetworkMode" => config.fetch("network", "none"),
                     "Memory" => config.fetch("memory_bytes", 2 * (1024**3)), "NanoCpus" => 1_000_000_000,
                     "PidsLimit" => 256, "LogConfig" => { "Type" => "json-file", "Config" => { "max-size" => "10m", "max-file" => "3" } }, "Tmpfs" => { "/tmp" => "rw,nosuid,nodev,size=128m", "/home/agent" => "rw,nosuid,nodev,size=128m" } },
      user: config.fetch("uid", "1000:1000")
    }
  end

  # Only a fresh, exclusively leased clone is changed, never its symlink targets.
  # The controller may be root, while every worker remains a non-root UID.
  def prepare_worktree_ownership!(path, config)
    user = config.fetch("uid", "1000:1000").to_s
    unless user.match?(/\A[1-9][0-9]*:[1-9][0-9]*\z/)
      raise AcRuntimeSupervisorService::UnavailableError, "UID/GID não privilegiados obrigatórios"
    end
    uid, gid = user.split(":").map(&:to_i)
    unless Process.uid.zero? || (Process.uid == uid && Process.gid == gid)
      raise AcRuntimeSupervisorService::UnavailableError, "Controlador não pode preparar a posse da worktree"
    end
    return unless Process.uid.zero?

    Find.find(path) do |entry|
      info = File.lstat(entry)
      unless info.file? || info.directory? || info.symlink?
        raise AcRuntimeSupervisorService::UnverifiedReceiptError, "Arquivo especial na worktree"
      end
      File.lchown(uid, gid, entry)
    end
  end

  def execution_prompt(execution, request)
    role = execution.ac_execution_profile.role.to_s
    if %w[reviewer qa].include?(role)
      artifact = execution.metadata.fetch("source_artifact")
      contract = { "artifact_hash" => artifact.fetch("artifact_hash"), "candidate_commit_sha" => artifact.fetch("commit_sha"),
                   "base_commit_hash" => artifact.fetch("base_commit_sha"), "verdict" => "approved|needs_changes", "findings" => [] }
      "Avalie independentemente o artefato somente leitura. Papel: #{role}. Não altere o código. " \
        "Registre o parecer JSON em /evidence/review.json com os identificadores exatos e veredito honesto. Contrato: #{JSON.generate(contract)}. #{request}"
    else
      "#{request}\nCritérios: #{JSON.generate(execution.ac_task.outputs || {})}. " \
        "Execute as verificações pertinentes, preserve o resultado e faça commit das alterações. Não aprove a própria entrega."
    end
  end

  def evidence_path(execution, config)
    root = Rails.application.config.try(:ac_evidence_base_dir) || Settings.agent_control.evidence_base_dir
    path = File.join(File.realpath(root), identity(execution))
    raise AcRuntimeSupervisorService::UnverifiedReceiptError, "Diretório de evidência é symlink" if File.symlink?(path)
    FileUtils.mkdir_p(path, mode: 0o700)
    uid = config.fetch("uid", "1000:1000").to_s.split(":").first.to_i
    raise AcRuntimeSupervisorService::UnavailableError, "Agente root proibido" if uid.zero?
    File.chown(uid, nil, path) if Process.uid.zero?
    path
  end

  def labels(execution)
    { "ac.company" => execution.company_id.to_s, "ac.operation" => execution.operation_id,
      "ac.epoch" => execution.epoch.to_s, "ac.profile" => execution.ac_execution_profile_id.to_s,
      "ac.account" => execution.ac_execution_profile.agent_credential_id.to_s }
  end

  def verify_container!(execution, container)
    config = account_config!(execution)
    data = container.json
    unless (data.dig("Config", "Labels") || {}).slice(*labels(execution).keys) == labels(execution) && data.dig("Config", "Image") == config["image"]
      raise AcRuntimeSupervisorService::UnverifiedReceiptError, "Identidade do runtime não corresponde à operação"
    end
  end

  def artifact_output(execution)
    path = execution.worktree_path
    commit, _, status = AcSafeGit.capture("-C", path, "rev-parse", "--verify", "HEAD^{commit}")
    raise AcRuntimeSupervisorService::UnverifiedReceiptError, "Artefato sem commit Git" unless status.success?

    dirty, _, status = AcSafeGit.capture("-C", path, "status", "--porcelain")
    raise AcRuntimeSupervisorService::UnverifiedReceiptError, "Artefato contém alterações não commitadas" unless status.success? && dirty.empty?

    base = execution.metadata.dig("source_artifact", "base_commit_sha") || execution.metadata["base_commit_sha"]
    hash = AcArtifactIdentity.digest(repo: path, commit: commit.strip, base: base)
    { "commit_sha" => commit.strip, "base_commit_sha" => base, "artifact_hash" => hash }
  end
end
