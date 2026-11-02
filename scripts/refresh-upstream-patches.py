#!/usr/bin/env python3
"""Rebuild upstream patches with a temporary index; never change upstream refs/indexes."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parent.parent
base = Path(sys.argv[1] if len(sys.argv) > 1 else '/home/app/projects/agent-control-evaluation-v3/candidates').resolve()
changes = json.loads((root / 'upstream/CHANGES.json').read_text())
provenance_path = root / 'upstream/PROVENANCE.json'
provenance = json.loads(provenance_path.read_text())
for name in ('cezar', 'happier'):
    repository = base / name
    commit = subprocess.check_output(['git', '-C', str(repository), 'rev-parse', 'HEAD'], text=True).strip()
    if commit != provenance[name]['commit']:
        raise RuntimeError('UPSTREAM_REFERENCE_MISMATCH: ' + name)
    paths = [change['path'] for change in changes[name]]
    for path in paths:
        parts = PurePosixPath(path)
        if parts.is_absolute() or '..' in parts.parts or any(part in ('.git', '.state', 'node_modules', 'dist', '__pycache__') for part in parts.parts):
            raise RuntimeError('UNSAFE_PATCH_PATH')
    with tempfile.TemporaryDirectory(prefix='ac-patch-index-') as temporary:
        env = {**os.environ, 'GIT_INDEX_FILE': str(Path(temporary) / 'index'), 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1'}
        command = ['git', '-C', str(repository), '--work-tree=' + str(root / 'upstream' / name)]
        subprocess.check_call(command + ['read-tree', commit], env=env)
        if paths:
            subprocess.check_call(command + ['add', '-f', '-A', '--', *paths], env=env)
        patch = subprocess.check_output(command + ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', commit, '--'], env=env)
    target = root / 'upstream/patches' / (name + '-complete.patch')
    target.write_bytes(patch)
    provenance[name]['patch_sha256'] = hashlib.sha256(patch).hexdigest()
provenance_path.write_text(json.dumps(provenance, indent=2) + '\n')
print(json.dumps({'state': 'upstream_patches_refreshed', 'refsChanged': False, 'upstreams': ['cezar', 'happier']}))
