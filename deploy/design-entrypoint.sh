#!/bin/sh
# Entrypoint da imagem de design.
# Não executa código do repositório montado em /repository.
# Lê DESIGN_TARGET_URL, recusa outro host e escreve /output/achados-brutos.json.
# O exame em si está em /opt/design-tools/run-exam.mjs (script Node, não um esqueleto).
set -eu
cd /tmp
export HOME="${HOME:-/tmp}"
export TMPDIR="${TMPDIR:-/tmp}"
export PATH="/opt/design-tools/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"
export NODE_PATH="/opt/design-tools/node_modules${NODE_PATH:+:$NODE_PATH}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"
exec node /opt/design-tools/run-exam.mjs
