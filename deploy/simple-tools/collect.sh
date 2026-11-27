#!/bin/sh
set -eu
module=$1
shift
case "$module" in
    verify-db) module=verify; set -- /usr/local/bin/verify-db-fetch.sh "$@" ;;
    banco) set -- /usr/bin/ruby --disable=rubyopt /opt/banco/collector.rb "$@" ;;
    verify|qa|arquitetura|dependencias|prontidao|documentacao|conformidade)
        set -- "/usr/local/bin/$module-entrypoint.sh" "$@" ;;
    *) exit 64 ;;
esac
root="/opt/ac-collectors/$module"
case "$*" in *' --check') set -- /bin/sh -ec 'test "$(id -u)" = 65532' ;; esac
# Only paths already available inside the offline, read-only Docker container.
# PRoot makes the original collectors' absolute library paths work as uid 65532.
for path in /proc /sys /dev /tmp /repo /repository /output /databases /run/prontidao-evidence.json /ms-playwright; do
    if [ -e "$path" ]; then set -- -b "$path" "$@"; fi
done
export PATH="/opt/${module}-tools/node_modules/.bin:/usr/lib/postgresql/17/bin:/usr/local/bin:/usr/bin:/bin"
export PROOT_NO_SECCOMP=1
workdir=/tmp
if [ "$module" = verify ] && [ -d /output ]; then workdir=/output; fi
exec /usr/bin/proot -r "$root" -w "$workdir" "$@"
