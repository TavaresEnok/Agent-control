-- Lab schema only. Disposable databases apply this with the normal migrator.
-- Do not run it against a production installation.
-- One held writer per managed worktree. Neutralized is explicit and does not delete the tree.
CREATE TABLE ac_worktree_writers(
 parent_intent_id uuid NOT NULL,
 run_id uuid NOT NULL,
 holder_intent_id uuid NOT NULL,
 manager_epoch bigint NOT NULL CHECK(manager_epoch>0),
 state text NOT NULL CHECK(state IN ('held','neutralized')),
 PRIMARY KEY(parent_intent_id,run_id));
