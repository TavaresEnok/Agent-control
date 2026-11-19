# syntax=docker/dockerfile:1.6
FROM --platform=linux/amd64 eclipse-temurin@sha256:5b5a79b85aeb03a859d4b5196482a08d39ec2714102aecae2c66223323bdf2e5 AS java25

FROM --platform=linux/amd64 python@sha256:48d884813cf44e927cf64c5529dd630dd3b18338c6dc727991eef9b71e934a20 AS ort-dist
ADD --checksum=sha256:69d6a8dda5e2d3ab517ec99b9c16e3f85d3fc74f8bdf373d515592126325e3b4 https://github.com/oss-review-toolkit/ort/releases/download/97.2.0/ort-97.2.0.tgz /tmp/ort.tgz
RUN mkdir -p /opt/ort && tar -xzf /tmp/ort.tgz --strip-components=1 -C /opt/ort

# hadolint ignore=DL3029
FROM --platform=linux/amd64 python@sha256:48d884813cf44e927cf64c5529dd630dd3b18338c6dc727991eef9b71e934a20

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1

RUN cd /tmp \
 && apt-get update \
 && apt-get download libgomp1=14.2.0-19 \
 && printf '%s  %s\n' 72b7a1a33c48f3195efeb044111b34ae684b1e640bb6495c832443b798601cd5 libgomp1_14.2.0-19_amd64.deb | sha256sum -c - \
 && apt-get install -y --no-install-recommends ./libgomp1_14.2.0-19_amd64.deb \
 && rm -f libgomp1_14.2.0-19_amd64.deb \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 65532 conformidade \
 && useradd --system --uid 65532 --gid 65532 --home-dir /tmp --no-create-home --shell /usr/sbin/nologin conformidade \
 && mkdir -p /repo /opt/conformidade \
 && chmod 0755 /repo /opt/conformidade

COPY requirements.lock /tmp/requirements.lock
RUN python3 -m venv /opt/conformidade/venv \
 && /opt/conformidade/venv/bin/pip install --no-cache-dir --no-deps --require-hashes --only-binary=:all: -r /tmp/requirements.lock \
 && /opt/conformidade/venv/bin/pip check \
 && rm -f /tmp/requirements.lock

COPY --from=java25 /opt/java/openjdk /opt/java/openjdk
COPY --from=ort-dist /opt/ort /opt/ort
COPY ort_inventory.py /opt/conformidade/ort_inventory.py
COPY tools.lock.json /opt/conformidade/tools.lock.json
COPY license_policy.py /opt/conformidade/license_policy.py
COPY lgpd_analyzer.py /opt/conformidade/lgpd_analyzer.py
COPY collector.py /opt/conformidade/collector.py
COPY entrypoint.sh /usr/local/bin/conformidade-entrypoint.sh

RUN JAVA_HOME=/opt/java/openjdk /opt/ort/bin/ort --version >/dev/null \
 && mkdir -p /tmp/c9-prewarm/input \
 && printf '%s\n' '{"name":"c9-prewarm","version":"1.0.0","license":"MIT"}' > /tmp/c9-prewarm/input/package.json \
 && /opt/conformidade/venv/bin/scancode --no-check-version --license --package --processes 1 --quiet \
      --json-pp /tmp/c9-prewarm/scan.json /tmp/c9-prewarm/input \
 && rm -rf /tmp/c9-prewarm \
 && chmod -R a+rX /opt/conformidade/venv \
 && cd /opt/conformidade \
 && /opt/conformidade/venv/bin/python3 -c "from lgpd_analyzer import create_presidio; create_presidio()" \
 && chmod 0555 /usr/local/bin/conformidade-entrypoint.sh /opt/conformidade/collector.py \
 && chmod 0444 /opt/conformidade/license_policy.py /opt/conformidade/lgpd_analyzer.py /opt/conformidade/ort_inventory.py /opt/conformidade/tools.lock.json

USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/conformidade-entrypoint.sh"]
