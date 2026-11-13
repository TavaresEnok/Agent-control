-- Profiles and protocol pins may store xhigh and max. Provider CLIs still receive only what they accept.
ALTER TABLE ac_profiles DROP CONSTRAINT ac_profiles_effort_check;
ALTER TABLE ac_profiles ADD CONSTRAINT ac_profiles_effort_check CHECK (effort IN ('low','medium','high','xhigh','max'));
ALTER TABLE ac_native_protocol_attempt_pins DROP CONSTRAINT ac_native_protocol_attempt_pins_effort_check;
ALTER TABLE ac_native_protocol_attempt_pins ADD CONSTRAINT ac_native_protocol_attempt_pins_effort_check CHECK (effort IN ('low','medium','high','xhigh','max'));
