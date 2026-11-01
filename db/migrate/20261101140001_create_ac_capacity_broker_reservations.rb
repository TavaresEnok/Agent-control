# frozen_string_literal: true

class CreateAcCapacityBrokerReservations < ActiveRecord::Migration[8.1]
  def change
    create_table :ac_capacity_broker_reservations do |t|
      t.string :operation_id, null: false
      t.string :account_key, null: false
      t.string :authority_id, null: false
      t.string :host_id, null: false
      t.string :epoch, null: false
      t.integer :quantity, null: false
      t.string :state, null: false
      t.string :grant_id
      t.jsonb :release_evidence, null: false, default: {}
      t.timestamps
    end
    add_index :ac_capacity_broker_reservations, :operation_id, unique: true, name: "index_ac_broker_reservations_on_operation"
    add_index :ac_capacity_broker_reservations, [ :account_key, :state ], name: "index_ac_broker_reservations_on_account_state"
    add_check_constraint :ac_capacity_broker_reservations, "quantity > 0", name: "ac_broker_positive_quantity"
    add_check_constraint :ac_capacity_broker_reservations, "state IN ('reserved', 'bound', 'released', 'denied')", name: "ac_broker_valid_state"

    create_table :ac_capacity_broker_nonces do |t|
      t.string :digest, null: false
      t.datetime :created_at, null: false
    end
    add_index :ac_capacity_broker_nonces, :digest, unique: true
  end
end
