# frozen_string_literal: true

class PreserveAnonymizedAgentCredentialHistory < ActiveRecord::Migration[8.1]
  def up
    change_column_null :agent_credentials, :user_id, true
    remove_foreign_key :ac_client_commands, :users
    add_foreign_key :ac_client_commands, :users, on_delete: :nullify
    add_check_constraint :agent_credentials,
      "user_id IS NOT NULL OR (status = 'error' AND account_slug LIKE 'retired-%')",
      name: "agent_credentials_anonymous_are_disabled"
  end

  def down
    if select_value("SELECT EXISTS (SELECT 1 FROM agent_credentials WHERE user_id IS NULL)")
      raise ActiveRecord::IrreversibleMigration, "Anonymized credential history cannot be restored to a user"
    end
    remove_check_constraint :agent_credentials, name: "agent_credentials_anonymous_are_disabled"
    remove_foreign_key :ac_client_commands, :users
    add_foreign_key :ac_client_commands, :users
    change_column_null :agent_credentials, :user_id, false
  end
end
