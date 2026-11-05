#!/usr/bin/env python3
"""Operation journal for controller-approved SSH tasks. No AI credentials or scheduler.
This process boundary is not a hostile-code sandbox; deploy it as a restricted executor.
"""
import remote_supervisor
import argparse, fcntl, hashlib, importlib.util, json, os, pathlib, resource, signal, stat, subprocess, sys, time, uuid


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
    info = root.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError('UNSAFE_STATE_PERMISSIONS')
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
        cancel_path = root / (operation + '.cancel.json')
        if cancel_path.exists():
            item.update(state='canceled_confirmed', exitCode=0, canceledWithoutStart=True,
                        logSha256=hashlib.sha256(b'').hexdigest(), finishedAt=time.time())
            atomic(record, item)
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
        if type(max_log) is not int or not 1024 <= max_log <= 16777216:
            raise ValueError('INVALID_LOG_LIMIT')
        if type(max_seconds) is not int or not 1 <= max_seconds <= 3600:
            raise ValueError('INVALID_TIME_LIMIT')
        if config.get('executionBackend') == 'docker':
            remote_supervisor.execute(config, root, item, atomic)
            return
        def limits():
            resource.setrlimit(resource.RLIMIT_FSIZE, (max_log, max_log))
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        # Bind origin before any task is allowed to execute. The gated child exits
        # on EOF if the supervisor dies before publishing its identity.
        origin = {'bootId': pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                  'pidNamespace': os.readlink('/proc/self/ns/pid'),
                  'supervisorPid': os.getpid(), 'supervisorStartTime': start_time(os.getpid())}
        item['origin'] = origin
        atomic(record, item)
        log_path = root / (operation + '.log')
        # One writer lock stays held until the physical process has actually exited.
        with open(log_path, 'xb') as log:
            os.chmod(log_path, 0o600)
            child = subprocess.Popen([sys.executable, str(pathlib.Path(__file__).resolve()), '--gate', *command],
                                     cwd=directory, stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT,
                                     env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(directory)},
                                     start_new_session=True, preexec_fn=limits)
            try:
                observed_start = start_time(child.pid)
            except FileNotFoundError:
                if child.poll() is None:
                    raise
                observed_start = None
            if observed_start is None or os.getpgid(child.pid) != child.pid:
                raise ValueError('CHILD_IDENTITY_UNAVAILABLE')
            item.update(state='running', pid=child.pid, startTime=observed_start,
                        bootId=origin['bootId'], pidNamespace=origin['pidNamespace'], pgid=child.pid)
            atomic(record, item)
            child.stdin.write(b'1')
            child.stdin.close()
            timed_out, canceled = False, False
            deadline = time.monotonic() + max_seconds
            while True:
                try:
                    code = child.wait(timeout=min(.25, max(.01, deadline - time.monotonic())))
                    break
                except subprocess.TimeoutExpired:
                    canceled = cancel_path.exists()
                    timed_out = time.monotonic() >= deadline
                    if not canceled and not timed_out:
                        continue
                    # Only the owning parent signals its unreaped child's group.
                    # RPC never signals a PID copied from historical state.
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    code = child.wait()
                    break
            log.flush()
            os.fsync(log.fileno())
        item.update(state='canceled_confirmed' if canceled else 'completed' if code == 0 else 'failed', exitCode=code, timedOut=timed_out,
                    logSha256=hashlib.sha256(log_path.read_bytes()).hexdigest(), finishedAt=time.time())
        atomic(record, item)


def observed(item):
    # Legacy or mismatched identities never justify reporting a live supervisor.
    item = dict(item)
    if (item.get('stableGroup') or item.get('groupIntent')):
        return item
    if item['state'] == 'running':
        try:
            origin = item['origin']
            if (not item.get('pidNamespace') or item['pidNamespace'] != os.readlink('/proc/self/ns/pid')
                    or origin['pidNamespace'] != item['pidNamespace'] or origin['bootId'] != item['bootId']
                    or origin['supervisorStartTime'] != start_time(origin['supervisorPid'])
                    or item['bootId'] != pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
                    or item['startTime'] != start_time(item['pid'])):
                item['state'] = 'uncertain'
        except (OSError, ValueError, KeyError, TypeError):
            item['state'] = 'uncertain'
    return item


def rpc(config_path):
    config, root = load(config_path)
    if config.get('executionBackend') == 'docker':
        # Keep fencing held through request validation, journal mutations, recovery
        # and admission. A stale request cannot pass a check then mutate later.
        with remote_supervisor.authority(config, root, atomic):
            return dispatch(config_path, config, root)
    return dispatch(config_path, config, root)


def dispatch(config_path, config, root):
    raw = sys.stdin.buffer.read(98305)
    if len(raw) > 98304:
        raise ValueError('REQUEST_TOO_LARGE')
    request = json.loads(raw)
    if not isinstance(request, dict) or request.get('schemaVersion') != 1:
        raise ValueError('INVALID_REQUEST')
    operation = str(uuid.UUID(request['operationId']))
    record = operation_path(root, operation)
    action = request.get('action')
    if action == 'git-return':
        if (request.get('projectId') not in config.get('gitReturnProjects', [])
                or request.get('destinationRef') not in config.get('gitReturnRefs', {}).get(request.get('projectId'), [])):
            raise ValueError('RETURN_FORBIDDEN')
        spec = importlib.util.spec_from_file_location('return_helper', '/usr/local/lib/agent-control/remote_git_return.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.return_artifact(config, request)
    if action == 'git-export':
        # Only a fixed installed helper may implement this read-only action.
        spec = importlib.util.spec_from_file_location('remote_git', '/usr/local/lib/agent-control/remote_git.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.export(config, request)
    if action == 'cancel':
        if set(request) != {'schemaVersion', 'operationId', 'action', 'projectId', 'taskId', 'epoch'}:
            raise ValueError('INVALID_REQUEST')
        with open(root / (operation + '.admission.lock'), 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if not record.exists():
                return {'schemaVersion': 1, 'operationId': operation, 'state': 'unknown'}
            item = json.loads(record.read_text())
            if (item['projectId'] != request['projectId'] or item['taskId'] != request['taskId']
                    or type(request['epoch']) is not int or item['epoch'] != request['epoch']):
                raise ValueError('CANCELLATION_SCOPE_MISMATCH')
            if item['state'] in ('completed', 'failed', 'canceled_confirmed'):
                return item
            atomic(root / (operation + '.cancel.json'), {'operationId': operation, 'requestedAt': time.time()})
            item = remote_supervisor.recover(config, root, item, atomic) if (item.get('stableGroup') or item.get('groupIntent')) else observed(item)
            return {**item, 'cancellationRequested': True}
    if action == 'inspect':
        if set(request) != {'schemaVersion', 'operationId', 'action'}:
            raise ValueError('INVALID_REQUEST')
        if not record.exists():
            return {'schemaVersion': 1, 'operationId': operation, 'state': 'unknown'}
        item = json.loads(record.read_text())
        # Missing or reused identities are uncertainty, never proof of completion.
        return remote_supervisor.recover(config, root, item, atomic) if (item.get('stableGroup') or item.get('groupIntent')) else observed(item)
    if action != 'start' or set(request) != {'schemaVersion', 'operationId', 'action', 'projectId', 'taskId', 'root', 'epoch'}:
        raise ValueError('INVALID_REQUEST')
    project, task = request['projectId'], request['taskId']
    if project not in config['projects'] or task not in config['tasks']:
        raise ValueError('TASK_FORBIDDEN')
    directory = pathlib.Path(config['projects'][project]).resolve(strict=True)
    if str(directory) != request['root']:
        raise ValueError('PROJECT_ROOT_MISMATCH')
    if type(request['epoch']) is not int or request['epoch'] < 1:
        raise ValueError('INVALID_EPOCH')
    fingerprint = hashlib.sha256(json.dumps(request, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    # Every alias and controller using this state directory shares this lock.
    # Terminal journal replacement is atomic; uncertain and orphaned records keep
    # their slot. A malformed operation record fails closed.
    with open(root / '.global-admission.lock', 'a') as global_lock:
        fcntl.flock(global_lock, fcntl.LOCK_EX)
        with open(root / (operation + '.admission.lock'), 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if record.exists():
                prior = json.loads(record.read_text())
                if prior['requestDigest'] != fingerprint:
                    raise ValueError('OPERATION_ID_CONFLICT')
                return remote_supervisor.recover(config, root, prior, atomic) if (prior.get('stableGroup') or prior.get('groupIntent')) else observed(prior)
            maximum = config.get('maxConcurrent', 1)
            if type(maximum) is not int or not 1 <= maximum <= 32:
                raise ValueError('INVALID_CONCURRENCY_LIMIT')
            active = 0
            for candidate in root.glob('*.json'):
                try:
                    candidate_id = str(uuid.UUID(candidate.stem))
                except ValueError:
                    continue
                if candidate.name != candidate_id + '.json':
                    continue
                other = json.loads(candidate.read_text())
                if other['operationId'] != candidate_id:
                    raise ValueError('INVALID_OPERATION_JOURNAL')
                terminal = other['state'] in ('completed', 'failed', 'canceled_confirmed')
                checksum = other.get('logSha256')
                receipt = (type(other.get('exitCode')) is int and isinstance(checksum, str)
                           and len(checksum) == 64 and all(ch in '0123456789abcdef' for ch in checksum))
                if not terminal or not receipt:
                    active += 1
            if active >= maximum:
                raise ValueError('REMOTE_HOST_BUSY')
            item = {'schemaVersion': 1, 'operationId': operation, 'state': 'uncertain', 'projectId': project,
                    'taskId': task, 'root': str(directory), 'epoch': request['epoch'], 'requestDigest': fingerprint}
            # Persist before launching. A crash in this gap remains uncertain and is not blindly retried.
            atomic(record, item)
            subprocess.Popen([sys.executable, str(pathlib.Path(__file__).resolve()), '--config', config_path, '--execute', operation],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
                             env={'PATH': '/usr/local/bin:/usr/bin:/bin'})
            return item


def main():
    # The task must not start until the supervisor has durably recorded both
    # process identities. No command is retried when this handshake is lost.
    if len(sys.argv) > 2 and sys.argv[1] == '--gate':
        if sys.stdin.buffer.read(1) != b'1':
            raise SystemExit(125)
        os.execvpe(sys.argv[2], sys.argv[2:], os.environ)
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--execute')
    args = parser.parse_args()
    if args.execute:
        execute(args.config, str(uuid.UUID(args.execute)))
    else:
        try:
            print(json.dumps(rpc(args.config)))
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            print(json.dumps({'error': 'REMOTE_OPERATION_REFUSED'}))
            raise SystemExit(1)


if __name__ == '__main__':
    main()
