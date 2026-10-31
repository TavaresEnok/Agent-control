# frozen_string_literal: true

require_relative "process_probe"
run = ARGV.fetch(0)
raise "expected run ID g0-<32 hex>" unless /\Ag0-[a-f0-9]{32}\z/.match?(run)
root = File.join(__dir__, "artifacts", run)
raise "missing run directory" unless File.directory?(root) && !File.symlink?(root)
manifest = JSON.parse(File.read(File.join(root, "manifest.json")))
namespace = "agent-control-#{run}"
raise "ownership mismatch" unless manifest.fetch("namespace") == namespace

# Stop only workers and dev servers bearing this exact run's names/DB path.
# Preserve SQLite, histories and results; deleting evidence is a separate step.
Dir["/proc/[0-9]*"].each do |path|
  next unless File.stat(path).uid == Process.uid
  args = File.binread(File.join(path, "cmdline")).split("\0")
  owned_worker = args.include?(File.join(__dir__, "worker.rb")) && args.include?(namespace)
  owned_server = args.include?("start-dev") && args.include?(File.join(root, "temporal.sqlite"))
  next unless owned_worker || owned_server
  next unless File.binread(File.join(path, "cmdline")).split("\0") == args
  Process.kill("TERM", Integer(File.basename(path)))
rescue Errno::ENOENT, Errno::ESRCH
  next
end
Dir.children(root).select { |name| /\Ag0-[a-f0-9]{32}\z/.match?(name) }.each do |operation|
  raise "symlink operation directory" if File.symlink?(File.join(root, operation))
  ProcessProbe.new(root, operation).stop
end
puts "Own resources signaled/stopped; evidence retained in #{root}"
