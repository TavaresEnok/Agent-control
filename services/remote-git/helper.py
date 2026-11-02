"""Read-only, bounded export of one configured repository commit over SSH."""
import base64
import hashlib
import os
import pathlib
import re
import resource
import signal
import subprocess
import tempfile

MAX_BUNDLE = 65536
OID = re.compile(r'(?:[0-9a-f]{40}|[0-9a-f]{64})\Z')
ENV = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'LC_ALL': 'C',
       'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
       'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_TERMINAL_PROMPT': '0'}


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
    child = subprocess.Popen(['/usr/bin/git', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', str(root), *args], env=ENV,
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
