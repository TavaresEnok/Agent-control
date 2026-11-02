#!/bin/sh
# Dependency repair ONLY in this disposable laboratory container.
set -eu
runtime=ac-implementation-runtime-1
docker network connect bridge "$runtime"
trap 'docker network disconnect bridge "$runtime"' EXIT
docker exec --user 0 "$runtime" apk add --no-cache curl
