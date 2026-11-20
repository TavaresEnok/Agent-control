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
const manifestStaticFiles = ['src/telemetry.ts', 'vendor/widget.js'];
const npmLicenseSkipDetail = 'Lockfiles npm v2/v3 classificados: 0; erros: 0. Licenças ausentes permanecem desconhecidas.';
const isolated = [
  'run', '--pull=never', '--rm', '--network', 'none', '--read-only',
  '--user', '65532:65532', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--pids-limit', '256', '--memory', '2g', '--memory-swap', '2g', '--cpus', '2',
  '--tmpfs', '/tmp:rw,exec,nosuid,nodev,mode=1777,size=512m',
];

type Output = {
  coverage: {tool: string; version: string; status: string; detail: string; files?: string[]}[];
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
  const attribution = fixture === attributionFixture;
  assert.equal(code, attribution ? 1 : 0, `Código de saída de ${fixture}`);
  const report = JSON.parse(stdout) as Output;
  assert.deepEqual(Object.keys(report).sort(), ['coverage', 'findings']);
  const expectedCoverage: [tool: string, status: string, skipDetail?: string][] = [
    ['conformidade:snapshot', 'ok'],
    ['scancode-toolkit', 'ok'],
    ['presidio-analyzer', 'ok'],
    attribution ? ['npm-license-policy', 'skipped', npmLicenseSkipDetail] :
      ['npm-license-policy', 'ok'],
    attribution ? ['ort', 'skipped', 'Nenhuma declaração SPDX elegível em lockfile npm.'] : ['ort', 'ok'],
    ...(!attribution ? [['lgpd-static', 'ok'] as [string, string]] : []),
  ];
  for (const [tool, status, skipDetail] of expectedCoverage) {
    const rows = report.coverage.filter(row => row.tool === tool);
    assert.equal(rows.length, 1, `Cobertura agregada de ${tool} em ${fixture}`);
    const [row] = rows;
    assert.equal(row.status, status, `Estado de ${tool} em ${fixture}: ${row.detail}`);
    if (skipDetail !== undefined) assert.equal(row.detail, skipDetail, `Motivo do salto de ${tool} em ${fixture}`);
  }
  for (const row of report.coverage) {
    assert.match(row.status, /^(ok|failed|skipped)$/);
    if (!attribution) assert.notEqual(row.status, 'failed', `${row.tool}: ${row.detail}`);
  }
  const fileRows = report.coverage.filter(row => row.tool === 'lgpd-static:file');
  const expectedFiles = attribution ? ['operations.js', 'operations.py', 'writes.ts'] :
    ['package-lock.json', 'package.json', ...manifestStaticFiles];
  assert.deepEqual(fileRows.map(row => row.detail.split(' | ')[0]).sort(), [...expectedFiles].sort(),
    `Arquivos estáticos em ${fixture}`);
  for (const row of fileRows) {
    assert.equal(Object.hasOwn(row, 'files'), false, `files inesperado em ${row.detail}`);
  }
  if (!attribution) {
    assert.deepEqual(report.coverage.find(row => row.tool === 'lgpd-static')?.files, manifestStaticFiles);
    const destinations = report.findings.filter(row => row.rule.startsWith('PII_POSSIBLE_'))
      .map(row => [row.rule, row.file, row.line]);
    assert.deepEqual(destinations, fixture === 'com-defeito' ?
      [['PII_POSSIBLE_LOG', 'src/telemetry.ts', 3]] : [], `Destinos em ${fixture}`);
  }
  if (attribution) {
    const staticRows = report.coverage.filter(row => row.tool === 'lgpd-static');
    assert.equal(staticRows.length, 3, 'Grupos de cobertura lgpd-static');
    const expectedGroups = [
      {status: 'failed', detail: '3 arquivos JS/TS/Python examinados, 2 com cobertura parcial. AST: vínculos simples, sem fluxo entre funções, análise de ramos ou chaves dinâmicas. SQL: parâmetros vinculados a valores de INSERT/UPDATE literal no recorte. Outras extensões de código/config: inventário textual de campos.', files: undefined},
      {status: 'ok', detail: 'Análise estática AST e inventário textual concluídos sem lacunas em 1 arquivo(s).', files: ['writes.ts']},
      {status: 'ok', detail: 'Evidências locais (vínculos AST comprovados ou inventário textual de campos) confirmadas em 2 arquivo(s) com escopo parcial; trechos sem vínculo ou sem parser permanecem em falha ou pulados.', files: ['operations.js', 'operations.py']},
    ];
    for (const group of expectedGroups) {
      const matches = staticRows.filter(row => row.detail === group.detail);
      assert.equal(matches.length, 1, `Grupo lgpd-static: ${group.detail}`);
      assert.equal(matches[0].version, '1');
      assert.equal(matches[0].status, group.status);
      assert.deepEqual(matches[0].files, group.files);
    }
    for (const file of ['operations.js', 'operations.py']) {
      assert.ok(report.findings.some(row => row.tool === 'lgpd-static' && row.file === file),
        `Evidência local sem achado estático em ${file}`);
    }
    const failed = report.coverage.filter(row => row.status === 'failed');
    assert.equal(failed.length, 3, JSON.stringify(failed));
    assert.equal(report.coverage.filter(row => row.tool === 'lgpd-static:file').length, 3);
    for (const [file, fields, destinations, calls] of [['operations.js', 13, 5, 2], ['operations.py', 8, 5, 1], ['writes.ts', 14, 6, 0]] as const) {
      const rows = report.coverage.filter(row => row.tool === 'lgpd-static:file' && row.detail.startsWith(`${file} | `));
      assert.equal(rows.length, 1, `Cobertura estática de ${file}`);
      const [row] = rows;
      assert.equal(row.version, '1', file);
      assert.equal(row.status, calls ? 'failed' : 'ok', file);
      assert.equal(row.detail, `${file} | linhas com campos=${fields}, indícios de destino=${destinations}` +
        (calls ? `. Cobertura parcial: ${calls} resultados de chamadas sem vínculo estático.` : ''), file);
    }
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
  const aggregate: Output['coverage'] = [
    {tool: 'conformidade:snapshot', version: '1', status: 'ok', detail: '3 arquivos copiados.'},
    {tool: 'scancode-toolkit', version: '1', status: 'ok', detail: '3/3 registros de arquivo.'},
    {tool: 'presidio-analyzer', version: '1', status: 'ok', detail: '3/3 textos examinados.'},
    {tool: 'npm-license-policy', version: '1', status: 'skipped',
      detail: npmLicenseSkipDetail},
    {tool: 'ort', version: '1', status: 'skipped', detail: 'Nenhuma declaração SPDX elegível em lockfile npm.'},
  ];
  const coverage: Output['coverage'] = [
    ...aggregate,
    {tool: 'lgpd-static', version: '1', status: 'failed', detail: '3 arquivos JS/TS/Python examinados, 2 com cobertura parcial. AST: vínculos simples, sem fluxo entre funções, análise de ramos ou chaves dinâmicas. SQL: parâmetros vinculados a valores de INSERT/UPDATE literal no recorte. Outras extensões de código/config: inventário textual de campos.'},
    {tool: 'lgpd-static', version: '1', status: 'ok', detail: 'Análise estática AST e inventário textual concluídos sem lacunas em 1 arquivo(s).', files: ['writes.ts']},
    {tool: 'lgpd-static', version: '1', status: 'ok', detail: 'Evidências locais (vínculos AST comprovados ou inventário textual de campos) confirmadas em 2 arquivo(s) com escopo parcial; trechos sem vínculo ou sem parser permanecem em falha ou pulados.', files: ['operations.js', 'operations.py']},
    {tool: 'lgpd-static:file', version: '1', status: 'failed',
      detail: 'operations.js | linhas com campos=13, indícios de destino=5. Cobertura parcial: 2 resultados de chamadas sem vínculo estático.'},
    {tool: 'lgpd-static:file', version: '1', status: 'failed',
      detail: 'operations.py | linhas com campos=8, indícios de destino=5. Cobertura parcial: 1 resultados de chamadas sem vínculo estático.'},
    {tool: 'lgpd-static:file', version: '1', status: 'ok',
      detail: 'writes.ts | linhas com campos=14, indícios de destino=6'},
  ];
  const findings: Output['findings'] = ['operations.js', 'operations.py'].map(file => ({
    tool: 'lgpd-static', rule: 'PII_FIELD', file, line: 1, severity: 'informativa',
    message: 'Referência sintética.', evidence: 'Campo sintético.',
  }));
  const report = {coverage, findings};
  const stdout = JSON.stringify(report);
  assert.deepEqual(parseCollectorOutput(attributionFixture, {stdout, code: 1}), report);
  assert.throws(() => parseCollectorOutput(attributionFixture, {stdout, code: 0}), /Código de saída/);
  assert.throws(() => parseCollectorOutput(attributionFixture, {stdout, code: 125}), /Código de saída/);
  assert.throws(() => parseCollectorOutput(attributionFixture, {stdout: 'inválido', code: 1}), SyntaxError);
  const checkCoverage = (rows: Output['coverage']) => parseCollectorOutput(attributionFixture, {
    stdout: JSON.stringify({coverage: rows, findings}), code: 1,
  });
  for (const finding of findings) {
    for (const replacement of [undefined, {...finding, tool: 'presidio-analyzer'}]) {
      const altered = findings.filter(row => row !== finding);
      if (replacement) altered.push(replacement);
      assert.throws(() => parseCollectorOutput(attributionFixture, {
        stdout: JSON.stringify({coverage, findings: altered}), code: 1,
      }), /Evidência local sem achado estático/);
    }
  }
  const groups = coverage.filter(row => row.tool === 'lgpd-static');
  for (const group of groups) {
    assert.throws(() => checkCoverage(coverage.filter(row => row !== group)), assert.AssertionError);
    assert.throws(() => checkCoverage([...coverage, group]), assert.AssertionError);
    assert.throws(() => checkCoverage(coverage.map(row => row === group ? {...row, status: row.status === 'ok' ? 'failed' : 'ok'} : row)), assert.AssertionError);
  }
  for (const [group, files] of [[groups[0], ['writes.ts']], [groups[1], ['operations.js']],
    [groups[1], ['writes.ts', 'operations.js']], [groups[2], ['operations.js', 'writes.ts']],
    [groups[2], ['operations.js']], [groups[2], undefined]] as const) {
    assert.throws(() => checkCoverage(coverage.map(row => row === group ? {...row, files: files && [...files]} : row)), assert.AssertionError);
  }
  for (const row of coverage.filter(row => row.tool === 'lgpd-static:file')) {
    assert.throws(() => checkCoverage(coverage.map(item => item === row ? {...item, files: ['operations.js']} : item)), assert.AssertionError);
    assert.throws(() => checkCoverage(coverage.filter(item => item !== row)), assert.AssertionError);
    assert.throws(() => checkCoverage([...coverage, row]), assert.AssertionError);
    assert.throws(() => checkCoverage(coverage.map(item => item === row ? {...item, status: row.status === 'ok' ? 'failed' : 'ok'} : item)), assert.AssertionError);
  }
  for (const entry of aggregate) {
    const otherRows = coverage.filter(row => row.tool !== entry.tool);
    const countError = new RegExp(`Cobertura agregada de ${entry.tool} em ${attributionFixture}`);
    assert.throws(() => checkCoverage(otherRows), countError);
    assert.throws(() => checkCoverage([...coverage, entry]), countError);
    const status = entry.status === 'skipped' ? 'ok' : 'skipped';
    assert.throws(() => checkCoverage([...otherRows, {...entry, status}]),
      new RegExp(`Estado de ${entry.tool} em ${attributionFixture}`));
    if (entry.status === 'skipped') {
      assert.throws(() => checkCoverage([...otherRows, {...entry, detail: 'Limite sintético atingido.'}]),
        new RegExp(`Motivo do salto de ${entry.tool} em ${attributionFixture}`));
    }
  }
  assert.throws(() => parseCollectorOutput(attributionFixture, {
    stdout: stdout.replace(npmLicenseSkipDetail, `${npmLicenseSkipDetail} Limite sintético atingido.`), code: 1,
  }), /Motivo do salto de npm-license-policy em atribuicao\/repo/);
  assert.throws(() => parseCollectorOutput(attributionFixture, {
    stdout: stdout.replace('operations.js', 'unexpected.js'), code: 1,
  }), assert.AssertionError);
  assert.throws(() => parseCollectorOutput(attributionFixture, {
    stdout: stdout.replace('2 resultados de chamadas sem vínculo estático.', '2 resultados de chamadas sem vínculo estático, 1 erro de leitura.'),
    code: 1,
  }), assert.AssertionError);
  assert.throws(() => parseCollectorOutput(attributionFixture, {
    stdout: JSON.stringify({...report, coverage: [...coverage,
      {tool: 'scancode-toolkit:file', version: '1', status: 'failed', detail: 'Falha sintética.'},
    ]}), code: 1,
  }), assert.AssertionError);
});

test('C9 exige cobertura agregada ok para todas as ferramentas nas fixtures com manifesto', () => {
  for (const fixture of ['com-defeito', 'limpo']) {
    const coverage: Output['coverage'] = [
      'conformidade:snapshot', 'scancode-toolkit', 'presidio-analyzer', 'npm-license-policy', 'ort', 'lgpd-static',
    ].map(tool => ({tool, version: '1', status: 'ok', detail: 'Cobertura sintética.',
      ...(tool === 'lgpd-static' ? {files: ['src/telemetry.ts', 'vendor/widget.js']} : {})}));
    coverage.push(...['package-lock.json', 'package.json', 'src/telemetry.ts', 'vendor/widget.js'].map(file => ({
      tool: 'lgpd-static:file', version: '1', status: 'ok', detail: `${file} | sintético`,
    })));
    const findings: Output['findings'] = fixture === 'com-defeito' ? [{
      tool: 'lgpd-static', rule: 'PII_POSSIBLE_LOG', file: 'src/telemetry.ts', line: 3,
      severity: 'media', message: 'Destino sintético.', evidence: 'Origem sintética.',
    }] : [];
    const report = {coverage, findings};
    const stdout = JSON.stringify(report);
    assert.deepEqual(parseCollectorOutput(fixture, {stdout, code: 0}), report);
    assert.throws(() => parseCollectorOutput(fixture, {stdout, code: 1}), /Código de saída/);
    const checkCoverage = (rows: Output['coverage']) => parseCollectorOutput(fixture, {
      stdout: JSON.stringify({coverage: rows, findings}), code: 0,
    });
    const staticAggregate = coverage.find(row => row.tool === 'lgpd-static')!;
    for (const files of [['inexistente.ts'], ['src/telemetry.ts'], ['src/telemetry.ts', 'inexistente.ts'], undefined]) {
      assert.throws(() => checkCoverage(coverage.map(row => row === staticAggregate ? {...row, files} : row)), assert.AssertionError);
    }
    for (const row of coverage.filter(item => item.tool === 'lgpd-static:file')) {
      assert.throws(() => checkCoverage(coverage.map(item => item === row ? {...item, files: ['inexistente.ts']} : item)), assert.AssertionError);
    }
    if (fixture === 'com-defeito') {
      assert.throws(() => parseCollectorOutput(fixture, {
        stdout: JSON.stringify({coverage, findings: [...findings, {...findings[0], line: 1}]}), code: 0,
      }), /Destinos em com-defeito/);
    }
    for (const entry of coverage.filter(row => !row.tool.endsWith(':file'))) {
      const otherRows = coverage.filter(row => row !== entry);
      const countError = new RegExp(`Cobertura agregada de ${entry.tool} em ${fixture}`);
      assert.throws(() => checkCoverage(otherRows), countError);
      assert.throws(() => checkCoverage([...coverage, entry]), countError);
      assert.throws(() => checkCoverage([...otherRows, {...entry, status: 'skipped'}]),
        new RegExp(`Estado de ${entry.tool} em ${fixture}`));
    }
  }
});

test('laboratório C9 detecta licença forte e CPF plantados e verifica o controle limpo', {skip: !enabled}, async () => {
  const image = (await readFile(new URL('digest.txt', root), 'utf8')).trim();
  assert.match(image, /^(?:[A-Za-z0-9._:/-]+@)?sha256:[a-f0-9]{64}$/);
  const pin = JSON.parse(await readFile(new URL('tools.lock.json', root), 'utf8'));
  for (const fixture of ['com-defeito', 'limpo']) {
    const report = await collect(image, fixture);
    const dirty = fixture === 'com-defeito';
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
  assert.ok(report.findings.filter(row => row.rule.startsWith('PII_POSSIBLE_'))
    .every(row => Object.hasOwn(expected, row.file)), 'Destino atribuído a arquivo inesperado');
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
