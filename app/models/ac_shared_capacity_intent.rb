# frozen_string_literal: true

class AcSharedCapacityIntent < ApplicationRecord
  belongs_to :company
  belongs_to :ac_task
  belongs_to :ac_execution_profile
  belongs_to :agent_credential
end
