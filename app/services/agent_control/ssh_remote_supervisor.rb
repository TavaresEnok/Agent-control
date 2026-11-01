# frozen_string_literal: true

require "base64"
require "digest"
require "json"
require "open3"
require "openssl"
require "shellwords"
require "timeout"

module AgentControl
  # Configuration is provisioned by the operator, not supplied by a request.
  # Keys are environment IDs; values name the local secret file and the two
  # absolute, preinstalled paths on the remote host.
  class SshRemoteSupervisor
    class Error < StandardError; end

    def initialize(environments:, runner: nil)
      @environments = environments
      @runner = runner || Runner.new
    end

    def dispatch_operation!(environment:, operation_id:, command:, working_directory:, artifact_hash:, task:, execution:, **)
      operation = AcRemoteOperation.find_by!(company_id: environment.company_id, operation_id: operation_id,
        ac_remote_environment_id: environment.id, ac_task_id: task.id, ac_execution_id: execution.id)
      request(operation, "dispatch", command: command, working_directory: working_directory, artifact_hash: artifact_hash)
    end

    def query_operation_status!(operation:, **)
      request(operation, "status")
    end

    def cancel_operation!(operation:, **)
      request(operation, "cancel")
    end

    def verify_operation_receipt!(operation:, receipt:)
      return false unless receipt.is_a?(Hash)

      signature = receipt["signature"].to_s
      body = receipt.except("signature")
      return false unless signature.match?(/\A[0-9a-f]{64}\z/) && body["intent_hash"] == intent_hash(operation)
      return false unless identity(operation).all? { |key, value| value.present? && body[key].to_s == value.to_s }

      expected = OpenSSL::HMAC.hexdigest("SHA256", secret(operation.ac_remote_environment), canonical(body))
      ActiveSupport::SecurityUtils.secure_compare(signature, expected)
    rescue Error, ActiveRecord::RecordNotFound
      false
    end

    private

    class Runner
      def execute(transport, remote_command, input:)
        output = nil
        status = nil
        Open3.popen3(transport.environment, *transport.argv(remote_command), **transport.spawn_options) do |stdin, stdout, stderr, waiter|
          readers = [ Thread.new { stdout.read(131_073) }, Thread.new { stderr.read(8_193) } ]
          begin
            Timeout.timeout(30) do
              stdin.write(input)
              stdin.close
              output = readers.first.value
              readers.last.value
              status = waiter.value
            end
          rescue Timeout::Error
            begin
              Process.kill("KILL", waiter.pid)
            rescue Errno::ESRCH
              nil
            end
            raise Error, "SSH supervisor request timed out"
          ensure
            stdin.close unless stdin.closed?
            stdout.close unless stdout.closed?
            stderr.close unless stderr.closed?
            readers.each(&:kill)
          end
        end
        raise Error, "SSH supervisor request failed" unless status.success? && output.bytesize <= 131_072

        output
      rescue SystemCallError, IOError
        raise Error, "SSH supervisor request failed"
      end
    end

    def request(operation, action, command: nil, working_directory: nil, artifact_hash: nil)
      environment = operation.ac_remote_environment
      config = configuration(environment)
      payload = identity(operation).merge("action" => action, "intent_hash" => intent_hash(operation))
      if action == "dispatch"
        unless command == operation.command && working_directory == operation.working_directory && artifact_hash == operation.artifact_hash
          raise Error, "Remote intent mismatch"
        end
        payload.merge!("command" => command, "working_directory" => working_directory, "artifact_hash" => artifact_hash)
      end
      signature = OpenSSL::HMAC.hexdigest("SHA256", secret(environment), canonical(payload))
      envelope = canonical("payload" => payload, "mac" => signature)
      command_line = Shellwords.join([ "/usr/bin/python3", config.fetch(:helper_path), config.fetch(:remote_config_path) ])
      response = @runner.execute(environment.build_transport(lab_opt_in: true), command_line, input: envelope)
      parsed = JSON.parse(response)
      receipt = parsed.fetch("receipt").merge("signature" => parsed.fetch("mac"))
      raise Error, "Remote receipt verification failed" unless verify_operation_receipt!(operation: operation, receipt: receipt)

      receipt
    rescue JSON::ParserError, KeyError, TypeError, ArgumentError
      raise Error, "Remote supervisor response invalid"
    end

    def identity(operation)
      { "operation_id" => operation.operation_id, "company_id" => operation.company_id,
        "environment_id" => operation.ac_remote_environment_id, "task_id" => operation.ac_task_id,
        "execution_id" => operation.ac_execution_id, "epoch" => operation.metadata["execution_epoch"].to_s }
    end

    def intent_hash(operation)
      Digest::SHA256.hexdigest(canonical(identity(operation).merge("command" => operation.command,
        "working_directory" => operation.working_directory, "artifact_hash" => operation.artifact_hash)))
    end

    def canonical(value)
      JSON.generate(sort_keys(value))
    end

    def sort_keys(value)
      case value
      when Hash then value.keys.sort.to_h { |key| [ key, sort_keys(value[key]) ] }
      when Array then value.map { |entry| sort_keys(entry) }
      else value
      end
    end

    def configuration(environment)
      config = @environments[environment.id] || @environments[environment.id.to_s]
      raise Error, "Remote supervisor not configured" unless config.is_a?(Hash)

      config = config.symbolize_keys
      %i[helper_path remote_config_path secret_file].each do |key|
        value = config[key].to_s
        raise Error, "Unsafe supervisor configuration" unless value.start_with?("/") && !value.match?(/[\x00-\x1f\x7f]/)
      end
      config
    end

    def secret(environment)
      path = configuration(environment).fetch(:secret_file)
      raw = File.open(path, File::RDONLY | File::NOFOLLOW) do |file|
        stat = file.stat
        raise Error, "Unsafe supervisor secret" unless stat.file? && stat.uid == Process.euid && (stat.mode & 0o077).zero?

        file.read(65).to_s.strip
      end
      raise Error, "Invalid supervisor secret" unless raw.match?(/\A[0-9a-f]{64}\z/)

      [ raw ].pack("H*")
    rescue SystemCallError
      raise Error, "Supervisor secret unavailable"
    end
  end
end
