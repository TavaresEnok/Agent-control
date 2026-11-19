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
  const {runtime, compiler} = lock.javascriptParser;
  for (const component of [runtime, compiler]) {
    assert.match(component.sha256, /^[a-f0-9]{64}$/);
    assert.ok(dockerfile.includes('--checksum=sha256:' + component.sha256 + ' ' + component.url));
  }
  const npmLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const parserPackage = npmLock.packages['deploy/modules/conformidade/node_modules/typescript'];
  assert.equal(parserPackage.version, compiler.version);
  assert.equal(parserPackage.integrity, compiler.integrity);
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

test('C9 mantém a versão de pluggy compatível com os hooks de classe do plugincode', () => {
  const requirements = readFileSync(join(moduleDir, 'requirements.lock'), 'utf8');
  assert.match(requirements, /^plugincode==32\.0\.0 --hash=sha256:344bb9943fcf4d6d05669c3c61efd4093fffa6a290fba7c5c11db15f2b51305e$/m);
  assert.match(requirements, /^pluggy==1\.6\.0 --hash=sha256:e920276dd6813095e9377c0bc5566d94c932c33b27a3e3945d8389c374dd4746$/m);
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

test('C9 relaciona campos e destinos em linhas distintas por argumentos e variáveis locais', () => {
  const cases = JSON.parse(python(String.raw`
import json
from collector import Report
from lgpd_analyzer import inspect_fields

sources = {
    "binding": """const body = JSON.stringify({ cpf: cliente.cpf, marker: "SYNTHETIC_VALUE" })
fetch(url, { method: "POST", body })""",
    "inline": """fetch(
    url,
    { body: JSON.stringify({cpf: cliente.cpf}) },
)""",
    "alias": """const body = JSON.stringify({ cpf: cliente.cpf })
const payload = body;
axios.post(url, payload);""",
    "unrelated": """const body = JSON.stringify({ cpf: cliente.cpf })
fetch(url, { body: fixture.body })""",
    "reassigned": """let body = JSON.stringify({ cpf: cliente.cpf })
body = "SYNTHETIC_VALUE"
fetch(url, { body })""",
    "different_scope": """{
  const body = JSON.stringify({ cpf: cliente.cpf })
}
fetch(url, { body })""",
    "literal": """const body = "fake cpf SYNTHETIC_VALUE"
fetch(url, { body })""",
}
reports = {}
for name, source in sources.items():
    report = Report()
    inspect_fields(source, "sample.ts", report)
    reports[name] = report.output()
print(json.dumps(reports))
`));
  for (const [name, line, source] of [
    ['binding', 2, 1], ['inline', 1, 3], ['alias', 3, 1],
  ] as const) {
    const findings = cases[name].findings.filter((row: {rule: string}) => row.rule === 'PII_POSSIBLE_NETWORK');
    assert.equal(findings.length, 1, name);
    assert.equal(findings[0].line, line, name);
    assert.ok(findings[0].evidence.includes(`linha ${source}.`), name);
  }
  for (const name of ['unrelated', 'reassigned', 'different_scope', 'literal']) {
    assert.ok(cases[name].findings.every((row: {rule: string}) => row.rule !== 'PII_POSSIBLE_NETWORK'), name);
    assert.ok(cases[name].findings.some((row: {rule: string}) => row.rule === 'PII_FIELD'), name);
  }
  assert.doesNotMatch(JSON.stringify(cases), /SYNTHETIC_VALUE|cliente\.cpf|JSON\.stringify|axios\.post/);
});

test('C9 distingue tipos, interpolações executáveis e texto estático em JavaScript e TypeScript', () => {
  const cases = JSON.parse(python(String.raw`
import json
from collector import Report
from lgpd_analyzer import inspect_fields

typed = """const payload: Record<string, { cpf?: string }> = { cpf: request.cpf };
fetch(url, payload);
const neutral: { cpf?: string; tag?: string } = { tag: "SYNTHETIC_VALUE" };
fetch(url, neutral);
const alias:
    string = payload.cpf;
logger.info(alias);"""
templates = r"""const alias = request.email;
const message = ~literal cpf SYNTHETIC_VALUE #{~nested #{alias}~}~;
logger.info(message);
logger.debug(~live #{request.cpf}~);
logger.log(~escaped cpf \#{request.cpf} SYNTHETIC_VALUE~);
logger.log("example cpf SYNTHETIC_VALUE");
// logger.log(request.cpf, "SYNTHETIC_VALUE");
logger.log(ready ? "cpf" : "SYNTHETIC_VALUE");
fetch(url, {"cpf": candidate});
logger.log(~first line
#{({item: alias}).item}
last line~);
localStorage.setItem("key", ~#{ready ? alias : "public"}~);
fetch(url, {alias: "SYNTHETIC_VALUE"});
fetch(url, {...alias});
const example = 'logger.warn(request.cpf, "SYNTHETIC_VALUE")';
/* logger.warn(request.cpf, "SYNTHETIC_VALUE"); */""".replace("~", chr(96)).replace("#{", chr(36) + "{")

reports = []
for source, file in ((typed, "sample.ts"), (templates, "sample.js")):
    report = Report()
    inspect_fields(source, file, report)
    reports.append(report.output())
print(json.dumps(reports))
`));
  const destinations = (report: {findings: {rule: string; line: number; evidence: string}[]}) =>
    report.findings.filter(row => row.rule.startsWith('PII_POSSIBLE_')).map(row =>
      [row.rule, row.line, row.evidence.match(/linha (\d+)/)?.[1]]);
  assert.deepEqual(destinations(cases[0]), [
    ['PII_POSSIBLE_NETWORK', 2, '1'], ['PII_POSSIBLE_LOG', 7, '1'],
  ]);
  assert.deepEqual(destinations(cases[1]), [
    ['PII_POSSIBLE_LOG', 3, '1'], ['PII_POSSIBLE_LOG', 4, '4'],
    ['PII_POSSIBLE_NETWORK', 9, '9'], ['PII_POSSIBLE_LOG', 10, '1'],
    ['PII_POSSIBLE_STORAGE', 13, '1'], ['PII_POSSIBLE_NETWORK', 15, '1'],
  ]);
  assert.ok(cases.every((row: {coverage: {status: string}[]}) => row.coverage[0].status === 'ok'));
  assert.doesNotMatch(JSON.stringify(cases), /SYNTHETIC_VALUE|request\.(cpf|email)|logger\.log/);
});

test('C9 lê blocos ascendentes e reatribui a variável visível respeitando o sombreamento', () => {
  const report = JSON.parse(python(String.raw`
import json
from collector import Report
from lgpd_analyzer import inspect_fields

source = """let payload = request.cpf;
{
  { fetch(url, {body: payload}); }
  payload = "SYNTHETIC_VALUE";
}
fetch(url, payload);
{ payload = request.email; }
fetch(url, payload);
{
  fetch(url, payload);
  let payload: string;
  fetch(url, payload);
  { payload = request.phone; }
  fetch(url, payload);
  payload = "SYNTHETIC_VALUE";
  fetch(url, payload);
}
other. /* synthetic member assignment */ payload = "SYNTHETIC_VALUE";
fetch(url, payload);"""
report = Report()
inspect_fields(source, "sample.ts", report)
print(json.dumps(report.output()))
`));
  const flows = report.findings.filter((row: {rule: string}) => row.rule === 'PII_POSSIBLE_NETWORK');
  assert.deepEqual(flows.map((row: {line: number; evidence: string}) =>
    [row.line, row.evidence.match(/linha (\d+)/)?.[1]]), [[3, '1'], [8, '7'], [14, '13'], [19, '7']]);
  assert.equal(report.coverage[0].status, 'ok');
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_VALUE|request\.(cpf|email|phone)/);
});

test('C9 conserva origens nas uniões multilinha, nos declaradores e nas interpolações com regex', () => {
  python(String.raw`
import json
import re
from collector import Report
from lgpd_analyzer import inspect_fields

typed = """const payload: | string
    | number = syntheticRow.cpf;
{
    fetch(url, payload);
    const tag = [1, 2].join(","),
          payload: string |
              number = "SYNTHETIC_MARKER",
          copy = payload;
    fetch(url, copy);
}
fetch(url, payload);
let neutral: string, first = syntheticRow.email
    , second = first;
logger.info(second);
logger.info(neutral);"""
lexical = r"""const payload = syntheticRow.email;
logger.info(~#{/[}]/.test("}") ? payload : "SYNTHETIC_MARKER"}~);
logger.info(~#{/[\]}/]/.test("}") ? syntheticRow["cpf"] : "public"}~);
logger.info(syntheticRow?.[/* synthetic */ 'cpf']);
logger.info(["cpf"], "syntheticRow.cpf");
logger.info("syntheticRow['cpf']");
logger.info(/logger.info(syntheticRow.cpf)/);
// logger.info(syntheticRow["cpf"]);
/* db.query("INSERT INTO synthetic (cpf) VALUES (?)", [syntheticRow.cpf]); */
logger.info(~escaped \#{syntheticRow.cpf} and logger.info(syntheticRow.cpf)~);
logger.info(6 / 2, syntheticRow[dynamicKey]);""".replace("~", chr(96)).replace("#{", chr(36) + "{")

for text, file, expected in (
    (typed, "synthetic.ts", [("NETWORK", 11, 2), ("LOG", 14, 12)]),
    (lexical, "synthetic.js", [("LOG", 2, 1), ("LOG", 3, 3), ("LOG", 4, 4)]),
):
    report = Report()
    inspect_fields(text, file, report)
    output = report.output()
    locations = [(row["rule"].removeprefix("PII_POSSIBLE_"), row["line"],
                  int(re.search(r"linha (\d+)\.", row["evidence"])[1]))
                 for row in output["findings"] if row["rule"].startswith("PII_POSSIBLE_")]
    assert locations == expected, locations
    assert output["coverage"][0]["status"] == "failed", output["coverage"]
    assert "resultados de chamadas sem vínculo estático" in output["coverage"][0]["detail"]
    assert not re.search(r"SYNTHETIC_MARKER|syntheticRow|logger\.info", json.dumps(output))
`);
});

test('C9 reconhece parâmetros de escrita SQL e mantém exemplos, colunas e leituras sem aviso de destino', () => {
  python(String.raw`
import json
import re
from collector import Report
from lgpd_analyzer import inspect_fields

text = """const payload = syntheticRow['cpf'];
db.query(
    "INSERT INTO synthetic (cpf) VALUES (?)",
    [payload],
);
pool.execute(~UPDATE synthetic SET email = ?~, [syntheticRow.email]);
db.query("INSERT INTO synthetic (cpf) VALUES (?)", [syntheticRow.cpf]);
db.query("INSERT INTO synthetic (cpf) VALUES (?)", ["SYNTHETIC_MARKER", "cpf"]);
db.query("UPDATE synthetic SET cpf = 'SYNTHETIC_MARKER'");
db.query("SELECT cpf FROM synthetic WHERE cpf = ?", [syntheticRow.cpf]);
db.query("SELECT 'example INSERT INTO synthetic (cpf) VALUES (?)'", [syntheticRow.cpf]);
logger.info("db.query('INSERT INTO synthetic (cpf) VALUES (?)', [syntheticRow.cpf])");
/* db.query("INSERT INTO synthetic (cpf) VALUES (?)", [syntheticRow.cpf]); */
db.query("SELECT 'INSERT INTO synthetic' FROM synthetic", [payload]);
db.query("INSERT INTO synthetic (cpf) VALUES (?)", ["SYNTHETIC_MARKER"], () => syntheticRow.cpf);""".replace("~", chr(96))
report = Report()
inspect_fields(text, "synthetic.ts", report)
result = report.output()
locations = [(row["rule"], row["line"], int(re.search(r"linha (\d+)\.", row["evidence"])[1]))
             for row in result["findings"] if row["rule"].startswith("PII_POSSIBLE_")]
assert locations == [("PII_POSSIBLE_STORAGE", 2, 1),
                     ("PII_POSSIBLE_STORAGE", 6, 6),
                     ("PII_POSSIBLE_STORAGE", 7, 7)], locations
assert result["coverage"][0]["status"] == "ok", result["coverage"]
assert not re.search(r"SYNTHETIC_MARKER|syntheticRow|INSERT INTO|UPDATE synthetic", json.dumps(result))
`);
});

test('C9 atribui destinos da fixture R6 e preserva os controles negativos em JS, TS e Python', () => {
  python(String.raw`
from pathlib import Path
import json
import re
import sys
from collector import Report, inspect_privacy
from unittest.mock import Mock, patch

root = Path(sys.argv[1], "atribuicao")
expected = json.loads((root / "expected.json").read_text())
selected = {name: root / "repo" / name for name in expected}
recognizer = Mock()
recognizer.analyze.return_value = []
report = Report()
with patch("lgpd_analyzer.create_presidio", return_value=recognizer):
    inspect_privacy(selected, "2.2.366", report)
output = report.output()
coverage = {row["detail"].split(" | ")[0]: row for row in output["coverage"]
            if row["tool"] == "lgpd-static:file"}
for file in ("operations.js", "operations.py"):
    assert coverage[file]["status"] == "failed", coverage[file]
    assert "resultados de chamadas sem vínculo estático" in coverage[file]["detail"], coverage[file]
assert coverage["writes.ts"]["status"] == "ok", coverage["writes.ts"]
for file, locations in expected.items():
    destinations = [
        [row["rule"].removeprefix("PII_POSSIBLE_"), row["line"],
         int(re.search(r"linha (\d+)\.", row["evidence"])[1])]
        for row in output["findings"]
        if row["file"] == file and row["rule"].startswith("PII_POSSIBLE_")
    ]
    assert destinations == locations, (file, destinations)
assert not re.search(r"SYNTHETIC_|syntheticRow|logger\.info|INSERT INTO", json.dumps(output))
`);
});

test('C9 atualiza propriedades e verifica o vínculo dos destinos com campos inventados', () => {
  python(String.raw`
import json
import re
from unittest.mock import patch
from collector import Report
from lgpd_analyzer import inspect_fields, javascript_destinations

cases = [
    ("properties.ts", '''const block = {tray: {slot: "R7_NEUTRAL"}};
const tray = block.tray;
tray.slot = mockRow.quartzSignal;
logger.info(block.tray.slot);
tray["slot"] = "R7_NEUTRAL";
logger.info(tray.slot);
tray["spare"] = mockRow.amberSignal;
logger.info(block);
delete tray.spare;
logger.info(block);
const entries = ["R7_NEUTRAL"];
entries[0] = mockRow.quartzSignal;
logger.info(...entries);
entries[0] = "R7_NEUTRAL";
logger.info(...entries);
function stage(target: {slot: unknown}) {
  target.slot = mockRow.amberSignal;
  logger.info(target.slot);
}''', [("LOG", 4, 3), ("LOG", 8, 7), ("LOG", 13, 12), ("LOG", 18, 17)], None),
    ("identity.js", '''const genuine = logger;
const record = genuine.info;
{
  const logger = {info() {}};
  logger.info(mockRow.quartzSignal);
}
record(mockRow.quartzSignal);
genuine.info = () => {};
logger.info(mockRow.quartzSignal);
function fetch() {}
fetch(endpoint, mockRow.quartzSignal);
const db = {query() {}};
db.query("INSERT INTO sample VALUES ($1)", [mockRow.quartzSignal]);
import transport from "axios";
transport.post(endpoint, mockRow.amberSignal);''', [("LOG", 7, 7), ("NETWORK", 15, 15)], None),
    ("properties.py", '''block = {"tray": {"slot": "R7_NEUTRAL"}}
tray = block["tray"]
tray["slot"] = mock_row.quartzSignal
print(block["tray"]["slot"])
tray["slot"] = "R7_NEUTRAL"
print(tray["slot"])
tray["spare"] = mock_row.amberSignal
requests.post(endpoint, json={**tray})
requests.post(endpoint, json={**tray, "spare": "R7_NEUTRAL"})
del tray["spare"]
requests.post(endpoint, json={"spare": mock_row.amberSignal, **tray})
args = [mock_row.quartzSignal]
print(*args)
args[0] = "R7_NEUTRAL"
print(*args)
mock_box.slot = mock_row.amberSignal
print(mock_box.slot)
mock_box.slot = "R7_NEUTRAL"
print(mock_box.slot)
print(mock_row[
    "quartzSignal"
])
print((mock_row
      .amberSignal))
def stage(target):
    target["slot"] = mock_row.amberSignal
    print(target["slot"])''', [("LOG", 4, 3), ("NETWORK", 8, 7), ("NETWORK", 11, 11),
                               ("LOG", 13, 12), ("LOG", 17, 16), ("LOG", 20, 21), ("LOG", 23, 24),
                               ("LOG", 27, 26)], None),
    ("identity.py", '''genuine = print
def print(*items): pass
print(mock_row.quartzSignal)
genuine(mock_row.quartzSignal)
requests = {"post": lambda *items: None}
requests.post(endpoint, mock_row.quartzSignal)
from requests import post as deliver
deliver(endpoint, mock_row.amberSignal)
def sink(*items): pass
cursor.execute = sink
cursor.execute("INSERT INTO sample VALUES ($1)", [mock_row.quartzSignal])
import logging as telemetry
writer = telemetry.getLogger("R7_NEUTRAL")
writer.info(mock_row.amberSignal)''', [("LOG", 4, 4), ("NETWORK", 8, 8), ("LOG", 14, 14)], None),
    ("ambiguous.ts", '''const tray = {slot: mockRow.quartzSignal};
tray[selector] = "R7_NEUTRAL";
logger.info(tray.slot);
const loggerAlias = chooseWriter();
loggerAlias.info(mockRow.amberSignal);
const fallback = {slot: mockRow.quartzSignal};
if (enabled) fallback.slot = "R7_NEUTRAL";
fetch(endpoint, fallback.slot);
const cleanTray = {slot: "R7_NEUTRAL"};
reflectiveWrite(cleanTray);
logger.info(cleanTray.slot);''', [], ("mutações de propriedades", "destino sem vínculo", "fluxo condicional")),
    ("ambiguous.py", '''tray = {"slot": mock_row.quartzSignal}
tray[selector] = "R7_NEUTRAL"
print(tray["slot"])
print(*opaque)
requests.post(endpoint, json={"slot": mock_row.quartzSignal, **opaque})
requests.post(endpoint, json={**opaque, "slot": mock_row.amberSignal})
writer = choose_writer()
writer.info(mock_row.quartzSignal)
pending = [mock_row.quartzSignal]
if enabled:
    pending[0] = "R7_NEUTRAL"
print(*pending)
suffix = {**opaque, "fixed": mock_row.quartzSignal}
requests.post(endpoint, json={**suffix})
visible = [*opaque, mock_row.amberSignal]
print(*visible)''', [("NETWORK", 6, 6), ("NETWORK", 14, 13), ("LOG", 16, 15)],
                    ("mutações de propriedades", "expansões de argumentos ou valores", "destino sem vínculo", "fluxo condicional")),
    ("late_binding.py", '''def stage():
    print(mock_row.quartzSignal)
def print(*items): pass
stage()''', [], ("destino sem vínculo",)),
]
with patch("lgpd_analyzer.FIELD", re.compile(r"\b(?:quartzSignal|amberSignal)\b")):
    parsed = javascript_destinations((file, source) for file, source, _, _ in cases)
    for file, source, expected, limits in cases:
        report = Report()
        inspect_fields(source, file, report, parsed.get(file))
        output = report.output()
        locations = [
            (row["rule"].removeprefix("PII_POSSIBLE_"), row["line"],
             int(re.search(r"linha (\d+)\.", row["evidence"])[1]))
            for row in output["findings"] if row["rule"].startswith("PII_POSSIBLE_")
        ]
        assert locations == expected, (file, locations)
        coverage, = output["coverage"]
        assert coverage["status"] == ("failed" if limits else "ok"), coverage
        assert all(reason in coverage["detail"] for reason in limits or ()), coverage
        assert not re.search(r"R7_NEUTRAL|quartzSignal|amberSignal|mock[Rr_]|INSERT INTO|choose_writer",
                             json.dumps(output)), file
`);
});

test('C9 mede a ordem de leitura e os limites de efeitos entre funções e laços', () => {
  python(String.raw`
import json
import re
from unittest.mock import patch
from collector import Report
from lgpd_analyzer import inspect_fields, javascript_destinations

cases = [
    ('order.ts', '''const tray = {slot: mockRow.quartzSignal};
logger.info(tray.slot, (tray.slot = "R8_NEUTRAL"));
logger.info(tray.slot, (tray.slot = mockRow.amberSignal));
logger.info({saved: tray.slot, changed: (tray.slot = "R8_NEUTRAL")});
const spread = [mockRow.quartzSignal];
logger.info(...spread, (spread[0] = "R8_NEUTRAL"));
let values = [mockRow.amberSignal];
db.query("INSERT INTO sample VALUES ($1)", values, (values = []));
localStorage.setItem("sample", (tray.slot = mockRow.quartzSignal), (tray.slot = "R8_NEUTRAL"));
logger.info(tray.slot);
const emit = {send: logger.info};
emit.send(mockRow.amberSignal, (emit.send = () => {}));
emit.send(mockRow.quartzSignal);
const referred = {slot: mockRow.quartzSignal};
logger.info(referred, (referred.slot = "R8_NEUTRAL"));''',
     [('LOG', 2, 1), ('LOG', 3, 3), ('LOG', 4, 3), ('LOG', 6, 5), ('STORAGE', 8, 7),
      ('STORAGE', 9, 9), ('LOG', 12, 12)], ()),
    ('order.py', '''slot = mock_row.quartzSignal
print(slot, (slot := "R8_NEUTRAL"))
print(slot)
args = [mock_row.amberSignal]
print(*args, (args := []))
pending = [mock_row.quartzSignal]
cursor.execute("INSERT INTO sample VALUES (?)", pending, (pending := []))''',
     [('LOG', 2, 1), ('LOG', 5, 4), ('STORAGE', 7, 6)], ()),
    ('effects.js', '''function clear(target) { target.inner.slot = "R8_NEUTRAL"; }
function ignore(target) {}
const tray = {inner: {slot: mockRow.quartzSignal}};
const child = tray.inner;
ignore(tray);
logger.info(child.slot);
const saved = child.slot;
clear(tray);
logger.info(tray.inner.slot);
logger.info(child.slot);
logger.info(saved);
const other = {slot: mockRow.amberSignal};
logger.info(other.slot);
function neutralize(target) { target.quartzSignal = "R8_NEUTRAL"; }
const opaque = readFixture();
neutralize(opaque);
opaque.quartzSignal = mockRow.amberSignal;
neutralize(opaque);
logger.info(opaque.quartzSignal);''',
     [('LOG', 6, 3), ('LOG', 11, 3), ('LOG', 13, 12)], ('mutações de propriedades',)),
    ('effects.py', '''def clear(target): target["inner"]["slot"] = "R8_NEUTRAL"
def ignore(target): pass
tray = {"inner": {"slot": mock_row.quartzSignal}}
child = tray["inner"]
ignore(tray)
print(child["slot"])
saved = child["slot"]
clear(tray)
print(tray["inner"]["slot"])
print(child["slot"])
print(saved)
other = {"slot": mock_row.amberSignal}
print(other["slot"])
def neutralize(target): target.quartzSignal = "R8_NEUTRAL"
opaque = read_fixture()
neutralize(opaque)
opaque.quartzSignal = mock_row.amberSignal
neutralize(opaque)
print(opaque.quartzSignal)''',
     [('LOG', 6, 3), ('LOG', 11, 3), ('LOG', 13, 12)], ('mutações de propriedades',)),
    ('captures.ts', '''let emit = logger.info;
function toNeutral() { emit(mockRow.quartzSignal); }
emit = () => {};
toNeutral();
function toLogger() { emit(mockRow.amberSignal); }
emit = logger.info;
toLogger();
emit(mockRow.quartzSignal);
const stable = logger.info;
function independent() { stable(mockRow.amberSignal); }
independent();''',
     [('LOG', 8, 8), ('LOG', 10, 10)], ('vínculos externos a funções', 'destino sem vínculo')),
    ('captures.py', '''emit = print
def noop(*items): pass
def to_neutral(): emit(mock_row.quartzSignal)
emit = noop
to_neutral()
def to_logger(): emit(mock_row.amberSignal)
emit = print
to_logger()
emit(mock_row.quartzSignal)
def independent():
    emit = print
    emit(mock_row.amberSignal)
independent()''',
     [('LOG', 9, 9), ('LOG', 12, 12)], ('vínculos externos a funções', 'destino sem vínculo')),
    ('modules.js', '''import first from "axios";
import second from "axios";
import {default as third} from "axios";
const saved = second.post;
second.post(endpoint, mockRow.quartzSignal);
first.post = () => {};
second.post(endpoint, mockRow.quartzSignal);
third.post(endpoint, mockRow.quartzSignal);
saved(endpoint, mockRow.amberSignal);''',
     [('NETWORK', 5, 5), ('NETWORK', 9, 9)], ()),
    ('modules.py', '''import requests as first
from requests import post as saved
def noop(*items, **options): pass
first.post(endpoint, mock_row.quartzSignal)
first.post = noop
import requests as second
second.post(endpoint, mock_row.quartzSignal)
from requests import post as current
current(endpoint, mock_row.quartzSignal)
saved(endpoint, mock_row.amberSignal)
import httpx as independent
independent.post(endpoint, mock_row.quartzSignal)''',
     [('NETWORK', 4, 4), ('NETWORK', 10, 10), ('NETWORK', 12, 12)], ()),
    ('loops.js', '''const tray = {slot: mockRow.quartzSignal};
const alias = tray;
for (tray.slot of ["R8_NEUTRAL"]) {}
logger.info(alias.slot);
let scratch = mockRow.quartzSignal;
for (scratch in {slot: "R8_NEUTRAL"}) {}
logger.info(scratch);
const empty = {slot: mockRow.quartzSignal};
for (empty.slot of []) {}
logger.info(empty.slot);
const other = {slot: mockRow.amberSignal};
logger.info(other.slot);''',
     [('LOG', 12, 11)], ('fluxo condicional ou repetido',)),
]
with patch('lgpd_analyzer.FIELD', re.compile(r'\b(?:quartzSignal|amberSignal)\b')):
    parsed = javascript_destinations((file, source) for file, source, _, _ in cases)
    for file, source, expected, reasons in cases:
        report = Report()
        inspect_fields(source, file, report, parsed.get(file))
        output = report.output()
        locations = [(row['rule'].removeprefix('PII_POSSIBLE_'), row['line'],
                      int(re.search(r'linha (\d+)\.', row['evidence'])[1]))
                     for row in output['findings'] if row['rule'].startswith('PII_POSSIBLE_')]
        assert locations == expected, (file, locations)
        coverage, = output['coverage']
        assert coverage['status'] == ('failed' if reasons else 'ok'), (file, coverage)
        assert all(reason in coverage['detail'] for reason in reasons), (file, coverage)
        assert not re.search(r'R8_NEUTRAL|quartzSignal|amberSignal|mockRow|mock_row|INSERT INTO', json.dumps(output)), file
`);
});

test('C9 limita os efeitos de chamadas locais, incluindo métodos sem vínculo', () => {
  python(String.raw`
import json
import re
from unittest.mock import patch
from collector import Report
from lgpd_analyzer import inspect_fields, javascript_destinations

cases = [
    ("calls.ts", '''let emit = logger.info;
const saved = emit;
const stop = () => { emit = () => {}; };
function neutral() { let emit = () => {}; emit = () => {}; }
neutral();
emit(mockRow.quartzSignal);
function wrapper() { stop(); }
wrapper();
emit(mockRow.quartzSignal);
saved(mockRow.amberSignal);
emit = logger.info;
emit(mockRow.quartzSignal);
const tray = {slot: mockRow.amberSignal};
const alias = tray;
function clear() { tray.slot = "C9_NEUTRAL"; }
clear();
logger.info(alias.slot);''',
     [("LOG", 6, 6), ("LOG", 10, 10), ("LOG", 12, 12)],
     ("vínculos externos a funções", "mutações de propriedades")),
    ("calls.py", '''emit = print
saved = emit
def stop():
    global emit
    emit = lambda *items: None
def neutral():
    emit = lambda *items: None
neutral()
emit(mock_row.quartzSignal)
def wrapper(): stop()
wrapper()
emit(mock_row.quartzSignal)
saved(mock_row.amberSignal)
emit = print
emit(mock_row.quartzSignal)
tray = {"slot": mock_row.amberSignal}
alias = tray
def clear(): tray["slot"] = "C9_NEUTRAL"
clear()
print(alias["slot"])
def outer():
    emit = print
    saved = emit
    def stop():
        nonlocal emit
        emit = lambda *items: None
    stop()
    emit(mock_row.quartzSignal)
    saved(mock_row.amberSignal)''',
     [("LOG", 9, 9), ("LOG", 13, 13), ("LOG", 15, 15), ("LOG", 29, 29)],
     ("vínculos externos a funções", "mutações de propriedades")),
    ("methods.js", '''const receiver = readFixture();
const alias = receiver;
receiver.slot = mockRow.quartzSignal;
receiver.send = logger.info;
const saved = receiver.slot;
receiver.cleanup();
logger.info(alias.slot);
alias.send(mockRow.amberSignal);
logger.info(saved);
receiver.slot = mockRow.amberSignal;
logger.info(alias.slot);
const independent = {send() {}, slot: mockRow.quartzSignal};
independent.send();
logger.info(independent.slot);
function cleanup() { receiver.cleanup(); }
cleanup();
logger.info(alias.slot);''',
     [("LOG", 9, 3), ("LOG", 11, 10), ("LOG", 14, 12)], ("mutações de propriedades",)),
    ("methods.py", '''receiver = read_fixture()
alias = receiver
receiver.slot = mock_row.quartzSignal
receiver.send = print
saved = receiver.slot
receiver.cleanup()
print(alias.slot)
alias.send(mock_row.amberSignal)
print(saved)
receiver.slot = mock_row.amberSignal
print(alias.slot)
independent = {"slot": mock_row.quartzSignal}
independent.get("slot")
print(independent["slot"])
def cleanup(): receiver.cleanup()
cleanup()
print(alias.slot)''',
     [("LOG", 9, 3), ("LOG", 11, 10), ("LOG", 14, 12)], ("mutações de propriedades",)),
    ("unsupported.ts", '''let reading = mockRow.quartzSignal;
reading *= 2;
logger.info(reading);
const changed = -mockRow.amberSignal;
logger.info(changed);
const independent = mockRow.quartzSignal;
logger.info(independent);''',
     [("LOG", 7, 6)], ("mutações de propriedades", "expressões JavaScript/TypeScript fora do rastreamento")),
]
with patch("lgpd_analyzer.FIELD", re.compile(r"\b(?:quartzSignal|amberSignal)\b")):
    parsed = javascript_destinations((file, source) for file, source, _, _ in cases)
    for file, source, expected, reasons in cases:
        report = Report()
        inspect_fields(source, file, report, parsed.get(file))
        output = report.output()
        hits = [(row["rule"].removeprefix("PII_POSSIBLE_"), row["line"],
                 int(re.search(r"linha (\d+)\.", row["evidence"])[1]))
                for row in output["findings"] if row["rule"].startswith("PII_POSSIBLE_")]
        assert hits == expected, (file, hits)
        coverage, = output["coverage"]
        assert coverage["status"] == "failed", (file, coverage)
        assert all(reason in coverage["detail"] for reason in reasons), (file, coverage)
        assert not re.search(r"C9_NEUTRAL|quartzSignal|amberSignal|mockRow|mock_row", json.dumps(output)), file
`);
});

test('C9 publica apenas fluxos com origem preservada após chamadas, aliases e junções', () => {
  python(String.raw`
import json
import re
from unittest.mock import patch
from collector import Report
from lgpd_analyzer import inspect_fields, javascript_destinations

cases = [
    ("nested.ts", '''let emit = logger.info;
const saved = emit;
function outer() {
  const stop = () => { emit = () => {}; };
  function middle() { stop(); }
  middle();
}
emit(mockRow.quartzSignal);
outer();
emit(mockRow.quartzSignal);
saved(mockRow.amberSignal);''',
     [(8, 8), (11, 11)], ("vínculos externos a funções",)),
    ("nested.py", '''emit = print
saved = emit
def outer():
    def stop():
        global emit
        emit = lambda: None
    def middle(): stop()
    middle()
emit(mock_row.quartzSignal)
outer()
emit(mock_row.quartzSignal)
saved(mock_row.amberSignal)''',
     [(9, 9), (12, 12)], ("vínculos externos a funções",)),
    ("alias.ts", '''const tray = {quartzSignal: mockRow.quartzSignal};
const saved = tray.quartzSignal;
const other = {slot: mockRow.amberSignal};
function clear() {
  const alias = tray;
  alias.quartzSignal = "C9_NEUTRAL";
}
clear();
logger.info(tray.quartzSignal);
logger.info(other.slot);
logger.info(saved);
tray.quartzSignal = mockRow.amberSignal;
logger.info(tray.quartzSignal);
function forward() {
  const alias = tray;
  useFixture(alias);
}
forward();
logger.info(tray.quartzSignal);
logger.info(other.slot);''',
     [(10, 3), (11, 1), (13, 12), (20, 3)], ("mutações de propriedades",)),
    ("alias.py", '''tray = {"quartzSignal": mock_row.quartzSignal}
saved = tray["quartzSignal"]
other = {"slot": mock_row.amberSignal}
def clear():
    alias = tray
    alias["quartzSignal"] = "C9_NEUTRAL"
clear()
print(tray["quartzSignal"])
print(other["slot"])
print(saved)
tray["quartzSignal"] = mock_row.amberSignal
print(tray["quartzSignal"])
def forward():
    alias = tray
    use_fixture(alias)
forward()
print(tray["quartzSignal"])
print(other["slot"])''',
     [(9, 3), (10, 1), (12, 11), (18, 3)], ("mutações de propriedades",)),
    ("global.py", '''def outer():
    global emit
    emit = print
    saved = emit
    def stop():
        global emit
        emit = lambda: None
    stop()
    emit(mock_row.quartzSignal)
    saved(mock_row.amberSignal)
def independent():
    emit = print
    def stop():
        global emit
        emit = lambda: None
    stop()
    emit(mock_row.quartzSignal)''',
     [(10, 10), (17, 17)], ("vínculos externos a funções",)),
    ("join.py", '''fixed = {"quartzSignal": "C9_NEUTRAL"}
chosen = (fixed and fixed) if flag else fixed
print(chosen["quartzSignal"])
other = fixed if flag else fixed
print(other["quartzSignal"])
maybe = mock_row.amberSignal if flag else "C9_NEUTRAL"
print(maybe)
opaque = read_fixture()
print(opaque.quartzSignal)
opaque.quartzSignal = mock_row.quartzSignal
print(opaque.quartzSignal)
packed = {**opaque}
print(packed["amberSignal"])
draft = "C9_NEUTRAL"
0 == 1 == (draft := mock_row.amberSignal)
print(draft)''',
     [(7, 6), (11, 10)], ("expressões Python fora do rastreamento", "fluxo condicional")),
    ("join.ts", '''const fixed = {quartzSignal: "C9_NEUTRAL"};
const chosen = flag ? fixed : fixed;
logger.info(chosen.quartzSignal);
const maybe = flag ? mockRow.amberSignal : "C9_NEUTRAL";
logger.info(maybe);
const opaque = readFixture();
logger.info(opaque.quartzSignal);
const joined = opaque || fixed;
logger.info(joined.quartzSignal);
opaque.quartzSignal = mockRow.quartzSignal;
logger.info(opaque.quartzSignal);
const packed = {...opaque};
logger.info(packed.amberSignal);
let draft = "C9_NEUTRAL";
!(draft = mockRow.amberSignal);
logger.info(draft);
var emit = logger.info;
if (flag) { var emit = () => {}; }
emit(mockRow.quartzSignal);''',
     [(5, 4), (11, 10)], ("expressões JavaScript/TypeScript fora do rastreamento", "fluxo condicional")),
]
with patch("lgpd_analyzer.FIELD", re.compile(r"\b(?:quartzSignal|amberSignal)\b")):
    parsed = javascript_destinations((file, source) for file, source, _, _ in cases)
    for file, source, expected, reasons in cases:
        report = Report()
        inspect_fields(source, file, report, parsed.get(file))
        output = report.output()
        hits = [(row["line"], int(re.search(r"linha (\d+)\.", row["evidence"])[1]))
                for row in output["findings"] if row["rule"] == "PII_POSSIBLE_LOG"]
        assert hits == expected, (file, hits)
        coverage, = output["coverage"]
        assert coverage["status"] == "failed", (file, coverage)
        assert all(reason in coverage["detail"] for reason in reasons), (file, coverage)
        assert not re.search(r"C9_NEUTRAL|quartzSignal|amberSignal|mockRow|mock_row", json.dumps(output)), file
`);
});

test('C9 atribui origens após aliases de método, argumentos padrão, junções e curto-circuito', () => {
  python(String.raw`
import json
import re
from unittest.mock import patch
from collector import Report
from lgpd_analyzer import inspect_fields, javascript_destinations

cases = [
    ("methods.ts", '''let emit = logger.info;
let store = localStorage.setItem;
const hooks = {stopLog() { emit = () => {}; }, stopStore() { store = () => {}; }};
function run() {
  const receiver = hooks;
  receiver.stopLog();
  const detached = receiver.stopStore;
  detached();
}
run();
emit(mockRow.quartzSignal);
store("C9_NEUTRAL", mockRow.quartzSignal);
logger.info(mockRow.amberSignal);''',
     [("LOG", 13, 13)], ("vínculos externos a funções",)),
    ("methods.py", '''emit = print
store = cursor.execute
def stop_log():
    global emit
    emit = lambda *items: None
def stop_store():
    global store
    store = lambda *items: None
hooks = {"stop_log": stop_log, "stop_store": stop_store}
def run():
    receiver = hooks
    receiver["stop_log"]()
    detached = receiver["stop_store"]
    detached()
run()
emit(mock_row.quartzSignal)
store("INSERT INTO sample VALUES (?)", [mock_row.quartzSignal])
print(mock_row.amberSignal)''',
     [("LOG", 18, 18)], ("vínculos externos a funções",)),
    ("bound.py", '''receiver = [mock_row.quartzSignal]
saved = receiver[0]
reset = receiver.clear
reset()
print(receiver[0])
print(saved)''',
     [("LOG", 6, 1)], ("mutações de propriedades",)),
    ("dynamic.ts", '''let emit = logger.info;
const callbacks = {reset() { emit = () => {}; }};
callbacks[selector]();
emit(mockRow.quartzSignal);
logger.info(mockRow.amberSignal);''',
     [("LOG", 5, 5)], ("leituras de propriedades sem chave estática", "vínculos externos a funções")),
    ("dynamic.py", '''emit = print
def reset():
    global emit
    emit = lambda *items: None
callbacks = {"reset": reset}
callbacks[selector]()
emit(mock_row.quartzSignal)
print(mock_row.amberSignal)''',
     [("LOG", 8, 8)], ("leituras de propriedades sem chave estática", "vínculos externos a funções")),
    ("defaults.ts", '''let tray = {slot: mockRow.quartzSignal};
const before = tray;
function clear(target = tray) { const alias = target; alias.slot = "C9_NEUTRAL"; }
clear({slot: "C9_NEUTRAL"});
logger.info(before.slot);
tray = {slot: mockRow.amberSignal};
const saved = tray.slot;
function run() { clear(); }
run();
logger.info(tray.slot);
logger.info(before.slot);
localStorage.setItem("C9_NEUTRAL", saved);''',
     [("LOG", 5, 1), ("LOG", 11, 1), ("STORAGE", 12, 6)], ("mutações de propriedades",)),
    ("defaults.py", '''tray = {"slot": mock_row.quartzSignal}
before = tray
def clear(*, target=tray):
    alias = target
    alias["slot"] = "C9_NEUTRAL"
clear(target={"slot": "C9_NEUTRAL"})
print(before["slot"])
tray = {"slot": mock_row.amberSignal}
saved = before["slot"]
def run(): clear()
run()
print(before["slot"])
print(tray["slot"])
cursor.execute("INSERT INTO sample VALUES (?)", [saved])''',
     [("LOG", 7, 1), ("LOG", 13, 8), ("STORAGE", 14, 1)], ("mutações de propriedades",)),
    ("default-initializer.ts", '''let emit = logger.info;
function configure(value = (emit = () => {})) {}
configure(null);
emit(mockRow.quartzSignal);
configure(undefined);
emit(mockRow.amberSignal);''',
     [("LOG", 4, 4)], ("vínculos externos a funções",)),
    ("join-identity.ts", '''const tray = {slot: mockRow.quartzSignal};
const chosen = flag ? tray : tray;
logger.info(chosen.slot);
let alias;
if (flag) { alias = chosen; } else { alias = tray; }
localStorage.setItem("C9_NEUTRAL", alias.slot);
chosen.slot = "C9_NEUTRAL";
logger.info(alias.slot);''',
     [("LOG", 3, 1), ("STORAGE", 6, 1)], ()),
    ("join-identity.py", '''tray = {"slot": mock_row.quartzSignal}
chosen = tray if flag else tray
print(chosen["slot"])
if flag: alias = chosen
else: alias = tray
cursor.execute("INSERT INTO sample VALUES (?)", [alias["slot"]])
chosen["slot"] = "C9_NEUTRAL"
print(alias["slot"])''',
     [("LOG", 3, 1), ("STORAGE", 6, 1)], ()),
    ("join-opaque.ts", '''const tray = {slot: mockRow.quartzSignal};
const other = {slot: mockRow.amberSignal};
const choice = flag ? tray : other;
logger.info(choice.slot);
logger.info(tray.slot);
choice.slot = "C9_NEUTRAL";
logger.info(tray.slot);
logger.info(other.slot);''',
     [("LOG", 5, 1)], ("expressões JavaScript/TypeScript fora do rastreamento", "mutações de propriedades")),
    ("join-opaque.py", '''tray = {"slot": mock_row.quartzSignal}
other = {"slot": mock_row.amberSignal}
choice = tray if flag else other
print(choice["slot"])
print(tray["slot"])
choice["slot"] = "C9_NEUTRAL"
print(tray["slot"])
print(other["slot"])''',
     [("LOG", 5, 1)], ("expressões Python fora do rastreamento", "mutações de propriedades")),
    ("logical.ts", '''let reading = mockRow.quartzSignal;
let emit = logger.info;
function stop() { emit = () => {}; }
function run() { false && stop(); }
run();
false && logger.info(mockRow.amberSignal);
true || (reading = "C9_NEUTRAL");
0 ?? (reading = "C9_NEUTRAL");
const gate = false;
let off = false;
off &&= logger.info(mockRow.amberSignal);
logger.info(gate && mockRow.amberSignal);
emit(reading);
localStorage.setItem("C9_NEUTRAL", null ?? mockRow.amberSignal);''',
     [("LOG", 13, 1), ("STORAGE", 14, 14)], ()),
    ("logical.py", '''reading = mock_row.quartzSignal
emit = print
def stop():
    global emit
    emit = lambda *items: None
def run(): False and stop()
run()
False and print(mock_row.amberSignal)
True or (reading := "C9_NEUTRAL")
gate = False
print(gate and mock_row.amberSignal)
emit(reading)
cursor.execute("INSERT INTO sample VALUES (?)", [False or mock_row.amberSignal])''',
     [("LOG", 12, 1), ("STORAGE", 13, 13)], ()),
    ("opaque.ts", '''logger.info(readFixture());
localStorage.setItem("C9_NEUTRAL", readFixture(mockRow.amberSignal));
logger.info(mockRow.quartzSignal);''',
     [("LOG", 3, 3)], ("resultados de chamadas sem vínculo", "resultados de chamadas indiretas")),
    ("opaque.py", '''print(read_fixture())
cursor.execute("INSERT INTO sample VALUES (?)", [read_fixture(mock_row.amberSignal)])
print(mock_row.quartzSignal)''',
     [("LOG", 3, 3)], ("resultados de chamadas sem vínculo", "resultados de chamadas indiretas")),
]
with patch("lgpd_analyzer.FIELD", re.compile(r"\b(?:quartzSignal|amberSignal)\b")):
    parsed = javascript_destinations((file, source) for file, source, _, _ in cases)
    for file, source, expected, reasons in cases:
        report = Report()
        inspect_fields(source, file, report, parsed.get(file))
        output = report.output()
        hits = [(row["rule"].removeprefix("PII_POSSIBLE_"), row["line"],
                 int(re.search(r"linha (\d+)\.", row["evidence"])[1]))
                for row in output["findings"] if row["rule"].startswith("PII_POSSIBLE_")]
        assert hits == expected, (file, hits)
        coverage, = output["coverage"]
        assert coverage["status"] == ("failed" if reasons else "ok"), (file, coverage)
        assert all(reason in coverage["detail"] for reason in reasons), (file, coverage)
        assert not re.search(r"C9_NEUTRAL|quartzSignal|amberSignal|mockRow|mock_row|INSERT INTO", json.dumps(output)), file
`);
});

test('C9 propaga curto-circuito composto e presença de argumento nos efeitos de funções locais', () => {
  python(String.raw`
import json
import re
from unittest.mock import patch
from collector import Report
from lgpd_analyzer import inspect_fields, javascript_destinations

cases = []
capture = "vínculos externos a funções"
for gate, js, py, reaches_stop in (
    ("false", "false", "False", False),
    ("true", "true", "True", True),
    ("unknown", "fixtureGate", "fixture_gate", True),
):
    reasons = (capture,) if reaches_stop else ()
    cases.extend([
        (f"logical-{gate}.js", f'''const reading = mockRow.quartzSignal;
let emit = logger.info;
function stop() {{ emit = () => {{}}; }}
function run() {{ ({js} && true) && stop(); }}
run();
emit(reading);
logger.info(mockRow.amberSignal);''',
         ([] if reaches_stop else [(6, 1)]) + [(7, 7)], reasons),
        (f"logical-{gate}.py", f'''reading = mock_row.quartzSignal
emit = print
def stop():
    global emit
    emit = lambda *items: None
def run(): ({py} and True) and stop()
run()
emit(reading)
print(mock_row.amberSignal)''',
         ([] if reaches_stop else [(8, 1)]) + [(9, 9)], reasons),
    ])

uncertain_default = "argumentos padrão JavaScript/TypeScript sem vínculo estático"
mutation = "mutações de propriedades"
for name, argument, invalidates_tray, reasons in (
    ("object", "{}", False, (capture, mutation)),
    ("compound", "(false && fixtureTarget) || {}", False, (capture, mutation)),
    ("omitted", "", True, (capture, mutation)),
    ("undefined", "undefined", True, (capture, mutation)),
    ("unknown", "fixtureTarget", True, (capture, mutation, uncertain_default)),
    ("spread", "...fixtureTargets", True, (capture, mutation, uncertain_default)),
):
    cases.append((f"default-{name}.js", f'''const tray = {{slot: mockRow.quartzSignal}};
function clear(target = tray) {{ const alias = target; alias.slot = "C9_NEUTRAL"; }}
function run() {{ clear({argument}); }}
run();
logger.info(tray.slot);
logger.info(mockRow.amberSignal);''',
                  ([] if invalidates_tray else [(5, 1)]) + [(6, 6)], reasons))

for name, argument, expected, reasons in (
    ("null", "null", [(8, 1), (9, 9)], ()),
    ("omitted", "", [(9, 9)], (capture,)),
    ("shadowed", "undefined", [(9, 9)], (capture, uncertain_default)),
):
    parameter = "undefined" if name == "shadowed" else ""
    cases.append((f"initializer-{name}.js", f'''const reading = mockRow.quartzSignal;
let emit = logger.info;
function run({parameter}) {{
  function clear(target = (emit = () => {{}})) {{}}
  clear({argument});
}}
run();
emit(reading);
logger.info(mockRow.amberSignal);''', expected, reasons))

with patch("lgpd_analyzer.FIELD", re.compile(r"\b(?:quartzSignal|amberSignal)\b")):
    parsed = javascript_destinations((file, source) for file, source, _, _ in cases)
    for file, source, expected, reasons in cases:
        report = Report()
        inspect_fields(source, file, report, parsed.get(file))
        output = report.output()
        hits = [(row["rule"], row["line"], int(re.search(r"linha (\d+)\.", row["evidence"])[1]))
                for row in output["findings"] if row["rule"].startswith("PII_POSSIBLE_")]
        assert hits == [("PII_POSSIBLE_LOG", *hit) for hit in expected], (file, hits)
        coverage, = output["coverage"]
        assert coverage["status"] == ("failed" if reasons else "ok"), (file, coverage)
        assert all(reason in coverage["detail"] for reason in reasons), (file, coverage)
        if uncertain_default not in reasons:
            assert uncertain_default not in coverage["detail"], (file, coverage)
        assert not re.search(r"C9_NEUTRAL|quartzSignal|amberSignal|mockRow|mock_row", json.dumps(output)), file
`);
});

test('C9 captura operandos Python no ponto da leitura e conserva o alvo da atribuição aumentada', () => {
  python(String.raw`
import json
import re
from unittest.mock import patch
from collector import Report
from lgpd_analyzer import inspect_fields

sources = [
    ('''label = mock_row.quartzSignal
combined = label + (label := "C9_NEUTRAL")
print(combined)
print(label)
label = mock_row.amberSignal
print(f"{label}{(label := 'C9_NEUTRAL')}")
print(label)
label = mock_row.quartzSignal
print((label, (label := "C9_NEUTRAL")))
print(label)
label = mock_row.amberSignal
print({"slot": label, "other": (label := "C9_NEUTRAL")})
print(label)''',
     [(3, 1), (6, 5), (9, 8), (12, 11)], ()),
    ('''tray = {"slot": "C9_NEUTRAL"}
saved = tray
other = {"slot": mock_row.quartzSignal,
         "suffix": mock_row.amberSignal}
tray["slot"] += (tray := other)["suffix"]
print(saved["slot"])
print(tray["slot"])
def neutralize():
    global tray
    tray = {}
    return "C9_NEUTRAL"
tray["slot"] += neutralize()
print(other["slot"])
print(saved["slot"])''',
     [(6, 4), (7, 3), (14, 4)], ("vínculos externos a funções", "reatribuições fora do rastreamento")),
    ('''slot = mock_row.quartzSignal
slot *= 2
print(slot)
slot = mock_row.amberSignal
slot = slot.replace("C9_NEUTRAL", "C9_NEUTRAL")
print(slot)
message = mock_row.quartzSignal * 2
print(message)''',
     [], ("reatribuições fora do rastreamento", "expressões Python fora do rastreamento")),
]
with patch("lgpd_analyzer.FIELD", re.compile(r"\b(?:quartzSignal|amberSignal)\b")):
    for source, expected, reasons in sources:
        report = Report()
        inspect_fields(source, "order.py", report)
        output = report.output()
        hits = [(row["line"], int(re.search(r"linha (\d+)\.", row["evidence"])[1]))
                for row in output["findings"] if row["rule"] == "PII_POSSIBLE_LOG"]
        assert hits == expected, hits
        coverage, = output["coverage"]
        assert coverage["status"] == ("failed" if reasons else "ok"), coverage
        assert all(reason in coverage["detail"] for reason in reasons), coverage
        assert not re.search(r"C9_NEUTRAL|quartzSignal|amberSignal|mock_row", json.dumps(output))
`);
});

test('C9 mede a escrita em EXPLAIN que executa a instrução SQL', () => {
  python(String.raw`
import json
import re
from unittest.mock import patch
from collector import Report
from lgpd_analyzer import inspect_fields, javascript_destinations

cases = [
    ('EXPLAIN ANALYZE INSERT INTO sample (slot) VALUES ($1)', True, None),
    ('EXPLAIN ANALYSE VERBOSE INSERT INTO sample (slot) VALUES ($1)', True, None),
    ('EXPLAIN (VERBOSE, ANALYZE ON, FORMAT JSON) UPDATE sample SET slot = $1', True, None),
    ('EXPLAIN (ANALYZE) WITH seed(v) AS (VALUES ($1)) INSERT INTO sample SELECT v FROM seed', True, None),
    ('EXPLAIN INSERT INTO sample (slot) VALUES ($1)', False, None),
    ('EXPLAIN (ANALYZE FALSE) INSERT INTO sample (slot) VALUES ($1)', False, None),
    ('EXPLAIN ANALYZE SELECT $1', False, None),
    ('EXPLAIN ANALYZE INSERT INTO sample VALUES (lower($1))', False, 'fora do recorte de escrita'),
    ('EXPLAIN (ANALYZE $1) UPDATE sample SET slot = $1', False, 'fora do recorte de escrita'),
    ('EXPLAIN ANALYZE UPDATE sample SET slot = $2', False, 'parâmetros SQL sem vínculo'),
]
texts = []
for index, (command, hit, limit) in enumerate(cases):
    for extension in ('ts', 'py'):
        file = f'{index}.{extension}'
        source = f'parameters = [mock_row.quartzSignal]\ncursor.execute("{command}", parameters)'
        if extension == 'ts':
            source = 'const ' + source
        texts.append((file, source, hit, limit))
with patch("lgpd_analyzer.FIELD", re.compile(r"\bquartzSignal\b")):
    parsed = javascript_destinations((file, source) for file, source, _, _ in texts)
    for file, source, expected, limit in texts:
        report = Report()
        inspect_fields(source, file, report, parsed.get(file))
        output = report.output()
        hits = [row for row in output['findings'] if row['rule'].startswith('PII_POSSIBLE_')]
        assert [(row['rule'], row['line']) for row in hits] == ([('PII_POSSIBLE_STORAGE', 2)] if expected else []), file
        assert all('linha 1.' in row['evidence'] for row in hits), file
        coverage, = output['coverage']
        assert coverage['status'] == ('failed' if limit else 'ok'), coverage
        assert limit is None or limit in coverage['detail'], coverage
        assert not re.search(r'EXPLAIN|sample|quartzSignal|mock_row', json.dumps(output)), file
`);
});

test('C9 mede sintaxe, SQL e transformações fora do rastreamento sem inventar destinos', () => {
  python(String.raw`
import json
from unittest.mock import patch
from collector import Report
from lgpd_analyzer import inspect_fields

cases = [
    ("s.ts", 'logger.info(syntheticRow.cpf', "failed", "sintaxe não analisável"),
    ("s.py", 'logger.info(synthetic_row.cpf', "failed", "sintaxe não analisável"),
    ("s.php", '// logger.info(syntheticRow.cpf);', "skipped", "Sem parser de destinos"),
    ("s.ts", 'db.query(command, [syntheticRow.cpf]);', "failed", "sem comando literal"),
    ("s.ts", 'db.query("example INSERT INTO synthetic (tag) VALUES (?)", [syntheticRow.cpf]);',
     "failed", "fora do recorte de escrita"),
    ("s.ts", 'db.query("WITH src(v) AS (SELECT ?) INSERT INTO synthetic (tag) SELECT v FROM src", [syntheticRow.cpf]);',
     "failed", "fora do recorte de escrita"),
    ("s.ts", 'db.query("UPDATE synthetic SET tag = lower($1)", [syntheticRow.cpf]);',
     "failed", "fora do recorte de escrita"),
    ("s.ts", 'db.query("INSERT INTO synthetic (tag) VALUES ($1)", () => syntheticRow.cpf);',
     "failed", "parâmetros SQL sem vínculo"),
    ("s.ts", 'db.query("INSERT INTO synthetic (tag) VALUES ($2)", [syntheticRow.cpf]);',
     "failed", "parâmetros SQL sem vínculo"),
    ("s.ts", 'localStorage.setItem("synthetic-key", transform(syntheticRow.cpf));',
     "failed", "resultados de chamadas indiretas"),
]
for file, text, status, detail in cases:
    report = Report()
    inspect_fields(text, file, report)
    output = report.output()
    assert output["coverage"][0]["status"] == status, output["coverage"]
    assert detail in output["coverage"][0]["detail"], output["coverage"]
    assert not any(row["rule"].startswith("PII_POSSIBLE_") for row in output["findings"]), output
    assert "syntheticRow" not in json.dumps(output)

report = Report()
with patch("lgpd_analyzer.which", return_value=None):
    inspect_fields('logger.info(syntheticRow.cpf)', 'synthetic.ts', report)
assert report.has_errors and "parser JavaScript/TypeScript indisponível" in report.coverage[0]["detail"]
assert not any(row["rule"].startswith("PII_POSSIBLE_") for row in report.output()["findings"])
`);
});

test('C9 preserva a origem já lida e informa cobertura parcial em chamadas acima do limite', () => {
  python(String.raw`
import json
from collector import Report
from lgpd_analyzer import JS_EXPRESSION_LIMIT, inspect_fields

prefix = 'const payload = request.cpf;\nlogger.info('
long_literal = '"' + 'SYNTHETIC_VALUE' * JS_EXPRESSION_LIMIT + '"'
boundary = 'payload'.ljust(JS_EXPRESSION_LIMIT)
cases = (
    (prefix + 'payload, ' + long_literal + ');', 'failed', 1),
    (prefix + 'request.email, ' + long_literal + ');', 'failed', 2),
    (prefix + long_literal + ', payload);', 'failed', None),
    (prefix + ' ' * (JS_EXPRESSION_LIMIT - 3) + 'cpfSuffix);', 'failed', None),
    (prefix + boundary + ');', 'ok', 1),
    (prefix + boundary + ' );', 'failed', 1),
)
for text, status, origin in cases:
    report = Report()
    inspect_fields(text, "sample.ts", report)
    result = report.output()
    warnings = [row for row in result["findings"] if row["rule"] == "PII_POSSIBLE_LOG"]
    assert len(warnings) == int(origin is not None), warnings
    if origin is not None:
        assert warnings[0]["line"] == 2 and f"linha {origin}." in warnings[0]["evidence"]
    assert result["coverage"][0]["status"] == status
    assert report.has_errors == (status == "failed")
    if status == "failed":
        assert "Cobertura parcial: 1" in result["coverage"][0]["detail"]
    assert "SYNTHETIC_VALUE" not in json.dumps(result)
`);
});

test('C9 aceita o piso do telefone e preserva o piso das demais entidades', () => {
  const result = JSON.parse(python(String.raw`
import json
import sys
from types import SimpleNamespace as Namespace
from unittest.mock import Mock, patch
from collector import Report
from lgpd_analyzer import create_presidio, inspect_entities, presidio_diagnostics

class PhoneRecognizer:
    SCORE = 0.4
    score_thresholds = {}

class PatternRecognizer:
    def __init__(self, **_options):
        pass

phone = PhoneRecognizer()
person = Namespace(score_thresholds={})

class SyntheticAnalyzer:
    def __init__(self, *, default_score_threshold, **_options):
        self.default = default_score_threshold
        self.registry = Mock()

    def get_recognizers(self, *, language):
        assert language == "en"
        return [phone, person]

    def analyze(self, *, text, language, entities):
        scores = (("PERSON", 0.59), ("BR_CPF", 0.59), ("EMAIL_ADDRESS", 0.59),
                  ("PHONE_NUMBER", 0.4 if text == "+1 202-555-0100" else 0.39))
        limits = {**person.score_thresholds, **phone.score_thresholds}
        return [Namespace(entity_type=entity, score=score, start=0, end=len(text))
                for entity, score in scores if entity in entities and score >= limits.get(entity, self.default)]

packages = {
    "spacy": Namespace(util=Namespace(is_package=lambda _name: True)),
    "tldextract": Namespace(TLDExtract=Mock()),
    "presidio_analyzer": Namespace(AnalyzerEngine=SyntheticAnalyzer, Pattern=Mock(), PatternRecognizer=PatternRecognizer),
    "presidio_analyzer.nlp_engine": Namespace(NerModelConfiguration=Mock(), SpacyNlpEngine=Mock()),
    "presidio_analyzer.predefined_recognizers": Namespace(EmailRecognizer=object, PhoneRecognizer=PhoneRecognizer),
}
with patch.dict(sys.modules, packages):
    analyzer = create_presidio()

report = Report()
with presidio_diagnostics() as diagnostics:
    assert inspect_entities(analyzer, "+1 202-555-0100", "phone.txt", "2.2.366", report, diagnostics)
    assert inspect_entities(analyzer, "000", "control.txt", "2.2.366", report, diagnostics)
print(json.dumps(report.output()))
`));
  assert.deepEqual(result.findings.map((row: {rule: string; file: string; line: number}) =>
    [row.rule, row.file, row.line]), [['PII_PHONE_NUMBER', 'phone.txt', 1]]);
  assert.ok(result.coverage.every((row: {status: string}) => row.status === 'ok'));
  assert.doesNotMatch(JSON.stringify(result), /202-555-0100/);
});

test('C9 marca timeout interno como falha parcial e suprime diagnósticos nas duas saídas', () => {
  const run = spawnSync('python3', ['-B', '-c', String.raw`
import logging, sys, warnings
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock, patch
from collector import inspect_privacy, main

class SyntheticAnalyzer:
    def analyze(self, *, text, language, **_options):
        if language == "pt":
            return []
        if text.startswith("interrompido"):
            try:
                raise TimeoutError(text)
            except TimeoutError:
                logging.getLogger("presidio-analyzer").warning(
                    "Regex pattern '%s' timed out after %s seconds, skipping.", text, 60, exc_info=True)
            return [SimpleNamespace(entity_type="EMAIL_ADDRESS", score=1, start=0, end=len(text))]
        if text.startswith("excecao"):
            raise TimeoutError(text)
        warnings.warn(text)
        print(text)
        print(text, file=sys.stderr)
        logging.getLogger("presidio-analyzer").warning("%s", text)
        logging.getLogger("fixture").warning("%s", text)
        return []

def privacy_only(root, report):
    selected = {path.name: path for path in sorted(root.iterdir())}
    inspect_privacy(selected, "2.2.366", report)

with TemporaryDirectory() as scratch:
    root = Path(scratch)
    for name, prefix in (("a-interrompido.txt", "interrompido"), ("b-controle.txt", "controle"),
                         ("c-excecao.txt", "excecao")):
        (root / name).write_text(prefix + " private-fixture@example.invalid SYNTHETIC_SECRET")
    presidio_logger = logging.getLogger("presidio-analyzer")
    original_handler = Mock(spec=logging.Handler, level=logging.WARNING)
    presidio_logger.addHandler(original_handler)
    sys.argv = ["collector.py", "--repo", scratch]
    with patch("collector.collect", side_effect=privacy_only), patch("lgpd_analyzer.create_presidio", return_value=SyntheticAnalyzer()):
        code = main()
    assert presidio_logger.handlers == [original_handler]
    original_handler.handle.assert_not_called()
    sys.exit(code)
`], {cwd: moduleDir, encoding: 'utf8'});
  assert.equal(run.status, 1);
  assert.equal(run.stderr, '');
  const result = JSON.parse(run.stdout);
  assert.doesNotMatch(run.stdout, /private-fixture|SYNTHETIC_SECRET|Traceback/);
  const coverage = new Map<string, string>(result.coverage.map((row: {detail: string; status: string}) =>
    [row.detail.split(' | ')[0], row.status]));
  assert.equal(coverage.get('a-interrompido.txt'), 'failed');
  assert.equal(coverage.get('b-controle.txt'), 'ok');
  assert.equal(coverage.get('c-excecao.txt'), 'failed');
  assert.equal(result.coverage.find((row: {tool: string}) => row.tool === 'presidio-analyzer').status, 'failed');
  assert.deepEqual(result.findings.map((row: {rule: string; file: string}) => [row.rule, row.file]),
    [['PII_EMAIL_ADDRESS', 'a-interrompido.txt']]);
});

test('C9 registra a cobertura individual mesmo quando um arquivo deixou de ser examinado', () => {
  const reports = JSON.parse(python(String.raw`
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch
import json
from collector import Report, inspect_privacy
from lgpd_analyzer import MAX_TEXT_BYTES

with TemporaryDirectory() as scratch:
    root = Path(scratch)
    samples = {
        "Dockerfile": b"FROM scratch",
        "config.cjs": b"module.exports = true",
        "binary.txt": b"\x00\xff",
        "oversize.txt": b"x" * (MAX_TEXT_BYTES + 1),
        "eligible.txt": b"SYNTHETIC_TEXT",
        "complete.ts": b"const payload = syntheticRow.cpf; fetch(url, payload);",
        "partial.ts": b"""let payload = syntheticRow.cpf;
{
  const { tag } = fixture, payload = "SYNTHETIC_TEXT";
  logger.info(payload);
}
db.query(command, [payload]);
fetch(url, payload);""",
    }
    for name, data in samples.items():
        (root / name).write_bytes(data)
    files = {name: root / name for name in (*samples, "missing.txt")}
    analyzer = Mock()
    analyzer.analyze.return_value = []
    report, unavailable = Report(), Report()
    with patch("lgpd_analyzer.create_presidio", return_value=analyzer):
        inspect_privacy(files, "2.2.366", report)
    with patch("lgpd_analyzer.create_presidio", side_effect=RuntimeError("SYNTHETIC_TEXT")):
        inspect_privacy(files, "2.2.366", unavailable)
    assert [call.kwargs["text"] for call in analyzer.analyze.call_args_list] == [
        samples[name].decode() for name in ("eligible.txt", "complete.ts", "partial.ts") for _ in range(2)
    ]
print(json.dumps([report.output(), unavailable.output()]))
`));
  for (const report of reports) {
    for (const file of ['Dockerfile', 'config.cjs', 'binary.txt', 'oversize.txt']) {
      assert.ok(report.coverage.some((row: {tool: string; status: string; detail: string}) =>
        row.tool === 'lgpd:file' && row.status === 'skipped' && row.detail.startsWith(`${file} |`)), file);
    }
    assert.ok(report.coverage.some((row: {tool: string; status: string; detail: string}) =>
      row.tool === 'lgpd:file' && row.status === 'failed' && row.detail.startsWith('missing.txt |')));
    const staticFiles = new Map<string, {status: string; detail: string}>(report.coverage
      .filter((row: {tool: string}) => row.tool === 'lgpd-static:file')
      .map((row: {status: string; detail: string}) => [row.detail.split(' | ')[0], row]));
    assert.equal(staticFiles.get('eligible.txt')?.status, 'skipped');
    assert.equal(staticFiles.get('complete.ts')?.status, 'ok');
    assert.equal(staticFiles.get('partial.ts')?.status, 'failed');
    assert.match(staticFiles.get('partial.ts')?.detail ?? '', /1 chamadas SQL sem comando literal analisável/);
    assert.match(staticFiles.get('partial.ts')?.detail ?? '', /1 declaradores fora do rastreamento/);
    const summary = report.coverage.find((row: {tool: string}) => row.tool === 'lgpd-static');
    assert.equal(summary.status, 'failed');
    assert.match(summary.detail, /2 arquivos.+1 com cobertura parcial/);
    assert.match(summary.detail, /fluxo entre funções, análise de ramos ou chaves dinâmicas/);
    assert.deepEqual(report.findings
      .filter((row: {file: string; rule: string}) => row.file === 'partial.ts' && row.rule.startsWith('PII_POSSIBLE_'))
      .map((row: {rule: string; line: number}) => [row.rule, row.line]), [['PII_POSSIBLE_NETWORK', 7]]);
  }
  for (const [index, status] of ['ok', 'failed'].entries()) {
    assert.ok(reports[index].coverage.some((row: {tool: string; status: string; detail: string}) =>
      row.tool === 'presidio-analyzer:file' && row.status === status && row.detail.startsWith('eligible.txt |')));
  }
  assert.doesNotMatch(JSON.stringify(reports), /SYNTHETIC_TEXT/);
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
  assert.doesNotMatch(JSON.stringify(result), /fixture-widget/);
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

test('C9 registra triagem entre projeto e dependência e entre declarações distintas do lockfile', () => {
  const reports = JSON.parse(python(String.raw`
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from collector import Report, inspect_npm
from license_policy import inspect_lock

categories = {"MIT": "permissiva", "GPL-2.0-only": "copyleft forte",
              "GPL-3.0-only": "copyleft forte", "UNLICENSED": "proprietária"}
def classify(value):
    return (categories[value], value) if value in categories else ("desconhecida", None)

source = """{
  "lockfileVersion": 3,
  "packages": {
    "": {"license": "UNLICENSED"},
    "node_modules/synthetic-gpl3": {"version": "SYNTHETIC_SECRET", "license": "GPL-3.0-only"},
    "node_modules/synthetic-gpl2": {"license": "GPL-2.0-only"},
    "node_modules/synthetic-closed": {"license": "UNLICENSED"}
  }
}"""
control = source.replace("GPL-2.0-only", "GPL-3.0-only").replace(
    '"node_modules/synthetic-closed": {"license": "UNLICENSED"}',
    '"node_modules/synthetic-closed": {"license": "MIT"}')
with patch("license_policy.classify", side_effect=classify):
    dirty, clean, from_manifest = Report(), Report(), Report()
    inspect_lock(source, None, "package-lock.json", dirty)
    inspect_lock(control, "UNKNOWN", "package-lock.json", clean)
    with TemporaryDirectory() as scratch:
        path = Path(scratch)
        (path / "package.json").write_text('{\n  "license": "UNLICENSED"\n}')
        (path / "npm-shrinkwrap.json").write_text(source.replace('"license": "UNLICENSED"', '"license": "MIT"'))
        inspect_npm({"demo/npm-shrinkwrap.json": path / "npm-shrinkwrap.json"}, [], from_manifest)
print(json.dumps([report.output() for report in (dirty, clean, from_manifest)]))
`));
  const [dirty, clean, manifest] = reports;
  const review = (row: {rule: string}) => row.rule === 'LICENSE_OBLIGATION_REVIEW';
  const dependencies = (row: {rule: string}) => row.rule === 'LICENSE_DEPENDENCY_OBLIGATION_REVIEW';
  assert.deepEqual(dirty.findings.filter(review).map((row: {line: number}) => row.line), [5, 6]);
  assert.ok(dirty.findings.filter(review).every((row: {evidence: string}) =>
    row.evidence.includes('UNLICENSED em package-lock.json linha 4')));
  assert.deepEqual(dirty.findings.filter(dependencies).map((row: {line: number; evidence: string}) =>
    [row.line, row.evidence.match(/linha (\d+)/)?.[1]]).sort(), [[6, '5'], [7, '5'], [7, '6']]);
  assert.ok(clean.findings.every((row: {rule: string}) => !review(row) && !dependencies(row)));
  assert.equal(manifest.findings.find(review).file, 'demo/npm-shrinkwrap.json');
  assert.match(manifest.findings.find(review).evidence, /UNLICENSED em demo\/package\.json linha 2/);
  assert.doesNotMatch(JSON.stringify(reports), /synthetic-gpl|synthetic-closed|SYNTHETIC_SECRET/);
});

test('C9 conserva pares SPDX em todas as permutações e declara a cobertura limitada', () => {
  python(String.raw`
from itertools import permutations, combinations
from unittest.mock import patch
from collector import Report
from license_policy import inspect_lock
import json
import re

classes = ("GPL-2.0-or-later", "GPL-2.0-only", "GPL-3.0-only")
wanted = {tuple(sorted(pair)) for pair in combinations(classes, 2)}
def inspect(items):
    lock = {"lockfileVersion": 3, "packages": {
        "node_modules/p" + str(i): {"license": value} for i, value in enumerate(items)
    }}
    report = Report()
    with patch("license_policy.classify", side_effect=lambda value: ("copyleft forte", value)):
        inspect_lock(json.dumps(lock), None, "package-lock.json", report)
    return report.output()
for ordering in permutations(classes):
    result = inspect((*ordering, ordering[0]))
    pairs = [tuple(sorted(re.findall(r"declara (GPL-[^.]+\.0-[a-z-]+)", row["evidence"])))
             for row in result["findings"] if row["rule"] == "LICENSE_DEPENDENCY_OBLIGATION_REVIEW"]
    assert len(pairs) == len(wanted) and set(pairs) == wanted
with patch("license_policy.MAX_LICENSE_PAIRS", 1):
    for ordering in permutations(classes):
        result = inspect(ordering)
        assert result["coverage"][0]["status"] == "failed"
        assert "pares fora do limite=2" in result["coverage"][0]["detail"]
        emitted = [row for row in result["findings"] if row["rule"] == "LICENSE_DEPENDENCY_OBLIGATION_REVIEW"]
        assert len(emitted) == 1 and all(term in emitted[0]["evidence"] for term in sorted(classes)[:2])
`);
});

test('C9 localiza chaves reais de packages em JSON compacto, inclusive escapadas', () => {
  const result = JSON.parse(python(String.raw`
import json
from unittest.mock import patch
from collector import Report
from license_policy import inspect_lock

source = r"""{
"lockfileVersion":2,
"packages":{"":{},"node_modules\/compact":{"license":"GPL-3.0-only"},
  "node_modules/fixture": {"license":"MIT"}},
"other":{
  "node_modules/compact":{"license":"MIT"}
}}"""
report = Report()
with patch("license_policy.classify", side_effect=lambda value: ("permissiva", value)):
    assert inspect_lock(source, "MIT", "package-lock.json", report) == [
        ("node_modules/compact", "GPL-3.0-only", 3), ("node_modules/fixture", "MIT", 4)]
print(json.dumps(report.output()))
`));
  assert.deepEqual(result.findings.map((row: {line: number}) => row.line), [3, 4]);
  assert.ok(result.findings.every((row: {line: number}) => row.line !== 1 && row.line !== 6));
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
