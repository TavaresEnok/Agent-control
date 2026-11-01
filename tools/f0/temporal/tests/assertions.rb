# frozen_string_literal: true

# Assertions without autorun: each standalone script owns its execution and exit.
require "minitest"
extend Minitest::Assertions
class << self
  attr_accessor :assertions
end
self.assertions = 0
