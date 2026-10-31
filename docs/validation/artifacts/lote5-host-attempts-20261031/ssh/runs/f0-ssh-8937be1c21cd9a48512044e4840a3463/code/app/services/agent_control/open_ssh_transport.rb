# frozen_string_literal: true

require "base64"
require "digest"

module AgentControl
  # Explicit opt-in for disposable laboratories. No destination discovery,
  # credentials resolver, tool input, or alternate job engine lives here.
  class OpenSshTransport
    PIN_ALIAS = "f0-lab-pinned"

    def initialize(host:, user:, identity_file:, known_hosts_file:, fingerprint:, lab_opt_in: false, port: 22)
      raise ArgumentError, "laboratory opt-in required" unless lab_opt_in == true
      raise ArgumentError, "invalid host" unless host.to_s.match?(/\A[a-zA-Z0-9][a-zA-Z0-9.-]*\z/)
      raise ArgumentError, "invalid user" unless user.to_s.match?(/\A[a-z_][a-z0-9_-]*\z/)
      raise ArgumentError, "invalid port" unless port.is_a?(Integer) && (1..65535).cover?(port)
      @host, @user, @port = host.dup.freeze, user.dup.freeze, port
      @identity = path!(identity_file).freeze
      @known_hosts = path!(known_hosts_file).freeze
      @fingerprint = fingerprint.to_s.dup.freeze
      verify_pin!
    end

    def environment
      { "PATH" => "/usr/bin:/bin", "HOME" => "/nonexistent", "LANG" => "C" }
    end

    def spawn_options
      { unsetenv_others: true }
    end

    def validate_job_env!(env)
      raise ArgumentError, "laboratory SSH jobs do not accept environment forwarding" unless env.empty?
    end

    def argv(remote_command)
      verify_pin!
      options = [
        "BatchMode=yes", "IdentitiesOnly=yes", "IdentityAgent=none",
        "StrictHostKeyChecking=yes", "UserKnownHostsFile=\"#{config_quote(@known_hosts)}\"",
        "GlobalKnownHostsFile=/dev/null", "HostKeyAlias=#{PIN_ALIAS}",
        "HostKeyAlgorithms=ssh-ed25519", "UpdateHostKeys=no", "VerifyHostKeyDNS=no",
        "ForwardAgent=no", "ClearAllForwardings=yes", "ForwardX11=no", "Tunnel=no",
        "SendEnv=-*", "ControlMaster=no", "ControlPath=none", "RequestTTY=no",
        "ProxyCommand=none", "ProxyJump=none", "PermitLocalCommand=no",
        "CanonicalizeHostname=no", "ConnectionAttempts=1", "ConnectTimeout=10",
        "PasswordAuthentication=no", "KbdInteractiveAuthentication=no",
        "EscapeChar=none", "AddKeysToAgent=no", "GSSAPIAuthentication=no"
      ]
      [ "/usr/bin/ssh", "-F", "/dev/null", "-T", "-p", @port.to_s,
        "-i", @identity, *options.flat_map { |option| [ "-o", option ] },
        "--", "#{@user}@#{@host}", remote_command.to_s ]
    end

    private

    def path!(value)
      path = value.to_s.dup
      # OpenSSH expands percent tokens and ${ENV} in explicit filenames, even
      # inside quoted options. Refuse both so Ruby and SSH use the same file.
      raise ArgumentError, "explicit absolute file required" unless path.start_with?("/") && !path.match?(/[$%\x00-\x1f\x7f]/) && File.file?(path)
      path
    end

    def config_quote(value)
      value.gsub(/([\\"])/) { |char| "\\#{char}" }
    end

    def verify_pin!
      lines = File.readlines(@known_hosts).reject { |line| line.strip.empty? }
      fields = lines.one? ? lines.first.split : []
      unless fields.length == 3 && fields[0] == PIN_ALIAS && fields[1] == "ssh-ed25519"
        raise ArgumentError, "one explicit ed25519 host pin required"
      end
      key = Base64.strict_decode64(fields[2])
      actual = "SHA256:#{Base64.strict_encode64(Digest::SHA256.digest(key)).delete_suffix('=')}"
      raise ArgumentError, "host fingerprint mismatch" unless actual == @fingerprint
    rescue ArgumentError => e
      raise ArgumentError, "invalid laboratory host pin: #{e.message}"
    end
  end
end
