"""Bounded artifact import. Atomic ref transaction is also the durable ACK journal.

Only explicitly configured bare repositories and branch refs are writable. Objects
are verified in isolation before import; no checkout, reset, shell or force push.
"""
import base64
import hashlib
import importlib.util
import json
import pathlib
import re
import tempfile
import uuid

_directory = pathlib.Path(__file__).parent
_export_helper = _directory / 'helper.py'
if not _export_helper.exists():
    _export_helper = _directory / 'remote_git.py'
_spec = importlib.util.spec_from_file_location('ac_git_export', _export_helper)
_helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_helper)
git = _helper.git
OID = _helper.OID
MAX_BUNDLE = _helper.MAX_BUNDLE


def run(root, args, data=None):
    import subprocess
    try:
        return git(root, args, input=data, capture_output=True).stdout.decode().strip()
    except subprocess.CalledProcessError as error:
        error.add_note((error.stderr or b'').decode(errors='replace')[:2048])
        raise


def return_artifact(config, request):
    keys = {'schemaVersion', 'action', 'operationId', 'projectId', 'artifactId', 'commit', 'tree',
            'bundleSha256', 'bundle', 'expectedCommit', 'destinationRef'}
    if set(request) != keys or request['schemaVersion'] != 1 or request['action'] != 'git-return':
        raise ValueError('INVALID_RETURN_REQUEST')
    operation = str(uuid.UUID(request['operationId']))
    if operation != request['operationId'] or str(uuid.UUID(request['artifactId'])) != request['artifactId']:
        raise ValueError('INVALID_RETURN_ID')
    project, ref = request['projectId'], request['destinationRef']
    if project not in config.get('gitReturnProjects', []) or ref not in config.get('gitReturnRefs', {}).get(project, []):
        raise ValueError('RETURN_DESTINATION_FORBIDDEN')
    if not isinstance(ref, str) or not re.fullmatch(r'refs/heads/[A-Za-z0-9][A-Za-z0-9/_-]*', ref):
        raise ValueError('INVALID_RETURN_REF')
    commit, tree, expected = (request[k] for k in ('commit', 'tree', 'expectedCommit'))
    if any(not isinstance(v, str) or not OID.fullmatch(v) for v in (commit, tree, expected)) or len({len(v) for v in (commit, tree, expected)}) != 1:
        raise ValueError('INVALID_RETURN_IDENTITY')
    root = pathlib.Path(config['projects'][project]).resolve(strict=True)
    if run(root, ['rev-parse', '--is-bare-repository']) != 'true':
        raise ValueError('RETURN_BARE_REPOSITORY_REQUIRED')
    bundle = base64.b64decode(request['bundle'], validate=True)
    if len(bundle) > MAX_BUNDLE or hashlib.sha256(bundle).hexdigest() != request['bundleSha256']:
        raise ValueError('RETURN_BUNDLE_MISMATCH')
    fingerprint = hashlib.sha256(json.dumps(request, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    marker = 'refs/agent-control/returns/' + operation
    # A marker and destination are committed in one Git ref transaction. A retry
    # returns the saved ACK even if a later authorized writer moved the branch.
    def prior():
        found = git(root, ['show-ref', '--verify', '--hash', marker], capture_output=True)  # raises if missing
        saved = json.loads(run(root, ['cat-file', 'blob', found.stdout.decode().strip()]))
        if saved['requestDigest'] != fingerprint:
            raise ValueError('RETURN_OPERATION_CONFLICT')
        return saved['receipt']
    if git_ref_exists(root, marker):
        return prior()
    with tempfile.TemporaryDirectory(prefix='ac-return-') as temporary:
        scratch = pathlib.Path(temporary)
        bare = scratch / 'verified.git'
        run(scratch, ['init', '--bare', *(['--object-format=sha256'] if len(commit) == 64 else []), str(bare)])
        file = scratch / 'input.bundle'
        file.write_bytes(bundle)
        header = bundle.split(b'\n\n', 1)[0].decode()
        advertised = [line for line in header.splitlines() if re.match(r'^[a-f0-9]+ ', line)]
        if advertised != [commit + ' refs/heads/agent-control-export'] or '\n-' in header:
            raise ValueError('RETURN_BUNDLE_IDENTITY_MISMATCH')
        run(bare, ['bundle', 'verify', str(file)])
        pack = bundle.split(b'\n\n', 1)[1]
        run(bare, ['unpack-objects', '--strict'], pack)
        if run(bare, ['rev-parse', commit + '^{commit}']) != commit or run(bare, ['rev-parse', commit + '^{tree}']) != tree:
            raise ValueError('RETURN_TREE_MISMATCH')
        run(bare, ['merge-base', '--is-ancestor', expected, commit])
        # rev-list verifies full reachable connectivity without fsck's optional
        # child validators (UID-wide RLIMIT_NPROC can already be exhausted).
        run(bare, ['rev-list', '--objects', '--missing=error', commit])
        # Unreachable imported objects are harmless on a failed CAS. No branch
        # has changed at this point. Git's own locks arbitrate external writers.
        run(root, ['unpack-objects'], pack)
    receipt = {'schemaVersion': 1, 'state': 'returned', 'operationId': operation, 'projectId': project,
               'artifactId': request['artifactId'], 'commit': commit, 'tree': tree,
               'expectedCommit': expected, 'destinationRef': ref, 'bundleSha256': request['bundleSha256']}
    blob = run(root, ['hash-object', '-w', '--stdin'], json.dumps({'requestDigest': fingerprint, 'receipt': receipt}, sort_keys=True).encode())
    transaction = f'start\nupdate {ref} {commit} {expected}\ncreate {marker} {blob}\nprepare\ncommit\n'
    try:
        run(root, ['update-ref', '--stdin'], transaction.encode())
    except Exception:
        # Another identical delivery may have won the transaction. A different
        # operation cannot adopt its result or override a concurrent branch.
        if git_ref_exists(root, marker):
            return prior()
        raise ValueError('RETURN_DESTINATION_CONFLICT')
    return receipt


def git_ref_exists(root, ref):
    # show-ref --exists is unavailable in older Git; rev-parse is read-only.
    import subprocess
    try:
        run(root, ['show-ref', '--verify', '--hash', ref])
        return True
    except subprocess.CalledProcessError:
        return False
