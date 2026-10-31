# frozen_string_literal: true

require "bundler/setup"
require "active_support"
require "active_support/core_ext"
require "hashie"
require "logger"
require "ostruct"
require "json"
require "securerandom"
require "fileutils"
require "temporalio/client"
require "temporalio/worker"

# Only the configuration/logging surface needed by the imported service. This
# does not boot Rails, read .env, connect to its database, or sync schedules.
module Rails
  def self.logger = @logger ||= Logger.new($stderr, level: Logger::WARN)
end

module Settings
  def self.temporal = OpenStruct.new(enabled: true)
end

module Workflows; end
ROOT = File.expand_path("../../..", __dir__)
require File.join(ROOT, "app/temporal/temporal_input")
require File.join(ROOT, "app/services/temporal_service")
require File.join(ROOT, "app/temporal/workflows/base")
require_relative "process_probe"
require_relative "definitions"
