#!/bin/sh
set -eu

# This creates dedicated accounts only; it never modifies existing users.
[ "$(id -u)" -eq 0 ] || { echo 'run as root' >&2; exit 1; }
[ "$#" -eq 4 ] || { echo 'usage: install.sh SUPERVISOR_USER JOB_USER SECRET_FILE ALLOWED_DIRECTORY' >&2; exit 1; }
supervisor_user=$1
job_user=$2
secret_source=$3
allowed_dir=$4
for user in "$supervisor_user" "$job_user"; do
  case "$user" in ''|*[!a-z0-9_-]*|[!a-z_]*|root) echo 'invalid account name' >&2; exit 1;; esac
  if id "$user" >/dev/null 2>&1; then echo 'accounts must not already exist' >&2; exit 1; fi
done
[ "$supervisor_user" != "$job_user" ] || { echo 'accounts must differ' >&2; exit 1; }
[ -f "$secret_source" ] && [ ! -L "$secret_source" ] || { echo 'secret file required' >&2; exit 1; }
case "$allowed_dir" in /*) ;; *) echo 'absolute allowed directory required' >&2; exit 1;; esac
[ -d "$allowed_dir" ] || { echo 'allowed directory missing' >&2; exit 1; }
for command in useradd install sudo visudo python3 systemd-run systemctl loginctl; do
  command -v "$command" >/dev/null 2>&1 || { echo "missing $command" >&2; exit 1; }
done
python3 - "$secret_source" <<'PYKEY'
import os, re, stat, sys
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
with os.fdopen(fd, 'rb') as key:
    if not stat.S_ISREG(os.fstat(key.fileno()).st_mode) or not re.fullmatch(rb'[0-9a-f]{64}\n?', key.read(66)):
        raise SystemExit('invalid key file')
PYKEY
state="/var/lib/agent-control-lab/ssh/$supervisor_user"
config="/etc/agent-control-lab/ssh/$supervisor_user.json"
sudoers="/etc/sudoers.d/ac-remote-$supervisor_user"
[ ! -e "$state" ] && [ ! -e "$config" ] && [ ! -e "$sudoers" ] &&
  [ ! -e /opt/agent-control-lab/ssh/supervisor.py ] && [ ! -e /opt/agent-control-lab/ssh/job_wrapper.py ] || {
    echo 'destination already exists' >&2; exit 1;
  }
python3 - <<'PYDIR'
import os, stat
for path in ('/opt/agent-control-lab/ssh', '/etc/agent-control-lab/ssh', '/var/lib/agent-control-lab/ssh'):
    current = '/'
    for part in path.split('/'):
        if not part:
            continue
        current = os.path.join(current, part)
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            break
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise SystemExit('unsafe installation ancestor')
PYDIR
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
useradd --system --create-home --shell /bin/sh "$supervisor_user"
useradd --system --no-create-home --shell /usr/sbin/nologin "$job_user"
for directory in /opt/agent-control-lab/ssh /etc/agent-control-lab/ssh /var/lib/agent-control-lab/ssh; do
  if [ -e "$directory" ]; then
    [ -d "$directory" ] && [ ! -L "$directory" ] || { echo 'unsafe existing directory' >&2; exit 1; }
  else
    install -d -o root -g root -m 0755 "$directory"
  fi
done
install -o root -g root -m 0755 "$source_dir/supervisor.py" /opt/agent-control-lab/ssh/supervisor.py
install -o root -g root -m 0755 "$source_dir/job_wrapper.py" /opt/agent-control-lab/ssh/job_wrapper.py
install -d -o "$supervisor_user" -g "$(id -gn "$supervisor_user")" -m 0700 "$state"
install -o "$supervisor_user" -g "$(id -gn "$supervisor_user")" -m 0600 "$secret_source" "$state/secret"
python3 - "$state" "$job_user" "$allowed_dir" > "$config" <<'PY'
import json, sys
state, job, allowed = sys.argv[1:]
print(json.dumps({'state_dir': state, 'secret_file': state + '/secret', 'job_user': job,
                  'wrapper_path': '/opt/agent-control-lab/ssh/job_wrapper.py', 'allowed_directories': [allowed]}))
PY
chown root:root "$config"
chmod 0644 "$config"
temporary=$(mktemp /etc/sudoers.d/.ac-remote.XXXXXX)
printf '%s ALL=(%s) NOPASSWD: /usr/bin/env\n' "$supervisor_user" "$job_user" > "$temporary"
chmod 0440 "$temporary"
visudo -cf "$temporary" >/dev/null
mv "$temporary" "$sudoers"
loginctl enable-linger "$supervisor_user"
echo 'Dedicated supervisor installed; provision SSH key and isolated workspace separately.'
