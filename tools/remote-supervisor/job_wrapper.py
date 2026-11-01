#!/usr/bin/env python3
"""Keep the systemd main process alive until its whole cgroup has exited."""
import os
import re
import subprocess
import sys
import time


def own_cgroup():
    with open('/proc/self/cgroup', encoding='utf-8') as source:
        entries = [line.strip().split(':', 2) for line in source if line.count(':') >= 2]
    for hierarchy, controllers, path in entries:
        if hierarchy == '0' and not controllers:
            root = '/sys/fs/cgroup'
            break
        if 'name=systemd' in controllers.split(','):
            root = '/sys/fs/cgroup/systemd'
            break
    else:
        raise RuntimeError('systemd cgroup unavailable')
    target = os.path.realpath(os.path.join(root, path.lstrip('/')))
    if target == root or not target.startswith(root + '/') or not os.path.isfile(os.path.join(target, 'cgroup.procs')):
        raise RuntimeError('invalid cgroup')
    return target


def other_processes(group):
    found_self = False
    for directory, subdirs, files in os.walk(group, followlinks=False):
        subdirs[:] = [name for name in subdirs if not os.path.islink(os.path.join(directory, name))]
        if 'cgroup.procs' not in files:
            raise RuntimeError('incomplete cgroup')
        with open(os.path.join(directory, 'cgroup.procs'), encoding='ascii') as source:
            for value in source.read().split():
                pid = int(value)
                if pid == os.getpid():
                    found_self = True
                else:
                    return True
    if not found_self:
        raise RuntimeError('wrapper moved from its cgroup')
    return False


def main():
    if len(sys.argv) != 3 or not re.fullmatch(r'[a-z_][a-z0-9_-]*', sys.argv[1]):
        return 125
    group = own_cgroup()
    command = ['/usr/bin/sudo', '-n', '-u', sys.argv[1], '--', '/usr/bin/env', '-i',
               'PATH=/usr/bin:/bin', 'HOME=/nonexistent', 'LANG=C', '/bin/sh', '-c', sys.argv[2]]
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL)
    code = child.wait()
    while other_processes(group):
        time.sleep(0.25)
    return code if 0 <= code <= 125 else 125


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        sys.stderr.write('cgroup writer state could not be verified\n')
        sys.exit(125)
