#!/bin/sh
# Cria a rede design-homologation sem acesso genérico.
#
# A rede é bridge e internal: não há rota para a internet nem para as
# interfaces externas do host. O contêiner de design só recebe
# DESIGN_TARGET_URL e o entrypoint recusa qualquer outro host.
#
# Host permitido: 127.0.0.1, localhost ou um nome com sufixo .local, sem
# usuário na URL. Outro host encerra o script antes de criar a rede.
#
# 127.0.0.1 dentro do contêiner não é o loopback do host. Para o alvo
# responder, o servidor de homologação precisa estar nesta mesma rede.
# Se o host da URL for um nome .local, publique-o como alias dessa rede.
# A rede internal não encaminha para a internet.
#
# Uso: deploy/design-network.sh http://homologacao.local:4173
#      DESIGN_TARGET_URL=http://127.0.0.1:4173 deploy/design-network.sh
#
# A pasta de saída montada em /output precisa ser gravável pelo uid 65532.
set -eu

if [ "$#" -gt 1 ]; then
  echo "uso: design-network.sh [URL]" >&2
  exit 2
fi

url="${1:-${DESIGN_TARGET_URL:-}}"
if [ -z "$url" ]; then
  echo "informe a URL de homologação" >&2
  exit 2
fi

origin=$(DESIGN_TARGET_URL="$url" node --input-type=module <<'DESIGN_NETWORK_END'
const HOST = /^(?:127\.0\.0\.1|localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local)$/;

function writtenHost(value) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(value);
  const authority = match?.[1] ?? '';
  if (authority === '' || authority.includes('@') || authority.startsWith('[')) return '';
  const colon = authority.lastIndexOf(':');
  if (colon > 0 && /^\d{1,5}$/.test(authority.slice(colon + 1))) return authority.slice(0, colon).toLowerCase();
  return authority.toLowerCase();
}

const value = process.env.DESIGN_TARGET_URL ?? '';
function refuse() {
  console.error('URL recusada: só http ou https, sem usuário, host 127.0.0.1, localhost ou sufixo .local.');
  process.exit(2);
}
if (typeof value !== 'string' || value.length < 1 || value.length > 2048) refuse();
if (/[\u0000-\u0020\u007f\\]/.test(value)) refuse();
let url;
try {
  url = new URL(value);
} catch {
  refuse();
}
if (url.username !== '' || url.password !== '') refuse();
if (url.protocol !== 'http:' && url.protocol !== 'https:') refuse();
const host = url.hostname.toLowerCase();
if (!HOST.test(host) || writtenHost(value) !== host) refuse();
const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) refuse();
process.stdout.write(url.origin);
DESIGN_NETWORK_END
)

case "$origin" in
  http://*|https://*) ;;
  *)
    echo "origem recusada" >&2
    exit 2
    ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "o runtime de contêiner não está no PATH; a origem válida seria ${origin}" >&2
  exit 1
fi

network=design-homologation
if [ "$network" != "design-homologation" ]; then
  echo "rede recusada" >&2
  exit 1
fi

if docker network inspect "$network" >/dev/null 2>&1; then
  internal=$(docker network inspect --format '{{.Internal}}' "$network" | tr -d '[:space:]')
  if [ "$internal" != "true" ]; then
    echo "a rede ${network} já existe e tem acesso genérico; não vou usá-la" >&2
    exit 1
  fi
else
  docker network create \
    --driver bridge \
    --internal \
    --label agent-control.module=design \
    --label agent-control.network=design-homologation \
    "$network" >/dev/null
fi

internal=$(docker network inspect --format '{{.Internal}}' "$network" | tr -d '[:space:]')
if [ "$internal" != "true" ]; then
  echo "a rede ${network} ficou com acesso genérico" >&2
  exit 1
fi

echo "rede ${network} pronta, sem rota externa; alvo único ${origin}"
