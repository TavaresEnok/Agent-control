#!/bin/sh
# Coletor do módulo 3 (arquitetura). Sem rede, sem socket, usuário sem privilégio, /repo somente leitura.
set -eu

for name in GH_TOKEN GITHUB_TOKEN GITLAB_TOKEN NPM_TOKEN NODE_AUTH_TOKEN \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
  DOCKER_HOST DOCKER_CONFIG DOCKER_CERT_PATH KUBECONFIG \
  ANTHROPIC_API_KEY OPENAI_API_KEY XAI_API_KEY GOOGLE_API_KEY GEMINI_API_KEY \
  JSCPD_SEMANTIC_API_KEY; do
  unset "$name" || true
done

for arg in "$@"; do
  case "$arg" in
    *..*)
      printf '%s\n' ARQUITETURA_PATH_FORBIDDEN >&2
      exit 78
      ;;
    *.sock*)
      printf '%s\n' ARQUITETURA_SOCKET_FORBIDDEN >&2
      exit 78
      ;;
  esac
done

if [ -S /var/run/docker.sock ] || [ -S /run/docker.sock ] || [ -e /var/run/docker.sock ] || [ -e /run/docker.sock ]; then
  printf '%s\n' ARQUITETURA_SOCKET_FORBIDDEN >&2
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
  printf '%s\n' ARQUITETURA_NETWORK_FORBIDDEN >&2
  exit 78
fi

if [ ! -d /repo ] || [ ! -d /tmp ] || [ ! -w /tmp ]; then
  printf '%s\n' ARQUITETURA_PATH_FORBIDDEN >&2
  exit 78
fi

if [ ! -r /repo ] || [ ! -x /repo ]; then
  printf '%s\n' ARQUITETURA_REPO_UNREADABLE >&2
  exit 78
fi

export AC_REPO_DIR=/repo
export HOME=/tmp
export TMPDIR=/tmp
export NPM_CONFIG_UPDATE_NOTIFIER=false
export JSCPD_NO_TIPS=1
export NO_COLOR=1
export FORCE_COLOR=0
export PATH="/opt/arquitetura-tools/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"
export NODE_PATH="/opt/arquitetura-tools/node_modules"

cd /tmp
exec node /opt/arquitetura-tools/collect.mjs "$@"
