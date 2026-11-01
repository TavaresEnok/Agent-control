# frozen_string_literal: true

class CreateAcRemoteEnvironmentsAndOperations < ActiveRecord::Migration[7.1]
  def change
    create_table :ac_remote_environments do |t|
      t.references :company, null: false, foreign_key: true
      t.references :project, null: false, foreign_key: true
      t.string :name, null: false
      t.string :environment_slug, null: false
      t.string :host, null: false
      t.integer :port, null: false, default: 22
      t.string :user, null: false
      t.string :fingerprint, null: false
      t.string :identity_key_path, null: false
      t.string :known_hosts_path, null: false
      t.string :authorized_directories, array: true, default: [], null: false
      t.string :state, null: false, default: "active"
      t.jsonb :metadata, default: {}, null: false

      t.timestamps
    end

    add_index :ac_remote_environments, [:company_id, :environment_slug], unique: true, name: "idx_ac_remote_envs_on_company_and_slug"
    add_index :ac_remote_environments, :state

    create_table :ac_remote_operations do |t|
      t.references :company, null: false, foreign_key: true
      t.references :project, null: false, foreign_key: true
      t.references :ac_remote_environment, null: false, foreign_key: true
      t.references :ac_task, foreign_key: true
      t.references :ac_execution, foreign_key: true
      t.string :operation_id, null: false
      t.text :command, null: false
      t.string :working_directory, null: false
      t.string :state, null: false, default: "pending"
      t.string :remote_job_id
      t.string :artifact_hash
      t.integer :exit_code
      t.text :output_log
      t.text :error_log
      t.datetime :started_at
      t.datetime :finished_at
      t.jsonb :metadata, default: {}, null: false

      t.timestamps
    end

    add_index :ac_remote_operations, :operation_id, unique: true
    add_index :ac_remote_operations, [:ac_remote_environment_id, :state], name: "idx_ac_remote_ops_on_env_and_state"
    add_index :ac_remote_operations, :remote_job_id
    add_index :ac_remote_operations, :state
  end
end
