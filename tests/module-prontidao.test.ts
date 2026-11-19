import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {auditRepositoryReadiness, collectRepoFiles, parseComposeServices, redactEvidence} from '../deploy/modules/prontidao/audit-readiness.mjs';
import {
  evaluatePassiveTlsEvidence,
  parseGitleaksJson,
  parseHadolintJson,
  parseTestsslJson,
  parseTrivyConfigJson,
  runCollector,
  validateTargetUrl,
} from '../deploy/modules/prontidao/run-collector.mjs';

const moduleDir = fileURLToPath(new URL('../deploy/modules/prontidao/', import.meta.url));
const defectiveDir = fileURLToPath(new URL('./fixtures/module-prontidao/defective', import.meta.url));
const cleanDir = fileURLToPath(new URL('./fixtures/module-prontidao/clean', import.meta.url));

const VALID_SEVERITIES = new Set(['alta', 'media', 'baixa', 'informativa']);
const VALID_STATUSES = new Set(['ok', 'failed', 'skipped']);

test('tools.lock.json e Dockerfile fixam versões, digests e usuário sem privilégio', () => {
  const lock = JSON.parse(readFileSync(join(moduleDir, 'tools.lock.json'), 'utf8')) as {
    baseImage: {digest: string; platformDigest: string};
    tools: {name: string; version: string; license: string; url: string; sha256: string}[];
  };
  assert.match(lock.baseImage.digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(lock.baseImage.platformDigest, /^sha256:[a-f0-9]{64}$/);
  const names = new Set(lock.tools.map(t => t.name));
  for (const required of ['testssl.sh', 'gitleaks', 'hadolint', 'trivy']) {
    assert.equal(names.has(required), true, `ferramenta ausente no lockfile: ${required}`);
  }
  for (const tool of lock.tools) {
    assert.ok(tool.version.length > 0);
    assert.ok(tool.license.length > 0);
    assert.match(tool.url, /^https:\/\//);
    assert.match(tool.sha256, /^[a-f0-9]{64}$/);
  }

  const dockerfile = readFileSync(join(moduleDir, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /FROM\s+(?:--platform=linux\/amd64\s+)?node@sha256:[a-f0-9]{64}/);
  assert.doesNotMatch(dockerfile, /:latest\b/);
  assert.match(dockerfile, /USER\s+65532:65532/);
  assert.match(dockerfile, /ENTRYPOINT\s+\["\/usr\/local\/bin\/prontidao-entrypoint\.sh"\]/);

  const entrypoint = readFileSync(join(moduleDir, 'entrypoint.sh'), 'utf8');
  assert.match(entrypoint, /unset\s+"\$name"/);
  assert.match(entrypoint, /AC_PRONTIDAO_EVIDENCE_FILE/);
  assert.match(entrypoint, /\/run\/prontidao-evidence\.json/);
  assert.match(entrypoint, /\*\.\.\*/);
  assert.match(entrypoint, /\*\.sock\*/);
  assert.match(entrypoint, /PRONTIDAO_SOCKET_FORBIDDEN/);
  assert.match(entrypoint, /export HOME=\/tmp/);

  const collectorSrc = readFileSync(join(moduleDir, 'run-collector.mjs'), 'utf8');
  assert.equal(collectorSrc.includes('--sneaky'), false);
});

test('auditRepositoryReadiness detecta todos os defeitos plantados e mascara segredos', () => {
  const res = auditRepositoryReadiness(defectiveDir);
  assert.ok(res.filesAnalyzed >= 6);
  const rules = new Set(res.findings.map(f => f.rule));
  for (const expected of [
    'PRONTIDAO-TLS-DESATIVADO',
    'PRONTIDAO-CABECALHO-HSTS-AUSENTE',
    'PRONTIDAO-TLS-VERIFICACAO-DESABILITADA',
    'PRONTIDAO-BACKUP-AUSENTE',
    'PRONTIDAO-PROVA-RESTAURACAO-AUSENTE',
    'PRONTIDAO-LOG-SEM-ROTACAO',
    'PRONTIDAO-ALERTA-AUSENTE',
    'PRONTIDAO-REINICIO-AUTOMATICO-AUSENTE',
    'PRONTIDAO-HEALTHCHECK-COMPOSE-AUSENTE',
    'PRONTIDAO-SYSTEMD-REINICIO-AUSENTE',
    'PRONTIDAO-LIMITE-MEMORIA-AUSENTE',
    'PRONTIDAO-LIMITE-PIDS-AUSENTE',
    'PRONTIDAO-SYSTEMD-MEMORIA-AUSENTE',
    'PRONTIDAO-DISCO-SEM-MONITORAMENTO',
    'PRONTIDAO-SEGREDO-ARQUIVO-ENV',
    'PRONTIDAO-SEGREDO-COMPOSE-INLINE',
    'PRONTIDAO-SEGREDO-SYSTEMD-INLINE',
  ]) {
    assert.equal(rules.has(expected), true, `regra ausente nos achados: ${expected}`);
  }

  const serialized = JSON.stringify(res);
  for (const secret of [
    'lab-defective-db-pass-98765',
    'lab-defective-systemd-secret-12345',
    '-----BEGIN PRIVATE KEY-----' + '!'.repeat(64) + 'KEY-----',
    'synthetic_db_pass_987654321',
  ]) {
    assert.equal(serialized.includes(secret), false, 'segredo bruto vazou na saída');
  }

  for (const f of res.findings) {
    assert.equal(VALID_SEVERITIES.has(f.severity), true);
    assert.equal(Number.isInteger(f.line) && f.line >= 1, true);
    assert.equal(f.file.startsWith('/') || f.file.includes('..'), false);
  }
  assert.ok(res.coverage.some(c => c.tool === 'prontidao-audit' && c.status === 'ok'));
  assert.equal(res.coverage.filter(c => c.tool.startsWith('prontidao:requisito:')).length, 6);
  assert.ok(res.coverage.some(c => c.tool === 'prontidao:arquivo'));
});

test('auditRepositoryReadiness não acusa defeitos no controle limpo', () => {
  const res = auditRepositoryReadiness(cleanDir);
  assert.deepEqual(res.findings, []);
  assert.ok(res.filesAnalyzed >= 10);
  const reqRows = res.coverage.filter(c => c.tool.startsWith('prontidao:requisito:'));
  assert.equal(reqRows.length, 6);
  for (const row of reqRows) {
    assert.equal(row.status, 'ok');
    assert.match(row.detail, /0 achado\(s\)/);
  }
  assert.match(
    reqRows.find(r => r.tool === 'prontidao:requisito:backup-restauracao')?.detail ?? '',
    /restauração real não comprovada/,
  );
  assert.match(
    reqRows.find(r => r.tool === 'prontidao:requisito:alertas-logs')?.detail ?? '',
    /entrega real de alertas não comprovada/,
  );
  assert.match(
    reqRows.find(r => r.tool === 'prontidao:requisito:reinicio-automatico')?.detail ?? '',
    /disponibilidade real não comprovada/,
  );
});

test('collectRepoFiles ignora symlinks e parseComposeServices preserva linhas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-symlink-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'ok.ts'), 'export const ok = true;\n');
    symlinkSync(join(cleanDir, 'package.json'), join(dir, 'src', 'leak.txt'));
    const files = collectRepoFiles(dir);
    assert.deepEqual(files.map(f => f.rel), ['src/ok.ts']);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }

  const services = parseComposeServices(
    'services:\n  api:\n    image: node:22\n    restart: unless-stopped\n    mem_limit: 512m\n    pids_limit: 64\n    healthcheck:\n      test: ["CMD", "true"]\n    logging:\n      driver: json-file\n      options:\n        max-size: "10m"\n        max-file: "3"\n',
  );
  assert.equal(services.length, 1);
  assert.equal(services[0]?.line, 2);
  assert.equal(services[0]?.hasMemLimit, true);
  assert.equal(services[0]?.hasPidsLimit, true);
  assert.equal(services[0]?.hasHealthcheck, true);
  assert.equal(services[0]?.hasLogMaxSize, true);
  assert.equal(services[0]?.hasLogMaxFile, true);
  assert.equal(redactEvidence('DATABASE_URL=postgres://app:segredo123@db.local:5432/app').includes('segredo123'), false);
});

test('normalizadores e runCollector reportam cobertura, achados, skipped offline e falha de ferramenta', () => {
  assert.throws(() => validateTargetUrl('https://user:pass@example.com'));
  assert.throws(() => validateTargetUrl('ftp://example.com'));
  assert.throws(() => validateTargetUrl('http://localhost/var/run/docker.sock'));
  assert.equal(validateTargetUrl('https://app.example.com')?.origin, 'https://app.example.com');

  const gl = parseGitleaksJson(JSON.stringify([{
    RuleID: 'generic-api-key',
    Description: 'Detected API key',
    StartLine: 3,
    File: '/repo/.env',
    Secret: 'my-secret-value-12345',
  }]), '/repo', 'package.json');
  assert.equal(gl.length, 1);
  assert.equal(gl[0]?.file, '.env');
  assert.equal(gl[0]?.line, 3);
  assert.equal(JSON.stringify(gl).includes('my-secret-value-12345'), false);

  const hl = parseHadolintJson(JSON.stringify([{
    line: 4,
    code: 'DL3002',
    message: 'Last USER should not be root',
    file: '/repo/Dockerfile',
    level: 'warning',
  }]), '/repo', 'package.json');
  assert.equal(hl[0]?.file, 'Dockerfile');
  assert.equal(hl[0]?.severity, 'media');

  const tr = parseTrivyConfigJson(JSON.stringify({
    Results: [{
      Target: 'Dockerfile',
      Misconfigurations: [{
        ID: 'DS026',
        AVDID: 'AVD-DS-0026',
        Title: 'No HEALTHCHECK defined',
        Severity: 'LOW',
        Status: 'FAIL',
        CauseMetadata: {StartLine: 1},
      }],
    }],
  }), '/repo', 'package.json');
  assert.equal(tr.findings.length, 1);
  assert.equal(tr.findings[0]?.severity, 'baixa');
  assert.equal(tr.findings[0]?.line, 1);

  const ts = parseTestsslJson(JSON.stringify([
    {id: 'TLS1', ip: '127.0.0.1', port: '443', severity: 'HIGH', finding: 'TLS 1.0 offered'},
    {id: 'TLS1_3', ip: '127.0.0.1', port: '443', severity: 'OK', finding: 'offered'},
    {id: 'HSTS', ip: '127.0.0.1', port: '443', severity: 'MEDIUM', finding: 'No HSTS header'},
  ]), cleanDir, 'deploy/caddy/site.caddy');
  assert.equal(ts.length, 2);
  assert.equal(ts[0]?.severity, 'alta');
  assert.equal(ts[1]?.severity, 'media');

  const collectWithTrivyStatus = (trivyStatus: number) => runCollector({
    repoRoot: defectiveDir,
    evidenceFile: '',
    runBin(bin, args, options) {
      if (args[0] === 'version') return {status: 0, stdout: '8.30.1\n', stderr: ''};
      if (args[0] === '--version') {
        if (bin === 'hadolint') return {status: 0, stdout: 'Haskell Dockerfile Linter 2.15.1\n', stderr: ''};
        if (bin === 'trivy') return {status: 0, stdout: 'Version: 0.76.2\n', stderr: ''};
        if (bin === 'testssl.sh') return {status: 0, stdout: 'testssl.sh version 3.2.5\n', stderr: ''};
      }
      if (bin === 'gitleaks') {
        const reportPath = args[args.indexOf('--report-path') + 1]!;
        writeFileSync(reportPath, '[]\n');
        return {status: 0, stdout: '', stderr: ''};
      }
      if (bin === 'hadolint') {
        return {status: 0, stdout: JSON.stringify([{line: 4, code: 'DL3002', message: 'Last USER should not be root', file: join(defectiveDir, 'Dockerfile'), level: 'warning'}]), stderr: ''};
      }
      if (bin === 'trivy') {
        const cwd = options?.cwd;
        assert.ok(cwd);
        assert.equal(statSync(cwd).mode & 0o077, 0);
        const reportPath = join(cwd, 'trivy-config.json');
        assert.deepEqual(args, [
          'config', '--skip-check-update', '--skip-version-check', '--disable-telemetry', '--quiet',
          '--cache-dir', join(cwd, 'trivy-cache'), '--format', 'json', '--output', reportPath, defectiveDir,
        ]);
        writeFileSync(reportPath, JSON.stringify({
          Results: [{
            Target: 'Dockerfile',
            Misconfigurations: [{AVDID: 'AVD-DS-0026', Status: 'FAIL', Severity: 'LOW'}],
          }],
        }));
        return {status: trivyStatus, stdout: '', stderr: ''};
      }
      return {status: 0, stdout: '', stderr: ''};
    },
  });

  const success = collectWithTrivyStatus(0);
  const trivySuccess = success.coverage.find(c => c.tool === 'trivy');
  assert.equal(trivySuccess?.version, '0.76.2');
  assert.equal(trivySuccess?.status, 'ok');
  assert.ok(success.findings.some(f => f.tool === 'trivy' && f.rule === 'AVD-DS-0026' && f.file === 'Dockerfile'));

  const out = collectWithTrivyStatus(1);
  for (const row of out.coverage) {
    assert.equal(VALID_STATUSES.has(row.status), true);
    assert.ok(row.version.length > 0);
    assert.ok(row.detail.length > 0);
  }
  const trivyRow = out.coverage.find(c => c.tool === 'trivy');
  assert.equal(trivyRow?.status, 'failed');
  assert.match(trivyRow.detail, /exit=1/);
  assert.equal(out.findings.some(f => f.tool === 'trivy'), false);
  const passiveTlsRow = out.coverage.find(c => c.tool === 'prontidao-tls-passivo');
  assert.equal(passiveTlsRow?.status, 'skipped');
  const testsslRow = out.coverage.find(c => c.tool === 'testssl.sh');
  assert.equal(testsslRow?.status, 'skipped');
  for (const opTool of [
    'prontidao:operacional:restauracao',
    'prontidao:operacional:alertas',
    'prontidao:operacional:disponibilidade',
  ]) {
    assert.equal(out.coverage.find(c => c.tool === opTool)?.status, 'skipped');
  }
  assert.ok(out.coverage.some(c => c.tool === 'gitleaks' && c.status === 'ok'));
  assert.ok(out.coverage.some(c => c.tool === 'hadolint' && c.status === 'ok'));
});

test('runCollector extrai versão colorida de testssl e não inventa versão ausente', () => {
  const cases = [
    {stdout: '\u001b[1m\n     testssl.sh version \u001b[1m3.2.5\u001b[0m from https://testssl.sh/\n', status: 0, expected: '3.2.5'},
    {stdout: '\u001b[1m\nversão indisponível\u001b[0m\nOpenSSL 3.0.0\n', status: 0, expected: 'desconhecida'},
    {stdout: 'testssl.sh version 3.2.5\n', status: 1, expected: 'desconhecida'},
    {stdout: '', status: 0, expected: 'desconhecida'},
  ];
  for (const scenario of cases) {
    const calls: string[][] = [];
    const out = runCollector({
      repoRoot: defectiveDir,
      evidenceFile: '',
      runBin(bin, args) {
        if (bin === 'testssl.sh') {
          calls.push(args);
          return {status: scenario.status, stdout: scenario.stdout, stderr: ''};
        }
        return {status: 1, stdout: '', stderr: ''};
      },
    });
    const row = out.coverage.find(c => c.tool === 'testssl.sh');
    assert.equal(row?.version, scenario.expected);
    assert.equal(row?.status, 'skipped');
    assert.doesNotMatch(row!.version, /[\u0000-\u001f\u007f-\u009f]/);
    assert.deepEqual(calls, [['--version']]);
    const envFinding = out.findings.find(f => f.rule === 'PRONTIDAO-SEGREDO-ARQUIVO-ENV');
    assert.equal(envFinding?.file, '.env');
    assert.equal(envFinding?.evidence, 'Localização informada pelo coletor; conteúdo protegido.');
    assert.equal(JSON.stringify(out).includes('synthetic_db_pass_987654321'), false);
  }
});

test('evaluatePassiveTlsEvidence avalia evidência estruturada e recusa arquivo dentro do repo', () => {
  const cleanEval = evaluatePassiveTlsEvidence({
    schemaVersion: 1,
    collectedBy: 'agent-control-prontidao-adapter',
    collectedAt: '2026-11-19T00:00:00.000Z',
    targets: [{
      origin: 'https://app.example.com',
      status: 'ok',
      httpStatus: 200,
      tlsProtocol: 'TLSv1.3',
      cipher: 'TLS_AES_256_GCM_SHA384',
      tlsAuthorized: true,
      tlsErrorCode: null,
      tlsErrorMessage: null,
      errorCode: null,
      errorMessage: null,
      certificate: {subject: 'CN=app.example.com', issuer: 'CN=Test CA', validFrom: '2026-01-01', validTo: '2027-01-01', daysRemaining: 90, subjectAltName: 'DNS:app.example.com'},
      headers: {
        'strict-transport-security': 'max-age=31536000; includeSubDomains',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
      },
      redirectTargetOrigin: null,
      redirectCrossOrigin: false,
      redirectDowngradeHttp: false,
      bytesRead: 512,
      truncated: false,
      durationMs: 25,
    }],
  }, cleanDir, 'deploy/caddy/site.caddy');
  assert.deepEqual(cleanEval.findings, []);
  assert.equal(cleanEval.coverage[0]?.status, 'ok');

  const brokenEval = evaluatePassiveTlsEvidence({
    schemaVersion: 1,
    collectedBy: 'agent-control-prontidao-adapter',
    collectedAt: '2026-11-19T00:00:00.000Z',
    targets: [
      {
        origin: 'https://expired.example.com',
        status: 'tls_error',
        httpStatus: null,
        tlsProtocol: null,
        cipher: null,
        tlsAuthorized: false,
        tlsErrorCode: 'CERT_HAS_EXPIRED',
        tlsErrorMessage: 'certificate has expired',
        errorCode: null,
        errorMessage: null,
        certificate: null,
        headers: {},
        redirectTargetOrigin: null,
        redirectCrossOrigin: false,
        redirectDowngradeHttp: false,
        bytesRead: 0,
        truncated: false,
        durationMs: 12,
      },
      {
        origin: 'https://weak.example.com',
        status: 'ok',
        httpStatus: 302,
        tlsProtocol: 'TLSv1.2',
        cipher: 'ECDHE-RSA-AES128-GCM-SHA256',
        tlsAuthorized: true,
        tlsErrorCode: null,
        tlsErrorMessage: null,
        errorCode: null,
        errorMessage: null,
        certificate: {subject: 'CN=weak.example.com', issuer: 'CN=Test CA', validFrom: '2026-01-01', validTo: '2026-11-25', daysRemaining: 6, subjectAltName: 'DNS:weak.example.com'},
        headers: {'strict-transport-security': 'max-age=60'},
        redirectTargetOrigin: 'http://weak.example.com',
        redirectCrossOrigin: true,
        redirectDowngradeHttp: true,
        bytesRead: 0,
        truncated: false,
        durationMs: 18,
      },
    ],
  }, cleanDir, 'deploy/caddy/site.caddy');
  const rules = new Set(brokenEval.findings.map(f => f.rule));
  assert.equal(rules.has('PRONTIDAO-CERT-EXPIRADO'), true);
  assert.equal(rules.has('PRONTIDAO-CERT-EXPIRANDO'), true);
  assert.equal(rules.has('PRONTIDAO-REDIR-HTTP'), true);
  assert.equal(rules.has('PRONTIDAO-HSTS-FRACO'), true);
  assert.equal(rules.has('PRONTIDAO-NOSNIFF-AUSENTE'), true);
  assert.equal(rules.has('PRONTIDAO-FRAME-AUSENTE'), true);

  assert.throws(() => evaluatePassiveTlsEvidence({
    schemaVersion: 1,
    collectedBy: 'untrusted-repo-script',
    collectedAt: '2026-11-19T00:00:00.000Z',
    targets: [],
  }, cleanDir, 'deploy/caddy/site.caddy'));

  const insideRepoOut = runCollector({
    repoRoot: cleanDir,
    evidenceFile: join(cleanDir, 'package.json'),
    runBin(bin, args) {
      if (args[0] === 'version') return {status: 0, stdout: '8.30.1\n', stderr: ''};
      if (args[0] === '--version') {
        if (bin === 'hadolint') return {status: 0, stdout: 'Haskell Dockerfile Linter 2.15.1\n', stderr: ''};
        if (bin === 'trivy') return {status: 0, stdout: 'Version: 0.76.2\n', stderr: ''};
        if (bin === 'testssl.sh') return {status: 0, stdout: 'testssl.sh version 3.2.5\n', stderr: ''};
      }
      if (bin === 'gitleaks') {
        writeFileSync(args[args.indexOf('--report-path') + 1]!, '[]\n');
        return {status: 0, stdout: '', stderr: ''};
      }
      if (bin === 'hadolint') return {status: 0, stdout: '[]', stderr: ''};
      if (bin === 'trivy') {
        writeFileSync(args[args.indexOf('--output') + 1]!, '{"Results":[]}\n');
        return {status: 0, stdout: '', stderr: ''};
      }
      return {status: 0, stdout: '', stderr: ''};
    },
  });
  assert.equal(insideRepoOut.coverage.find(c => c.tool === 'prontidao-tls-passivo')?.status, 'failed');
});

test('nginx com TLS legado e backup em /tmp são detectados sem executar scripts do repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-nginx-'));
  try {
    mkdirSync(join(dir, 'deploy', 'nginx'), {recursive: true});
    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'package.json'), '{"name":"ngx","version":"1.0.0"}\n');
    writeFileSync(
      join(dir, 'deploy', 'nginx', 'site.conf'),
      'server {\n  listen 443 ssl;\n  ssl_protocols TLSv1 TLSv1.1 TLSv1.2;\n}\n',
    );
    writeFileSync(
      join(dir, 'scripts', 'backup.sh'),
      '#!/bin/sh\npg_dump -Fc -f /tmp/backup.dump "$DATABASE_URL"\n',
    );
    const res = auditRepositoryReadiness(dir);
    const rules = new Set(res.findings.map(f => f.rule));
    assert.equal(rules.has('PRONTIDAO-TLS-PROTOCOLO-FRACO'), true);
    assert.equal(rules.has('PRONTIDAO-CABECALHO-HSTS-AUSENTE'), true);
    assert.equal(rules.has('PRONTIDAO-BACKUP-DESTINO-INSEGURO'), true);
    assert.equal(rules.has('PRONTIDAO-PROVA-RESTAURACAO-AUSENTE'), true);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
