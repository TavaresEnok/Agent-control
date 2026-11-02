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

begin
  input = JSON.parse(STDIN.read(65_537))
  raise 'INVALID_REQUEST' unless input.is_a?(Hash)
  expected = case input['action']
    when 'identity-at' then %w[action base candidate repo sourceRepo]
    when 'verify-composition' then %w[action base candidate repo sourceRepo sources]
    when 'import' then %w[action base candidate repo sourceRepo]
    when 'compose' then %w[action base destination repo sources]
    when 'identity', 'diff' then %w[action base candidate repo]
    when 'observe' then %w[action base candidate repo targetRef]
    when 'snapshot' then %w[action base candidate destination repo]
    when 'cas' then %w[action base candidate operationId repo targetRef]
    else raise 'INVALID_ACTION'
  end
  raise 'INVALID_REQUEST' unless input.keys.sort == expected.sort
  raise 'INVALID_ACTION' unless %w[identity diff observe snapshot cas compose import verify-composition identity-at].include?(input['action'])
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
