import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from '../src/contracts.ts';
import {redactText, redactUnknownSecrets, secretPreview} from '../src/verify-redact.ts';
import {normalizeToolOutput} from '../src/verify-normalize.ts';
import {RawFinding, type VerifySeverity} from '../src/verify-types.ts';

const fixtureDir = fileURLToPath(new URL('./fixtures/verify-tool-output/', import.meta.url));
const akia = 'AKIAIOSFODNN7EXAMPLE';
const generic = 's3cr3t-valor-ficticio-998877';

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureDir, name), 'utf8')) as unknown;
}

function token(secret: string): string {
  const preview = secretPreview(secret);
  return `${preview.preview} (sha256:${preview.sha256})`;
}

test('secretPreview mostra os quatro primeiros caracteres e o sha256 do valor inteiro', () => {
  const preview = secretPreview(akia);
  assert.equal(preview.preview, `AKIA${'\u2026'}`);
  assert.equal(preview.sha256, createHash('sha256').update(akia, 'utf8').digest('hex'));
  assert.equal(preview.preview.includes(akia), false);
});

test('redactText troca cada ocorrência e prefere o segredo mais longo', () => {
  const once = token(generic);
  assert.equal(redactText(`inicio ${generic} meio ${generic} fim`, [generic]), `inicio ${once} meio ${once} fim`);
  assert.equal(redactText('abc', ['']), 'abc');
  const outer = `xx${akia}yy`;
  assert.equal(redactText(outer, [akia, outer]), token(outer));
  assert.equal(redactText(outer, [akia, outer]).includes(akia), false);
});

test('redactUnknownSecrets mascara token e bloco PEM sem devolver o valor', () => {
  assert.equal(redactUnknownSecrets(`veja ${generic}`), `veja ${generic}`);
  const ghp = `ghp_${'a'.repeat(36)}`;
  const pat = `github_pat_${'b'.repeat(22)}`;
  const sk = `sk-${'c'.repeat(32)}`;
  const xox = 'xoxb-1234567890-abcdefghij';
  const pem = [
    '-----BEGIN PRIVATE KEY-----',
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7example',
    '-----END PRIVATE KEY-----',
  ].join('\n');
  const out = redactUnknownSecrets([`key=${akia};`, ghp, pat, sk, xox, pem].join('\n'));
  for (const secret of [akia, ghp, pat, sk, xox, pem]) {
    assert.equal(out.includes(secret), false, secret.slice(0, 6));
    assert.equal(out.includes(secretPreview(secret).sha256), true);
    assert.equal(out.includes(secretPreview(secret).preview), true);
  }
  assert.equal(out.includes('BEGIN PRIVATE KEY'), false);
  assert.match(out, new RegExp(`^key=AKIA${'\u2026'} \\(sha256:[a-f0-9]{64}\\);`));
});

test('normaliza SARIF e JSON sem duplicar fingerprint e sem vazar segredo', () => {
  const gitleaks = load('gitleaks.json') as {Secret?: string}[];
  assert.equal(gitleaks[0]?.Secret, akia);
  const syft = load('syft.json') as {artifacts: unknown[]};
  assert.ok(syft.artifacts.length >= 1);
  const result = normalizeToolOutput([
    {tool: 'gitleaks', format: 'json', body: gitleaks},
    {tool: 'gitleaks', format: 'json', body: load('gitleaks-findings.json')},
    {tool: 'osv-scanner', format: 'json', body: load('osv-scanner.json')},
    {tool: 'grype', format: 'json', body: load('grype.json')},
    {tool: 'trivy', format: 'json', body: load('trivy.json')},
    {tool: 'syft', format: 'json', body: syft},
    {tool: 'opengrep', format: 'json', body: load('opengrep.json')},
    {tool: 'hadolint', format: 'json', body: load('hadolint.json')},
    {tool: 'checkov', format: 'json', body: load('checkov.json')},
    {tool: 'semgrep', format: 'sarif', body: load('semgrep.sarif.json')},
  ]);
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes(akia), false);
  assert.equal(encoded.includes(generic), false);
  assert.equal(encoded.includes(secretPreview(akia).preview), true);
  assert.equal(encoded.includes(secretPreview(akia).sha256), true);
  assert.equal(encoded.includes(secretPreview(generic).sha256), true);
  const expected: {tool: string; rule: string; severity: VerifySeverity; file: string; line: number | null; cwe: string | null; snippet: string}[] = [
    {tool: 'gitleaks', rule: 'aws-access-key', severity: 'media', file: 'config/credenciais.env', line: 8, cwe: null, snippet: `Chave ${token(akia)} no arquivo`},
    {tool: 'gitleaks', rule: 'generic-api-key', severity: 'media', file: 'config/api.env', line: 21, cwe: null, snippet: `Token ${token(generic)}`},
    {tool: 'gitleaks', rule: 'aws-access-key-embrulhado', severity: 'media', file: 'config/embrulhado.env', line: 3, cwe: null, snippet: `Embrulho ${token(akia)}`},
    {tool: 'osv-scanner', rule: 'GHSA-fict-icio-0001', severity: 'alta', file: 'package-lock.json', line: null, cwe: 'CWE-1321', snippet: 'minimist@1.2.5 GHSA-fict-icio-0001 Poluição de protótipo'},
    {tool: 'osv-scanner', rule: 'GHSA-fict-icio-0002', severity: 'media', file: 'package-lock.json', line: null, cwe: null, snippet: 'pacote-grupo@0.1.0 GHSA-fict-icio-0002'},
    {tool: 'grype', rule: 'CVE-2024-12345', severity: 'media', file: 'apk/installed', line: null, cwe: 'CWE-611', snippet: 'libxml2 CVE-2024-12345'},
    {tool: 'grype', rule: 'CVE-2023-0001', severity: 'baixa', file: 'lib/apk/db/installed', line: null, cwe: null, snippet: 'openssl CVE-2023-0001 Falha antiga fictícia'},
    {tool: 'trivy', rule: 'CVE-2024-35195', severity: 'alta', file: 'requirements.txt', line: null, cwe: 'CWE-200', snippet: 'requests CVE-2024-35195 Falha fictícia de sessão'},
    {tool: 'trivy', rule: 'CVE-2024-99999', severity: 'alta', file: 'pom.xml', line: null, cwe: 'CWE-917', snippet: 'log4j CVE-2024-99999'},
    {tool: 'opengrep', rule: 'javascript.lang.security.audit.xss.direct-response-write', severity: 'alta', file: 'src/pagina.ts', line: 15, cwe: 'CWE-79', snippet: 'Entrada do usuário vai para a resposta HTML. res.send(entrada)'},
    {tool: 'hadolint', rule: 'DL3008', severity: 'media', file: 'Containerfile', line: 4, cwe: null, snippet: 'Fixe a versão dos pacotes.'},
    {tool: 'hadolint', rule: 'DL3059', severity: 'informativa', file: 'Containerfile', line: 9, cwe: null, snippet: 'Várias instruções RUN seguidas.'},
    {tool: 'checkov', rule: 'CKV_AWS_20', severity: 'baixa', file: '/main.tf', line: 12, cwe: null, snippet: 'O bucket não bloqueia ACL pública'},
    {tool: 'semgrep', rule: 'regra.injecao', severity: 'alta', file: 'src/consulta.ts', line: 40, cwe: 'CWE-89', snippet: 'Consulta SQL concatenada. consulta(entrada)'},
    {tool: 'semgrep', rule: 'regra.prop', severity: 'media', file: 'src/prop.ts', line: 7, cwe: 'CWE-22', snippet: 'Propriedade com CWE.'},
    {tool: 'semgrep', rule: 'regra.da-regra', severity: 'baixa', file: 'src/regra.ts', line: 5, cwe: 'CWE-502', snippet: 'CWE na regra.'},
    {tool: 'semgrep', rule: 'regra.nota', severity: 'baixa', file: 'src/nota.ts', line: 2, cwe: null, snippet: 'Nota sem CWE.'},
    {tool: 'semgrep', rule: 'regra.nenhuma', severity: 'informativa', file: 'src/info.ts', line: 1, cwe: null, snippet: 'Nível nenhum.'},
  ];
  assert.equal(result.rejected, 7);
  assert.equal(result.findings.length, expected.length, result.findings.map(item => `${item.tool}:${item.rule}`).join(','));
  assert.equal(new Set(result.findings.map(item => item.fingerprint)).size, result.findings.length);
  assert.equal(result.findings.some(item => item.tool === 'syft' || item.rule === 'regra.sem-arquivo' || item.rule === 'DL3000' || item.snippet.includes('não deve aparecer')), false);
  for (const item of expected) {
    const found = result.findings.filter(finding => finding.tool === item.tool && finding.rule === item.rule);
    assert.equal(found.length, 1, `${item.tool}:${item.rule}`);
    const finding = found[0];
    assert.ok(finding);
    RawFinding.parse(finding);
    assert.equal(finding.severity, item.severity);
    assert.equal(finding.file, item.file);
    assert.equal(finding.line, item.line);
    assert.equal(finding.cwe, item.cwe);
    assert.equal(finding.snippet, item.snippet);
    assert.ok(finding.snippet.length <= 180);
    assert.equal(finding.fingerprint, digest({tool: finding.tool, rule: finding.rule, file: finding.file, line: finding.line, cwe: finding.cwe}));
  }
});
