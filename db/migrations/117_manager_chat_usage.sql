-- Token use of panel manager calls. Reported totals come from the CLI; otherwise the row is an estimate by text size.
CREATE TABLE ac_manager_chat_usage(
 id bigserial PRIMARY KEY,
 project_id uuid,
 account_id uuid NOT NULL,
 provider text NOT NULL,
 model text NOT NULL,
 effort text NOT NULL,
 role text NOT NULL DEFAULT 'manager',
 input_tokens bigint CHECK(input_tokens IS NULL OR input_tokens>=0),
 output_tokens bigint CHECK(output_tokens IS NULL OR output_tokens>=0),
 total_tokens bigint CHECK(total_tokens IS NULL OR total_tokens>=0),
 estimated boolean NOT NULL,
 prompt_chars integer NOT NULL CHECK(prompt_chars>=0),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX ac_manager_chat_usage_time ON ac_manager_chat_usage(observed_at);
