# Build ONLY in a disposable project build container, before starting services.
ARG RUBY_BASE=ruby@sha256:32fdd19c0a001077d1711f1afa6d8a0ac9d497c4eac20e47ae7e1c7f7a8c49df
FROM ${RUBY_BASE}
RUN if command -v apk >/dev/null; then \
      apk add --no-cache build-base postgresql-dev yaml-dev vips-dev git curl ca-certificates; \
    else apt-get update && apt-get install -y --no-install-recommends \
      build-essential libpq-dev libyaml-dev libvips-dev git curl ca-certificates && rm -rf /var/lib/apt/lists/*; fi
# Upstream static release, explicit x86_64 architecture and fixed checksum.
RUN test "$(uname -m)" = x86_64 \
    && curl -fsSL -o /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
    && echo '8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55  /usr/local/bin/ttyd' | sha256sum -c - \
    && chmod +x /usr/local/bin/ttyd && ttyd --version
WORKDIR /work
COPY . /work
ENV BUNDLE_FROZEN=true BUNDLE_PATH=/usr/local/bundle
RUN test "$(ruby -e 'print RUBY_VERSION')" = 4.0.9 \
    && ruby -c tools/f0/access/run.rb && ruby -c tools/f0/access/web_socket.rb \
    && ruby -c tools/f0/access/mcp_evidence.rb \
    && ruby -c tools/f0/access/session_cookie.rb \
    && bundle install && bundle check \
    && bundle exec ruby tools/f0/access/tests/mcp_evidence_test.rb \
    && RAILS_ENV=test bundle exec ruby tools/f0/access/tests/session_cookie_test.rb
# No provider CLI, CA injection, MITM entrypoint, broker or worker is installed.
CMD ["bundle", "exec", "ruby", "tools/f0/access/run.rb"]
