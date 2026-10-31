# Build ONLY in a disposable project build container, before starting services.
ARG RUBY_BASE=ruby@sha256:32fdd19c0a001077d1711f1afa6d8a0ac9d497c4eac20e47ae7e1c7f7a8c49df
FROM ${RUBY_BASE}
RUN if command -v apk >/dev/null; then \
      apk add --no-cache build-base postgresql-dev yaml-dev vips-dev git ttyd; \
    else apt-get update && apt-get install -y --no-install-recommends \
      build-essential libpq-dev libyaml-dev libvips-dev git ttyd && rm -rf /var/lib/apt/lists/*; fi
WORKDIR /work
COPY . /work
ENV BUNDLE_FROZEN=true BUNDLE_PATH=/usr/local/bundle
RUN test "$(ruby -e 'print RUBY_VERSION')" = 4.0.9 \
    && ruby -c tools/f0/access/run.rb && ruby -c tools/f0/access/web_socket.rb \
    && ruby -c tools/f0/access/mcp_evidence.rb \
    && ruby -c tools/f0/access/session_cookie.rb \
    && bundle install && bundle check \
    && bundle exec ruby test/f0/access/mcp_evidence_test.rb \
    && RAILS_ENV=test bundle exec ruby test/f0/access/session_cookie_test.rb
# No provider CLI, CA injection, MITM entrypoint, broker or worker is installed.
CMD ["bundle", "exec", "ruby", "tools/f0/access/run.rb"]
