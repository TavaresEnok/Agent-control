# Releasing

Aixle Flow is released as `vX.Y.Z` tags on `develop`, following
[Semantic Versioning](https://semver.org/) from **1.0.0**. A tag is the only thing that
publishes images; a merge to `develop` publishes nothing.

## What a version number promises

The contract is what a self-hosted deployment depends on: configuration, the database,
the HTTP and MCP APIs, and the runtimes it can launch.

| Bump | When |
| --- | --- |
| **Major** (`2.0.0`) | An upgrade needs an operator's hand: a configuration variable renamed or removed without a fallback, a migration that cannot run unattended, a breaking change to the REST or MCP API, a runtime removed. The changelog entry says what to do. |
| **Minor** (`1.1.0`) | New features, new runtimes, new configuration with a working default, deprecations. |
| **Patch** (`1.0.1`) | Fixes, and raised CLI pins in `config/agent_runtimes.json` — a vendor's CLI update ships as a patch release. |

Pre-releases (`v1.1.0-rc.1`) exist for trying a release on staging first. They publish
their own image tags only, never `latest`, and get no changelog section: their GitHub
Release (marked pre-release) shows `[Unreleased]` as of the tagged commit. Tag them
straight from `develop`, without a changelog PR.

## What a release publishes

Pushing `vX.Y.Z` runs two workflows:

- **`images.yml`** publishes every image — `flow-web`, `flow-otlp-ingest`,
  `flow-agent-base-core` and one `flow-<image>` per entry in `config/agent_runtimes.json`
  — to `ghcr.io/aixlehq` as `X.Y.Z`, plus `X.Y`, `X` and `latest` for a stable release.
  The web image carries `APP_VERSION=X.Y.Z` (the Sentry release) and
  `AGENT_IMAGE_TAG=X.Y.Z`, so it launches the agent images built with it. A deployment
  that pins `flow-web:X.Y.Z` therefore runs one version end to end.
- **`release.yml`** checks that the tag is on `develop` and creates the GitHub Release,
  whose notes are the `[X.Y.Z]` section of `CHANGELOG.md`, the image list, and the PRs
  merged since the previous tag.

## Cutting a release

1. **Changelog PR.** On a branch off `develop`, run
   `docker compose exec -T web bin/changelog release X.Y.Z`. It moves everything under
   `[Unreleased]` into a dated `[X.Y.Z]` section and updates the compare links. Read the
   section as a user would — it is the release announcement — then open the PR as
   `chore(release): X.Y.Z`.
2. **Merge it**, after CI is green.
3. **Tag the merge commit** and push the tag:

   ```bash
   git fetch origin develop
   git tag -a vX.Y.Z -m "vX.Y.Z" origin/develop
   git push origin vX.Y.Z
   ```

   The tag has to be pushed by a person: a tag created with a workflow's `GITHUB_TOKEN`
   starts no other workflow, so nothing would be published.
4. **Check both runs** (`Build Images`, `Release`) and the GitHub Release.

`bin/changelog notes X.Y.Z` prints a section exactly as the release will show it.

## Writing the changelog

Every PR with a user-visible change adds its entry under `[Unreleased]` in the same PR —
prefixed with its product area from
[product/changelog-product-areas.md](../product/changelog-product-areas.md) — so cutting
a release is a move, not an archaeology session. PR titles are Conventional Commits
(checked by `pr-title.yml`), because the squash-merged title is the line the release
notes list for that PR.

## Rolling back

Deploy the previous version's images. Two things decide whether that is safe:

- **Migrations do not roll back.** A release that ran a migration the previous code
  cannot read (a dropped or renamed column) cannot be rolled back past; write such
  changes expand/contract, so the release that adds a column is not the one that drops
  the old one.
- **Temporal histories.** Workflows started on the newer release replay on the older
  code. A workflow change guarded with `patched` replays safely in both directions;
  see [architecture/temporal-versioning.md](../architecture/temporal-versioning.md).

### Decision audit database protection

`ac_decision_audit_events` is append-only. Its migration installs PostgreSQL
triggers rejecting SQL UPDATE, DELETE, and TRUNCATE, including through cascades.
Inserts remain available to the application and backup restoration. These
triggers are not represented in Rails' Ruby schema dump: after `db:schema:load`,
run `bin/rails ac:audit:install_protection` as the separate migration owner
before admitting application traffic. Do not run that installation as the app
role. Check `GET /ready/audit` using the application's actual connection; a 503
means the triggers are missing or the connection has an unsafe role. Configure
deployment readiness and worker startup to enforce this check; `/up` is only a
liveness probe. The check requires PostgreSQL's `has_parameter_privilege`.

The app login must not own the database, audit table, schema, or trigger function,
be a superuser, have CREATEROLE, replication or BYPASSRLS, or be able to assume
any role with those powers or SET on `session_replication_role`. Use separate
credentials for migrations and application processes; do not give ordinary app
processes or users the migration-owner credentials or role membership. Database
owners and superusers can remove protections; securing those credentials and
independent backup retention remain operational requirements. A schema reload or
restore must be followed by trigger installation and a successful readiness check
before service resumes. Audit foreign keys also prevent deleting referenced
projects/companies while their audit history remains.

### Local capacity account identities

Agent Control's local capacity authority requires a configured canonical identity
for every credential that can hold capacity. Configure
`Rails.application.config.ac_capacity_authority_id` with a stable nonempty name
for the single local authority; set `ac_capacity_account_identities` by credential
id, each with `account_key`, `authority_id`, and `ownership` equal to
`exclusive_local`. The key must be `sha256:` followed by 64 lowercase hex
characters. Map all aliases of the same vendor account to the same key, and set
`ac_local_capacity_accounts[key]` to a finite positive `limit` and `mode: local`.
Use an operator-attested stable vendor account identity or a keyed fingerprint of
it; do not use token material, email alone, or account slugs as account identity.
All credentials participating in live grants must be mapped; changing a live
grant's identity or encountering an old grant without an identity blocks further
reservations until the grant is reconciled.

The local lock coordinates processes sharing this database; the configured
exclusive ownership is an operator attestation, not a discovery or proof that a
vendor account is unused elsewhere. An account used on another installation or
host with a separate database must use a shared broker with an authoritative
cross-host reservation instead of this local authority. Do not mark it
`exclusive_local` on either installation. Unknown active legacy session identity
is conservatively charged to each account while admission is decided.

### Remote execution and shared capacity gates

The remote gateway requires an admitted execution and an authorized directory;
without a configured durable remote supervisor it refuses dispatch and reports
existing operations as uncertain. SSH key pinning and a successful connection do
not prove durable execution or safe retry. Shared-account capacity likewise
requires a common reservation authority; a timestamped usage snapshot alone is
not a reservation. Real SSH dispatch and shared-broker operation remain rollout
gates until an independently verifiable supervisor/broker contract and
end-to-end tests establish durable identity, receipts, fencing and recovery.
Do not configure a placeholder adapter as evidence of these properties.

A remote supervisor must implement dispatch, status and independent receipt
verification. Its receipts bind the operation, company, environment, task,
execution, epoch and remote job. A remote intent commits before dispatch and is
never blindly redispatched after an uncertain result. A shared-capacity adapter
must verify a granted receipt bound to the operation, account and quantity.
An uncertain shared reservation requires broker reconciliation: do not retry it
until the broker's idempotency and status contracts have been established.
