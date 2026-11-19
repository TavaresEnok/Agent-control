# Imagem do Módulo 2 (QA pesado). Contexto de build: deploy/modules/qa/.
FROM docker.io/library/python:3.12.16-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df AS qa-python
ADD --checksum=sha256:34b02417cf070e173989b3db962f7ed56d2f644307b2cf9d5a0f258e13084a61 https://files.pythonhosted.org/packages/9e/ee/a4cf96b8ce1e566ed238f0659ac2d3f007ed1d14b181bcb684e19561a69a/coverage-7.13.5-py3-none-any.whl /tmp/coverage-7.13.5-py3-none-any.whl
RUN python3.12 -I -m pip install --disable-pip-version-check --no-index --no-deps \
    --target /opt/qa-coverage /tmp/coverage-7.13.5-py3-none-any.whl
COPY mutacao-linguagens/install.sh mutacao-linguagens/requirements.lock /tmp/qa-mutation/
RUN /tmp/qa-mutation/install.sh python /opt/qa-mutation-python

FROM docker.io/library/golang:1.27.4-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea AS qa-go
COPY mutacao-linguagens/install.sh /tmp/qa-mutation/
COPY mutacao-linguagens/go-mutesting/ /tmp/qa-mutation/go-mutesting/
RUN /tmp/qa-mutation/install.sh go /opt/go-mutesting-plan

# Tag fixa v1.65.1-noble com digest OCI imutável conferido no registro MCR:
# sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579
# linux/amd64: sha256:766137e2d9caad4744187e53cdc89320ba6f2eb57cff097374020944b44dd0a9
# linux/arm64: sha256:56be08aca06bf736a928da2e3235a3b63ef71ee97313beb18c6019fea791aba4
FROM qa-python AS qa-carga
ADD --checksum=sha256:5a5ecf23529ccf93135bc7e5b0c1cd5126ecf5f2672e22eed1556a0ab74abb87 https://github.com/grafana/k6/releases/download/v2.4.0/k6-v2.4.0-linux-amd64.tar.gz /tmp/k6.tar.gz
ADD --checksum=sha256:556d891134a3c582dc1e1a3f7335fd55142e5965769855a00b944e13e48302fc https://github.com/Shopify/toxiproxy/releases/download/v2.12.0/toxiproxy-server-linux-amd64 /opt/qa-carga/toxiproxy-server
RUN test "$(dpkg --print-architecture)" = amd64 \
    && tar -xzOf /tmp/k6.tar.gz k6-v2.4.0-linux-amd64/k6 > /opt/qa-carga/k6 \
    && chmod 0555 /opt/qa-carga/k6 /opt/qa-carga/toxiproxy-server

FROM mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
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
COPY mutacao-linguagens/requirements.lock ./mutacao-linguagens/
COPY mutacao-linguagens/go-mutesting/go.mod mutacao-linguagens/go-mutesting/go.sum ./mutacao-linguagens/go-mutesting/
RUN echo "fd08d53610a4d9e3cba811b3dbb94a25470d1def52728ac9d6521f579e3cabfd  package-lock.json" | sha256sum -c - \
    && node /opt/qa-tools/verify-lock.mjs \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force \
    && chown -R 65532:65532 /opt/qa-tools

COPY entrypoint.sh /usr/local/bin/qa-entrypoint.sh
COPY banco-local/install.sh /tmp/qa-banco-install.sh
RUN /bin/sh /tmp/qa-banco-install.sh && rm /tmp/qa-banco-install.sh
COPY banco-local/*.mjs /opt/qa-tools/banco-local/
COPY collect.mjs browser-qa.mjs visual-reference.mjs execute-tests.mjs language-tests.mjs node-test-runner.mjs python-test-runner.py js-properties.mjs /opt/qa-tools/
COPY contratos/*.mjs /opt/qa-tools/contratos/
COPY carga-local/*.mjs carga-local/tools.lock.json /opt/qa-tools/carga-local/
COPY --from=qa-carga /opt/qa-carga/ /usr/local/bin/
COPY mutacao-linguagens/index.mjs mutacao-linguagens/measurement.mjs mutacao-linguagens/report.mjs mutacao-linguagens/python-runner.py /opt/qa-tools/mutacao-linguagens/
COPY --from=qa-python /usr/local/bin/python3.12 /usr/local/bin/
COPY --from=qa-python /usr/local/lib/libpython3.12.so.1.0 /usr/local/lib/
COPY --from=qa-python /usr/local/lib/python3.12 /usr/local/lib/python3.12
COPY --from=qa-python /opt/qa-coverage /opt/qa-coverage
COPY --from=qa-python /opt/qa-mutation-python /opt/qa-tools/mutacao-linguagens/python-deps
COPY --from=qa-go /usr/local/go /usr/local/go
COPY --from=qa-go /opt/go-mutesting-plan /opt/qa-tools/mutacao-linguagens/go-mutesting-plan
RUN chmod 0555 /usr/local/bin/qa-entrypoint.sh /opt/qa-tools/*.mjs \
    && chmod 0444 /opt/qa-tools/package.json /opt/qa-tools/package-lock.json /opt/qa-tools/qa-tools.lock.json /opt/qa-tools/python-test-runner.py \
    && /usr/local/bin/python3.12 -I -S -c 'import sqlite3, sys; sys.path.append("/opt/qa-coverage"); import coverage; assert sys.version_info[:3] == (3, 12, 16) and coverage.__version__ == "7.13.5"' \
    && test "$(GOTOOLCHAIN=local /usr/local/go/bin/go env GOVERSION)" = "go1.27.4" \
    && node /opt/qa-tools/verify-lock.mjs --language-tools-installed

USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/qa-entrypoint.sh"]
