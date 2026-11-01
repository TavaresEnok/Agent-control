# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2026_11_01_140201) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "citext"
  enable_extension "pg_catalog.plpgsql"

  create_table "ac_artifact_retention_references", force: :cascade do |t|
    t.bigint "ac_execution_id", null: false
    t.string "backup_id", null: false
    t.string "manifest_digest", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["ac_execution_id"], name: "index_ac_artifact_retention_references_on_ac_execution_id"
    t.index ["backup_id", "ac_execution_id"], name: "index_ac_retention_refs_on_backup_and_execution", unique: true
  end

  create_table "ac_capacity_broker_nonces", force: :cascade do |t|
    t.string "digest", null: false
    t.datetime "created_at", null: false
    t.index ["digest"], name: "index_ac_capacity_broker_nonces_on_digest", unique: true
  end

  create_table "ac_capacity_broker_reservations", force: :cascade do |t|
    t.string "operation_id", null: false
    t.string "account_key", null: false
    t.string "authority_id", null: false
    t.string "host_id", null: false
    t.string "epoch", null: false
    t.integer "quantity", null: false
    t.string "state", null: false
    t.string "grant_id"
    t.jsonb "release_evidence", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["account_key", "state"], name: "index_ac_broker_reservations_on_account_state"
    t.index ["operation_id"], name: "index_ac_broker_reservations_on_operation", unique: true
    t.check_constraint "quantity > 0", name: "ac_broker_positive_quantity"
    t.check_constraint "state::text = ANY (ARRAY['reserved'::character varying, 'bound'::character varying, 'released'::character varying, 'denied'::character varying]::text[])", name: "ac_broker_valid_state"
  end

  create_table "ac_capacity_grants", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.bigint "ac_task_id", null: false
    t.bigint "ac_execution_profile_id", null: false
    t.bigint "agent_credential_id", null: false
    t.string "operation_id", null: false
    t.string "epoch", null: false
    t.string "state", default: "pending", null: false
    t.integer "quantity", default: 1, null: false
    t.string "resource_type", default: "inference_slot", null: false
    t.bigint "policy_revision_id", null: false
    t.integer "policy_revision_number", null: false
    t.datetime "granted_at"
    t.datetime "expires_at"
    t.datetime "released_at"
    t.string "revoke_reason"
    t.string "external_process_id"
    t.jsonb "reconciliation_data", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["ac_execution_profile_id"], name: "index_ac_capacity_grants_on_ac_execution_profile_id"
    t.index ["ac_task_id", "state"], name: "index_ac_capacity_grants_on_ac_task_id_and_state"
    t.index ["ac_task_id"], name: "index_ac_capacity_grants_on_ac_task_id"
    t.index ["agent_credential_id", "state"], name: "index_ac_capacity_grants_on_agent_credential_id_and_state"
    t.index ["agent_credential_id"], name: "index_ac_capacity_grants_on_agent_credential_id"
    t.index ["company_id", "state"], name: "index_ac_capacity_grants_on_company_id_and_state"
    t.index ["company_id"], name: "index_ac_capacity_grants_on_company_id"
    t.index ["epoch"], name: "index_ac_capacity_grants_on_epoch"
    t.index ["expires_at"], name: "index_ac_capacity_grants_on_expires_at", where: "((state)::text = ANY ((ARRAY['granted'::character varying, 'active'::character varying])::text[]))"
    t.index ["operation_id"], name: "index_ac_capacity_grants_on_operation_id", unique: true
    t.index ["state"], name: "index_ac_capacity_grants_on_state"
    t.check_constraint "quantity > 0", name: "ac_capacity_grants_positive_qty"
    t.check_constraint "resource_type::text = ANY (ARRAY['inference_slot'::character varying, 'worktree'::character varying, 'disk_mb'::character varying, 'process'::character varying]::text[])", name: "ac_capacity_grants_valid_resource"
    t.check_constraint "state::text = ANY (ARRAY['pending'::character varying, 'granted'::character varying, 'active'::character varying, 'released'::character varying, 'expired'::character varying, 'revoked'::character varying]::text[])", name: "ac_capacity_grants_valid_state"
  end

  create_table "ac_client_commands", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.bigint "user_id"
    t.string "intent_id", null: false
    t.string "command_type", null: false
    t.jsonb "payload", default: {}, null: false
    t.string "state", default: "received", null: false
    t.jsonb "result", default: {}, null: false
    t.text "error_message"
    t.datetime "processed_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["company_id", "command_type"], name: "index_ac_client_commands_on_company_id_and_command_type"
    t.index ["company_id", "intent_id"], name: "index_ac_client_commands_on_company_id_and_intent_id", unique: true
    t.index ["company_id"], name: "index_ac_client_commands_on_company_id"
    t.index ["state"], name: "index_ac_client_commands_on_state"
    t.index ["user_id"], name: "index_ac_client_commands_on_user_id"
  end

  create_table "ac_decision_audit_events", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.bigint "project_id", null: false
    t.string "event_type", null: false
    t.bigint "ac_work_context_id"
    t.bigint "ac_plan_id"
    t.bigint "ac_task_id"
    t.bigint "ac_execution_profile_id"
    t.bigint "ac_capacity_grant_id"
    t.bigint "ac_policy_revision_id"
    t.bigint "agent_credential_id"
    t.string "actor_type", null: false
    t.bigint "actor_user_id"
    t.jsonb "decision_details", default: {}, null: false
    t.string "previous_state"
    t.string "new_state"
    t.text "reason"
    t.datetime "occurred_at", null: false
    t.string "execution_epoch"
    t.jsonb "metadata", default: {}, null: false
    t.datetime "created_at", null: false
    t.index ["ac_task_id", "occurred_at"], name: "index_ac_decision_audit_events_on_ac_task_id_and_occurred_at", where: "(ac_task_id IS NOT NULL)"
    t.index ["ac_work_context_id", "occurred_at"], name: "idx_on_ac_work_context_id_occurred_at_18a3dac39d", where: "(ac_work_context_id IS NOT NULL)"
    t.index ["actor_type"], name: "index_ac_decision_audit_events_on_actor_type"
    t.index ["agent_credential_id"], name: "index_ac_decision_audit_events_on_agent_credential_id", where: "(agent_credential_id IS NOT NULL)"
    t.index ["company_id", "occurred_at"], name: "index_ac_decision_audit_events_on_company_id_and_occurred_at"
    t.index ["company_id"], name: "index_ac_decision_audit_events_on_company_id"
    t.index ["event_type"], name: "index_ac_decision_audit_events_on_event_type"
    t.index ["occurred_at"], name: "index_ac_decision_audit_events_on_occurred_at"
    t.index ["project_id"], name: "index_ac_decision_audit_events_on_project_id"
    t.check_constraint "actor_type::text = ANY (ARRAY['human'::character varying, 'manager_agent'::character varying, 'policy_service'::character varying, 'system'::character varying]::text[])", name: "ac_audit_events_valid_actor"
    t.check_constraint "event_type::text = ANY (ARRAY['profile_selected'::character varying, 'profile_rejected'::character varying, 'capacity_granted'::character varying, 'capacity_denied'::character varying, 'capacity_revoked'::character varying, 'policy_published'::character varying, 'policy_revoked'::character varying, 'quota_state_changed'::character varying, 'task_state_changed'::character varying, 'human_intervention'::character varying, 'profile_substitution'::character varying]::text[])", name: "ac_audit_events_valid_type"
  end

  create_table "ac_execution_profiles", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.bigint "ac_policy_revision_id", null: false
    t.string "profile_key", null: false
    t.string "role", null: false
    t.string "cli_adapter", null: false
    t.string "model_id", null: false
    t.string "effort_level", default: "medium", null: false
    t.bigint "agent_credential_id"
    t.integer "chain_position", default: 1, null: false
    t.string "permanence_rule", default: "permanent", null: false
    t.string "state", default: "active", null: false
    t.string "ineligibility_reason"
    t.jsonb "permissions", default: {}, null: false
    t.jsonb "limits", default: {}, null: false
    t.jsonb "selection_criteria", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["ac_policy_revision_id", "profile_key"], name: "idx_ac_exec_profiles_revision_key", unique: true
    t.index ["ac_policy_revision_id"], name: "index_ac_execution_profiles_on_ac_policy_revision_id"
    t.index ["agent_credential_id"], name: "index_ac_execution_profiles_on_agent_credential_id", where: "(agent_credential_id IS NOT NULL)"
    t.index ["company_id", "cli_adapter", "state"], name: "idx_on_company_id_cli_adapter_state_eacf3ea1ee"
    t.index ["company_id", "role", "state"], name: "index_ac_execution_profiles_on_company_id_and_role_and_state"
    t.index ["company_id"], name: "index_ac_execution_profiles_on_company_id"
    t.index ["role", "chain_position"], name: "index_ac_execution_profiles_on_role_and_chain_position"
    t.index ["state"], name: "index_ac_execution_profiles_on_state"
    t.check_constraint "chain_position > 0", name: "ac_exec_profiles_positive_chain"
    t.check_constraint "cli_adapter::text = ANY (ARRAY['codex_cli'::character varying, 'claude_code'::character varying, 'grok_cli'::character varying, 'antigravity_cli'::character varying]::text[])", name: "ac_exec_profiles_valid_cli"
    t.check_constraint "effort_level::text = ANY (ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying]::text[])", name: "ac_exec_profiles_valid_effort"
    t.check_constraint "permanence_rule::text = ANY (ARRAY['permanent'::character varying, 'return_to_principal'::character varying, 'conclude_and_yield'::character varying]::text[])", name: "ac_exec_profiles_valid_permanence"
    t.check_constraint "role::text = ANY (ARRAY['manager'::character varying, 'programmer'::character varying, 'reviewer'::character varying, 'qa'::character varying, 'specialist'::character varying, 'integrator'::character varying]::text[])", name: "ac_exec_profiles_valid_role"
    t.check_constraint "state::text = ANY (ARRAY['active'::character varying, 'disabled'::character varying, 'deprecated'::character varying]::text[])", name: "ac_exec_profiles_valid_state"
  end

  create_table "ac_executions", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.bigint "ac_task_id", null: false
    t.bigint "ac_work_context_id", null: false
    t.bigint "ac_execution_profile_id"
    t.bigint "ac_capacity_grant_id"
    t.string "operation_id", null: false
    t.string "epoch", null: false
    t.string "state", default: "pending", null: false
    t.string "process_handle"
    t.string "worktree_lease_token"
    t.string "worktree_path"
    t.string "temporal_workflow_id"
    t.string "temporal_run_id"
    t.datetime "heartbeat_at"
    t.datetime "started_at"
    t.datetime "finished_at"
    t.integer "exit_code"
    t.jsonb "output_payload", default: {}, null: false
    t.jsonb "error_details", default: {}, null: false
    t.jsonb "metadata", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["ac_capacity_grant_id"], name: "index_ac_executions_on_ac_capacity_grant_id"
    t.index ["ac_execution_profile_id"], name: "index_ac_executions_on_ac_execution_profile_id"
    t.index ["ac_task_id", "state"], name: "index_ac_executions_on_ac_task_id_and_state"
    t.index ["ac_task_id"], name: "index_ac_executions_on_ac_task_id"
    t.index ["ac_work_context_id"], name: "index_ac_executions_on_ac_work_context_id"
    t.index ["company_id", "state"], name: "index_ac_executions_on_company_id_and_state"
    t.index ["company_id"], name: "index_ac_executions_on_company_id"
    t.index ["epoch"], name: "index_ac_executions_on_epoch"
    t.index ["operation_id"], name: "index_ac_executions_on_operation_id", unique: true
    t.index ["process_handle"], name: "index_ac_executions_on_process_handle"
    t.index ["worktree_lease_token"], name: "index_ac_executions_on_worktree_lease_token"
    t.check_constraint "state::text = ANY (ARRAY['pending'::character varying, 'granted'::character varying, 'preparing'::character varying, 'running'::character varying, 'paused'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying, 'uncertain'::character varying]::text[])", name: "ac_executions_valid_state"
  end

  create_table "ac_integration_operations", force: :cascade do |t|
    t.bigint "ac_task_id", null: false
    t.string "identity", null: false
    t.string "state", default: "prepared", null: false
    t.string "base_commit", null: false
    t.string "candidate_commit", null: false
    t.string "artifact_hash", null: false
    t.string "branch_ref", null: false
    t.jsonb "evidence", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["ac_task_id"], name: "index_ac_integration_operations_on_ac_task_id"
    t.index ["identity"], name: "index_ac_integration_operations_on_identity", unique: true
  end

  create_table "ac_notification_receipts", force: :cascade do |t|
    t.bigint "trigger_event_id", null: false
    t.bigint "user_id", null: false
    t.datetime "read_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["trigger_event_id", "user_id"], name: "index_ac_notification_receipts_on_event_user", unique: true
    t.index ["trigger_event_id"], name: "index_ac_notification_receipts_on_trigger_event_id"
    t.index ["user_id"], name: "index_ac_notification_receipts_on_user_id"
  end

  create_table "ac_plans", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.bigint "project_id", null: false
    t.bigint "ac_work_context_id", null: false
    t.string "plan_key", null: false
    t.integer "version", default: 1, null: false
    t.string "title", null: false
    t.text "objective"
    t.string "state", default: "draft", null: false
    t.string "content_hash"
    t.datetime "published_at"
    t.string "created_by_type", default: "human", null: false
    t.bigint "created_by_user_id"
    t.bigint "policy_revision_id"
    t.jsonb "metadata", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["ac_work_context_id", "state"], name: "index_ac_plans_on_ac_work_context_id_and_state"
    t.index ["ac_work_context_id"], name: "index_ac_plans_on_ac_work_context_id"
    t.index ["company_id", "project_id"], name: "index_ac_plans_on_company_id_and_project_id"
    t.index ["company_id"], name: "index_ac_plans_on_company_id"
    t.index ["content_hash"], name: "index_ac_plans_on_content_hash", where: "(content_hash IS NOT NULL)"
    t.index ["plan_key", "version"], name: "index_ac_plans_on_plan_key_and_version", unique: true
    t.index ["project_id"], name: "index_ac_plans_on_project_id"
    t.index ["state"], name: "index_ac_plans_on_state"
    t.check_constraint "created_by_type::text = ANY (ARRAY['human'::character varying, 'manager_agent'::character varying, 'import'::character varying]::text[])", name: "ac_plans_valid_creator_type"
    t.check_constraint "state::text = ANY (ARRAY['draft'::character varying, 'active'::character varying, 'completed'::character varying, 'abandoned'::character varying, 'superseded'::character varying]::text[])", name: "ac_plans_valid_state"
    t.check_constraint "version > 0", name: "ac_plans_positive_version"
  end

  create_table "ac_policy_revisions", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.bigint "predecessor_id"
    t.integer "revision_number", default: 1, null: false
    t.string "state", default: "draft", null: false
    t.jsonb "diff", default: {}, null: false
    t.jsonb "content", default: {}, null: false
    t.string "content_hash", null: false
    t.jsonb "validation_result", default: {}, null: false
    t.string "apply_mode", default: "next_attempts", null: false
    t.bigint "published_by_user_id"
    t.datetime "published_at"
    t.string "revoked_reason"
    t.datetime "revoked_at"
    t.bigint "revoked_by_user_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["company_id", "revision_number"], name: "index_ac_policy_revisions_on_company_id_and_revision_number", unique: true
    t.index ["company_id", "state"], name: "index_ac_policy_revisions_on_company_id_and_state"
    t.index ["company_id"], name: "index_ac_policy_revisions_on_company_id"
    t.index ["content_hash"], name: "index_ac_policy_revisions_on_content_hash", unique: true
    t.index ["predecessor_id"], name: "index_ac_policy_revisions_on_predecessor_id"
    t.index ["state"], name: "index_ac_policy_revisions_on_state"
    t.check_constraint "apply_mode::text = ANY (ARRAY['next_attempts'::character varying, 'drain_and_switch'::character varying, 'immediate_revoke'::character varying]::text[])", name: "ac_policy_revisions_valid_apply_mode"
    t.check_constraint "revision_number > 0", name: "ac_policy_revisions_positive_revision"
    t.check_constraint "state::text = ANY (ARRAY['draft'::character varying, 'published'::character varying, 'superseded'::character varying, 'revoked'::character varying]::text[])", name: "ac_policy_revisions_valid_state"
  end

  create_table "ac_quota_observations", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.bigint "agent_credential_id", null: false
    t.string "cli_adapter", null: false
    t.string "model_scope", null: false
    t.datetime "window_start"
    t.datetime "window_end"
    t.string "quota_state", null: false
    t.jsonb "quota_data", default: {}, null: false
    t.datetime "observed_at", null: false
    t.datetime "valid_until"
    t.string "confidence_level", default: "medium", null: false
    t.string "origin", default: "cli_output", null: false
    t.text "redacted_evidence"
    t.bigint "ac_task_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["ac_task_id"], name: "index_ac_quota_observations_on_ac_task_id", where: "(ac_task_id IS NOT NULL)"
    t.index ["agent_credential_id", "observed_at"], name: "idx_on_agent_credential_id_observed_at_3b91565229"
    t.index ["agent_credential_id", "quota_state"], name: "idx_on_agent_credential_id_quota_state_195faf3798"
    t.index ["agent_credential_id"], name: "index_ac_quota_observations_on_agent_credential_id"
    t.index ["company_id", "quota_state"], name: "index_ac_quota_observations_on_company_id_and_quota_state"
    t.index ["company_id"], name: "index_ac_quota_observations_on_company_id"
    t.index ["observed_at"], name: "index_ac_quota_observations_on_observed_at"
    t.index ["valid_until"], name: "index_ac_quota_observations_on_valid_until", where: "(valid_until IS NOT NULL)"
    t.check_constraint "cli_adapter::text = ANY (ARRAY['codex_cli'::character varying, 'claude_code'::character varying, 'grok_cli'::character varying, 'antigravity_cli'::character varying]::text[])", name: "ac_quota_observations_valid_cli"
    t.check_constraint "confidence_level::text = ANY (ARRAY['high'::character varying, 'medium'::character varying, 'low'::character varying, 'snapshot_only'::character varying]::text[])", name: "ac_quota_observations_valid_confidence"
    t.check_constraint "origin::text = ANY (ARRAY['cli_output'::character varying, 'api_header'::character varying, 'synthetic_probe'::character varying, 'manual_import'::character varying]::text[])", name: "ac_quota_observations_valid_origin"
    t.check_constraint "quota_state::text = ANY (ARRAY['exhausted'::character varying, 'rate_limited'::character varying, 'auth_error'::character varying, 'network_error'::character varying, 'unknown'::character varying, 'available'::character varying]::text[])", name: "ac_quota_observations_valid_state"
  end

  create_table "ac_remote_environments", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.bigint "project_id", null: false
    t.string "name", null: false
    t.string "environment_slug", null: false
    t.string "host", null: false
    t.integer "port", default: 22, null: false
    t.string "user", null: false
    t.string "fingerprint", null: false
    t.string "identity_key_path", null: false
    t.string "known_hosts_path", null: false
    t.string "authorized_directories", default: [], null: false, array: true
    t.string "state", default: "active", null: false
    t.jsonb "metadata", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["company_id", "environment_slug"], name: "idx_ac_remote_envs_on_company_and_slug", unique: true
    t.index ["company_id"], name: "index_ac_remote_environments_on_company_id"
    t.index ["project_id"], name: "index_ac_remote_environments_on_project_id"
    t.index ["state"], name: "index_ac_remote_environments_on_state"
  end

  create_table "ac_remote_operations", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.bigint "project_id", null: false
    t.bigint "ac_remote_environment_id", null: false
    t.bigint "ac_task_id"
    t.bigint "ac_execution_id"
    t.string "operation_id", null: false
    t.text "command", null: false
    t.string "working_directory", null: false
    t.string "state", default: "pending", null: false
    t.string "remote_job_id"
    t.string "artifact_hash"
    t.integer "exit_code"
    t.text "output_log"
    t.text "error_log"
    t.datetime "started_at"
    t.datetime "finished_at"
    t.jsonb "metadata", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["ac_execution_id"], name: "index_ac_remote_operations_on_ac_execution_id"
    t.index ["ac_remote_environment_id", "state"], name: "idx_ac_remote_ops_on_env_and_state"
    t.index ["ac_remote_environment_id"], name: "index_ac_remote_operations_on_ac_remote_environment_id"
    t.index ["ac_task_id"], name: "index_ac_remote_operations_on_ac_task_id"
    t.index ["company_id"], name: "index_ac_remote_operations_on_company_id"
    t.index ["operation_id"], name: "index_ac_remote_operations_on_operation_id", unique: true
    t.index ["project_id"], name: "index_ac_remote_operations_on_project_id"
    t.index ["remote_job_id"], name: "index_ac_remote_operations_on_remote_job_id"
    t.index ["state"], name: "index_ac_remote_operations_on_state"
  end

  create_table "ac_review_verdicts", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.bigint "project_id", null: false
    t.bigint "ac_task_id", null: false
    t.bigint "ac_execution_id"
    t.string "reviewer_role", default: "reviewer", null: false
    t.string "verdict", null: false
    t.string "artifact_hash", null: false
    t.string "base_commit_hash"
    t.string "candidate_commit_sha"
    t.jsonb "findings", default: [], null: false
    t.string "evaluator_identity", null: false
    t.integer "policy_revision_number"
    t.string "state", default: "valid", null: false
    t.string "invalidation_reason"
    t.jsonb "metadata", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["ac_execution_id"], name: "index_ac_review_verdicts_on_ac_execution_id"
    t.index ["ac_task_id", "reviewer_role", "state"], name: "idx_on_ac_task_id_reviewer_role_state_9b7e43f958"
    t.index ["ac_task_id", "state"], name: "index_ac_review_verdicts_on_ac_task_id_and_state"
    t.index ["ac_task_id"], name: "index_ac_review_verdicts_on_ac_task_id"
    t.index ["artifact_hash", "state"], name: "index_ac_review_verdicts_on_artifact_hash_and_state"
    t.index ["company_id", "verdict"], name: "index_ac_review_verdicts_on_company_id_and_verdict"
    t.index ["company_id"], name: "index_ac_review_verdicts_on_company_id"
    t.index ["project_id"], name: "index_ac_review_verdicts_on_project_id"
    t.check_constraint "reviewer_role::text = ANY (ARRAY['reviewer'::character varying, 'qa'::character varying]::text[])", name: "ac_review_verdicts_valid_role"
    t.check_constraint "state::text = ANY (ARRAY['valid'::character varying, 'invalidated'::character varying, 'superseded'::character varying]::text[])", name: "ac_review_verdicts_valid_state"
    t.check_constraint "verdict::text = ANY (ARRAY['approved'::character varying, 'rejected'::character varying, 'needs_changes'::character varying, 'waived'::character varying]::text[])", name: "ac_review_verdicts_valid_verdict"
  end

  create_table "ac_shared_capacity_intents", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.bigint "ac_task_id", null: false
    t.bigint "ac_execution_profile_id", null: false
    t.bigint "agent_credential_id", null: false
    t.string "operation_id", null: false
    t.string "account_key", null: false
    t.string "host_id", null: false
    t.string "authority_id", null: false
    t.string "epoch", null: false
    t.integer "quantity", null: false
    t.string "broker_grant_id", null: false
    t.string "state", default: "prepared", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["ac_execution_profile_id"], name: "index_ac_shared_capacity_intents_on_ac_execution_profile_id"
    t.index ["ac_task_id"], name: "index_ac_shared_capacity_intents_on_ac_task_id"
    t.index ["agent_credential_id"], name: "index_ac_shared_capacity_intents_on_agent_credential_id"
    t.index ["company_id"], name: "index_ac_shared_capacity_intents_on_company_id"
    t.index ["operation_id"], name: "index_ac_shared_capacity_intents_on_operation_id", unique: true
    t.check_constraint "quantity > 0", name: "ac_shared_intents_positive_quantity"
    t.check_constraint "state::text = ANY (ARRAY['prepared'::character varying, 'reserved'::character varying, 'bound'::character varying, 'fenced'::character varying, 'released'::character varying]::text[])", name: "ac_shared_intents_valid_state"
  end

  create_table "ac_tasks", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.bigint "project_id", null: false
    t.bigint "ac_plan_id", null: false
    t.string "task_key", null: false
    t.string "title", null: false
    t.text "scope"
    t.jsonb "inputs", default: {}, null: false
    t.jsonb "outputs", default: {}, null: false
    t.text "acceptance_criteria"
    t.string "risk_class", default: "medium", null: false
    t.string "assigned_role", default: "programmer", null: false
    t.string "depends_on", default: [], null: false, array: true
    t.string "state", default: "pending", null: false
    t.integer "position", default: 0, null: false
    t.string "approved_commit_sha"
    t.string "approved_artifact_hash"
    t.integer "attempt_count", default: 0, null: false
    t.jsonb "metadata", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["ac_plan_id", "position"], name: "index_ac_tasks_on_ac_plan_id_and_position"
    t.index ["ac_plan_id", "task_key"], name: "index_ac_tasks_on_ac_plan_id_and_task_key", unique: true
    t.index ["ac_plan_id"], name: "index_ac_tasks_on_ac_plan_id"
    t.index ["approved_commit_sha"], name: "index_ac_tasks_on_approved_commit_sha", where: "(approved_commit_sha IS NOT NULL)"
    t.index ["assigned_role"], name: "index_ac_tasks_on_assigned_role"
    t.index ["company_id", "project_id", "state"], name: "index_ac_tasks_on_company_id_and_project_id_and_state"
    t.index ["company_id"], name: "index_ac_tasks_on_company_id"
    t.index ["project_id"], name: "index_ac_tasks_on_project_id"
    t.index ["state"], name: "index_ac_tasks_on_state"
    t.check_constraint "assigned_role::text = ANY (ARRAY['programmer'::character varying, 'manager'::character varying, 'qa'::character varying, 'reviewer'::character varying, 'specialist'::character varying, 'integrator'::character varying]::text[])", name: "ac_tasks_valid_role"
    t.check_constraint "attempt_count >= 0", name: "ac_tasks_nonneg_attempts"
    t.check_constraint "risk_class::text = ANY (ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'critical'::character varying]::text[])", name: "ac_tasks_valid_risk_class"
    t.check_constraint "state::text = ANY (ARRAY['pending'::character varying, 'waiting_dependencies'::character varying, 'queued'::character varying, 'running'::character varying, 'review'::character varying, 'needs_changes'::character varying, 'approved'::character varying, 'integrated'::character varying, 'failed'::character varying, 'cancelled'::character varying]::text[])", name: "ac_tasks_valid_state"
  end

  create_table "ac_templates", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.string "template_key", null: false
    t.integer "version", null: false
    t.string "title", null: false
    t.datetime "deleted_at"
    t.jsonb "definition", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["company_id", "template_key", "version"], name: "index_ac_templates_on_company_key_version", unique: true
    t.index ["company_id"], name: "index_ac_templates_on_company_id"
  end

  create_table "ac_work_contexts", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.bigint "project_id", null: false
    t.string "external_id", null: false
    t.string "title", null: false
    t.string "state", default: "active", null: false
    t.string "pause_reason"
    t.text "objective_summary"
    t.jsonb "metadata", default: {}, null: false
    t.string "origin", default: "new", null: false
    t.bigint "policy_revision_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["company_id", "project_id"], name: "index_ac_work_contexts_on_company_id_and_project_id"
    t.index ["company_id"], name: "index_ac_work_contexts_on_company_id"
    t.index ["created_at"], name: "index_ac_work_contexts_on_created_at"
    t.index ["external_id"], name: "index_ac_work_contexts_on_external_id", unique: true
    t.index ["policy_revision_id"], name: "index_ac_work_contexts_on_policy_revision_id"
    t.index ["project_id"], name: "index_ac_work_contexts_on_project_id"
    t.index ["state"], name: "index_ac_work_contexts_on_state"
    t.check_constraint "origin::text = ANY (ARRAY['new'::character varying, 'paseo_import'::character varying, 'migration'::character varying]::text[])", name: "ac_work_contexts_valid_origin"
    t.check_constraint "state::text = ANY (ARRAY['active'::character varying, 'paused'::character varying, 'archived'::character varying, 'suspended'::character varying]::text[])", name: "ac_work_contexts_valid_state"
  end

  create_table "agent_credentials", force: :cascade do |t|
    t.bigint "user_id"
    t.string "agent_type", null: false
    t.text "encrypted_config_data", null: false
    t.jsonb "metadata", default: {}
    t.datetime "last_used_at"
    t.datetime "expires_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.bigint "company_id", null: false
    t.string "status", default: "active", null: false
    t.string "refresh_error"
    t.integer "refresh_failure_count", default: 0, null: false
    t.datetime "refresh_lease_until"
    t.string "refresh_lease_token"
    t.string "account_slug", default: "default", null: false
    t.index ["agent_type"], name: "index_agent_credentials_on_agent_type"
    t.index ["company_id"], name: "index_agent_credentials_on_company_id"
    t.index ["status", "expires_at"], name: "index_agent_credentials_on_status_and_expires_at"
    t.index ["user_id", "company_id", "agent_type", "account_slug"], name: "index_agent_credentials_on_user_co_agent_slug", unique: true
    t.index ["user_id"], name: "index_agent_credentials_on_user_id"
    t.check_constraint "user_id IS NOT NULL OR status::text = 'error'::text AND account_slug::text ~~ 'retired-%'::text", name: "agent_credentials_anonymous_are_disabled"
  end

  create_table "agents", force: :cascade do |t|
    t.string "name", null: false
    t.string "title", null: false
    t.string "icon"
    t.text "persona", null: false
    t.text "communication_style"
    t.text "principles"
    t.string "source", default: "custom", null: false
    t.string "scope_type", null: false
    t.bigint "scope_id", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.bigint "project_id"
    t.bigint "company_id"
    t.integer "current_version_number", default: 0, null: false
    t.datetime "archived_at"
    t.index ["company_id"], name: "index_agents_on_company_id"
    t.index ["project_id"], name: "index_agents_on_project_id"
    t.index ["scope_type", "scope_id", "name"], name: "index_agents_on_scope_type_and_scope_id_and_name", unique: true, where: "(archived_at IS NULL)"
    t.index ["scope_type", "scope_id"], name: "index_agents_on_scope_type_and_scope_id"
  end

  add_check_constraint "agents", "project_id IS NULL AND company_id IS NULL OR scope_type::text = 'Project'::text AND project_id = scope_id AND company_id IS NOT NULL", name: "agents_tenant_columns", validate: false

  create_table "asset_versions", force: :cascade do |t|
    t.bigint "asset_id", null: false
    t.integer "version", default: 1, null: false
    t.text "file_data"
    t.string "content_type"
    t.bigint "file_size"
    t.bigint "uploaded_by_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "source", default: "upload", null: false
    t.index ["asset_id", "version"], name: "index_asset_versions_on_asset_id_and_version", unique: true
    t.index ["asset_id"], name: "index_asset_versions_on_asset_id"
  end

  create_table "assets", force: :cascade do |t|
    t.string "name", null: false
    t.string "folder"
    t.string "tags", default: [], array: true
    t.boolean "public", default: false
    t.string "public_token"
    t.string "scope_type", null: false
    t.bigint "scope_id", null: false
    t.bigint "created_by_id"
    t.bigint "step_run_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.datetime "deleted_at"
    t.bigint "terminal_session_id"
    t.string "status", default: "active", null: false
    t.datetime "reviewed_at"
    t.bigint "project_id"
    t.bigint "company_id"
    t.datetime "shared_at"
    t.bigint "shared_by_id"
    t.bigint "shared_in_session_id"
    t.index "scope_type, scope_id, COALESCE(folder, ''::character varying), name", name: "index_assets_on_scope_folder_name", unique: true, where: "(deleted_at IS NULL)"
    t.index ["company_id"], name: "index_assets_on_company_id"
    t.index ["created_by_id"], name: "index_assets_on_created_by_id"
    t.index ["deleted_at"], name: "index_assets_on_deleted_at"
    t.index ["project_id"], name: "index_assets_on_project_id"
    t.index ["public_token"], name: "index_assets_on_public_token", unique: true, where: "(public_token IS NOT NULL)"
    t.index ["scope_type", "scope_id"], name: "index_assets_on_scope_type_and_scope_id"
    t.index ["shared_by_id"], name: "index_assets_on_shared_by_id", where: "(shared_by_id IS NOT NULL)"
    t.index ["shared_in_session_id"], name: "index_assets_on_shared_in_session_id", where: "(shared_in_session_id IS NOT NULL)"
    t.index ["status"], name: "index_assets_on_status"
    t.index ["step_run_id"], name: "index_assets_on_step_run_id", where: "(step_run_id IS NOT NULL)"
    t.index ["terminal_session_id"], name: "index_assets_on_terminal_session_id"
  end

  add_check_constraint "assets", "project_id IS NULL AND company_id IS NULL OR scope_type::text = 'Project'::text AND project_id = scope_id AND company_id IS NOT NULL OR scope_type::text = 'Company'::text AND project_id IS NULL AND company_id = scope_id", name: "assets_tenant_columns", validate: false

  create_table "audits", force: :cascade do |t|
    t.bigint "auditable_id"
    t.string "auditable_type"
    t.bigint "associated_id"
    t.string "associated_type"
    t.bigint "user_id"
    t.string "user_type"
    t.string "username"
    t.string "action"
    t.text "audited_changes"
    t.integer "version", default: 0
    t.string "comment"
    t.string "remote_address"
    t.string "request_uuid"
    t.datetime "created_at"
    t.index ["associated_type", "associated_id"], name: "associated_index"
    t.index ["auditable_type", "auditable_id", "version"], name: "auditable_index"
    t.index ["created_at"], name: "index_audits_on_created_at"
    t.index ["request_uuid"], name: "index_audits_on_request_uuid"
    t.index ["user_id", "user_type"], name: "user_index"
  end

  create_table "azure_devops_deliveries", force: :cascade do |t|
    t.bigint "azure_devops_subscription_id", null: false
    t.string "event_id", null: false
    t.string "event_type"
    t.datetime "received_at", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["azure_devops_subscription_id", "event_id"], name: "idx_ado_deliveries_event", unique: true
    t.index ["azure_devops_subscription_id"], name: "idx_ado_deliveries_subscription"
    t.index ["received_at"], name: "idx_ado_deliveries_received_at"
  end

  create_table "azure_devops_installations", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.bigint "approved_by_id"
    t.datetime "approved_at"
    t.string "tenant_id", null: false
    t.string "client_id", null: false
    t.string "organization_slug", null: false
    t.string "organization_id"
    t.string "service_principal_object_id"
    t.jsonb "allowed_project_ids", default: [], null: false
    t.string "app_config_key", default: "default", null: false
    t.text "encrypted_access_token"
    t.datetime "token_expires_at"
    t.string "token_credential_generation"
    t.string "token_resource"
    t.string "status", default: "inactive", null: false
    t.string "error_code"
    t.datetime "last_verified_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["company_id", "tenant_id", "organization_slug"], name: "idx_ado_installations_identity", unique: true
    t.index ["company_id"], name: "index_azure_devops_installations_on_company_id"
    t.index ["token_expires_at"], name: "idx_ado_installations_token_expiry"
  end

  create_table "azure_devops_operations", force: :cascade do |t|
    t.bigint "integration_id", null: false
    t.bigint "terminal_session_id"
    t.bigint "user_id"
    t.string "operation_key", null: false
    t.string "operation", null: false
    t.string "request_digest", null: false
    t.string "state", default: "pending", null: false
    t.string "target_kind"
    t.string "target_id"
    t.jsonb "result", default: {}, null: false
    t.string "error_code"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["created_at"], name: "idx_ado_operations_created_at"
    t.index ["integration_id", "operation_key"], name: "idx_ado_operations_key", unique: true
    t.index ["integration_id"], name: "index_azure_devops_operations_on_integration_id"
  end

  create_table "azure_devops_subscriptions", force: :cascade do |t|
    t.bigint "integration_id", null: false
    t.string "endpoint_id", null: false
    t.text "encrypted_password", null: false
    t.string "azure_subscription_id"
    t.string "event_type", null: false
    t.string "status", default: "pending", null: false
    t.string "error_code"
    t.datetime "last_event_at"
    t.datetime "last_checked_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "azure_project_id"
    t.index ["endpoint_id"], name: "index_azure_devops_subscriptions_on_endpoint_id", unique: true
    t.index ["integration_id", "azure_project_id", "event_type"], name: "idx_ado_subscriptions_integration_project_event", unique: true, nulls_not_distinct: true
    t.index ["integration_id"], name: "index_azure_devops_subscriptions_on_integration_id"
  end

  create_table "billing_cancellations", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.bigint "user_id"
    t.string "reason"
    t.text "comment"
    t.datetime "cancels_at", null: false
    t.datetime "resumed_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "settlement_state"
    t.jsonb "final_usage", default: {}, null: false
    t.string "final_invoice_id"
    t.string "final_invoice_url"
    t.datetime "settled_at"
    t.text "settlement_error"
    t.string "stripe_subscription_id"
    t.index ["company_id"], name: "index_billing_cancellations_on_company_id"
    t.index ["user_id"], name: "index_billing_cancellations_on_user_id"
  end

  create_table "bitbucket_installations", force: :cascade do |t|
    t.string "forge_installation_id", null: false
    t.string "forge_environment_id", null: false
    t.string "workspace_uuid", null: false
    t.string "workspace_slug"
    t.string "workspace_name"
    t.bigint "company_id"
    t.bigint "bound_by_id"
    t.datetime "bound_at"
    t.string "status", default: "active", null: false
    t.string "error_code"
    t.text "encrypted_access_token"
    t.datetime "token_expires_at"
    t.datetime "last_invocation_at"
    t.string "app_version"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["company_id"], name: "index_bitbucket_installations_on_company_id"
    t.index ["forge_environment_id", "workspace_uuid"], name: "idx_bitbucket_installations_live_workspace", unique: true, where: "((status)::text <> 'uninstalled'::text)"
    t.index ["forge_installation_id"], name: "index_bitbucket_installations_on_forge_installation_id", unique: true
    t.index ["token_expires_at"], name: "index_bitbucket_installations_on_token_expires_at"
  end

  create_table "bitbucket_pairings", force: :cascade do |t|
    t.bigint "bitbucket_installation_id", null: false
    t.string "public_id", null: false
    t.string "secret_digest", null: false
    t.string "account_id", null: false
    t.string "workspace_uuid", null: false
    t.datetime "expires_at", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["bitbucket_installation_id"], name: "index_bitbucket_pairings_on_bitbucket_installation_id"
    t.index ["expires_at"], name: "index_bitbucket_pairings_on_expires_at"
    t.index ["public_id"], name: "index_bitbucket_pairings_on_public_id", unique: true
  end

  create_table "board_activities", force: :cascade do |t|
    t.bigint "board_id", null: false
    t.bigint "board_task_id"
    t.string "event_type", null: false
    t.bigint "actor_id"
    t.string "actor_type", null: false
    t.jsonb "metadata", default: {}, null: false
    t.datetime "created_at", null: false
    t.index ["actor_id"], name: "index_board_activities_on_actor_id"
    t.index ["board_id", "created_at"], name: "index_board_activities_on_board_id_and_created_at"
    t.index ["board_id"], name: "index_board_activities_on_board_id"
    t.index ["board_task_id", "created_at"], name: "index_board_activities_on_board_task_id_and_created_at"
    t.index ["board_task_id"], name: "index_board_activities_on_board_task_id"
    t.index ["event_type"], name: "index_board_activities_on_event_type"
  end

  create_table "board_columns", force: :cascade do |t|
    t.bigint "board_id", null: false
    t.string "name", null: false
    t.integer "position", null: false
    t.text "purpose"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["board_id", "position"], name: "index_board_columns_on_board_id_and_position", unique: true
    t.index ["board_id"], name: "index_board_columns_on_board_id"
  end

  create_table "board_tasks", force: :cascade do |t|
    t.bigint "board_id", null: false
    t.bigint "board_column_id", null: false
    t.string "title", null: false
    t.text "description"
    t.string "task_type", default: "not_specified", null: false
    t.string "priority"
    t.bigint "assignee_id"
    t.integer "position", null: false
    t.bigint "parent_task_id"
    t.string "tags", default: [], array: true
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.datetime "archived_at"
    t.integer "number", null: false
    t.index ["assignee_id"], name: "index_board_tasks_on_assignee_id"
    t.index ["board_column_id"], name: "index_board_tasks_on_board_column_id"
    t.index ["board_id", "archived_at"], name: "index_board_tasks_on_board_id_and_archived_at"
    t.index ["board_id", "number"], name: "index_board_tasks_on_board_id_and_number", unique: true
    t.index ["board_id"], name: "index_board_tasks_on_board_id"
    t.index ["parent_task_id"], name: "index_board_tasks_on_parent_task_id"
    t.check_constraint "number > 0", name: "board_tasks_number_positive"
  end

  create_table "board_view_presets", force: :cascade do |t|
    t.bigint "board_id", null: false
    t.bigint "user_id", null: false
    t.string "name", null: false
    t.jsonb "filters", default: {}, null: false
    t.boolean "shared", default: false, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["board_id", "shared"], name: "index_board_view_presets_on_board_id_and_shared"
    t.index ["board_id", "user_id", "name"], name: "index_board_view_presets_on_board_id_and_user_id_and_name", unique: true
    t.index ["board_id"], name: "index_board_view_presets_on_board_id"
    t.index ["user_id"], name: "index_board_view_presets_on_user_id"
  end

  create_table "boards", force: :cascade do |t|
    t.bigint "project_id", null: false
    t.string "name", null: false
    t.string "preset_origin"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.integer "last_task_number", default: 0, null: false
    t.index ["project_id"], name: "index_boards_on_project_id", unique: true
  end

  create_table "capacity_meter_reports", force: :cascade do |t|
    t.string "provider", null: false
    t.datetime "period_start", null: false
    t.integer "quantity_seconds", null: false
    t.integer "peak_concurrent", default: 0, null: false
    t.integer "unbounded_companies", default: 0, null: false
    t.jsonb "breakdown", default: {}, null: false
    t.string "state", default: "pending", null: false
    t.string "external_id"
    t.text "error"
    t.integer "attempts", default: 0, null: false
    t.datetime "reported_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.jsonb "receipts", default: {}, null: false
    t.index ["provider", "period_start"], name: "index_capacity_meter_reports_on_provider_and_period_start", unique: true
    t.index ["state", "period_start"], name: "index_capacity_meter_reports_on_state_and_period_start"
  end

  create_table "catalog_namespaces", force: :cascade do |t|
    t.string "name", null: false
    t.string "display_name", null: false
    t.string "url"
    t.boolean "verified", default: false, null: false
    t.string "owners", default: [], null: false, array: true
    t.datetime "synced_at", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["name"], name: "index_catalog_namespaces_on_name", unique: true
  end

  create_table "catalog_search_queries", force: :cascade do |t|
    t.string "term", null: false
    t.integer "search_count", default: 0, null: false
    t.datetime "last_searched_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["search_count", "last_searched_at"], name: "index_catalog_search_queries_on_demand"
    t.index ["term"], name: "index_catalog_search_queries_on_term", unique: true
  end

  create_table "catalog_skills", force: :cascade do |t|
    t.string "registry_id", null: false
    t.string "source", null: false
    t.string "slug", null: false
    t.string "title"
    t.text "description"
    t.integer "installs", default: 0, null: false
    t.integer "install_count", default: 0, null: false
    t.boolean "featured", default: false, null: false
    t.boolean "bulk_publisher", default: false, null: false
    t.string "content_hash"
    t.datetime "registry_synced_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.virtual "search_vector", type: :tsvector, as: "(((setweight(to_tsvector('simple'::regconfig, (COALESCE(slug, ''::character varying))::text), 'A'::\"char\") || setweight(to_tsvector('simple'::regconfig, (COALESCE(title, ''::character varying))::text), 'A'::\"char\")) || setweight(to_tsvector('simple'::regconfig, (COALESCE(source, ''::character varying))::text), 'B'::\"char\")) || setweight(to_tsvector('simple'::regconfig, COALESCE(description, ''::text)), 'C'::\"char\"))", stored: true
    t.jsonb "audit", default: {}, null: false
    t.string "audit_risk"
    t.datetime "audited_at"
    t.datetime "description_checked_at"
    t.index ["audit_risk"], name: "index_catalog_skills_on_audit_risk"
    t.index ["description_checked_at"], name: "index_catalog_skills_on_backfill_queue", where: "(description IS NULL)"
    t.index ["featured", "bulk_publisher", "installs"], name: "index_catalog_skills_on_ranking"
    t.index ["registry_id"], name: "index_catalog_skills_on_registry_id", unique: true
    t.index ["registry_synced_at"], name: "index_catalog_skills_on_registry_synced_at"
    t.index ["search_vector"], name: "index_catalog_skills_on_search_vector", using: :gin
    t.index ["source"], name: "index_catalog_skills_on_source"
  end

  create_table "catalog_templates", force: :cascade do |t|
    t.string "namespace", null: false
    t.string "slug", null: false
    t.integer "version", null: false
    t.string "name", null: false
    t.text "summary"
    t.string "kind", null: false
    t.string "categories", default: [], null: false, array: true
    t.integer "format_version", null: false
    t.jsonb "definition", default: {}, null: false
    t.jsonb "files", default: {}, null: false
    t.text "readme"
    t.text "setup_markdown"
    t.string "commit_sha", null: false
    t.string "package_digest", null: false
    t.boolean "installable", default: true, null: false
    t.datetime "revoked_at"
    t.text "revocation_reason"
    t.integer "install_count", default: 0, null: false
    t.datetime "synced_at", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["kind"], name: "index_catalog_templates_on_kind"
    t.index ["namespace", "slug"], name: "index_catalog_templates_on_namespace_and_slug", unique: true
  end

  create_table "chat_channel_connections", force: :cascade do |t|
    t.bigint "chat_conversation_id", null: false
    t.bigint "company_id", null: false
    t.bigint "requested_by_id"
    t.string "posted_by_external_id"
    t.string "posted_by_name"
    t.string "confirmation_message_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "confirmation_url"
    t.index ["chat_conversation_id", "company_id"], name: "idx_on_chat_conversation_id_company_id_df284b3410", unique: true
    t.index ["company_id"], name: "index_chat_channel_connections_on_company_id"
    t.index ["requested_by_id"], name: "index_chat_channel_connections_on_requested_by_id"
  end

  create_table "chat_connect_codes", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.bigint "project_id", null: false
    t.bigint "trigger_binding_id"
    t.bigint "requested_by_id"
    t.bigint "chat_channel_connection_id"
    t.string "provider", null: false
    t.string "code_digest", null: false
    t.datetime "expires_at", null: false
    t.datetime "redeemed_at"
    t.string "failure_reason"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "channel_name"
    t.string "team_name"
    t.index ["chat_channel_connection_id"], name: "index_chat_connect_codes_on_chat_channel_connection_id"
    t.index ["code_digest"], name: "index_chat_connect_codes_on_code_digest", unique: true
    t.index ["company_id"], name: "index_chat_connect_codes_on_company_id"
    t.index ["project_id"], name: "index_chat_connect_codes_on_project_id"
    t.index ["requested_by_id"], name: "index_chat_connect_codes_on_requested_by_id"
    t.index ["trigger_binding_id"], name: "index_chat_connect_codes_on_trigger_binding_id"
  end

  create_table "chat_conversations", force: :cascade do |t|
    t.bigint "integration_id"
    t.string "provider", null: false
    t.string "external_id", null: false
    t.string "kind", null: false
    t.string "name"
    t.string "tenant_id"
    t.string "team_external_id"
    t.string "team_aad_group_id"
    t.string "team_name"
    t.string "service_url"
    t.boolean "installed", default: true, null: false
    t.datetime "welcomed_at"
    t.datetime "last_activity_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.bigint "chat_workspace_id"
    t.index ["chat_workspace_id", "external_id"], name: "index_chat_conversations_on_chat_workspace_id_and_external_id", unique: true
    t.index ["chat_workspace_id"], name: "index_chat_conversations_on_chat_workspace_id"
    t.index ["integration_id", "external_id"], name: "index_chat_conversations_on_integration_id_and_external_id", unique: true
    t.index ["integration_id"], name: "index_chat_conversations_on_integration_id"
  end

  create_table "chat_identities", force: :cascade do |t|
    t.string "provider", null: false
    t.string "workspace_id", null: false
    t.string "external_user_id", null: false
    t.bigint "user_id", null: false
    t.string "proof", null: false
    t.datetime "linked_at", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["provider", "workspace_id", "external_user_id"], name: "index_chat_identities_on_sender", unique: true
    t.index ["user_id"], name: "index_chat_identities_on_user_id"
  end

  create_table "chat_messages", force: :cascade do |t|
    t.bigint "chat_conversation_id", null: false
    t.bigint "company_id", null: false
    t.string "message_id", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["chat_conversation_id", "message_id"], name: "index_chat_messages_on_chat_conversation_id_and_message_id", unique: true
    t.index ["company_id"], name: "index_chat_messages_on_company_id"
  end

  create_table "chat_workspaces", force: :cascade do |t|
    t.string "provider", null: false
    t.string "external_id", null: false
    t.string "name"
    t.string "status", default: "active", null: false
    t.jsonb "settings", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["provider", "external_id"], name: "index_chat_workspaces_on_provider_and_external_id", unique: true
  end

  create_table "column_transitions", force: :cascade do |t|
    t.bigint "board_task_id", null: false
    t.bigint "from_column_id"
    t.bigint "to_column_id", null: false
    t.bigint "actor_id"
    t.string "actor_type", null: false
    t.bigint "workflow_run_id"
    t.datetime "created_at", null: false
    t.index ["actor_id"], name: "index_column_transitions_on_actor_id"
    t.index ["board_task_id"], name: "index_column_transitions_on_board_task_id"
    t.index ["from_column_id"], name: "index_column_transitions_on_from_column_id"
    t.index ["to_column_id"], name: "index_column_transitions_on_to_column_id"
    t.index ["workflow_run_id"], name: "index_column_transitions_on_workflow_run_id"
  end

  create_table "column_workflow_bindings", force: :cascade do |t|
    t.bigint "board_column_id", null: false
    t.bigint "workflow_id", null: false
    t.string "trigger_mode", default: "manual", null: false
    t.integer "cooldown_seconds", default: 5, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.bigint "created_by_id"
    t.index ["board_column_id"], name: "index_column_workflow_bindings_on_board_column_id", unique: true
    t.index ["created_by_id"], name: "index_column_workflow_bindings_on_created_by_id"
    t.index ["workflow_id"], name: "index_column_workflow_bindings_on_workflow_id"
  end

  create_table "companies", force: :cascade do |t|
    t.string "name", null: false
    t.string "slug", null: false
    t.jsonb "settings", default: {}, null: false
    t.string "state", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "display_name"
    t.string "logo_url"
    t.string "primary_color", default: "#4785FF"
    t.string "secondary_color", default: "#bb9af7"
    t.string "email_domain", null: false
    t.boolean "auto_accept_users", default: false, null: false
    t.text "logo_data"
    t.string "billing_state", default: "active", null: false
    t.string "domain_verification_token"
    t.datetime "domain_verified_at"
    t.string "stripe_customer_id"
    t.string "stripe_subscription_id"
    t.datetime "billing_period_starts_at"
    t.datetime "billing_period_ends_at"
    t.datetime "billing_cancels_at"
    t.string "billing_block_reason"
    t.string "billing_unpaid_invoice_url"
    t.datetime "billing_event_at"
    t.boolean "managed_by_aixle", default: false, null: false
    t.datetime "trial_started_at"
    t.string "billing_provider", default: "none", null: false
    t.datetime "billing_provider_since"
    t.integer "trial_hours"
    t.index ["billing_provider"], name: "index_companies_on_billing_provider"
    t.index ["billing_state"], name: "index_companies_on_billing_state"
    t.index ["email_domain"], name: "index_companies_on_email_domain", unique: true
    t.index ["name"], name: "index_companies_on_name", unique: true
    t.index ["slug"], name: "index_companies_on_slug", unique: true
    t.index ["state"], name: "index_companies_on_state"
    t.index ["stripe_customer_id"], name: "index_companies_on_stripe_customer_id", unique: true, where: "(stripe_customer_id IS NOT NULL)"
  end

  create_table "company_auth_policies", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.bigint "identity_provider_id", null: false
    t.boolean "enabled", default: true, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["company_id", "identity_provider_id"], name: "index_company_auth_policies_unique_pair", unique: true
    t.index ["company_id"], name: "index_company_auth_policies_on_company_id"
    t.index ["identity_provider_id"], name: "index_company_auth_policies_on_identity_provider_id"
  end

  create_table "company_billing_state_changes", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.string "billing_state", null: false
    t.datetime "occurred_at", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["company_id", "occurred_at"], name: "index_billing_state_changes_on_company_and_time"
    t.index ["company_id"], name: "index_company_billing_state_changes_on_company_id"
    t.index ["occurred_at"], name: "index_company_billing_state_changes_on_occurred_at"
  end

  create_table "company_capacity_changes", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.integer "max_sessions"
    t.datetime "occurred_at", null: false
    t.datetime "created_at", null: false
    t.index ["company_id", "occurred_at"], name: "index_company_capacity_changes_on_company_id_and_occurred_at"
    t.index ["company_id"], name: "index_company_capacity_changes_on_company_id"
    t.index ["occurred_at"], name: "index_company_capacity_changes_on_occurred_at"
  end

  create_table "company_capacity_usages", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.datetime "period_start", null: false
    t.integer "quantity_seconds", default: 0, null: false
    t.datetime "created_at", null: false
    t.index ["company_id", "period_start"], name: "index_company_capacity_usages_on_company_id_and_period_start", unique: true
    t.index ["company_id"], name: "index_company_capacity_usages_on_company_id"
    t.index ["period_start"], name: "index_company_capacity_usages_on_period_start"
  end

  create_table "company_memberships", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.bigint "company_id", null: false
    t.string "role", default: "employee", null: false
    t.string "state", default: "invited", null: false
    t.bigint "invited_by_id"
    t.datetime "invited_at"
    t.datetime "accepted_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.datetime "reminded_at"
    t.string "onboarding_state", default: "step1", null: false
    t.datetime "onboarding_completed_at"
    t.string "position"
    t.string "preferred_agent_language", default: "en"
    t.text "selected_agents", default: [], array: true
    t.bigint "default_agent_credential_id"
    t.datetime "agent_setup_skipped_at"
    t.index ["company_id"], name: "index_company_memberships_on_company_id"
    t.index ["default_agent_credential_id"], name: "index_company_memberships_on_default_agent_credential_id"
    t.index ["invited_by_id"], name: "index_company_memberships_on_invited_by_id"
    t.index ["onboarding_state"], name: "index_company_memberships_on_onboarding_state"
    t.index ["state"], name: "index_company_memberships_on_state"
    t.index ["user_id", "company_id"], name: "index_company_memberships_on_user_id_and_company_id", unique: true
  end

  create_table "company_usage_hours", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.datetime "period_start", null: false
    t.integer "limit_min"
    t.integer "limit_max"
    t.integer "unlimited_seconds", default: 0, null: false
    t.integer "offered_seconds", default: 0, null: false
    t.string "billing_class", null: false
    t.integer "occupied_seconds", default: 0, null: false
    t.integer "peak_workers", default: 0, null: false
    t.integer "sessions_queued", default: 0, null: false
    t.integer "sessions_admitted", default: 0, null: false
    t.integer "wait_seconds_total", default: 0, null: false
    t.integer "wait_seconds_max", default: 0, null: false
    t.integer "sessions_succeeded", default: 0, null: false
    t.integer "sessions_failed", default: 0, null: false
    t.datetime "computed_at", null: false
    t.index ["company_id", "period_start"], name: "index_company_usage_hours_on_company_id_and_period_start", unique: true
    t.index ["period_start"], name: "index_company_usage_hours_on_period_start"
  end

  create_table "config_item_accesses", force: :cascade do |t|
    t.bigint "config_item_id", null: false
    t.bigint "terminal_session_id", null: false
    t.bigint "user_id"
    t.string "config_item_name", null: false
    t.string "item_type", null: false
    t.datetime "created_at", null: false
    t.string "channel", default: "get_config_item", null: false
    t.index ["config_item_id"], name: "index_config_item_accesses_on_config_item_id"
    t.index ["created_at"], name: "index_config_item_accesses_on_created_at"
    t.index ["terminal_session_id"], name: "index_config_item_accesses_on_terminal_session_id"
  end

  create_table "config_items", force: :cascade do |t|
    t.string "name", null: false
    t.text "value"
    t.text "encrypted_value"
    t.text "description"
    t.string "item_type", null: false
    t.string "scope_type", null: false
    t.bigint "scope_id", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.bigint "project_id"
    t.bigint "company_id"
    t.index ["company_id"], name: "index_config_items_on_company_id"
    t.index ["project_id"], name: "index_config_items_on_project_id"
    t.index ["scope_type", "scope_id", "name"], name: "index_config_items_on_scope_type_and_scope_id_and_name", unique: true
    t.index ["scope_type", "scope_id"], name: "index_config_items_on_scope_type_and_scope_id"
  end

  add_check_constraint "config_items", "project_id IS NULL AND company_id IS NULL OR scope_type::text = 'Project'::text AND project_id = scope_id AND company_id IS NOT NULL", name: "config_items_tenant_columns", validate: false

  create_table "connectors", force: :cascade do |t|
    t.string "name", null: false
    t.string "version"
    t.string "title"
    t.text "description"
    t.string "repository_url"
    t.jsonb "manifest", default: {}, null: false
    t.string "status", default: "active", null: false
    t.boolean "is_latest", default: true, null: false
    t.datetime "registry_updated_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.virtual "search_vector", type: :tsvector, as: "((setweight(to_tsvector('simple'::regconfig, (COALESCE(name, ''::character varying))::text), 'A'::\"char\") || setweight(to_tsvector('simple'::regconfig, (COALESCE(title, ''::character varying))::text), 'A'::\"char\")) || setweight(to_tsvector('simple'::regconfig, COALESCE(description, ''::text)), 'B'::\"char\"))", stored: true
    t.integer "install_count", default: 0, null: false
    t.boolean "featured", default: false, null: false
    t.boolean "bulk_publisher", default: false, null: false
    t.string "normalizer_version"
    t.index ["bulk_publisher"], name: "index_connectors_on_bulk_publisher"
    t.index ["install_count", "featured", "registry_updated_at"], name: "index_connectors_on_ranking"
    t.index ["name"], name: "index_connectors_on_name", unique: true
    t.index ["normalizer_version"], name: "index_connectors_on_normalizer_version"
    t.index ["registry_updated_at"], name: "index_connectors_on_registry_updated_at"
    t.index ["search_vector"], name: "index_connectors_on_search_vector", using: :gin
    t.index ["status"], name: "index_connectors_on_status"
  end

  create_table "entity_versions", force: :cascade do |t|
    t.string "versionable_type", null: false
    t.bigint "versionable_id", null: false
    t.integer "number", null: false
    t.string "event", null: false
    t.jsonb "snapshot", default: {}, null: false
    t.integer "snapshot_format", default: 1, null: false
    t.bigint "restored_from_id"
    t.bigint "author_id"
    t.string "source", null: false
    t.bigint "terminal_session_id"
    t.jsonb "metadata", default: {}, null: false
    t.bigint "project_id"
    t.bigint "company_id"
    t.datetime "created_at", null: false
    t.index ["project_id", "created_at"], name: "index_entity_versions_on_project_id_and_created_at"
    t.index ["terminal_session_id"], name: "index_entity_versions_on_terminal_session_id", where: "(terminal_session_id IS NOT NULL)"
    t.index ["versionable_type", "versionable_id", "number"], name: "index_entity_versions_on_versionable_and_number", unique: true
    t.check_constraint "number > 0", name: "entity_versions_number_positive"
  end

  create_table "external_resources", force: :cascade do |t|
    t.bigint "board_task_id", null: false
    t.string "kind", null: false
    t.string "provider", null: false
    t.string "instance", null: false
    t.string "external_id", null: false
    t.jsonb "data", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["board_task_id", "kind", "provider", "instance", "external_id"], name: "idx_external_resources_unique", unique: true
    t.index ["kind", "provider", "instance", "external_id"], name: "idx_external_resources_identity"
  end

  create_table "feature_flag_overrides", force: :cascade do |t|
    t.bigint "feature_flag_id", null: false
    t.bigint "company_id", null: false
    t.boolean "enabled", null: false
    t.text "reason", null: false
    t.bigint "created_by_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["company_id"], name: "index_feature_flag_overrides_on_company_id"
    t.index ["created_by_id"], name: "index_feature_flag_overrides_on_created_by_id"
    t.index ["feature_flag_id", "company_id"], name: "index_feature_flag_overrides_on_feature_flag_id_and_company_id", unique: true
  end

  create_table "feature_flags", force: :cascade do |t|
    t.string "key", null: false
    t.boolean "enabled"
    t.integer "rollout_percent"
    t.bigint "updated_by_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["key"], name: "index_feature_flags_on_key", unique: true
    t.index ["updated_by_id"], name: "index_feature_flags_on_updated_by_id"
  end

  create_table "feedback_attachments", force: :cascade do |t|
    t.bigint "feedback_submission_id", null: false
    t.string "name", null: false
    t.jsonb "file_data"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["feedback_submission_id"], name: "index_feedback_attachments_on_feedback_submission_id"
  end

  create_table "feedback_submissions", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.bigint "user_id"
    t.string "kind", null: false
    t.text "message", null: false
    t.string "page_url"
    t.string "app_version"
    t.datetime "slack_delivered_at"
    t.datetime "board_delivered_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["company_id"], name: "index_feedback_submissions_on_company_id"
    t.index ["user_id", "created_at"], name: "index_feedback_submissions_on_user_id_and_created_at"
  end

  create_table "folders", force: :cascade do |t|
    t.string "path", null: false
    t.string "scope_type", null: false
    t.bigint "scope_id", null: false
    t.bigint "created_by_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.bigint "project_id"
    t.bigint "company_id"
    t.index ["company_id"], name: "index_folders_on_company_id"
    t.index ["created_by_id"], name: "index_folders_on_created_by_id"
    t.index ["project_id"], name: "index_folders_on_project_id"
    t.index ["scope_type", "scope_id", "path"], name: "index_folders_on_scope_and_path", unique: true
    t.index ["scope_type", "scope_id"], name: "index_folders_on_scope_type_and_scope_id"
  end

  add_check_constraint "folders", "project_id IS NULL AND company_id IS NULL OR scope_type::text = 'Project'::text AND project_id = scope_id AND company_id IS NOT NULL OR scope_type::text = 'Company'::text AND project_id IS NULL AND company_id = scope_id", name: "folders_tenant_columns", validate: false

  create_table "gates", force: :cascade do |t|
    t.bigint "board_task_id", null: false
    t.string "gate_type", null: false
    t.string "status", default: "pending", null: false
    t.jsonb "metadata", default: {}, null: false
    t.jsonb "resolution_data", default: {}, null: false
    t.datetime "resolved_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.bigint "creator_id"
    t.datetime "expires_at", null: false
    t.datetime "last_reconciled_at"
    t.integer "reconcile_attempts", default: 0, null: false
    t.string "diagnostic_reason"
    t.jsonb "reconciliation_log", default: [], null: false
    t.index "(((metadata ->> 'pipeline_id'::text))::bigint)", name: "index_gates_on_metadata_pipeline_id", where: "((gate_type)::text = 'gitlab_pipeline_completed'::text)"
    t.index "(((metadata ->> 'pr_number'::text))::integer)", name: "index_gates_on_metadata_pr_number"
    t.index "(((metadata ->> 'run_id'::text))::bigint)", name: "index_gates_on_metadata_run_id"
    t.index "((metadata ->> 'repo_full_name'::text))", name: "index_gates_on_metadata_repo_full_name"
    t.index ["board_task_id"], name: "index_gates_on_board_task_id"
    t.index ["creator_id"], name: "index_gates_on_creator_id"
    t.index ["gate_type", "status"], name: "index_gates_on_gate_type_and_status"
    t.index ["status", "expires_at"], name: "index_gates_on_status_and_expires_at", where: "((status)::text <> 'resolved'::text)"
    t.index ["status"], name: "index_gates_on_status"
  end

  create_table "identity_providers", force: :cascade do |t|
    t.string "kind", null: false
    t.string "scope", null: false
    t.bigint "company_id"
    t.string "name"
    t.jsonb "config", default: {}, null: false
    t.text "encrypted_secret"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["company_id", "kind", "name"], name: "index_identity_providers_unique_company_connection", unique: true, where: "((scope)::text = 'company'::text)"
    t.index ["company_id"], name: "index_identity_providers_on_company_id"
    t.index ["kind"], name: "index_identity_providers_unique_deployment_kind", unique: true, where: "((scope)::text = 'deployment'::text)"
    t.check_constraint "scope::text = 'deployment'::text AND company_id IS NULL OR scope::text = 'company'::text AND company_id IS NOT NULL", name: "identity_providers_scope_company_consistency"
  end

  create_table "integration_data", force: :cascade do |t|
    t.bigint "integration_id", null: false
    t.string "key", null: false
    t.jsonb "value", default: {}, null: false
    t.datetime "expires_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index "((value ->> 'workspace_id'::text))", name: "index_integration_data_on_coder_workspace_lock", unique: true, where: "((key)::text ~~ 'coder:workspace_lock:%'::text)"
    t.index ["expires_at"], name: "ix_integration_data_expires_at", where: "(expires_at IS NOT NULL)"
    t.index ["integration_id", "key"], name: "ix_integration_data_integration_key", unique: true
    t.index ["integration_id"], name: "index_integration_data_on_integration_id"
  end

  create_table "integrations", force: :cascade do |t|
    t.string "name", null: false
    t.string "provider", null: false
    t.text "credentials"
    t.jsonb "settings", default: {}
    t.string "status", default: "inactive", null: false
    t.bigint "company_id", null: false
    t.bigint "connected_by_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.bigint "project_id"
    t.bigint "azure_devops_installation_id"
    t.bigint "github_installation_id"
    t.bigint "bitbucket_installation_id"
    t.bigint "chat_workspace_id"
    t.index ["azure_devops_installation_id"], name: "index_integrations_on_azure_devops_installation_id"
    t.index ["bitbucket_installation_id"], name: "index_integrations_on_bitbucket_installation_id"
    t.index ["chat_workspace_id"], name: "index_integrations_on_chat_workspace_id"
    t.index ["company_id", "provider"], name: "index_integrations_on_company_id_and_provider"
    t.index ["company_id"], name: "index_integrations_on_company_id"
    t.index ["github_installation_id"], name: "index_integrations_on_github_installation_id"
    t.index ["id", "company_id"], name: "index_integrations_on_id_and_company_id", unique: true
    t.index ["project_id", "provider"], name: "index_integrations_on_project_id_and_provider", where: "(project_id IS NOT NULL)"
    t.index ["project_id"], name: "index_integrations_on_project_id"
    t.index ["status"], name: "index_integrations_on_status"
  end

  create_table "magic_link_tokens", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "token_digest", null: false
    t.datetime "expires_at", null: false
    t.datetime "consumed_at"
    t.string "requested_ip"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["expires_at"], name: "index_magic_link_tokens_on_expires_at"
    t.index ["token_digest"], name: "index_magic_link_tokens_on_token_digest", unique: true
    t.index ["user_id"], name: "index_magic_link_tokens_on_user_id"
  end

  create_table "marketplace_licenses", force: :cascade do |t|
    t.string "license_arn", null: false
    t.string "customer_aws_account_id", null: false
    t.string "product_code", null: false
    t.string "agreement_id"
    t.string "customer_identifier"
    t.bigint "company_id"
    t.string "subscription_state", default: "pending", null: false
    t.string "offer_identifier"
    t.string "registered_offer_type"
    t.datetime "subscribed_at"
    t.datetime "ended_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.bigint "proposed_company_id"
    t.string "proposed_by_email"
    t.datetime "proposed_at"
    t.datetime "proposal_decided_at"
    t.string "proposal_state"
    t.string "previous_agreement_id"
    t.index ["agreement_id"], name: "index_marketplace_licenses_on_agreement_id"
    t.index ["company_id"], name: "index_marketplace_licenses_on_company_id", unique: true, where: "((company_id IS NOT NULL) AND ((subscription_state)::text <> 'ended'::text))"
    t.index ["customer_aws_account_id"], name: "index_marketplace_licenses_on_customer_aws_account_id"
    t.index ["license_arn"], name: "index_marketplace_licenses_on_license_arn", unique: true
    t.index ["proposed_company_id"], name: "index_marketplace_licenses_on_proposed_company_id"
    t.index ["subscription_state"], name: "index_marketplace_licenses_on_subscription_state"
  end

  create_table "marketplace_subscription_events", force: :cascade do |t|
    t.string "event_id", null: false
    t.string "detail_type", null: false
    t.string "agreement_id"
    t.string "license_arn"
    t.bigint "marketplace_license_id"
    t.datetime "occurred_at", null: false
    t.datetime "applied_at"
    t.jsonb "detail", default: {}, null: false
    t.string "failure"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "metered"
    t.jsonb "metered_receipts", default: {}, null: false
    t.index ["agreement_id"], name: "index_marketplace_subscription_events_on_agreement_id"
    t.index ["applied_at", "occurred_at"], name: "idx_on_applied_at_occurred_at_9b9f6d64f1"
    t.index ["event_id"], name: "index_marketplace_subscription_events_on_event_id", unique: true
    t.index ["marketplace_license_id"], name: "idx_on_marketplace_license_id_bbeb7c9440"
  end

  create_table "mcp_servers", force: :cascade do |t|
    t.string "name", null: false
    t.string "url"
    t.string "transport", default: "sse"
    t.jsonb "headers", default: {}
    t.text "description"
    t.string "kind", default: "custom", null: false
    t.string "scope_type"
    t.bigint "scope_id"
    t.boolean "enabled", default: true, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "command"
    t.jsonb "env", default: {}
    t.string "auth_type", default: "none", null: false
    t.string "credential_scope", default: "shared", null: false
    t.string "connector_name"
    t.string "connector_version"
    t.jsonb "connector_manifest", default: {}, null: false
    t.jsonb "tool_snapshot", default: {}, null: false
    t.datetime "tool_snapshot_at"
    t.jsonb "tool_drift", default: {}, null: false
    t.jsonb "args", default: []
    t.bigint "project_id"
    t.bigint "company_id"
    t.text "encrypted_headers"
    t.text "encrypted_env"
    t.integer "current_version_number", default: 0, null: false
    t.datetime "archived_at"
    t.index ["company_id"], name: "index_mcp_servers_on_company_id"
    t.index ["connector_name"], name: "index_mcp_servers_on_connector_name"
    t.index ["id"], name: "index_mcp_servers_with_tool_drift", where: "(tool_drift <> '{}'::jsonb)"
    t.index ["name", "scope_type", "scope_id"], name: "index_mcp_servers_on_name_and_scope_type_and_scope_id", unique: true, where: "(archived_at IS NULL)", nulls_not_distinct: true
    t.index ["project_id"], name: "index_mcp_servers_on_project_id"
    t.index ["scope_type", "scope_id"], name: "index_mcp_servers_on_scope"
  end

  add_check_constraint "mcp_servers", "project_id IS NULL AND company_id IS NULL OR scope_type IS NULL AND scope_id IS NULL AND project_id IS NULL AND company_id IS NULL OR scope_type::text = 'Project'::text AND project_id = scope_id AND company_id IS NOT NULL", name: "mcp_servers_tenant_columns", validate: false

  create_table "oauth_clients", force: :cascade do |t|
    t.string "issuer"
    t.string "authorization_endpoint"
    t.string "token_endpoint"
    t.string "registration_endpoint"
    t.string "client_id", null: false
    t.text "encrypted_client_secret"
    t.string "scopes"
    t.string "source", null: false
    t.jsonb "metadata", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.bigint "mcp_server_id"
    t.index ["issuer", "client_id"], name: "index_oauth_clients_on_issuer_and_client_id", unique: true, where: "(mcp_server_id IS NULL)"
    t.index ["mcp_server_id"], name: "index_oauth_clients_on_mcp_server_id", unique: true, where: "(mcp_server_id IS NOT NULL)"
    t.index ["source"], name: "index_oauth_clients_on_source"
  end

  create_table "oauth_credentials", force: :cascade do |t|
    t.string "owner_type", null: false
    t.bigint "owner_id", null: false
    t.bigint "oauth_client_id", null: false
    t.bigint "mcp_server_id"
    t.string "provider", null: false
    t.text "encrypted_access_token"
    t.text "encrypted_refresh_token"
    t.string "token_type", default: "Bearer"
    t.string "scopes"
    t.datetime "expires_at"
    t.string "status", default: "pending", null: false
    t.string "refresh_error"
    t.datetime "last_refreshed_at"
    t.jsonb "metadata", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.integer "refresh_failure_count", default: 0, null: false
    t.string "resource"
    t.bigint "connected_by_id"
    t.datetime "refresh_lease_until"
    t.string "refresh_lease_token"
    t.index ["connected_by_id"], name: "index_oauth_credentials_on_connected_by_id"
    t.index ["mcp_server_id"], name: "index_oauth_credentials_on_mcp_server_id"
    t.index ["oauth_client_id"], name: "index_oauth_credentials_on_oauth_client_id"
    t.index ["owner_type", "owner_id", "oauth_client_id", "provider", "mcp_server_id"], name: "idx_oauth_credentials_unique_owner_client", unique: true, nulls_not_distinct: true
    t.index ["owner_type", "owner_id", "provider"], name: "idx_on_owner_type_owner_id_provider_1db0e9274f"
    t.index ["owner_type", "owner_id"], name: "index_oauth_credentials_on_owner"
    t.index ["status", "expires_at"], name: "index_oauth_credentials_on_status_and_expires_at"
  end

  create_table "project_collaborators", force: :cascade do |t|
    t.bigint "project_id", null: false
    t.bigint "user_id", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["project_id", "user_id"], name: "index_project_collaborators_on_project_id_and_user_id", unique: true
    t.index ["project_id"], name: "index_project_collaborators_on_project_id"
    t.index ["user_id"], name: "index_project_collaborators_on_user_id"
  end

  create_table "project_favorites", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.bigint "project_id", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["project_id"], name: "index_project_favorites_on_project_id"
    t.index ["user_id", "project_id"], name: "index_project_favorites_on_user_id_and_project_id", unique: true
    t.index ["user_id"], name: "index_project_favorites_on_user_id"
  end

  create_table "project_trackers", force: :cascade do |t|
    t.bigint "project_id", null: false
    t.bigint "integration_id", null: false
    t.string "provider", null: false
    t.string "external_scope_id", null: false
    t.string "external_scope_key"
    t.string "name", null: false
    t.string "handle", null: false
    t.boolean "primary", default: false, null: false
    t.string "access", default: "read_write", null: false
    t.string "status", default: "active", null: false
    t.jsonb "settings", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["integration_id"], name: "index_project_trackers_on_integration_id"
    t.index ["project_id", "handle"], name: "idx_project_trackers_handle", unique: true
    t.index ["project_id", "integration_id", "external_scope_id"], name: "idx_project_trackers_scope", unique: true
    t.index ["project_id"], name: "idx_project_trackers_one_primary", unique: true, where: "\"primary\""
  end

  create_table "projects", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.string "name", null: false
    t.text "description"
    t.string "slug", null: false
    t.string "state", null: false
    t.jsonb "settings", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.bigint "owner_id", null: false
    t.string "preferred_artifacts_language", default: "en"
    t.index ["company_id", "name"], name: "index_projects_on_company_id_and_name", unique: true
    t.index ["company_id", "slug"], name: "index_projects_on_company_id_and_slug", unique: true
    t.index ["company_id"], name: "index_projects_on_company_id"
    t.index ["id", "company_id"], name: "index_projects_on_id_and_company_id", unique: true
    t.index ["owner_id"], name: "index_projects_on_owner_id"
    t.index ["state"], name: "index_projects_on_state"
  end

  create_table "pull_request_operations", force: :cascade do |t|
    t.bigint "integration_id", null: false
    t.bigint "repository_id", null: false
    t.string "operation", null: false
    t.string "operation_key", null: false
    t.string "request_digest", null: false
    t.string "state", default: "pending", null: false
    t.jsonb "result", default: {}, null: false
    t.string "error_code"
    t.string "pull_request_number"
    t.bigint "terminal_session_id"
    t.bigint "workflow_run_id"
    t.bigint "workflow_id"
    t.bigint "user_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["integration_id", "operation_key"], name: "idx_pull_request_operations_key", unique: true
    t.index ["repository_id", "pull_request_number"], name: "idx_on_repository_id_pull_request_number_59fcb5ad05"
  end

  create_table "received_webhooks", force: :cascade do |t|
    t.bigint "webhook_endpoint_id", null: false
    t.string "idempotency_key", null: false
    t.string "event_type"
    t.string "status", default: "received", null: false
    t.jsonb "raw_payload", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["webhook_endpoint_id", "idempotency_key"], name: "index_received_webhooks_on_endpoint_and_idempotency_key", unique: true
    t.index ["webhook_endpoint_id"], name: "index_received_webhooks_on_webhook_endpoint_id"
  end

  create_table "repositories", force: :cascade do |t|
    t.string "full_name", null: false
    t.string "source_branch", default: "main", null: false
    t.string "clone_url", null: false
    t.boolean "is_private", default: false
    t.text "description"
    t.datetime "last_fetched_at"
    t.bigint "integration_id"
    t.string "scope_type", null: false
    t.bigint "scope_id", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.text "purpose"
    t.string "webhook_secret"
    t.string "external_id"
    t.string "external_project_id"
    t.string "external_organization_id"
    t.bigint "project_id"
    t.bigint "company_id"
    t.bigint "gitlab_hook_id"
    t.index ["company_id"], name: "index_repositories_on_company_id"
    t.index ["integration_id"], name: "index_repositories_on_integration_id"
    t.index ["project_id"], name: "index_repositories_on_project_id"
    t.index ["scope_type", "scope_id", "external_organization_id", "external_project_id", "external_id"], name: "idx_repositories_external_identity", unique: true, where: "(external_id IS NOT NULL)"
    t.index ["scope_type", "scope_id", "full_name"], name: "idx_repositories_scope_full_name", unique: true
    t.index ["scope_type", "scope_id"], name: "index_repositories_on_scope_type_and_scope_id"
    t.index ["webhook_secret"], name: "index_repositories_on_webhook_secret", unique: true
  end

  add_check_constraint "repositories", "project_id IS NULL AND company_id IS NULL OR scope_type::text = 'Project'::text AND project_id = scope_id AND company_id IS NOT NULL", name: "repositories_tenant_columns", validate: false

  create_table "runner_credentials", force: :cascade do |t|
    t.bigint "runner_id", null: false
    t.bigint "company_id", null: false
    t.bigint "runner_environment_id"
    t.string "kind", null: false
    t.string "token_digest", null: false
    t.uuid "family_id"
    t.datetime "expires_at", null: false
    t.datetime "used_at"
    t.datetime "revoked_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["company_id"], name: "index_runner_credentials_on_company_id"
    t.index ["family_id"], name: "index_runner_credentials_on_family_id"
    t.index ["runner_environment_id"], name: "index_runner_credentials_on_runner_environment_id"
    t.index ["runner_id"], name: "index_runner_credentials_on_runner_id"
    t.index ["token_digest"], name: "index_runner_credentials_on_token_digest", unique: true
  end

  create_table "runner_environments", force: :cascade do |t|
    t.bigint "runner_id", null: false
    t.bigint "company_id", null: false
    t.string "key", null: false
    t.string "origin", null: false
    t.string "display_name"
    t.boolean "ephemeral", default: false, null: false
    t.string "state", null: false
    t.string "state_reason"
    t.string "os"
    t.string "arch"
    t.jsonb "facts", default: {}, null: false
    t.string "runner_version"
    t.string "protocol_version"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["company_id"], name: "index_runner_environments_on_company_id"
    t.index ["id", "runner_id"], name: "index_runner_environments_on_id_and_runner_id", unique: true
    t.index ["runner_id", "key"], name: "index_runner_environments_on_runner_id_and_key", unique: true
    t.index ["runner_id"], name: "index_runner_environments_on_runner_id"
  end

  create_table "runners", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.bigint "project_id"
    t.string "name", null: false
    t.string "runner_type", null: false
    t.string "status", default: "pending", null: false
    t.string "status_reason"
    t.bigint "integration_id"
    t.jsonb "config", default: {}, null: false
    t.integer "max_concurrency", null: false
    t.integer "max_environments"
    t.string "reuse_policy", null: false
    t.jsonb "capabilities", default: {}, null: false
    t.jsonb "health", default: {}, null: false
    t.datetime "last_seen_at"
    t.bigint "created_by_id"
    t.datetime "disabled_at"
    t.datetime "revoked_at"
    t.datetime "deleted_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index "company_id, COALESCE(project_id, (0)::bigint), lower((name)::text)", name: "index_runners_on_scope_and_name", unique: true, where: "(deleted_at IS NULL)"
    t.index ["company_id"], name: "index_runners_on_company_id"
    t.index ["created_by_id"], name: "index_runners_on_created_by_id"
    t.index ["id", "company_id"], name: "index_runners_on_id_and_company_id", unique: true
    t.index ["integration_id"], name: "index_runners_on_integration_id"
    t.index ["project_id"], name: "index_runners_on_project_id"
    t.check_constraint "(runner_type::text = 'coder'::text) = (integration_id IS NOT NULL)", name: "runners_coder_integration"
    t.check_constraint "max_concurrency > 0", name: "runners_max_concurrency_positive"
    t.check_constraint "max_environments IS NULL OR max_environments > 0", name: "runners_max_environments_positive"
    t.check_constraint "runner_type::text <> 'manual'::text OR max_environments IS NULL", name: "runners_manual_no_pool_size"
  end

  create_table "scim_configurations", force: :cascade do |t|
    t.bigint "company_id", null: false
    t.string "token_digest", null: false
    t.boolean "enabled", default: true, null: false
    t.datetime "last_seen_at"
    t.bigint "identity_provider_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["company_id"], name: "index_scim_configurations_on_company_id", unique: true
    t.index ["identity_provider_id"], name: "index_scim_configurations_on_identity_provider_id"
    t.index ["token_digest"], name: "index_scim_configurations_on_token_digest", unique: true
  end

  create_table "session_admission_policies", force: :cascade do |t|
    t.boolean "enabled", default: true, null: false
    t.boolean "paused", default: false, null: false
    t.integer "revision", default: 1, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.check_constraint "id = 1", name: "valid_session_policy"
  end

  create_table "session_admission_pools", force: :cascade do |t|
    t.string "key", null: false
    t.integer "limit", null: false
    t.integer "policy_revision", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["key"], name: "index_session_admission_pools_on_key", unique: true
    t.check_constraint "\"limit\" > 0", name: "positive_session_pool_limit"
  end

  create_table "session_admissions", force: :cascade do |t|
    t.bigint "terminal_session_id", null: false
    t.bigint "session_admission_pool_id", null: false
    t.string "permit_token"
    t.datetime "admitted_at"
    t.datetime "released_at"
    t.datetime "stop_requested_at"
    t.string "launch_state", default: "pending", null: false
    t.datetime "claimed_at"
    t.string "claim_token"
    t.string "runtime_id"
    t.string "runtime_kind"
    t.jsonb "phase_state", default: {}, null: false
    t.string "wait_reason", default: "concurrency_limit"
    t.text "last_error"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.integer "launch_attempts", default: 0, null: false
    t.index ["permit_token"], name: "index_session_admissions_on_permit_token", unique: true
    t.index ["released_at"], name: "index_session_admissions_on_released_at"
    t.index ["session_admission_pool_id", "id"], name: "session_admission_fifo", where: "(released_at IS NULL)"
    t.index ["session_admission_pool_id"], name: "index_session_admissions_on_session_admission_pool_id"
    t.index ["terminal_session_id"], name: "index_session_admissions_on_terminal_session_id", unique: true
  end

  create_table "session_concurrency_limits", force: :cascade do |t|
    t.string "scope_type", null: false
    t.bigint "scope_id", null: false
    t.integer "max_sessions", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.bigint "project_id"
    t.bigint "company_id"
    t.index ["company_id"], name: "index_session_concurrency_limits_on_company_id"
    t.index ["project_id"], name: "index_session_concurrency_limits_on_project_id"
    t.index ["scope_type", "scope_id"], name: "index_session_concurrency_limits_on_scope_type_and_scope_id", unique: true
    t.check_constraint "max_sessions > 0 AND (scope_type::text = ANY (ARRAY['Project'::character varying::text, 'Company'::character varying::text]))", name: "valid_session_scope_limit"
  end

  add_check_constraint "session_concurrency_limits", "project_id IS NULL AND company_id IS NULL OR scope_type::text = 'Project'::text AND project_id = scope_id AND company_id IS NOT NULL OR scope_type::text = 'Company'::text AND project_id IS NULL AND company_id = scope_id", name: "session_concurrency_limits_tenant_columns", validate: false

  create_table "session_config_items", id: false, force: :cascade do |t|
    t.bigint "terminal_session_id", null: false
    t.bigint "config_item_id", null: false
    t.index ["config_item_id"], name: "index_session_config_items_on_config_item_id"
    t.index ["terminal_session_id", "config_item_id"], name: "index_session_config_items_on_session_and_item", unique: true
  end

  create_table "session_input_assets", id: false, force: :cascade do |t|
    t.bigint "terminal_session_id", null: false
    t.bigint "asset_id", null: false
    t.index ["terminal_session_id", "asset_id"], name: "index_session_input_assets_on_terminal_session_id_and_asset_id", unique: true
  end

  create_table "session_logs", force: :cascade do |t|
    t.bigint "terminal_session_id", null: false
    t.string "name", null: false
    t.text "file_data"
    t.bigint "file_size"
    t.string "content_type"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["terminal_session_id"], name: "index_session_logs_on_terminal_session_id"
  end

  create_table "session_mcp_servers", id: false, force: :cascade do |t|
    t.bigint "terminal_session_id", null: false
    t.bigint "mcp_server_id", null: false
    t.index ["terminal_session_id", "mcp_server_id"], name: "idx_on_terminal_session_id_mcp_server_id_84ce6e54b4", unique: true
  end

  create_table "session_repositories", id: false, force: :cascade do |t|
    t.bigint "terminal_session_id", null: false
    t.bigint "repository_id", null: false
    t.index ["terminal_session_id", "repository_id"], name: "idx_on_terminal_session_id_repository_id_6a57113eb8", unique: true
  end

  create_table "session_runtime_operations", force: :cascade do |t|
    t.bigint "session_admission_id", null: false
    t.string "phase", null: false
    t.string "state", default: "in_flight", null: false
    t.jsonb "result", default: {}, null: false
    t.text "error"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.datetime "absent_since"
    t.index ["session_admission_id", "phase"], name: "session_runtime_phase_once", unique: true
    t.index ["session_admission_id"], name: "index_session_runtime_operations_on_session_admission_id"
  end

  create_table "session_skills", id: false, force: :cascade do |t|
    t.bigint "terminal_session_id", null: false
    t.bigint "skill_id", null: false
    t.index ["terminal_session_id", "skill_id"], name: "index_session_skills_on_terminal_session_id_and_skill_id", unique: true
  end

  create_table "session_tools", id: false, force: :cascade do |t|
    t.bigint "terminal_session_id", null: false
    t.bigint "tool_id", null: false
    t.index ["terminal_session_id", "tool_id"], name: "index_session_tools_on_terminal_session_id_and_tool_id", unique: true
  end

  create_table "skills", force: :cascade do |t|
    t.string "name", null: false
    t.string "title"
    t.text "content"
    t.text "description"
    t.string "scope_type"
    t.bigint "scope_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "package"
    t.string "source"
    t.string "source_url"
    t.integer "install_count", default: 0
    t.string "origin", default: "registry", null: false
    t.string "content_hash"
    t.bigint "project_id"
    t.bigint "company_id"
    t.jsonb "files", default: {}, null: false
    t.integer "current_version_number", default: 0, null: false
    t.datetime "archived_at"
    t.index ["company_id"], name: "index_skills_on_company_id"
    t.index ["origin"], name: "index_skills_on_origin"
    t.index ["package"], name: "index_skills_on_package"
    t.index ["project_id"], name: "index_skills_on_project_id"
    t.index ["scope_type", "scope_id", "name"], name: "index_skills_on_scope_type_and_scope_id_and_name", unique: true, where: "(archived_at IS NULL)", nulls_not_distinct: true
    t.index ["scope_type", "scope_id"], name: "index_skills_on_scope_type_and_scope_id"
  end

  add_check_constraint "skills", "project_id IS NULL AND company_id IS NULL OR scope_type::text = 'Project'::text AND project_id = scope_id AND company_id IS NOT NULL", name: "skills_tenant_columns", validate: false

  create_table "solid_queue_blocked_executions", force: :cascade do |t|
    t.bigint "job_id", null: false
    t.string "queue_name", null: false
    t.integer "priority", default: 0, null: false
    t.string "concurrency_key", null: false
    t.datetime "expires_at", null: false
    t.datetime "created_at", null: false
    t.index ["concurrency_key", "priority", "job_id"], name: "index_solid_queue_blocked_executions_for_release"
    t.index ["expires_at", "concurrency_key"], name: "index_solid_queue_blocked_executions_for_maintenance"
    t.index ["job_id"], name: "index_solid_queue_blocked_executions_on_job_id", unique: true
  end

  create_table "solid_queue_claimed_executions", force: :cascade do |t|
    t.bigint "job_id", null: false
    t.bigint "process_id"
    t.datetime "created_at", null: false
    t.index ["job_id"], name: "index_solid_queue_claimed_executions_on_job_id", unique: true
    t.index ["process_id", "job_id"], name: "index_solid_queue_claimed_executions_on_process_id_and_job_id"
  end

  create_table "solid_queue_failed_executions", force: :cascade do |t|
    t.bigint "job_id", null: false
    t.text "error"
    t.datetime "created_at", null: false
    t.index ["job_id"], name: "index_solid_queue_failed_executions_on_job_id", unique: true
  end

  create_table "solid_queue_jobs", force: :cascade do |t|
    t.string "queue_name", null: false
    t.string "class_name", null: false
    t.text "arguments"
    t.integer "priority", default: 0, null: false
    t.string "active_job_id"
    t.datetime "scheduled_at"
    t.datetime "finished_at"
    t.string "concurrency_key"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["active_job_id"], name: "index_solid_queue_jobs_on_active_job_id"
    t.index ["class_name"], name: "index_solid_queue_jobs_on_class_name"
    t.index ["finished_at"], name: "index_solid_queue_jobs_on_finished_at"
    t.index ["queue_name", "finished_at"], name: "index_solid_queue_jobs_for_filtering"
    t.index ["scheduled_at", "finished_at"], name: "index_solid_queue_jobs_for_alerting"
  end

  create_table "solid_queue_pauses", force: :cascade do |t|
    t.string "queue_name", null: false
    t.datetime "created_at", null: false
    t.index ["queue_name"], name: "index_solid_queue_pauses_on_queue_name", unique: true
  end

  create_table "solid_queue_processes", force: :cascade do |t|
    t.string "kind", null: false
    t.datetime "last_heartbeat_at", null: false
    t.bigint "supervisor_id"
    t.integer "pid", null: false
    t.string "hostname"
    t.text "metadata"
    t.datetime "created_at", null: false
    t.string "name", null: false
    t.index ["last_heartbeat_at"], name: "index_solid_queue_processes_on_last_heartbeat_at"
    t.index ["name", "supervisor_id"], name: "index_solid_queue_processes_on_name_and_supervisor_id", unique: true
    t.index ["supervisor_id"], name: "index_solid_queue_processes_on_supervisor_id"
  end

  create_table "solid_queue_ready_executions", force: :cascade do |t|
    t.bigint "job_id", null: false
    t.string "queue_name", null: false
    t.integer "priority", default: 0, null: false
    t.datetime "created_at", null: false
    t.index ["job_id"], name: "index_solid_queue_ready_executions_on_job_id", unique: true
    t.index ["priority", "job_id"], name: "index_solid_queue_poll_all"
    t.index ["queue_name", "priority", "job_id"], name: "index_solid_queue_poll_by_queue"
  end

  create_table "solid_queue_recurring_executions", force: :cascade do |t|
    t.bigint "job_id", null: false
    t.string "task_key", null: false
    t.datetime "run_at", null: false
    t.datetime "created_at", null: false
    t.index ["job_id"], name: "index_solid_queue_recurring_executions_on_job_id", unique: true
    t.index ["task_key", "run_at"], name: "index_solid_queue_recurring_executions_on_task_key_and_run_at", unique: true
  end

  create_table "solid_queue_recurring_tasks", force: :cascade do |t|
    t.string "key", null: false
    t.string "schedule", null: false
    t.string "command", limit: 2048
    t.string "class_name"
    t.text "arguments"
    t.string "queue_name"
    t.integer "priority", default: 0
    t.boolean "static", default: true, null: false
    t.text "description"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["key"], name: "index_solid_queue_recurring_tasks_on_key", unique: true
    t.index ["static"], name: "index_solid_queue_recurring_tasks_on_static"
  end

  create_table "solid_queue_scheduled_executions", force: :cascade do |t|
    t.bigint "job_id", null: false
    t.string "queue_name", null: false
    t.integer "priority", default: 0, null: false
    t.datetime "scheduled_at", null: false
    t.datetime "created_at", null: false
    t.index ["job_id"], name: "index_solid_queue_scheduled_executions_on_job_id", unique: true
    t.index ["scheduled_at", "priority", "job_id"], name: "index_solid_queue_dispatch_all"
  end

  create_table "solid_queue_semaphores", force: :cascade do |t|
    t.string "key", null: false
    t.integer "value", default: 1, null: false
    t.datetime "expires_at", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["expires_at"], name: "index_solid_queue_semaphores_on_expires_at"
    t.index ["key", "value"], name: "index_solid_queue_semaphores_on_key_and_value"
    t.index ["key"], name: "index_solid_queue_semaphores_on_key", unique: true
  end

  create_table "step_runs", force: :cascade do |t|
    t.bigint "workflow_run_id", null: false
    t.bigint "step_id", null: false
    t.bigint "terminal_session_id"
    t.string "state", default: "pending", null: false
    t.text "step_note"
    t.string "skip_reason"
    t.datetime "started_at"
    t.datetime "completed_at"
    t.text "error_message"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.integer "retry_count", default: 0, null: false
    t.jsonb "error_history", default: [], null: false
    t.string "error_category"
    t.bigint "workflow_version_id"
    t.index ["step_id"], name: "index_step_runs_on_step_id"
    t.index ["terminal_session_id"], name: "index_step_runs_on_terminal_session_id"
    t.index ["workflow_run_id", "state"], name: "index_step_runs_on_workflow_run_id_and_state"
    t.index ["workflow_run_id"], name: "index_step_runs_on_workflow_run_id"
    t.index ["workflow_version_id"], name: "index_step_runs_on_workflow_version_id", where: "(workflow_version_id IS NOT NULL)"
  end

  create_table "steps", force: :cascade do |t|
    t.bigint "workflow_id", null: false
    t.bigint "agent_id"
    t.integer "position", null: false
    t.string "name", null: false
    t.text "instructions"
    t.boolean "allow_non_interactive", default: false, null: false
    t.string "skip_policy", default: "never", null: false
    t.jsonb "input_asset_specs", default: [], null: false
    t.jsonb "output_asset_specs", default: [], null: false
    t.jsonb "tool_ids", default: [], null: false
    t.string "on_failure", default: "fail", null: false
    t.integer "max_retries", default: 0, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.jsonb "mcp_server_ids", default: [], null: false
    t.jsonb "skill_ids", default: [], null: false
    t.jsonb "depends_on_step_ids", default: [], null: false
    t.string "required_agent_runtime"
    t.boolean "bmad_enabled", default: false, null: false
    t.datetime "deleted_at"
    t.string "preferred_model"
    t.jsonb "asset_ids", default: [], null: false
    t.jsonb "repository_ids", default: [], null: false
    t.jsonb "config_item_ids", default: [], null: false
    t.string "reasoning_effort"
    t.index ["agent_id"], name: "index_steps_on_agent_id"
    t.index ["deleted_at"], name: "index_steps_on_deleted_at"
    t.index ["workflow_id", "position"], name: "index_steps_on_workflow_id_and_position", unique: true
    t.index ["workflow_id"], name: "index_steps_on_workflow_id"
  end

  create_table "sub_step_runs", force: :cascade do |t|
    t.bigint "step_run_id", null: false
    t.bigint "sub_step_id", null: false
    t.string "state"
    t.text "note"
    t.jsonb "data"
    t.datetime "started_at"
    t.datetime "completed_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["step_run_id"], name: "index_sub_step_runs_on_step_run_id"
    t.index ["sub_step_id"], name: "index_sub_step_runs_on_sub_step_id"
  end

  create_table "sub_steps", force: :cascade do |t|
    t.bigint "step_id", null: false
    t.integer "position", null: false
    t.string "name", null: false
    t.text "instructions"
    t.boolean "required", default: true, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.datetime "deleted_at"
    t.index ["deleted_at"], name: "index_sub_steps_on_deleted_at"
    t.index ["step_id", "position"], name: "index_sub_steps_on_step_id_and_position"
    t.index ["step_id"], name: "index_sub_steps_on_step_id"
  end

  create_table "task_assets", force: :cascade do |t|
    t.bigint "board_task_id", null: false
    t.string "name", null: false
    t.bigint "author_id"
    t.string "author_type", default: "human", null: false
    t.string "tags", default: [], array: true
    t.text "file_data"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "public_token"
    t.datetime "shared_at"
    t.bigint "shared_by_id"
    t.bigint "shared_in_session_id"
    t.string "source", default: "upload", null: false
    t.string "content_sha256"
    t.index ["author_id"], name: "index_task_assets_on_author_id"
    t.index ["board_task_id"], name: "index_task_assets_on_board_task_id"
    t.index ["public_token"], name: "index_task_assets_on_public_token", unique: true, where: "(public_token IS NOT NULL)"
    t.index ["shared_by_id"], name: "index_task_assets_on_shared_by_id", where: "(shared_by_id IS NOT NULL)"
    t.index ["shared_in_session_id"], name: "index_task_assets_on_shared_in_session_id", where: "(shared_in_session_id IS NOT NULL)"
  end

  create_table "task_comments", force: :cascade do |t|
    t.bigint "board_task_id", null: false
    t.text "body", null: false
    t.bigint "author_id"
    t.string "author_type", default: "human", null: false
    t.string "tags", default: [], array: true
    t.datetime "created_at", null: false
    t.index ["author_id"], name: "index_task_comments_on_author_id"
    t.index ["board_task_id"], name: "index_task_comments_on_board_task_id"
  end

  create_table "template_installs", force: :cascade do |t|
    t.bigint "project_id", null: false
    t.bigint "installed_by_id"
    t.string "namespace", null: false
    t.string "slug", null: false
    t.integer "version", null: false
    t.string "commit_sha", null: false
    t.string "package_digest", null: false
    t.string "idempotency_key", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["installed_by_id", "idempotency_key"], name: "index_template_installs_on_installed_by_id_and_idempotency_key", unique: true
    t.index ["installed_by_id"], name: "index_template_installs_on_installed_by_id"
    t.index ["namespace", "slug"], name: "index_template_installs_on_namespace_and_slug"
    t.index ["project_id"], name: "index_template_installs_on_project_id"
  end

  create_table "template_setup_items", force: :cascade do |t|
    t.bigint "template_install_id", null: false
    t.string "kind", null: false
    t.string "ref", null: false
    t.string "status", default: "pending", null: false
    t.integer "position", default: 0, null: false
    t.jsonb "detail", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["template_install_id", "ref"], name: "index_template_setup_items_on_template_install_id_and_ref", unique: true
    t.index ["template_install_id"], name: "index_template_setup_items_on_template_install_id"
  end

  create_table "terminal_sessions", force: :cascade do |t|
    t.bigint "user_id"
    t.bigint "project_id"
    t.string "session_type", null: false
    t.string "agent_type"
    t.string "state", null: false
    t.string "temporal_workflow_id"
    t.string "temporal_run_id"
    t.string "container_id"
    t.string "artifacts_path"
    t.text "error_message"
    t.jsonb "metadata", default: {}
    t.datetime "started_at"
    t.datetime "finished_at"
    t.datetime "collected_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "route_token"
    t.string "mcp_key"
    t.jsonb "session_config", default: {}, null: false
    t.bigint "total_tokens", default: 0, null: false
    t.bigint "input_tokens", default: 0, null: false
    t.bigint "output_tokens", default: 0, null: false
    t.bigint "cache_read_tokens", default: 0, null: false
    t.bigint "cache_write_tokens", default: 0, null: false
    t.bigint "cost_cents", default: 0, null: false
    t.string "models", default: [], null: false, array: true
    t.boolean "artifacts_reviewed", default: false
    t.bigint "configured_agent_id"
    t.string "mode", default: "interactive"
    t.text "initial_prompt"
    t.datetime "ready_at"
    t.jsonb "context_metadata"
    t.string "requested_model"
    t.datetime "finishing_at"
    t.bigint "company_id"
    t.datetime "queued_at"
    t.jsonb "version_ids", default: {}, null: false
    t.bigint "runner_id"
    t.string "reasoning_effort"
    t.index ["company_id"], name: "index_terminal_sessions_on_company_id"
    t.index ["configured_agent_id"], name: "index_terminal_sessions_on_configured_agent_id"
    t.index ["finished_at"], name: "index_terminal_sessions_on_finished_at"
    t.index ["mcp_key"], name: "index_terminal_sessions_on_mcp_key", unique: true
    t.index ["project_id"], name: "index_terminal_sessions_on_project_id"
    t.index ["route_token"], name: "index_terminal_sessions_on_route_token", unique: true
    t.index ["runner_id"], name: "index_terminal_sessions_on_runner_id"
    t.index ["session_type"], name: "index_terminal_sessions_on_session_type"
    t.index ["state"], name: "index_terminal_sessions_on_state"
    t.index ["temporal_workflow_id"], name: "index_terminal_sessions_on_temporal_workflow_id"
    t.index ["user_id", "created_at"], name: "index_terminal_sessions_on_user_id_and_created_at"
    t.index ["user_id", "session_type"], name: "index_terminal_sessions_on_user_id_and_session_type"
    t.index ["user_id", "state"], name: "index_terminal_sessions_on_user_id_and_state"
    t.index ["user_id"], name: "index_terminal_sessions_on_user_id"
  end

  create_table "tool_files", force: :cascade do |t|
    t.bigint "tool_id", null: false
    t.string "path", null: false
    t.text "content"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.text "file_data"
    t.index ["tool_id", "path"], name: "index_tool_files_on_tool_id_and_path", unique: true
    t.index ["tool_id"], name: "index_tool_files_on_tool_id"
  end

  create_table "tool_results", force: :cascade do |t|
    t.string "execution_id", null: false
    t.string "state", default: "processing", null: false
    t.bigint "tool_id", null: false
    t.bigint "terminal_session_id"
    t.bigint "step_run_id"
    t.integer "exit_code"
    t.string "error"
    t.integer "duration_ms"
    t.text "stdout_data"
    t.text "stderr_data"
    t.text "result_data_data"
    t.text "output_data"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["execution_id"], name: "index_tool_results_on_execution_id", unique: true
    t.index ["state", "created_at"], name: "index_tool_results_on_state_and_created_at"
    t.index ["step_run_id"], name: "index_tool_results_on_step_run_id"
    t.index ["terminal_session_id"], name: "index_tool_results_on_terminal_session_id"
    t.index ["tool_id"], name: "index_tool_results_on_tool_id"
  end

  create_table "tools", force: :cascade do |t|
    t.string "name", null: false
    t.string "display_name", null: false
    t.text "description"
    t.string "scope_type"
    t.bigint "scope_id"
    t.string "docker_image"
    t.text "command"
    t.jsonb "required_config_items", default: []
    t.jsonb "input_schema", default: {}
    t.boolean "enabled", default: true
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "execution_mode", default: "container", null: false
    t.datetime "deleted_at"
    t.string "requires_integration"
    t.string "source", default: "db", null: false
    t.boolean "user_attachable", default: true, null: false
    t.jsonb "tags", default: [], null: false
    t.string "definition_digest"
    t.string "docker_image_digest"
    t.bigint "project_id"
    t.bigint "company_id"
    t.integer "current_version_number", default: 0, null: false
    t.index ["company_id"], name: "index_tools_on_company_id"
    t.index ["deleted_at"], name: "index_tools_on_deleted_at"
    t.index ["name"], name: "index_tools_on_name_where_source_code", unique: true, where: "(((source)::text = 'code'::text) AND (deleted_at IS NULL))"
    t.index ["project_id"], name: "index_tools_on_project_id"
    t.index ["scope_type", "scope_id", "name"], name: "index_tools_on_scope_type_and_scope_id_and_name", unique: true, where: "(deleted_at IS NULL)"
  end

  add_check_constraint "tools", "name::text !~~ 'mcp\\_\\_%'::text", name: "tools_name_not_managed_namespace", validate: false
  add_check_constraint "tools", "project_id IS NULL AND company_id IS NULL OR scope_type IS NULL AND scope_id IS NULL AND project_id IS NULL AND company_id IS NULL OR scope_type::text = 'Project'::text AND project_id = scope_id AND company_id IS NOT NULL", name: "tools_tenant_columns", validate: false

  create_table "tracker_accounts", force: :cascade do |t|
    t.string "provider", null: false
    t.string "account_id", null: false
    t.string "status", default: "active", null: false
    t.datetime "first_seen_at", null: false
    t.datetime "last_seen_at", null: false
    t.datetime "reported_at"
    t.datetime "closed_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["provider", "account_id"], name: "index_tracker_accounts_on_provider_and_account_id", unique: true
    t.index ["provider", "status", "reported_at"], name: "index_tracker_accounts_on_provider_and_status_and_reported_at"
  end

  create_table "tracker_attachments", force: :cascade do |t|
    t.bigint "project_id", null: false
    t.string "provider", null: false
    t.string "instance", null: false
    t.string "issue_id", null: false
    t.string "external_id", null: false
    t.string "direction", null: false
    t.string "content_sha256", null: false
    t.bigint "task_asset_id"
    t.bigint "tracker_operation_id"
    t.jsonb "data", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["project_id", "provider", "instance", "issue_id", "content_sha256"], name: "idx_tracker_attachments_content"
    t.index ["project_id", "provider", "instance", "issue_id", "external_id"], name: "idx_tracker_attachments_identity", unique: true
    t.index ["task_asset_id"], name: "index_tracker_attachments_on_task_asset_id"
  end

  create_table "tracker_deliveries", force: :cascade do |t|
    t.bigint "tracker_subscription_id", null: false
    t.string "dedup_key", null: false
    t.jsonb "notifications", default: [], null: false
    t.string "status", default: "received", null: false
    t.jsonb "detail", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["created_at"], name: "index_tracker_deliveries_on_created_at"
    t.index ["tracker_subscription_id", "dedup_key"], name: "idx_tracker_deliveries_dedup", unique: true
  end

  create_table "tracker_operations", force: :cascade do |t|
    t.bigint "project_tracker_id", null: false
    t.string "operation", null: false
    t.string "operation_key", null: false
    t.string "request_digest", null: false
    t.string "state", default: "pending", null: false
    t.string "error_code"
    t.string "issue_id"
    t.jsonb "change", default: {}, null: false
    t.string "result_ref"
    t.jsonb "result", default: {}, null: false
    t.bigint "terminal_session_id"
    t.bigint "user_id"
    t.bigint "workflow_run_id"
    t.bigint "workflow_id"
    t.jsonb "chain", default: [], null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["project_tracker_id", "issue_id", "created_at"], name: "idx_tracker_operations_issue"
    t.index ["project_tracker_id", "operation_key"], name: "idx_tracker_operations_key", unique: true
  end

  create_table "tracker_subscriptions", force: :cascade do |t|
    t.bigint "integration_id", null: false
    t.string "external_scope_id"
    t.string "strategy", null: false
    t.string "endpoint_token", null: false
    t.text "encrypted_secret"
    t.string "provider_subscription_id"
    t.jsonb "settings", default: {}, null: false
    t.string "status", default: "pending", null: false
    t.datetime "expires_at"
    t.datetime "last_event_at"
    t.string "last_error"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["endpoint_token"], name: "index_tracker_subscriptions_on_endpoint_token", unique: true
    t.index ["expires_at"], name: "index_tracker_subscriptions_on_expires_at"
    t.index ["integration_id", "external_scope_id"], name: "idx_tracker_subscriptions_scope", unique: true, nulls_not_distinct: true
    t.index ["provider_subscription_id"], name: "index_tracker_subscriptions_on_provider_subscription_id"
  end

  create_table "trigger_bindings", force: :cascade do |t|
    t.bigint "project_id", null: false
    t.bigint "workflow_id", null: false
    t.bigint "created_by_id"
    t.string "name"
    t.string "event_type", null: false
    t.jsonb "filter_predicate", default: {}, null: false
    t.string "trigger_mode", default: "auto", null: false
    t.boolean "enabled", default: true, null: false
    t.integer "cooldown_seconds", default: 0, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "subject_policy", default: "none", null: false
    t.string "subject_title_template"
    t.bigint "subject_column_id"
    t.jsonb "schedule_config", default: {}, null: false
    t.bigint "project_tracker_id"
    t.string "aixle_changes", default: "ignore", null: false
    t.string "status_reporting", default: "failures", null: false
    t.boolean "copy_attachments", default: false, null: false
    t.bigint "chat_conversation_id"
    t.index ["chat_conversation_id"], name: "index_trigger_bindings_on_chat_conversation_id"
    t.index ["created_by_id"], name: "index_trigger_bindings_on_created_by_id"
    t.index ["project_id", "event_type", "enabled"], name: "idx_on_project_id_event_type_enabled_44a9c97a71"
    t.index ["project_id"], name: "index_trigger_bindings_on_project_id"
    t.index ["project_tracker_id"], name: "index_trigger_bindings_on_project_tracker_id"
    t.index ["subject_column_id"], name: "index_trigger_bindings_on_subject_column_id"
    t.index ["workflow_id"], name: "index_trigger_bindings_on_workflow_id"
  end

  create_table "trigger_dispatches", force: :cascade do |t|
    t.bigint "trigger_event_id", null: false
    t.bigint "trigger_binding_id"
    t.bigint "workflow_run_id"
    t.string "source"
    t.string "status", default: "matched", null: false
    t.string "dedup_key", null: false
    t.jsonb "detail", default: {}, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["dedup_key"], name: "index_trigger_dispatches_on_dedup_key", unique: true
    t.index ["trigger_binding_id", "created_at"], name: "index_trigger_dispatches_on_binding_and_created_at"
    t.index ["trigger_binding_id"], name: "index_trigger_dispatches_on_trigger_binding_id"
    t.index ["trigger_event_id"], name: "index_trigger_dispatches_on_trigger_event_id"
    t.index ["workflow_run_id"], name: "index_trigger_dispatches_on_workflow_run_id"
  end

  create_table "trigger_events", force: :cascade do |t|
    t.string "event_type", null: false
    t.string "source"
    t.string "subject"
    t.jsonb "data", default: {}, null: false
    t.string "dedup_key"
    t.datetime "occurred_at"
    t.bigint "project_id"
    t.bigint "board_task_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "relay_state", default: "dispatched", null: false
    t.datetime "dispatched_at"
    t.integer "relay_attempts", default: 0, null: false
    t.string "relay_error"
    t.bigint "actor_id"
    t.bigint "company_id"
    t.index ["actor_id"], name: "index_trigger_events_on_actor_id"
    t.index ["board_task_id"], name: "index_trigger_events_on_board_task_id"
    t.index ["company_id", "event_type"], name: "index_trigger_events_on_company_id_and_event_type"
    t.index ["dedup_key"], name: "index_trigger_events_on_dedup_key_unique", unique: true, where: "(dedup_key IS NOT NULL)"
    t.index ["event_type"], name: "index_trigger_events_on_event_type"
    t.index ["project_id", "event_type"], name: "index_trigger_events_on_project_id_and_event_type"
    t.index ["relay_state", "created_at"], name: "index_trigger_events_pending_relay", where: "((relay_state)::text = ANY (ARRAY[('pending'::character varying)::text, ('dispatching'::character varying)::text]))"
  end

  create_table "usage_statistics", force: :cascade do |t|
    t.bigint "terminal_session_id", null: false
    t.bigint "cost_cents", default: 0, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.bigint "input_tokens", default: 0, null: false
    t.bigint "output_tokens", default: 0, null: false
    t.bigint "cache_write_tokens", default: 0, null: false
    t.bigint "cache_read_tokens", default: 0, null: false
    t.decimal "total_cents_precise", precision: 12, scale: 6, default: "0.0"
    t.string "source", default: "unknown", null: false
    t.integer "events_count", default: 0, null: false
    t.jsonb "events_data", default: []
    t.string "models", default: [], null: false, array: true
    t.index ["terminal_session_id"], name: "index_usage_statistics_on_terminal_session_id", unique: true
  end

  create_table "usage_statistics_batch_receipts", force: :cascade do |t|
    t.bigint "terminal_session_id", null: false
    t.string "batch_key", null: false
    t.string "payload_digest", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["terminal_session_id", "batch_key"], name: "index_usage_batch_receipts_on_session_and_digest", unique: true
    t.index ["terminal_session_id"], name: "index_usage_statistics_batch_receipts_on_terminal_session_id"
  end

  create_table "usage_statistics_event_receipts", force: :cascade do |t|
    t.bigint "terminal_session_id", null: false
    t.string "event_key", null: false
    t.string "payload_digest", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["terminal_session_id", "event_key"], name: "index_usage_event_receipts_on_session_and_key", unique: true
    t.index ["terminal_session_id"], name: "index_usage_statistics_event_receipts_on_terminal_session_id"
  end

  create_table "user_identities", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.bigint "identity_provider_id", null: false
    t.string "subject", null: false
    t.string "email"
    t.boolean "email_verified", default: false, null: false
    t.datetime "last_used_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["identity_provider_id", "subject"], name: "index_user_identities_on_identity_provider_id_and_subject", unique: true
    t.index ["identity_provider_id"], name: "index_user_identities_on_identity_provider_id"
    t.index ["user_id"], name: "index_user_identities_on_user_id"
  end

  create_table "user_session_proofs", force: :cascade do |t|
    t.bigint "user_session_id", null: false
    t.bigint "identity_provider_id", null: false
    t.datetime "proved_at", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["identity_provider_id"], name: "index_user_session_proofs_on_identity_provider_id"
    t.index ["user_session_id", "identity_provider_id"], name: "index_user_session_proofs_unique_pair", unique: true
    t.index ["user_session_id"], name: "index_user_session_proofs_on_user_session_id"
  end

  create_table "user_sessions", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.bigint "impersonator_id"
    t.string "ip_address"
    t.string "user_agent"
    t.datetime "last_seen_at", null: false
    t.datetime "revoked_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["impersonator_id"], name: "index_user_sessions_on_impersonator_id"
    t.index ["user_id", "revoked_at"], name: "index_user_sessions_on_user_id_and_revoked_at"
    t.index ["user_id"], name: "index_user_sessions_on_user_id"
  end

  create_table "users", force: :cascade do |t|
    t.citext "email", null: false
    t.string "name", null: false
    t.string "password_digest"
    t.string "state", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "provider"
    t.string "uid"
    t.string "avatar_url"
    t.string "mcp_token_digest"
    t.datetime "mcp_token_last_used_at"
    t.datetime "deleted_at"
    t.boolean "super_admin", default: false, null: false
    t.bigint "last_company_id"
    t.boolean "share_active_sessions", default: false, null: false
    t.boolean "share_completed_sessions", default: true, null: false
    t.jsonb "mcp_enabled_tools"
    t.text "encrypted_totp_secret"
    t.datetime "totp_confirmed_at"
    t.datetime "sessions_revoked_at"
    t.bigint "mcp_token_proof_provider_ids", array: true
    t.datetime "password_changed_at"
    t.index ["deleted_at"], name: "index_users_on_deleted_at", where: "(deleted_at IS NOT NULL)"
    t.index ["email"], name: "index_users_on_email", unique: true
    t.index ["mcp_token_digest"], name: "index_users_on_mcp_token_digest", unique: true
    t.index ["provider", "uid"], name: "index_users_on_provider_and_uid", unique: true
    t.index ["state"], name: "index_users_on_state"
  end

  create_table "webauthn_credentials", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "external_id", null: false
    t.string "public_key", null: false
    t.bigint "sign_count", default: 0, null: false
    t.string "nickname"
    t.datetime "last_used_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["external_id"], name: "index_webauthn_credentials_on_external_id", unique: true
    t.index ["user_id"], name: "index_webauthn_credentials_on_user_id"
  end

  create_table "webhook_endpoints", force: :cascade do |t|
    t.string "slug", null: false
    t.string "provider", default: "generic", null: false
    t.string "verification_strategy", default: "none", null: false
    t.text "encrypted_secret"
    t.jsonb "config", default: {}, null: false
    t.boolean "enabled", default: true, null: false
    t.bigint "project_id"
    t.bigint "company_id"
    t.bigint "created_by_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["company_id"], name: "index_webhook_endpoints_on_company_id"
    t.index ["created_by_id"], name: "index_webhook_endpoints_on_created_by_id"
    t.index ["project_id"], name: "index_webhook_endpoints_on_project_id"
    t.index ["slug"], name: "index_webhook_endpoints_on_slug", unique: true
  end

  create_table "workflow_run_assets", force: :cascade do |t|
    t.bigint "workflow_run_id", null: false
    t.bigint "produced_by_step_run_id"
    t.string "name", null: false
    t.string "s3_key"
    t.string "content_type"
    t.integer "file_size"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.jsonb "file_data"
    t.string "public_token"
    t.datetime "shared_at"
    t.bigint "shared_by_id"
    t.bigint "shared_in_session_id"
    t.index ["produced_by_step_run_id"], name: "index_workflow_run_assets_on_produced_by_step_run_id"
    t.index ["public_token"], name: "index_workflow_run_assets_on_public_token", unique: true, where: "(public_token IS NOT NULL)"
    t.index ["shared_by_id"], name: "index_workflow_run_assets_on_shared_by_id", where: "(shared_by_id IS NOT NULL)"
    t.index ["shared_in_session_id"], name: "index_workflow_run_assets_on_shared_in_session_id", where: "(shared_in_session_id IS NOT NULL)"
    t.index ["workflow_run_id"], name: "index_workflow_run_assets_on_workflow_run_id"
  end

  create_table "workflow_runs", force: :cascade do |t|
    t.bigint "workflow_id", null: false
    t.bigint "project_id", null: false
    t.bigint "user_id"
    t.string "state", default: "pending", null: false
    t.string "mode", default: "interactive", null: false
    t.jsonb "input_asset_ids", default: []
    t.jsonb "shared_context", default: {}
    t.datetime "started_at"
    t.datetime "completed_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.jsonb "repository_ids", default: [], null: false
    t.string "agent_runtime"
    t.jsonb "step_overrides", default: {}, null: false
    t.bigint "board_task_id"
    t.integer "step_runs_count", default: 0, null: false
    t.string "failure_reason"
    t.bigint "failed_agent_credential_id"
    t.datetime "stop_requested_at"
    t.string "relay_state", default: "dispatched", null: false
    t.integer "relay_attempts", default: 0, null: false
    t.string "relay_error"
    t.datetime "relay_claimed_at"
    t.datetime "execution_started_at"
    t.string "source"
    t.bigint "retried_from_run_id"
    t.string "idempotency_key"
    t.bigint "runner_id"
    t.index ["board_task_id"], name: "index_workflow_runs_on_board_task_id"
    t.index ["failed_agent_credential_id"], name: "index_workflow_runs_on_failed_agent_credential_id"
    t.index ["project_id"], name: "index_workflow_runs_on_project_id"
    t.index ["relay_state", "created_at"], name: "index_workflow_runs_pending_relay", where: "((relay_state)::text = 'pending'::text)"
    t.index ["retried_from_run_id"], name: "index_workflow_runs_on_retried_from_run_id"
    t.index ["runner_id"], name: "index_workflow_runs_on_runner_id"
    t.index ["state"], name: "index_workflow_runs_on_state"
    t.index ["user_id", "created_at"], name: "index_workflow_runs_on_user_id_and_created_at"
    t.index ["user_id", "idempotency_key"], name: "index_workflow_runs_on_user_id_and_idempotency_key", unique: true, where: "(idempotency_key IS NOT NULL)"
    t.index ["user_id"], name: "index_workflow_runs_on_user_id"
    t.index ["workflow_id", "state"], name: "index_workflow_runs_on_workflow_id_and_state"
    t.index ["workflow_id"], name: "index_workflow_runs_on_workflow_id"
  end

  create_table "workflows", force: :cascade do |t|
    t.string "name", null: false
    t.text "description"
    t.jsonb "config", default: {}, null: false
    t.string "scope_type", null: false
    t.bigint "scope_id", null: false
    t.datetime "deleted_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.datetime "published_at"
    t.bigint "published_by_id"
    t.bigint "project_id"
    t.bigint "company_id"
    t.integer "current_version_number", default: 0, null: false
    t.bigint "runner_id"
    t.index ["company_id"], name: "index_workflows_on_company_id"
    t.index ["deleted_at"], name: "index_workflows_on_deleted_at"
    t.index ["project_id"], name: "index_workflows_on_project_id"
    t.index ["published_at"], name: "index_workflows_on_published_at", where: "(published_at IS NOT NULL)"
    t.index ["published_by_id"], name: "index_workflows_on_published_by_id"
    t.index ["runner_id"], name: "index_workflows_on_runner_id"
    t.index ["scope_type", "scope_id", "name"], name: "index_workflows_on_scope_and_name_unique", unique: true, where: "(deleted_at IS NULL)"
    t.index ["scope_type", "scope_id"], name: "index_workflows_on_scope_type_and_scope_id"
    t.index ["scope_type"], name: "index_workflows_on_system_scope", where: "((scope_type)::text = 'System'::text)"
  end

  add_check_constraint "workflows", "project_id IS NULL AND company_id IS NULL OR scope_type::text = 'System'::text AND project_id IS NULL AND company_id IS NULL OR scope_type::text = 'Project'::text AND project_id = scope_id AND company_id IS NOT NULL", name: "workflows_tenant_columns", validate: false

  create_table "youtrack_pairings", force: :cascade do |t|
    t.string "public_id", null: false
    t.string "secret_digest", null: false
    t.string "code", null: false
    t.string "origin", null: false
    t.string "status", default: "pending", null: false
    t.string "instance_url", null: false
    t.bigint "company_id"
    t.bigint "project_id"
    t.bigint "user_id"
    t.bigint "integration_id"
    t.datetime "expires_at", null: false
    t.datetime "approved_at"
    t.datetime "completed_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["code"], name: "index_youtrack_pairings_on_code", unique: true, where: "((status)::text = 'pending'::text)"
    t.index ["company_id"], name: "index_youtrack_pairings_on_company_id"
    t.index ["integration_id"], name: "index_youtrack_pairings_on_integration_id"
    t.index ["project_id"], name: "index_youtrack_pairings_on_project_id"
    t.index ["public_id"], name: "index_youtrack_pairings_on_public_id", unique: true
    t.index ["user_id"], name: "index_youtrack_pairings_on_user_id"
  end

  add_foreign_key "ac_artifact_retention_references", "ac_executions"
  add_foreign_key "ac_capacity_grants", "ac_execution_profiles"
  add_foreign_key "ac_capacity_grants", "ac_tasks"
  add_foreign_key "ac_capacity_grants", "agent_credentials"
  add_foreign_key "ac_capacity_grants", "companies"
  add_foreign_key "ac_client_commands", "companies"
  add_foreign_key "ac_client_commands", "users", on_delete: :nullify
  add_foreign_key "ac_decision_audit_events", "companies"
  add_foreign_key "ac_decision_audit_events", "projects"
  add_foreign_key "ac_execution_profiles", "ac_policy_revisions"
  add_foreign_key "ac_execution_profiles", "companies"
  add_foreign_key "ac_executions", "ac_capacity_grants"
  add_foreign_key "ac_executions", "ac_execution_profiles"
  add_foreign_key "ac_executions", "ac_tasks"
  add_foreign_key "ac_executions", "ac_work_contexts"
  add_foreign_key "ac_executions", "companies"
  add_foreign_key "ac_integration_operations", "ac_tasks"
  add_foreign_key "ac_notification_receipts", "trigger_events", on_delete: :cascade
  add_foreign_key "ac_notification_receipts", "users", on_delete: :cascade
  add_foreign_key "ac_plans", "ac_work_contexts"
  add_foreign_key "ac_plans", "companies"
  add_foreign_key "ac_plans", "projects"
  add_foreign_key "ac_policy_revisions", "companies"
  add_foreign_key "ac_quota_observations", "agent_credentials"
  add_foreign_key "ac_quota_observations", "companies"
  add_foreign_key "ac_remote_environments", "companies"
  add_foreign_key "ac_remote_environments", "projects"
  add_foreign_key "ac_remote_operations", "ac_executions"
  add_foreign_key "ac_remote_operations", "ac_remote_environments"
  add_foreign_key "ac_remote_operations", "ac_tasks"
  add_foreign_key "ac_remote_operations", "companies"
  add_foreign_key "ac_remote_operations", "projects"
  add_foreign_key "ac_review_verdicts", "ac_executions"
  add_foreign_key "ac_review_verdicts", "ac_tasks"
  add_foreign_key "ac_review_verdicts", "companies"
  add_foreign_key "ac_review_verdicts", "projects"
  add_foreign_key "ac_shared_capacity_intents", "ac_execution_profiles"
  add_foreign_key "ac_shared_capacity_intents", "ac_tasks"
  add_foreign_key "ac_shared_capacity_intents", "agent_credentials"
  add_foreign_key "ac_shared_capacity_intents", "companies"
  add_foreign_key "ac_tasks", "ac_plans"
  add_foreign_key "ac_tasks", "companies"
  add_foreign_key "ac_tasks", "projects"
  add_foreign_key "ac_templates", "companies", on_delete: :cascade
  add_foreign_key "ac_work_contexts", "companies"
  add_foreign_key "ac_work_contexts", "projects"
  add_foreign_key "agent_credentials", "companies"
  add_foreign_key "agent_credentials", "users"
  add_foreign_key "agents", "companies", on_delete: :cascade, validate: false
  add_foreign_key "agents", "projects", column: ["project_id", "company_id"], primary_key: ["id", "company_id"], name: "fk_agents_project_company", on_delete: :cascade, validate: false
  add_foreign_key "agents", "projects", on_delete: :cascade, validate: false
  add_foreign_key "asset_versions", "assets", on_delete: :cascade
  add_foreign_key "asset_versions", "users", column: "uploaded_by_id", on_delete: :nullify
  add_foreign_key "assets", "companies", on_delete: :cascade, validate: false
  add_foreign_key "assets", "projects", column: ["project_id", "company_id"], primary_key: ["id", "company_id"], name: "fk_assets_project_company", on_delete: :cascade, validate: false
  add_foreign_key "assets", "projects", on_delete: :cascade, validate: false
  add_foreign_key "assets", "step_runs", on_delete: :nullify
  add_foreign_key "assets", "terminal_sessions", column: "shared_in_session_id", on_delete: :nullify
  add_foreign_key "assets", "terminal_sessions", on_delete: :nullify
  add_foreign_key "assets", "users", column: "created_by_id", on_delete: :nullify
  add_foreign_key "assets", "users", column: "shared_by_id", on_delete: :nullify
  add_foreign_key "azure_devops_deliveries", "azure_devops_subscriptions"
  add_foreign_key "azure_devops_installations", "companies"
  add_foreign_key "azure_devops_installations", "users", column: "approved_by_id", on_delete: :nullify
  add_foreign_key "azure_devops_operations", "integrations", on_delete: :cascade
  add_foreign_key "azure_devops_subscriptions", "integrations", on_delete: :cascade
  add_foreign_key "billing_cancellations", "companies", on_delete: :cascade
  add_foreign_key "billing_cancellations", "users", on_delete: :nullify
  add_foreign_key "bitbucket_installations", "companies", on_delete: :nullify
  add_foreign_key "bitbucket_installations", "users", column: "bound_by_id", on_delete: :nullify
  add_foreign_key "bitbucket_pairings", "bitbucket_installations", on_delete: :cascade
  add_foreign_key "board_activities", "board_tasks", on_delete: :cascade
  add_foreign_key "board_activities", "boards", on_delete: :cascade
  add_foreign_key "board_activities", "users", column: "actor_id", on_delete: :nullify
  add_foreign_key "board_columns", "boards", on_delete: :cascade
  add_foreign_key "board_tasks", "board_columns"
  add_foreign_key "board_tasks", "board_tasks", column: "parent_task_id", on_delete: :nullify
  add_foreign_key "board_tasks", "boards", on_delete: :cascade
  add_foreign_key "board_tasks", "users", column: "assignee_id", on_delete: :nullify
  add_foreign_key "board_view_presets", "boards", on_delete: :cascade
  add_foreign_key "board_view_presets", "users"
  add_foreign_key "boards", "projects", on_delete: :cascade
  add_foreign_key "chat_channel_connections", "chat_conversations", on_delete: :cascade
  add_foreign_key "chat_channel_connections", "companies", on_delete: :cascade
  add_foreign_key "chat_channel_connections", "users", column: "requested_by_id", on_delete: :nullify
  add_foreign_key "chat_connect_codes", "chat_channel_connections", on_delete: :nullify
  add_foreign_key "chat_connect_codes", "companies", on_delete: :cascade
  add_foreign_key "chat_connect_codes", "projects", on_delete: :cascade
  add_foreign_key "chat_connect_codes", "trigger_bindings", on_delete: :nullify
  add_foreign_key "chat_connect_codes", "users", column: "requested_by_id", on_delete: :nullify
  add_foreign_key "chat_conversations", "chat_workspaces", on_delete: :cascade
  add_foreign_key "chat_conversations", "integrations", on_delete: :nullify
  add_foreign_key "chat_identities", "users", on_delete: :cascade
  add_foreign_key "chat_messages", "chat_conversations", on_delete: :cascade
  add_foreign_key "chat_messages", "companies", on_delete: :cascade
  add_foreign_key "column_transitions", "board_columns", column: "from_column_id", on_delete: :cascade
  add_foreign_key "column_transitions", "board_columns", column: "to_column_id", on_delete: :cascade
  add_foreign_key "column_transitions", "board_tasks", on_delete: :cascade
  add_foreign_key "column_transitions", "users", column: "actor_id", on_delete: :nullify
  add_foreign_key "column_transitions", "workflow_runs", on_delete: :nullify
  add_foreign_key "column_workflow_bindings", "board_columns", on_delete: :cascade
  add_foreign_key "column_workflow_bindings", "users", column: "created_by_id", on_delete: :nullify
  add_foreign_key "column_workflow_bindings", "workflows", on_delete: :cascade
  add_foreign_key "company_auth_policies", "companies"
  add_foreign_key "company_auth_policies", "identity_providers"
  add_foreign_key "company_billing_state_changes", "companies", on_delete: :cascade
  add_foreign_key "company_capacity_changes", "companies", on_delete: :cascade
  add_foreign_key "company_capacity_usages", "companies", on_delete: :cascade
  add_foreign_key "company_memberships", "agent_credentials", column: "default_agent_credential_id", on_delete: :nullify
  add_foreign_key "company_memberships", "companies"
  add_foreign_key "company_memberships", "users"
  add_foreign_key "company_memberships", "users", column: "invited_by_id", on_delete: :nullify
  add_foreign_key "company_usage_hours", "companies", on_delete: :cascade
  add_foreign_key "config_items", "companies", on_delete: :cascade, validate: false
  add_foreign_key "config_items", "projects", column: ["project_id", "company_id"], primary_key: ["id", "company_id"], name: "fk_config_items_project_company", on_delete: :cascade, validate: false
  add_foreign_key "config_items", "projects", on_delete: :cascade, validate: false
  add_foreign_key "entity_versions", "companies", on_delete: :cascade
  add_foreign_key "entity_versions", "entity_versions", column: "restored_from_id", on_delete: :nullify
  add_foreign_key "entity_versions", "projects", on_delete: :cascade
  add_foreign_key "entity_versions", "terminal_sessions", on_delete: :nullify
  add_foreign_key "entity_versions", "users", column: "author_id", on_delete: :nullify
  add_foreign_key "external_resources", "board_tasks", on_delete: :cascade
  add_foreign_key "feature_flag_overrides", "companies", on_delete: :cascade
  add_foreign_key "feature_flag_overrides", "feature_flags", on_delete: :cascade
  add_foreign_key "feature_flag_overrides", "users", column: "created_by_id", on_delete: :nullify
  add_foreign_key "feature_flags", "users", column: "updated_by_id", on_delete: :nullify
  add_foreign_key "feedback_attachments", "feedback_submissions", on_delete: :cascade
  add_foreign_key "feedback_submissions", "companies", on_delete: :cascade
  add_foreign_key "feedback_submissions", "users", on_delete: :nullify
  add_foreign_key "folders", "companies", on_delete: :cascade, validate: false
  add_foreign_key "folders", "projects", column: ["project_id", "company_id"], primary_key: ["id", "company_id"], name: "fk_folders_project_company", on_delete: :cascade, validate: false
  add_foreign_key "folders", "projects", on_delete: :cascade, validate: false
  add_foreign_key "folders", "users", column: "created_by_id", on_delete: :nullify
  add_foreign_key "gates", "board_tasks", on_delete: :cascade
  add_foreign_key "gates", "users", column: "creator_id", on_delete: :nullify
  add_foreign_key "identity_providers", "companies"
  add_foreign_key "integration_data", "integrations", on_delete: :cascade
  add_foreign_key "integrations", "azure_devops_installations", on_delete: :restrict
  add_foreign_key "integrations", "bitbucket_installations", on_delete: :restrict
  add_foreign_key "integrations", "chat_workspaces", on_delete: :nullify
  add_foreign_key "integrations", "companies"
  add_foreign_key "integrations", "projects", on_delete: :cascade
  add_foreign_key "integrations", "users", column: "connected_by_id", on_delete: :nullify
  add_foreign_key "magic_link_tokens", "users"
  add_foreign_key "marketplace_licenses", "companies"
  add_foreign_key "marketplace_licenses", "companies", column: "proposed_company_id", on_delete: :nullify
  add_foreign_key "marketplace_subscription_events", "marketplace_licenses"
  add_foreign_key "mcp_servers", "companies", on_delete: :cascade, validate: false
  add_foreign_key "mcp_servers", "projects", column: ["project_id", "company_id"], primary_key: ["id", "company_id"], name: "fk_mcp_servers_project_company", on_delete: :cascade, validate: false
  add_foreign_key "mcp_servers", "projects", on_delete: :cascade, validate: false
  add_foreign_key "oauth_clients", "mcp_servers", on_delete: :cascade
  add_foreign_key "oauth_credentials", "mcp_servers", on_delete: :cascade
  add_foreign_key "oauth_credentials", "oauth_clients"
  add_foreign_key "oauth_credentials", "users", column: "connected_by_id", on_delete: :nullify
  add_foreign_key "project_collaborators", "projects", on_delete: :cascade
  add_foreign_key "project_collaborators", "users"
  add_foreign_key "project_favorites", "projects", on_delete: :cascade
  add_foreign_key "project_favorites", "users"
  add_foreign_key "project_trackers", "integrations", on_delete: :cascade
  add_foreign_key "project_trackers", "projects", on_delete: :cascade
  add_foreign_key "projects", "companies"
  add_foreign_key "projects", "users", column: "owner_id"
  add_foreign_key "pull_request_operations", "integrations", on_delete: :cascade
  add_foreign_key "pull_request_operations", "repositories", on_delete: :cascade
  add_foreign_key "received_webhooks", "webhook_endpoints", on_delete: :cascade
  add_foreign_key "repositories", "companies", on_delete: :cascade, validate: false
  add_foreign_key "repositories", "integrations", column: ["integration_id", "company_id"], primary_key: ["id", "company_id"], name: "fk_repositories_integration_company", validate: false
  add_foreign_key "repositories", "integrations", on_delete: :cascade
  add_foreign_key "repositories", "projects", column: ["project_id", "company_id"], primary_key: ["id", "company_id"], name: "fk_repositories_project_company", on_delete: :cascade, validate: false
  add_foreign_key "repositories", "projects", on_delete: :cascade, validate: false
  add_foreign_key "runner_credentials", "companies", on_delete: :cascade
  add_foreign_key "runner_credentials", "runner_environments", column: ["runner_environment_id", "runner_id"], primary_key: ["id", "runner_id"], name: "fk_runner_credentials_environment_runner", on_delete: :cascade
  add_foreign_key "runner_credentials", "runner_environments", on_delete: :cascade
  add_foreign_key "runner_credentials", "runners", column: ["runner_id", "company_id"], primary_key: ["id", "company_id"], name: "fk_runner_credentials_runner_company", on_delete: :cascade
  add_foreign_key "runner_credentials", "runners", on_delete: :cascade
  add_foreign_key "runner_environments", "companies", on_delete: :cascade
  add_foreign_key "runner_environments", "runners", column: ["runner_id", "company_id"], primary_key: ["id", "company_id"], name: "fk_runner_environments_runner_company", on_delete: :cascade
  add_foreign_key "runner_environments", "runners", on_delete: :cascade
  add_foreign_key "runners", "companies", on_delete: :cascade
  add_foreign_key "runners", "integrations"
  add_foreign_key "runners", "integrations", column: ["integration_id", "company_id"], primary_key: ["id", "company_id"], name: "fk_runners_integration_company"
  add_foreign_key "runners", "projects", column: ["project_id", "company_id"], primary_key: ["id", "company_id"], name: "fk_runners_project_company", on_delete: :cascade
  add_foreign_key "runners", "projects", on_delete: :cascade
  add_foreign_key "runners", "users", column: "created_by_id", on_delete: :nullify
  add_foreign_key "scim_configurations", "companies"
  add_foreign_key "scim_configurations", "identity_providers"
  add_foreign_key "session_admissions", "session_admission_pools"
  add_foreign_key "session_admissions", "terminal_sessions"
  add_foreign_key "session_concurrency_limits", "companies", on_delete: :cascade, validate: false
  add_foreign_key "session_concurrency_limits", "projects", column: ["project_id", "company_id"], primary_key: ["id", "company_id"], name: "fk_session_concurrency_limits_project_company", on_delete: :cascade, validate: false
  add_foreign_key "session_concurrency_limits", "projects", on_delete: :cascade, validate: false
  add_foreign_key "session_input_assets", "assets", on_delete: :cascade
  add_foreign_key "session_input_assets", "terminal_sessions", on_delete: :cascade
  add_foreign_key "session_logs", "terminal_sessions", on_delete: :cascade
  add_foreign_key "session_mcp_servers", "mcp_servers", on_delete: :cascade
  add_foreign_key "session_mcp_servers", "terminal_sessions", on_delete: :cascade
  add_foreign_key "session_repositories", "repositories", on_delete: :cascade
  add_foreign_key "session_repositories", "terminal_sessions", on_delete: :cascade
  add_foreign_key "session_runtime_operations", "session_admissions"
  add_foreign_key "session_skills", "skills", on_delete: :cascade
  add_foreign_key "session_skills", "terminal_sessions", on_delete: :cascade
  add_foreign_key "session_tools", "terminal_sessions", on_delete: :cascade
  add_foreign_key "session_tools", "tools", on_delete: :cascade
  add_foreign_key "skills", "companies", on_delete: :cascade, validate: false
  add_foreign_key "skills", "projects", column: ["project_id", "company_id"], primary_key: ["id", "company_id"], name: "fk_skills_project_company", on_delete: :cascade, validate: false
  add_foreign_key "skills", "projects", on_delete: :cascade, validate: false
  add_foreign_key "solid_queue_blocked_executions", "solid_queue_jobs", column: "job_id", on_delete: :cascade
  add_foreign_key "solid_queue_claimed_executions", "solid_queue_jobs", column: "job_id", on_delete: :cascade
  add_foreign_key "solid_queue_failed_executions", "solid_queue_jobs", column: "job_id", on_delete: :cascade
  add_foreign_key "solid_queue_ready_executions", "solid_queue_jobs", column: "job_id", on_delete: :cascade
  add_foreign_key "solid_queue_recurring_executions", "solid_queue_jobs", column: "job_id", on_delete: :cascade
  add_foreign_key "solid_queue_scheduled_executions", "solid_queue_jobs", column: "job_id", on_delete: :cascade
  add_foreign_key "step_runs", "entity_versions", column: "workflow_version_id", on_delete: :nullify
  add_foreign_key "step_runs", "steps", on_delete: :cascade
  add_foreign_key "step_runs", "terminal_sessions"
  add_foreign_key "step_runs", "workflow_runs", on_delete: :cascade
  add_foreign_key "steps", "agents", on_delete: :nullify
  add_foreign_key "steps", "workflows", on_delete: :cascade
  add_foreign_key "sub_step_runs", "step_runs", on_delete: :cascade
  add_foreign_key "sub_step_runs", "sub_steps"
  add_foreign_key "sub_steps", "steps"
  add_foreign_key "task_assets", "board_tasks", on_delete: :cascade
  add_foreign_key "task_assets", "terminal_sessions", column: "shared_in_session_id", on_delete: :nullify
  add_foreign_key "task_assets", "users", column: "author_id", on_delete: :nullify
  add_foreign_key "task_assets", "users", column: "shared_by_id", on_delete: :nullify
  add_foreign_key "task_comments", "board_tasks", on_delete: :cascade
  add_foreign_key "task_comments", "users", column: "author_id", on_delete: :nullify
  add_foreign_key "template_installs", "projects", on_delete: :cascade
  add_foreign_key "template_installs", "users", column: "installed_by_id", on_delete: :nullify
  add_foreign_key "template_setup_items", "template_installs", on_delete: :cascade
  add_foreign_key "terminal_sessions", "agents", column: "configured_agent_id", on_delete: :nullify
  add_foreign_key "terminal_sessions", "companies"
  add_foreign_key "terminal_sessions", "projects", on_delete: :nullify
  add_foreign_key "terminal_sessions", "runners"
  add_foreign_key "terminal_sessions", "runners", column: ["runner_id", "company_id"], primary_key: ["id", "company_id"], name: "fk_terminal_sessions_runner_company"
  add_foreign_key "terminal_sessions", "users", on_delete: :nullify
  add_foreign_key "tool_files", "tools", on_delete: :cascade
  add_foreign_key "tool_results", "step_runs", on_delete: :nullify
  add_foreign_key "tool_results", "terminal_sessions", on_delete: :nullify
  add_foreign_key "tool_results", "tools", on_delete: :cascade
  add_foreign_key "tools", "companies", on_delete: :cascade, validate: false
  add_foreign_key "tools", "projects", column: ["project_id", "company_id"], primary_key: ["id", "company_id"], name: "fk_tools_project_company", on_delete: :cascade, validate: false
  add_foreign_key "tools", "projects", on_delete: :cascade, validate: false
  add_foreign_key "tracker_attachments", "projects", on_delete: :cascade
  add_foreign_key "tracker_attachments", "task_assets", on_delete: :nullify
  add_foreign_key "tracker_deliveries", "tracker_subscriptions", on_delete: :cascade
  add_foreign_key "tracker_operations", "project_trackers", on_delete: :cascade
  add_foreign_key "tracker_subscriptions", "integrations", on_delete: :cascade
  add_foreign_key "trigger_bindings", "board_columns", column: "subject_column_id", on_delete: :nullify
  add_foreign_key "trigger_bindings", "chat_conversations", on_delete: :nullify
  add_foreign_key "trigger_bindings", "project_trackers", on_delete: :restrict
  add_foreign_key "trigger_bindings", "projects", on_delete: :cascade
  add_foreign_key "trigger_bindings", "users", column: "created_by_id", on_delete: :nullify
  add_foreign_key "trigger_bindings", "workflows", on_delete: :cascade
  add_foreign_key "trigger_dispatches", "trigger_bindings", on_delete: :nullify
  add_foreign_key "trigger_dispatches", "trigger_events", on_delete: :cascade
  add_foreign_key "trigger_dispatches", "workflow_runs", on_delete: :nullify
  add_foreign_key "trigger_events", "board_tasks", on_delete: :nullify
  add_foreign_key "trigger_events", "companies", on_delete: :cascade
  add_foreign_key "trigger_events", "projects", on_delete: :nullify
  add_foreign_key "trigger_events", "users", column: "actor_id", on_delete: :nullify
  add_foreign_key "usage_statistics", "terminal_sessions"
  add_foreign_key "usage_statistics_batch_receipts", "terminal_sessions", on_delete: :cascade
  add_foreign_key "usage_statistics_event_receipts", "terminal_sessions", on_delete: :cascade
  add_foreign_key "user_identities", "identity_providers"
  add_foreign_key "user_identities", "users"
  add_foreign_key "user_session_proofs", "identity_providers"
  add_foreign_key "user_session_proofs", "user_sessions", on_delete: :cascade
  add_foreign_key "user_sessions", "users", column: "impersonator_id", on_delete: :nullify
  add_foreign_key "user_sessions", "users", on_delete: :cascade
  add_foreign_key "users", "companies", column: "last_company_id", on_delete: :nullify
  add_foreign_key "webauthn_credentials", "users"
  add_foreign_key "webhook_endpoints", "companies", on_delete: :cascade
  add_foreign_key "webhook_endpoints", "projects", on_delete: :cascade
  add_foreign_key "webhook_endpoints", "users", column: "created_by_id", on_delete: :nullify
  add_foreign_key "workflow_run_assets", "step_runs", column: "produced_by_step_run_id", on_delete: :nullify
  add_foreign_key "workflow_run_assets", "terminal_sessions", column: "shared_in_session_id", on_delete: :nullify
  add_foreign_key "workflow_run_assets", "users", column: "shared_by_id", on_delete: :nullify
  add_foreign_key "workflow_run_assets", "workflow_runs", on_delete: :cascade
  add_foreign_key "workflow_runs", "agent_credentials", column: "failed_agent_credential_id", on_delete: :nullify
  add_foreign_key "workflow_runs", "board_tasks", on_delete: :nullify
  add_foreign_key "workflow_runs", "projects", on_delete: :cascade
  add_foreign_key "workflow_runs", "runners"
  add_foreign_key "workflow_runs", "users", on_delete: :nullify
  add_foreign_key "workflow_runs", "workflow_runs", column: "retried_from_run_id", on_delete: :nullify
  add_foreign_key "workflow_runs", "workflows", on_delete: :cascade
  add_foreign_key "workflows", "companies", on_delete: :cascade, validate: false
  add_foreign_key "workflows", "projects", column: ["project_id", "company_id"], primary_key: ["id", "company_id"], name: "fk_workflows_project_company", on_delete: :cascade, validate: false
  add_foreign_key "workflows", "projects", on_delete: :cascade, validate: false
  add_foreign_key "workflows", "runners"
  add_foreign_key "workflows", "runners", column: ["runner_id", "company_id"], primary_key: ["id", "company_id"], name: "fk_workflows_runner_company"
  add_foreign_key "workflows", "users", column: "published_by_id", on_delete: :nullify
  add_foreign_key "youtrack_pairings", "companies", on_delete: :cascade
  add_foreign_key "youtrack_pairings", "integrations", on_delete: :nullify
  add_foreign_key "youtrack_pairings", "projects", on_delete: :cascade
  add_foreign_key "youtrack_pairings", "users", on_delete: :cascade
end
