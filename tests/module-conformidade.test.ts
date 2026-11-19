import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const moduleDir = fileURLToPath(new URL('../deploy/modules/conformidade/', import.meta.url));
const fixtures = fileURLToPath(new URL('./fixtures/module-conformidade/', import.meta.url));

function python(code: string) {
  return execFileSync('python3', ['-B', '-c', code, fixtures], {
    cwd: moduleDir,
    encoding: 'utf8',
  });
}

test('C9 fixa a base, os wheels e o lock que a imagem instala', () => {
  const lock = JSON.parse(readFileSync(join(moduleDir, 'tools.lock.json'), 'utf8'));
  const dockerfile = readFileSync(join(moduleDir, 'Dockerfile'), 'utf8');
  const requirements = readFileSync(join(moduleDir, 'requirements.lock'), 'utf8');
  assert.match(lock.baseImage.platformDigest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(dockerfile.includes('python@' + lock.baseImage.platformDigest));
  assert.ok(dockerfile.includes('eclipse-temurin@' + lock.jreImage.platformDigest));
  for (const aptPackage of lock.aptPackages) assert.ok(dockerfile.includes(aptPackage.sha256));
  assert.ok(dockerfile.includes('--no-deps --require-hashes --only-binary=:all:'));
  assert.equal(createHash('sha256').update(requirements).digest('hex'), lock.requirementsLockSha256);
  for (const tool of lock.tools) {
    assert.match(tool.sha256, /^[a-f0-9]{64}$/);
    if (tool.name === 'ort') {
      assert.ok(dockerfile.includes(`--checksum=sha256:${tool.sha256} ${tool.url}`));
    } else {
      assert.ok(requirements.split('\n').some(line =>
        line.includes(tool.version) && line.includes('--hash=sha256:' + tool.sha256)));
    }
  }
});

test('C9 valida dígitos de CPF e indica destino local sem copiar a linha ou os valores', () => {
  const result = JSON.parse(python(String.raw`
from pathlib import Path
import json, re, sys
from collector import Report
from lgpd_analyzer import CPF_PATTERN, inspect_fields, valid_cpf
assert valid_cpf("123.456.789-09")
assert valid_cpf("12345678909")
assert not valid_cpf("123.456.789-08")
assert not valid_cpf("111.111.111-11")
assert re.search(CPF_PATTERN, " CPF: 123.456.789-09\n")
assert not re.search(CPF_PATTERN, "ticket123456789090")
assert not re.search(CPF_PATTERN, "123.456.789-090")
reports = []
for scenario in ("com-defeito", "limpo"):
    original = Path(sys.argv[1], scenario, "src", "telemetry.ts").read_text()
    report = Report()
    inspect_fields(original, "src/telemetry.ts", report)
    reports.append(report.output())
print(json.dumps(reports))
`));
  const [dirty, clean] = result;
  assert.ok(dirty.findings.some((row: {rule: string; line: number}) =>
    row.rule === 'PII_POSSIBLE_LOG' && row.line === 3));
  assert.deepEqual(clean.findings, []);
  assert.doesNotMatch(JSON.stringify(result), /123\.456\.789|console\.log/);
});

test('C9 mantém locais do ScanCode, sinaliza erros parciais e limita o relatório', () => {
  const result = JSON.parse(python(String.raw`
import json
from collector import Report, add_scancode_results, MAX_FINDINGS, MAX_COVERAGE
report = Report()
data = {
    "headers": [{"errors": []}],
    "files": [
        {"type": "directory", "path": ""},
        {"type": "file", "path": "vendor/widget.js", "license_detections": [
            {"license_expression_spdx": "GPL-3.0-only", "matches": [{"start_line": 2}, {"start_line": 2}]},
        ]},
        {"type": "file", "path": "broken.js", "scan_errors": ["untrusted-content"]},
    ],
}
assert add_scancode_results(data, {"vendor/widget.js": "", "broken.js": "", "missing.ts": ""}, "32.5.0", report) == (2, True)
sample = report.output()
assert report.has_errors
limited = Report()
for n in range(MAX_COVERAGE + 5):
    limited.cover("test", "1", "ok", "synthetic")
for n in range(MAX_FINDINGS + 1):
    limited.find("test", "R", "test.ts", 1, "informativa", "m", "e")
limited.find("test", "PRIORITY", "test.ts", 1, "media", "m", "e")
output = limited.output()
assert limited.has_errors
assert len(output["coverage"]) == 5000
assert len(output["findings"]) == 999
assert output["findings"][0]["rule"] == "PRIORITY"
assert output["coverage"][-1]["status"] == "failed"
print(json.dumps(sample))
`));
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].line, 2);
  assert.match(result.findings[0].evidence, /GPL-3\.0-only/);
  assert.ok(result.coverage.some((row: {status: string; detail: string}) =>
    row.status === 'skipped' && row.detail.startsWith('missing.ts')));
  assert.doesNotMatch(JSON.stringify(result), /untrusted-content/);
});

test('C9 devolve JSON e código de falha quando o repositório não pode ser aberto', () => {
  const run = spawnSync('python3', ['-B', 'collector.py', '--repo', join(fixtures, 'sintetico-inexistente')], {
    cwd: moduleDir,
    env: {...process.env, TMPDIR: moduleDir},
    encoding: 'utf8',
  });
  assert.equal(run.status, 1, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.ok(result.coverage.some((row: {tool: string; status: string}) =>
    row.tool === 'conformidade' && row.status === 'failed'));
  assert.deepEqual(result.findings, []);
});

test('C9 entrega ao ORT apenas SPDX gerado e mede os pacotes devolvidos pelo analisador', () => {
  const result = JSON.parse(python(String.raw`
from pathlib import Path
import json
from tempfile import TemporaryDirectory
from unittest.mock import patch
from collector import Report
from ort_inventory import read_results, write_documents
report = Report()
locks = [("package-lock.json", [("node_modules/fixture-widget", "GPL-3.0-only", 7)])]
with TemporaryDirectory(dir=Path.cwd()) as scratch:
    picked = write_documents(locks, Path(scratch), "97.2.0", report)
    document = json.loads((Path(scratch) / "lock-1.spdx.json").read_text())
    assert document["documentDescribes"] == ["SPDXRef-lock-1"]
    assert document["relationships"][0]["relatedSpdxElement"] == "SPDXRef-component-1-1"
    assert document["packages"][1]["licenseDeclared"] == "GPL-3.0-only"
    assert document["packages"][1]["downloadLocation"] == "NOASSERTION"
    assert "fixture-widget" not in json.dumps(document)
    mock_result = {"packages": [{
        "id": "SpdxDocumentFile::component-1-1:1",
        "declared_licenses_processed": {"spdx_expression": "GPL-3.0-only"},
    }]}
    with patch("ort_inventory.classify", return_value=("copyleft forte", "GPL-3.0-only")):
        assert read_results(mock_result, picked, "97.2.0", report) == (1, 1)
    missing = Report()
    assert read_results({"packages": []}, picked, "97.2.0", missing) == (0, 0)
    assert missing.has_errors
print(json.dumps(report.output()))
`));
  assert.equal(result.coverage[0].status, 'ok');
  assert.equal(result.findings[0].rule, 'ORT_STRONG_COPYLEFT_DECLARED');
  assert.equal(result.findings[0].line, 7);
});

test('C9 inventaria o lockfile npm, mede ausências e preserva a diferença do controle limpo', () => {
  const result = JSON.parse(python(String.raw`
from pathlib import Path
from unittest.mock import patch
import json, sys
from collector import Report
from license_policy import inspect_lock
categories = {"MIT": "permissiva", "GPL-3.0-only": "copyleft forte"}
reports = []
for scenario in ("com-defeito", "limpo"):
    source = Path(sys.argv[1], scenario, "package-lock.json").read_text()
    report = Report()
    with patch("license_policy.classify", side_effect=lambda value: (categories[value], value)):
        declarations = inspect_lock(source, "MIT", "package-lock.json", report)
        assert len(declarations) == 1
        assert declarations[0][0] == "node_modules/fixture-widget"
        assert declarations[0][2] == 7
    reports.append(report.output())
print(json.dumps(reports))
`));
  assert.ok(result[0].findings.some((row: {rule: string}) => row.rule === 'LICENSE_OBLIGATION_REVIEW'));
  assert.deepEqual(result[1].findings.map((row: {rule: string}) => row.rule), ['LICENSE_DEPENDENCY_DECLARED']);
});

test('C9 copia apenas entradas regulares elegíveis para o recorte de análise', () => {
  const result = JSON.parse(python(String.raw`
from pathlib import Path
from tempfile import TemporaryDirectory
import json
from collector import Report, snapshot

with TemporaryDirectory(dir=Path.cwd()) as scratch:
    root = Path(scratch, "repo")
    staging = Path(scratch, "staging")
    root.mkdir()
    staging.mkdir()
    (root / "source.ts").write_text("const fixture = true;")
    (root / ".env.synthetic").write_text("outside-scope")
    outside = Path(scratch, "outside.txt")
    outside.write_text("synthetic-outside")
    (root / "redirect.ts").symlink_to(outside)
    (root / "redirect-dir").symlink_to(Path(scratch))
    report = Report()
    picked = snapshot(root, staging, report)
    assert list(picked) == ["source.ts"]
    assert picked["source.ts"].read_text() == "const fixture = true;"
    assert len(list(staging.iterdir())) == 1
print(json.dumps(report.output()))
`));
  assert.ok(result.coverage.some((row: {status: string; detail: string}) =>
    row.status === 'skipped' && row.detail.startsWith('redirect.ts')));
  assert.doesNotMatch(JSON.stringify(result), /synthetic-outside/);
});
