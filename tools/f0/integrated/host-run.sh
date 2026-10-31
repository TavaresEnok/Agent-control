#!/usr/bin/env bash
# Administrative operation for the manager AFTER independent review. No downloads.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.."
[[ $# == 1 && $1 =~ ^[a-f0-9]{64}$ ]] || { echo 'Usage: bash tools/f0/integrated/host-run.sh EXPECTED_CLI_SHA256' >&2; exit 78; }
cli=/home/enok/.local/bin/temporal1.9.1
sql_image=sha256:51e6a0811e25f8987d80eaab3fcec28c8c1c11fbaa07995830eca22cb3a5e116
pg_image=postgres@sha256:4ca65a9209f164bdb30f715ac2ed9182cc0737d0f0a549031b3c1b0b7e652f3a
token=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
name=f0-integrated-$token
artifacts="$PWD/docs/validation/artifacts/integrated/host-$token"
mkdir -m 700 -p "$artifacts"
created_pg=0
created_volume=0
cleanup() {
  code=$?
  trap - EXIT
  # Persist operation status and Docker logs BEFORE removing only owned resources.
  printf '%s\n' "$code" >"$artifacts/exit-code.txt"
  if [[ $created_pg == 1 ]]; then
    docker logs "$name-pg" >"$artifacts/postgres.log" 2>&1 || true
    docker rm -f "$name-pg" >>"$artifacts/cleanup.log" 2>&1 || code=1
  fi
  if [[ $created_volume == 1 ]]; then
    docker volume rm "$name-socket" >>"$artifacts/cleanup.log" 2>&1 || code=1
  fi
  printf '%s\n' "$code" >"$artifacts/final-exit-code.txt"
  (cd "$artifacts" && find . -type f ! -name sha256.txt -print0 | sort -z | xargs -0 sha256sum) >"$artifacts/sha256.txt"
  exit "$code"
}
trap cleanup EXIT
[[ -x $cli && $(sha256sum "$cli" | cut -d ' ' -f1) == "$1" ]] || { echo 'CLI hash/executable refused' >&2; exit 78; }
docker image inspect "$sql_image" "$pg_image" >/dev/null # Refuse missing local images; never pull.
[[ $(docker run --rm --pull never --network none --security-opt seccomp=unconfined "$sql_image" ruby -e 'print RUBY_VERSION') == 4.0.9 ]]
if docker container inspect "$name-pg" >/dev/null 2>&1 || docker volume inspect "$name-socket" >/dev/null 2>&1; then
  echo 'Exclusive resource name already exists; refused' >&2
  exit 78
fi
docker image inspect "$sql_image" "$pg_image" >"$artifacts/images.json"
sha256sum "$cli" tools/f0/integrated/Gemfile.lock >"$artifacts/components.sha256"
"$cli" --version >"$artifacts/cli-version.txt"
# Exercise the filtered subprocess environment and both real entrypoint boots
# before creating PG/Temporal resources. This check needs only the local bundle.
docker run --rm --pull never --network none --security-opt seccomp=unconfined \
  --memory 2g --cpus 2 --pids-limit 512 \
  --mount type=bind,source="$PWD",target=/work,readonly --workdir /work \
  -e BUNDLE_GEMFILE=/work/tools/f0/integrated/Gemfile -e BUNDLE_FROZEN=true \
  "$sql_image" ruby test/f0/integrated/subprocess_boot_test.rb \
  >"$artifacts/subprocess-boot.log" 2>&1
docker volume create --label agent-control.fixture="$token" "$name-socket" >"$artifacts/socket-volume.txt"
created_volume=1
docker run -d --pull never --name "$name-pg" --label agent-control.fixture="$token" \
  --network none --security-opt seccomp=unconfined --memory 512m --cpus 1 --pids-limit 128 \
  --mount source="$name-socket",target=/var/run/postgresql \
  --tmpfs /var/lib/postgresql/data:rw \
  -e POSTGRES_USER=f0_admission_lab -e POSTGRES_DB=f0_admission_sql \
  -e POSTGRES_HOST_AUTH_METHOD=trust "$pg_image" \
  -c listen_addresses= -c unix_socket_permissions=0777 >"$artifacts/postgres-container.txt"
created_pg=1
ready=0
for attempt in {1..30}; do
  if docker exec "$name-pg" pg_isready -U f0_admission_lab -d f0_admission_sql >>"$artifacts/readiness.log" 2>&1; then ready=1; break; fi
  sleep 1
done
[[ $ready == 1 ]] || { echo 'PG not ready' >&2; exit 1; }
docker exec "$name-pg" psql -U f0_admission_lab -d f0_admission_sql -v ON_ERROR_STOP=1 \
  -c "COMMENT ON DATABASE f0_admission_sql IS 'agent-control:F0-G0:admission-sql:disposable:v1'" >"$artifacts/pg-identity.txt"
# Image contains the physical SQL bundle. Frozen integrated lock is its captured
# lock, byte-for-byte; root Gemfile/lock and global gems are never modified.
docker run --rm --pull never --name "$name-runner" --label agent-control.fixture="$token" \
  --network none --security-opt seccomp=unconfined --memory 2g --cpus 2 --pids-limit 512 \
  --mount source="$name-socket",target=/lab-pg \
  --mount type=bind,source="$PWD",target=/work \
  --mount type=bind,source="$cli",target=/lab-cli/temporal,readonly \
  --tmpfs /lab-runtime:rw,mode=0700 \
  -e BUNDLE_GEMFILE=/work/tools/f0/integrated/Gemfile -e BUNDLE_FROZEN=true \
  -e F0_ADMISSION_LAB=agent-control:F0-G0:admission-sql:disposable:v1 \
  -e F0_ADMISSION_SOCKET=/lab-pg "$sql_image" \
  timeout --signal=TERM --kill-after=15s 240s ruby tools/f0/integrated/run.rb /lab-cli/temporal "$1" /lab-runtime \
  >"$artifacts/runner.log" 2>&1
