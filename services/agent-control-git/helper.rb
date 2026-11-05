# frozen_string_literal: true
# Trusted helper only. Existing AcSafeGit and AcArtifactIdentity remain unchanged.
require 'json'
require 'digest'
require_relative 'ac_safe_git'
require_relative 'ac_artifact_identity'

def git(repo, *args)
  out, _error, status = AcSafeGit.capture('-C', repo, *args)
  raise 'GIT_OPERATION_FAILED' unless status.success?
  out.strip
end

# Bounded raw object reads: never capture unbounded worker-controlled output.
def bounded_git(limit, *args)
  env = { 'PATH' => '/usr/bin:/bin', 'HOME' => '/nonexistent', 'LANG' => 'C.UTF-8' }.merge(AcSafeGit::ENVIRONMENT)
  reader, writer = IO.pipe
  pid = Process.spawn(env, 'git', *AcSafeGit::OPTIONS, *args, in: File::NULL, out: writer, err: File::NULL, unsetenv_others: true)
  writer.close
  bytes = reader.read(limit + 1) || ''.b
  if bytes.bytesize > limit
    Process.kill('KILL', pid) rescue nil
    Process.wait(pid) rescue nil
    raise 'SCAN_LIMIT'
  end
  _, status = Process.wait2(pid)
  raise 'GIT_OPERATION_FAILED' unless status.success?
  bytes
ensure
  reader&.close unless reader&.closed?
  writer&.close unless writer&.closed?
end

begin
  input = JSON.parse(STDIN.read(65_537))
  raise 'INVALID_REQUEST' unless input.is_a?(Hash)
  expected = case input['action']
    when 'head' then %w[action repo targetRef]
    when 'identity-at' then %w[action base candidate repo sourceRepo]
    when 'verify-composition' then %w[action base candidate repo sourceRepo sources]
    when 'import' then %w[action base candidate repo sourceRepo]
    when 'compose' then %w[action base destination repo sources]
    when 'identity', 'diff' then %w[action base candidate repo]
    when 'protected-paths' then %w[action base candidate paths repo]
    when 'scan-new-secrets' then %w[action base candidate repo secrets]
    when 'observe' then %w[action base candidate repo targetRef]
    when 'snapshot' then %w[action base candidate destination repo]
    when 'cas' then %w[action base candidate operationId repo targetRef]
    else raise 'INVALID_ACTION'
  end
  raise 'INVALID_REQUEST' unless input.keys.sort == expected.sort
  raise 'INVALID_ACTION' unless %w[head identity diff protected-paths scan-new-secrets observe snapshot cas compose import verify-composition identity-at].include?(input['action'])
  if input['action'] == 'head'
    ref = input.fetch('targetRef')
    raise 'INVALID_REQUEST' unless ref.is_a?(String) && ref.match?(/\Arefs\/heads\/[A-Za-z0-9][A-Za-z0-9\/_-]*\z/)
    repo = File.realpath(input.fetch('repo')); commit = git(repo, 'rev-parse', '--verify', ref)
    raise 'INVALID_GIT_ID' unless commit.match?(/\A[0-9a-f]{40}\z/)
    puts JSON.generate({commit: commit, targetRef: ref}); exit 0
  end
  (input['action'] == 'compose' ? %w[base] : %w[base candidate]).each do |key|
    raise 'INVALID_GIT_ID' unless input[key].is_a?(String) && input[key].match?(/\A(?:[0-9a-f]{40}|[0-9a-f]{64})\z/)
  end
  repo = File.realpath(input.fetch('repo'))
  base = input.fetch('base')
  if input['action'] == 'compose'
    destination = input.fetch('destination'); sources = input.fetch('sources')
    raise 'INVALID_REQUEST' unless destination.is_a?(String) && destination.start_with?('/') && !File.exist?(destination) && !File.symlink?(destination) && sources.is_a?(Array) && sources.length.between?(1, 16)
    seen = []
    sources.each do |source|
      raise 'INVALID_REQUEST' unless source.is_a?(Hash) && [ %w[base commit tree writePaths].sort, %w[base commit tree writePaths sourceRepo].sort ].include?(source.keys.sort) && source['base'] == base &&
        %w[commit tree].all? { |k| source[k].is_a?(String) && source[k].match?(/\A(?:[0-9a-f]{40}|[0-9a-f]{64})\z/) } &&
        source['writePaths'].is_a?(Array) && source['writePaths'].all? { |p| p.is_a?(String) && p.match?(%r{\A[^/\x00-\x1f]+(?:/[^/\x00-\x1f]+)*\z}) && p.split('/').none? { |part| %w[. .. .git].include?(part.downcase) } }
      if source['sourceRepo']
        AcSafeGit.with_repository(File.realpath(source['sourceRepo'])) do |metadata|
          _, _, fetched = AcSafeGit.capture('-C', repo, 'fetch', '--no-tags', metadata, source['commit'])
          raise 'GIT_OPERATION_FAILED' unless fetched.success?
        end
      end
      raise 'INVALID_REQUEST' unless git(repo, 'rev-parse', "#{source['commit']}^{tree}") == source['tree'] && git(repo, 'rev-parse', "#{source['commit']}^") == base
      paths, _, status = AcSafeGit.capture('-C', repo, 'diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', base, source['commit'])
      raise 'GIT_OPERATION_FAILED' unless status.success?
      entries, _, status = AcSafeGit.capture('-C', repo, 'ls-tree', '-r', '-z', source['commit'])
      raise 'GIT_OPERATION_FAILED' unless status.success?
      modes = entries.split("\0").to_h do |entry|
        header, path = entry.split("\t", 2)
        [path, header.split(' ', 2).first]
      end
      paths.split("\0").each do |path|
        raise 'INVALID_REQUEST' unless source['writePaths'].any? { |scope| path == scope || path.start_with?(scope + '/') }
        raise 'INVALID_REQUEST' if modes[path] && !%w[100644 100755].include?(modes[path])
        raise 'INVALID_REQUEST' if seen.any? { |prior| path == prior || path.start_with?(prior + '/') || prior.start_with?(path + '/') }
        seen << path
      end
    end
    AcSafeGit.with_repository(repo) do |metadata|
      _, _, cloned = AcSafeGit.capture('clone', '--no-local', '--no-checkout', '--', metadata, destination)
      raise 'GIT_OPERATION_FAILED' unless cloned.success?
      ([base] + sources.map { |source| source['commit'] }).each do |object|
        _, _, fetched = AcSafeGit.capture('-C', destination, 'fetch', '--no-tags', metadata, object)
        raise 'GIT_OPERATION_FAILED' unless fetched.success?
      end
    end
    sources.each_with_index do |source, index|
      git(destination, 'update-ref', "refs/agent-control/sources/#{index}", source['commit'])
    end
    git(destination, 'checkout', '--detach', base)
    current = git(destination, 'rev-parse', "#{base}^{tree}")
    sources.each do |source|
      git(destination, 'read-tree', '-m', base, current, source['commit'])
      raise 'INVALID_REQUEST' unless git(destination, 'ls-files', '-u').empty?
      current = git(destination, 'write-tree')
    end
    candidate = git(destination, 'commit-tree', current, '-p', base, '-m', 'Agent Control deterministic composition')
    git(destination, 'checkout', '--detach', candidate)
    tree = git(destination, 'rev-parse', "#{candidate}^{tree}")
    AcSafeGit.with_repository(destination) do |metadata|
      _, _, fetched = AcSafeGit.capture('-C', repo, 'fetch', '--no-tags', metadata, candidate)
      raise 'GIT_OPERATION_FAILED' unless fetched.success?
    end
    raise 'GIT_OPERATION_FAILED' unless git(repo, 'rev-parse', "#{candidate}^{tree}") == tree
    puts JSON.generate({commit: candidate, base: base, tree: tree, legacyDigest: AcArtifactIdentity.digest(repo: destination, commit: candidate, base: base), source: 'AcSafeGit+AcArtifactIdentity', snapshot: File.realpath(destination)})
    exit 0
  end
  candidate = input.fetch('candidate')
  if input['action'] == 'identity-at'
    source_repo = File.realpath(input.fetch('sourceRepo'))
    raise 'GIT_OPERATION_FAILED' unless git(source_repo, 'rev-parse', 'HEAD') == candidate && git(source_repo, 'rev-parse', "#{candidate}^") == base
    tree = git(source_repo, 'rev-parse', "#{candidate}^{tree}")
    puts JSON.generate({commit: candidate, base: base, tree: tree, legacyDigest: AcArtifactIdentity.digest(repo: source_repo, commit: candidate, base: base), source: 'AcSafeGit+AcArtifactIdentity'})
    exit 0
  end
  if input['action'] == 'verify-composition'
    source_repo = File.realpath(input.fetch('sourceRepo')); sources = input.fetch('sources')
    raise 'INVALID_REQUEST' unless sources.is_a?(Array) && sources.length.between?(1, 16) && sources.all? { |id| id.is_a?(String) && id.match?(/\A(?:[0-9a-f]{40}|[0-9a-f]{64})\z/) }
    raise 'GIT_OPERATION_FAILED' unless git(source_repo, 'rev-parse', 'HEAD') == candidate && git(source_repo, 'rev-parse', "#{candidate}^") == base
    sources.each_with_index { |id, index| raise 'GIT_OPERATION_FAILED' unless git(source_repo, 'rev-parse', "refs/agent-control/sources/#{index}") == id }
    tree = git(source_repo, 'rev-parse', "#{candidate}^{tree}")
    puts JSON.generate({commit: candidate, base: base, tree: tree, legacyDigest: AcArtifactIdentity.digest(repo: source_repo, commit: candidate, base: base), source: 'AcSafeGit+AcArtifactIdentity'})
    exit 0
  end
  if input['action'] == 'import'
    source_repo = File.realpath(input.fetch('sourceRepo'))
    AcSafeGit.with_repository(source_repo) do |metadata|
      _, _, fetched = AcSafeGit.capture('-C', repo, 'fetch', '--no-tags', metadata, candidate)
      raise 'GIT_OPERATION_FAILED' unless fetched.success?
    end
  end
  git(repo, 'cat-file', '-e', "#{base}^{commit}")
  git(repo, 'cat-file', '-e', "#{candidate}^{commit}")
  tree = git(repo, 'rev-parse', '--verify', "#{candidate}^{tree}")
  identity = {commit: candidate, base: base, tree: tree,
    legacyDigest: AcArtifactIdentity.digest(repo: repo, commit: candidate, base: base),
    source: 'AcSafeGit+AcArtifactIdentity'}
  if %w[identity import].include?(input['action'])
    puts JSON.generate(identity)
  elsif input['action'] == 'observe'
    ref = input.fetch('targetRef')
    raise 'INVALID_REQUEST' unless ref.is_a?(String) && ref.match?(/\Arefs\/heads\/[A-Za-z0-9][A-Za-z0-9\/_-]*\z/)
    puts JSON.generate(identity.merge({targetRef: ref, head: git(repo, 'rev-parse', '--verify', ref)}))
  elsif input['action'] == 'scan-new-secrets'
    secrets = input.fetch('secrets')
    raise 'INVALID_REQUEST' unless secrets.is_a?(Array) && secrets.length <= 256 && secrets.all? { |value| value.is_a?(String) && !value.empty? } && secrets.sum(&:bytesize) <= 48_000
    # Only objects newly reachable from candidate are examined: inherited base
    # objects are not reclassified. No working tree, filters, hooks or refs are
    # trusted. Every expanded object is bounded before reading its content.
    found = false
    AcSafeGit.with_repository(repo) do |metadata|
      objects = bounded_git(128 * 1024, '--git-dir', metadata, 'rev-list', '--objects', '--no-object-names', candidate, "^#{base}")
      ids = objects.lines.map(&:strip).reject(&:empty?).uniq
      # A new path may reuse a blob already reachable from base. Enumerate
      # each newly reachable commit's tree against the base tree as well.
      read_tree = lambda do |commit|
        data = bounded_git(8 * 1024 * 1024, '--git-dir', metadata, 'ls-tree', '-r', '-z', '--full-tree', commit)
        data.b.split("\0").to_h do |entry|
          header, path = entry.split("\t", 2); mode, kind, object = header.split(' ', 3)
          raise 'GIT_OPERATION_FAILED' unless path && %w[blob commit].include?(kind) && object&.match?(/\A(?:[a-f0-9]{40}|[a-f0-9]{64})\z/)
          [path, [mode, kind, object]]
        end
      end
      baseline = read_tree.call(base)
      commits = bounded_git(32 * 1024, '--git-dir', metadata, 'rev-list', candidate, "^#{base}")
      commit_ids = commits.lines.map(&:strip).reject(&:empty?)
      raise 'SCAN_LIMIT' if commit_ids.length > 256
      commit_ids.each do |commit_id|
        read_tree.call(commit_id).each do |path, entry|
          ids << entry[2] if entry[1] == 'blob' && baseline[path] != entry
        end
      end
      ids.uniq!
      raise 'SCAN_LIMIT' if ids.length > 1024 || ids.any? { |id| !id.match?(/\A(?:[a-f0-9]{40}|[a-f0-9]{64})\z/) }
      total = 0
      ids.each do |id|
        size = bounded_git(64, '--git-dir', metadata, 'cat-file', '-s', id)
        raise 'GIT_OPERATION_FAILED' unless size.match?(/\A[0-9]+\s*\z/)
        length = size.to_i; total += length
        raise 'SCAN_LIMIT' if length > 4 * 1024 * 1024 || total > 32 * 1024 * 1024
        kind = bounded_git(32, '--git-dir', metadata, 'cat-file', '-t', id).strip
        raise 'GIT_OPERATION_FAILED' unless %w[blob tree commit tag].include?(kind)
        bytes = bounded_git(length, '--git-dir', metadata, 'cat-file', kind, id)
        raise 'GIT_OPERATION_FAILED' unless bytes.bytesize == length
        found ||= secrets.any? { |secret| bytes.b.include?(secret.b) }
      end
    end
    puts JSON.generate(identity.merge({secretFound: found}))
  elsif input['action'] == 'protected-paths'
    paths = input.fetch('paths')
    raise 'INVALID_REQUEST' unless paths.is_a?(Array) && paths.length.between?(1, 64) && paths.all? do |path|
      path.is_a?(String) && path.bytesize.between?(1, 240) && path.match?(%r{\A[A-Za-z0-9._@+\-]+(?:/[A-Za-z0-9._@+\-]+)*/?\z}) && path.split('/').none? { |part| %w[. ..].include?(part) }
    end
    # AcSafeGit sets GIT_LITERAL_PATHSPECS=1; magic prefixes would be treated as filenames.
    specs = paths.map { |path| path.delete_suffix('/') }
    _, _, status = AcSafeGit.capture('-C', repo, 'diff', '--quiet', '--no-ext-diff', '--no-textconv', '--no-renames', base, candidate, '--', *specs)
    raise 'GIT_OPERATION_FAILED' unless [0, 1].include?(status.exitstatus)
    puts JSON.generate(identity.merge({protectedChanged: status.exitstatus == 1}))
  elsif input['action'] == 'diff'
    diff = git(repo, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', base, candidate, '--')
    puts JSON.generate(identity.merge({diff: diff.byteslice(0, 20_000).force_encoding('UTF-8').scrub,
      truncated: diff.bytesize > 20_000, diffSha256: Digest::SHA256.hexdigest(diff)}))
  elsif input['action'] == 'snapshot'
    destination = input.fetch('destination')
    raise 'INVALID_REQUEST' unless destination.is_a?(String) && destination.start_with?('/') && !File.exist?(destination) && !File.symlink?(destination)
    AcSafeGit.with_repository(repo) do |metadata|
      _out, _error, cloned = AcSafeGit.capture('clone', '--no-local', '--no-checkout', '--', metadata, destination)
      raise 'GIT_OPERATION_FAILED' unless cloned.success?
      # Imported native artifacts may be reachable only by their immutable ID,
      # not by a branch. Transfer that exact object before checkout.
      _out, _error, fetched = AcSafeGit.capture('-C', destination, 'fetch', '--no-tags', metadata, candidate)
      raise 'GIT_OPERATION_FAILED' unless fetched.success?
    end
    git(destination, 'checkout', '--detach', candidate)
    raise 'GIT_OPERATION_FAILED' unless AcArtifactIdentity.digest(repo: destination, commit: candidate, base: base) == identity[:legacyDigest]
    puts JSON.generate(identity.merge({snapshot: File.realpath(destination)}))
  else
    ref = input.fetch('targetRef'); operation = input.fetch('operationId')
    raise 'INVALID_REQUEST' unless ref.is_a?(String) && ref.match?(/\Arefs\/heads\/[A-Za-z0-9][A-Za-z0-9\/_-]*\z/) &&
      operation.is_a?(String) && operation.match?(/\A[0-9a-f-]{36}\z/)
    if git(repo, 'rev-parse', '--verify', ref) != base
      puts JSON.generate({status: 'rejected', reason: 'BASE_MOVED'})
    else
      _out, _error, ancestor = AcSafeGit.capture('-C', repo, 'merge-base', '--is-ancestor', base, candidate)
      raise 'GIT_OPERATION_FAILED' unless ancestor.success?
      git(repo, 'update-ref', '-m', "agent-control:#{operation}", ref, candidate, base)
      puts JSON.generate(identity.merge({status: 'integrated', operationId: operation, targetRef: ref}))
    end
  end
rescue StandardError => error
  # Never return repository/configuration data, raw Git stderr or credentials.
  allowed = %w[INVALID_REQUEST INVALID_ACTION INVALID_GIT_ID GIT_OPERATION_FAILED]
  puts JSON.generate({error: allowed.include?(error.message) ? error.message : 'UNSAFE_OR_UNAVAILABLE_REPOSITORY'})
  exit 1
end
