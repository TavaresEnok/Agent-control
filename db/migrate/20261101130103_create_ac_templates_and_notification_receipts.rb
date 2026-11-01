# frozen_string_literal: true

class CreateAcTemplatesAndNotificationReceipts < ActiveRecord::Migration[8.0]
  def change
    create_table :ac_templates do |t|
      t.references :company, null: false, foreign_key: { on_delete: :cascade }
      t.string :template_key, null: false
      t.integer :version, null: false
      t.string :title, null: false
      t.datetime :deleted_at
      t.jsonb :definition, null: false, default: {}
      t.timestamps
    end
    add_index :ac_templates, [ :company_id, :template_key, :version ], unique: true, name: "index_ac_templates_on_company_key_version"

    create_table :ac_notification_receipts do |t|
      t.references :trigger_event, null: false, foreign_key: { on_delete: :cascade }
      t.references :user, null: false, foreign_key: { on_delete: :cascade }
      t.datetime :read_at
      t.timestamps
    end
    add_index :ac_notification_receipts, [ :trigger_event_id, :user_id ], unique: true, name: "index_ac_notification_receipts_on_event_user"
  end
end
