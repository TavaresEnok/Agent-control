ALTER TABLE ac_capacity_config ADD COLUMN original_account_id uuid REFERENCES ac_accounts;
ALTER TABLE ac_capacity_config ADD COLUMN original_programming_limit integer CHECK(original_programming_limit BETWEEN 1 AND 128);
ALTER TABLE ac_capacity_config ADD COLUMN original_evaluation_limit integer CHECK(original_evaluation_limit BETWEEN 1 AND 128);
ALTER TABLE ac_capacity_config ADD CONSTRAINT ac_original_capacity_complete CHECK(
 (original_account_id IS NULL AND original_programming_limit IS NULL AND original_evaluation_limit IS NULL)
 OR (original_account_id IS NOT NULL AND original_programming_limit IS NOT NULL AND original_evaluation_limit IS NOT NULL));
