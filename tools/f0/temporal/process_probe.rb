# frozen_string_literal: true

require "json"
require "fileutils"
require "rbconfig"

# Test fixture, not a production executor/admission service. A real, harmless
# child has an operation label in /proc; PID alone is never treated as identity.
class ProcessProbe
  class Uncertain < StandardError; end
  CHILD = File.expand_path("child.rb", __dir__)

  def initialize(root, operation)
    raise ArgumentError, "invalid operation" unless /\Ag0-[a-f0-9]{32}\z/.match?(operation)
    @operation = operation
    @dir = File.join(root, operation)
    FileUtils.mkdir_p(@dir)
  end

  def write(name, value)
    tmp = File.join(@dir, "#{name}.tmp")
    File.open(tmp, "w", 0o600) { |f| f.write(JSON.generate(value)); f.flush; f.fsync }
    File.rename(tmp, File.join(@dir, name))
    File.open(@dir) { |f| f.fsync }
  end

  def read(name)
    path = File.join(@dir, name)
    JSON.parse(File.read(path)) if File.exist?(path)
  end

  def identity(pid)
    args = File.binread("/proc/#{pid}/cmdline").split("\0")
    return unless args.include?(CHILD) && args.include?(@operation)
    stat = File.read("/proc/#{pid}/stat").split(") ", 2).last.split
    return if stat[0] == "Z"
    { "pid" => Integer(pid), "ticks" => stat[19],
      "boot" => File.read("/proc/sys/kernel/random/boot_id").strip }
  rescue Errno::ENOENT, Errno::ESRCH
    nil
  end

  def observe
    matches = Dir["/proc/[0-9]*"].filter_map { |p| identity(File.basename(p)) }
    raise Uncertain, "multiple processes for operation" if matches.length > 1
    matches.first
  end

  def crash_once(point, scenario)
    return unless point == scenario && !read("injected.json")
    write("injected.json", { "point" => point })
    Process.exit!(86) # Real worker death, not a mocked exception/Temporal client.
  end

  def launch(scenario)
    File.open(File.join(@dir, "lock"), "w", 0o600) do |lock|
      lock.flock(File::LOCK_EX)
      raise Uncertain, "operation already stopped" if read("stop-request.json")
      if read("spawn-attempt.json")
        found = observe
        raise Uncertain, "spawn attempted but no labeled process: no blind relaunch" unless found
        saved = read("handle.json")
        raise Uncertain, "handle identity changed" if saved && saved != found
        write("handle.json", found)
        return found
      end
      write("intent.json", { "operation" => @operation })
      crash_once("after_intent", scenario)
      write("spawn-attempt.json", { "operation" => @operation })
      # This failure deliberately leaves no external proof; retry must fail closed.
      crash_once("uncertain", scenario)
      pid = Process.spawn({}, RbConfig.ruby, CHILD, @operation,
        unsetenv_others: true, close_others: true, pgroup: true,
        in: File::NULL, out: File::NULL, err: File::NULL)
      Process.detach(pid)
      # Wait for exec, since /proc initially still describes the spawning worker.
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 2
      until (found = identity(pid))
        raise Uncertain, "child identity unavailable" if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
        sleep 0.01
      end
      crash_once("after_process", scenario)
      write("handle.json", found)
      crash_once("after_handle", scenario)
      found
    end
  end

  def stop
    File.open(File.join(@dir, "lock"), "w", 0o600) do |lock|
      lock.flock(File::LOCK_EX)
      write("stop-request.json", { "operation" => @operation })
      stop_locked
    end
  end

  def stop_locked
    found = observe
    return { "stopped" => true } unless found
    saved = read("handle.json")
    raise Uncertain, "cannot stop changed identity" if saved && saved != found
    # Fixture owns this exact labeled process; recheck identity before signaling.
    raise Uncertain, "identity changed before stop" unless identity(found["pid"]) == found
    Process.kill("TERM", found["pid"])
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 3
    while observe
      raise Uncertain, "process did not stop" if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
      sleep 0.02
    end
    write("stopped.json", found)
    { "stopped" => true }
  end
end
