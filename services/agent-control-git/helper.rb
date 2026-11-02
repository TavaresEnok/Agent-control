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
    when 'identity', 'diff' then %w[action base candidate repo]
    when 'snapshot' then %w[action base candidate destination repo]
    when 'cas' then %w[action base candidate operationId repo targetRef]
    else raise 'INVALID_ACTION'
  end
  raise 'INVALID_REQUEST' unless input.keys.sort == expected.sort
  raise 'INVALID_ACTION' unless %w[identity diff snapshot cas].include?(input['action'])
  %w[base candidate].each do |key|
    raise 'INVALID_GIT_ID' unless input[key].is_a?(String) && input[key].match?(/\A(?:[0-9a-f]{40}|[0-9a-f]{64})\z/)
  end
  repo = File.realpath(input.fetch('repo'))
  candidate = input.fetch('candidate'); base = input.fetch('base')
  git(repo, 'cat-file', '-e', "#{base}^{commit}")
  git(repo, 'cat-file', '-e', "#{candidate}^{commit}")
  tree = git(repo, 'rev-parse', '--verify', "#{candidate}^{tree}")
  identity = {commit: candidate, base: base, tree: tree,
    legacyDigest: AcArtifactIdentity.digest(repo: repo, commit: candidate, base: base),
    source: 'AcSafeGit+AcArtifactIdentity'}
  if input['action'] == 'identity'
    puts JSON.generate(identity)
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
