#!/bin/sh
# Coletor passivo do módulo 6 (prontidao).
# Roda com /repo somente leitura, raiz read-only, usuário 65532, /tmp gravável,
# sem socket do Docker e sem login real. Rede desligada por padrão.
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
      printf '%s\n' PRONTIDAO_PATH_FORBIDDEN >&2
      exit 78
      ;;
    *.sock*)
      printf '%s\n' PRONTIDAO_SOCKET_FORBIDDEN >&2
      exit 78
      ;;
  esac
done

if [ -S /var/run/docker.sock ] || [ -S /run/docker.sock ]; then
  printf '%s\n' PRONTIDAO_SOCKET_FORBIDDEN >&2
  exit 78
fi

if [ ! -d /repo ] && [ ! -d /repository ]; then
  printf '%s\n' PRONTIDAO_REPO_MISSING >&2
  exit 78
fi

export HOME=/tmp
export TMPDIR=/tmp
export XDG_CACHE_HOME=/tmp/cache
export XDG_CONFIG_HOME=/tmp/config
export TRIVY_CACHE_DIR=/tmp/trivy-cache
export TESTSSL_INSTALL_DIR=/opt/testssl
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/tmp/config/gitconfig
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=safe.directory
export GIT_CONFIG_VALUE_0=*

mkdir -p /tmp/cache /tmp/config /tmp/trivy-cache
cd /tmp

exec node /opt/prontidao/run-collector.mjs "$@"
