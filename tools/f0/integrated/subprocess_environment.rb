# frozen_string_literal: true

module IntegratedSubprocessEnvironment
  def self.build(source = ENV)
    source.to_h.select do |key, _|
      key.start_with?("F0_") || %w[PATH BUNDLE_GEMFILE BUNDLE_FROZEN BUNDLE_PATH BUNDLE_APP_CONFIG GEM_HOME GEM_PATH HOME TMPDIR].include?(key)
    end
  end
end
