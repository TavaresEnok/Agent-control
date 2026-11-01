# frozen_string_literal: true

class CreateAcIntegrationOperations < ActiveRecord::Migration[8.1]
  def change
    create_table :ac_integration_operations do |t|
      t.references :ac_task, null: false, foreign_key: true
      t.string :identity, null: false
      t.string :state, null: false, default: "prepared"
      t.string :base_commit, null: false
      t.string :candidate_commit, null: false
      t.string :artifact_hash, null: false
      t.string :branch_ref, null: false
      t.jsonb :evidence, null: false, default: {}
      t.timestamps
    end
    add_index :ac_integration_operations, :identity, unique: true
  end
end
