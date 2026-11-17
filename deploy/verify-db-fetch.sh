#!/bin/sh
# Baixa as bases de vulnerabilidade. Passo separado do exame: este script precisa de rede.
# O exame monta o diretório resultante só para leitura.
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

if [ ! -d /databases ] || [ ! -w /databases ]; then
  printf '%s\n' VERIFY_PATH_FORBIDDEN >&2
  exit 78
fi

export HOME=/tmp
export TMPDIR=/tmp
mkdir -p /tmp/empty /databases/grype /databases/trivy /databases/osv/osv-scalibr

export GRYPE_DB_CACHE_DIR=/databases/grype
export GRYPE_DB_VALIDATE_AGE=false
export GRYPE_CHECK_FOR_APP_UPDATE=false
TMPDIR=/databases/grype grype db update

trivy fs --cache-dir /databases/trivy --download-db-only --skip-version-check \
  --disable-telemetry --quiet --timeout 20m /tmp/empty
trivy fs --cache-dir /databases/trivy --download-java-db-only --skip-version-check \
  --disable-telemetry --quiet --timeout 20m /tmp/empty
trivy config --cache-dir /databases/trivy --skip-version-check --disable-telemetry \
  --quiet --timeout 15m /tmp/empty

base=https://osv-vulnerabilities.storage.googleapis.com
for eco in npm PyPI Go Maven crates.io RubyGems Packagist NuGet Hex Pub; do
  mkdir -p "/databases/osv/osv-scalibr/$eco"
  curl -fsSL --retry 3 --retry-delay 2 \
    -o "/databases/osv/osv-scalibr/$eco/all.zip" \
    "$base/$eco/all.zip"
done
