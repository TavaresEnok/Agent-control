# frozen_string_literal: true

class AddAccountSlugToAgentCredentials < ActiveRecord::Migration[8.0]
  def change
    add_column :agent_credentials, :account_slug, :string, default: "default", null: false

    # Remove o índice restritivo upstream que impedia 2 contas do mesmo provedor
    remove_index :agent_credentials, name: "index_agent_credentials_on_user_company_agent"

    # Adiciona índice único escopado por account_slug (RF-05 / T01)
    add_index :agent_credentials,
              [ :user_id, :company_id, :agent_type, :account_slug ],
              unique: true,
              name: "index_agent_credentials_on_user_co_agent_slug"
  end
end
