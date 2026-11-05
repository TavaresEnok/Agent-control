FROM agent-control-lab:0.1.0
USER root
ARG fixture_mode
ENV FIXTURE_PROTOCOL_MODE=$fixture_mode
COPY --chmod=0555 codex /usr/local/bin/codex
COPY --chmod=0555 fake-node /opt/fake-node
RUN if [ "$fixture_mode" = "fake-node" ]; then cp /opt/fake-node /usr/local/bin/node; fi
