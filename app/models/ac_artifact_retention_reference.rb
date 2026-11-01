# frozen_string_literal: true

class AcArtifactRetentionReference < ApplicationRecord
  belongs_to :ac_execution
end
