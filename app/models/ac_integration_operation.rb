# frozen_string_literal: true

class AcIntegrationOperation < ApplicationRecord
  belongs_to :ac_task
  validates :identity, presence: true
  validates :state, inclusion: { in: %w[prepared git_applied completed uncertain] }
end
