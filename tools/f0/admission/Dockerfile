# Same Ruby baseline recorded by the manager's Temporal laboratory receipt.
FROM ruby@sha256:32fdd19c0a001077d1711f1afa6d8a0ac9d497c4eac20e47ae7e1c7f7a8c49df
WORKDIR /opt/admission
COPY Gemfile ./Gemfile
RUN bundle install
ENV BUNDLE_GEMFILE=/opt/admission/Gemfile
WORKDIR /work
