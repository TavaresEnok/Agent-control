# frozen_string_literal: true

require_relative "guard"
AdmissionLab.config!
abort "Ruby 4.0.9 required" unless RUBY_VERSION == "4.0.9"
require "bundler/setup"
require "active_record"
require "pg"
ActiveRecord::Base.establish_connection(AdmissionLab.config!)
begin
  AdmissionLab.verify!(ActiveRecord::Base.connection)
  puts "PASS: isolated PostgreSQL identity; no schema changed"
ensure
  ActiveRecord::Base.connection_pool.disconnect!
end
