#!/bin/sh
# Uso exclusivo durante a construção da imagem QA baseada no Ubuntu 24.04.
set -eu

snapshot=20261118T000000Z
pg_release=16.15
pg_version=$pg_release-0ubuntu0.24.04.1
tap_version=1.3.2-2
sources=$(mktemp)
trap 'rm -f "$sources"' EXIT
cat > "$sources" <<APT
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://snapshot.ubuntu.com/ubuntu/$snapshot/ noble main universe
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/$snapshot/ noble-updates main universe
APT

apt_for_qa() {
  apt-get -o "Dir::Etc::sourcelist=$sources" -o Dir::Etc::sourceparts=- "$@"
}

# Bloqueia serviços nos scripts de instalação dos pacotes.
policy=/usr/sbin/policy-rc.d
if [ ! -e "$policy" ]; then
  trap 'rm -f "$sources" "$policy"' EXIT
  printf '#!/bin/sh\nexit 101\n' > "$policy"
  chmod 0755 "$policy"
fi
# Imagens oficiais Docker já fornecem um policy-rc.d que retorna 101.
set +e
"$policy" postgresql start
policy_status=$?
set -e
test "$policy_status" -eq 101

export DEBIAN_FRONTEND=noninteractive
apt_for_qa update
apt_for_qa install -y --no-install-recommends postgresql-common
printf '\ncreate_main_cluster = false\n' >> /etc/postgresql-common/createcluster.conf
apt_for_qa install -y --no-install-recommends \
  "libpq5=$pg_version" "postgresql-16=$pg_version" "postgresql-client-16=$pg_version" \
  "postgresql-16-pgtap=$tap_version"
for package in libpq5 postgresql-16 postgresql-client-16; do
  test "$(dpkg-query -W -f='${Version}' "$package")" = "$pg_version"
done
test "$(/usr/lib/postgresql/16/bin/postgres --version)" = "postgres (PostgreSQL) $pg_release (Ubuntu $pg_version)"
test -r /usr/share/postgresql/16/extension/pgtap--1.3.2.sql
rm -rf /var/lib/apt/lists/*
