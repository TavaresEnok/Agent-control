#!/bin/sh
set -eu
pg_restore --no-owner --exit-on-error -d "${RESTORE_PROOF_DB}" /var/backups/app/latest.dump
