ALTER TABLE ac_contexts ADD COLUMN archived boolean NOT NULL DEFAULT false;
CREATE TABLE ac_import_batches(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES ac_projects,
 source_namespace text NOT NULL,input_digest text NOT NULL,principal_id text NOT NULL,
 state text NOT NULL CHECK(state IN ('staging','completed','reverted')),receipt jsonb,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id,source_namespace,id));
CREATE TABLE ac_import_entries(id uuid PRIMARY KEY,batch_id uuid NOT NULL REFERENCES ac_import_batches,
 source_namespace text NOT NULL,external_context_id text NOT NULL,session_id text NOT NULL UNIQUE,
 source_paused boolean NOT NULL,key_variant text NOT NULL CHECK(key_variant IN ('legacy','dataKey')),
 key_fingerprint text NOT NULL,message_count integer NOT NULL CHECK(message_count>=0),context_id uuid UNIQUE REFERENCES ac_contexts,
 UNIQUE(source_namespace,external_context_id));
CREATE TABLE ac_import_messages(entry_id uuid NOT NULL REFERENCES ac_import_entries,
 local_id text NOT NULL,position integer NOT NULL CHECK(position>=0),ciphertext text NOT NULL,delivered boolean NOT NULL DEFAULT false,
 PRIMARY KEY(entry_id,local_id),UNIQUE(entry_id,position));
CREATE TABLE ac_imported_runs(entry_id uuid NOT NULL REFERENCES ac_import_entries,external_run_id text NOT NULL,
 state text NOT NULL CHECK(state IN ('completed','failed','paused','unknown')),artifact_ref text,
 PRIMARY KEY(entry_id,external_run_id));
