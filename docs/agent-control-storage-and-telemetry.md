# Storage retention and telemetry identity

OTLP ingestion claims individual observations in `usage_statistics_event_receipts`
inside the same SQL transaction as the adapter/usage accumulator. A producer log
must retain `event.id`, `event_id`, `log.record.uid` or `eventId` across retries.
Metric points use their OTLP stream identity (resource, instrumentation scope,
metric descriptor and attributes), start time and observation time. Array order
and batch fragmentation do not affect these identities. Reusing an identity with
different contents rejects the request and rolls back that session's claims.
An explicit `batchId` additionally protects whole-request retries.

Anonymous logs or metric points without a timestamp are additive. Equal usage,
equal timestamps on logs, or equal JSON are not proof of a repeated occurrence.
The gateway must preserve upstream IDs rather than invent a hash of usage values.
The existing OTLP forwarder preserves attributes and observation timestamps; no
adapter-specific value hashing or collector-generated replacement ID is needed.
Receipt ledgers are not garbage-collected independently of their terminal session,
so a late retry cannot become billable again after receipt expiry.

`AcArtifactStorageService` serializes clone admission and retention on the managed
root. Before each clone it estimates twice the source disk usage and checks free
space, a root quota and a company quota. Defaults are respectively 1 GiB reserved,
100 GiB root and 20 GiB company. Configure
`Rails.application.config.ac_artifact_storage` with integer byte limits and
`retention_days` (default 30). These are admission quotas, not kernel limits on
subsequent writes by an agent; filesystem/project quotas are required for that.

Call `AcArtifactStorageService.new.collect!` for a dry run. Destructive collection
requires both `gc_enabled: true` in that configuration and `dry_run: false` on the
call. No scheduler or cleanup was activated by this change. Only marked clones in
`<managed-root>/<task-id>/<64-hex-id>` can be deleted. The ownership marker lives
outside the worker mount. Source repositories and unknown/orphan directories are
never collected. Eligible clones need retention expiry, a terminal task and
execution, zero active task writers or leases, and a fresh verified terminal
runtime receipt for every task execution. Uncertain runtime state preserves data.
Collection uses the same execution fence as admission/reconciliation.

Every encrypted backup export pins referenced executions by its manifest root
digest. Retire the backup explicitly with
`AcArtifactStorageService.retire_backup!(company:, backup_id: manifest_digest)`
only after removing that backup from the restore catalog. All integration journal
references and downstream review source references also preserve clones. The
collector retains database history and records the deletion path/time on execution
metadata. It deliberately retains journal-backed artifacts indefinitely until a
separate archival policy retires those references.
