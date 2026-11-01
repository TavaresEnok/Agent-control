# frozen_string_literal: true

require "fileutils"
require "open3"
require "json"

# Workspaces are controller-owned clones, never the user's source repository.
# The lock serializes clone preflights and retention decisions on this root.
class AcArtifactStorageService
  class StorageError < StandardError; end
  MARKER = ".ac-workspace-owner.json"
  DEFAULTS = { "minimum_free_bytes" => 1.gigabyte, "root_quota_bytes" => 100.gigabytes,
    "company_quota_bytes" => 20.gigabytes, "retention_days" => 30, "gc_enabled" => false }.freeze

  def initialize(root: nil, config: nil)
    @root = File.realpath(root || Rails.application.config.try(:ac_worktree_base_dir) || Settings.agent_control.worktree_base_dir)
    @config = DEFAULTS.merge((config || Rails.application.config.try(:ac_artifact_storage) || {}).stringify_keys)
  end

  def synchronize
    lock = File.join(@root, ".ac-storage.lock")
    File.open(lock, File::RDWR | File::CREAT | File::NOFOLLOW, 0o600) do |file|
      raise StorageError, "Storage lock must be regular" unless file.stat.file?
      file.flock(File::LOCK_EX)
      yield
    ensure
      file&.flock(File::LOCK_UN)
    end
  end

  # Called under synchronize immediately before allocating a clone. These are
  # admission quotas; kernel-enforced limits for writes require a quota filesystem.
  def preflight!(company:, source:)
    estimate = [ directory_bytes(File.realpath(source)) * 2, 1.megabyte ].max
    free = free_bytes
    raise StorageError, "Insufficient free disk for clone and reserve" if free - estimate < positive_limit("minimum_free_bytes")
    raise StorageError, "Artifact root quota exhausted" if directory_bytes(@root) + estimate > positive_limit("root_quota_bytes")
    company_bytes = AcExecution.where(company: company).where.not(worktree_path: nil).pluck(:worktree_path).uniq.sum do |path|
      owned_path?(path) && File.directory?(path) ? directory_bytes(path) : 0
    end
    raise StorageError, "Company artifact quota exhausted" if company_bytes + estimate > positive_limit("company_quota_bytes")
    estimate
  end

  def mark_owned!(execution:, path:)
    raise StorageError, "Invalid managed clone path" unless owned_path?(path, execution: execution)
    marker = { "execution_id" => execution.id, "operation_id" => execution.operation_id, "epoch" => execution.epoch.to_s }
    File.open(marker_path(path), File::WRONLY | File::CREAT | File::EXCL | File::NOFOLLOW, 0o600) { |file| file.write(JSON.generate(marker)) }
  end

  # Register an authenticated backup BEFORE it is made available for restore.
  # Pins are released explicitly only when the corresponding backup is retired.
  def self.pin_backup!(company:, envelope:, backup_id:)
    raise StorageError, "Backup identity required" if backup_id.to_s.blank?
    manifest = AcBackupService.decrypt_backup(envelope)
    unless AcBackupService.verify_manifest(manifest) && manifest.dig("header", "company_id") == company.id && manifest.dig("header", "redacted") == false
      raise StorageError, "Invalid backup reference"
    end
    AcArtifactRetentionReference.transaction do
      manifest.fetch("entities").fetch("ac_executions").each do |record|
        next if record["worktree_path"].blank? || record.dig("metadata", "artifact_collected_at").present?
        execution = AcExecution.where(company: company).find(record.fetch("id"))
        execution.lock!
        if execution.metadata["artifact_collected_at"].present?
          raise StorageError, "Backup references a collected artifact"
        end
        reference = AcArtifactRetentionReference.create_or_find_by!(backup_id: backup_id, ac_execution: execution) do |row|
          row.manifest_digest = manifest.fetch("root_digest")
        end
        raise StorageError, "Backup identity reused" unless reference.manifest_digest == manifest.fetch("root_digest")
      end
    end
  end

  def self.retire_backup!(company:, backup_id:)
    AcArtifactRetentionReference.where(backup_id: backup_id, ac_execution_id: AcExecution.where(company: company).select(:id)).delete_all
  end

  # No discovery/deletion of unowned paths. Uncertain, active, backup-pinned or
  # journal-referenced artifacts are kept. Even eligible candidates need fresh
  # runtime proof that EVERY writer of the task stopped before deleting anything.
  def collect!(dry_run: true, now: Time.current)
    raise StorageError, "GC is disabled" unless dry_run || @config["gc_enabled"] == true
    cutoff = now - positive_limit("retention_days").days
    AcExecution.where(state: %w[completed failed cancelled]).where("finished_at < ?", cutoff).where.not(worktree_path: nil).find_each.filter_map do |candidate|
      AcExecutionFence.synchronize(candidate, validate: false) do
        synchronize do
          next unless eligible?(candidate, cutoff)
          path = candidate.worktree_path
          if dry_run
            { execution_id: candidate.id, path: path, action: "would_delete" }
          else
            # Keep the database record and receipt metadata as the deletion audit.
            FileUtils.remove_entry_secure(path)
            File.unlink(marker_path(path))
            candidate.update!(metadata: candidate.metadata.merge("artifact_collected_at" => now.iso8601, "collected_artifact_path" => path))
            { execution_id: candidate.id, path: path, action: "deleted" }
          end
        end
      end
    end
  end

  private

  def eligible?(execution, cutoff)
    return false unless %w[completed failed cancelled].include?(execution.state.to_s) && execution.finished_at && execution.finished_at < cutoff
    return false unless %w[integrated failed cancelled].include?(execution.ac_task.state.to_s) && execution.worktree_lease_token.nil?
    return false unless owned_path?(execution.worktree_path, execution: execution) && File.directory?(execution.worktree_path)
    return false if AcArtifactRetentionReference.where(ac_execution: execution).exists?
    return false if AcIntegrationOperation.where(ac_task_id: execution.ac_task_id).exists?
    # Other reviewer/QA clones may still refer to the source even after its task
    # reaches a terminal state; preserve it until those references are retired.
    return false if AcExecution.where.not(id: execution.id).where("metadata ->> 'source_repository' = ?", execution.worktree_path).exists?
    expected = { "execution_id" => execution.id, "operation_id" => execution.operation_id, "epoch" => execution.epoch.to_s }
    marker = File.open(marker_path(execution.worktree_path), File::RDONLY | File::NOFOLLOW | File::NONBLOCK) do |file|
      return false unless file.stat.file? && file.stat.size <= 4096
      JSON.parse(file.read)
    end
    return false unless marker == expected
    execution.ac_task.ac_executions.all? do |writer|
      next false unless %w[completed failed cancelled].include?(writer.state.to_s) && writer.worktree_lease_token.nil?
      receipt = AcRuntimeSupervisorService.status!(execution: writer)
      %w[completed failed not_started].include?(receipt["state"])
    end
  rescue SystemCallError, JSON::ParserError, AcRuntimeSupervisorService::UnavailableError, AcRuntimeSupervisorService::UnverifiedReceiptError
    false
  end

  def marker_path(path)
    File.join(File.dirname(path), ".#{File.basename(path)}#{MARKER}")
  end

  def owned_path?(path, execution: nil)
    return false unless path.is_a?(String) && !File.symlink?(path)
    expanded = File.expand_path(path)
    relative = expanded.delete_prefix(@root + "/")
    return false unless relative.match?(/\A[1-9][0-9]*\/[a-f0-9]{64}\z/)
    return false if execution && relative.split("/").first != execution.ac_task_id.to_s
    return false if File.symlink?(File.dirname(expanded))
    !File.exist?(expanded) || File.realpath(expanded) == expanded
  end

  def positive_limit(name)
    value = @config.fetch(name)
    raise StorageError, "Invalid storage setting #{name}" unless value.is_a?(Integer) && value.positive?
    value
  end

  def directory_bytes(path)
    out, _, status = Open3.capture3({ "PATH" => "/usr/bin:/bin", "LANG" => "C" }, "du", "-sk", "--", path, unsetenv_others: true)
    raise StorageError, "Cannot measure artifact usage" unless status.success? && out.match?(/\A[0-9]+\s/)
    out.to_i * 1024
  end

  def free_bytes
    out, _, status = Open3.capture3({ "PATH" => "/usr/bin:/bin", "LANG" => "C" }, "df", "-Pk", "--", @root, unsetenv_others: true)
    fields = out.lines.last.to_s.split
    raise StorageError, "Cannot measure free disk" unless status.success? && fields[3].to_s.match?(/\A[0-9]+\z/)
    fields[3].to_i * 1024
  end
end
