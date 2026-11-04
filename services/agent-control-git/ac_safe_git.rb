# frozen_string_literal: true

require "open3"
require "tmpdir"
require "fileutils"

# Never load a worker's Git configuration on the control host. Disabling hooks
# alone is insufficient: clean/process filters can execute during `git status`.
class AcSafeGit
  ENVIRONMENT = { "GIT_CONFIG_NOSYSTEM" => "1", "GIT_CONFIG_GLOBAL" => "/dev/null", "GIT_CONFIG_SYSTEM" => "/dev/null",
                  "GIT_TERMINAL_PROMPT" => "0", "GIT_SSH_COMMAND" => "/bin/false", "GIT_NO_REPLACE_OBJECTS" => "1",
                  "GIT_LITERAL_PATHSPECS" => "1" }.freeze
  OPTIONS = [ "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never" ].freeze

  def self.capture(*args)
    return invoke(*args) unless (index = args.index("-C"))

    repo = File.realpath(args.fetch(index + 1))
    with_repository(repo) do |metadata|
      safe_args = args.dup
      safe_args[index, 2] = [ "--git-dir", metadata, "--work-tree", repo, "-c", "core.bare=false" ]
      result = invoke(*safe_args, index_path: File.join(repo, ".git", "index"))
      if result.last.success? && args.include?("checkout")
        FileUtils.copy_file(File.join(metadata, "HEAD"), File.join(repo, ".git", "HEAD"))
      end
      result
    end
  end

  # Paths whose disappearance is repository identity or an external reference.
  ESSENTIAL_INSPECTION_PATHS = %w[objects refs HEAD packed-refs shallow commondir objects/info/alternates].freeze
  # Git 2.39 names that regularly disappear between a directory walk and lstat.
  TRANSIENT_OBJECT = %r{\Aobjects/[0-9a-f]{2}/tmp_obj_[^/]+\z}
  TRANSIENT_PACK = %r{\Aobjects/pack/tmp_pack_[^/]+\z}
  TRANSIENT_LOCK = %r{\A(?:[^/]+/)*[^/]+\.lock\z}

  # Only object/ref data are shared. Configuration, hooks, grafts and includes
  # come from a disposable controller-owned directory, including upload-pack.
  def self.with_repository(repo)
    repo = File.realpath(repo)
    git_dir = File.join(repo, ".git")
    assert_contained!(repo, git_dir)
    inspect_metadata!(git_dir)
    assert_contained!(repo, git_dir)
    Dir.mktmpdir("ac-safe-git-") do |metadata|
      %w[objects refs].each do |name|
        source = File.join(git_dir, name)
        raise ArgumentError, "Metadados Git incompletos" unless File.directory?(source)
        File.symlink(source, File.join(metadata, name))
      end
      %w[HEAD packed-refs shallow].each do |name|
        source = File.join(git_dir, name)
        next unless File.exist?(source)
        raise ArgumentError, "Metadado Git inválido" unless File.file?(source)
        FileUtils.copy_file(source, File.join(metadata, name))
      end
      File.write(File.join(metadata, "config"), "[core]\nrepositoryformatversion = 0\nbare = true\n")
      yield metadata
    end
  end

  def self.assert_contained!(repo, git_dir)
    unless File.directory?(git_dir) && !File.symlink?(git_dir) && !repo.include?("\n")
      raise ArgumentError, "Repositório deve ser autocontido"
    end
    %w[commondir objects/info/alternates].each do |relative|
      raise ArgumentError, "Referência Git externa não autorizada" if File.exist?(File.join(git_dir, relative))
    end
  end

  # Dir.glob can observe a regular temporary entry that Git removes before
  # File.lstat. Only that walk rescues ENOENT, and only for the known
  # temporary names above. Roots, essential metadata, hooks, config and every
  # later Git call stay unrescued.
  def self.inspect_metadata!(git_dir)
    Dir.glob(File.join(git_dir, "**", "*"), File::FNM_DOTMATCH).each do |path|
      begin
        info = File.lstat(path)
      rescue Errno::ENOENT
        raise unless transient_vanished_metadata?(git_dir, path)
        next
      end
      unless info.file? || info.directory?
        raise ArgumentError, "Metadado Git deve ser arquivo regular ou diretório"
      end
    end
  end

  def self.inspection_relative(git_dir, path)
    prefix = "#{git_dir}/"
    return nil unless path.start_with?(prefix)
    relative = path.delete_prefix(prefix)
    parts = relative.split("/", -1)
    return nil if parts.empty? || parts.any? { |part| part.empty? || part == "." || part == ".." }
    relative
  end

  def self.transient_vanished_metadata?(git_dir, path)
    relative = inspection_relative(git_dir, path)
    return false unless relative
    return false if ESSENTIAL_INSPECTION_PATHS.include?(relative)
    relative.match?(TRANSIENT_OBJECT) || relative.match?(TRANSIENT_PACK) || relative.match?(TRANSIENT_LOCK)
  end

  def self.invoke(*args, index_path: nil)
    environment = { "PATH" => "/usr/bin:/bin", "HOME" => "/nonexistent", "LANG" => "C.UTF-8",
                    "GIT_AUTHOR_NAME" => "Agent Control", "GIT_AUTHOR_EMAIL" => "agent-control@invalid",
                    "GIT_COMMITTER_NAME" => "Agent Control", "GIT_COMMITTER_EMAIL" => "agent-control@invalid",
                    "GIT_AUTHOR_DATE" => "2000-01-01T00:00:00Z", "GIT_COMMITTER_DATE" => "2000-01-01T00:00:00Z" }.merge(ENVIRONMENT)
    environment["GIT_INDEX_FILE"] = index_path if index_path
    Open3.capture3(environment, "git", *OPTIONS, *args, unsetenv_others: true)
  end
  private_class_method :assert_contained!, :inspect_metadata!, :inspection_relative, :transient_vanished_metadata?, :invoke
end
