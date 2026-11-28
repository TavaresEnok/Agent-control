-- A remeasurement (`--medir-correcao`) is a new module run on the image of the run it measures again. It names that run here, so
-- the image retention can tell a measurement from an exam: only the latest exam of each project and module keeps its image.
-- No foreign key: the measured run may leave with its project. Idempotent: the column is only added when missing.
ALTER TABLE ac_verify_runs ADD COLUMN IF NOT EXISTS remeasure_of uuid;
