# frozen_string_literal: true

# Standalone laboratory: real runner, synthetic Settings only; no Rails, SQL,
# integration, Coder CLI, MCP authentication, or RepoBootstrap impersonation.
require "bundler/setup"
require "active_support/all"
require "ostruct"
require "json"
require "securerandom"
require "timeout"
require "uri"
unless defined?(Settings)
  module Settings
    def self.coder = OpenStruct.new
  end
end
require_relative "../../../app/services/coder/ssh_runner"
require_relative "../../../app/services/agent_control/open_ssh_transport"
