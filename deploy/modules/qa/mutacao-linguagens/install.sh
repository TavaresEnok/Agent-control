#!/bin/sh
# Called only during the image build. No installer is used by the exam runtime.
set -eu
src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mode=${1:?usage: install.sh python|go ABSOLUTE_DESTINATION}
dest=${2:?missing destination}
case "$dest" in /*) ;; *) exit 2 ;; esac

case "$mode" in
  python)
    /usr/local/bin/python3.12 -I -m pip --isolated install --disable-pip-version-check \
      --index-url https://pypi.org/simple --no-cache-dir --no-compile --only-binary=:all: \
      --require-hashes --no-deps --requirement "$src/requirements.lock" --target "$dest"
    ;;
  go)
    cd "$src/go-mutesting"
    export GOTOOLCHAIN=local GOENV=off GOWORK=off GOFLAGS= GOTELEMETRY=off CGO_ENABLED=0
    export GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org GOVCS='*:off'
    test "$(/usr/local/go/bin/go env GOVERSION)" = go1.27.4
    /usr/local/go/bin/go mod download github.com/avito-tech/go-mutesting
    GOPROXY=off GOSUMDB=off /usr/local/go/bin/go build -trimpath -buildvcs=false -mod=readonly -o "$dest" .
    ;;
  *) exit 2 ;;
esac
