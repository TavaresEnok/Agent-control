#!/bin/sh
# Entrypoint do coletor do Módulo 2 (QA pesado).
# Inicia com /repo montado somente leitura, raiz read-only, usuário sem privilégio (65532),
# /tmp gravável, sem socket Docker, sem login real e rede desligada por padrão.
set -eu

for name in GH_TOKEN GITHUB_TOKEN GITLAB_TOKEN NPM_TOKEN NODE_AUTH_TOKEN \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
  DOCKER_HOST DOCKER_CONFIG DOCKER_CERT_PATH KUBECONFIG \
  ANTHROPIC_API_KEY OPENAI_API_KEY XAI_API_KEY GOOGLE_API_KEY GEMINI_API_KEY \
  CLAUDE_CODE_OAUTH_TOKEN; do
  unset "$name" || true
done

for arg in "$@"; do
  case "$arg" in
    *..*)
      printf '%s\n' QA_PATH_FORBIDDEN >&2
      exit 78
      ;;
    *.sock*)
      printf '%s\n' QA_SOCKET_FORBIDDEN >&2
      exit 78
      ;;
  esac
done

if [ -n "${QA_TEST_SOCKET_PATH:-}" ] && [ -e "${QA_TEST_SOCKET_PATH}" ]; then
  printf '%s\n' QA_SOCKET_FORBIDDEN >&2
  exit 78
fi

if [ "${QA_HOST_TEST_MODE:-0}" != "1" ]; then
  if [ -S /var/run/docker.sock ] || [ -S /run/docker.sock ] || [ -e /var/run/docker.sock ] || [ -e /run/docker.sock ]; then
    printf '%s\n' QA_SOCKET_FORBIDDEN >&2
    exit 78
  fi

  if [ -e /account ] || [ -f /tmp/.credentials.json ] || [ -f /tmp/auth.json ] || [ -f /root/.claude/.credentials.json ]; then
    printf '%s\n' QA_LOGIN_FORBIDDEN >&2
    exit 78
  fi

  if [ "$(id -u)" -eq 0 ]; then
    printf '%s\n' QA_ROOT_FORBIDDEN >&2
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
    printf '%s\n' QA_NETWORK_FORBIDDEN >&2
    exit 78
  fi
fi

REPO_PATH="${QA_REPO_DIR:-/repo}"
if [ "${QA_HOST_TEST_MODE:-0}" != "1" ]; then
  unset NODE_OPTIONS NODE_PATH NODE_V8_COVERAGE QA_TOOLS_NODE_MODULES
  if [ -z "${QA_REPO_DIR:-}" ] && ! awk '$5 == "/repo" { mounted=1 } END { exit !mounted }' /proc/self/mountinfo; then
    REPO_PATH="/repository"
  fi
fi

case "$REPO_PATH" in
  *..*|*.sock*)
    printf '%s\n' QA_PATH_FORBIDDEN >&2
    exit 78
    ;;
esac

if [ ! -d "$REPO_PATH" ] || [ ! -d /tmp ] || [ ! -w /tmp ]; then
  printf '%s\n' QA_PATH_FORBIDDEN >&2
  exit 78
fi

if [ "${QA_HOST_TEST_MODE:-0}" != "1" ]; then
  case "$REPO_PATH" in
    /repo|/repository) ;;
    *)
      printf '%s\n' QA_PATH_FORBIDDEN >&2
      exit 78
      ;;
  esac
  if ! awk -v path="$REPO_PATH" '$5 == path && $6 ~ /(^|,)ro(,|$)/ { mounted=1 } END { exit !mounted }' /proc/self/mountinfo; then
    printf '%s\n' QA_REPO_WRITABLE_FORBIDDEN >&2
    exit 78
  fi
fi

cd /tmp
export HOME=/tmp
export TMPDIR=/tmp
export QA_REPO_DIR="$REPO_PATH"
export NODE_PATH="/opt/qa-tools/node_modules${NODE_PATH:+:$NODE_PATH}"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f /opt/qa-tools/collect.mjs ]; then
  exec node /opt/qa-tools/collect.mjs "$@"
else
  exec node "$SCRIPT_DIR/collect.mjs" "$@"
fi
