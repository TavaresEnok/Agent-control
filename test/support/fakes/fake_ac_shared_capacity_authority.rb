# frozen_string_literal: true

class FakeAcSharedCapacityAuthority
  attr_accessor :receipt, :verified
  attr_reader :requests

  def initialize
    @requests = []
    @verified = false
  end

  def reserve_shared!(**args)
    @requests << args
    receipt
  end

  def verify_shared_receipt!(**)
    verified
  end
end
