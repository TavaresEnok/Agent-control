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
const attributionFixture = 'atribuicao/repo';
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
  const result = await run('docker', [
    ...isolated,
    '--mount', `type=bind,src=${join(fixtures, fixture)},dst=/repo,readonly`, image,
  ], {timeout: 420_000, maxBuffer: 8 * 1024 * 1024}).then(
    ({stdout}) => ({stdout, code: 0}),
    (error: unknown) => {
      if (fixture === attributionFixture && error instanceof Error &&
        'code' in error && error.code === 1 && 'signal' in error && error.signal === null &&
        'killed' in error && error.killed === false && 'stdout' in error && typeof error.stdout === 'string') {
        return {stdout: error.stdout, code: error.code};
      }
      throw error;
    },
  );
  return parseCollectorOutput(fixture, result);
}

function parseCollectorOutput(fixture: string, {stdout, code}: {stdout: string; code: number}): Output {
  assert.equal(code, fixture === attributionFixture ? 1 : 0, `Código de saída de ${fixture}`);
  const report = JSON.parse(stdout) as Output;
  assert.deepEqual(Object.keys(report).sort(), ['coverage', 'findings']);
  for (const row of report.coverage) {
    assert.match(row.status, /^(ok|failed|skipped)$/);
    if (fixture !== attributionFixture) assert.notEqual(row.status, 'failed', `${row.tool}: ${row.detail}`);
  }
  if (fixture === attributionFixture) {
    const failed = report.coverage.filter(row => row.status === 'failed');
    assert.equal(failed.length, 3, JSON.stringify(failed));
    const summary = failed.filter(row => row.tool === 'lgpd-static');
    assert.equal(summary.length, 1, JSON.stringify(failed));
    assert.match(summary[0].detail, /^3 arquivos JS\/TS\/Python examinados, 2 com cobertura parcial\. /);
    for (const [file, calls] of [['operations.js', 2], ['operations.py', 1]] as const) {
      const rows = failed.filter(row => row.tool === 'lgpd-static:file' && row.detail.startsWith(`${file} | `));
      assert.equal(rows.length, 1, JSON.stringify(failed));
      assert.equal(rows[0].detail.match(/\. Cobertura parcial: .+$/)?.[0],
        `. Cobertura parcial: ${calls} resultados de chamadas sem vínculo estático.`, file);
    }
    assert.ok(report.coverage.some(row => row.tool === 'lgpd-static:file' && row.status === 'ok' &&
      row.detail.startsWith('writes.ts |')), 'writes.ts');
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

test('C9 aceita somente a cobertura parcial prevista para a fixture de atribuição', () => {
  const coverage: Output['coverage'] = [
    {tool: 'lgpd-static', version: '1', status: 'failed',
      detail: '3 arquivos JS/TS/Python examinados, 2 com cobertura parcial. AST: vínculos simples.'},
    {tool: 'lgpd-static:file', version: '1', status: 'failed',
      detail: 'operations.js | linhas com campos=13, indícios de destino=5. Cobertura parcial: 2 resultados de chamadas sem vínculo estático.'},
    {tool: 'lgpd-static:file', version: '1', status: 'failed',
      detail: 'operations.py | linhas com campos=8, indícios de destino=5. Cobertura parcial: 1 resultados de chamadas sem vínculo estático.'},
    {tool: 'lgpd-static:file', version: '1', status: 'ok',
      detail: 'writes.ts | linhas com campos=14, indícios de destino=6'},
  ];
  const report = {coverage, findings: []};
  const stdout = JSON.stringify(report);
  assert.deepEqual(parseCollectorOutput(attributionFixture, {stdout, code: 1}), report);
  assert.throws(() => parseCollectorOutput(attributionFixture, {stdout, code: 0}), /Código de saída/);
  assert.throws(() => parseCollectorOutput(attributionFixture, {stdout, code: 125}), /Código de saída/);
  assert.throws(() => parseCollectorOutput(attributionFixture, {stdout: 'inválido', code: 1}), SyntaxError);
  assert.throws(() => parseCollectorOutput(attributionFixture, {
    stdout: stdout.replace('operations.js', 'unexpected.js'), code: 1,
  }), assert.AssertionError);
  assert.throws(() => parseCollectorOutput(attributionFixture, {
    stdout: stdout.replace('2 resultados de chamadas sem vínculo estático.', '2 resultados de chamadas sem vínculo estático, 1 erro de leitura.'),
    code: 1,
  }), assert.AssertionError);
  assert.throws(() => parseCollectorOutput(attributionFixture, {
    stdout: JSON.stringify({...report, coverage: [...coverage,
      {tool: 'scancode-toolkit', version: '1', status: 'failed', detail: 'Falha sintética.'},
    ]}), code: 1,
  }), assert.AssertionError);
  for (const fixture of ['com-defeito', 'limpo']) {
    assert.throws(() => parseCollectorOutput(fixture, {stdout, code: 1}), /Código de saída/);
    assert.throws(() => parseCollectorOutput(fixture, {stdout, code: 0}), /lgpd-static/);
  }
});

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

test('laboratório C9 atribui apenas as chamadas e os valores armazenados da fixture R6', {skip: !enabled}, async () => {
  const image = (await readFile(new URL('digest.txt', root), 'utf8')).trim();
  assert.match(image, /^(?:[A-Za-z0-9._:/-]+@)?sha256:[a-f0-9]{64}$/);
  const report = await collect(image, attributionFixture);
  const expected = JSON.parse(await readFile(join(fixtures, 'atribuicao', 'expected.json'), 'utf8'));
  for (const [file, locations] of Object.entries(expected)) {
    const destinations = report.findings.filter(row => row.file === file && row.rule.startsWith('PII_POSSIBLE_'))
      .map(row => [row.rule.slice('PII_POSSIBLE_'.length), row.line, Number(row.evidence.match(/linha (\d+)\./)?.[1])]);
    assert.deepEqual(destinations, locations, file);
  }
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_|syntheticRow|logger\.info|INSERT INTO/);
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
