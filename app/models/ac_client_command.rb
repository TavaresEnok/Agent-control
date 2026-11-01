# frozen_string_literal: true

class AcClientCommand < ApplicationRecord
  STATES = %w[received processing processed failed].freeze

  belongs_to :company
  belongs_to :user, optional: true

  validates :intent_id, presence: true, uniqueness: true
  validates :command_type, presence: true
  validates :state, inclusion: { in: STATES }

  scope :processed, -> { where(state: "processed") }
  scope :failed, -> { where(state: "failed") }

  def processed?
    state == "processed"
  end

  def mark_processing!
    update!(state: "processing")
  end

  def mark_processed!(result_payload:)
    update!(
      state: "processed",
      result: result_payload || {},
      processed_at: Time.current
    )
  end

  def mark_failed!(error_message:)
    update!(
      state: "failed",
      error_message: error_message,
      processed_at: Time.current
    )
  end
end
