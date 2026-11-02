ALTER TABLE ac_stage_operations DROP CONSTRAINT ac_stage_operations_node_id_check;
ALTER TABLE ac_stage_operations ADD CONSTRAINT ac_stage_operations_node_id_check CHECK(node_id IN ('qa','review','judge','integrate'));
ALTER TABLE ac_verification_evidence DROP CONSTRAINT ac_verification_evidence_kind_check;
ALTER TABLE ac_verification_evidence ADD CONSTRAINT ac_verification_evidence_kind_check CHECK(kind IN ('qa','review','judge'));
