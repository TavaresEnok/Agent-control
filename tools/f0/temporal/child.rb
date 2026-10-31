# frozen_string_literal: true

# No network, shell, provider CLI, credentials, or inherited environment.
# Lifetime ceiling also bounds cleanup if the entire harness is killed.
raise "invalid operation" unless ARGV.one? && /\Ag0-[a-f0-9]{32}\z/.match?(ARGV.first)
trap("TERM") { exit 0 }
sleep 120
