# Imagem do Módulo 2 (QA pesado). Contexto de build: deploy/modules/qa/.
# Tag fixa v1.65.1-noble com digest OCI imutável conferido no registro MCR:
# sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579
# linux/amd64: sha256:766137e2d9caad4744187e53cdc89320ba6f2eb57cff097374020944b44dd0a9
# linux/arm64: sha256:56be08aca06bf736a928da2e3235a3b63ef71ee97313beb18c6019fea791aba4
FROM mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    HOME=/tmp \
    TMPDIR=/tmp \
    PATH="/opt/qa-tools/node_modules/.bin:${PATH}"

RUN groupadd --system --gid 65532 qa \
    && useradd --system --uid 65532 --gid 65532 --home-dir /tmp --no-create-home --shell /usr/sbin/nologin qa \
    && mkdir -p /opt/qa-tools /repo /repository \
    && chown 65532:65532 /repo /repository

WORKDIR /opt/qa-tools
COPY package.json package-lock.json qa-tools.lock.json verify-lock.mjs ./
RUN echo "28a00f552a3041e5e95492ce8913012ac5e75d197cab41b741b0790e691a9083  package-lock.json" | sha256sum -c - \
    && node /opt/qa-tools/verify-lock.mjs \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force \
    && chown -R 65532:65532 /opt/qa-tools

COPY entrypoint.sh /usr/local/bin/qa-entrypoint.sh
COPY collect.mjs execute-tests.mjs node-test-runner.mjs /opt/qa-tools/
RUN chmod 0555 /usr/local/bin/qa-entrypoint.sh /opt/qa-tools/*.mjs \
    && chmod 0444 /opt/qa-tools/package.json /opt/qa-tools/package-lock.json /opt/qa-tools/qa-tools.lock.json

USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/qa-entrypoint.sh"]
