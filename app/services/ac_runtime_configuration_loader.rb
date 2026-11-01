# frozen_string_literal: true

require "json"
require "time"
require "uri"

class AcRuntimeConfigurationLoader
  class InvalidConfiguration < StandardError; end

  MAX_BYTES = 1.megabyte
  ACCOUNT_KEYS = %w[image argv auth_files uid network memory_bytes cli_adapter agent_type auth_mode attestation].freeze
  CLIS = { "codex_cli" => [ "codex", "codex" ], "claude_code" => [ "claude", "claude_code" ], "grok_cli" => [ "grok", "grok" ] }.freeze

  def self.load!(path)
    raise InvalidConfiguration, "Configuração de runtime inválida" unless path.is_a?(String) && path.start_with?("/") && !path.match?(/[\0\r\n]/) && Pathname.new(path).cleanpath.to_s == path
    validate_parent!(path)
    document = File.open(path, File::RDONLY | File::NOFOLLOW | File::NONBLOCK) do |file|
      before = file.stat
      unless before.file? && before.uid == Process.euid && (before.mode & 0o7177).zero? && (before.mode & 0o400).positive? && before.size.between?(1, MAX_BYTES)
        raise InvalidConfiguration, "Arquivo de configuração não é privado"
      end
      bytes = file.read(MAX_BYTES + 1)
      after = file.stat
      unless bytes.bytesize <= MAX_BYTES && before.size == after.size && before.mtime == after.mtime && before.ino == after.ino
        raise InvalidConfiguration, "Arquivo de configuração mudou durante a leitura"
      end
      JSON.parse(bytes)
    end
    unless document.is_a?(Hash) && document.keys.sort == %w[accounts allowed_networks version] && document["version"] == 1 &&
           document["accounts"].is_a?(Hash) && document["accounts"].size.between?(1, 200) && document["allowed_networks"].is_a?(Array)
      raise InvalidConfiguration, "Estrutura de configuração inválida"
    end
    networks = document["allowed_networks"]
    unless networks.uniq == networks && networks.all? { |n| n.is_a?(String) && n.match?(/\A[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\z/) && n != "host" }
      raise InvalidConfiguration, "Redes não autorizadas"
    end
    document["accounts"].each { |id, account| validate_account!(id, account, networks: networks) }
    files = document["accounts"].values.flat_map { |account| account.fetch("auth_files").keys }
    identities = files.map { |path| stat = File.stat(path); [ stat.dev, stat.ino ] }
    raise InvalidConfiguration, "Arquivo de autenticação reutilizado entre contas" unless identities.uniq.size == identities.size

    { accounts: document["accounts"], networks: networks }
  rescue SystemCallError, JSON::ParserError, ArgumentError, TypeError
    raise InvalidConfiguration, "Não foi possível validar a configuração privada"
  end

  def self.validate_account!(id, account, networks:)
    raise InvalidConfiguration, "Conta de runtime inválida" unless id.to_s.match?(/\A[1-9][0-9]*\z/) && account.is_a?(Hash) && (account.keys - ACCOUNT_KEYS).empty?
    cli = account["cli_adapter"]
    expected = CLIS[cli]
    attestation = account["attestation"]
    unless expected && account["agent_type"] == expected.last && account["auth_mode"] == "subscription" && attestation.is_a?(Hash) &&
           attestation.keys.sort == %w[cli_adapter credential_id mode observed_at source status valid_until] &&
           attestation["status"] == "documented_supported" && attestation["mode"] == "subscription" &&
           attestation["cli_adapter"] == cli && attestation["credential_id"].to_s == id.to_s &&
           valid_attestation_dates?(attestation)
      raise InvalidConfiguration, "Atestado de conta não é válido"
    end
    image = account["image"]
    argv = account["argv"]
    uid = account["uid"]
    network = account["network"]
    unless image.is_a?(String) && image.match?(/\A(?:[a-zA-Z0-9._:\/-]+@)?sha256:[a-f0-9]{64}\z/) &&
           uid.is_a?(String) && uid.match?(/\A[1-9][0-9]*:[1-9][0-9]*\z/) &&
           argv.is_a?(Array) && argv.size.between?(1, 64) && argv.all? { |v| v.is_a?(String) && v.bytesize.between?(1, 4096) && !v.include?("\0") } &&
           File.basename(argv.first) == expected.first && argv.each_cons(2).any? { |flag, value| flag == "--model" && value == "{model}" } &&
           argv.include?("{prompt}") && (network == "none" || networks.include?(network)) && network != "host"
      raise InvalidConfiguration, "Imagem, comando, UID ou rede inválidos"
    end
    raise InvalidConfiguration, "UID/GID inválidos" if uid.split(":").any? { |part| part.to_i > 2_147_483_647 }
    model_flags = argv.count { |arg| arg == "--model" || arg == "-m" || arg.start_with?("--model=", "-m=") }
    placeholders = %w[{model} {effort} {prompt}]
    unless model_flags == 1 && placeholders.all? { |token| argv.sum { |arg| arg.scan(token).size } == 1 } &&
           argv.none? { |arg| arg.match?(/\{[^}]+\}/) && !placeholders.include?(arg) && arg != 'model_reasoning_effort="{effort}"' }
      raise InvalidConfiguration, "Comando contém parâmetros ambíguos"
    end
    effort_ok = if cli == "codex_cli"
      argv.each_cons(2).any? { |flag, value| %w[-c --config].include?(flag) && value == 'model_reasoning_effort="{effort}"' }
    else
      argv.each_cons(2).any? { |flag, value| flag == (cli == "claude_code" ? "--effort" : "--reasoning-effort") && value == "{effort}" }
    end
    effort_flags = argv.count { |arg| %w[-c --config --effort --reasoning-effort].include?(arg) ||
      arg.start_with?("--config=", "--effort=", "--reasoning-effort=") }
    raise InvalidConfiguration, "Esforço não vinculado ao perfil" unless effort_ok && effort_flags == 1
    memory = account.fetch("memory_bytes", 2 * (1024**3))
    raise InvalidConfiguration, "Limite de memória inválido" unless memory.is_a?(Integer) && memory.between?(128 * (1024**2), 8 * (1024**3))

    files = account["auth_files"]
    raise InvalidConfiguration, "Autenticação da conta ausente" unless files.is_a?(Hash) && files.size.between?(1, 16) && files.values.uniq.size == files.size
    files.each do |source, target|
      unless source.is_a?(String) && source.start_with?("/") && !source.match?(/[:\0\r\n]/) && Pathname.new(source).cleanpath.to_s == source && target.is_a?(String) &&
             target.start_with?("/home/agent/") && !target.match?(/[:\0\r\n]/) && Pathname.new(target).cleanpath.to_s == target
        raise InvalidConfiguration, "Montagem de autenticação inválida"
      end
      validate_parent!(source, additional_owner: uid.split(":").first.to_i)
      File.open(source, File::RDONLY | File::NOFOLLOW | File::NONBLOCK) do |file|
        stat = file.stat
        worker_uid = uid.split(":").first.to_i
        unless stat.file? && stat.uid == worker_uid && (stat.mode & 0o7177).zero? && (stat.mode & 0o400).positive? && stat.size <= MAX_BYTES
          raise InvalidConfiguration, "Arquivo de autenticação não é privado ou acessível ao agente"
        end
      end
    end
    true
  rescue SystemCallError, ArgumentError, TypeError
    raise InvalidConfiguration, "Não foi possível validar a conta de runtime"
  end

  def self.readiness(company:)
    status = Rails.application.config.try(:ac_runtime_configuration_status) || {}
    return { "ready" => false, "reason" => status["reason"] || "not_configured" } unless status["ready"] == true

    accounts = Rails.application.config.try(:ac_runtime_accounts) || {}
    credentials = company.agent_credentials.where(id: accounts.keys, status: "active")
      .where("expires_at IS NULL OR expires_at > ?", Time.current).pluck(:id, :agent_type)
    return { "ready" => false, "reason" => "no_accounts" } if credentials.empty?

    networks = Rails.application.config.try(:ac_worker_networks) || []
    credentials.each do |id, agent_type|
      account = accounts.fetch(id.to_s)
      return { "ready" => false, "reason" => "invalid_configuration" } unless account["agent_type"] == agent_type
      validate_account!(id.to_s, account, networks: networks)
    end
    { "ready" => true, "reason" => "configured", "auth_mode" => "subscription" }
  rescue InvalidConfiguration, KeyError
    { "ready" => false, "reason" => "invalid_configuration" }
  end

  def self.valid_attestation_dates?(attestation)
    observed = Time.iso8601(attestation["observed_at"].to_s)
    expires = Time.iso8601(attestation["valid_until"].to_s)
    source = URI.parse(attestation["source"].to_s)
    observed <= Time.current && expires > Time.current && expires > observed && source.is_a?(URI::HTTPS) &&
      source.host.present? && source.userinfo.nil? && source.query.nil? && source.fragment.nil?
  rescue ArgumentError, URI::InvalidURIError
    false
  end
  private_class_method :valid_attestation_dates?

  def self.validate_parent!(path, additional_owner: nil)
    parent = File.expand_path(File.dirname(path))
    raise InvalidConfiguration, "Caminho de configuração contém link simbólico" unless File.realpath(parent) == parent

    allowed_owners = [ 0, Process.euid, additional_owner ].compact.uniq
    cursor = parent
    loop do
      stat = File.stat(cursor)
      sticky_root = stat.uid.zero? && (stat.mode & 0o1000).positive?
      unless stat.directory? && allowed_owners.include?(stat.uid) && ((stat.mode & 0o022).zero? || sticky_root)
        raise InvalidConfiguration, "Diretório de configuração inseguro"
      end
      break if cursor == "/"
      cursor = File.dirname(cursor)
    end
  end
  private_class_method :validate_parent!
end
