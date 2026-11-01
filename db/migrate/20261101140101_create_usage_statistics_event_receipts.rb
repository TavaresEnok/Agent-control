# frozen_string_literal: true

class CreateUsageStatisticsEventReceipts < ActiveRecord::Migration[8.0]
  def change
    create_table :usage_statistics_event_receipts do |t|
      t.references :terminal_session, null: false, foreign_key: { on_delete: :cascade }
      t.string :event_key, null: false
      t.string :payload_digest, null: false
      t.timestamps
    end
    add_index :usage_statistics_event_receipts, [ :terminal_session_id, :event_key ], unique: true,
      name: "index_usage_event_receipts_on_session_and_key"
  end
end
