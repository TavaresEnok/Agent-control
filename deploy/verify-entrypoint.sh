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

# record_tool
# Guarda o código de saída REAL da ferramenta em NAME.code, a versão em NAME.version e a saída original em
# NAME.stdout e NAME.stderr. Nada aqui troca um erro por zero: quem lê decide, por ferramenta, quais códigos
# significam achado e quais significam erro (src/verify-collect.ts). 127 grava só quando command -v falha, ou
# quando a ferramenta sai com 127 sem relatório. Com relatório de achados, 127 vira 1, como antes.
record_version() {
  name=$1
  bin=$2
  outdir=$3
  version=''
  if command -v timeout >/dev/null 2>&1; then
    version=$(timeout 10 "$bin" --version 2>/dev/null) || version=$(timeout 10 "$bin" version 2>/dev/null) || version=''
  else
    version=$("$bin" --version 2>/dev/null) || version=$("$bin" version 2>/dev/null) || version=''
  fi
  printf '%s\n' "$version" | head -n 1 >"$outdir/${name}.version" || true
}

record_tool() {
  name=$1
  bin=$2
  report=$3
  shift 3
  outdir=${VERIFY_OUTPUT:-/output}
  if ! command -v "$bin" >/dev/null 2>&1; then
    printf '%s\n' 127 >"$outdir/${name}.code"
    return 0
  fi
  record_version "$name" "$bin" "$outdir"
  code=0
  "$@" >"$outdir/${name}.stdout" 2>"$outdir/${name}.stderr" || code=$?
  if [ "$code" -eq 127 ] && report_has_finding "$report"; then
    code=1
  fi
  printf '%s\n' "$code" >"$outdir/${name}.code"
  return 0
}

report_has_finding() {
  file=$1
  if [ ! -f "$file" ]; then
    return 1
  fi
  body=$(tr -d '[:space:]' < "$file" || true)
  if [ -z "$body" ] || [ "$body" = '[]' ] || [ "$body" = '{}' ]; then
    return 1
  fi
  return 0
}
# end record_tool

if [ -d /repository/.git ]; then
  record_tool gitleaks gitleaks /output/gitleaks.json gitleaks detect --source /repository --report-format json --report-path /output/gitleaks.json \
    --exit-code 0 --no-banner --redact --log-level error
else
  record_tool gitleaks gitleaks /output/gitleaks.json gitleaks detect --no-git --source /repository --report-format json --report-path /output/gitleaks.json \
    --exit-code 0 --no-banner --redact --log-level error
fi

record_tool osv-scanner osv-scanner /output/osv.json osv-scanner scan source --offline --recursive --allow-no-lockfiles --no-resolve \
  --format json --output-file /output/osv.json --verbosity error /repository

record_tool syft syft /output/syft.cdx.json syft scan dir:/repository -q -o cyclonedx-json=/output/syft.cdx.json

record_tool grype grype /output/grype.json grype dir:/repository -q -o json --file /output/grype.json

record_tool opengrep opengrep /output/opengrep.json opengrep scan --disable-version-check --no-error --quiet --jobs=2 \
  --json --json-output=/output/opengrep.json --config /opt/agent-control/rules /repository

find /repository -type f \( -name Dockerfile -o -name 'Dockerfile.*' -o -name '*.Dockerfile' \) ! -name '*.dockerignore' -print > /tmp/dockerfiles
if [ -s /tmp/dockerfiles ]; then
  record_tool hadolint hadolint /output/hadolint.json \
    sh -c 'xargs -d "\n" hadolint --no-fail -f json < /tmp/dockerfiles > /output/hadolint.json'
else
  printf '%s\n' '[]' > /output/hadolint.json
  record_tool hadolint hadolint /output/hadolint.json /bin/true
fi

record_tool trivy-config trivy /output/trivy-config.json trivy config --skip-check-update --skip-version-check --disable-telemetry --quiet \
  --cache-dir /databases/trivy --format json --output /output/trivy-config.json --timeout 10m /repository

scanners=secret
if [ -f /databases/trivy/db/trivy.db ]; then
  scanners=vuln,secret
fi
record_tool trivy-fs trivy /output/trivy-fs.json trivy fs --scanners "$scanners" --offline-scan --skip-db-update --skip-java-db-update \
  --skip-check-update --skip-version-check --disable-telemetry --quiet \
  --cache-dir /databases/trivy --format json --output /output/trivy-fs.json --timeout 15m /repository

record_tool checkov checkov /output/results_json.json checkov --directory /repository --output json --output-file-path /output \
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

# Só a ferramenta que não pôde rodar (127) derruba o exame. Um erro de outra ferramenta fica no código dela
# e o relatório mostra a ferramenta como indisponível ou truncada, nunca como execução limpa.
fail=0
for name in gitleaks osv-scanner syft grype opengrep hadolint trivy-config trivy-fs checkov; do
  code=$(cat "/output/${name}.code")
  if [ "$code" -eq 127 ]; then
    fail=1
  fi
done
exit "$fail"
