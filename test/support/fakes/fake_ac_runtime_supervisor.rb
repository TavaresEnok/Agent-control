# frozen_string_literal: true

class FakeAcRuntimeSupervisor
  attr_reader :receipts

  def initialize
    @receipts = {}
  end

  def dispatch!(execution:, **)
    receipts[execution.id]&.deep_dup
  end

  alias status! dispatch!

  def verify_receipt!(execution:, receipt:)
    receipt.present? && receipt == receipts[execution.id]
  end
end
