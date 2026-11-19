#!/bin/sh
set -eu

if [ "$#" -ne 0 ] || [ -S /run/docker.sock ] || [ -S /var/run/docker.sock ]; then
  printf '%s\n' CONFORMIDADE_RUNTIME_FORBIDDEN >&2
  exit 78
fi

for iface in /sys/class/net/*; do
  case "${iface##*/}" in
    lo|'*') ;;
    *)
      printf '%s\n' CONFORMIDADE_NETWORK_FORBIDDEN >&2
      exit 78
      ;;
  esac
done

exec /usr/bin/env -i PATH=/opt/conformidade/venv/bin:/usr/bin:/bin \
  HOME=/tmp TMPDIR=/tmp XDG_CACHE_HOME=/tmp/cache XDG_CONFIG_HOME=/tmp/config \
  PYTHONDONTWRITEBYTECODE=1 PYTHONUTF8=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 \
  /opt/conformidade/venv/bin/python3 /opt/conformidade/collector.py --repo /repo
