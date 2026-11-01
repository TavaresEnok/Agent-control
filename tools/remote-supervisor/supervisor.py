#!/usr/bin/env python3
"""SSH entrypoint for a pre-provisioned, isolated systemd user supervisor."""
import fcntl
import hashlib
import hmac
import json
import os
import pwd
import re
import stat
import subprocess
import sys
import tempfile

MAX_MESSAGE = 131072
IDENTITY_FIELDS = ('operation_id', 'company_id', 'environment_id', 'task_id', 'execution_id', 'epoch')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def safe_file(path, owner, secret=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_mode & (0o077 if secret else 0o022):
            raise ValueError('unsafe supervisor file')
        return handle.read(MAX_MESSAGE + 1)


def validate_directory(path, owner, leaf_writable=False):
    path = os.path.realpath(path)
    current = '/'
    components = [part for part in path.split('/') if part]
    for index, component in enumerate(components):
        current = os.path.join(current, component)
        info = os.lstat(current)
        leaf = index == len(components) - 1
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError('invalid directory')
        if not (leaf and leaf_writable) and (info.st_uid not in (0, owner) or info.st_mode & 0o022):
            raise ValueError('untrusted directory ancestor')
    return path


def atomic_json(path, value):
    fd, temporary = tempfile.mkstemp(prefix='.intent-', dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(canonical(value))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(os.path.dirname(path), os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def call(argv, env):
    return subprocess.run(argv, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=20, check=False, text=True)


def status(unit, intent, env):
    result = call(['/usr/bin/systemctl', '--user', 'show', unit, '--property=LoadState',
                   '--property=ActiveState', '--property=SubState', '--property=Result',
                   '--property=ExecMainStatus', '--property=InvocationID', '--property=Description',
                   '--property=Type', '--property=KillMode', '--property=ControlGroup', '--property=MainPID'], env)
    fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    receipt = {key: intent[key] for key in ('operation_id', 'company_id', 'environment_id', 'task_id', 'execution_id', 'epoch')}
    receipt.update({'remote_job_id': unit, 'intent_hash': intent['intent_hash'], 'state': 'uncertain'})
    invocation = fields.get('InvocationID', '')
    if result.returncode != 0 or fields.get('LoadState') != 'loaded' or not re.fullmatch(r'[0-9a-f]{32}', invocation) or set(invocation) == {'0'} or fields.get('Description') != 'agent-control-' + intent['intent_hash'] or fields.get('Type') != 'exec' or fields.get('KillMode') != 'control-group':
        return receipt
    state, substate = fields.get('ActiveState'), fields.get('SubState')
    if state in ('activating', 'deactivating') or (state == 'active' and substate not in ('exited', 'dead')):
        group = fields.get('ControlGroup', '')
        if group.startswith('/') and fields.get('MainPID', '').isdigit() and int(fields['MainPID']) > 0:
            receipt['state'] = 'running'
    elif (state in ('inactive', 'failed') or (state == 'active' and substate == 'exited')) and fields.get('ExecMainStatus', '').isdigit():
        code = int(fields['ExecMainStatus'])
        if code != 125:
            receipt.update({'state': 'completed' if fields.get('Result') == 'success' and code == 0 else 'failed',
                            'exit_code': code if code != 0 or fields.get('Result') == 'success' else 1,
                            'invocation_id': invocation})
    return receipt


def validate_terminal_receipt(receipt, unit, intent):
    required = set(IDENTITY_FIELDS) | {'remote_job_id', 'intent_hash', 'state', 'exit_code', 'invocation_id'}
    if not isinstance(receipt, dict) or set(receipt) != required:
        raise ValueError('invalid terminal cache receipt')
    if any(receipt[key] != intent[key] for key in IDENTITY_FIELDS):
        raise ValueError('terminal cache identity mismatch')
    if receipt['remote_job_id'] != unit or receipt['intent_hash'] != intent['intent_hash']:
        raise ValueError('terminal cache unit or intent mismatch')
    invocation = receipt['invocation_id']
    if not isinstance(invocation, str) or not re.fullmatch(r'[0-9a-f]{32}', invocation) or set(invocation) == {'0'}:
        raise ValueError('invalid terminal cache invocation')
    code = receipt['exit_code']
    if type(code) is not int or not 0 <= code <= 255 or code == 125:
        raise ValueError('invalid terminal cache exit code')
    if receipt['state'] not in ('completed', 'failed') or (receipt['state'] == 'completed') != (code == 0):
        raise ValueError('invalid terminal cache outcome')
    return receipt


def read_terminal_cache(path, owner, key, unit, intent):
    if not os.path.lexists(path):
        return None
    envelope = json.loads(safe_file(path, owner, secret=True))
    if not isinstance(envelope, dict) or set(envelope) != {'version', 'receipt', 'mac'} or type(envelope['version']) is not int or envelope['version'] != 1:
        raise ValueError('invalid terminal cache envelope')
    body = {name: envelope[name] for name in ('version', 'receipt')}
    supplied = envelope['mac']
    expected = hmac.new(key, canonical(body), hashlib.sha256).hexdigest()
    if not isinstance(supplied, str) or not hmac.compare_digest(supplied, expected):
        raise ValueError('invalid terminal cache authentication')
    return validate_terminal_receipt(envelope['receipt'], unit, intent)


def write_terminal_cache(path, owner, key, unit, intent, receipt):
    validate_terminal_receipt(receipt, unit, intent)
    previous = read_terminal_cache(path, owner, key, unit, intent)
    if previous is not None:
        if previous != receipt:
            raise ValueError('conflicting terminal cache receipt')
        return
    body = {'version': 1, 'receipt': receipt}
    envelope = dict(body, mac=hmac.new(key, canonical(body), hashlib.sha256).hexdigest())
    atomic_json(path, envelope)


def observe_operation(action, unit, intent, env, cache_path, owner, key):
    # Called only while the per-operation flock is held. A terminal observation
    # is immutable and survives loss of the transient systemd unit/user manager.
    cached = read_terminal_cache(cache_path, owner, key, unit, intent)
    if cached is not None:
        return cached
    receipt = status(unit, intent, env)
    if action == 'cancel' and receipt['state'] == 'running':
        call(['/usr/bin/systemctl', '--user', 'stop', unit], env)
        receipt = status(unit, intent, env)
    if receipt['state'] in ('completed', 'failed'):
        write_terminal_cache(cache_path, owner, key, unit, intent, receipt)
    return receipt


def main():
    if len(sys.argv) != 2 or not sys.argv[1].startswith('/'):
        raise ValueError('absolute configuration file required')
    owner = os.geteuid()
    validate_directory(os.path.dirname(sys.argv[1]), owner)
    config = json.loads(safe_file(sys.argv[1], 0))
    validate_directory(os.path.dirname(config['secret_file']), owner)
    secret = safe_file(config['secret_file'], owner, secret=True).strip()
    if len(secret) != 64 or not re.fullmatch(rb'[0-9a-f]{64}', secret):
        raise ValueError('invalid supervisor key')
    state_dir = validate_directory(config['state_dir'], owner)
    state_info = os.stat(state_dir)
    if state_info.st_uid != owner or state_info.st_mode & 0o077:
        raise ValueError('state directory must be private')
    validate_directory(os.path.dirname(config['wrapper_path']), owner)
    safe_file(config['wrapper_path'], 0)
    job = pwd.getpwnam(config['job_user'])
    if job.pw_uid in (0, owner) or not re.fullmatch(r'[a-z_][a-z0-9_-]*', config['job_user']):
        raise ValueError('job user must be a separate unprivileged account')
    raw = sys.stdin.buffer.read(MAX_MESSAGE + 1)
    if len(raw) > MAX_MESSAGE:
        raise ValueError('message too large')
    envelope = json.loads(raw)
    payload = envelope['payload']
    expected = hmac.new(bytes.fromhex(secret.decode()), canonical(payload), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, envelope.get('mac', '')):
        raise ValueError('request authentication failed')
    identity_fields = IDENTITY_FIELDS
    if not all(str(payload.get(k, '')) for k in identity_fields):
        raise ValueError('incomplete identity')
    operation_id = str(payload['operation_id'])
    digest = hashlib.sha256(operation_id.encode()).hexdigest()
    unit = 'ac-remote-' + digest[:40] + '.service'
    state_path = os.path.join(state_dir, digest + '.json')
    lock_path = os.path.join(state_dir, digest + '.lock')
    cache_path = os.path.join(state_dir, digest + '.terminal.json')
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, 'r+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        action = payload['action']
        if os.path.lexists(state_path):
            intent = json.loads(safe_file(state_path, owner, secret=True))
            if any(str(intent.get(k)) != str(payload.get(k)) for k in identity_fields) or intent['intent_hash'] != payload['intent_hash']:
                raise ValueError('operation identity mismatch')
        elif os.path.lexists(cache_path):
            raise ValueError('terminal cache without durable intent')
        elif action == 'dispatch':
            identity = {key: payload[key] for key in identity_fields}
            identity.update({'command': payload['command'], 'working_directory': payload['working_directory'],
                             'artifact_hash': payload.get('artifact_hash')})
            if hashlib.sha256(canonical(identity)).hexdigest() != payload['intent_hash']:
                raise ValueError('intent digest mismatch')
            working = validate_directory(payload['working_directory'], owner, leaf_writable=True)
            info = os.stat(working)
            if info.st_uid not in (0, owner, job.pw_uid) or info.st_mode & 0o022:
                raise ValueError('unsafe working directory')
            roots = [os.path.realpath(root) for root in config['allowed_directories']]
            if not any(os.path.commonpath([root, working]) == root for root in roots):
                raise ValueError('directory not allowed')
            intent = {key: payload[key] for key in identity_fields}
            intent.update({'intent_hash': payload['intent_hash'], 'working_directory': working})
            atomic_json(state_path, intent)
            env = {'PATH': '/usr/bin:/bin', 'HOME': pwd.getpwuid(owner).pw_dir, 'LANG': 'C',
                   'XDG_RUNTIME_DIR': '/run/user/' + str(owner),
                   'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/' + str(owner) + '/bus'}
            command = ['/usr/bin/systemd-run', '--user', '--unit=' + unit[:-8],
                       '--description=agent-control-' + intent['intent_hash'], '--property=Type=exec',
                       '--property=KillMode=control-group', '--property=RemainAfterExit=yes',
                       '--working-directory=' + working, '/usr/bin/python3', config['wrapper_path'],
                       config['job_user'], payload['command']]
            try:
                call(command, env)
            except (OSError, subprocess.TimeoutExpired):
                pass
        else:
            raise ValueError('operation not found')
        env = {'PATH': '/usr/bin:/bin', 'HOME': pwd.getpwuid(owner).pw_dir, 'LANG': 'C',
               'XDG_RUNTIME_DIR': '/run/user/' + str(owner),
               'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/' + str(owner) + '/bus'}
        if action not in ('dispatch', 'status', 'cancel'):
            raise ValueError('unknown action')
        receipt = observe_operation(action, unit, intent, env, cache_path, owner, bytes.fromhex(secret.decode()))
        mac = hmac.new(bytes.fromhex(secret.decode()), canonical(receipt), hashlib.sha256).hexdigest()
        sys.stdout.buffer.write(canonical({'receipt': receipt, 'mac': mac}) + b'\n')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.stderr.write('remote supervisor request failed\n')
        sys.exit(1)
