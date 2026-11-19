# Imagem do Módulo 4 (dependencias). Contexto de build: deploy/modules/dependencias/.
# Base Node 22.23.4 (Debian glibc) fixada por digest.
FROM node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NO_UPDATE_NOTIFIER=1 \
    PATH="/opt/dependencias-tools/node_modules/.bin:${PATH}"

RUN groupadd --system --gid 65532 dependencias \
    && useradd --system --uid 65532 --gid 65532 --home-dir /tmp --no-create-home --shell /bin/false dependencias \
    && mkdir -p /opt/dependencias-tools /opt/dependencias-tools/rules /opt/dependencias-tools/codemods /repo /databases \
    && chmod 0755 /opt/dependencias-tools /repo /databases

WORKDIR /opt/dependencias-tools
COPY package.json package-lock.json dependencias-tools.lock.json offline-registry.json verify-lock.mjs ./
RUN node /opt/dependencias-tools/verify-lock.mjs /opt/dependencias-tools \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && node /opt/dependencias-tools/node_modules/@ast-grep/cli/postinstall.js \
    && npm cache clean --force \
    && rm -rf /root/.npm /tmp/*

COPY sgconfig.yml collect.mjs cyclonedx.mjs fetch-registry.mjs ./
COPY rules/ ./rules/
COPY codemods/ ./codemods/
COPY schemas/ ./schemas/
COPY entrypoint.sh /usr/local/bin/dependencias-entrypoint.sh

RUN chmod 0555 /usr/local/bin/dependencias-entrypoint.sh \
    && chmod 0444 /opt/dependencias-tools/package.json \
      /opt/dependencias-tools/package-lock.json \
      /opt/dependencias-tools/dependencias-tools.lock.json \
      /opt/dependencias-tools/offline-registry.json \
      /opt/dependencias-tools/sgconfig.yml \
      /opt/dependencias-tools/collect.mjs \
      /opt/dependencias-tools/cyclonedx.mjs \
      /opt/dependencias-tools/fetch-registry.mjs \
      /opt/dependencias-tools/verify-lock.mjs \
      /opt/dependencias-tools/rules/*.yml \
      /opt/dependencias-tools/codemods/*.cjs \
      /opt/dependencias-tools/schemas/* \
    && chown -R root:root /opt/dependencias-tools

USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/dependencias-entrypoint.sh"]
