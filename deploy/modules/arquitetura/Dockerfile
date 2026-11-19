# Imagem do módulo 3 (arquitetura e dívida técnica). Contexto de build: deploy/modules/arquitetura/.
# Base node:22-bookworm-slim fixada por digest do índice OCI (conferido em 2026-11-19).
# hadolint ignore=DL3029
FROM --platform=linux/amd64 node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    JSCPD_NO_TIPS=1 \
    NO_COLOR=1 \
    FORCE_COLOR=0 \
    PATH="/opt/arquitetura-tools/node_modules/.bin:${PATH}"

RUN groupadd --system --gid 65532 arquitetura \
    && useradd --system --uid 65532 --gid 65532 --home-dir /tmp --no-create-home --shell /usr/sbin/nologin arquitetura \
    && mkdir -p /opt/arquitetura-tools /repo \
    && chown 65532:65532 /repo

WORKDIR /opt/arquitetura-tools
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && chown -R root:root /opt/arquitetura-tools \
    && chmod -R a+rX /opt/arquitetura-tools

COPY depcruise.config.json tools.lock.json collect.mjs knip-worker.mjs ./
COPY entrypoint.sh /usr/local/bin/arquitetura-entrypoint.sh
RUN chmod 0444 /opt/arquitetura-tools/depcruise.config.json /opt/arquitetura-tools/tools.lock.json \
    && chmod 0555 /opt/arquitetura-tools/collect.mjs /usr/local/bin/arquitetura-entrypoint.sh

USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/arquitetura-entrypoint.sh"]
