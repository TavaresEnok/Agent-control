# frozen_string_literal: true

class AcCapacityBrokerReservation < ApplicationRecord
  validates :operation_id, :account_key, :state, presence: true
end
