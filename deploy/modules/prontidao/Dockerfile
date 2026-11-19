# Módulo 6 — prontidao. Contexto de build: deploy/modules/prontidao/
# Base fixada por digest OCI: node:22-trixie-slim (debian:trixie-slim).
# hadolint ignore=DL3029
FROM --platform=linux/amd64 node@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64 AS tools
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/*
COPY tools.lock.json /tmp/tools.lock.json
COPY fetch-tools.py /tmp/fetch-tools.py
COPY install-tools.py /tmp/install-tools.py
RUN python3 /tmp/fetch-tools.py
WORKDIR /tmp/tools
RUN sha256sum -c checksums.txt \
 && python3 /tmp/install-tools.py

# hadolint ignore=DL3029
FROM --platform=linux/amd64 node@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64
ENV DEBIAN_FRONTEND=noninteractive \
    TESTSSL_INSTALL_DIR=/opt/testssl \
    NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      bsdextrautils \
      ca-certificates \
      coreutils \
      curl \
      dnsutils \
      findutils \
      gawk \
      git \
      grep \
      openssl \
      procps \
      sed \
      socat \
      xxd \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 65532 prontidao \
 && useradd --system --uid 65532 --gid 65532 --home-dir /tmp --no-create-home --shell /usr/sbin/nologin prontidao \
 && mkdir -p /repo /opt/prontidao /opt/testssl \
 && chmod 0755 /repo /opt/prontidao /opt/testssl
COPY --from=tools /usr/local/bin/gitleaks /usr/local/bin/hadolint /usr/local/bin/trivy /usr/local/bin/
COPY --from=tools /opt/testssl/ /opt/testssl/
RUN ln -sf /opt/testssl/testssl.sh /usr/local/bin/testssl.sh
COPY tools.lock.json /opt/prontidao/tools.lock.json
COPY audit-readiness.mjs /opt/prontidao/audit-readiness.mjs
COPY run-collector.mjs header-facts.mjs /opt/prontidao/
COPY entrypoint.sh /usr/local/bin/prontidao-entrypoint.sh
RUN chmod 0555 /usr/local/bin/gitleaks /usr/local/bin/hadolint /usr/local/bin/trivy \
      /usr/local/bin/prontidao-entrypoint.sh /opt/prontidao/audit-readiness.mjs /opt/prontidao/run-collector.mjs \
 && chmod 0444 /opt/prontidao/tools.lock.json
USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/prontidao-entrypoint.sh"]
