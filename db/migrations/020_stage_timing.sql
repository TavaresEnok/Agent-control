ALTER TABLE ac_stage_operations ADD COLUMN started_at timestamptz;
ALTER TABLE ac_stage_operations ADD COLUMN finished_at timestamptz;
