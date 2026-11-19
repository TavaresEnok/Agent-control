#!/bin/sh
# Entrypoint do módulo 7 (desempenho).
# Executa sem privilégios, com /repo somente leitura, raiz somente leitura e rede desligada por padrão.
set -eu

for name in GH_TOKEN GITHUB_TOKEN GITLAB_TOKEN NPM_TOKEN NODE_AUTH_TOKEN \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
  DOCKER_HOST DOCKER_CONFIG DOCKER_CERT_PATH KUBECONFIG \
  ANTHROPIC_API_KEY OPENAI_API_KEY XAI_API_KEY GOOGLE_API_KEY GEMINI_API_KEY \
  PGPASSWORD DATABASE_URL; do
  unset "$name" || true
done

for arg in "$@"; do
  case "$arg" in
    *..*)
      printf '%s\n' PERF_PATH_FORBIDDEN >&2
      exit 78
      ;;
    *.sock*)
      printf '%s\n' PERF_SOCKET_FORBIDDEN >&2
      exit 78
      ;;
  esac
done

if [ -S /var/run/docker.sock ] || [ -S /run/docker.sock ]; then
  printf '%s\n' PERF_SOCKET_FORBIDDEN >&2
  exit 78
fi

for iface in /sys/class/net/*; do
  base=${iface##*/}
  if [ "$base" != lo ] && [ "$base" != '*' ]; then
    printf '%s\n' PERF_NETWORK_FORBIDDEN >&2
    exit 78
  fi
done

case "${PERF_HTTP_MODE:-}" in
  static|isolated) ;;
  *)
    printf '%s\n' PERF_COLLECTOR_MODE_REQUIRED >&2
    exit 78
    ;;
esac

if [ ! -d /repo ] || [ ! -w /tmp ]; then
  printf '%s\n' PERF_PATH_FORBIDDEN >&2
  exit 78
fi

export HOME=/tmp
export TMPDIR=/tmp
export XDG_CACHE_HOME=/tmp/cache
export XDG_CONFIG_HOME=/tmp/config
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"
export PATH="/opt/desempenho-tools/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"
export NODE_PATH="/opt/desempenho-tools/node_modules${NODE_PATH:+:$NODE_PATH}"
export K6_NO_USAGE_REPORT=true

mkdir -p /tmp/cache /tmp/config

exec node /opt/desempenho-tools/collector.mjs "$@"
