"""Fixed Git workspace preparation and exact post-execution snapshot.

The source is always read-only. A worker may mount only the returned repo,
never its parent containing the authority manifest. No untracked file is added.
"""
import fcntl
import base64
import hashlib
import importlib.util
import json
import os
import pathlib
import stat
import uuid

_directory = pathlib.Path(__file__).parent
_export = _directory / 'helper.py'
if not _export.exists():
    _export = _directory / 'remote_git.py'
_spec = importlib.util.spec_from_file_location('ac_workspace_export', _export)
_helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_helper)


def run(root, args, data=None):
    result = _helper.git(root, ['-c', 'core.hooksPath=/dev/null', *args], input=data, capture_output=True, text=data is None).stdout
    return (result.decode() if isinstance(result, bytes) else result).strip()


def secure(path):
    path = pathlib.Path(path)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or path.resolve(strict=True) != path:
        raise ValueError('WORKSPACE_DIRECTORY_UNSAFE')
    return path


def identity(path):
    info = path.stat()
    return {'dev': info.st_dev, 'ino': info.st_ino}


def uuid_value(value):
    parsed = str(uuid.UUID(value))
    if value != parsed:
        raise ValueError('INVALID_WORKSPACE_ID')
    return parsed


def project_root(config, project):
    if project not in config.get('gitWorkspaceProjects', []):
        raise ValueError('WORKSPACE_PROJECT_FORBIDDEN')
    return pathlib.Path(config['projects'][project]).resolve(strict=True)


def atomic(path, value):
    temporary = path.with_suffix('.pending')
    with open(temporary, 'x') as out:
        os.chmod(temporary, 0o600)
        json.dump(value, out, sort_keys=True)
        out.flush()
        os.fsync(out.fileno())
    os.rename(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def workspace_directory(config, workspace_id, project):
    workspace_id = uuid_value(workspace_id)
    source = project_root(config, project)
    root = secure(config['gitWorkspaceRoot'])
    directory = secure(root / workspace_id)
    manifest = directory / 'manifest.json'
    info = manifest.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('WORKSPACE_MANIFEST_UNSAFE')
    value = json.loads(manifest.read_text())
    repo = secure(directory / 'repo')
    git_directory = secure(repo / '.git')
    if value['projectId'] != project or value['operationId'] != workspace_id or value['source'] != str(source) or value['sourceIdentity'] != identity(source) or value['repoIdentity'] != identity(repo) or value['gitIdentity'] != identity(git_directory):
        raise ValueError('WORKSPACE_IDENTITY_MISMATCH')
    return repo


def prepare(config, request):
    if set(request) != {'schemaVersion', 'action', 'operationId', 'projectId', 'commit', 'tree'} or request['schemaVersion'] != 1 or request['action'] != 'git-workspace-prepare':
        raise ValueError('INVALID_WORKSPACE_REQUEST')
    operation = uuid_value(request['operationId'])
    project = request['projectId']
    source = project_root(config, project)
    commit, tree = request['commit'], request['tree']
    if not all(isinstance(v, str) and _helper.OID.fullmatch(v) for v in (commit, tree)) or len(commit) != len(tree):
        raise ValueError('INVALID_WORKSPACE_IDENTITY')
    root = secure(config['gitWorkspaceRoot'])
    directory = root / operation
    fingerprint = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
    fd = os.open(root / (operation + '.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if directory.exists():
            repo = workspace_directory(config, operation, project)
            saved = json.loads((directory / 'manifest.json').read_text())
            if saved['requestDigest'] != fingerprint:
                raise ValueError('WORKSPACE_OPERATION_CONFLICT')
            return saved['receipt']
        if run(source, ['rev-parse', commit + '^{tree}']) != tree or run(source, ['rev-parse', commit + '^{commit}']) != commit:
            raise ValueError('WORKSPACE_SOURCE_MISMATCH')
        directory.mkdir(mode=0o700)
        # An interrupted preparation stays uncertain, never silently deleted.
        atomic(directory / 'request.json', {'requestDigest': fingerprint, 'request': request})
        repo = directory / 'repo'
        # Copy only the approved commit graph. Builtin Git calls avoid clone's
        # upload-pack subprocess under an already exhausted UID NPROC budget.
        exported = _helper.export({'projects': {project: str(source)}, 'gitExportProjects': [project]}, request | {'action': 'git-export'})
        bundle = base64.b64decode(exported['bundle'], validate=True)
        run(root, ['init', *(['--object-format=sha256'] if len(commit) == 64 else []), str(repo)])
        run(repo, ['unpack-objects', '--strict'], bundle.split(b'\n\n', 1)[1])
        run(repo, ['update-ref', 'refs/heads/agent-control-workspace', commit])
        os.chmod(repo, 0o700)
        os.chmod(repo / '.git', 0o700)
        run(repo, ['checkout', '--detach', commit])
        if run(repo, ['rev-parse', 'HEAD']) != commit or run(repo, ['rev-parse', 'HEAD^{tree}']) != tree or run(repo, ['status', '--porcelain']):
            raise ValueError('WORKSPACE_SOURCE_MISMATCH')
        receipt = {'schemaVersion': 1, 'operationId': operation, 'projectId': project, 'state': 'prepared', 'commit': commit, 'tree': tree, 'repository': str(repo)}
        atomic(directory / 'manifest.json', {'operationId': operation, 'projectId': project, 'requestDigest': fingerprint, 'source': str(source),
               'sourceIdentity': identity(source), 'repoIdentity': identity(repo), 'gitIdentity': identity(repo / '.git'), 'receipt': receipt})
        return receipt


def claim_execution(config, workspace_id, project, execution_operation_id):
    """A workspace permits one immutable writer for its entire lifetime."""
    if config.get('executionBackend') != 'docker':
        raise ValueError('WORKSPACE_DOCKER_ISOLATION_REQUIRED')
    workspace_id = uuid_value(workspace_id)
    execution_operation_id = uuid_value(execution_operation_id)
    repo = workspace_directory(config, workspace_id, project)
    root = secure(config['gitWorkspaceRoot'])
    fd = os.open(root / (workspace_id + '.lock'), os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(fd, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = repo.parent / 'execution.json'
        expected = {'workspaceId': workspace_id, 'projectId': project, 'executionOperationId': execution_operation_id}
        if path.exists():
            if path.is_symlink() or json.loads(path.read_text()) != expected:
                raise ValueError('WORKSPACE_WRITER_ALREADY_BOUND')
            return False
        manifest = json.loads((repo.parent / 'manifest.json').read_text())
        if run(repo, ['rev-parse', 'HEAD']) != manifest['receipt']['commit'] or run(repo, ['status', '--porcelain']):
            raise ValueError('WORKSPACE_INITIAL_STATE_CHANGED')
        atomic(path, expected)
        return True


def snapshot(config, request):
    if set(request) != {'schemaVersion', 'action', 'operationId', 'projectId', 'executionOperationId'} or request['schemaVersion'] != 1 or request['action'] != 'git-workspace-snapshot':
        raise ValueError('INVALID_WORKSPACE_SNAPSHOT')
    workspace_id = uuid_value(request['operationId'])
    execution = uuid_value(request['executionOperationId'])
    project = request['projectId']
    repo = workspace_directory(config, workspace_id, project)
    binding = json.loads((repo.parent / 'execution.json').read_text())
    if binding != {'workspaceId': workspace_id, 'projectId': project, 'executionOperationId': execution}:
        raise ValueError('WORKSPACE_EXECUTION_UNPROVEN')
    journal = pathlib.Path(config['stateDirectory']) / (execution + '.json')
    if journal.is_symlink():
        raise ValueError('WORKSPACE_EXECUTION_UNPROVEN')
    value = json.loads(journal.read_text())
    if value.get('operationId') != execution or value.get('workspaceId') != workspace_id or value.get('projectId') != project or value.get('root') != str(repo) or value.get('state') != 'completed' or value.get('exitCode') != 0 or value.get('groupRemovalConfirmed') is not True or not isinstance(value.get('logSha256'), str) or len(value['logSha256']) != 64:
        raise ValueError('WORKSPACE_EXECUTION_UNPROVEN')
    # No second writer can ever claim this workspace. Removal-confirmed means
    # the Docker execution group is absent before reading/finalizing its HEAD.
    root = secure(config['gitWorkspaceRoot'])
    fd = os.open(root / (workspace_id + '.lock'), os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(fd, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        manifest = json.loads((repo.parent / 'manifest.json').read_text())
        sealed_path = repo.parent / 'snapshot.json'
        if sealed_path.exists():
            if sealed_path.is_symlink():
                raise ValueError('WORKSPACE_SNAPSHOT_UNSAFE')
            sealed = json.loads(sealed_path.read_text())
            if sealed['executionOperationId'] != execution:
                raise ValueError('WORKSPACE_SNAPSHOT_CONFLICT')
            commit, tree = sealed['commit'], sealed['tree']
        else:
            # Only committed tracked changes are output. Untracked files stay
            # private; the adapter never adds them or sends their bytes.
            if run(repo, ['diff', '--name-only', 'HEAD']) or run(repo, ['diff', '--cached', '--name-only']):
                raise ValueError('WORKSPACE_UNCOMMITTED_CHANGES')
            commit = run(repo, ['rev-parse', 'HEAD'])
            tree = run(repo, ['rev-parse', 'HEAD^{tree}'])
            run(repo, ['merge-base', '--is-ancestor', manifest['receipt']['commit'], commit])
            sealed = {'executionOperationId': execution, 'commit': commit, 'tree': tree, 'base': manifest['receipt']['commit']}
            atomic(sealed_path, sealed)
        exported = _helper.export({'projects': {project: str(repo)}, 'gitExportProjects': [project]},
                                 {'schemaVersion': 1, 'action': 'git-export', 'operationId': workspace_id, 'projectId': project, 'commit': commit, 'tree': tree})
        return {**exported, 'workspaceId': workspace_id, 'executionOperationId': execution, 'base': sealed['base'], 'reviewStatus': 'not_reviewed'}
