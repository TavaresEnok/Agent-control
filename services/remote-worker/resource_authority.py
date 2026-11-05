#!/usr/bin/env python3
"""Opt-in Docker/systemd cgroup-v2 aggregate authority. Runtime never writes cgroup limits.

Provisioning is explicit and separate; executor state directories are never authority.
Docker socket access and configuration are trusted, as with the remote executor.
"""
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import threading

LABEL = 'ac.resources.authority'
_HELD = threading.local()


def docker(*args):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise ValueError('RESOURCE_DOCKER_UNAVAILABLE')
    return result.stdout.strip()


def settings(config):
    value = config.get('resourceAuthority')
    if not isinstance(value, dict):
        raise ValueError('RESOURCE_AUTHORITY_REQUIRED')
    authority = value.get('authorityId')
    if not isinstance(authority, str) or not re.fullmatch(r'[a-zA-Z0-9_.:-]{1,128}', authority):
        raise ValueError('INVALID_RESOURCE_AUTHORITY')
    for key, minimum, maximum in [('cpuQuotaMicros', 1000, 1000000000), ('cpuPeriodMicros', 1000, 1000000),
                                  ('memoryBytes', 16777216, 1099511627776), ('pidsLimit', 4, 1000000), ('maxJobs', 1, 10000)]:
        if type(value.get(key)) is not int or not minimum <= value[key] <= maximum:
            raise ValueError('INVALID_RESOURCE_LIMIT_' + key)
    if not re.fullmatch(r'[0-9a-f]{64}', str(value.get('anchorId', ''))):
        raise ValueError('INVALID_RESOURCE_ANCHOR')
    digest = hashlib.sha256(authority.encode()).hexdigest()[:24]
    return value, 'acr' + digest + '.slice'


def policy_digest(value):
    keys = ['cpuQuotaMicros', 'cpuPeriodMicros', 'memoryBytes', 'pidsLimit', 'maxJobs']
    return hashlib.sha256(json.dumps({key: value[key] for key in keys}, sort_keys=True).encode()).hexdigest()


def ledger_path(config):
    value, _ = settings(config)
    directory = pathlib.Path('/var/tmp') / ('ac-resource-authority-' + str(os.geteuid()))
    if directory.is_symlink():
        raise ValueError('UNSAFE_RESOURCE_AUTHORITY_DIRECTORY')
    try:
        info = directory.stat()
    except FileNotFoundError:
        raise ValueError('RESOURCE_AUTHORITY_LEDGER_MISSING')
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('UNSAFE_RESOURCE_AUTHORITY_DIRECTORY')
    return directory / (hashlib.sha256(value['authorityId'].encode()).hexdigest() + '.json')


def installation_directory(config, create=False):
    installation = config.get('installationId')
    if not isinstance(installation, str) or not installation or len(installation) > 256:
        raise ValueError('INVALID_RESOURCE_INSTALLATION')
    directory = pathlib.Path('/var/tmp') / ('ac-resource-installation-' + hashlib.sha256(installation.encode()).hexdigest())
    if create:
        directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink(): raise ValueError('UNSAFE_RESOURCE_INSTALLATION_DIRECTORY')
    try: info = directory.stat()
    except FileNotFoundError: raise ValueError('RESOURCE_INSTALLATION_BINDING_MISSING')
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('UNSAFE_RESOURCE_INSTALLATION_DIRECTORY')
    return directory


@contextlib.contextmanager
def installation_lock(config, provision=False):
    """One persistent lock per installation, independent of UID/state/authority IDs.

    First provision owns a private directory; another UID cannot split the lock.
    The binding is initialized by provisioning, never recreated by runtime.
    """
    identity = config.get('installationId')
    if getattr(_HELD, 'installation', None) is not None:
        if _HELD.installation != identity: raise ValueError('RESOURCE_NESTED_INSTALLATION_MISMATCH')
        yield installation_directory(config)
        return
    directory = installation_directory(config, provision)
    try: fd = os.open(directory / 'authority.lock', os.O_RDWR | os.O_NOFOLLOW | (os.O_CREAT if provision else 0), 0o600)
    except FileNotFoundError: raise ValueError('RESOURCE_INSTALLATION_BINDING_MISSING')
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            raise ValueError('UNSAFE_RESOURCE_INSTALLATION_LOCK')
        try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise ValueError('RESOURCE_AUTHORITY_BUSY')
        _HELD.installation = identity
        try: yield directory
        finally: _HELD.installation = None
    finally: os.close(fd)


def _verify_installation(config, value, parent):
    directory = installation_directory(config)
    path = directory / 'binding.json'
    try: binding = _read_reservation(path)
    except FileNotFoundError: raise ValueError('RESOURCE_INSTALLATION_BINDING_MISSING')
    expected = {'installationId': config['installationId'], 'authorityId': value['authorityId'],
                'anchorId': value['anchorId'], 'operationId': 'installation-binding'}
    if binding != expected: raise ValueError('RESOURCE_INSTALLATION_AUTHORITY_CONFLICT')
    identifiers = docker('ps', '-aq', '--no-trunc', '--filter', 'label=ac.resources.installation=' + config['installationId']).splitlines()
    for observed in json.loads(docker('inspect', *identifiers)) if identifiers else []:
        if observed['Config']['Labels'].get(LABEL) != value['authorityId'] or observed['HostConfig']['CgroupParent'] != parent:
            raise ValueError('RESOURCE_INSTALLATION_AUTHORITY_CONFLICT')
    return directory


def _group_processes(root, inspected):
    group = root / ('docker-' + inspected['Id'] + '.scope')
    try: return (group / 'cgroup.procs').read_text().splitlines()
    except FileNotFoundError:
        if not root.is_dir(): raise ValueError('RESOURCE_ENVELOPE_UNCERTAIN')
        raise


def _physical_member(root, inspected):
    # Read the real kernel hierarchy, not merely Docker's requested HostConfig.
    if str(inspected['State']['Pid']) not in _group_processes(root, inspected):
        raise ValueError('RESOURCE_PHYSICAL_GROUP_MISMATCH')


def _verify(config):
    value, parent = settings(config)
    installation = _verify_installation(config, value, parent)
    if docker('info', '--format', '{{.CgroupDriver}} {{.CgroupVersion}}') != 'systemd 2':
        raise ValueError('RESOURCE_BACKEND_UNSUPPORTED')
    anchor = json.loads(docker('inspect', value['anchorId']))[0]
    if anchor['Id'] != value['anchorId'] or not anchor['State']['Running'] or anchor['Config']['Labels'].get(LABEL) != value['authorityId'] or anchor['HostConfig']['CgroupParent'] != parent:
        raise ValueError('RESOURCE_ANCHOR_MISMATCH')
    if 'resourceCgroupRoot' in config:
        raise ValueError('RESOURCE_CGROUP_ROOT_OVERRIDE_FORBIDDEN')
    labels = anchor['Config']['Labels']
    directory = ledger_path(config).parent.stat()
    installation_info = installation.stat()
    expected_labels = {'ac.resources.installation-directory': str(installation_info.st_dev) + ':' + str(installation_info.st_ino),
                       'ac.resources.ledger-directory': str(directory.st_dev) + ':' + str(directory.st_ino),
                       'ac.resources.uid': str(os.geteuid()), 'ac.resources.max-jobs': str(value['maxJobs']),
                       'ac.resources.installation': config.get('installationId'),
                       'ac.resources.policy': policy_digest(value)}
    if any(labels.get(key) != expected for key, expected in expected_labels.items()):
        raise ValueError('RESOURCE_ANCHOR_POLICY_MISMATCH')
    root = pathlib.Path('/sys/fs/cgroup') / parent
    _physical_member(root, anchor)
    expected = {'cpu.max': f"{value['cpuQuotaMicros']} {value['cpuPeriodMicros']}",
                'memory.max': str(value['memoryBytes']), 'memory.swap.max': '0', 'pids.max': str(value['pidsLimit'])}
    for file, wanted in expected.items():
        if (root / file).read_text().strip() != wanted:
            raise ValueError('RESOURCE_ENVELOPE_MISMATCH_' + file)
    return value, parent


def verify(config):
    with installation_lock(config):
        return _verify(config)


@contextlib.contextmanager
def _authority(config):
    """Host-wide epoch fence. Keep held through inspect/create/start/remove + journal.

    Reentrant within one thread; another process/thread fails busy rather than
    waiting while a superseded authority performs a mutation.
    """
    value, parent = settings(config)
    epoch = config.get('authorityEpoch')
    installation = config.get('installationId')
    if type(epoch) is not int or epoch < 1 or not isinstance(installation, str) or not installation:
        raise ValueError('INVALID_RESOURCE_AUTHORITY_EPOCH')
    identity = (value['authorityId'], installation, epoch)
    held = getattr(_HELD, 'identity', None)
    if held is not None:
        if held != identity:
            raise ValueError('RESOURCE_NESTED_AUTHORITY_MISMATCH')
        yield
        return
    path = ledger_path(config)
    try:
        fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
    except FileNotFoundError:
        raise ValueError('RESOURCE_AUTHORITY_LEDGER_MISSING')
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            raise ValueError('UNSAFE_RESOURCE_LOCK')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('RESOURCE_AUTHORITY_BUSY')
        verify(config)
        previous = os.read(fd, 4096)
        if not previous:
            raise ValueError('RESOURCE_AUTHORITY_LEDGER_UNCERTAIN')
        if previous:
            try:
                ledger = json.loads(previous)
            except (ValueError, UnicodeDecodeError):
                raise ValueError('RESOURCE_AUTHORITY_LEDGER_UNCERTAIN')
            if ledger.get('anchorId') != value['anchorId'] or ledger.get('installationId') != installation:
                raise ValueError('RESOURCE_AUTHORITY_LEDGER_MISMATCH')
            if type(ledger.get('epoch')) is not int or epoch < ledger['epoch']:
                raise ValueError('RESOURCE_AUTHORITY_FENCED')
        ledger = recovery_transition(ledger, epoch, config.get('_recoveryToken'), config.get('_recoveryPhase'))
        encoded = json.dumps(ledger, sort_keys=True).encode()
        os.lseek(fd, 0, os.SEEK_SET)
        if os.write(fd, encoded) != len(encoded):
            raise ValueError('RESOURCE_AUTHORITY_LEDGER_UNCERTAIN')
        os.ftruncate(fd, len(encoded))
        os.fsync(fd)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        _HELD.identity = identity
        try:
            yield
        finally:
            _HELD.identity = None
    finally:
        os.close(fd)


@contextlib.contextmanager
def authority(config):
    with installation_lock(config):
        with _authority(config):
            yield


def recovery_transition(ledger, epoch, token, phase):
    """Durable host hold prevents new physical effects until recovery CAS."""
    import uuid
    prior = ledger['epoch']
    if phase is not None:
        if phase not in ('hold', 'release'): raise ValueError('RECOVERY_RESOURCE_TOKEN_INVALID')
        try: token = str(uuid.UUID(token))
        except (TypeError, ValueError): raise ValueError('RECOVERY_RESOURCE_TOKEN_INVALID')
        if epoch == prior and ledger.get('recoveryToken') != token: raise ValueError('RECOVERY_RESOURCE_EPOCH_NOT_ADVANCED')
        if phase == 'release' and (epoch != prior or ledger.get('recoveryToken') != token): raise ValueError('RECOVERY_RESOURCE_TOKEN_INVALID')
        ledger = {**ledger, 'epoch': epoch, 'recoveryToken': token, 'recoveryHold': phase == 'hold'}
    else:
        if ledger.get('recoveryHold') is True: raise ValueError('RECOVERY_RESOURCE_HOLD')
        ledger = {**ledger, 'epoch': epoch}
    return ledger


def _reservation_paths(config):
    value, _ = settings(config)
    prefix = hashlib.sha256(value['authorityId'].encode()).hexdigest()[:24]
    return ledger_path(config).parent.glob('reservation-' + prefix + '-*.json')


def _read_reservation(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            raise ValueError('UNSAFE_RESOURCE_RESERVATION')
        try:
            value = json.loads(os.read(fd, 4096))
            if not isinstance(value, dict) or not isinstance(value.get('operationId'), str): raise ValueError()
        except (ValueError, UnicodeDecodeError):
            raise ValueError('RESOURCE_RESERVATION_UNCERTAIN')
        return value
    finally:
        os.close(fd)


def _write_reservation(path, value, create):
    fd = os.open(path, os.O_WRONLY | os.O_NOFOLLOW | (os.O_CREAT | os.O_EXCL if create else 0), 0o600)
    try:
        encoded = json.dumps(value, sort_keys=True).encode()
        if os.write(fd, encoded) != len(encoded): raise ValueError('RESOURCE_RESERVATION_UNCERTAIN')
        os.ftruncate(fd, len(encoded))
        os.fsync(fd)
    finally:
        os.close(fd)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)


@contextlib.contextmanager
def reservation(config, operation_id, epoch):
    """Persist pending intent BEFORE Docker create, retaining ambiguous admissions.

    A delayed daemon create after RPC timeout cannot escape the budget. Pending
    intents have no optimistic release; only bound immutable IDs can be released.
    """
    import uuid
    operation_id = str(uuid.UUID(operation_id))
    if type(epoch) is not int or epoch < 1: raise ValueError('INVALID_RESOURCE_OPERATION_EPOCH')
    with authority(config):
        value, parent = settings(config)
        paths = list(_reservation_paths(config))
        slots = [_read_reservation(path) for path in paths]
        ids = docker('ps', '-aq', '--no-trunc', '--filter', 'label=' + LABEL + '=' + value['authorityId']).splitlines()
        bound = {slot.get('containerId') for slot in slots}
        untracked = [identifier for identifier in ids if identifier != value['anchorId'] and identifier not in bound]
        if len(slots) + len(untracked) >= value['maxJobs']:
            raise ValueError('RESOURCE_CAPACITY_EXHAUSTED')
        prefix = hashlib.sha256(value['authorityId'].encode()).hexdigest()[:24]
        key = hashlib.sha256((operation_id + ':' + str(epoch)).encode()).hexdigest()
        path = ledger_path(config).parent / ('reservation-' + prefix + '-' + key + '.json')
        slot = {'authorityId': value['authorityId'], 'operationId': operation_id, 'epoch': epoch, 'containerId': None}
        try:
            _write_reservation(path, slot, True)
        except FileExistsError:
            raise ValueError('RESOURCE_RESERVATION_UNCERTAIN')
        options = ['--cgroup-parent', parent, '--label', LABEL + '=' + value['authorityId'],
                   '--label', 'ac.resources.installation=' + config['installationId'],
                   '--label', 'ac.resources.operation=' + operation_id, '--label', 'ac.resources.epoch=' + str(epoch)]
        yield options
        # An exception/timeout leaves the already-durable unbound slot occupied.
        matches = docker('ps', '-aq', '--no-trunc', '--filter', 'label=' + LABEL + '=' + value['authorityId'],
                         '--filter', 'label=ac.resources.operation=' + operation_id,
                         '--filter', 'label=ac.resources.epoch=' + str(epoch)).splitlines()
        if len(matches) != 1: raise ValueError('RESOURCE_RESERVATION_UNCERTAIN')
        slot['containerId'] = matches[0]
        _write_reservation(path, slot, False)


def validate_group(config, inspect_dict, operation_id, epoch, reinspect=None):
    with authority(config):
        inspect_dict = _validate_group(config, inspect_dict, reinspect)
        labels = inspect_dict['Config']['Labels']
        if labels.get('ac.resources.operation') != operation_id or labels.get('ac.resources.epoch') != str(epoch):
            raise ValueError('RESOURCE_OPERATION_GROUP_MISMATCH')
        # Recover a create ACK lost before durable binding, while the physical
        # group's immutable identity and labels are still available to inspect.
        for path in list(_reservation_paths(config)):
            slot = _read_reservation(path)
            if slot['operationId'] == operation_id and slot.get('epoch') == epoch:
                if slot.get('containerId') not in (None, inspect_dict['Id']):
                    raise ValueError('RESOURCE_RESERVATION_ID_MISMATCH')
                if slot.get('containerId') is None:
                    slot['containerId'] = inspect_dict['Id']
                    _write_reservation(path, slot, False)
        return inspect_dict


def _inspect_immutable(identifier):
    observed = json.loads(docker('inspect', identifier))
    if not isinstance(observed, list) or len(observed) != 1:
        raise ValueError('RESOURCE_GROUP_REOBSERVATION_INVALID')
    return observed[0]


def _started(value):
    matched = re.fullmatch(r'([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.([0-9]{1,9}))?Z', value) if isinstance(value, str) else None
    if matched is None or value.startswith('0001-'):
        raise ValueError('RESOURCE_GROUP_TERMINAL_UNCONFIRMED')
    try: return datetime.datetime.fromisoformat(matched[1] + '+00:00'), int((matched[2] or '').ljust(9, '0'))
    except ValueError: raise ValueError('RESOURCE_GROUP_TERMINAL_UNCONFIRMED')


def _reobserve_membership(root, original, reinspect):
    identifier = original.get('Id')
    if not isinstance(identifier, str) or not re.fullmatch(r'[a-f0-9]{64}', identifier):
        raise ValueError('RESOURCE_GROUP_REOBSERVATION_INVALID')
    # Never re-observe by reusable name. The caller holds the host authority
    # lock; this bounded observation handles natural process exit, not a retry
    # of create/start, a missing container, or an authority-anchor failure.
    current = reinspect(identifier)
    if not isinstance(current, dict) or current.get('Id') != identifier or any(current.get(key) != original.get(key) for key in ('Name', 'Image', 'Config', 'HostConfig', 'RestartCount')):
        raise ValueError('RESOURCE_GROUP_REOBSERVATION_MISMATCH')
    state = current.get('State')
    previous = original.get('State')
    if not isinstance(state, dict) or not isinstance(previous, dict) or state.get('StartedAt') != previous.get('StartedAt'):
        raise ValueError('RESOURCE_GROUP_RESTARTED')
    if state.get('Running') is True:
        if type(state.get('Pid')) is not int or state['Pid'] <= 0 or state['Pid'] != previous.get('Pid') or state.get('Restarting') is not False or state.get('Status') != 'running' or state.get('Paused') is not False or state.get('Dead') is not False:
            raise ValueError('RESOURCE_PHYSICAL_GROUP_UNCERTAIN')
        _started(state.get('StartedAt'))
        try: _physical_member(root, current)
        except (FileNotFoundError, ValueError): raise ValueError('RESOURCE_PHYSICAL_GROUP_UNCERTAIN')
        return current
    if state.get('Status') != 'exited' or state.get('Running') is not False or state.get('Restarting') is not False or state.get('Dead') is not False or state.get('Paused') is not False or type(state.get('Pid')) is not int or state['Pid'] != 0 or type(state.get('ExitCode')) is not int:
        raise ValueError('RESOURCE_GROUP_TERMINAL_UNCONFIRMED')
    if _started(state.get('FinishedAt')) < _started(state.get('StartedAt')):
        raise ValueError('RESOURCE_GROUP_TERMINAL_UNCONFIRMED')
    # Docker terminal state is insufficient while any process still occupies
    # its kernel group. The completed group may legitimately have disappeared.
    try:
        if _group_processes(root, current): raise ValueError('RESOURCE_TERMINAL_GROUP_OCCUPIED')
    except FileNotFoundError: pass
    return current


def _validate_group(config, inspect_dict, reinspect=None):
    value, parent = verify(config)
    if inspect_dict['Config']['Labels'].get(LABEL) != value['authorityId'] or inspect_dict['HostConfig']['CgroupParent'] != parent:
        raise ValueError('RESOURCE_GROUP_MISMATCH')
    if inspect_dict['State']['Running']:
        root = pathlib.Path('/sys/fs/cgroup') / parent
        try: _physical_member(root, inspect_dict)
        except FileNotFoundError:
            return _reobserve_membership(root, inspect_dict, reinspect or _inspect_immutable)
        except ValueError as error:
            if str(error) != 'RESOURCE_PHYSICAL_GROUP_MISMATCH': raise
            return _reobserve_membership(root, inspect_dict, reinspect or _inspect_immutable)
    return inspect_dict


def release(config, container_id, operation_id, epoch):
    with authority(config):
        ids = docker('ps', '-aq', '--no-trunc', '--filter', 'id=' + container_id).splitlines()
        if ids:
            raise ValueError('RESOURCE_GROUP_STILL_PRESENT')
        for path in list(_reservation_paths(config)):
            if _read_reservation(path).get('containerId') == container_id:
                path.unlink()
        directory_fd = os.open(ledger_path(config).parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(directory_fd)
        finally: os.close(directory_fd)


def claim_operation(config, operation_id, epoch, request_digest, state_root):
    """Permanent same-root idempotency tombstone shared by every controller alias.

    Returns True for a new claim, False for identical replay. A caller with no
    local journal MUST refuse an existing claim as uncertain.
    A distinct state journal cannot relaunch an operation after its container has
    disappeared. Claims are intentionally retained until explicit authority retirement.
    """
    import uuid
    canonical = str(uuid.UUID(operation_id))
    if type(epoch) is not int or epoch < 1 or not isinstance(request_digest, str) or not re.fullmatch(r'[0-9a-f]{64}', request_digest):
        raise ValueError('INVALID_RESOURCE_OPERATION_CLAIM')
    root = pathlib.Path(state_root).resolve(strict=True)
    info = root.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
        raise ValueError('UNSAFE_RESOURCE_OPERATION_ROOT')
    with authority(config):
        key = hashlib.sha256((config['installationId'] + '\0' + canonical).encode()).hexdigest()
        path = ledger_path(config).parent / ('operation-' + key + '.json')
        claim = {'installationId': config['installationId'], 'operationId': canonical, 'epoch': epoch,
                 'requestDigest': request_digest, 'stateRoot': str(root), 'stateRootDevice': info.st_dev,
                 'stateRootInode': info.st_ino}
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                metadata = os.fstat(fd)
                if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_nlink != 1:
                    raise ValueError('UNSAFE_RESOURCE_OPERATION_CLAIM')
                try:
                    previous = json.loads(os.read(fd, 8192))
                except (ValueError, UnicodeDecodeError):
                    raise ValueError('RESOURCE_OPERATION_CLAIM_UNCERTAIN')
            finally:
                os.close(fd)
            if previous != claim:
                raise ValueError('RESOURCE_OPERATION_ALREADY_CLAIMED')
            return False
        try:
            encoded = json.dumps(claim, sort_keys=True).encode()
            if os.write(fd, encoded) != len(encoded):
                raise ValueError('RESOURCE_OPERATION_CLAIM_UNCERTAIN')
            os.fsync(fd)
        finally:
            os.close(fd)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)

        return True
