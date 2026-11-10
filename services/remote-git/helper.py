"""Read-only, bounded export of one configured repository commit over SSH."""
import base64
import contextlib
import hashlib
import os
import pathlib
import re
import resource
import shutil
import signal
import stat
import subprocess
import tempfile

MAX_BUNDLE = 65536
OID = re.compile(r'(?:[0-9a-f]{40}|[0-9a-f]{64})\Z')
ENV = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'LC_ALL': 'C',
       'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
       'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_TERMINAL_PROMPT': '0'}


@contextlib.contextmanager
def isolated_git(root):
    """Run Git on a worker-written repository without reading its .git/config.

    Local config can name programs (core.fsmonitor, filter.*), so only object
    storage, refs, HEAD and the index are carried into a private GIT_DIR.
    """
    source = pathlib.Path(root) / '.git'
    info = os.lstat(source)
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError('WORKSPACE_GIT_UNSAFE')
    for name in ('objects', 'refs'):
        if not stat.S_ISDIR(os.lstat(source / name).st_mode):
            raise ValueError('WORKSPACE_GIT_UNSAFE')
    if os.path.lexists(source / 'commondir') or os.path.lexists(source / 'objects' / 'info' / 'alternates'):
        raise ValueError('WORKSPACE_GIT_UNSAFE')
    config_path = source / 'config'
    if not stat.S_ISREG(os.lstat(config_path).st_mode) or os.lstat(config_path).st_size > 65536:
        raise ValueError('WORKSPACE_GIT_UNSAFE')
    config = config_path.read_text(errors='replace').lower()
    sha256 = re.search(r'objectformat\s*=\s*sha256', config) is not None
    def identity():
        # Detect (not prevent) a worker swapping a checked path for a link or another inode while Git runs.
        out = []
        for name in ('', 'objects', 'refs', 'config'):
            try:
                item = os.lstat(source / name) if name else os.lstat(source)
            except FileNotFoundError:
                out.append(None)
                continue
            out.append((item.st_dev, item.st_ino, stat.S_IFMT(item.st_mode)))
        if os.path.lexists(source / 'commondir') or os.path.lexists(source / 'objects' / 'info' / 'alternates'):
            out.append('links')
        return out
    before = identity()
    with tempfile.TemporaryDirectory(prefix='ac-git-') as private:
        target = pathlib.Path(private)
        (target / 'config').write_text('[core]\n\trepositoryformatversion = 1\n\tbare = false\n[extensions]\n\tobjectformat = sha256\n' if sha256 else '[core]\n\trepositoryformatversion = 0\n\tbare = false\n')
        (target / 'objects').symlink_to(source / 'objects')
        (target / 'refs').symlink_to(source / 'refs')
        for name in ('HEAD', 'index', 'packed-refs', 'shallow'):
            if os.path.lexists(source / name):
                if not stat.S_ISREG(os.lstat(source / name).st_mode) or os.lstat(source / name).st_size > 64 * 1024 * 1024:
                    raise ValueError('WORKSPACE_GIT_UNSAFE')
                shutil.copyfile(source / name, target / name, follow_symlinks=False)
        previous = {key: ENV.get(key) for key in ('GIT_DIR', 'GIT_WORK_TREE')}
        ENV.update(GIT_DIR=str(target), GIT_WORK_TREE=str(root))
        try:
            yield
            if identity() != before:
                raise ValueError('WORKSPACE_GIT_UNSAFE')
        finally:
            for key, value in previous.items():
                if value is None:
                    ENV.pop(key, None)
                else:
                    ENV[key] = value


def git(root, args, **kwargs):
    def limits():
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
        resource.setrlimit(resource.RLIMIT_CPU, (8, 8))
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_BUNDLE, MAX_BUNDLE))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_NPROC, (1024, 1024))
    value = kwargs.pop('input', None)
    capture = kwargs.pop('capture_output', False)
    text = kwargs.pop('text', False)
    if capture:
        kwargs.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    child = subprocess.Popen(['/usr/bin/git', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'pack.threads=1', '-c', 'pack.windowMemory=16m', '-C', str(root), *args], env=ENV,
                             start_new_session=True, preexec_fn=limits,
                             stdin=subprocess.PIPE if value is not None else subprocess.DEVNULL,
                             text=text, **kwargs)
    try:
        stdout, stderr = child.communicate(input=value, timeout=15)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.communicate()
        raise
    if child.returncode:
        raise subprocess.CalledProcessError(child.returncode, child.args, stdout, stderr)
    return subprocess.CompletedProcess(child.args, child.returncode, stdout, stderr)


def export(config, request):
    if set(request) != {'schemaVersion', 'action', 'operationId', 'projectId', 'commit', 'tree'}:
        raise ValueError('INVALID_GIT_REQUEST')
    commit, tree = request['commit'], request['tree']
    if not isinstance(commit, str) or not isinstance(tree, str) or not OID.fullmatch(commit) or not OID.fullmatch(tree) or len(commit) != len(tree):
        raise ValueError('INVALID_GIT_IDENTITY')
    project = request['projectId']
    if project not in config['projects'] or project not in config.get('gitExportProjects', []):
        raise ValueError('PROJECT_FORBIDDEN')
    root = pathlib.Path(config['projects'][project]).resolve(strict=True)
    actual = git(root, ['rev-parse', '--verify', commit + '^{commit}'], capture_output=True, text=True).stdout.strip()
    actual_tree = git(root, ['rev-parse', '--verify', commit + '^{tree}'], capture_output=True, text=True).stdout.strip()
    if actual != commit or actual_tree != tree:
        raise ValueError('GIT_IDENTITY_MISMATCH')
    # A self-contained pack contains only objects reachable from the selected
    # commit. The bundle header names one private ref; no remote ref is changed.
    with tempfile.TemporaryFile() as out:
        header = (('# v3 git bundle\n@object-format=sha256\n' if len(commit) == 64 else '# v2 git bundle\n')
                  + commit + ' refs/heads/agent-control-export\n\n').encode()
        out.write(header)
        out.flush()
        git(root, ['pack-objects', '--stdout', '--revs'], input=(commit + '\n').encode(),
            stdout=out, stderr=subprocess.DEVNULL)
        size = out.tell()
        if size > MAX_BUNDLE:
            raise ValueError('BUNDLE_TOO_LARGE')
        out.seek(0)
        bundle = out.read(MAX_BUNDLE + 1)
    return {'schemaVersion': 1, 'operationId': request['operationId'], 'projectId': project,
            'commit': commit, 'tree': tree, 'bundleSha256': hashlib.sha256(bundle).hexdigest(),
            'bundle': base64.b64encode(bundle).decode('ascii')}
