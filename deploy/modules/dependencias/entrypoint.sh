#!/bin/sh
# Entrypoint endurecido do Módulo 4 (dependencias).
# /repo montado somente leitura, raiz read-only, usuário 65532, sem socket e sem rede por padrão.
set -eu

fail() {
  printf '%s\n' "$1" >&2
  printf '{"coverage":[{"tool":"dependencias-collector","version":"1.0.0","status":"failed","detail":"%s"}],"findings":[]}\n' "$1"
  exit 78
}

for name in GH_TOKEN GITHUB_TOKEN GITLAB_TOKEN NPM_TOKEN NODE_AUTH_TOKEN \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
  DOCKER_HOST DOCKER_CONFIG DOCKER_CERT_PATH KUBECONFIG \
  ANTHROPIC_API_KEY OPENAI_API_KEY XAI_API_KEY GOOGLE_API_KEY GEMINI_API_KEY; do
  unset "$name" || true
done

for arg in "$@"; do
  case "$arg" in
    *..*)
      fail DEPENDENCIAS_PATH_FORBIDDEN
      ;;
    *.sock*)
      fail DEPENDENCIAS_SOCKET_FORBIDDEN
      ;;
  esac
done

if [ -S /var/run/docker.sock ] || [ -S /run/docker.sock ]; then
  fail DEPENDENCIAS_SOCKET_FORBIDDEN
fi

REPO_TARGET="${AC_MODULE_REPO:-/repo}"
if [ ! -d "$REPO_TARGET" ]; then
  fail DEPENDENCIAS_REPO_MISSING
fi

export HOME=/tmp
export TMPDIR=/tmp
export NO_UPDATE_NOTIFIER=1
export NPM_CONFIG_UPDATE_NOTIFIER=false
export PATH="/opt/dependencias-tools/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"

exec node /opt/dependencias-tools/collect.mjs "$@"
