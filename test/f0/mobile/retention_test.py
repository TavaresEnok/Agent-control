"""Audit the retained browser bytes without launching a second browser run."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from urllib.parse import urlsplit
import zipfile

ROOT = Path(__file__).resolve().parents[3]
HERE = ROOT / 'tools/f0/mobile'
PACKAGE = ROOT / 'docs/validation/artifacts/mobile/2026-10-31T152834-181Z'
spec = importlib.util.spec_from_file_location('evidence', HERE / 'evidence.py')
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


class RetainedEvidenceTest(unittest.TestCase):
    def test_receipt_and_executed_source_hashes(self):
        with contextlib.redirect_stdout(io.StringIO()):
            evidence.verify(PACKAGE)
        report = json.loads((PACKAGE / 'report.json').read_text())
        self.assertEqual(report['command'], 'python3 tools/f0/mobile/run.py')
        for path, expected in report['sourceInputs'].items():
            self.assertEqual(hashlib.sha256((ROOT / path).read_bytes()).hexdigest(), expected, path)
        for path, expected in report['inputs'].items():
            file = ROOT / path if path.startswith('test/') else HERE / path
            self.assertEqual(hashlib.sha256(file.read_bytes()).hexdigest(), expected, path)

    def test_trace_is_local_synthetic_and_sanitized(self):
        requests = 0
        origin = urlsplit(json.loads((PACKAGE / 'report.json').read_text())['url'])
        with zipfile.ZipFile(PACKAGE / 'trace.zip') as trace:
            for name in trace.namelist():
                data = trace.read(name)
                self.assertNotIn(str(ROOT).encode(), data, name)
                if not name.endswith('.network'):
                    continue
                for line in data.splitlines():
                    event = json.loads(line)
                    request = event.get('snapshot', {}).get('request')
                    if request is None:
                        continue
                    requests += 1
                    target = urlsplit(request['url'])
                    self.assertIn(target.scheme, ['http', 'ws'])
                    self.assertEqual((target.hostname, target.port), (origin.hostname, origin.port))
                    headers = {header['name'].lower(): header['value'] for header in request['headers']}
                    for secret in ['authorization', 'cookie', 'x-csrf-token']:
                        self.assertFalse(headers.get(secret), secret)
        self.assertGreater(requests, 0)

    def test_manifest_rejects_changed_report(self):
        # A small isolated copy proves corruption is rejected, without touching the receipt.
        runtime = HERE / '.runtime'
        runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=runtime) as temporary:
            copy = Path(temporary) / 'receipt'
            shutil.copytree(PACKAGE, copy)
            report = json.loads((copy / 'report.json').read_text())
            report['tree'] = 'tampered'
            (copy / 'report.json').write_text(json.dumps(report))
            with self.assertRaisesRegex(AssertionError, 'hash mismatch: report.json'):
                evidence.verify(copy)


if __name__ == '__main__':
    unittest.main()
