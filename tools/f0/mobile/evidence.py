"""Seal a synthetic mobile receipt in a Git-visible directory before teardown.

Only the explicit report, trace and screenshots are exported, never runtime/env.
Run `verify PACKAGE` again after checkout or worktree cleanup.
"""
import hashlib
import io
import json
from pathlib import Path
import sys
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
DEST = ROOT / 'docs/validation/artifacts/mobile'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def inspect(package):
    report = json.loads((package / 'report.json').read_text())
    names = ['report.json'] + [item['name'] for item in report['screenshots']]
    if (package / 'trace.zip').exists():
        names.append('trace.zip')
        with zipfile.ZipFile(package / 'trace.zip') as trace:
            assert trace.testzip() is None, 'corrupt trace'
            assert any(name.endswith('.trace') for name in trace.namelist()), 'missing trace events'
    for item in report['screenshots']:
        assert Path(item['name']).name == item['name'], 'unsafe screenshot path'
        data = (package / item['name']).read_bytes()
        assert data.startswith(b'\x89PNG\r\n\x1a\n'), 'invalid PNG'
        assert sha(data) == item['sha256'], 'screenshot hash mismatch'
    if report['status'] == 'completed':
        assert report['exitCode'] == 0 and report['errors'] == []
        assert report['sourceModuleCount'] == len(report['sourceInputs']) == 19
        assert len(report['checks']) == 4
        assert all(item['result'].startswith('PASS (partial') for item in report['checks'])
        assert [item['viewport'] for item in report['layout']] == [390, 360]
        assert all(not item['overflow'] and item['documentWidth'] <= item['viewport'] for item in report['layout'])
        assert len(report['screenshots']) == 4 and 'trace.zip' in names
    return names


def verify(package):
    names = inspect(package)
    manifest = json.loads((package / 'manifest-sha256.json').read_text())
    assert set(manifest) == set(names), 'manifest file list mismatch'
    for name in names:
        assert sha((package / name).read_bytes()) == manifest[name], f'hash mismatch: {name}'
    print(json.dumps({'verified': package.relative_to(ROOT).as_posix(), 'sha256': manifest}, indent=2))


def export(source):
    report = json.loads((source / 'report.json').read_text())
    stamp = report['startedAt'].replace(':', '').replace('.', '-')
    package = DEST / stamp
    package.mkdir(parents=True, exist_ok=False)
    names = ['report.json'] + [item['name'] for item in report['screenshots']]
    if (source / 'trace.zip').exists():
        names.append('trace.zip')

    def sanitize(data):
        return data.replace(str(ROOT).encode(), b'/worktree')

    for name in names:
        assert Path(name).name == name, 'unsafe evidence path'
        data = (source / name).read_bytes()
        if name == 'trace.zip':
            output = io.BytesIO()
            with zipfile.ZipFile(io.BytesIO(data)) as original, zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as sealed:
                for entry in original.infolist():
                    payload = original.read(entry)
                    try:
                        payload.decode('utf-8')
                    except UnicodeDecodeError:
                        pass
                    else:
                        payload = sanitize(payload)
                    sealed.writestr(entry, payload)
            data = output.getvalue()
        elif name == 'report.json':
            data = sanitize(data)
        (package / name).write_bytes(data)
    manifest = {name: sha((package / name).read_bytes()) for name in names}
    (package / 'manifest-sha256.json').write_text(json.dumps(manifest, indent=2) + '\n')
    verify(package)


if __name__ == '__main__':
    action, location = sys.argv[1:]
    if action == 'export':
        export(Path(location).resolve())
    elif action == 'verify':
        verify(Path(location).resolve())
    else:
        raise SystemExit('use export SOURCE or verify PACKAGE')
