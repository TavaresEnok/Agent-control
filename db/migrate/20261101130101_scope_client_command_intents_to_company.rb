# frozen_string_literal: true

class ScopeClientCommandIntentsToCompany < ActiveRecord::Migration[8.1]
  def change
    remove_index :ac_client_commands, :intent_id
    add_index :ac_client_commands, %i[company_id intent_id], unique: true
  end
end
