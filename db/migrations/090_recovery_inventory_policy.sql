-- Opt-in physical inventory policy. Legacy installations remain unclaimed;
-- restored legacy admission remains closed until separately reconciled.
CREATE TABLE ac_recovery_inventory_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 required boolean NOT NULL DEFAULT false,
 source_installation_id uuid,
 catalog_id uuid,
 manifest_hash text CHECK(manifest_hash IS NULL OR manifest_hash ~ '^[a-f0-9]{64}$'),
 CHECK (NOT required OR (source_installation_id IS NOT NULL AND catalog_id IS NOT NULL AND manifest_hash IS NOT NULL))
);
INSERT INTO ac_recovery_inventory_policy(singleton) VALUES(true);
CREATE TABLE ac_recovery_inventory_restores (
 installation_id uuid PRIMARY KEY,
 source_installation_id uuid NOT NULL,
 checkpoint jsonb,
 state text NOT NULL CHECK(state IN ('legacy-blocked','physical-reconciliation-required','reconciled')),
 recovery_id uuid,
 source_epoch integer CHECK(source_epoch IS NULL OR source_epoch>0),
 recovery_epoch integer CHECK(recovery_epoch IS NULL OR recovery_epoch>0),
 proof_digest text CHECK(proof_digest IS NULL OR proof_digest ~ '^[a-f0-9]{64}$'),
 proof_checkpoint jsonb,
 CHECK ((state='legacy-blocked') = (checkpoint IS NULL))
);
