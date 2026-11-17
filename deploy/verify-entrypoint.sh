#!/bin/sh
# Exame sem rede. Recusa socket, interface que não seja loopback e argumento com .. .
set -eu

for name in GH_TOKEN GITHUB_TOKEN GITLAB_TOKEN NPM_TOKEN NODE_AUTH_TOKEN \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
  DOCKER_HOST DOCKER_CONFIG DOCKER_CERT_PATH KUBECONFIG \
  CHECKOV_API_KEY BC_API_KEY PRISMA_API_URL \
  ANTHROPIC_API_KEY OPENAI_API_KEY XAI_API_KEY GOOGLE_API_KEY GEMINI_API_KEY; do
  unset "$name" || true
done

for arg in "$@"; do
  case "$arg" in
    *..*)
      printf '%s\n' VERIFY_PATH_FORBIDDEN >&2
      exit 78
      ;;
    *.sock*)
      printf '%s\n' VERIFY_SOCKET_FORBIDDEN >&2
      exit 78
      ;;
  esac
done

if [ -S /var/run/docker.sock ] || [ -S /run/docker.sock ]; then
  printf '%s\n' VERIFY_SOCKET_FORBIDDEN >&2
  exit 78
fi

extra=0
for iface in /sys/class/net/*; do
  base=${iface##*/}
  if [ "$base" = lo ] || [ "$base" = '*' ]; then
    continue
  fi
  extra=1
done
if [ "$extra" -eq 1 ]; then
  printf '%s\n' VERIFY_NETWORK_FORBIDDEN >&2
  exit 78
fi

if [ ! -d /repository ] || [ ! -d /databases ] || [ ! -d /output ] || [ ! -w /output ]; then
  printf '%s\n' VERIFY_PATH_FORBIDDEN >&2
  exit 78
fi

export HOME=/tmp
export TMPDIR=/tmp
export XDG_CACHE_HOME=/tmp/cache
export XDG_CONFIG_HOME=/tmp/config
mkdir -p /tmp/cache /tmp/config /tmp/empty
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/tmp/config/gitconfig
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=safe.directory
export GIT_CONFIG_VALUE_0=*
export SEMGREP_SEND_METRICS=off
export OPENGREP_SEND_METRICS=off
export SYFT_CHECK_FOR_APP_UPDATE=false
export GRYPE_CHECK_FOR_APP_UPDATE=false
export GRYPE_DB_CACHE_DIR=/databases/grype
export GRYPE_DB_AUTO_UPDATE=false
export GRYPE_DB_VALIDATE_AGE=false
export GRYPE_DB_VALIDATE_BY_HASH_ON_START=false
export GRYPE_DB_REQUIRE_UPDATE_CHECK=false
mkdir -p /tmp/osv-cache
if [ -d /databases/osv/osv-scalibr ]; then
  find /databases/osv/osv-scalibr -type d | while IFS= read -r dir; do
    rel=${dir#/databases/osv/}
    mkdir -p "/tmp/osv-cache/$rel"
  done
  find /databases/osv/osv-scalibr -type f | while IFS= read -r file; do
    rel=${file#/databases/osv/}
    ln -s "$file" "/tmp/osv-cache/$rel"
  done
fi
export OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY=/tmp/osv-cache
export TRIVY_CACHE_DIR=/databases/trivy

cd /output

run() {
  name=$1
  shift
  code=0
  "$@" >"/output/${name}.stdout" 2>"/output/${name}.stderr" || code=$?
  printf '%s\n' "$code" >"/output/${name}.code"
}

if [ -d /repository/.git ]; then
  run gitleaks gitleaks detect --source /repository --report-format json --report-path /output/gitleaks.json \
    --exit-code 0 --no-banner --redact --log-level error
else
  run gitleaks gitleaks detect --no-git --source /repository --report-format json --report-path /output/gitleaks.json \
    --exit-code 0 --no-banner --redact --log-level error
fi

run osv-scanner osv-scanner scan source --offline --recursive --allow-no-lockfiles --no-resolve \
  --format json --output-file /output/osv.json --verbosity error /repository

run syft syft scan dir:/repository -q -o cyclonedx-json=/output/syft.cdx.json

run grype grype dir:/repository -q -o json --file /output/grype.json

run opengrep opengrep scan --disable-version-check --no-error --quiet --jobs=2 \
  --json --json-output=/output/opengrep.json --config /opt/agent-control/rules /repository

find /repository -type f \( -name Dockerfile -o -name 'Dockerfile.*' -o -name '*.Dockerfile' \) ! -name '*.dockerignore' -print > /tmp/dockerfiles
if [ -s /tmp/dockerfiles ]; then
  code=0
  xargs -d '\n' hadolint --no-fail -f json < /tmp/dockerfiles > /output/hadolint.json || code=$?
  printf '%s\n' "$code" > /output/hadolint.code
else
  printf '%s\n' '[]' > /output/hadolint.json
  printf '%s\n' 0 > /output/hadolint.code
fi

run trivy-config trivy config --skip-check-update --skip-version-check --disable-telemetry --quiet \
  --cache-dir /databases/trivy --format json --output /output/trivy-config.json --timeout 10m /repository

scanners=secret
if [ -f /databases/trivy/db/trivy.db ]; then
  scanners=vuln,secret
fi
run trivy-fs trivy fs --scanners "$scanners" --offline-scan --skip-db-update --skip-java-db-update \
  --skip-check-update --skip-version-check --disable-telemetry --quiet \
  --cache-dir /databases/trivy --format json --output /output/trivy-fs.json --timeout 15m /repository

run checkov checkov --directory /repository --output json --output-file-path /output \
  --soft-fail --skip-download --download-external-modules false --quiet

: > /output/status.json
sep='{'
for name in gitleaks osv-scanner syft grype opengrep hadolint trivy-config trivy-fs checkov; do
  code=127
  if [ -f "/output/${name}.code" ]; then
    code=$(cat "/output/${name}.code")
  fi
  case "$code" in
    ''|*[!0-9-]*) code=127 ;;
  esac
  printf '%s\n  "%s": %s' "$sep" "$name" "$code" >> /output/status.json
  sep=','
done
printf '\n}\n' >> /output/status.json

fail=0
for name in gitleaks osv-scanner syft grype opengrep hadolint trivy-config trivy-fs checkov; do
  code=$(cat "/output/${name}.code")
  if [ "$code" -eq 127 ]; then
    fail=1
  fi
done
exit "$fail"
