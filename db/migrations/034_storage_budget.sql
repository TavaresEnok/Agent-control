-- PG remains the only authority for storage reservations. No filesystem scan can
-- authorize removal of existing project data, evidence, worktrees or history.
CREATE TABLE ac_storage_pools (
 id uuid PRIMARY KEY,
 path_digest text NOT NULL,
 device text NOT NULL,
 inode text NOT NULL,
 min_free_bytes bigint NOT NULL CHECK (min_free_bytes >= 0),
 budget_bytes bigint NOT NULL CHECK (budget_bytes > 0),
 max_object_bytes bigint NOT NULL CHECK (max_object_bytes > 0),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ac_storage_allocations (
 id uuid PRIMARY KEY,
 pool_id uuid NOT NULL REFERENCES ac_storage_pools(id),
 context_id uuid NOT NULL REFERENCES ac_contexts(id),
 grant_id uuid NOT NULL REFERENCES ac_capacity_grants(id),
 request_digest text NOT NULL,
 category text NOT NULL CHECK (category IN ('disposable_cache','disposable_diagnostic')),
 reserved_bytes bigint NOT NULL CHECK (reserved_bytes > 0),
 object_bytes bigint,
 object_sha256 text,
 state text NOT NULL CHECK (state IN ('reserved','published','retained','deleting','deleted')),
 held boolean NOT NULL DEFAULT true,
 retain_until timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((object_bytes IS NULL)=(object_sha256 IS NULL)),
 CHECK (object_bytes IS NULL OR (object_bytes>=0 AND object_bytes<=reserved_bytes)),
 CHECK (object_sha256 IS NULL OR object_sha256 ~ '^[a-f0-9]{64}$')
);
CREATE INDEX ac_storage_allocation_pool ON ac_storage_allocations(pool_id,state);
