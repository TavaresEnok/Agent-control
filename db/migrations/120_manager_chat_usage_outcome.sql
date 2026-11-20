-- Manager calls are recorded per attempt: outcome and measurement availability are separate facts.
-- measurement: informado (total reported by the CLI), estimado (size-based estimate), desconhecido (no numbers).
ALTER TABLE ac_manager_chat_usage
 ADD COLUMN outcome text NOT NULL DEFAULT 'sucesso' CHECK(outcome IN ('sucesso','falha','limite')),
 ADD COLUMN measurement text,
 ADD COLUMN collection_error text CHECK(collection_error IS NULL OR length(collection_error)<=200);
UPDATE ac_manager_chat_usage SET measurement=CASE WHEN estimated THEN 'estimado' ELSE 'informado' END;
ALTER TABLE ac_manager_chat_usage
 ALTER COLUMN measurement SET NOT NULL,
 ADD CONSTRAINT ac_manager_chat_usage_measurement CHECK(measurement IN ('informado','estimado','desconhecido') AND ((measurement='estimado')=estimated)),
 ADD CONSTRAINT ac_manager_chat_usage_unknown_empty CHECK(measurement<>'desconhecido' OR (input_tokens IS NULL AND output_tokens IS NULL AND total_tokens IS NULL));
