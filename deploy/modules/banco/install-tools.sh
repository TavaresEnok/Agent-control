#!/bin/sh
set -eu

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
# O npm distribui o mesmo binário. O hash conferido abaixo é o do release do Squawk.
curl --proto '=https' -fsSL --retry 3 --max-time 120 \
    https://registry.npmjs.org/@squawk-cli/linux-x64/-/linux-x64-2.73.0.tgz -o squawk.tgz
printf '%s  %s\n' \
    '48c329e71e927d9a28fbaa3e5901e0e627ded38aef9a0e662b0dce939127d8595e212c7bff0d9eb044501e227f36623849460c4aeea3f8f5b489e034f6199366' \
    squawk.tgz | sha512sum -c -
tar -xOzf squawk.tgz package/bin/squawk > squawk-linux-x64

while read -r hash name; do
    case "$name" in
        *.gem) curl --proto '=https' -fsSL --retry 3 --max-time 120 "https://rubygems.org/gems/$name" -o "$name" ;;
    esac
done < /opt/banco/tools.sha256
sha256sum -c /opt/banco/tools.sha256
install -m 0555 squawk-linux-x64 /usr/local/bin/squawk
gem install --local --no-document --ignore-dependencies \
    google-protobuf-3.25.8.gem pg_query-6.1.0.gem pg-1.5.9.gem \
    slop-4.10.1.gem csv-3.3.5.gem pgdexter-0.6.3.gem
# Verifica no build a carga das extensões nativas e das dependências do Dexter.
ruby -e 'require "dexter"; abort unless Dexter::VERSION == "0.6.3"'
squawk --version
