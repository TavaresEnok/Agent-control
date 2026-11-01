# frozen_string_literal: true

class UsageStatisticsEventReceipt < ApplicationRecord
  belongs_to :terminal_session
end
