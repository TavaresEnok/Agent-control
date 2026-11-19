#!/bin/sh
# Coletor do módulo 8 (documentacao). Sem rede, sem socket, sem login real, usuário sem privilégio, /repo somente leitura.
set -eu

PATH=/usr/local/bin:/usr/bin:/bin
export PATH

for arg in "$@"; do
  case "$arg" in
    *..*)
      printf '%s\n' DOCUMENTACAO_PATH_FORBIDDEN >&2
      exit 78
      ;;
    *.sock*)
      printf '%s\n' DOCUMENTACAO_SOCKET_FORBIDDEN >&2
      exit 78
      ;;
  esac
done

if [ -e /account/.credentials.json ] || [ -e /account/auth.json ] || [ -e /tmp/.credentials.json ] || [ -e /tmp/auth.json ]; then
  printf '%s\n' DOCUMENTACAO_LOGIN_FORBIDDEN >&2
  exit 78
fi

if [ -S /var/run/docker.sock ] || [ -S /run/docker.sock ] || [ -e /var/run/docker.sock ] || [ -e /run/docker.sock ]; then
  printf '%s\n' DOCUMENTACAO_SOCKET_FORBIDDEN >&2
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
  printf '%s\n' DOCUMENTACAO_NETWORK_FORBIDDEN >&2
  exit 78
fi

if [ "$(id -u)" -eq 0 ]; then
  printf '%s\n' DOCUMENTACAO_PRIVILEGED_USER_FORBIDDEN >&2
  exit 78
fi

if [ ! -d /repo ] || [ ! -d /tmp ] || [ ! -w /tmp ]; then
  printf '%s\n' DOCUMENTACAO_PATH_FORBIDDEN >&2
  exit 78
fi

if [ ! -r /repo ] || [ ! -x /repo ]; then
  printf '%s\n' DOCUMENTACAO_REPO_UNREADABLE >&2
  exit 78
fi

cd /tmp
exec env -i PATH="$PATH" HOME=/tmp TMPDIR=/tmp NO_COLOR=1 node /opt/documentacao-tools/collect.mjs
