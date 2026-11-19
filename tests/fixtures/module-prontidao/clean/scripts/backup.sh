#!/bin/sh
set -eu
mkdir -p /var/backups/app
pg_dump -Fc -f "/var/backups/app/db-$(date +%Y%m%d).dump" "${DATABASE_URL}"
find /var/backups/app -type f -mtime +14 -delete
