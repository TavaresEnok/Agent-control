# frozen_string_literal: true

class CreateAcSharedCapacityIntents < ActiveRecord::Migration[8.1]
  def change
    create_table :ac_shared_capacity_intents do |t|
      t.references :company, null: false, foreign_key: true
      t.references :ac_task, null: false, foreign_key: true
      t.references :ac_execution_profile, null: false, foreign_key: true
      t.references :agent_credential, null: false, foreign_key: true
      t.string :operation_id, null: false
      t.string :account_key, null: false
      t.string :host_id, null: false
      t.string :authority_id, null: false
      t.string :epoch, null: false
      t.integer :quantity, null: false
      t.string :broker_grant_id, null: false
      t.string :state, null: false, default: "prepared"
      t.timestamps
    end
    add_index :ac_shared_capacity_intents, :operation_id, unique: true
    add_check_constraint :ac_shared_capacity_intents, "quantity > 0", name: "ac_shared_intents_positive_quantity"
    add_check_constraint :ac_shared_capacity_intents, "state IN ('prepared', 'reserved', 'bound', 'fenced', 'released')", name: "ac_shared_intents_valid_state"
  end
end
