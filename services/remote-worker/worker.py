#!/usr/bin/env python3
"""Operation journal for controller-approved SSH tasks. No AI credentials or scheduler.
This process boundary is not a hostile-code sandbox; deploy it as a restricted executor.
"""
import argparse, fcntl, hashlib, json, os, pathlib, resource, signal, subprocess, sys, time, uuid


def atomic(path, value):
    temporary = path.with_name(path.name + '.tmp-' + uuid.uuid4().hex)
    with open(temporary, 'x', encoding='utf8') as out:
        os.chmod(temporary, 0o600)
        json.dump(value, out, sort_keys=True)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temporary, path)
    descriptor = os.open(str(path.parent), os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def start_time(pid):
    text = pathlib.Path('/proc', str(pid), 'stat').read_text()
    return text[text.rindex(')') + 2:].split()[19]


def load(config_path):
    config = json.loads(pathlib.Path(config_path).read_text())
    if not isinstance(config.get('projects'), dict) or not isinstance(config.get('tasks'), dict):
        raise ValueError('INVALID_CONFIGURATION')
    requested_root = pathlib.Path(config['stateDirectory'])
    if requested_root.is_symlink():
        raise ValueError('UNSAFE_STATE_DIRECTORY')
    root = requested_root.resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root.is_symlink():
        raise ValueError('UNSAFE_STATE_DIRECTORY')
    return config, root


def operation_path(root, operation):
    return root / (str(uuid.UUID(operation)) + '.json')


def execute(config_path, operation):
    config, root = load(config_path)
    record = operation_path(root, operation)
    with open(root / (operation + '.writer.lock'), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        item = json.loads(record.read_text())
        if item['state'] != 'uncertain':
            return
        project = item['projectId']
        directory = pathlib.Path(config['projects'][project]).resolve(strict=True)
        if str(directory) != item['root'] or not directory.is_dir():
            raise ValueError('PROJECT_ROOT_CHANGED')
        command = config['tasks'][item['taskId']]
        if not isinstance(command, list) or not command or any(not isinstance(x, str) for x in command):
            raise ValueError('INVALID_TASK_CONFIGURATION')
        if not os.path.isabs(command[0]):
            raise ValueError('EXECUTABLE_MUST_BE_ABSOLUTE')
        max_log = config.get('maxLogBytes', 1048576)
        max_seconds = config.get('maxSeconds', 60)
        if not isinstance(max_log, int) or not 1024 <= max_log <= 16777216:
            raise ValueError('INVALID_LOG_LIMIT')
        if not isinstance(max_seconds, int) or not 1 <= max_seconds <= 3600:
            raise ValueError('INVALID_TIME_LIMIT')
        def limits():
            resource.setrlimit(resource.RLIMIT_FSIZE, (max_log, max_log))
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        log_path = root / (operation + '.log')
        # One writer lock stays held until the physical process has actually exited.
        with open(log_path, 'xb') as log:
            os.chmod(log_path, 0o600)
            child = subprocess.Popen(command, cwd=directory, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                     env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(directory)},
                                     start_new_session=True, preexec_fn=limits)
            try:
                observed_start = start_time(child.pid)
            except FileNotFoundError:
                if child.poll() is None:
                    raise
                observed_start = None
            item.update(state='running', pid=child.pid, startTime=observed_start,
                        bootId=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip())
            atomic(record, item)
            timed_out = False
            try:
                code = child.wait(timeout=max_seconds)
            except subprocess.TimeoutExpired:
                timed_out = True
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                code = child.wait()
            log.flush()
            os.fsync(log.fileno())
        item.update(state='completed' if code == 0 else 'failed', exitCode=code, timedOut=timed_out,
                    logSha256=hashlib.sha256(log_path.read_bytes()).hexdigest(), finishedAt=time.time())
        atomic(record, item)


def rpc(config_path):
    config, root = load(config_path)
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError('REQUEST_TOO_LARGE')
    request = json.loads(raw)
    if not isinstance(request, dict) or request.get('schemaVersion') != 1:
        raise ValueError('INVALID_REQUEST')
    operation = str(uuid.UUID(request['operationId']))
    record = operation_path(root, operation)
    action = request.get('action')
    if action == 'inspect':
        if set(request) != {'schemaVersion', 'operationId', 'action'}:
            raise ValueError('INVALID_REQUEST')
        if not record.exists():
            return {'schemaVersion': 1, 'operationId': operation, 'state': 'unknown'}
        item = json.loads(record.read_text())
        # An absent/reused PID is uncertainty, never proof of successful completion.
        if item['state'] == 'running':
            try:
                if (item['bootId'] != pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
                        or item['startTime'] != start_time(item['pid'])):
                    item['state'] = 'uncertain'
            except (OSError, ValueError):
                item['state'] = 'uncertain'
        return item
    if action != 'start' or set(request) != {'schemaVersion', 'operationId', 'action', 'projectId', 'taskId', 'root', 'epoch'}:
        raise ValueError('INVALID_REQUEST')
    project, task = request['projectId'], request['taskId']
    if project not in config['projects'] or task not in config['tasks']:
        raise ValueError('TASK_FORBIDDEN')
    directory = pathlib.Path(config['projects'][project]).resolve(strict=True)
    if str(directory) != request['root']:
        raise ValueError('PROJECT_ROOT_MISMATCH')
    if not isinstance(request['epoch'], int) or request['epoch'] < 1:
        raise ValueError('INVALID_EPOCH')
    fingerprint = hashlib.sha256(json.dumps(request, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    with open(root / (operation + '.admission.lock'), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if record.exists():
            prior = json.loads(record.read_text())
            if prior['requestDigest'] != fingerprint:
                raise ValueError('OPERATION_ID_CONFLICT')
            return prior
        item = {'schemaVersion': 1, 'operationId': operation, 'state': 'uncertain', 'projectId': project,
                'taskId': task, 'root': str(directory), 'epoch': request['epoch'], 'requestDigest': fingerprint}
        # Persist before launching. A crash in this gap remains uncertain and is not blindly retried.
        atomic(record, item)
        subprocess.Popen([sys.executable, str(pathlib.Path(__file__).resolve()), '--config', config_path, '--execute', operation],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
                         env={'PATH': '/usr/local/bin:/usr/bin:/bin'})
        return item


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--execute')
    args = parser.parse_args()
    if args.execute:
        execute(args.config, str(uuid.UUID(args.execute)))
    else:
        try:
            print(json.dumps(rpc(args.config)))
        except (OSError, ValueError, KeyError, TypeError):
            print(json.dumps({'error': 'REMOTE_OPERATION_REFUSED'}))
            raise SystemExit(1)


if __name__ == '__main__':
    main()
