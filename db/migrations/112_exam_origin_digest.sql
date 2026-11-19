ALTER TABLE ac_verify_runs ADD COLUMN exam_origin_sha256 text
  CHECK (exam_origin_sha256 IS NULL OR exam_origin_sha256 ~ '^[0-9a-f]{64}$');
