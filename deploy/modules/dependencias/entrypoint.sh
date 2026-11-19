#!/bin/sh
# Entrypoint endurecido do Módulo 4 (dependencias).
# /repo montado somente leitura, raiz read-only, usuário 65532, sem socket e sem rede por padrão.
set -eu

for name in GH_TOKEN GITHUB_TOKEN GITLAB_TOKEN NPM_TOKEN NODE_AUTH_TOKEN \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
  DOCKER_HOST DOCKER_CONFIG DOCKER_CERT_PATH KUBECONFIG \
  ANTHROPIC_API_KEY OPENAI_API_KEY XAI_API_KEY GOOGLE_API_KEY GEMINI_API_KEY; do
  unset "$name" || true
done

for arg in "$@"; do
  case "$arg" in
    *..*)
      printf '%s\n' DEPENDENCIAS_PATH_FORBIDDEN >&2
      exit 78
      ;;
    *.sock*)
      printf '%s\n' DEPENDENCIAS_SOCKET_FORBIDDEN >&2
      exit 78
      ;;
  esac
done

if [ -S /var/run/docker.sock ] || [ -S /run/docker.sock ]; then
  printf '%s\n' DEPENDENCIAS_SOCKET_FORBIDDEN >&2
  exit 78
fi

REPO_TARGET="${AC_MODULE_REPO:-/repo}"
if [ ! -d "$REPO_TARGET" ]; then
  printf '%s\n' DEPENDENCIAS_REPO_MISSING >&2
  exit 78
fi

export HOME=/tmp
export TMPDIR=/tmp
export NO_UPDATE_NOTIFIER=1
export NPM_CONFIG_UPDATE_NOTIFIER=false
export PATH="/opt/dependencias-tools/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"

exec node /opt/dependencias-tools/collect.mjs "$@"
