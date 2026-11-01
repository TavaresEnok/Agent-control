# frozen_string_literal: true

class CreateUsageStatisticsBatchReceipts < ActiveRecord::Migration[8.0]
  def change
    create_table :usage_statistics_batch_receipts do |t|
      t.references :terminal_session, null: false, foreign_key: { on_delete: :cascade }
      t.string :batch_key, null: false
      t.string :payload_digest, null: false
      t.timestamps
    end
    add_index :usage_statistics_batch_receipts, [ :terminal_session_id, :batch_key ], unique: true, name: "index_usage_batch_receipts_on_session_and_digest"
  end
end
