# syntax=docker/dockerfile:1
# The performance observer runs directly in its original runtime. Its browser
# installation is shared with QA (both recipes pin the same Playwright base).
FROM desempenho AS collectors
LABEL io.agent-control.simple-tools=1
USER root
RUN apt-get update && apt-get install -y --no-install-recommends proot util-linux && rm -rf /var/lib/apt/lists/*
# The collectors require different system libraries, absolute paths and tool
# versions. Assemble their files once, deduplicating before committing the layer.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN --mount=from=verify,target=/inputs/verify \
    --mount=from=qa,target=/inputs/qa \
    --mount=from=arquitetura,target=/inputs/arquitetura \
    --mount=from=dependencias,target=/inputs/dependencias \
    --mount=from=banco,target=/inputs/banco \
    --mount=from=prontidao,target=/inputs/prontidao \
    --mount=from=documentacao,target=/inputs/documentacao \
    --mount=from=conformidade,target=/inputs/conformidade \
    set -eu; for input in /inputs/*; do \
      dest=/opt/ac-collectors/${input##*/}; mkdir -p "$dest"; \
      tar -C "$input" --exclude=./ms-playwright -cf - . | tar -C "$dest" -xf -; \
      hardlink --ignore-time --respect-xattrs /opt/ac-collectors; \
    done
FROM collectors
USER root
# Ubuntu Noble's PRoot 5.1 cannot translate statx used by Node's module loader.
RUN curl -fsSL https://github.com/proot-me/proot/releases/download/v5.5.0/proot -o /tmp/proot \
    && echo 'db185300a9daabbce86aca7632d8c7fdc4249f6f153171954013b70c5f491ec0  /tmp/proot' | sha256sum -c - \
    && install -m 0555 /tmp/proot /usr/bin/proot \
    && rm /tmp/proot
COPY --chmod=0555 collect.sh /usr/local/bin/ac-collect
RUN printf '#!/bin/sh\nexec /usr/local/bin/ac-collect verify-db "$@"\n' > /usr/local/bin/verify-db-fetch.sh && chmod 0555 /usr/local/bin/verify-db-fetch.sh
ENV PROOT_NO_SECCOMP=1
USER 65532:65532
RUN /usr/local/bin/ac-collect banco --check && /usr/local/bin/ac-collect qa --check && /usr/local/bin/ac-collect conformidade --check
