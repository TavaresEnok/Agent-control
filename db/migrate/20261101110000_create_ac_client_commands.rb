# frozen_string_literal: true

class CreateAcClientCommands < ActiveRecord::Migration[7.1]
  def change
    create_table :ac_client_commands do |t|
      t.references :company, null: false, foreign_key: true
      t.references :user, foreign_key: true
      t.string :intent_id, null: false
      t.string :command_type, null: false
      t.jsonb :payload, default: {}, null: false
      t.string :state, null: false, default: "received"
      t.jsonb :result, default: {}, null: false
      t.text :error_message
      t.datetime :processed_at

      t.timestamps
    end

    add_index :ac_client_commands, :intent_id, unique: true
    add_index :ac_client_commands, [ :company_id, :command_type ]
    add_index :ac_client_commands, :state
  end
end
