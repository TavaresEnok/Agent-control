# Imagem do módulo 7 (desempenho). Contexto de build: deploy/modules/desempenho/.
# Base fixa v1.65.1-noble por digest (mesma base de deploy/Dockerfile.design).
FROM mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579
LABEL org.agent-control.performance.protocol="6"

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    K6_NO_USAGE_REPORT=true \
    PATH="/opt/desempenho-tools/node_modules/.bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       python3 \
       postgresql-16=16.2-1ubuntu4 \
    && rm -rf /var/lib/apt/lists/*

COPY desempenho-tools.lock.json /tmp/desempenho-tools.lock.json
COPY fetch-tools.py /tmp/fetch-tools.py
RUN python3 /tmp/fetch-tools.py \
    && cd /tmp/tools \
    && sha256sum -c checksums.txt \
    && python3 /tmp/fetch-tools.py --install \
    && rm -rf /tmp/tools /tmp/fetch-tools.py

RUN groupadd --system --gid 65532 desempenho \
    && useradd --system --uid 65532 --gid 65532 --home-dir /tmp --no-create-home --shell /usr/sbin/nologin desempenho \
    && mkdir -p /opt/desempenho-tools /repo /output \
    && chown 65532:65532 /repo /output

WORKDIR /opt/desempenho-tools
COPY package.json package-lock.json ./
COPY cpu-parser/package.json cpu-parser/package-lock.json ./cpu-parser/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm ci --prefix cpu-parser --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force \
    && mv /tmp/desempenho-tools.lock.json /opt/desempenho-tools/desempenho-tools.lock.json

COPY static-server.mjs lib.mjs references.mjs collector.mjs http-link.mjs cpu-metrics.mjs postgres-metrics.mjs /opt/desempenho-tools/
COPY entrypoint.sh /usr/local/bin/desempenho-entrypoint.sh
RUN chmod 0444 /opt/desempenho-tools/package.json /opt/desempenho-tools/package-lock.json /opt/desempenho-tools/desempenho-tools.lock.json \
    && chmod 0555 /opt/desempenho-tools/*.mjs /usr/local/bin/desempenho-entrypoint.sh /usr/local/bin/k6

USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/desempenho-entrypoint.sh"]
