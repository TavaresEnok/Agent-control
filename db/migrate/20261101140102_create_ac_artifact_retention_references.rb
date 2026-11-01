# frozen_string_literal: true

class CreateAcArtifactRetentionReferences < ActiveRecord::Migration[8.0]
  def change
    create_table :ac_artifact_retention_references do |t|
      t.references :ac_execution, null: false, foreign_key: true
      t.string :backup_id, null: false
      t.string :manifest_digest, null: false
      t.timestamps
    end
    add_index :ac_artifact_retention_references, [ :backup_id, :ac_execution_id ], unique: true,
      name: "index_ac_retention_refs_on_backup_and_execution"
  end
end
