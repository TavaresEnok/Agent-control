# frozen_string_literal: true

require "digest"
require "open3"

class AcArtifactIdentity
  def self.digest(repo:, commit:, base:)
    unless commit.to_s.match?(/\A[0-9a-f]{40,64}\z/) && base.to_s.match?(/\A[0-9a-f]{40,64}\z/)
      raise ArgumentError, "Base e candidato devem ser IDs Git completos"
    end
    tree, error, status = AcSafeGit.capture("-C", repo, "rev-parse", "--verify", "#{commit}^{tree}")
    raise ArgumentError, "Árvore Git não encontrada: #{error}" unless status.success?

    Digest::SHA256.hexdigest([ base, commit, tree.strip ].join("\0"))
  end
end
