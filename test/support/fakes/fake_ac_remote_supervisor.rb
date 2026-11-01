# frozen_string_literal: true

class FakeAcRemoteSupervisor
  attr_accessor :receipt, :verified
  attr_reader :dispatch_calls

  def initialize
    @dispatch_calls = 0
    @verified = false
  end

  def dispatch_operation!(**)
    @dispatch_calls += 1
    receipt
  end

  def query_operation_status!(**)
    receipt
  end

  def verify_operation_receipt!(**)
    verified
  end
end
