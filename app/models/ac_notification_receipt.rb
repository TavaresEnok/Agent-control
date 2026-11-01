# frozen_string_literal: true

class AcNotificationReceipt < ApplicationRecord
  belongs_to :trigger_event
  belongs_to :user
end
