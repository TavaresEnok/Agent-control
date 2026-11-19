import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const run = promisify(execFile);
const enabled = process.env.AC_MODULE_LAB === '1';
const root = new URL('../deploy/modules/conformidade/', import.meta.url);
const fixtures = fileURLToPath(new URL('./fixtures/module-conformidade/', import.meta.url));
const isolated = [
  'run', '--pull=never', '--rm', '--network', 'none', '--read-only',
  '--user', '65532:65532', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--pids-limit', '256', '--memory', '2g', '--memory-swap', '2g', '--cpus', '2',
  '--tmpfs', '/tmp:rw,exec,nosuid,nodev,mode=1777,size=512m',
];

type Output = {
  coverage: {tool: string; version: string; status: string; detail: string}[];
  findings: {tool: string; rule: string; file: string; line: number; severity: string; message: string; evidence: string}[];
};

async function collect(image: string, fixture: string): Promise<Output> {
  const {stdout} = await run('docker', [
    ...isolated,
    '--mount', `type=bind,src=${join(fixtures, fixture)},dst=/repo,readonly`, image,
  ], {timeout: 420_000, maxBuffer: 8 * 1024 * 1024});
  const report = JSON.parse(stdout) as Output;
  assert.deepEqual(Object.keys(report).sort(), ['coverage', 'findings']);
  for (const row of report.coverage) {
    assert.match(row.status, /^(ok|failed|skipped)$/);
    assert.notEqual(row.status, 'failed', `${row.tool}: ${row.detail}`);
  }
  for (const row of report.findings) {
    assert.match(row.file, /^[A-Za-z0-9._@+/\-]+$/);
    assert.ok(!row.file.split('/').some(part => part === '' || part === '..'));
    assert.ok(Number.isInteger(row.line) && row.line >= 1);
    assert.match(row.severity, /^(alta|media|baixa|informativa)$/);
  }
  assert.doesNotMatch(stdout, /123\.456\.789-09|12345678909/);
  return report;
}

test('laboratório C9 detecta licença forte e CPF plantados e verifica o controle limpo', {skip: !enabled}, async () => {
  const image = (await readFile(new URL('digest.txt', root), 'utf8')).trim();
  assert.match(image, /^(?:[A-Za-z0-9._:/-]+@)?sha256:[a-f0-9]{64}$/);
  const pin = JSON.parse(await readFile(new URL('tools.lock.json', root), 'utf8'));
  for (const fixture of ['com-defeito', 'limpo']) {
    const report = await collect(image, fixture);
    const dirty = fixture === 'com-defeito';
    for (const name of ['scancode-toolkit', 'presidio-analyzer', 'npm-license-policy', 'lgpd-static', 'ort']) {
      assert.equal(report.coverage.find(row => row.tool === name)?.status, 'ok', name);
    }
    for (const name of ['scancode-toolkit', 'presidio-analyzer']) {
      assert.equal(report.coverage.find(row => row.tool === name)?.version,
        pin.tools.find((tool: {name: string}) => tool.name === name).version);
      assert.ok(report.coverage.some(row => row.tool === name + ':file' &&
        row.status === 'ok' && row.detail.startsWith('src/telemetry.ts |')));
    }
    assert.equal(report.coverage.find(row => row.tool === 'ort')?.version,
      pin.tools.find((tool: {name: string}) => tool.name === 'ort').version);
    assert.ok(report.coverage.some(row => row.tool === 'ort:file' && row.status === 'ok' &&
      row.detail.startsWith('package-lock.json | 1/1')));
    assert.equal(report.findings.some(row => row.tool === 'ort' && row.rule === 'ORT_STRONG_COPYLEFT_DECLARED' &&
      row.file === 'package-lock.json' && row.line === 7 && row.evidence.includes('GPL-3.0-only')), dirty);
    assert.ok(report.findings.some(row => row.tool === 'scancode-toolkit' && row.rule === 'LICENSE_DETECTED' &&
      row.file === 'vendor/widget.js' && row.line === 1 && row.evidence.includes(dirty ? 'GPL-3.0-only' : 'MIT')));
    assert.equal(report.findings.some(row => row.rule === 'LICENSE_OBLIGATION_REVIEW' &&
      row.file === 'package-lock.json' && row.line === 7 && row.evidence.includes('GPL-3.0-only')), dirty);
    assert.equal(report.findings.some(row => row.rule === 'PII_BR_CPF' &&
      row.file === 'src/telemetry.ts' && row.line === 1), dirty);
    assert.equal(report.findings.some(row => row.rule === 'PII_POSSIBLE_LOG' &&
      row.file === 'src/telemetry.ts' && row.line === 3), dirty);
    if (!dirty) {
      assert.ok(report.findings.every(row =>
        !['LICENSE_OBLIGATION_REVIEW', 'PII_BR_CPF', 'PII_POSSIBLE_LOG'].includes(row.rule)));
    }
  }
});

test('laboratório C9 carrega o índice empacotado do ScanCode com HOME sem escrita', {skip: !enabled}, async () => {
  const image = (await readFile(new URL('digest.txt', root), 'utf8')).trim();
  assert.match(image, /^(?:[A-Za-z0-9._:/-]+@)?sha256:[a-f0-9]{64}$/);
  const {stdout} = await run('docker', [
    ...isolated, '--entrypoint', '/usr/bin/env', image,
    '-i', 'PATH=/opt/conformidade/venv/bin:/usr/bin:/bin', 'HOME=/tmp/c9-cache-home', 'TMPDIR=/tmp',
    '/opt/conformidade/venv/bin/python3', '-B', '-c', String.raw`
import os
import sys
from importlib.metadata import version
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

home = Path.home()
general = home / ".cache" / "scancode-tk" / version("scancode-toolkit")
general.mkdir(parents=True)
for directory in (general, *home.rglob("*"), home):
    directory.chmod(0o555)
assert os.geteuid() == 65532
assert not os.access(home, os.W_OK)
assert not os.access(general, os.W_OK)

from licensedcode import cache
from licensedcode.index import LicenseIndex
from scancode_config import licensedcode_cache_dir, scancode_cache_dir

assert Path(scancode_cache_dir) == general
packed = Path(licensedcode_cache_dir) / cache.LICENSE_INDEX_DIR / cache.LICENSE_INDEX_FILENAME
assert packed.resolve().is_relative_to(Path(sys.prefix).resolve())
assert packed.stat().st_size > 0 and not os.access(packed, os.W_OK)
with patch.object(cache, "load_cache_file", wraps=cache.load_cache_file) as load:
    with patch.object(cache, "build_index", side_effect=AssertionError("reconstrução inesperada")):
        assert isinstance(cache.get_index(), LicenseIndex)
    load.assert_called_once_with(str(packed))
assert all(path.is_dir() for path in home.rglob("*"))

class CacheMiss(Exception):
    pass

with TemporaryDirectory() as empty, patch("scancode.lockfile.FileLock", side_effect=CacheMiss) as lock:
    try:
        cache.LicenseCache.load_or_build(licensedcode_cache_dir=empty, scancode_cache_dir=empty)
    except CacheMiss:
        lock.assert_called_once()
    else:
        raise AssertionError("cache vazio deveria seguir para reconstrução")
print("cache ScanCode carregado")
`,
  ], {timeout: 60_000});
  assert.equal(stdout.trim(), 'cache ScanCode carregado');
});
