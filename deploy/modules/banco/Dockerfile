FROM docker.io/library/debian@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PATH="/usr/lib/postgresql/17/bin:${PATH}"

COPY tools.sha256 install-tools.sh /opt/banco/
RUN test "$(dpkg --print-architecture)" = amd64 \
    && apt-get update \
    && printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
    && chmod 0755 /usr/sbin/policy-rc.d \
    && apt-get install -y --no-install-recommends postgresql-common \
    && printf '\ncreate_main_cluster = false\n' >> /etc/postgresql-common/createcluster.conf \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl ruby ruby-dev build-essential libpq-dev=17.12-0+deb13u1 \
       libpq5=17.12-0+deb13u1 postgresql-17=17.12-0+deb13u1 \
       postgresql-client-17=17.12-0+deb13u1 postgresql-17-hypopg=1.4.1-2+b1 \
    && /bin/sh /opt/banco/install-tools.sh \
    && apt-get purge -y --auto-remove build-essential libpq-dev ruby-dev curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 65532 banco \
    && useradd --uid 65532 --gid 65532 --home-dir /tmp --no-create-home --shell /usr/sbin/nologin banco

COPY collector.rb /opt/banco/
USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["/usr/bin/ruby", "--disable=rubyopt", "/opt/banco/collector.rb"]
