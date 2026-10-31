FROM sha256:439b8d946672298113bc4334f310006b4d8f6c299a47d141c529412789e48242
WORKDIR /work
COPY --chown=0:0 tools/f0/access/run.rb tools/f0/access/readiness.rb tools/f0/access/host.py /work/tools/f0/access/
COPY --chown=0:0 test/f0/access/readiness_test.rb /work/test/f0/access/readiness_test.rb
CMD ["bundle", "exec", "ruby", "tools/f0/access/run.rb"]
