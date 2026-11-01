# frozen_string_literal: true

require "test_helper"

class IsolatedAcDatabaseTest < ActiveSupport::TestCase
  self.use_transactional_tests = false

  test "a completed isolated run preserves later transactions across migration checks" do
    runner_class = Class.new do
      def run
        :completed
      end
      prepend IsolatedAcDatabase
    end
    original_config = ActiveRecord::Base.connection_pool.db_config

    assert_equal :completed, runner_class.new.run
    assert_same original_config, ActiveRecord::Base.connection_pool.db_config

    ActiveRecord::Base.transaction do
      company = create(:company)
      Tools::Reconciler.materialize!
      assert Company.exists?(company.id), "migration checks must preserve the open transaction"
      raise ActiveRecord::Rollback
    end
  end
end
