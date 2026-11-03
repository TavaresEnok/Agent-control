# frozen_string_literal: true
# Trusted local finalizer. No model commands, repository config or branch merge.
require 'json'
require 'digest'
require_relative 'ac_safe_git'
require_relative 'ac_artifact_identity'

def git(repo, *args)
  out, _err, status = AcSafeGit.capture('-C', repo, *args)
  raise 'GIT_OPERATION_FAILED' unless status.success?
  out
end

def valid_path?(path)
  path.is_a?(String) && path.bytesize.between?(1, 240) && !path.start_with?('/') &&
    !path.match?(/[\\\x00-\x1f*?\[\]{}]/) && path.split('/', -1).none? { |part| part.empty? || %w[. .. .git .ai].include?(part.downcase) }
end

def publish(path, value)
  temporary = path + '.pending'
  File.open(temporary, File::WRONLY | File::CREAT | File::EXCL | File::NOFOLLOW, 0o600) do |file|
    file.write(JSON.generate(value)); file.flush; file.fsync
  end
  raise 'OUTPUT_EXISTS' if File.exist?(path) || File.symlink?(path)
  File.rename(temporary, path)
  File.open(File.dirname(path)) { |directory| directory.fsync }
end

begin
  input = JSON.parse(STDIN.read(65_537))
  raise 'INVALID_REQUEST' unless input.is_a?(Hash) && input.keys.sort == %w[base inputDigest jobId output scopeDigest work writePaths].sort &&
    input['jobId'].is_a?(String) && input['jobId'].match?(/\A[0-9a-f-]{36}\z/) &&
    %w[inputDigest scopeDigest].all? { |k| input[k].is_a?(String) && input[k].match?(/\A[0-9a-f]{64}\z/) } &&
    input['base'].is_a?(String) && input['base'].match?(/\A[0-9a-f]{40}\z/) &&
    input['writePaths'].is_a?(Array) && input['writePaths'].length.between?(1, 64) && input['writePaths'].all? { |path| valid_path?(path) }
  work = input.fetch('work'); output = input.fetch('output')
  raise 'INVALID_REQUEST' unless work.is_a?(String) && output.is_a?(String) && work.start_with?('/') && output.start_with?('/') &&
    File.basename(work) == 'work' && File.basename(output) == 'finalizer-result.json' && File.dirname(work) == File.dirname(output)
  root = File.dirname(work); info = File.lstat(root)
  raise 'INVALID_REQUEST' unless File.basename(root) == input['jobId'] && File.realpath(root) == root && info.directory? && !info.symlink? && info.uid == Process.uid && (info.mode & 0o7777) == 0o700 && File.realpath(work) == work
  lock = File.open(File.join(root, 'finalizer.lock'), File::RDWR | File::CREAT | File::NOFOLLOW, 0o600)
  raise 'INVALID_REQUEST' unless lock.stat.file? && lock.stat.nlink == 1 && lock.stat.uid == Process.uid && (lock.stat.mode & 0o077).zero?
  exit 75 unless lock.flock(File::LOCK_EX | File::LOCK_NB)
  raise 'OUTPUT_EXISTS' if File.exist?(output) || File.symlink?(output)
  begin
    base = input.fetch('base'); scopes = input.fetch('writePaths')
    git(work, 'cat-file', '-e', "#{base}^{commit}")
    # Rebuild the index against the frozen base; model-created commits are not
    # accepted as the final artifact and untrusted hooks/filters stay disabled.
    git(work, 'read-tree', base)
    tracked = git(work, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', base, '--').split("\0")
    untracked = git(work, 'ls-files', '--others', '--exclude-standard', '-z').split("\0")
    paths = (tracked + untracked).uniq
    raise 'NO_CHANGES' if paths.empty?
    raise 'INVALID_SCOPE' if paths.length > 10_000
    paths.each do |path|
      raise 'INVALID_SCOPE' unless valid_path?(path) && scopes.any? { |scope| path == scope || path.start_with?(scope + '/') }
      full = File.join(work, path)
      if File.exist?(full) || File.symlink?(full)
        stat = File.lstat(full)
        raise 'INVALID_SCOPE' unless stat.file? && !stat.symlink? && stat.nlink == 1
      end
    end
    git(work, 'add', '--all', '--', *scopes)
    tree = git(work, 'write-tree').strip
    raise 'NO_CHANGES' if tree == git(work, 'rev-parse', "#{base}^{tree}").strip
    # Reject symlink/submodule modes introduced through a malicious index.
    entries = git(work, 'ls-tree', '-r', '-z', tree).split("\0").to_h do |entry|
      header, path = entry.split("\t", 2); [path, header.split(' ', 2).first]
    end
    paths.each { |path| raise 'INVALID_SCOPE' if entries[path] && !%w[100644 100755].include?(entries[path]) }
    commit = git(work, 'commit-tree', tree, '-p', base, '-m', "Agent Control native task #{input['jobId']}").strip
    git(work, 'update-ref', '--no-deref', 'HEAD', commit)
    result = {schemaVersion: 1, jobId: input['jobId'], inputDigest: input['inputDigest'], scopeDigest: input['scopeDigest'], status: 'ready',
      identity: {commit: commit, base: base, tree: tree, legacyDigest: AcArtifactIdentity.digest(repo: work, commit: commit, base: base), source: 'AcSafeGit+AcArtifactIdentity'}, failureCode: nil}
    publish(output, result)
  rescue StandardError => error
    code = %w[INVALID_SCOPE NO_CHANGES].include?(error.message) ? error.message : 'FINALIZATION_FAILED'
    publish(output, {schemaVersion: 1, jobId: input['jobId'], inputDigest: input['inputDigest'], scopeDigest: input['scopeDigest'], status: 'failed', identity: nil, failureCode: code})
  ensure
    lock.close
  end
rescue StandardError
  warn 'NATIVE_ARTIFACT_FINALIZATION_FAILED'
  exit 1
end
