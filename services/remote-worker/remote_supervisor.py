"""Durable Docker group supervision. Container IDs, never historical PIDs, authorize removal."""
import contextlib
import fcntl
import hashlib
import json
import os
import pathlib
import re
import subprocess
import time

TERMINAL = ('completed', 'failed', 'canceled_confirmed')
_HELD_AUTHORITIES = set()


def docker(*args, check=True):
    return subprocess.run(['/usr/bin/docker', *args], capture_output=True, timeout=20, check=check)


def labels(config, item):
    installation = config.get('installationId')
    epoch = config.get('authorityEpoch')
    if not isinstance(installation, str) or not re.fullmatch(r'[a-zA-Z0-9_.-]{1,80}', installation):
        raise ValueError('INVALID_INSTALLATION_ID')
    if type(epoch) is not int or epoch < 1:
        raise ValueError('INVALID_AUTHORITY_EPOCH')
    return {'ac.remote.installation': installation, 'ac.remote.operation': item['operationId'],
            'ac.remote.epoch': str(item['epoch']), 'ac.remote.authority-epoch': str(epoch)}


@contextlib.contextmanager
def authority(config, root, atomic):
    with contextlib.ExitStack() as stack:
        if config.get('resourceAuthority'):
            import resource_authority
            deadline = time.monotonic() + 20
            while True:
                try:
                    stack.enter_context(resource_authority.authority(config))
                    break
                except ValueError as error:
                    if str(error) != 'RESOURCE_AUTHORITY_BUSY' or time.monotonic() >= deadline:
                        raise
                    # Contention is transient; it must not crash a healthy supervisor.
                    # Every eventual acquisition revalidates epoch before mutation.
                    time.sleep(.05)
        with local_authority(config, root, atomic):
            yield


@contextlib.contextmanager
def local_authority(config, root, atomic):
    # Old configuration cannot regain authority after a successor advances epoch.
    epoch = config.get('authorityEpoch')
    if type(epoch) is not int or epoch < 1:
        raise ValueError('INVALID_AUTHORITY_EPOCH')
    key = str(root)
    if key in _HELD_AUTHORITIES:
        yield
        return
    with open(root / '.authority.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = root / '.authority.json'
        prior = json.loads(path.read_text()) if path.exists() else None
        identity = config.get('installationId')
        if prior and (prior['installationId'] != identity or prior['epoch'] > epoch):
            raise ValueError('STALE_REMOTE_AUTHORITY')
        if not prior or prior['epoch'] < epoch:
            atomic(path, {'installationId': identity, 'epoch': epoch})
        _HELD_AUTHORITIES.add(key)
        try:
            yield
        finally:
            _HELD_AUTHORITIES.remove(key)


def inspect(group):
    identity = group.get('id', '')
    if not re.fullmatch(r'[0-9a-f]{64}', identity):
        raise ValueError('INVALID_GROUP_ID')
    result = docker('container', 'inspect', identity, check=False)
    if result.returncode:
        # Daemon failure and permission errors are never absence evidence.
        if b'No such container:' in result.stderr or b'No such object:' in result.stderr:
            return None
        raise ValueError('GROUP_INSPECTION_UNAVAILABLE')
    observed = json.loads(result.stdout)[0]
    if observed['Id'] != identity or any(observed['Config']['Labels'].get(k) != v for k, v in group['labels'].items()):
        raise ValueError('GROUP_IDENTITY_MISMATCH')
    return observed


def finish(config, root, item, atomic, recovered=False):
    group = item['stableGroup']
    expected = labels(config, item)
    recorded_epoch = group['labels'].get('ac.remote.authority-epoch', '')
    if not recorded_epoch.isdigit() or not 1 <= int(recorded_epoch) <= config['authorityEpoch']:
        raise ValueError('GROUP_EPOCH_MISMATCH')
    expected['ac.remote.authority-epoch'] = recorded_epoch
    if group['labels'] != expected:
        raise ValueError('GROUP_SCOPE_MISMATCH')
    observed = inspect(group)
    log_path = root / (item['operationId'] + '.log')
    code = item.get('exitCode', 137)
    if observed is not None:
        if config.get('resourceAuthority'):
            import resource_authority
            observed = resource_authority.validate_group(config, observed, item['operationId'], item['epoch'])
        if not observed['State']['Running']:
            code = observed['State']['ExitCode']
        logs = docker('logs', '--tail', '1000', group['id'], check=False)
        if logs.returncode:
            raise ValueError('GROUP_LOG_UNAVAILABLE')
        content = (logs.stdout + logs.stderr)[:config.get('maxLogBytes', 1048576)]
        # Retain durable logs before destructive removal and ACK.
        with open(log_path, 'wb') as output:
            os.chmod(log_path, 0o600)
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        item['logSha256'] = hashlib.sha256(content).hexdigest()
        item['exitCode'] = code
        atomic(root / (item['operationId'] + '.json'), item)
        docker('rm', '--force', group['id'])
    if inspect(group) is not None:
        raise ValueError('GROUP_REMOVAL_UNCONFIRMED')
    if config.get('resourceAuthority'):
        import resource_authority
        resource_authority.release(config, group['id'], item['operationId'], item['epoch'])
    # Removal ACK may be lost; only a previously durable log receipt permits replay.
    if not log_path.exists() or hashlib.sha256(log_path.read_bytes()).hexdigest() != item.get('logSha256'):
        raise ValueError('GROUP_RECEIPT_INCOMPLETE')
    canceled = (root / (item['operationId'] + '.cancel.json')).exists()
    item.update(state='canceled_confirmed' if canceled else 'failed' if recovered or code else 'completed',
                exitCode=code, recoveredSupervisor=bool(recovered), groupRemovalConfirmed=True, finishedAt=time.time())
    atomic(root / (item['operationId'] + '.json'), item)
    return item


def execute(config, root, item, atomic):
    operation = item['operationId']
    expected = labels(config, item)
    image = config.get('dockerImage')
    if not isinstance(image, str) or not image:
        raise ValueError('DOCKER_IMAGE_REQUIRED')
    mount = item['root'] if item.get('workspaceId') else config.get('dockerProjectRoots', {}).get(item['projectId'], item['root'])
    name = 'ac-remote-' + hashlib.sha256((config['installationId'] + '\0' + operation).encode()).hexdigest()
    options = ['--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
               '--pids-limit', '64', '--memory', '128m', '--cpus', '0.5', '--log-opt', 'max-size=1m',
               '--mount', 'type=bind,src=' + mount + ',dst=/project', '--workdir', '/project',
               '--env', 'HOME=/project', '--env', 'PATH=/usr/local/bin:/usr/bin:/bin']
    for key, value in expected.items():
        options += ['--label', key + '=' + value]
    with authority(config, root, atomic):
        item['groupIntent'] = expected
        atomic(root / (operation + '.json'), item)
        if config.get('resourceAuthority'):
            import resource_authority
            reservation = resource_authority.reservation(config, operation, item['epoch'])
        else:
            reservation = contextlib.nullcontext([])
        with reservation as resource_options:
            result = docker('create', *options, *resource_options, image, *config['tasks'][item['taskId']])
        identity = result.stdout.decode().strip()
        item.update(state='running', stableGroup={'kind': 'docker', 'id': identity, 'labels': expected},
                    origin={'supervisorPid': os.getpid()})
        atomic(root / (operation + '.json'), item)
        # A crash before this start leaves a stopped immutable group, recoverable.
        docker('start', identity)
    deadline = time.monotonic() + config.get('maxSeconds', 60)
    while True:
        with authority(config, root, atomic):
            current = inspect(item['stableGroup'])
            canceled = (root / (operation + '.cancel.json')).exists()
            if current is None or not current['State']['Running'] or canceled or time.monotonic() >= deadline:
                return finish(config, root, item, atomic)
        time.sleep(.1)


def recover(config, root, item, atomic):
    if item['state'] in TERMINAL or not (item.get('stableGroup') or item.get('groupIntent')):
        return item
    try:
        with open(root / (item['operationId'] + '.writer.lock'), 'a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return item
            with authority(config, root, atomic):
                item = json.loads((root / (item['operationId'] + '.json')).read_text())
                if item['state'] in TERMINAL:
                    return item
                if not item.get('stableGroup'):
                    expected = labels(config, item)
                    expected['ac.remote.authority-epoch'] = item['groupIntent']['ac.remote.authority-epoch']
                    if item['groupIntent'] != expected:
                        raise ValueError('GROUP_INTENT_MISMATCH')
                    filters = []
                    for key, value in expected.items():
                        filters += ['--filter', 'label=' + key + '=' + value]
                    identities = docker('ps', '-aq', '--no-trunc', *filters).stdout.decode().split()
                    if len(identities) > 1:
                        raise ValueError('GROUP_INTENT_AMBIGUOUS')
                    if not identities:
                        # An interrupted Docker create may still be in flight at the daemon.
                        # Empty enumeration cannot prove that a group will not appear later.
                        return {**item, 'state': 'uncertain'}
                    item['stableGroup'] = {'kind': 'docker', 'id': identities[0], 'labels': expected}
                    atomic(root / (item['operationId'] + '.json'), item)
                # The successor authorizes cleanup using recorded group labels;
                # it never starts old work or signals a historical PID.
                if item['stableGroup']['labels']['ac.remote.installation'] != config['installationId']:
                    raise ValueError('GROUP_INSTALLATION_MISMATCH')
                return finish(config, root, item, atomic, recovered=True)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return {**item, 'state': 'uncertain'}
