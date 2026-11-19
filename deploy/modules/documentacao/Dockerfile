# Imagem do módulo 8 (documentação viva).
# Contexto de build: deploy/modules/documentacao/
# Base fixada por digest imutável (node 22-bookworm-slim, linux/amd64):
# sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
# Ferramentas fixadas em tools.lock.json e package-lock.json:
# - typedoc 0.28.20 (Apache-2.0)
# - dependency-cruiser 18.8.0 (MIT)
# - mermaid 12.3.0 (MIT)
# - jsdom 31.0.1 (MIT)
# - typescript 5.9.3 (Apache-2.0)
# - sh-syntax 0.8.7 (MIT)
FROM node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NO_COLOR=1 \
    FORCE_COLOR=0 \
    PATH="/opt/documentacao-tools/node_modules/.bin:${PATH}"

RUN groupadd --system --gid 65532 documentacao \
    && useradd --system --uid 65532 --gid 65532 --home-dir /tmp --no-create-home --shell /usr/sbin/nologin documentacao \
    && mkdir -p /opt/documentacao-tools /repo \
    && chmod 0555 /repo

WORKDIR /opt/documentacao-tools
COPY package.json package-lock.json tools.lock.json ./
RUN sha256sum package-lock.json | grep -q "^2acd6ab4a2f4f9c414ddcdc14b1e0289f39f1f82e4e4d9697c0c4047fb6ae279 " \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY depcruise.config.json collect.mjs report-privacy.mjs /opt/documentacao-tools/
COPY documentacao-entrypoint.sh /usr/local/bin/documentacao-entrypoint.sh
RUN chmod 0444 /opt/documentacao-tools/tools.lock.json /opt/documentacao-tools/depcruise.config.json /opt/documentacao-tools/report-privacy.mjs \
    && chmod 0555 /opt/documentacao-tools/collect.mjs /usr/local/bin/documentacao-entrypoint.sh

USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/documentacao-entrypoint.sh"]
