# frozen_string_literal: true

class AcRemoteOperation < ApplicationRecord
  STATES = %w[pending running completed failed uncertain cancelled].freeze
  TERMINAL_STATES = %w[completed failed uncertain cancelled].freeze

  belongs_to :company
  belongs_to :project
  belongs_to :ac_remote_environment
  belongs_to :ac_task, optional: true
  belongs_to :ac_execution, optional: true

  validates :operation_id, presence: true, uniqueness: true
  validates :command, presence: true
  validates :working_directory, presence: true
  validates :state, inclusion: { in: STATES }

  scope :pending, -> { where(state: "pending") }
  scope :running, -> { where(state: "running") }
  scope :completed, -> { where(state: "completed") }
  scope :failed, -> { where(state: "failed") }
  scope :uncertain, -> { where(state: "uncertain") }
  scope :cancelled, -> { where(state: "cancelled") }
  scope :terminal, -> { where(state: TERMINAL_STATES) }

  def terminal?
    TERMINAL_STATES.include?(state)
  end

  def mark_running!(remote_job_id:)
    update!(
      state: "running",
      remote_job_id: remote_job_id,
      started_at: started_at || Time.current
    )
  end

  def mark_completed!(exit_code: 0, output: nil, error: nil)
    update!(
      state: "completed",
      exit_code: exit_code,
      output_log: output,
      error_log: error,
      finished_at: Time.current
    )
  end

  def mark_failed!(exit_code:, output: nil, error: nil)
    update!(
      state: "failed",
      exit_code: exit_code,
      output_log: output,
      error_log: error,
      finished_at: Time.current
    )
  end

  def mark_uncertain!(reason:, error: nil)
    combined_err = [error_log, error, "UNCERTAIN: #{reason}"].compact.reject(&:blank?).join("\n")
    update!(
      state: "uncertain",
      error_log: combined_err,
      metadata: (metadata || {}).merge(
        "uncertain_reason" => reason,
        "marked_uncertain_at" => Time.current.iso8601
      )
    )
  end

  def mark_cancelled!(reason: nil)
    update!(
      state: "cancelled",
      finished_at: Time.current,
      metadata: (metadata || {}).merge(
        "cancellation_reason" => reason,
        "cancelled_at" => Time.current.iso8601
      )
    )
  end
end
