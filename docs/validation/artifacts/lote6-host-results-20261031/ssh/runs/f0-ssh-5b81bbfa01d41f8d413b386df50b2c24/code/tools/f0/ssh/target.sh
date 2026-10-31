#!/bin/sh
set -eu
mkdir -p /lab/home /run/sshd
chown lab:lab /lab/home
ssh-keygen -q -t ed25519 -N '' -f /lab/host_key
cat > /lab/sshd_config <<'CONFIG'
Port 22
ListenAddress 0.0.0.0
HostKey /lab/host_key
PidFile /lab/sshd.pid
AuthorizedKeysFile /lab/authorized_keys
StrictModes yes
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
PermitRootLogin no
AllowUsers lab
AllowAgentForwarding no
AllowTcpForwarding no
X11Forwarding no
PermitTunnel no
PermitUserEnvironment no
PrintMotd no
CONFIG
# The source repository is created only here, never copied from central.
su -s /bin/sh lab -c '
set -eu
cd /lab/home
git init -q source
cd source
git config user.name Fixture
git config user.email fixture@invalid
printf "before\n" > value.txt
printf "#!/bin/sh\nset -eu\ntest \"\$(cat value.txt)\" = after\n" > test.sh
git add .
git commit -qm initial
'
exec /usr/sbin/sshd -D -e -f /lab/sshd_config
