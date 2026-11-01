# frozen_string_literal: true

require "test_helper"

class AcLocalCapacityConcurrencyTest < ActiveSupport::TestCase
  self.use_transactional_tests = false

  test "four simultaneous requests cannot exceed an empty account limit" do
    assert_operator ActiveRecord::Base.connection_pool.size, :>=, 4, "Concurrency proof needs four database connections"
    company = create(:company)
    user = create(:user, company: company)
    project = create(:project, company: company, owner: user)
    credential = create(:agent_credential, company: company, user: user, agent_type: "claude_code")
    context = AcWorkContext.create!(company: company, project: project, external_id: SecureRandom.uuid, title: "Context")
    plan = AcPlan.create!(company: company, project: project, ac_work_context: context,
      plan_key: SecureRandom.uuid, version: 1, title: "Plan", objective: "Concurrent admissions")
    task = AcTask.create!(company: company, project: project, ac_plan: plan, task_key: SecureRandom.uuid,
      title: "Task", position: 1, state: :pending)
    revision = AcPolicyRevision.create!(company: company, revision_number: 1, content_hash: SecureRandom.hex(16),
      content: { "model_chain" => [ "claude-sonnet-4.6" ], "effort_limits" => { "max" => "high" },
                 "active_accounts" => [], "chain_rules" => [] }, validation_result: {}, state: :draft, apply_mode: :next_attempts)
    profile = AcExecutionProfile.create!(company: company, ac_policy_revision: revision,
      profile_key: "concurrent_#{SecureRandom.hex(4)}", role: :programmer, cli_adapter: :claude_code,
      model_id: "claude-sonnet-4.6", effort_level: :medium, chain_position: 1, state: :active, agent_credential: credential)
    old_accounts = Rails.application.config.try(:ac_local_capacity_accounts)
    old_identities = Rails.application.config.try(:ac_capacity_account_identities)
    old_authority = Rails.application.config.try(:ac_capacity_authority_id)
    Rails.application.config.ac_capacity_authority_id = "test-authority"
    Rails.application.config.ac_capacity_account_identities = {
      credential.id => { "account_key" => "sha256:#{Digest::SHA256.hexdigest("fixture-#{credential.id}")}",
        "authority_id" => "test-authority", "ownership" => "exclusive_local" }
    }
    Rails.application.config.ac_local_capacity_accounts = {
      AcLocalCapacityAuthorityService.account_key(credential) => { "mode" => "local", "limit" => 1 }
    }
    ready = Queue.new
    start = Queue.new
    results = Queue.new
    ActiveRecord::Base.connection_pool.release_connection
    threads = 4.times.map do |number|
      Thread.new do
        ActiveRecord::Base.connection_pool.with_connection do
          ready << true
          start.pop
          begin
            AcCapacityGrant.grant_atomically!(company: company, ac_task: task, ac_execution_profile: profile,
              agent_credential: credential, operation_id: "#{task.id}-concurrent-#{number}", epoch: "1",
              policy_revision_id: revision.id, policy_revision_number: revision.revision_number)
            results << :granted
          rescue AcCapacityGrant::LimitExceededError
            results << :denied
          end
        end
      end
    end
    Timeout.timeout(30) { 4.times { ready.pop } }
    4.times { start << true }
    threads.each(&:value)
    outcomes = 4.times.map { results.pop }
    assert_equal 1, outcomes.count(:granted)
    assert_equal 3, outcomes.count(:denied)
    assert_equal 1, AcCapacityGrant.where(ac_task: task).active_or_granted.sum(:quantity)
  ensure
    threads&.each { |thread| thread.kill if thread.alive? }
    Rails.application.config.ac_local_capacity_accounts = old_accounts
    Rails.application.config.ac_capacity_account_identities = old_identities
    Rails.application.config.ac_capacity_authority_id = old_authority
    context&.destroy!
    revision&.destroy!
    credential&.destroy!
    Project.unscoped.where(id: project.id).delete_all if project
    if user
      user.company_memberships.delete_all
      UserIdentity.where(user_id: user.id).delete_all
      UserSession.where(user_id: user.id).delete_all
      user.delete
    end
    if company
      CompanyAuthPolicy.where(company_id: company.id).delete_all
      IdentityProvider.where(company_id: company.id).delete_all
      company.delete
    end
  end
end
