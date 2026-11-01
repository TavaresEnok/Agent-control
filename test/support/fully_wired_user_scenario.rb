# frozen_string_literal: true

# A user with a row behind every foreign key that reaches them: the tables that
# point at the user, and the tables that point at rows deleted along with them.
# Rows that outlive the user (history, authorship) belong to someone else's
# record — `heir`'s session, `heir`'s project — so a test can tell a nullified
# reference from a deleted row.
#
#   FullyWiredUserScenario.new(user:, company:, heir:).build
class FullyWiredUserScenario
  include FactoryBot::Syntax::Methods

  def initialize(user:, company:, heir:)
    @user = user
    @company = company
    @heir = heir
  end

  def build
    @project = create(:project, company: @company, owner: @heir)
    create(:project, company: @company, owner: @user)
    build_personal_data
    build_sign_ins
    build_board
    build_workflow
    build_agent_control
    build_company_records
    self
  end

  private

  def build_personal_data
    @credential = create(:agent_credential, user: @user, company: @company)
    @user.company_memberships.find_by!(company: @company).update!(default_agent_credential: @credential)
    create(:company_membership, company: @company, invited_by: @user)
    create(:project_collaborator, project: @project, user: @user)
    create(:project_favorite, project: @project, user: @user)
    OauthCredential.create!(owner: @user, provider: "sentry", status: :active, access_token: "at-mine", oauth_client: oauth_client)
    OauthCredential.create!(owner: @project, connected_by: @user, provider: "sentry", status: :active,
                            access_token: "at-project", oauth_client: oauth_client)
  end

  def build_sign_ins
    provider = create(:identity_provider, company: @company)
    create(:user_identity, user: @user, identity_provider: provider)
    Auth::SessionService.record_proof(UserSession.start!(user: @user), provider)
    UserSession.start!(user: @heir, impersonator: @user)
    MagicLinkToken.issue!(@user)
    WebauthnCredential.create!(user: @user, external_id: "passkey-1", public_key: "public-key")
    ChatIdentity.create!(provider: "slack", workspace_id: "T1", external_user_id: "U1", user: @user,
                         proof: "slack_sign_in", linked_at: Time.current)
    YoutrackPairing.start!(instance_url: "https://acme.youtrack.cloud", project: @project, user: @user)
  end

  def build_board
    @board = create(:board, project: @project)
    @column = create(:board_column, board: @board)
    task = create(:board_task, board: @board, board_column: @column, assignee: @user)
    BoardActivity.create!(board: @board, event_type: :task_created, actor: @user, actor_type: :human)
    ColumnTransition.create!(board_task: task, to_column: @column, actor: @user, actor_type: :human)
    BoardViewPreset.create!(board: @board, user: @user, name: "Mine", filters: { "state" => "active" })
    create(:task_comment, board_task: task, author: @user)
    create(:task_asset, board_task: task, author: @user, shared_by: @user)
    Gate.create!(board_task: task, creator: @user, gate_type: "github_checks_completed")
    create(:folder, path: "docs", scope: @project, created_by: @user)
  end

  def build_workflow
    workflow = create(:workflow, scope: @project, published_by: @user, published_at: Time.current)
    EntityVersion.create!(versionable: workflow, project_id: @project.id, company_id: @company.id, author: @user,
                          event: "created", source: "ui", number: 1)
    ColumnWorkflowBinding.create!(board_column: @column, workflow: workflow, created_by: @user)
    create(:trigger_binding, project: @project, workflow: workflow, created_by: @user)
    create(:trigger_event, actor: @user, event_type: "webhook.deploy", source: "webhook", project: @project,
                           company: @company)
    WebhookEndpoint.create_for_trigger!(project: @project, created_by: @user)
    TemplateInstall.create!(project: @project, installed_by: @user, namespace: "aixle", slug: "starter", version: 1,
                            commit_sha: "abc123", package_digest: "digest", idempotency_key: "install-1")

    run = create(:workflow_run, :completed, workflow: workflow, project: @project, user: @user)
    create(:workflow_run, :failed, workflow: workflow, project: @project, user: @heir,
                                   failed_agent_credential: @credential)
    create(:workflow_run_asset, workflow_run: run, shared_by: @user)
    create(:terminal_session, :agent_session, user: @user, project: @project, state: "finished")

    asset = create(:asset, scope: @project, created_by: @user, shared_by: @user)
    create(:asset_version, asset: asset, uploaded_by: @user)
  end

  def build_agent_control
    context = AcWorkContext.create!(company: @company, project: @project, external_id: SecureRandom.uuid, title: "History")
    plan = AcPlan.create!(company: @company, project: @project, ac_work_context: context,
      plan_key: SecureRandom.uuid, title: "History", version: 1, state: :draft)
    task = AcTask.create!(company: @company, project: @project, ac_plan: plan, task_key: "history", title: "History")
    policy = AcPolicyRevision.create!(company: @company, revision_number: 1, content_hash: SecureRandom.hex(32),
      state: :draft, content: { "model_chain" => [ "fixture" ], "active_accounts" => [], "chain_rules" => [], "effort_limits" => {} })
    profile = AcExecutionProfile.create!(company: @company, ac_policy_revision: policy, profile_key: "history",
      role: "programmer", cli_adapter: "claude_code", model_id: "fixture", agent_credential: @credential, effort_level: "medium")
    operation_id = SecureRandom.uuid
    grant = AcCapacityGrant.create!(company: @company, ac_task: task, ac_execution_profile: profile,
      agent_credential: @credential, operation_id: operation_id, epoch: "1", state: "released",
      policy_revision_id: policy.id, policy_revision_number: 1)
    execution = AcExecution.create!(company: @company, ac_task: task, ac_work_context: context, ac_execution_profile: profile,
      ac_capacity_grant: grant, operation_id: operation_id, epoch: "1", state: "completed")
    AcReviewVerdict.create!(company: @company, project: @project, ac_task: task, ac_execution: execution,
      reviewer_role: "reviewer", verdict: "approved", artifact_hash: "fixture", evaluator_identity: "fixture")
    environment = AcRemoteEnvironment.create!(company: @company, project: @project, name: "Fixture", environment_slug: "fixture",
      host: "localhost", port: 22, user: "worker", fingerprint: "fixture", identity_key_path: "/fixture/key",
      known_hosts_path: "/fixture/hosts", authorized_directories: [ "/fixture" ], state: "active")
    AcRemoteOperation.create!(company: @company, project: @project, ac_remote_environment: environment, ac_task: task,
      ac_execution: execution, operation_id: SecureRandom.uuid, command: "true", working_directory: "/fixture", state: "completed")
    AcArtifactRetentionReference.create!(ac_execution: execution, backup_id: "fixture", manifest_digest: "fixture")
    AcQuotaObservation.create!(company: @company, agent_credential: @credential, cli_adapter: "claude_code",
      model_scope: "fixture", quota_state: :available, confidence_level: :high, origin: :api_header, observed_at: Time.current)
    AcSharedCapacityIntent.create!(company: @company, ac_task: task, ac_execution_profile: profile, agent_credential: @credential,
      operation_id: SecureRandom.uuid, account_key: "sha256:#{'a' * 64}", host_id: "fixture", authority_id: "fixture",
      epoch: "1", quantity: 1, broker_grant_id: "fixture", state: "released")
    AcClientCommand.create!(company: @company, user: @user, intent_id: SecureRandom.uuid, command_type: "fixture")
    event = create(:trigger_event, actor: @user, event_type: "fixture", source: "fixture", project: @project, company: @company)
    AcNotificationReceipt.create!(trigger_event: event, user: @user)
  end

  def build_company_records
    create(:integration, company: @company, connected_by: @user)
    create(:runner, :manual, company: @company, created_by: @user)
    create(:azure_devops_installation, company: @company, approved_by: @user, approved_at: Time.current)
    create(:bitbucket_installation, :bound, company: @company, bound_by: @user)
    create(:billing_cancellation, company: @company, user: @user)
    create(:feedback_submission, company: @company, user: @user)
    conversation = ChatChannelTestHelper.connect_chat_channel(company: @company)
    ChatChannelConnection.find_by!(chat_conversation: conversation, company: @company).update!(requested_by: @user)
    ChatConnectCode.issue!(project: @project, provider: "slack", user: @user, channel: "#deploys")
    flag = FeatureFlag.create!(key: "external_runners", enabled: true, updated_by: @user)
    flag.overrides.create!(company: @company, enabled: false, reason: "asked to wait", created_by: @user)
  end

  def oauth_client
    @oauth_client ||= OauthClient.create!(issuer: "https://sentry.io", client_id: "c", source: "static",
                                          authorization_endpoint: "https://sentry.io/a",
                                          token_endpoint: "https://sentry.io/t")
  end
end
