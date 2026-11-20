import assert from 'node:assert/strict';
import childProcess, {type SpawnSyncOptionsWithStringEncoding} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
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
import {parseModuleCollectorOutput, validateModuleCollectorPublication, writeModuleReport} from '../src/verification-modules.ts';
import {hasKnownSecret} from '../src/verify-redact.ts';

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
    /prova de restauração requer execução/,
  );
  assert.match(
    reqRows.find(r => r.tool === 'prontidao:requisito:alertas-logs')?.detail ?? '',
    /entrega de alertas exige verificação/,
  );
  assert.match(
    reqRows.find(r => r.tool === 'prontidao:requisito:reinicio-automatico')?.detail ?? '',
    /disponibilidade exige observação/,
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
        redirectTargetOrigin: 'http://synthetic-tenant.example.invalid',
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
  assert.equal(JSON.stringify(brokenEval).includes('synthetic-tenant'), false);

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

test('segredos em formatos de Compose, systemd e dotenv aparecem somente por localização', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-secret-metadata-'));
  try {
    writeFileSync(join(dir, 'compose.yml'), [
      'services:',
      '  maps:',
      '    environment:',
      String.raw`      APP_PASSWORD: "synthetic-map-first \"synthetic-map-second\""`,
      "      APP_TOKEN: 'synthetic-single-first ''synthetic-single-second'''",
      '      APP_API_KEY: >-',
      '        synthetic-block-first',
      '        # synthetic-block-second',
      '      CONTROL_TOKEN: ${MOUNTED_TOKEN}',
      '  lists:',
      '    environment:',
      String.raw`      - "APP_PASSWORD=synthetic-list-first \\ synthetic-list-second"`,
      "      - 'CONTROL_PASSWORD=changeme'",
      '  flow: {environment: ["APP_PASSWORD=synthetic-flow-first synthetic-flow-second"]}',
      "  flowmap: {environment: {'APP_TOKEN': 'synthetic-flowmap-first synthetic-flowmap-second'}}",
    ].join('\n'));
    writeFileSync(join(dir, '.env'), [
      'export APP_TOKEN="synthetic-dotenv-first synthetic-dotenv-second"',
      'APP_SECRET: synthetic-colon-first synthetic-colon-second',
      'CONTROL_PASSWORD=${INJECTED_PASSWORD} # referência',
    ].join('\n'));
    writeFileSync(join(dir, 'app.service'), [
      '[Service]',
      'Restart=on-failure',
      'MemoryMax=128M',
      String.raw`Environment="APP_TOKEN=synthetic-systemd-first \"synthetic-systemd-second\"" 'APP_PASSWORD=synthetic-unit-first synthetic-unit-second' ` + '\\',
      '# comentário entre linhas da diretiva',
      String.raw`    APP_SECRET=synthetic-escape-first\ssynthetic-escape-second`,
    ].join('\n'));
    const out = runCollector({
      repoRoot: dir,
      evidenceFile: '',
      runBin(bin, args) {
        if (bin === 'gitleaks' && args[0] === 'dir') {
          const staged = join(args.at(-1)!, 'checkout', '.env');
          assert.equal(readFileSync(staged, 'utf8'), readFileSync(join(dir, '.env'), 'utf8'));
          writeFileSync(args[args.indexOf('--report-path') + 1]!, JSON.stringify([{
            RuleID: 'generic-api-key', File: staged, StartLine: 1,
            Secret: 'synthetic-gitleaks-first synthetic-gitleaks-second',
            Match: 'synthetic-match-first synthetic-match-second',
          }]));
          return {status: 0, stdout: '', stderr: ''};
        }
        if (bin === 'trivy' && args[0] === 'config') {
          writeFileSync(args[args.indexOf('--output') + 1]!, JSON.stringify({
            Results: [{Target: '.env', Secrets: [{
              RuleID: 'generic-api-key', StartLine: 2, Match: 'synthetic-trivy-first synthetic-trivy-second',
            }]}],
          }));
          return {status: 0, stdout: '', stderr: ''};
        }
        return {status: 1, stdout: '', stderr: ''};
      },
    });
    const secrets = out.findings.filter(f => f.rule.startsWith('PRONTIDAO-SEGREDO-'));
    const linesFor = (file: string) => secrets.filter(f => f.file === file).map(f => f.line).sort((a, b) => a - b);
    assert.deepEqual(linesFor('compose.yml'), [4, 5, 6, 12, 14, 15]);
    assert.deepEqual(linesFor('app.service'), [4, 4, 4]);
    assert.deepEqual(linesFor('.env'), [1, 2]);
    assert.equal(out.findings.filter(f => ['gitleaks', 'trivy'].includes(f.tool)).length, 2);
    assert.ok(secrets.every(f => f.evidence === 'Localização informada pelo coletor; conteúdo protegido.'));
    assert.equal(/synthetic-[a-z]+-(?:first|second)/.test(JSON.stringify(out)), false);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('Compose e systemd reconhecem políticas efetivas de reinício e healthchecks desativados', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-compose-state-'));
  try {
    writeFileSync(join(dir, 'compose.yml'), [
      'services:',
      '  disabled:',
      '    restart: always',
      '    deploy: {restart_policy: {condition: none}}',
      '    healthcheck: {disable: true, test: ["CMD", "true"]}',
      '  none:',
      '    restart: "no"',
      '    deploy:',
      '      restart_policy:',
      '    healthcheck: {test: [NONE]}',
      '  enabled:',
      '    deploy:',
      '      restart_policy:',
      '        delay: 2s',
      '    healthcheck:',
      '      disable: false',
      '      test:',
      '        - CMD',
      '        - "true"',
      '  explicit: {restart: "on-failure:3", healthcheck: {test: "true"}}',
    ].join('\n'));
    writeFileSync(join(dir, 'app.service'), [
      '[Unit]', 'Restart=always', '[Service]', 'Restart=on-failure', 'Restart=no', 'MemoryMax=128M',
    ].join('\n'));
    const findings = auditRepositoryReadiness(dir).findings;
    for (const rule of ['PRONTIDAO-REINICIO-AUTOMATICO-AUSENTE', 'PRONTIDAO-HEALTHCHECK-COMPOSE-AUSENTE']) {
      assert.deepEqual(findings.filter(f => f.rule === rule).map(f => f.line), [2, 6]);
    }
    assert.deepEqual(findings.filter(f => f.rule === 'PRONTIDAO-SYSTEMD-REINICIO-AUSENTE').map(f => f.line), [3]);
    assert.equal(parseComposeServices('{"services":{"app":{"restart":"always","healthcheck":{"test":["CMD","true"]}}}}')[0]?.hasHealthcheck, true);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('documentação, comentários e texto de shell não contam como rotinas de backup ou restauração', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-backup-declaration-'));
  try {
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(dir, 'README.md'), '# Rotinas planejadas\npg_dump\npg_restore\n');
    writeFileSync(join(dir, 'notes.sh'), [
      '#!/bin/sh', '# pg_dump -f /var/backups/example.dump', 'echo "pg_dump e pg_restore"',
      "cat <<'NOTES'", 'pg_dump', 'pg_restore', 'NOTES',
      'cat <<EOF>/dev/null', 'pg_dump -f fixture.dump', ' EOF',
      'pg_restore -d synthetic_db fixture.dump', 'EOF',
      "cat 3<<-'FIRST' 4<<SEC\"OND\" >/dev/null",
      'pg_dump -f fixture.dump', '\tFIRST',
      '\tSECOND', 'pg_restore -d synthetic_db fixture.dump', 'SECOND',
      'cat <<CO\\', 'NTINUED>/dev/null',
      'CO', 'pg_dump -f fixture.dump', 'CONTINUED',
      'cat <<"EN\\"D">/dev/null', 'pg_dump -f fixture.dump', 'EN"D',
    ].join('\n'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({description: 'pg_dump', scripts: {notes: 'echo pg_restore'}}));
    const absent = ['PRONTIDAO-BACKUP-AUSENTE', 'PRONTIDAO-PROVA-RESTAURACAO-AUSENTE'];
    assert.ok(absent.every(rule => auditRepositoryReadiness(dir).findings.some(f => f.rule === rule)));
    writeFileSync(join(dir, 'backup.service'), '[Service]\nType=oneshot\nExecStart=/usr/bin/pg_dump -f /var/backups/app.dump\n');
    writeFileSync(join(dir, 'restore.sh'), '#!/bin/sh\npg_restore --exit-on-error -d fixture /var/backups/app.dump\n');
    assert.ok(absent.every(rule => !auditRepositoryReadiness(dir).findings.some(f => f.rule === rule)));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('Here-docs distinguem delimitadores físicos, continuados e citados de comandos de backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-heredoc-'));
  try {
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    const script = join(dir, 'backup.sh');
    const audit = (lines: string[]) => {
      writeFileSync(script, ['#!/bin/bash', ...lines, ''].join('\n'));
      return auditRepositoryReadiness(dir);
    };
    const requirement = (out: ReturnType<typeof audit>) => out.coverage.find(c => c.tool === 'prontidao:requisito:backup-restauracao');
    const backupMissing = (out: ReturnType<typeof audit>) => out.findings.some(f => f.rule === 'PRONTIDAO-BACKUP-AUSENTE');
    const textOnly = audit([
      'cat <<EOF', 'texto\\', 'EOF', 'pg_dump -f fixture.dump', 'EOF',
      'cat <<-EOF', '\ttexto' + '\\'.repeat(3), '\tEOF', 'pg_dump -f fixture.dump', '\tEOF',
      'cat <<EOF', 'EOF\r', 'pg_dump -f fixture.dump', 'EOF',
      'cat <<EOF\u00a0text', 'EOF', 'pg_dump -f fixture.dump', 'EOF\u00a0text',
    ]);
    assert.equal(backupMissing(textOnly), true);
    assert.equal(requirement(textOnly)?.status, 'ok');

    for (const lines of [
      ['cat <<EOF', 'EO\\', 'F'],
      ['cat <<EOF', 'text' + '\\'.repeat(2), 'EOF'],
      ["cat <<'EOF'", 'text\\', 'EOF'],
      ['cat <<\\EOF', 'text\\', 'EOF'],
      ["cat <<'END${fixture:-with spaces}'", 'END${fixture:-with', 'pg_dump -f ignored.dump', 'END${fixture:-with spaces}'],
      ["cat <<'END$[1 + 2]'", 'END$[1', 'pg_dump -f ignored.dump', 'END$[1 + 2]'],
      ['cat <<EOF # comentário com barra\\', 'pg_dump -f ignored.dump', 'EOF'],
    ]) {
      const result = audit([...lines, 'pg_dump -f declared.dump']);
      assert.equal(backupMissing(result), false);
      assert.equal(requirement(result)?.status, 'ok');
      assert.deepEqual(result.findings.filter(f => f.rule === 'PRONTIDAO-BACKUP-DESTINO-INSEGURO').map(f => f.line),
        [lines.length + 2]);
      assert.doesNotMatch(JSON.stringify(result), /ignored\.dump|declared\.dump/);
    }

    const compoundDelimiter = [
      "cat <<'END'${fixture:-with spaces}", 'END${fixture:-with', 'pg_dump -f fixture.dump', 'END${fixture:-with spaces}',
    ];
    for (const lines of [
      ['cat <<EOF', 'text\\', 'EOF', 'pg_dump -f fixture.dump'],
      ["cat <<$'EOF'", 'pg_dump -f fixture.dump', 'EOF'],
      compoundDelimiter,
      ["cat <<'END'$[1 + 2]", 'END$[1', 'pg_dump -f fixture.dump', 'END$[1 + 2]'],
      ['cat <<EOF | wc -l', 'pg_dump -f fixture.dump', 'EOF'],
    ]) {
      const result = audit(lines);
      assert.equal(backupMissing(result), false);
      assert.equal(requirement(result)?.status, 'failed');
      assert.ok(result.coverage.some(c => c.status === 'failed' && c.detail.startsWith('backup.sh: linha 2,')));
      assert.equal(result.findings.some(f => f.rule === 'PRONTIDAO-BACKUP-DESTINO-INSEGURO'), false);
    }
    const knownPrefix = audit(['pg_dump -f /var/backups/fixture.dump', ...compoundDelimiter, 'pg_dump -f later.dump']);
    assert.equal(backupMissing(knownPrefix), false);
    assert.ok(knownPrefix.coverage.some(c => c.status === 'failed' && c.detail.startsWith('backup.sh: linha 3,')));
    assert.equal(knownPrefix.findings.some(f => f.rule === 'PRONTIDAO-BACKUP-DESTINO-INSEGURO'), false);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('Nginx aplica protocolo exato e redirecionamento somente no bloco correspondente', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-nginx-blocks-'));
  try {
    writeFileSync(join(dir, 'nginx.conf'), [
      'http {',
      '  server { listen 443 ssl; ssl_protocols TLSv1.2 TLSv1.3; }',
      '  server { listen 80; return 308 https://$host$request_uri; }',
      '  server {',
      '    listen 0.0.0.0:80; # return 301 https://exemplo.invalid;',
      '    location /example { return 301 https://exemplo.invalid; }',
      '  }',
      '  server { listen [::]:80; return 301 "https://${host}$request_uri"; }',
      '  server { listen 443 ssl; ssl_protocols TLSv1.1 TLSv1.3; }',
      '}',
    ].join('\n'));
    const findings = auditRepositoryReadiness(dir).findings;
    assert.deepEqual(findings.filter(f => f.rule === 'PRONTIDAO-TLS-PROTOCOLO-FRACO').map(f => f.line), [9]);
    assert.deepEqual(findings.filter(f => f.rule === 'PRONTIDAO-TLS-DESATIVADO').map(f => f.line), [5]);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('a cobertura estática aponta subárvores, arquivos e cotas com análise parcial', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-cobertura-'));
  try {
    const deep = Array.from({length: 11}, (_, i) => `d${i}`).join('/');
    mkdirSync(join(dir, deep), {recursive: true});
    writeFileSync(join(dir, deep, 'fora.ts'), '');
    writeFileSync(join(dir, 'grande.yml'), Buffer.alloc(1024 * 1024 + 1));
    symlinkSync(join(dir, 'grande.yml'), join(dir, 'link.yml'));
    for (let i = 0; i < 4001; i++) writeFileSync(join(dir, `src-${String(i).padStart(4, '0')}.ts`), '');
    const out = auditRepositoryReadiness(dir);
    assert.equal(out.coverage.find(c => c.tool === 'prontidao-audit')?.status, 'failed');
    assert.ok(out.coverage.some(c => c.status === 'failed' && c.detail.includes(deep) && c.detail.includes('profundidade')));
    assert.ok(out.coverage.some(c => c.status === 'failed' && c.detail.startsWith('grande.yml:')));
    assert.ok(out.coverage.some(c => c.status === 'skipped' && c.detail.startsWith('link.yml:')));
    assert.ok(out.coverage.some(c => c.status === 'failed' && c.detail.includes('src-3999.ts') && c.detail.includes('4000 arquivos')));
    assert.equal(out.coverage.filter(c => c.tool === 'prontidao:arquivo' && c.status === 'ok').length, 3999);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('publicação de prontidão mantém achados no escopo medido e conserva as lacunas', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-publicacao-parcial-'));
  const compose = join(dir, 'compose.yaml');
  const collect = () => runCollector({
    repoRoot: dir,
    evidenceFile: '',
    runBin(bin, args) {
      if (args[0] === 'version' || args[0] === '--version') {
        return {status: 0, stdout: 'Version: 1.0.0', stderr: ''};
      }
      if (bin === 'gitleaks') writeFileSync(args[args.indexOf('--report-path') + 1]!, '[]');
      if (bin === 'trivy') writeFileSync(args[args.indexOf('--output') + 1]!, '{"Results":[]}');
      return {status: 0, stdout: '[]', stderr: ''};
    },
  });
  const restartRule = 'PRONTIDAO-REINICIO-AUTOMATICO-AUSENTE';
  const globalAbsences = [
    'PRONTIDAO-ALERTA-AUSENTE', 'PRONTIDAO-DISCO-SEM-MONITORAMENTO', 'PRONTIDAO-LOGROTATE-AUSENTE',
  ];
  const parse = (out: ReturnType<typeof collect>) => parseModuleCollectorOutput(JSON.stringify(out), {module: 'prontidao'});
  const worker = join(dir, 'worker.service');
  const workerUnit = '[Service]\nType=oneshot\nStandardOutput=append:/var/log/fixture.log\n';
  try {
    writeFileSync(compose, [
      'services:', '  api:', '    image: scratch',
      '    logging:', '      driver: fixture-local', '',
    ].join('\n'));
    writeFileSync(join(dir, 'backup.sh'), '#!/bin/sh\ncat <<$\'EOF\'\npg_dump -f ignored.dump\nEOF\n');
    writeFileSync(worker, workerUnit);
    writeFileSync(join(dir, '.env'), 'FIXTURE_MODE=example\n');
    writeFileSync(join(dir, 'fixture(notes).ts'), 'export const enabled = true;\n');
    symlinkSync('compose.yaml', join(dir, 'ignored.yaml'));
    const partial = collect();
    const publication = parse(partial);
    await validateModuleCollectorPublication(dir, publication);
    const restart = partial.findings.find(f => f.tool === 'prontidao-audit' && f.rule === restartRule
      && f.file === 'compose.yaml' && f.line === 2);
    assert.ok(restart);
    assert.equal(publication.findings.some(f => f.file === 'worker.service'), false);
    const auditRows = publication.coverage.filter(c => c.tool === 'prontidao-audit');
    assert.deepEqual(auditRows.map(c => c.status), ['failed', 'ok']);
    assert.equal(auditRows[0]?.files, undefined);
    assert.deepEqual(auditRows[1]?.files, ['compose.yaml', 'worker.service']);

    const scoped = {...auditRows[1]!, files: ['compose.yaml']};
    const outside = {...restart, rule: 'PRONTIDAO-SYSTEMD-REINICIO-AUSENTE', file: 'worker.service', line: 1};
    const failedForWorker = {...auditRows[0]!, files: ['worker.service']};
    const otherTool = {...scoped, tool: 'gitleaks', files: ['worker.service']};
    for (const rows of [[scoped], [scoped, failedForWorker, otherTool], [{...scoped, files: []}]]) {
      await assert.rejects(validateModuleCollectorPublication(dir, {coverage: rows, findings: [outside]}),
        {code: 'VERIFY_COLLECTOR_INVALID'});
    }
    await validateModuleCollectorPublication(dir, {coverage: [scoped], findings: [restart]});
    await validateModuleCollectorPublication(dir, {
      coverage: [{...otherTool, files: undefined}],
      findings: [{...outside, tool: otherTool.tool}],
    });

    assert.equal(partial.coverage.find(c => c.tool === 'prontidao:requisito:alertas-logs')?.status, 'failed');
    assert.equal(partial.coverage.find(c => c.tool === 'prontidao:requisito:backup-restauracao')?.status, 'failed');
    assert.ok(partial.coverage.some(c => c.tool === 'prontidao:arquivo' && c.status === 'failed'
      && c.detail.startsWith('compose.yaml:')));
    assert.ok(partial.coverage.some(c => c.tool === 'prontidao:arquivo' && c.status === 'skipped'
      && c.detail.startsWith('ignored.yaml:')));
    assert.equal(partial.findings.some(f => [
      'PRONTIDAO-LOG-SEM-ROTACAO', 'PRONTIDAO-BACKUP-AUSENTE', 'PRONTIDAO-PROVA-RESTAURACAO-AUSENTE',
      'PRONTIDAO-LOGROTATE-AUSENTE', 'PRONTIDAO-ALERTA-AUSENTE',
    ].includes(f.rule)), false);

    rmSync(worker);
    writeFileSync(compose, 'services:\n  api:\n    <<: *unresolved\n');
    const unresolved = collect();
    assert.deepEqual(unresolved.findings, []);
    assert.deepEqual(unresolved.coverage.filter(c => c.tool === 'prontidao-audit').map(c => c.status), ['failed']);

    rmSync(compose);
    const failureOnly = collect();
    assert.deepEqual(failureOnly.findings, []);
    assert.deepEqual(failureOnly.coverage.filter(c => c.tool === 'prontidao-audit').map(c => c.status), ['failed']);

    rmSync(join(dir, 'backup.sh'));
    rmSync(join(dir, 'ignored.yaml'));
    writeFileSync(worker, workerUnit);
    writeFileSync(compose, 'services:\n  api:\n    image: scratch\n');
    const complete = collect();
    assert.ok(complete.findings.some(f => f.rule === restartRule));
    assert.ok(complete.findings.some(f => f.rule === 'PRONTIDAO-BACKUP-AUSENTE'));
    assert.ok(globalAbsences.every(rule => complete.findings.some(f => f.rule === rule)));
    assert.deepEqual(complete.coverage.filter(c => c.tool === 'prontidao-audit').map(c => c.status), ['ok']);
    assert.equal(complete.coverage.some(c => c.status === 'failed'), false);
    await validateModuleCollectorPublication(dir, parse(complete));

    const unparsed = join(dir, 'compose.extra.yaml');
    writeFileSync(unparsed, 'services:\n  worker:\n    <<: *unresolved\n');
    const mixed = collect();
    await validateModuleCollectorPublication(dir, parse(mixed));
    assert.equal(mixed.findings.some(f => [
      'PRONTIDAO-BACKUP-AUSENTE', 'PRONTIDAO-PROVA-RESTAURACAO-AUSENTE', ...globalAbsences,
    ].includes(f.rule)), false);
    assert.ok(mixed.findings.some(f => f.rule === restartRule && f.file === 'compose.yaml'));
    assert.deepEqual(mixed.coverage.find(c => c.tool === 'prontidao-audit' && c.status === 'ok')?.files,
      ['compose.yaml', 'worker.service']);
    for (const requirement of ['backup-restauracao', 'alertas-logs', 'reinicio-automatico', 'disco-memoria', 'segredos-fora-codigo']) {
      assert.equal(mixed.coverage.find(c => c.tool === `prontidao:requisito:${requirement}`)?.status, 'failed');
    }
    rmSync(unparsed);

    const unread = join(dir, 'oversized.sh');
    writeFileSync(unread, '');
    truncateSync(unread, 1024 * 1024 + 1);
    const omitted = collect();
    assert.ok(omitted.findings.some(f => f.rule === restartRule));
    assert.equal(omitted.findings.some(f => [
      'PRONTIDAO-BACKUP-AUSENTE', 'PRONTIDAO-PROVA-RESTAURACAO-AUSENTE',
      ...globalAbsences,
    ].includes(f.rule)), false);
    assert.ok(omitted.coverage.some(c => c.tool === 'prontidao:arquivo' && c.status === 'failed'
      && c.detail.startsWith('oversized.sh:')));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('adaptadores recusam relatórios inválidos sem publicar mensagens brutas dos binários', () => {
  const malformed = 'synthetic-tool-data-first synthetic-tool-data-second';
  for (const bad of ['{}', '', '[{}]', '[null]', '{"bad":"shape"}']) {
    assert.throws(() => parseHadolintJson(bad, '/repo', 'Dockerfile'));
  }
  for (const bad of ['{}', '', '{"Results":42}', '{"Results":[null]}', '{"Results":[{"Target":"Dockerfile","Misconfigurations":42}]}']) {
    assert.throws(() => parseTrivyConfigJson(bad, '/repo', 'Dockerfile'));
  }
  assert.deepEqual(parseTrivyConfigJson('{"SchemaVersion":2,"ArtifactName":"/repo","ArtifactType":"filesystem"}', '/repo', 'Dockerfile'), {findings: [], targets: []});
  const out = runCollector({
    repoRoot: cleanDir,
    evidenceFile: '',
    runBin(bin, args) {
      if (bin === 'trivy' && args[0] === 'config') {
        writeFileSync(args[args.indexOf('--output') + 1]!, malformed);
      }
      if (bin === 'gitleaks' && args[0] === 'dir') {
        writeFileSync(args[args.indexOf('--report-path') + 1]!, '{"findings":42}');
      }
      return {status: 0, stdout: malformed, stderr: malformed};
    },
  });
  for (const bin of ['gitleaks', 'hadolint', 'trivy']) {
    assert.equal(out.coverage.find(c => c.tool === bin)?.status, 'failed');
  }
  assert.equal(JSON.stringify(out).includes('synthetic-tool-data'), false);
});

test('Gitleaks usa configuração fixa, isola políticas do repositório e anuncia o escopo de arquivos', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-gitleaks-source-'));
  try {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.gitleaks.toml'), '# configuração de fixture\n');
    writeFileSync(join(dir, '.gitleaksignore'), '# exclusões de fixture\n');
    writeFileSync(join(dir, 'source.txt'), 'dados fictícios\n');
    symlinkSync(join(dir, 'source.txt'), join(dir, 'link.txt'));
    const out = runCollector({
      repoRoot: dir,
      evidenceFile: '',
      runBin(bin, args, options) {
        if (bin !== 'gitleaks' || args[0] !== 'dir') return {status: 1, stdout: '', stderr: ''};
        const config = args[args.indexOf('--config') + 1]!;
        assert.equal(readFileSync(config, 'utf8'), '[extend]\nuseDefault = true\n');
        assert.equal(args[args.indexOf('--gitleaks-ignore-path') + 1], options?.cwd);
        assert.ok(args.includes('--ignore-gitleaks-allow'));
        assert.ok(args.includes('--redact=100'));
        const source = args.at(-1)!;
        assert.throws(() => statSync(join(source, '.gitleaksignore')), /ENOENT/);
        assert.throws(() => statSync(join(source, 'checkout', '.git')), /ENOENT/);
        assert.throws(() => statSync(join(source, 'checkout', 'link.txt')), /ENOENT/);
        assert.ok(statSync(join(source, 'checkout', '.gitleaksignore')).isFile());
        writeFileSync(args[args.indexOf('--report-path') + 1]!, JSON.stringify([
          {File: join(source, 'checkout', 'source.txt'), RuleID: 'generic-api-key', StartLine: 1},
        ]));
        return {status: 0, stdout: '', stderr: ''};
      },
    });
    assert.equal(out.findings.find(f => f.tool === 'gitleaks')?.file, 'source.txt');
    assert.equal(out.coverage.find(c => c.tool === 'gitleaks')?.status, 'ok');
    assert.equal(out.coverage.find(c => c.tool === 'gitleaks:historico')?.status, 'skipped');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('HTTPS passivo distingue cabeçalhos inválidos e registra origens que excedem a cota', () => {
  const omitted = 'https://fora-da-cota.example.invalid';
  const evaluate = (hsts: string, xfo: string, csp = '') => evaluatePassiveTlsEvidence({
    schemaVersion: 1,
    collectedBy: 'agent-control-prontidao-adapter',
    unmeasuredOrigins: [omitted],
    targets: [{
      origin: 'https://passivo.example.invalid',
      status: 'ok',
      httpStatus: 200,
      tlsProtocol: 'TLSv1.3',
      headers: {
        'strict-transport-security': hsts,
        'x-content-type-options': 'nosniff',
        'x-frame-options': xfo,
        'content-security-policy': csp,
      },
    }],
  }, cleanDir, 'deploy/caddy/site.caddy');
  for (const hsts of ['max-age=31536000abc', 'max-age=31536000; max-age=0', 'prefix max-age=31536000', 'max-age=31536000, max-age=31536000']) {
    const invalid = evaluate(hsts, 'synthetic-invalid-frame');
    assert.deepEqual(invalid.findings.map(f => f.rule), ['PRONTIDAO-HSTS-FRACO', 'PRONTIDAO-FRAME-AUSENTE']);
    assert.equal(JSON.stringify(invalid).includes('synthetic-invalid-frame'), false);
  }
  const valid = evaluate('max-age="31536000"; includeSubDomains', 'SAMEORIGIN');
  assert.deepEqual(valid.findings, []);
  assert.deepEqual(valid.coverage.map(row => row.status), ['ok', 'skipped']);
  assert.ok(valid.coverage[1]?.detail.includes(omitted));
  assert.deepEqual(evaluate('max-age=31536000', 'inválido', "default-src 'self'; frame-ancestors 'none'").findings, []);
  assert.deepEqual(evaluate('max-age=31536000', 'inválido', "default-src 'self' frame-ancestors").findings.map(f => f.rule), ['PRONTIDAO-FRAME-AUSENTE']);
});

test('dotenv multilinha e âncoras inline do Compose preservam apenas as localizações', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-inline-'));
  try {
    const compose = [
      'services: &services {',
      '  web: &service {',
      '    environment: &env {',
      '      SYNTHETIC_KEY_PASSWORD: &value "synthetic-value-one",',
      '      OTHER_TOKEN: "synthetic-value-two",',
      '    },',
      '  },',
      '  list: {environment: &list ["LIST_TOKEN=synthetic-value-three"]}',
      '}',
    ].join('\n');
    const backtick = String.fromCharCode(96);
    const dotenv = [
      'export APP_TOKEN="synthetic-dotenv-start',
      'FAKE_PASSWORD=synthetic-dotenv-interior',
      '# synthetic-dotenv-end" # fim',
      'export APP_SECRET=',
      "APP_PASSWORD='",
      "synthetic-dotenv-multiline'",
      'OTHER_TOKEN=$' + '{INJECTED_TOKEN}',
      'APP_API_KEY=' + backtick + 'synthetic-dotenv-backtick',
      backtick,
    ].join('\n');
    writeFileSync(join(dir, 'compose.yml'), compose);
    writeFileSync(join(dir, '.env'), dotenv);
    const result = auditRepositoryReadiness(dir);
    const secretLines = (file: string) => result.findings
      .filter(f => f.file === file && f.rule.startsWith('PRONTIDAO-SEGREDO-')).map(f => f.line);
    assert.deepEqual(secretLines('.env'), [1, 5, 8]);
    assert.deepEqual(secretLines('compose.yml'), [4, 5, 8]);
    const services = parseComposeServices(compose);
    assert.deepEqual(services.map(svc => svc.environment), [[{line: 4}, {line: 5}], [{line: 8}]]);
    assert.doesNotMatch(JSON.stringify([services, result]), /synthetic-(?:dotenv|value)|SYNTHETIC_KEY_PASSWORD/);

    writeFileSync(join(dir, 'compose.yml'), [
      'x-env: &base {APP_TOKEN: dummy}',
      'services:',
      '  web:',
      '    environment:',
      '      <<: *base',
      '      DIRECT_TOKEN: &direct |-',
      '        synthetic-value-block',
      '      OTHER_TOKEN: *direct',
      '    extends: {file: other.yml, service: web}',
    ].join('\n'));
    const partial = auditRepositoryReadiness(dir);
    assert.ok(partial.coverage.some(c => c.status === 'failed' && c.detail.startsWith('compose.yml:')));
    assert.ok(partial.findings.some(f => f.rule === 'PRONTIDAO-SEGREDO-COMPOSE-INLINE' && f.line === 6));
    assert.equal(partial.findings.some(f => f.rule === 'PRONTIDAO-LIMITE-MEMORIA-AUSENTE'), false);
    assert.doesNotMatch(JSON.stringify(partial), /synthetic-value-block/);
    assert.deepEqual(partial.coverage.find(c => c.tool === 'prontidao-audit' && c.status === 'ok')?.files,
      ['.env', 'compose.yml']);
    const publication = parseModuleCollectorOutput(JSON.stringify({coverage: partial.coverage, findings: partial.findings}),
      {module: 'prontidao'});
    await validateModuleCollectorPublication(dir, publication);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('Compose exige valores positivos e válidos para memória, PIDs e rotação', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-compose-limites-'));
  try {
    writeFileSync(join(dir, 'compose.yml'), [
      'services:',
      '  zero: {mem_limit: 0, pids_limit: -1, logging: {options: {max-size: 0m, max-file: 0}}}',
      '  bad: {mem_limit: 15bananas, pids_limit: 2.5, logging: {options: {max-size: unlimited, max-file: "1.5"}}}',
      '  unset: {mem_limit: null, pids_limit: null, logging: {options: {max-size: null, max-file: null}}}',
      '  overflow: {mem_limit: 9007199254740992b, pids_limit: 9007199254740992, logging: {options: {max-size: 1e5, max-file: 1abc}}}',
      '  valid: {mem_limit: 64MB, pids_limit: "64", logging: {options: {max-size: "8MB", max-file: "3"}}}',
      '  alternative: {deploy: {resources: {limits: {memory: 512m, pids: 16}}}, logging: {options: {max-size: 256k, max-file: 1}}}',
      '  conflict: {mem_limit: 1m, pids_limit: 1, deploy: {resources: {limits: {memory: 512m, pids: 16}}}, logging: {driver: null}}',
    ].join('\n'));
    const result = auditRepositoryReadiness(dir);
    for (const rule of ['PRONTIDAO-LIMITE-MEMORIA-AUSENTE', 'PRONTIDAO-LIMITE-PIDS-AUSENTE', 'PRONTIDAO-LOG-SEM-ROTACAO']) {
      assert.deepEqual(result.findings.filter(f => f.rule === rule).map(f => f.line), [2, 3, 4, 5, 8]);
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('Compose respeita chaves de fluxo YAML e os valores literais do driver de logs', () => {
  let incomplete = false;
  const [ambiguous] = parseComposeServices('services: {app: {mem_limit:64m, pids_limit:64}}', () => { incomplete = true; });
  assert.equal(incomplete, true);
  assert.equal(ambiguous?.hasMemLimit, false);
  assert.equal(ambiguous?.hasPidsLimit, false);
  const [compact] = parseComposeServices('{services:{app:{"mem_limit":64m,"pids_limit":64}}}');
  assert.equal(compact?.hasMemLimit, true);
  assert.equal(compact?.hasPidsLimit, true);
  assert.deepEqual(parseComposeServices('services:{app: {mem_limit: 64m}}'), []);
  const [tabSize, binarySize] = parseComposeServices(
    'services: {tab: {logging: {options: {max-size: "8\\tm"}}}, binary: {logging: {options: {max-size: 8KiB}}}}',
  );
  assert.equal(tabSize?.hasLogMaxSize, false);
  assert.equal(binarySize?.hasLogMaxSize, true);

  const dir = mkdtempSync(join(tmpdir(), 'prontidao-compose-literais-'));
  try {
    writeFileSync(join(dir, 'compose.yml'), [
      'services:',
      '  clipped:',
      '    logging: {driver: json-file, options: {max-size: 8m, max-file: "2\\n"}}',
      '  block:',
      '    logging:',
      '      driver: local',
      '      options:',
      '        max-size: 8m',
      '        max-file: |',
      '          2',
      '  sized:',
      '    logging:',
      '      options:',
      '        max-size: |+',
      '          8m',
      '        max-file: "3"',
      '  stripped:',
      '    logging:',
      '      driver: |-',
      '        json-file',
      '      options:',
      '        max-size: >-',
      '          8m',
      '        max-file: |2-',
      '          +2',
      '  indented:',
      '    logging:',
      '      options:',
      '        max-size: 8m',
      '        max-file: |2-',
      '           2',
      '  driver: {logging: {driver: " JSON-FILE "}}',
      '  external: {logging: {driver: journald}}',
      '  disabled: {logging: {driver: none}}',
      '  final:',
      '    logging:',
      '      options:',
      '        max-size: 8m',
      '        max-file: |',
      '          2',
    ].join('\n'));
    const result = auditRepositoryReadiness(dir);
    assert.deepEqual(result.findings.filter(f => f.rule === 'PRONTIDAO-LOG-SEM-ROTACAO').map(f => f.line), [2, 4, 11, 26]);
    assert.ok(result.coverage.some(c => c.status === 'failed' && /linha 32,/.test(c.detail)));
    assert.ok(result.coverage.some(c => c.status === 'skipped' && /linha 33,/.test(c.detail)));
    assert.ok(result.coverage.some(c => c.status === 'skipped' && /linha 34,/.test(c.detail)));
    assert.equal(result.coverage.find(c => c.tool === 'prontidao:requisito:alertas-logs')?.status, 'failed');
    assert.equal(result.coverage.find(c => c.tool === 'prontidao:requisito:disco-memoria')?.status, 'ok');
    assert.doesNotMatch(JSON.stringify(result), /JSON-FILE/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('Compose consome blocos dobrados de metadados e mantém as verificações dos serviços', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-compose-extensao-'));
  try {
    const file = join(dir, 'compose.yaml');
    const metadata = [
      'x-description: &notes >-',
      '  descrição sintética',
      '  restart: always',
      'services:',
      '  api:',
      '    image: scratch',
      '    x-notes: >-',
      '      outra descrição',
      '      pids_limit: 128',
      '    logging:',
      '      x-notes: >-',
      '        max-size: 10m',
      '        max-file: 3',
    ];
    const footer = [
      'x-after: >-',
      '  primeira linha',
      '  segunda linha',
    ];
    writeFileSync(file, [...metadata, ...footer].join('\n'));
    const out = auditRepositoryReadiness(dir);
    const serviceRules = [
      'PRONTIDAO-REINICIO-AUTOMATICO-AUSENTE', 'PRONTIDAO-HEALTHCHECK-COMPOSE-AUSENTE',
      'PRONTIDAO-LOG-SEM-ROTACAO', 'PRONTIDAO-LIMITE-MEMORIA-AUSENTE', 'PRONTIDAO-LIMITE-PIDS-AUSENTE',
    ];
    assert.deepEqual(out.findings.filter(f => serviceRules.includes(f.rule)).map(f => [f.rule, f.line]),
      serviceRules.map(rule => [rule, 5]));
    assert.ok(out.coverage.some(c => c.status === 'ok' && c.detail.startsWith('compose.yaml: verificações [compose')));
    assert.equal(out.coverage.some(c => c.status === 'failed'), false);

    for (const auditedSetting of [
      ['    restart: *notes'],
      ['    restart: >-', '      unless-', '      stopped'],
    ]) {
      writeFileSync(file, [...metadata, ...auditedSetting, ...footer].join('\n'));
      const partial = auditRepositoryReadiness(dir);
      assert.ok(partial.coverage.some(c => c.status === 'failed' && c.detail.startsWith('compose.yaml:')));
      assert.equal(partial.coverage.find(c => c.tool === 'prontidao:requisito:reinicio-automatico')?.status, 'failed');
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('Compose limita a cobertura de extensões de raiz às referências nos serviços', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-compose-ancora-'));
  try {
    const file = join(dir, 'compose.yaml');
    const audit = (note: string, ...serviceSettings: string[]) => {
      writeFileSync(file, [
        'x-notes: &unused',
        '  logging:',
        `    driver: ${note}`,
        'services:',
        '  api:',
        '    image: scratch',
        ...serviceSettings,
      ].join('\n'));
      return auditRepositoryReadiness(dir);
    };
    for (const note of ['local', '!!str local']) {
      const result = audit(note);
      assert.equal(result.coverage.some(c => c.status === 'failed'), false);
      assert.deepEqual(result.findings.filter(f => f.rule === 'PRONTIDAO-LOG-SEM-ROTACAO').map(f => f.line), [5]);
    }
    const partial = audit('!!str local', '    <<: *unused');
    assert.ok(partial.coverage.some(c => c.status === 'failed' && c.detail.startsWith('compose.yaml:')));
    assert.equal(partial.coverage.find(c => c.tool === 'prontidao:requisito:alertas-logs')?.status, 'failed');

    writeFileSync(file, 'x-restart: &restart/v1 always\nservices:\n  api:\n    image: scratch\n    restart: *restart/v1\n');
    const alias = auditRepositoryReadiness(dir);
    assert.equal(alias.coverage.find(c => c.tool === 'prontidao:requisito:reinicio-automatico')?.status, 'failed');
    assert.equal(alias.findings.some(f => f.rule === 'PRONTIDAO-REINICIO-AUTOMATICO-AUSENTE'), false);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('Compose deixa os serviços indeterminados quando a extensão de raiz contém YAML incompleto', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-compose-extensao-incompleta-'));
  try {
    const services = ['services:', '  api:', '    image: scratch'];
    const audit = (lines: string[]) => {
      writeFileSync(join(dir, 'compose.yaml'), [...lines, ''].join('\n'));
      return auditRepositoryReadiness(dir);
    };
    const restart = (out: ReturnType<typeof audit>) => out.coverage.find(c => c.tool === 'prontidao:requisito:reinicio-automatico');
    const restartFinding = 'PRONTIDAO-REINICIO-AUTOMATICO-AUSENTE';
    for (const [notes, serviceLine] of [
      [['x-notes:', '  metadata: {enabled: true,', '    labels: [fixture]}'], 5],
      [['x-notes:', '  metadata: {label: !<tag:example.invalid,2026:note> fixture} # !<>'], 4],
      [['x-notes:', '  - - [fixture]'], 4],
      [['x-notes:', '  metadata: {label: "!<>", other: \'!<>\'} # !<>'], 4],
      [['x-notes:', '  metadata: |', '    !<>', '  other: texto !<>'], 6],
    ] as const) {
      const result = audit([...notes, ...services]);
      assert.equal(restart(result)?.status, 'ok');
      assert.deepEqual(result.findings.filter(f => f.rule === restartFinding).map(f => f.line), [serviceLine]);
      assert.ok(result.coverage.some(c => c.status === 'ok' && c.detail.startsWith('compose.yaml: verificações [compose')));
    }
    const invalid = [
      ['x-notes:', '  - - [fixture'],
      ['x-notes:', '  metadata: !<tag:example.invalid,2026:note fixture'],
      ['x-notes:', '  metadata: !<> fixture'],
      ['x-notes:', '  metadata: {label: [!<> fixture]}'],
      ['x-notes:', '  ? !<> label', '  : fixture'],
    ];
    for (const lines of [
      ['x-notes:', '  metadata: {enabled: true', ...services],
      [...services, 'x-notes:', '  - metadata: [fixture'],
      ['x-notes:', '  metadata: "anotação', ...services],
      ...invalid.flatMap(notes => [[...notes, ...services], [...services, ...notes]]),
    ]) {
      const result = audit(lines);
      assert.ok(result.coverage.some(c => c.status === 'failed' && c.detail.startsWith('compose.yaml:')));
      assert.equal(result.coverage.some(c => c.status === 'ok' && c.detail.startsWith('compose.yaml: verificações [compose')), false);
      for (const requirement of ['backup-restauracao', 'alertas-logs', 'reinicio-automatico', 'disco-memoria', 'segredos-fora-codigo']) {
        assert.equal(result.coverage.find(c => c.tool === `prontidao:requisito:${requirement}`)?.status, 'failed');
      }
      assert.equal(result.findings.some(f => f.rule === restartFinding), false);
      assert.doesNotMatch(JSON.stringify(result), /tag:example\.invalid|!<>/);
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('Caddy e Nginx auditam o bloco efetivo e declaram imports ou rotas não resolvidos', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-proxy-'));
  try {
    writeFileSync(join(dir, 'Caddyfile'), [
      'http://redirect.example.invalid {',
      '  redir https://{host}{uri} permanent',
      '}',
      'http://open.example.invalid, http://localhost {',
      '  redir /somewhere https://other.example.invalid',
      '  respond "redir https://synthetic-text.example.invalid # parte da resposta"',
      '}',
      'https://secure.example.invalid {',
      '  header Strict-Transport-Security "max-age=31536000"',
      '  header X-Content-Type-Options nosniff',
      '  header X-Frame-Options DENY',
      '}',
      'https://unresolved.example.invalid {',
      '  import fragment.caddy',
      '}',
    ].join('\n'));
    writeFileSync(join(dir, 'nginx.conf'), [
      'http {',
      '  add_header Strict-Transport-Security "max-age=31536000" always;',
      '  add_header X-Content-Type-Options nosniff always;',
      '  add_header X-Frame-Options DENY always;',
      '  ssl_protocols TLSv1 TLSv1.2;',
      '  server { listen 8443 ssl; location / { try_files $uri =404; } }',
      '  server {',
      '    listen 443 ssl;',
      '    ssl_protocols TLSv1.2 TLSv1.3;',
      '    location /override { add_header X-Other data; }',
      '    location /merge { add_header_inherit merge; add_header X-Other data; }',
      '    location /off { add_header_inherit off; }',
      '    location /external { include synthetic.conf; }',
      '  }',
      '  server { listen 443 ssl; add_header X-Content-Type-Options nosniff; }',
      '  server { listen 80; if ($host) { return 200; } return 301 https://$host$request_uri; }',
      '}',
    ].join('\n'));
    const result = auditRepositoryReadiness(dir);
    const locations = (rule: string) => result.findings.filter(f => f.rule === rule).map(f => [f.file, f.line]);
    assert.deepEqual(locations('PRONTIDAO-TLS-DESATIVADO'), [['Caddyfile', 4]]);
    assert.deepEqual(locations('PRONTIDAO-TLS-PROTOCOLO-FRACO'), [['nginx.conf', 6], ['nginx.conf', 15]]);
    for (const rule of ['PRONTIDAO-CABECALHO-HSTS-AUSENTE', 'PRONTIDAO-CABECALHO-SEGURANCA-AUSENTE']) {
      assert.deepEqual(locations(rule), [['nginx.conf', 10], ['nginx.conf', 12], ['nginx.conf', 15]]);
    }
    for (const [file, line] of [['Caddyfile', 13], ['nginx.conf', 13], ['nginx.conf', 16]]) {
      assert.ok(result.coverage.some(c => c.status === 'failed' && c.detail.startsWith(file + ': linha ' + line)));
    }
    assert.doesNotMatch(JSON.stringify(result), /synthetic-text|synthetic\.conf/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('Proxies avaliam porta, ordem de reescrita e aplicação dos cabeçalhos por resposta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-proxy-resposta-'));
  try {
    writeFileSync(join(dir, 'Caddyfile'), [
      ':8080 {',
      '  respond "fixture"',
      '}',
      'http://fixture.example.invalid:8081 {',
      '  redir https://fixture.example.invalid 303',
      '}',
      'https://fixture.example.invalid {',
      '  header -Strict-Transport-Security',
      '  header Strict-Transport-Security "max-age=31536000"',
      '  header X-Content-Type-Options nosniff',
      '  header X-Frame-Options DENY',
      '}',
      'https://fixture-zero.example.invalid {',
      '  header >Strict-Transport-Security "max-age=0"',
      '  header X-Content-Type-Options nosniff',
      '  header X-Frame-Options DENY',
      '}',
      'https://fixture-conditional.example.invalid {',
      '  header @fixture Strict-Transport-Security "max-age=0"',
      '}',
    ].join('\n'));
    writeFileSync(join(dir, 'nginx.conf'), [
      'http {',
      '  add_header Strict-Transport-Security "max-age=31536000";',
      '  add_header X-Content-Type-Options nosniff;',
      '  add_header X-Frame-Options DENY;',
      '  server { listen 80; break; return 301 https://fixture.example.invalid; }',
      '  server { listen 8080; return 200; }',
      '  server { listen 443; return 200; }',
      '  server { listen 8081; return 303 https://fixture.example.invalid; }',
      '  server { listen 8082; return https://fixture.example.invalid; }',
      '  server { listen 8083; return 308 https://fixture.example.invalid; if ($host) { return 200; } }',
      '  server { listen 8084; rewrite ^ /elsewhere last; return 301 https://fixture.example.invalid; }',
      '  server { listen 8085; if ($host) { return 404; } return 302 https://fixture.example.invalid; }',
      '  server { listen 8443 ssl;',
      '    location /absent { return 404; }',
      '    location /zero { add_header Strict-Transport-Security "max-age=0" always; return 404; }',
      '    location /ok { return 303 https://fixture.example.invalid; }',
      '    location /rewritten { error_page 404 /ok; return 404; }',
      '  }',
      '  server { listen 8443; }',
      '}',
    ].join('\n'));
    const result = auditRepositoryReadiness(dir);
    const locations = (rule: string) => result.findings.filter(f => f.rule === rule).map(f => [f.file, f.line]);
    assert.deepEqual(locations('PRONTIDAO-TLS-DESATIVADO'), [['Caddyfile', 1], ['nginx.conf', 5], ['nginx.conf', 6], ['nginx.conf', 7]]);
    assert.deepEqual(locations('PRONTIDAO-CABECALHO-HSTS-AUSENTE'), [['Caddyfile', 7], ['nginx.conf', 14]]);
    assert.deepEqual(locations('PRONTIDAO-HSTS-FRACO'), [['Caddyfile', 13], ['nginx.conf', 15]]);
    for (const [file, line] of [['Caddyfile', 18], ...[11, 12, 13, 17, 19].map(line => ['nginx.conf', line])]) {
      assert.ok(result.coverage.some(c => c.status === 'failed' && c.detail.startsWith(file + ': linha ' + line + ',')));
    }
    assert.equal(result.coverage.find(c => c.tool === 'prontidao:requisito:tls-cabecalhos')?.status, 'failed');
    assert.doesNotMatch(JSON.stringify(result), /fixture\.example\.invalid|@fixture|\/elsewhere/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('Redirecionamentos HTTPS validam a autoridade e preservam destinos literais ou modelos conhecidos', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-redirecionamento-'));
  try {
    const invalid = [
      'https://[fixture.invalid', 'https://[not:ipv6]', 'https://[::1]tail',
      'https://fixture.invalid:65536', 'https://fixture.invalid:bad', 'https://fixture.invalid:',
      'https:///elsewhere', 'https://fixture.invalid@', 'https://fixture.invalid/%ZZ',
    ];
    const valid = ['https://fixture.invalid', 'https://[2001:db8::1]:8443/path?x=y', 'https://fixture.invalid/p%20q'];
    const invalidNginx = [...invalid, 'https://fixture.invalid:bad/$request_filename', 'https://[not:ipv6]/${request_filename}'];
    const nginxKnown = [...valid, 'https://${host}$request_uri'];
    const nginxUnknown = [
      'https://fixture.invalid/$request_filename', 'https://$custom_host:bad/path', 'https://$host$request_uri?$custom_query',
      '$redirect_target', '${redirect_target}',
    ];
    writeFileSync(join(dir, 'Caddyfile'), [...invalid, ...valid, 'https://{host}{uri}'].flatMap((target, i) => [
      'http://site' + i + '.invalid {',
      '  redir /* ' + target + ' 303',
      '}',
    ]).join('\n'));
    writeFileSync(join(dir, 'nginx.conf'), [...invalidNginx, ...nginxKnown, ...nginxUnknown].map((target, i) =>
      'server { listen ' + (8000 + i) + '; return 308 "' + target + '"; }').join('\n'));
    const out = auditRepositoryReadiness(dir);
    const findings = (file: string) => out.findings.filter(f => f.file === file && f.rule === 'PRONTIDAO-TLS-DESATIVADO').map(f => f.line);
    assert.deepEqual(findings('Caddyfile'), invalid.map((_, i) => i * 3 + 1));
    assert.ok(out.coverage.some(c => c.status === 'ok' && c.detail.startsWith('Caddyfile: verificações [')));
    assert.deepEqual(findings('nginx.conf'), invalidNginx.map((_, i) => i + 1));
    assert.deepEqual(out.coverage.filter(c => c.status === 'failed' && c.detail.startsWith('nginx.conf: linha '))
      .map(c => Number(/^nginx\.conf: linha (\d+),/.exec(c.detail)?.[1])),
      nginxUnknown.map((_, i) => invalidNginx.length + nginxKnown.length + i + 1));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('Nginx considera o 301 da barra final antes do return da localização', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-nginx-barra-'));
  try {
    const toHttps = 'return 308 https://fixture.invalid;';
    const root = `location / { ${toHttps} }`;
    const app = `location /app/ { ${toHttps} proxy_pass http://fixture.invalid; }`;
    const repeated = 'location /app/// { proxy_pass http://fixture.invalid; }';
    writeFileSync(join(dir, 'nginx.conf'), [
      `server { listen 8000; ${root} ${app} }`,
      `server { listen 8001; absolute_redirect off; ${root} ${app} }`,
      `server { listen 8002; ${root} ${app} location = /app { ${toHttps} } }`,
      `server { listen 8003; ${toHttps} ${root} ${app} }`,
      `server { listen 8004; ${root} location /app/ { ${toHttps} } }`,
      `server { listen 8005; ${root} location /app { ${toHttps} proxy_pass http://fixture.invalid; } }`,
      `server { listen 8006; error_page 301 /redirect; ${root} ${app} }`,
      `server { listen 8007; error_page 404 /redirect; ${root} location /app/ { internal; ${toHttps} proxy_pass http://fixture.invalid; } }`,
      `server { listen 8008; ${root} ${repeated} }`,
      `server { listen 8009; merge_slashes off; ${root} ${repeated} }`,
      `server { listen 8010; merge_slashes on; ${root} ${repeated} }`,
      `server { listen 8011; ${root} location /app// { ${toHttps} proxy_pass http://fixture.invalid; } }`,
      `http { merge_slashes off; server { listen 8012; ${root} ${repeated} }`,
      `  server { listen 8013; merge_slashes on; ${root} ${repeated} } }`,
      `server { listen 8014; merge_slashes off; ${toHttps} }`,
      `server { listen 8014; ${root} ${repeated} }`,
    ].join('\n'));
    const result = auditRepositoryReadiness(dir);
    assert.deepEqual(result.findings.filter(f => f.rule === 'PRONTIDAO-TLS-DESATIVADO').map(f => f.line), [1, 2, 10, 12, 13]);
    assert.deepEqual(result.coverage.filter(c => c.status === 'failed' && c.detail.startsWith('nginx.conf: linha '))
      .map(c => Number(/^nginx\.conf: linha (\d+),/.exec(c.detail)?.[1])), [7, 8, 16]);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('Nginx avalia redirecionamentos por caminho e só aplica error_page a status correspondentes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-nginx-rotas-'));
  try {
    writeFileSync(join(dir, 'nginx.conf'), [
      'http {',
      '  error_page 404 500 =200 /missing;',
      '  server { listen 80; location / { return 303 https://fixture.invalid; } }',
      '  server { listen 8080; error_page 303 /missing; location / { return 303 https://fixture.invalid; } }',
      '  server { listen 8081; location / { return 303 https://fixture.invalid; } location = /clear { return 200; } }',
      '  server { listen 8082; location ^~ / { return 303 https://fixture.invalid; } location /other { return 301 https://fixture.invalid; } }',
      '  server { listen 8083; location / { return 303 https://fixture.invalid; } location ~ ^/other { return 200; } }',
      '  server { listen 8443 ssl; return 303 https://fixture.invalid; add_header Strict-Transport-Security "max-age=0" always; }',
      '  server { listen 8444 ssl; error_page 303 /missing; return 303 https://fixture.invalid; add_header Strict-Transport-Security "max-age=0" always; }',
      '  server { listen 8445 ssl; error_page 303 /missing;',
      '    location / { error_page 404 /local; return 303 https://fixture.invalid; add_header Strict-Transport-Security "max-age=0" always; }',
      '  }',
      '}',
    ].join('\n'));
    const out = auditRepositoryReadiness(dir);
    const locations = (rule: string) => out.findings.filter(f => f.rule === rule).map(f => f.line);
    assert.deepEqual(locations('PRONTIDAO-TLS-DESATIVADO'), [5]);
    assert.deepEqual(locations('PRONTIDAO-HSTS-FRACO'), [8, 11]);
    for (const line of [4, 7, 9]) {
      assert.ok(out.coverage.some(c => c.status === 'failed' && c.detail.startsWith('nginx.conf: linha ' + line + ',')));
    }
    for (const line of [3, 5, 6, 8, 11]) {
      assert.equal(out.coverage.some(c => c.status === 'failed' && c.detail.startsWith('nginx.conf: linha ' + line + ',')), false);
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('cron de usuário e sistema, truncate e catálogo têm evidências distintas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-rotinas-'));
  try {
    mkdirSync(join(dir, 'etc', 'cron.d'), {recursive: true});
    mkdirSync(join(dir, 'var', 'spool', 'cron', 'crontabs'), {recursive: true});
    writeFileSync(join(dir, 'app.service'), '[Service]\nType=oneshot\nStandardError=truncate:/var/log/fixture.log\n');
    writeFileSync(join(dir, 'etc', 'crontab'), '15 2 * * mon root pg_dump --file "fixture local.dump"\n');
    writeFileSync(join(dir, 'etc', 'cron.d', 'fixture'), [
      '@daily backup restic -r /var/backups/fixture forget a4e9b26c',
      '@weekly backup mysql --not-a-dump',
    ].join('\n'));
    writeFileSync(join(dir, 'var', 'spool', 'cron', 'crontabs', 'fixture'), [
      'PATH=/usr/bin',
      '0 3 * * * pg_restore --list fixture.dump',
      '@daily restic check',
      '@weekly borg check',
      '15 3 * * * mysqldump synthetic_db > relative.sql',
    ].join('\n'));
    const result = auditRepositoryReadiness(dir);
    assert.deepEqual(result.findings.filter(f => f.rule === 'PRONTIDAO-BACKUP-DESTINO-INSEGURO').map(f => [f.file, f.line]), [
      ['etc/crontab', 1], ['var/spool/cron/crontabs/fixture', 5],
    ]);
    assert.ok(result.findings.some(f => f.rule === 'PRONTIDAO-LOGROTATE-AUSENTE'));
    assert.ok(result.findings.some(f => f.rule === 'PRONTIDAO-PROVA-RESTAURACAO-AUSENTE'));
    assert.equal(result.findings.some(f => f.rule === 'PRONTIDAO-BACKUP-RETENCAO-AUSENTE'), false);
    const requirement = (out: typeof result) => out.coverage.find(c => c.tool === 'prontidao:requisito:backup-restauracao')?.detail ?? '';
    assert.match(requirement(result), /checagem de catálogo identificada, rotina de restauração não identificada/);
    assert.doesNotMatch(JSON.stringify(result), /fixture local\.dump|relative\.sql|a4e9b26c/);

    writeFileSync(join(dir, 'etc', 'cron.d', 'fixture'), '@daily backup pg_restore -d synthetic_db /var/backups/fixture.dump\n');
    const withRestore = auditRepositoryReadiness(dir);
    assert.match(requirement(withRestore), /checagem de catálogo identificada, rotina de restauração identificada.*prova de restauração requer execução/);
    assert.equal(withRestore.findings.some(f => f.rule === 'PRONTIDAO-PROVA-RESTAURACAO-AUSENTE'), false);
    assert.ok(withRestore.findings.some(f => f.rule === 'PRONTIDAO-BACKUP-RETENCAO-AUSENTE'));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('Restic exige snapshot e destino na restauração, ou snapshot ou política na retenção', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-restic-sintaxe-'));
  try {
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    const script = join(dir, 'backup.sh');
    const audit = (...commands: string[]) => {
      writeFileSync(script, ['#!/bin/sh', 'restic backup /var/lib/fixture', ...commands].join('\n'));
      return auditRepositoryReadiness(dir);
    };
    const absent = (out: ReturnType<typeof audit>) => out.findings.filter(f =>
      ['PRONTIDAO-PROVA-RESTAURACAO-AUSENTE', 'PRONTIDAO-BACKUP-RETENCAO-AUSENTE'].includes(f.rule)).map(f => f.rule);
    assert.deepEqual(absent(audit(
      'restic restore --target /var/tmp/fixture',
      'restic restore latest --target=',
      'restic restore --target latest',
      'restic forget --prune',
      'restic forget --keep-last=0 --prune',
      'restic forget --keep-weekly 2 --dry-run',
    )), ['PRONTIDAO-PROVA-RESTAURACAO-AUSENTE', 'PRONTIDAO-BACKUP-RETENCAO-AUSENTE']);
    const literal = audit(
      'restic -r /var/backups/fixture restore --include /fixture latest --target=/var/tmp/fixture',
      'restic forget --prune --keep-daily 2',
    );
    assert.deepEqual(absent(literal), []);
    assert.match(literal.coverage.find(c => c.tool === 'prontidao:requisito:backup-restauracao')?.detail ?? '',
      /rotina de restauração identificada e retenção de backup identificada.*prova de restauração requer execução/);
    assert.deepEqual(absent(audit('restic restore --target /var/tmp/fixture 2d63c1a5', 'restic forget --keep-within 1m7d')), []);
    for (const command of [
      'restic forget --keep-daily 2 --keep-weekly invalid',
      'restic forget --keep-within invalid --keep-daily 2',
      'restic forget --keep-daily invalid --keep-daily 2',
      'restic forget 2d63c1a5 --keep-weekly invalid',
      'restic forget --keep-tag one, --keep-daily 2',
      'restic forget --keep-daily 2 --keep-daily 0',
    ]) {
      assert.ok(absent(audit(command)).includes('PRONTIDAO-BACKUP-RETENCAO-AUSENTE'), command);
    }
    assert.equal(absent(audit('restic forget --keep-daily 2 --keep-weekly 0')).includes('PRONTIDAO-BACKUP-RETENCAO-AUSENTE'), false);
    const unresolved = audit('restic forget --keep-last="$KEEP"');
    assert.deepEqual(absent(unresolved), []);
    assert.equal(unresolved.coverage.find(c => c.tool === 'prontidao:requisito:backup-restauracao')?.status, 'failed');
    assert.deepEqual(absent(audit('restic restore --target /var/tmp/fixture "$SNAPSHOT"')), []);
    assert.doesNotMatch(JSON.stringify(unresolved), /SNAPSHOT|KEEP|\/var\/tmp\/fixture/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('Gitleaks limita o preparo de snapshots sem metadados Git', async t => {
  const limitCases = [
    ['arquivos', (dir: string) => {
      for (let i = 0; i < 4001; i++) writeFileSync(join(dir, 'empty-' + i), '');
    }, /4000 arquivos/],
    ['bytes por arquivo', (dir: string) => {
      const file = join(dir, 'large');
      writeFileSync(file, '');
      truncateSync(file, 8 * 1024 * 1024 + 1);
    }, /8 MiB por arquivo/],
    ['bytes no total', (dir: string) => {
      for (let i = 0; i < 9; i++) {
        const file = join(dir, 'large-' + i);
        writeFileSync(file, '');
        truncateSync(file, 8 * 1024 * 1024);
      }
    }, /64 MiB no total/],
    ['profundidade', (dir: string) => {
      mkdirSync(join(dir, ...Array<string>(11).fill('nested')), {recursive: true});
    }, /profundidade 10/],
  ] as const;

  for (const [name, prepare, expected] of limitCases) {
    await t.test(name, () => {
      const root = mkdtempSync(join(tmpdir(), 'prontidao-gitleaks-limites-'));
      const repoRoot = join(root, 'fixture');
      mkdirSync(repoRoot);
      let scans = 0;
      try {
        prepare(repoRoot);
        const out = runCollector({
          repoRoot,
          tmpDir: root,
          evidenceFile: '',
          runBin(bin, args) {
            if (bin === 'gitleaks' && args[0] === 'dir') scans++;
            return {status: 1, stdout: '', stderr: ''};
          },
        });
        assert.equal(scans, 0);
        const gitleaks = out.coverage.find(c => c.tool === 'gitleaks');
        assert.equal(gitleaks?.status, 'failed');
        assert.match(gitleaks.detail, expected);
      } finally {
        rmSync(root, {recursive: true, force: true});
      }
    });
  }
});

test('Gitleaks interrompe uma chamada síncrona bloqueada no processo de cópia', t => {
  const root = mkdtempSync(join(tmpdir(), 'prontidao-gitleaks-prazo-'));
  const repoRoot = join(root, 'fixture');
  mkdirSync(repoRoot);
  const source = join(repoRoot, 'small');
  const marker = join(root, 'copy-entered');
  writeFileSync(source, 'fixture\n');
  const preload = 'data:text/javascript,' + encodeURIComponent(`
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const open = fs.openSync;
    fs.openSync = function (path, ...args) {
      if (path === ${JSON.stringify(source)}) {
        fs.writeFileSync(${JSON.stringify(marker)}, 'chamada síncrona iniciada');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      return open.call(fs, path, ...args);
    };
    syncBuiltinESMExports();
  `);
  const spawn = childProcess.spawnSync;
  let copyInterruption;
  let scans = 0;
  try {
    t.mock.method(childProcess, 'spawnSync', (bin: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => {
      assert.equal(args[1], '--prepare-gitleaks-source');
      assert.equal(options.timeout, 5000);
      assert.equal(options.killSignal, 'SIGKILL');
      const result = spawn(bin, ['--import', preload, ...args], options);
      copyInterruption = {signal: result.signal, error: result.error && 'code' in result.error ? result.error.code : undefined};
      return result;
    });
    syncBuiltinESMExports();
    const out = runCollector({
      repoRoot,
      tmpDir: root,
      evidenceFile: '',
      runBin(bin, args) {
        if (bin === 'gitleaks' && args[0] === 'dir') scans++;
        return {status: 1, stdout: '', stderr: ''};
      },
    });
    assert.equal(readFileSync(marker, 'utf8'), 'chamada síncrona iniciada');
    assert.deepEqual(copyInterruption, {signal: 'SIGKILL', error: 'ETIMEDOUT'});
    assert.equal(scans, 0);
    const row = out.coverage.find(c => c.tool === 'gitleaks');
    assert.equal(row?.status, 'failed');
    assert.match(row.detail, /5 s/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, {recursive: true, force: true});
  }
});

function stubCollectorBins(bin: string, args: string[], overrides?: {
  gitleaks?: unknown[];
  hadolint?: unknown[];
  trivy?: unknown;
}) {
  if (args[0] === 'version' || args[0] === '--version') {
    return {status: 0, stdout: 'Version: 1.0.0', stderr: ''};
  }
  if (bin === 'gitleaks') {
    writeFileSync(args[args.indexOf('--report-path') + 1]!, JSON.stringify(overrides?.gitleaks ?? []));
  }
  if (bin === 'hadolint') {
    return {status: 0, stdout: JSON.stringify(overrides?.hadolint ?? []), stderr: ''};
  }
  if (bin === 'trivy') {
    writeFileSync(args[args.indexOf('--output') + 1]!, JSON.stringify(overrides?.trivy ?? {Results: []}));
  }
  return {status: 0, stdout: '[]', stderr: ''};
}

function assertNoHostSecretLeak(out: {coverage: unknown[]; findings: unknown[]}) {
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      assert.equal(hasKnownSecret(value), false, `texto acionou hasKnownSecret: ${value.slice(0, 40)}`);
      return;
    }
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(out);
}

test('caminhos detectados por hasKnownSecret são omitidos dos relatórios com declaração agregada e sem diagnóstico parcial', async () => {
  const secretPath = 'deploy/modules/dependencias/dependencias-tools.lock.json';
  const tokenPath = 'config/ghp_synthetic12345678901234567890.ts';
  assert.equal(hasKnownSecret(secretPath), true);
  assert.equal(hasKnownSecret(tokenPath), true);

  const dir = mkdtempSync(join(tmpdir(), 'prontidao-secret-path-'));
  try {
    mkdirSync(join(dir, 'deploy', 'modules', 'dependencias'), {recursive: true});
    mkdirSync(join(dir, 'config'), {recursive: true});
    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(dir, 'deploy', 'logrotate'), '/var/log/app.log {\n  rotate 7\n  daily\n}\n');
    writeFileSync(join(dir, 'scripts', 'backup.sh'), '#!/bin/sh\nrestic backup /var/lib/app\nrestic forget --keep-daily 7\n');
    writeFileSync(join(dir, 'scripts', 'restore.sh'), '#!/bin/sh\nrestic restore latest --target /var/tmp/restore\n');
    writeFileSync(join(dir, 'scripts', 'watch.sh'), '#!/bin/sh\ndf -P /\nnpm run personal:watch\n');
    writeFileSync(join(dir, secretPath), '{"synthetic":true}\n');
    writeFileSync(join(dir, tokenPath), 'export const ok = true;\n');

    const clean = runCollector({
      repoRoot: dir,
      evidenceFile: '',
      runBin: (bin, args) => stubCollectorBins(bin, args),
    });
    assert.deepEqual(clean.findings, []);
    assert.equal(clean.coverage.some(c => c.status === 'failed'), false);
    assert.equal(clean.coverage.find(c => c.tool === 'prontidao-audit')?.status, 'ok');
    const cleanLimit = clean.coverage.find(c => c.tool === 'prontidao:limites');
    assert.equal(cleanLimit?.status, 'skipped');
    assert.match(cleanLimit?.detail ?? '', /^2 caminho\(s\) omitido\(s\)/);
    assertNoHostSecretLeak(clean);
    const serializedClean = JSON.stringify(clean);
    for (const fragment of ['dependencias-tools', 'ghp_synthetic', 'depl\u2026', 'ghp_\u2026']) {
      assert.equal(serializedClean.includes(fragment), false);
    }
    await validateModuleCollectorPublication(dir, parseModuleCollectorOutput(JSON.stringify(clean), {module: 'prontidao'}));

    writeFileSync(join(dir, 'compose.extra.yaml'), 'services:\n  worker:\n    <<: *unresolved\n');
    writeFileSync(join(dir, 'compose.yaml'), 'services:\n  api:\n    image: scratch\n');
    const partial = runCollector({
      repoRoot: dir,
      evidenceFile: '',
      runBin: (bin, args) => stubCollectorBins(bin, args),
    });
    const scoped = partial.coverage.find(c => c.tool === 'prontidao-audit' && c.status === 'ok')?.files ?? [];
    assert.deepEqual(scoped, [
      'compose.yaml',
      'deploy/logrotate',
      'Dockerfile',
      'scripts/backup.sh',
      'scripts/restore.sh',
      'scripts/watch.sh',
    ]);
    assert.equal(scoped.includes(secretPath), false);
    assert.equal(scoped.includes(tokenPath), false);
    assertNoHostSecretLeak(partial);
    assert.equal(JSON.stringify(partial).includes('dependencias-tools'), false);
    await validateModuleCollectorPublication(dir, parseModuleCollectorOutput(JSON.stringify(partial), {module: 'prontidao'}));

    const skipSecretPath = 'config/AKIA1234567890123456.json';
    assert.equal(hasKnownSecret(skipSecretPath), true);
    writeFileSync(join(dir, skipSecretPath), '');
    truncateSync(join(dir, skipSecretPath), 1024 * 1024 + 1);
    const skippedSecret = runCollector({
      repoRoot: dir,
      evidenceFile: '',
      runBin: (bin, args) => stubCollectorBins(bin, args),
    });
    assertNoHostSecretLeak(skippedSecret);
    assert.equal(JSON.stringify(skippedSecret).includes('AKIA1234567890123456'), false);
    assert.equal(JSON.stringify(skippedSecret).includes('AKIA\u2026'), false);
    assert.equal(skippedSecret.coverage.some(c => c.tool === 'prontidao:limites' && c.status === 'failed'), true);
    await validateModuleCollectorPublication(dir, parseModuleCollectorOutput(JSON.stringify(skippedSecret), {module: 'prontidao'}));
    rmSync(join(dir, skipSecretPath));

    writeFileSync(join(dir, tokenPath), 'const insecure = { rejectUnauthorized: false };\n');
    const withBlockedFinding = runCollector({
      repoRoot: dir,
      evidenceFile: '',
      runBin: (bin, args) => stubCollectorBins(bin, args, {
        gitleaks: [{RuleID: 'generic-api-key', File: join(dir, tokenPath), StartLine: 1}],
        trivy: {Results: [{Target: secretPath, Misconfigurations: [{AVDID: 'AVD-TEST-1', Status: 'FAIL', Severity: 'LOW'}]}]},
      }),
    });
    assert.equal(withBlockedFinding.coverage.find(c => c.tool === 'prontidao-audit')?.status, 'failed');
    assert.equal(withBlockedFinding.coverage.find(c => c.tool === 'prontidao:requisito:tls-cabecalhos')?.status, 'failed');
    assert.equal(withBlockedFinding.coverage.find(c => c.tool === 'gitleaks')?.status, 'failed');
    assert.equal(withBlockedFinding.coverage.find(c => c.tool === 'trivy')?.status, 'failed');
    assert.equal(withBlockedFinding.coverage.some(c => c.tool === 'prontidao:limites' && c.status === 'failed'), true);
    assertNoHostSecretLeak(withBlockedFinding);
    for (const fragment of ['dependencias-tools', 'ghp_synthetic', 'depl\u2026', 'ghp_\u2026']) {
      assert.equal(JSON.stringify(withBlockedFinding).includes(fragment), false);
    }
    await validateModuleCollectorPublication(dir, parseModuleCollectorOutput(JSON.stringify(withBlockedFinding), {module: 'prontidao'}));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('Caddy local válido aciona verificações globais e mantém controle limpo com zero achados', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-caddy-local-'));
  try {
    writeFileSync(join(dir, 'Caddyfile'), 'http://localhost {\n  reverse_proxy 127.0.0.1:3000\n}\n');
    const missing = runCollector({
      repoRoot: dir,
      evidenceFile: '',
      runBin: (bin, args) => stubCollectorBins(bin, args),
    });
    assert.equal(missing.findings.some(f => f.rule === 'PRONTIDAO-TLS-DESATIVADO'), false);
    for (const rule of [
      'PRONTIDAO-BACKUP-AUSENTE',
      'PRONTIDAO-PROVA-RESTAURACAO-AUSENTE',
      'PRONTIDAO-ALERTA-AUSENTE',
      'PRONTIDAO-DISCO-SEM-MONITORAMENTO',
    ]) {
      assert.ok(missing.findings.some(f => f.rule === rule && f.file === 'Caddyfile'), `ausência esperada: ${rule}`);
    }
    await validateModuleCollectorPublication(dir, parseModuleCollectorOutput(JSON.stringify(missing), {module: 'prontidao'}));

    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'scripts', 'backup.sh'), '#!/bin/sh\nrestic backup /var/lib/app\nrestic forget --keep-daily 7\n');
    writeFileSync(join(dir, 'scripts', 'restore.sh'), '#!/bin/sh\nrestic restore latest --target /var/tmp/restore\n');
    writeFileSync(join(dir, 'scripts', 'watch.sh'), '#!/bin/sh\ndf -P /\nnpm run personal:watch\n');
    const clean = runCollector({
      repoRoot: dir,
      evidenceFile: '',
      runBin: (bin, args) => stubCollectorBins(bin, args),
    });
    assert.deepEqual(clean.findings, []);
    assert.equal(clean.coverage.some(c => c.status === 'failed'), false);
    assert.equal(clean.coverage.find(c => c.tool === 'prontidao-audit')?.status, 'ok');
    await validateModuleCollectorPublication(dir, parseModuleCollectorOutput(JSON.stringify(clean), {module: 'prontidao'}));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('artefato de implantação com segmento recusado não invalida a publicação nem simula resultado positivo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-ancora-invalida-'));
  try {
    mkdirSync(join(dir, 'infra '), {recursive: true});
    const invalidDockerfile = join(dir, 'infra ', 'Dockerfile');
    writeFileSync(invalidDockerfile, 'FROM scratch\n');

    const partial = runCollector({
      repoRoot: dir,
      evidenceFile: '',
      runBin: (bin, args) => stubCollectorBins(bin, args, {
        hadolint: [{line: 1, code: 'DL3006', message: 'Always tag image', file: invalidDockerfile, level: 'warning'}],
        trivy: {Results: [{Target: 'infra /Dockerfile', Misconfigurations: [{AVDID: 'AVD-DS-0026', Status: 'FAIL', Severity: 'LOW'}]}]},
      }),
    });
    assert.equal(partial.findings.some(f => f.file.includes('infra ')), false);
    assert.equal(partial.coverage.find(c => c.tool === 'prontidao-audit')?.status, 'failed');
    for (const pillar of ['backup-restauracao', 'alertas-logs', 'disco-memoria']) {
      assert.equal(partial.coverage.find(c => c.tool === `prontidao:requisito:${pillar}`)?.status, 'failed');
    }
    assert.equal(partial.coverage.find(c => c.tool === 'hadolint')?.status, 'failed');
    assert.equal(partial.coverage.find(c => c.tool === 'trivy')?.status, 'failed');
    assert.equal(JSON.stringify(partial).includes('infra '), false);
    await validateModuleCollectorPublication(dir, parseModuleCollectorOutput(JSON.stringify(partial), {module: 'prontidao'}));

    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'scripts', 'backup.sh'), '#!/bin/sh\nrestic backup /var/lib/app\nrestic forget --keep-daily 7\n');
    writeFileSync(join(dir, 'scripts', 'restore.sh'), '#!/bin/sh\nrestic restore latest --target /var/tmp/restore\n');
    writeFileSync(join(dir, 'scripts', 'watch.sh'), '#!/bin/sh\ndf -P /\nnpm run personal:watch\n');
    const clean = runCollector({
      repoRoot: dir,
      evidenceFile: '',
      runBin: (bin, args) => stubCollectorBins(bin, args),
    });
    assert.deepEqual(clean.findings, []);
    assert.equal(clean.coverage.some(c => c.status === 'failed'), false);
    assert.equal(JSON.stringify(clean).includes('infra '), false);
    await validateModuleCollectorPublication(dir, parseModuleCollectorOutput(JSON.stringify(clean), {module: 'prontidao'}));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('controle limpo oficial passa na publicação com zero achados', async () => {
  const clean = runCollector({
    repoRoot: cleanDir,
    evidenceFile: '',
    runBin: (bin, args) => stubCollectorBins(bin, args),
  });
  assert.deepEqual(clean.findings, []);
  assert.equal(clean.coverage.some(c => c.status === 'failed'), false);
  assertNoHostSecretLeak(clean);
  await validateModuleCollectorPublication(cleanDir, parseModuleCollectorOutput(JSON.stringify(clean), {module: 'prontidao'}));
});

test('script operacional com argumento em aspas simples multilinha preserva análise posterior sem reinterpretar corpo citado', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-shell-multiline-'));
  try {
    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(dir, 'scripts', 'watch.sh'), [
      '#!/bin/sh',
      '# personal:watch df -P',
      "node -e '",
      '  // pg_dump -f /tmp/quoted.dump',
      '  // pg_restore -d synthetic /var/backups/quoted.dump',
      '  // restic forget --keep-daily 7',
      '  // personal:watch df -P',
      '  const shift = 1 << 2;',
      '  const tail = "line \\',
      '    still inside single quotes";',
      '  console.log(shift, tail);',
      "' # comentário com pg_dump e df -P",
      'echo "somente texto"',
      '',
    ].join('\n'));

    const quotedOnly = runCollector({
      repoRoot: dir,
      evidenceFile: '',
      runBin: (bin, args) => stubCollectorBins(bin, args),
    });
    assert.equal(quotedOnly.coverage.some(c => c.status === 'failed'), false);
    assert.equal(quotedOnly.coverage.find(c => c.tool === 'prontidao-audit')?.status, 'ok');
    for (const rule of [
      'PRONTIDAO-BACKUP-AUSENTE',
      'PRONTIDAO-PROVA-RESTAURACAO-AUSENTE',
      'PRONTIDAO-ALERTA-AUSENTE',
      'PRONTIDAO-DISCO-SEM-MONITORAMENTO',
    ]) {
      assert.ok(quotedOnly.findings.some(f => f.rule === rule), `ausência esperada sem fatos executáveis: ${rule}`);
    }
    assert.equal(quotedOnly.findings.some(f => f.rule === 'PRONTIDAO-BACKUP-DESTINO-INSEGURO'), false);
    await validateModuleCollectorPublication(dir, parseModuleCollectorOutput(JSON.stringify(quotedOnly), {module: 'prontidao'}));

    writeFileSync(join(dir, 'scripts', 'watch.sh'), [
      '#!/bin/sh',
      'set -eu',
      "node --input-type=module -e '",
      '  // pg_dump -f /tmp/ignored.dump',
      "  const text = \"it'\\''s literal \\\\\";",
      '  const mask = 1 << 3;',
      '  if (text && mask > 0) console.log(text);',
      "' && echo ok",
      'df -P /',
      'npm run personal:watch',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'scripts', 'backup.sh'), [
      '#!/bin/sh',
      "node -e '",
      '  // pg_dump -f /tmp/ignored.dump',
      '  console.log("pre-check");',
      "'",
      'pg_dump -Fc -f /var/backups/app.dump "$DATABASE_URL"',
      'restic forget --keep-daily 7',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'scripts', 'restore.sh'), [
      '#!/bin/sh',
      'pg_restore --exit-on-error -d "$RESTORE_DB" /var/backups/app.dump',
      '',
    ].join('\n'));

    const clean = runCollector({
      repoRoot: dir,
      evidenceFile: '',
      runBin: (bin, args) => stubCollectorBins(bin, args),
    });
    assert.deepEqual(clean.findings, []);
    assert.equal(clean.coverage.some(c => c.status === 'failed'), false);
    assert.equal(clean.coverage.find(c => c.tool === 'prontidao-audit')?.status, 'ok');
    await validateModuleCollectorPublication(dir, parseModuleCollectorOutput(JSON.stringify(clean), {module: 'prontidao'}));

    writeFileSync(join(dir, 'scripts', 'backup.sh'), [
      '#!/bin/sh',
      "node -e '",
      '  console.log("pre-check");',
      "'",
      'pg_dump -Fc -f /tmp/unsafe.dump "$DATABASE_URL"',
      '',
    ].join('\n'));
    const afterClose = auditRepositoryReadiness(dir);
    assert.equal(afterClose.coverage.some(c => c.status === 'failed'), false);
    assert.deepEqual(
      afterClose.findings.filter(f => f.rule === 'PRONTIDAO-BACKUP-DESTINO-INSEGURO').map(f => ({file: f.file, line: f.line})),
      [{file: 'scripts/backup.sh', line: 5}],
    );

    for (const [label, script] of [
      ['aspas simples abertas', "#!/bin/sh\nnode -e '\nconsole.log(1);\n"],
      ['aspas duplas multilinha', '#!/bin/sh\nnode -e "\nconsole.log(1);\n"\n'],
      ['ansi-c multilinha', "#!/bin/sh\nprintf '%s' $'\nhello\n'\n"],
      ['cr em script shell', "#!/bin/sh\nnode -e '\r\nconsole.log(1);\n'\n"],
    ] as const) {
      writeFileSync(join(dir, 'scripts', 'backup.sh'), script);
      const incomplete = auditRepositoryReadiness(dir);
      assert.equal(incomplete.coverage.find(c => c.tool === 'prontidao-audit')?.status, 'failed', label);
      assert.equal(incomplete.coverage.find(c => c.tool === 'prontidao:requisito:backup-restauracao')?.status, 'failed', label);
      assert.ok(
        incomplete.coverage.some(c => c.tool === 'prontidao:arquivo' && c.status === 'failed' && c.detail.startsWith('scripts/backup.sh:')),
        label,
      );
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('linhas de cobertura com nomes protegidos ou segredos em texto livre são omitidas sem dupla contagem', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-coverage-secret-'));
  try {
    mkdirSync(join(dir, 'deploy'), {recursive: true});
    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(dir, '.env.token'), 'APP_SECRET=synthetic-token-value-12345\n');
    writeFileSync(join(dir, 'deploy', 'logrotate-token'), '/var/log/app.log {\n  rotate 7\n  daily\n}\n');
    writeFileSync(join(dir, 'scripts', 'backup.sh'), '#!/bin/sh\nrestic backup /var/lib/app\nrestic forget --keep-daily 7\n');
    writeFileSync(join(dir, 'scripts', 'restore.sh'), '#!/bin/sh\nrestic restore latest --target /var/tmp/restore\n');
    writeFileSync(join(dir, 'scripts', 'watch.sh'), '#!/bin/sh\ndf -P /\nnpm run personal:watch\n');

    const withToken = runCollector({
      repoRoot: dir,
      evidenceFile: '',
      runBin: (bin, args) => stubCollectorBins(bin, args),
    });
    assert.ok(withToken.findings.some(f => f.rule === 'PRONTIDAO-SEGREDO-ARQUIVO-ENV' && f.file === '.env.token'));
    assert.equal(withToken.coverage.some(c => c.detail.includes('.env.token')), false);
    assert.equal(withToken.coverage.some(c => c.detail.includes('logrotate-token')), false);
    assertNoHostSecretLeak(withToken);
    const limitRows = withToken.coverage.filter(c => c.tool === 'prontidao:limites');
    assert.equal(limitRows.length, 1);
    assert.equal(limitRows[0]?.status, 'skipped');
    assert.match(limitRows[0]?.detail ?? '', /^2 caminho\(s\) omitido\(s\) dos relatórios/);
    await validateModuleCollectorPublication(dir, parseModuleCollectorOutput(JSON.stringify(withToken), {module: 'prontidao'}));

    writeFileSync(join(dir, 'compose.extra.yaml'), 'services:\n  worker:\n    <<: *unresolved\n');
    const partialWithToken = runCollector({
      repoRoot: dir,
      evidenceFile: '',
      runBin: (bin, args) => stubCollectorBins(bin, args),
    });
    const scoped = partialWithToken.coverage.find(c => c.tool === 'prontidao-audit' && c.status === 'ok')?.files ?? [];
    assert.equal(scoped.includes('.env.token'), true);
    assert.equal(partialWithToken.coverage.some(c => c.detail.includes('.env.token')), false);
    assertNoHostSecretLeak(partialWithToken);
    await validateModuleCollectorPublication(dir, parseModuleCollectorOutput(JSON.stringify(partialWithToken), {module: 'prontidao'}));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }

  const dedupDir = mkdtempSync(join(tmpdir(), 'prontidao-omitted-dedup-'));
  try {
    mkdirSync(join(dedupDir, 'infra '), {recursive: true});
    writeFileSync(join(dedupDir, 'infra ', 'compose.yaml'), [
      'services:',
      '  api:',
      '    <<: *unresolved',
      '    environment:',
      '      APP_MODE: production',
      '',
    ].join('\n'));
    const out = runCollector({
      repoRoot: dedupDir,
      evidenceFile: '',
      runBin: (bin, args) => stubCollectorBins(bin, args),
    });
    const limitRows = out.coverage.filter(c => c.tool === 'prontidao:limites');
    assert.equal(limitRows.length, 1);
    assert.equal(limitRows[0]?.status, 'failed');
    assert.match(limitRows[0]?.detail ?? '', /^1 caminho\(s\) omitido\(s\) dos relatórios/);
    assert.equal(JSON.stringify(out).includes('infra '), false);
    await validateModuleCollectorPublication(dedupDir, parseModuleCollectorOutput(JSON.stringify(out), {module: 'prontidao'}));
  } finally {
    rmSync(dedupDir, {recursive: true, force: true});
  }
});

test('medições de alerta, disco e rotação em scripts avaliam palavras e posições efetivas de comando', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-shell-positions-'));
  try {
    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(dir, 'app.service'), '[Service]\nType=oneshot\nStandardOutput=append:/var/log/app.log\n');

    // Defect 1 negative: markers after '\'' inside a single multiline printf argument must not count.
    writeFileSync(join(dir, 'scripts', 'watch.sh'), [
      '#!/bin/sh',
      "printf '%s\\n' 'primeira linha",
      "it'\\''s personal:watch df -P rotate 7 daily'",
      '',
    ].join('\n'));
    const escapedSingleQuote = runCollector({
      repoRoot: dir,
      evidenceFile: '',
      runBin: (bin, args) => stubCollectorBins(bin, args),
    });
    assert.equal(escapedSingleQuote.coverage.some(c => c.status === 'failed'), false);
    assert.equal(escapedSingleQuote.coverage.find(c => c.tool === 'prontidao-audit')?.status, 'ok');
    for (const rule of [
      'PRONTIDAO-ALERTA-AUSENTE',
      'PRONTIDAO-DISCO-SEM-MONITORAMENTO',
      'PRONTIDAO-LOGROTATE-AUSENTE',
      'PRONTIDAO-BACKUP-AUSENTE',
      'PRONTIDAO-PROVA-RESTAURACAO-AUSENTE',
    ]) {
      assert.ok(escapedSingleQuote.findings.some(f => f.rule === rule), `ausência esperada em literal multilinha: ${rule}`);
    }
    assert.match(
      escapedSingleQuote.coverage.find(c => c.tool === 'prontidao:requisito:alertas-logs')?.detail ?? '',
      /Diretiva de alerta não identificada e logrotate não identificado/,
    );
    assert.match(
      escapedSingleQuote.coverage.find(c => c.tool === 'prontidao:requisito:disco-memoria')?.detail ?? '',
      /Rotina de disco não identificada/,
    );
    assert.equal(
      escapedSingleQuote.coverage.some(c => c.tool === 'prontidao:arquivo' && c.detail.startsWith('scripts/watch.sh:')),
      false,
    );
    await validateModuleCollectorPublication(dir, parseModuleCollectorOutput(JSON.stringify(escapedSingleQuote), {module: 'prontidao'}));

    // Defect 2 negative: unquoted arguments to printf/echo or command -v must not satisfy alerting/disk/logrotate.
    writeFileSync(join(dir, 'scripts', 'watch.sh'), [
      '#!/bin/sh',
      "printf '%s\\n' personal:watch df -P",
      'echo rotate 7 daily',
      "node -e 'console.log(\"personal-watch.js\")'",
      'command -v df -P',
      '',
    ].join('\n'));
    const printedArgsOnly = runCollector({
      repoRoot: dir,
      evidenceFile: '',
      runBin: (bin, args) => stubCollectorBins(bin, args),
    });
    assert.equal(printedArgsOnly.coverage.some(c => c.status === 'failed'), false);
    for (const rule of ['PRONTIDAO-ALERTA-AUSENTE', 'PRONTIDAO-DISCO-SEM-MONITORAMENTO', 'PRONTIDAO-LOGROTATE-AUSENTE']) {
      assert.ok(printedArgsOnly.findings.some(f => f.rule === rule), `ausência esperada para argumentos impressos: ${rule}`);
    }
    assert.equal(
      printedArgsOnly.coverage.some(c => c.tool === 'prontidao:arquivo' && c.detail.startsWith('scripts/watch.sh:')),
      false,
    );
    await validateModuleCollectorPublication(dir, parseModuleCollectorOutput(JSON.stringify(printedArgsOnly), {module: 'prontidao'}));

    // Defect 1 & 2 positive: real commands with quoted args after multiline literal and with wrappers.
    writeFileSync(join(dir, 'scripts', 'backup.sh'), [
      '#!/bin/sh',
      'restic backup /var/lib/app',
      'restic forget --keep-daily 7',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'scripts', 'restore.sh'), [
      '#!/bin/sh',
      'restic restore latest --target /var/tmp/restore',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'scripts', 'watch.sh'), [
      '#!/bin/sh',
      "printf '%s\\n' 'primeira linha",
      "it'\\''s personal:watch df -P rotate 7 daily'",
      "npm run 'personal:watch'",
      "df '-P' /",
      'logrotate /etc/logrotate.conf',
      '',
    ].join('\n'));
    const quotedCommands = runCollector({
      repoRoot: dir,
      evidenceFile: '',
      runBin: (bin, args) => stubCollectorBins(bin, args),
    });
    assert.deepEqual(quotedCommands.findings, []);
    assert.equal(quotedCommands.coverage.some(c => c.status === 'failed'), false);
    const watchRow = quotedCommands.coverage.find(c => c.tool === 'prontidao:arquivo' && c.detail.startsWith('scripts/watch.sh:'));
    assert.ok(watchRow);
    assert.match(watchRow.detail, /logrotate/);
    assert.match(watchRow.detail, /alerting/);
    assert.match(watchRow.detail, /disk-monitor/);
    await validateModuleCollectorPublication(dir, parseModuleCollectorOutput(JSON.stringify(quotedCommands), {module: 'prontidao'}));

    // Wrapper + quoted forms (sudo / env).
    writeFileSync(join(dir, 'scripts', 'watch.sh'), [
      '#!/bin/sh',
      'sudo -u app npm \'run\' "personal:watch"',
      'env TZ=UTC df "-P" /',
      'sudo -u root logrotate -f /etc/logrotate.conf',
      '',
    ].join('\n'));
    const wrappedCommands = runCollector({
      repoRoot: dir,
      evidenceFile: '',
      runBin: (bin, args) => stubCollectorBins(bin, args),
    });
    assert.deepEqual(wrappedCommands.findings, []);
    assert.equal(wrappedCommands.coverage.some(c => c.status === 'failed'), false);
    await validateModuleCollectorPublication(dir, parseModuleCollectorOutput(JSON.stringify(wrappedCommands), {module: 'prontidao'}));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('delimitação indeterminada em script marca os três requisitos afetados como parciais e preserva fatos locais anteriores', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-shell-partial-pillars-'));
  try {
    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');

    // Defect 3: multiline double-quoted printf before df and personal:watch.
    writeFileSync(join(dir, 'scripts', 'watch.sh'), [
      '#!/bin/sh',
      'printf \'%s\\n\' "linha 1',
      'linha 2"',
      'df -P /',
      'npm run personal:watch',
      '',
    ].join('\n'));
    const interrupted = runCollector({
      repoRoot: dir,
      evidenceFile: '',
      runBin: (bin, args) => stubCollectorBins(bin, args),
    });
    assert.equal(interrupted.coverage.find(c => c.tool === 'prontidao-audit')?.status, 'failed');
    for (const pillar of ['backup-restauracao', 'alertas-logs', 'disco-memoria']) {
      assert.equal(interrupted.coverage.find(c => c.tool === `prontidao:requisito:${pillar}`)?.status, 'failed', pillar);
    }
    assert.ok(
      interrupted.coverage.some(c => c.tool === 'prontidao:arquivo' && c.status === 'failed' && c.detail.startsWith('scripts/watch.sh: linha 2,')),
    );
    for (const rule of [
      'PRONTIDAO-ALERTA-AUSENTE',
      'PRONTIDAO-DISCO-SEM-MONITORAMENTO',
      'PRONTIDAO-BACKUP-AUSENTE',
      'PRONTIDAO-PROVA-RESTAURACAO-AUSENTE',
    ]) {
      assert.equal(interrupted.findings.some(f => f.rule === rule), false, `ausência não pode ser declarada após interrupção: ${rule}`);
    }
    await validateModuleCollectorPublication(dir, parseModuleCollectorOutput(JSON.stringify(interrupted), {module: 'prontidao'}));

    // Preserves local facts interpreted before the indeterminate delimitation.
    writeFileSync(join(dir, 'scripts', 'watch.sh'), [
      '#!/bin/sh',
      "df '-P' /",
      'printf \'%s\\n\' "linha 1',
      'linha 2"',
      "npm run 'personal:watch'",
      '',
    ].join('\n'));
    const prefixPreserved = runCollector({
      repoRoot: dir,
      evidenceFile: '',
      runBin: (bin, args) => stubCollectorBins(bin, args),
    });
    assert.equal(prefixPreserved.coverage.find(c => c.tool === 'prontidao:requisito:disco-memoria')?.status, 'failed');
    assert.match(
      prefixPreserved.coverage.find(c => c.tool === 'prontidao:requisito:disco-memoria')?.detail ?? '',
      /Rotina de disco identificada.*Cobertura parcial/,
    );
    assert.equal(prefixPreserved.coverage.find(c => c.tool === 'prontidao:requisito:alertas-logs')?.status, 'failed');
    assert.equal(prefixPreserved.coverage.find(c => c.tool === 'prontidao:requisito:backup-restauracao')?.status, 'failed');
    assert.ok(
      prefixPreserved.coverage.some(c => c.tool === 'prontidao:arquivo' && c.status === 'failed' && c.detail.includes('verificações [disk-monitor]')),
    );
    assert.ok(
      prefixPreserved.coverage.some(c => c.tool === 'prontidao:arquivo' && c.status === 'failed' && c.detail.startsWith('scripts/watch.sh: linha 3,')),
    );
    assert.equal(prefixPreserved.findings.some(f => f.rule === 'PRONTIDAO-ALERTA-AUSENTE'), false);
    await validateModuleCollectorPublication(dir, parseModuleCollectorOutput(JSON.stringify(prefixPreserved), {module: 'prontidao'}));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('comando composto com wrapper sudo e opções aciona cobertura parcial mesmo com outro backup válido', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-sudo-compound-'));
  try {
    mkdirSync(join(dir, 'deploy'), {recursive: true});
    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(dir, 'deploy', 'logrotate'), '/var/log/app.log {\n  rotate 7\n  daily\n}\n');
    writeFileSync(join(dir, 'scripts', 'watch.sh'), '#!/bin/sh\ndf -P /\nnpm run personal:watch\n');
    writeFileSync(join(dir, 'scripts', 'restore.sh'), '#!/bin/sh\nrestic restore latest --target /var/tmp/restore\n');

    // Defect 4 positive (partial coverage): compound sudo -u postgres pg_dump alongside another valid backup.
    writeFileSync(join(dir, 'scripts', 'backup.sh'), [
      '#!/bin/sh',
      'restic backup /var/lib/app',
      'restic forget --keep-daily 7',
      'sudo -u postgres pg_dump -Fc -f /tmp/app.dump && echo ok',
      '',
    ].join('\n'));
    const compoundSudo = runCollector({
      repoRoot: dir,
      evidenceFile: '',
      runBin: (bin, args) => stubCollectorBins(bin, args),
    });
    assert.equal(compoundSudo.coverage.find(c => c.tool === 'prontidao-audit')?.status, 'failed');
    assert.equal(compoundSudo.coverage.find(c => c.tool === 'prontidao:requisito:backup-restauracao')?.status, 'failed');
    assert.equal(compoundSudo.coverage.find(c => c.tool === 'prontidao:requisito:alertas-logs')?.status, 'ok');
    assert.equal(compoundSudo.coverage.find(c => c.tool === 'prontidao:requisito:disco-memoria')?.status, 'ok');
    assert.ok(
      compoundSudo.coverage.some(c => c.tool === 'prontidao:arquivo' && c.status === 'failed' && c.detail.startsWith('scripts/backup.sh: linha 4,')),
    );
    await validateModuleCollectorPublication(dir, parseModuleCollectorOutput(JSON.stringify(compoundSudo), {module: 'prontidao'}));

    // Simple command with sudo -u postgres unwraps and detects unsafe /tmp destination.
    writeFileSync(join(dir, 'scripts', 'backup.sh'), [
      '#!/bin/sh',
      'sudo -u postgres pg_dump -Fc -f /tmp/app.dump',
      'restic forget --keep-daily 7',
      '',
    ].join('\n'));
    const simpleSudo = auditRepositoryReadiness(dir);
    assert.equal(simpleSudo.coverage.some(c => c.status === 'failed'), false);
    assert.deepEqual(
      simpleSudo.findings.filter(f => f.rule === 'PRONTIDAO-BACKUP-DESTINO-INSEGURO').map(f => ({file: f.file, line: f.line})),
      [{file: 'scripts/backup.sh', line: 2}],
    );

    // Negative control: quoted pg_dump inside compound command without any other backup must not trigger partial or backup.
    writeFileSync(join(dir, 'scripts', 'backup.sh'), [
      '#!/bin/sh',
      'node -e \'console.log("pg_dump -Fc -f /tmp/ignored.dump")\' && echo ok',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'scripts', 'restore.sh'), '#!/bin/sh\necho ok\n');
    const quotedCompound = auditRepositoryReadiness(dir);
    assert.equal(quotedCompound.coverage.some(c => c.status === 'failed'), false);
    assert.equal(quotedCompound.coverage.find(c => c.tool === 'prontidao:requisito:backup-restauracao')?.status, 'ok');
    assert.ok(quotedCompound.findings.some(f => f.rule === 'PRONTIDAO-BACKUP-AUSENTE'));
    assert.equal(quotedCompound.findings.some(f => f.rule === 'PRONTIDAO-BACKUP-DESTINO-INSEGURO'), false);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('consultas e argumentos de wrappers não se confundem com operações de prontidão', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-r6-'));
  try {
    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(dir, 'app.service'), '[Service]\nType=oneshot\nStandardOutput=append:/var/log/app.log\n');
    const audit = (lines: string[]) => {
      writeFileSync(join(dir, 'scripts', 'maintenance.sh'), ['#!/bin/sh', ...lines, ''].join('\n'));
      return runCollector({repoRoot: dir, evidenceFile: '', runBin: (bin, args) => stubCollectorBins(bin, args)});
    };
    const has = (out: ReturnType<typeof runCollector>, rule: string) => out.findings.some(f => f.rule === rule);
    const status = (out: ReturnType<typeof runCollector>, pillar: string) => out.coverage.find(c => c.tool === `prontidao:requisito:${pillar}`)?.status;

    for (const line of ['./constructor --help', 'sudo -l -- pg_dump -Fc -f /tmp/app.dump', 'sudo -l -- pg_dump -Fc -f /tmp/app.dump && true']) {
      const out = audit([line]);
      assert.equal(status(out, 'backup-restauracao'), 'ok', line);
      assert.equal(has(out, 'PRONTIDAO-BACKUP-DESTINO-INSEGURO'), false, line);
      assert.equal(has(out, 'PRONTIDAO-BACKUP-AUSENTE'), true, line);
    }
    const execution = audit(['sudo -u postgres pg_dump -Fc -f /tmp/app.dump']);
    assert.equal(has(execution, 'PRONTIDAO-BACKUP-DESTINO-INSEGURO'), true);
    const ambiguous = audit(['sudo --opcao-desconhecida pg_dump -Fc -f /tmp/app.dump']);
    assert.equal(status(ambiguous, 'backup-restauracao'), 'failed');
    assert.equal(has(ambiguous, 'PRONTIDAO-BACKUP-AUSENTE'), false);

    const wrapped = audit(['timeout 10s df -P /', 'timeout 30s npm run personal:watch']);
    assert.equal(has(wrapped, 'PRONTIDAO-DISCO-SEM-MONITORAMENTO'), false);
    assert.equal(has(wrapped, 'PRONTIDAO-ALERTA-AUSENTE'), false);
    const invalid = audit(['timeout --help df -P /', 'timeout npm run personal:watch', 'timeout --kill-after=bad 30s npm run personal:watch']);
    assert.equal(has(invalid, 'PRONTIDAO-DISCO-SEM-MONITORAMENTO'), true);
    assert.equal(has(invalid, 'PRONTIDAO-ALERTA-AUSENTE'), true);
    const timeoutOptions = audit(['timeout -k 5s -- 10s df -P /', 'timeout --signal=TERM 30s npm run personal:watch']);
    assert.equal(has(timeoutOptions, 'PRONTIDAO-DISCO-SEM-MONITORAMENTO'), false);
    assert.equal(has(timeoutOptions, 'PRONTIDAO-ALERTA-AUSENTE'), false);

    const optionValues = audit(["curl -o '$WEBHOOK_ALERT' https://example.com/health", 'logrotate -s /var/lib/logrotate/status']);
    assert.equal(has(optionValues, 'PRONTIDAO-ALERTA-AUSENTE'), true);
    assert.equal(has(optionValues, 'PRONTIDAO-LOGROTATE-AUSENTE'), true);
    const targets = audit(['curl -o /tmp/result --url "$WEBHOOK_ALERT"', 'logrotate -s /var/lib/logrotate/status /etc/logrotate.conf']);
    assert.equal(has(targets, 'PRONTIDAO-ALERTA-AUSENTE'), false);
    assert.equal(has(targets, 'PRONTIDAO-LOGROTATE-AUSENTE'), false);
    const longOptions = audit(["curl --output='$WEBHOOK_ALERT' https://example.com/health", 'logrotate --state=/var/lib/logrotate/status']);
    assert.equal(has(longOptions, 'PRONTIDAO-ALERTA-AUSENTE'), true);
    assert.equal(has(longOptions, 'PRONTIDAO-LOGROTATE-AUSENTE'), true);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('R6: argumentos ambíguos afetam apenas a cobertura correspondente', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-r7-'));
  try {
    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(dir, 'app.service'), '[Service]\nStandardOutput=append:/var/log/app.log\n');
    const audit = async (line: string) => {
      writeFileSync(join(dir, 'scripts', 'maintenance.sh'), `#!/bin/sh\n${line}\n`);
      const out = runCollector({repoRoot: dir, evidenceFile: '', runBin: (bin, args) => stubCollectorBins(bin, args)});
      await validateModuleCollectorPublication(dir, parseModuleCollectorOutput(JSON.stringify(out), {module: 'prontidao'}));
      return out;
    };
    const has = (out: ReturnType<typeof runCollector>, rule: string) => out.findings.some(f => f.rule === rule);
    const status = (out: ReturnType<typeof runCollector>, pillar: string) => out.coverage.find(c => c.tool === `prontidao:requisito:${pillar}`)?.status;
    for (const option of ['--signal=BOGUS', '--signal BOGUS', '-s BOGUS', '-sBOGUS', '--signal=65']) {
      const out = await audit(`timeout ${option} 30s npm run personal:watch`);
      assert.equal(has(out, 'PRONTIDAO-ALERTA-AUSENTE'), true, option);
      assert.equal(status(out, 'alertas-logs'), 'ok', option);
    }
    for (const option of ['--signal=TERM', '-s SIGTERM', '-s9', '--signal=RTMIN+1', '--signal=64', '--signal=32']) {
      const out = await audit(`timeout ${option} 30s npm run personal:watch`);
      assert.equal(has(out, 'PRONTIDAO-ALERTA-AUSENTE'), false, option);
      assert.equal(status(out, 'alertas-logs'), 'ok', option);
    }
    for (const suffix of ['', ' && true']) {
      const disk = await audit(`timeout "$LIMITE" df -P /${suffix}`);
      assert.equal(status(disk, 'disco-memoria'), 'failed', suffix);
      assert.equal(has(disk, 'PRONTIDAO-DISCO-SEM-MONITORAMENTO'), false, suffix);
      assert.equal(status(disk, 'backup-restauracao'), 'ok', suffix);
      assert.equal(status(disk, 'alertas-logs'), 'ok', suffix);
      assert.equal(has(disk, 'PRONTIDAO-BACKUP-AUSENTE'), true, suffix);
      const backup = await audit(`timeout "$LIMITE" pg_dump db${suffix}`);
      assert.equal(status(backup, 'backup-restauracao'), 'failed', suffix);
      assert.equal(has(backup, 'PRONTIDAO-BACKUP-AUSENTE'), false, suffix);
      assert.equal(status(backup, 'alertas-logs'), 'ok', suffix);
      assert.equal(status(backup, 'disco-memoria'), 'ok', suffix);
      const signal = await audit(`timeout -s "$SINAL" 30s npm run personal:watch${suffix}`);
      assert.equal(status(signal, 'alertas-logs'), 'failed', suffix);
      assert.equal(has(signal, 'PRONTIDAO-ALERTA-AUSENTE'), false, suffix);
      assert.equal(status(signal, 'backup-restauracao'), 'ok', suffix);
      assert.equal(status(signal, 'disco-memoria'), 'ok', suffix);
    }
    for (const line of ['curl -fsS --retry 3 --retry-connrefused "$WEBHOOK_ALERT"', 'curl -fsS "$WEBHOOK_ALERT" --retry-connrefused']) {
      const out = await audit(line);
      assert.equal(has(out, 'PRONTIDAO-ALERTA-AUSENTE'), false, line);
      assert.equal(status(out, 'alertas-logs'), 'ok', line);
    }
    for (const line of ['logrotate --wait-for-state-lock /etc/logrotate.conf', 'logrotate /etc/logrotate.conf --wait-for-state-lock']) {
      const out = await audit(line);
      assert.equal(has(out, 'PRONTIDAO-LOGROTATE-AUSENTE'), false, line);
      assert.equal(status(out, 'alertas-logs'), 'ok', line);
    }
    for (const line of ['curl --retry 3 --referer "$WEBHOOK_ALERT" https://example.com', 'logrotate --wait-for-state-lock --state /tmp/state']) {
      const out = await audit(line);
      assert.equal(has(out, line.startsWith('curl') ? 'PRONTIDAO-ALERTA-AUSENTE' : 'PRONTIDAO-LOGROTATE-AUSENTE'), true, line);
      assert.equal(status(out, 'alertas-logs'), 'ok', line);
    }
    for (const line of ['curl --opcao-desconhecida "$WEBHOOK_ALERT"', 'curl --config "$CONFIG"', 'curl "$WEBHOOK_ALERT" --opcao-desconhecida', 'curl "$DESTINO"', 'logrotate "$CONFIG"', 'logrotate --opcao-desconhecida /etc/logrotate.conf']) {
      const out = await audit(line);
      assert.equal(status(out, 'alertas-logs'), 'failed', line);
      assert.equal(has(out, 'PRONTIDAO-ALERTA-AUSENTE'), false, line);
      assert.equal(has(out, 'PRONTIDAO-LOGROTATE-AUSENTE'), false, line);
      assert.equal(status(out, 'backup-restauracao'), 'ok', line);
      assert.equal(status(out, 'disco-memoria'), 'ok', line);
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('R8: validade do timeout, posição do executável e array HTTP genérico', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-r8-'));
  try {
    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(dir, 'app.service'), '[Service]\nStandardOutput=append:/var/log/app.log\n');
    const audit = async (script: string) => {
      writeFileSync(join(dir, 'scripts', 'fixture.sh'), `#!/bin/bash\n${script}\n`);
      const out = runCollector({repoRoot: dir, evidenceFile: '', runBin: (bin, args) => stubCollectorBins(bin, args)});
      await validateModuleCollectorPublication(dir, parseModuleCollectorOutput(JSON.stringify(out), {module: 'prontidao'}));
      return out;
    };
    const has = (out: ReturnType<typeof runCollector>, rule: string) => out.findings.some(f => f.rule === rule);
    const status = (out: ReturnType<typeof runCollector>, pillar: string) => out.coverage.find(c => c.tool === `prontidao:requisito:${pillar}`)?.status;
    for (const args of ['--signal=143 30s', '1e1s', '-k 1e-2s 0x1p2s', '+1s', '.1s']) {
      const out = await audit(`timeout ${args} npm run personal:watch`);
      assert.equal(status(out, 'alertas-logs'), 'ok', args);
      assert.equal(has(out, 'PRONTIDAO-ALERTA-AUSENTE'), false, args);
    }
    // Fixed expectations from the production GNU coreutils 9.7 image, independent of the host.
    const durationCases: [string, boolean][] = [
      ['1s', true], ['30S', false], ['30ss', false], ['1e1s', true], ['0x1P2s', true],
      ['+1s', true], ['.1s', true], ['INF', true], ['1e', false], ['1s ', false],
    ];
    for (const [value, accepted] of durationCases) {
      for (const killAfter of [false, true]) {
        const options = killAfter ? [`--kill-after=${value}`, '1s'] : ['--', value];
        // Quote whitespace as a single shell word in the static fixture.
        const literal = `'${value}'`;
        const out = await audit(killAfter
          ? `timeout --kill-after=${literal} 1s npm run personal:watch`
          : `timeout -- ${literal} npm run personal:watch`);
        assert.equal(status(out, 'alertas-logs'), 'ok', JSON.stringify(options));
        assert.equal(has(out, 'PRONTIDAO-ALERTA-AUSENTE'), !accepted, JSON.stringify(options));
      }
    }
    for (const [value, accepted] of [['32', true], ['33', true], ['64', true], ['65', false], ['128', true],
      ['143', true], ['159', true], ['160', true], ['191', true], ['192', true], ['255', false],
      ['256', true], ['271', true], ['288', true], ['320', true], ['384', false], ['2147483648', false]] as [string, boolean][]) {
      const out = await audit(`timeout --signal=${value} 1s npm run personal:watch`);
      assert.equal(status(out, 'alertas-logs'), 'ok', value);
      assert.equal(has(out, 'PRONTIDAO-ALERTA-AUSENTE'), !accepted, value);
    }
    for (const command of ['npm run personal:watch', 'df -P /', 'pg_dump db']) {
      for (const options of ['30s', '--foreground 30s', '-- 30s']) {
        const out = await audit(`timeout "$OPCAO" ${options} ${command}`);
        const pillar = command.startsWith('npm') ? 'alertas-logs' : command.startsWith('df') ? 'disco-memoria' : 'backup-restauracao';
        assert.equal(status(out, pillar), 'failed', `${options}: ${command}`);
        if (command.startsWith('npm')) assert.equal(has(out, 'PRONTIDAO-ALERTA-AUSENTE'), false, options);
      }
    }
    const empty = await audit('timeout --signal= 30s npm run personal:watch');
    assert.equal(status(empty, 'alertas-logs'), 'ok');
    assert.equal(has(empty, 'PRONTIDAO-ALERTA-AUSENTE'), true);
    for (const line of [
      'timeout -- "$LIMITE" 30s npm run personal:watch',
      'timeout -- "$LIMITE" 30s df -P /',
      'timeout -- "$LIMITE" 30s pg_dump db',
    ]) {
      const out = await audit(line);
      for (const pillar of ['alertas-logs', 'disco-memoria', 'backup-restauracao']) assert.equal(status(out, pillar), 'ok', line);
      assert.equal(has(out, 'PRONTIDAO-ALERTA-AUSENTE'), true, line);
      assert.equal(has(out, 'PRONTIDAO-BACKUP-AUSENTE'), true, line);
    }
    for (const duration of ['1,5s', '0x1,8p2s']) {
      for (const args of [`-- ${duration}`, `--kill-after=${duration} 30s`, `--kill-after ${duration} 30s`, `-k${duration} 30s`, `-k ${duration} 30s`]) {
        for (const [command, pillar, rule] of [
          ['npm run personal:watch', 'alertas-logs', 'PRONTIDAO-ALERTA-AUSENTE'],
          ['df -P /', 'disco-memoria', 'PRONTIDAO-DISCO-SEM-MONITORAMENTO'],
          ['pg_dump db', 'backup-restauracao', 'PRONTIDAO-BACKUP-AUSENTE'],
        ]) {
          const out = await audit(`timeout ${args} ${command}`);
          assert.equal(status(out, pillar), 'failed', `${args}: ${command}`);
          assert.equal(has(out, rule), false, `${args}: ${command}`);
          for (const other of ['alertas-logs', 'disco-memoria', 'backup-restauracao'].filter(x => x !== pillar)) assert.equal(status(out, other), 'ok', `${args}: ${command}: ${other}`);
        }
      }
    }
    for (const value of ['1,5S', '1,5ss', '1,2,3s']) {
      for (const args of [`-- ${value}`, `--kill-after=${value} 30s`]) {
        const out = await audit(`timeout ${args} npm run personal:watch`);
        assert.equal(status(out, 'alertas-logs'), 'ok', args);
        assert.equal(has(out, 'PRONTIDAO-ALERTA-AUSENTE'), true, args);
      }
    }
    for (const line of [
      `timeout "$LIMITE" /usr/bin/printf '%s\\n' pg_dump npm run personal:watch`,
      `timeout --signal="$SINAL" 30s /usr/bin/printf '%s\\n' pg_dump npm run personal:watch && true`,
    ]) {
      const out = await audit(line);
      for (const pillar of ['alertas-logs', 'backup-restauracao', 'disco-memoria']) assert.equal(status(out, pillar), 'ok', line);
      assert.equal(has(out, 'PRONTIDAO-ALERTA-AUSENTE'), true, line);
      assert.equal(has(out, 'PRONTIDAO-BACKUP-AUSENTE'), true, line);
    }
    const generic = await audit([
      'request() {',
      '  local destination="$1"',
      '  local args=(-sS -X POST "$destination" -H "Content-Type: application/json")',
      '  if [ -n "$2" ]; then args+=(-d "$2"); fi',
      '  curl "${args[@]}"',
      '}',
    ].join('\n'));
    assert.equal(status(generic, 'alertas-logs'), 'failed');
    assert.equal(status(generic, 'backup-restauracao'), 'ok');
    assert.equal(status(generic, 'disco-memoria'), 'ok');
    assert.equal(has(generic, 'PRONTIDAO-ALERTA-AUSENTE'), false);
    assert.equal(has(generic, 'PRONTIDAO-LOGROTATE-AUSENTE'), false);
    assert.equal(has(generic, 'PRONTIDAO-BACKUP-AUSENTE'), true);
    assert.ok(generic.coverage.some(c => c.tool === 'prontidao:arquivo' && c.status === 'failed' && c.detail.includes('argumentos operacionais de alertas')));
    // The report receives no reviewed findings here, isolating the coverage contribution to its note.
    const raw = parseModuleCollectorOutput(JSON.stringify(generic), {module: 'prontidao'});
    mkdirSync(join(dir, 'reports'));
    const report = await writeModuleReport({dataDirectory: join(dir, 'reports'), projectId: '11111111-1111-4111-8111-111111111111',
      module: 'prontidao', runId: '33333333-3333-4333-8333-333333333333', createdAt: new Date('2026-11-19T00:00:00Z'),
      commit: '0123456789abcdef0123456789abcdef01234567', toolCoverage: raw.coverage, fileCoverage: [], achados: [], raw});
    assert.equal(report.summary.toolFailures, raw.coverage.filter(c => c.status === 'failed').length);
    assert.ok(report.summary.toolFailures > 0);
    assert.match(readFileSync(join(report.directory, 'README.md'), 'utf8'), /Nota de falha: execução com .*falha/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('R11: incerteza de timeout preserva somente os requisitos possíveis', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-r11-'));
  try {
    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(dir, 'app.service'), '[Service]\nStandardOutput=append:/var/log/app.log\n');
    const audit = (line: string) => {
      writeFileSync(join(dir, 'scripts', 'fixture.sh'), `#!/bin/sh\n${line}\n`);
      return runCollector({repoRoot: dir, evidenceFile: '', runBin: (bin, args) => stubCollectorBins(bin, args)});
    };
    const pillars = ['alertas-logs', 'disco-memoria', 'backup-restauracao'];
    const status = (out: ReturnType<typeof audit>, pillar: string) => out.coverage.find(c => c.tool === `prontidao:requisito:${pillar}`)?.status;
    const has = (out: ReturnType<typeof audit>, rule: string) => out.findings.some(f => f.rule === rule);
    for (const [signal, accepted] of [['32', true], ['33', true], ['160', true], ['288', true], ['SIG160', false], ['SIG32', false], ['SIGTERM', true], ['TERM', true]] as [string, boolean][]) {
      const out = audit(`timeout --signal=${signal} 30s npm run personal:watch`);
      assert.equal(status(out, 'alertas-logs'), 'ok', signal);
      assert.equal(has(out, 'PRONTIDAO-ALERTA-AUSENTE'), !accepted, signal);
    }
    for (const [duration, expected] of [['-0,0s', 'failed'], ['-0,1s', 'ok'], ['1,5s', 'failed'], ['1,5ss', 'ok'], ['-0.0s', 'ok'], ['-1s', 'ok']] as [string, string][]) {
      for (const args of [`-- ${duration}`, `--kill-after=${duration} 30s`, `-k ${duration} 30s`]) {
        const out = audit(`timeout ${args} npm run personal:watch`);
        assert.equal(status(out, 'alertas-logs'), expected, args);
        assert.equal(has(out, 'PRONTIDAO-ALERTA-AUSENTE'), expected === 'ok' && duration !== '-0.0s', args);
      }
    }
    for (const suffix of ['', ' && true', ' | cat']) {
      for (const [command, pillar, rule] of [
        ['npm run personal:watch', 'alertas-logs', 'PRONTIDAO-ALERTA-AUSENTE'],
        ['df -P /', 'disco-memoria', 'PRONTIDAO-DISCO-SEM-MONITORAMENTO'],
        ['pg_dump db', 'backup-restauracao', 'PRONTIDAO-BACKUP-AUSENTE'],
      ]) {
        for (const prefix of ['timeout -- $LIMITE 30s', 'timeout "$OPCAO" 1,5s', 'timeout -- 1,5s']) {
          const line = `${prefix} ${command}${suffix}`;
          const out = audit(line);
          for (const p of pillars) assert.equal(status(out, p), p === pillar ? 'failed' : 'ok', `${line}: ${p}`);
          assert.equal(has(out, rule), false, line);
        }
      }
      const backup = audit(`timeout -- 1,5s sh -c 'pg_dump db'${suffix}`);
      assert.equal(status(backup, 'backup-restauracao'), 'failed', suffix);
      assert.equal(has(backup, 'PRONTIDAO-BACKUP-AUSENTE'), false, suffix);
      for (const p of ['alertas-logs', 'disco-memoria']) assert.equal(status(backup, p), 'ok', suffix);
      for (const line of [`timeout -- 1,5s pg_dump --version${suffix}`, `timeout -- 1,5s sh -c 'pg_dump --version'${suffix}`]) {
        const out = audit(line);
        assert.equal(status(out, 'backup-restauracao'), 'ok', line);
        assert.equal(has(out, 'PRONTIDAO-BACKUP-AUSENTE'), true, line);
      }
    }
    const quoted = audit('timeout -- "$LIMITE" 30s npm run personal:watch');
    assert.equal(status(quoted, 'alertas-logs'), 'ok');
    assert.equal(has(quoted, 'PRONTIDAO-ALERTA-AUSENTE'), true);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('R12: posições possíveis de timeout e rotinas condicionais por pilar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-r12-'));
  try {
    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(dir, 'app.service'), '[Service]\nStandardOutput=append:/var/log/app.log\n');
    const pillars = ['alertas-logs', 'disco-memoria', 'backup-restauracao'];
    const rules = ['PRONTIDAO-ALERTA-AUSENTE', 'PRONTIDAO-DISCO-SEM-MONITORAMENTO', 'PRONTIDAO-BACKUP-AUSENTE'];
    const quoteShell = (body: string) => `'${body.replace(/'/g, `'\\''`)}'`;
    const nestShell = (body: string) => `sh -c ${quoteShell(body)}`;
    const cases: [string, number | null, boolean][] = [
      ['timeout "$OPCAO" TERM 30s npm run personal:watch', 0, false],
      ['timeout --signal=$OPCAO npm run personal:watch', 0, false],
      ['timeout -- "$@" 30s df -P /', 1, false],
      ['timeout -- "${itens[@]}" 30s df -P /', 1, false],
      [`timeout -- 1,5s sh -c 'sh -c "df -P /"'`, 1, false],
      [`timeout -- 1,5s sh -c 'sh -c "npm run personal:watch"'`, 0, false],
      ['timeout -- 1,5s pg_dump -h db.example app', 2, false],
      [`timeout -- 1,5s sh -c 'pg_dump db' --help | cat`, 2, false],
      ['timeout 1,5s 30s npm run personal:watch', null, false],
      ['timeout -- -0x0d npm run personal:watch', null, false],
      [`timeout -- 1,5s sh -c 'find . -print'`, null, false],
      ['timeout -- 1,5s restic snapshots', null, false],
      ['timeout -- 1,5s sqlite3 db "select 1"', null, false],
      ['timeout -- 1,5s pg_restore arquivo.dump', null, false],
      ['timeout --signal="$OPCAO" 30s printf npm run personal:watch', null, false],
      [`timeout -- 1,5s sh -c 'find . -mtime +7 -delete'`, 2, false],
      ['timeout -- -0x0p0 npm run personal:watch', null, true],
      ['timeout -- -0x0s npm run personal:watch', null, true],
      ['timeout -- 30s pg_dump -h db.example app', null, true],
      ['pg_dump -vh', null, false],
      ['timeout -- 1,5s pg_dump -vh', null, false],
      ["pg_dump -n '-tenant' app", null, true],
      ['restic backup -- --help', null, true],
      ['timeout -s"$SINAL" TERM 30s df -P /', 1, false],
      ['timeout i"$RESTO" df -P /', 1, false],
      [nestShell(nestShell(nestShell('timeout -- 1,5s echo pg_dump'))), null, false],
      [nestShell(nestShell(nestShell('echo df'))), null, false],
      [nestShell(nestShell(nestShell('df -P /'))), 1, false],
      [nestShell(nestShell(nestShell('pg_dump db'))), 2, false],
      ['pg_dump -h', null, false],
      ['pg_restore -d app -h', null, false],
      ['timeout -- 1,5s pg_dump -h', null, false],
      ['timeout -- 1,5s pg_restore -d app -h', null, false],
      ["find . -exec echo '-mtime' '+7' '-delete' '{}' +", null, false],
      ["timeout -- 1,5s find . -exec echo '-mtime' '+7' '-delete' '{}' +", null, false],
      ['timeout -s"$SINAL" npm run personal:watch', null, false],
      ['timeout invalido"$OPCAO" 30s npm run personal:watch', null, false],
      ['timeout 3"$LIMITE" npm run personal:watch', 0, false],
      ['timeout -- 1,5s restic --help', null, false],
      ['timeout -- 1,5s borg --help', null, false],
      ['timeout --signal=$OPCOES TERM 30s df -P /', 1, false],
      [`timeout -- 30s sh -c 'sh -c "pg_dump db"'`, null, true],
      [`timeout -- 1,5s sh -c 'sh -c "pg_dump db"'`, 2, false],
      [`timeout -- 30s sh -c 'sh -c "sh -c \"pg_dump db\""'`, 2, false],
      ['timeout -- 1,5s pg_dump -h db.example app', 2, false],
      ['pg_dump -h db.example app', null, true],

    ];
    for (const [line, rule, present] of [
      ['pg_restore -d app -vh', 'PRONTIDAO-PROVA-RESTAURACAO-AUSENTE', true],
      ['pg_restore -d app -- --list', 'PRONTIDAO-PROVA-RESTAURACAO-AUSENTE', false],
      ["pg_dump db\nfind . -exec echo + '-mtime' '+7' '-delete' '{}' ';'", 'PRONTIDAO-BACKUP-RETENCAO-AUSENTE', true],
      ["pg_dump db\nfind . -mtime +7 -fprint '-delete'", 'PRONTIDAO-BACKUP-RETENCAO-AUSENTE', true],
      ['pg_dump db\nfind . -mtime +7 -o -delete', 'PRONTIDAO-BACKUP-RETENCAO-AUSENTE', false],
      ["pg_dump db\nfind . -exec echo '{}' + -mtime +7 -delete", 'PRONTIDAO-BACKUP-RETENCAO-AUSENTE', false],
      ['pg_restore -d app -h', 'PRONTIDAO-PROVA-RESTAURACAO-AUSENTE', true],
      ['pg_restore -d app -h db.example', 'PRONTIDAO-PROVA-RESTAURACAO-AUSENTE', false],
      ["pg_dump db; find . -exec echo '-mtime' '+7' '-delete' '{}' +", 'PRONTIDAO-BACKUP-RETENCAO-AUSENTE', true],
      ['pg_dump db\nfind . -mtime +7 -delete', 'PRONTIDAO-BACKUP-RETENCAO-AUSENTE', false],
    ] as [string, string, boolean][]) {
      // Separate declarations avoid treating a compound command as certain evidence.
      writeFileSync(join(dir, 'scripts', 'fixture.sh'), `#!/bin/sh\n${line.replace('; ', '\n')}\n`);
      const out = runCollector({repoRoot: dir, evidenceFile: '', runBin: (bin, args) => stubCollectorBins(bin, args)});
      assert.equal(out.findings.some(f => f.rule === rule), present, line);
    }
    for (const duration of ['30s', '1,5s']) {
      const line = `timeout -- ${duration} sh -c 'echo "sem fechamento' pg_dump`;
      writeFileSync(join(dir, 'scripts', 'fixture.sh'), `#!/bin/sh\n${line}\n`);
      const out = runCollector({repoRoot: dir, evidenceFile: '', runBin: (bin, args) => stubCollectorBins(bin, args)});
      assert.equal(out.coverage.find(c => c.tool === 'prontidao:requisito:backup-restauracao')?.status, 'ok', line);
      assert.ok(out.findings.some(f => f.rule === 'PRONTIDAO-BACKUP-AUSENTE'), line);
    }
    for (const [line, partial, positive] of cases) {
      writeFileSync(join(dir, 'scripts', 'fixture.sh'), `#!/bin/sh\n${line}\n`);
      const out = runCollector({repoRoot: dir, evidenceFile: '', runBin: (bin, args) => stubCollectorBins(bin, args)});
      for (const [i, pillar] of pillars.entries()) {
        assert.equal(out.coverage.find(c => c.tool === `prontidao:requisito:${pillar}`)?.status, i === partial ? 'failed' : 'ok', `${line}: ${pillar}`);
        const positivePillar = positive && (line.includes('pg_dump') || line.startsWith('restic') ? i === 2 : i === 0);
        assert.equal(out.findings.some(f => f.rule === rules[i]), i !== partial && !positivePillar, `${line}: ${rules[i]}`);
      }
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('R14: prova positiva de retenção e posições de operandos', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-r14-'));
  try {
    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    const audit = (line: string) => {
      writeFileSync(join(dir, 'scripts', 'fixture.sh'), `#!/bin/sh\n${line}\n`);
      return runCollector({repoRoot: dir, evidenceFile: '', runBin: (bin, args) => stubCollectorBins(bin, args)});
    };
    const has = (out: ReturnType<typeof audit>, rule: string) => out.findings.some(f => f.rule === rule);
    for (const expression of ['! -mtime +7 -delete', '-mtime +7 -o -delete', '-delete -mtime +7', '-mtime +7 -delete -o -delete']) {
      const out = audit(`pg_dump db\nfind . ${expression}`);
      assert.ok(has(out, 'PRONTIDAO-BACKUP-RETENCAO-AUSENTE') || out.coverage.find(c => c.tool === 'prontidao:requisito:backup-restauracao')?.status === 'failed', expression);
    }
    const clean = audit('pg_dump db\nfind . -mtime +7 -delete');
    assert.equal(has(clean, 'PRONTIDAO-BACKUP-RETENCAO-AUSENTE'), false);
    const coverage = clean.coverage.find(c => c.tool === 'prontidao:requisito:backup-restauracao');
    assert.equal(coverage?.status, 'ok');
    assert.match(coverage?.detail ?? '', /retenção de backup identificada/);
    assert.equal(has(audit('pg_dump -V'), 'PRONTIDAO-BACKUP-AUSENTE'), true);
    assert.equal(has(audit('pg_dump -vV'), 'PRONTIDAO-BACKUP-AUSENTE'), true);
    assert.equal(has(audit("pg_dump -n '-falso' -f /seguro/real.sql app"), 'PRONTIDAO-BACKUP-DESTINO-INSEGURO'), false);
    assert.equal(has(audit('pg_dump -vfbackup.sql app'), 'PRONTIDAO-BACKUP-DESTINO-INSEGURO'), true);
    assert.equal(has(audit('pg_dump -vf /seguro/backup.sql app'), 'PRONTIDAO-BACKUP-DESTINO-INSEGURO'), false);
    assert.equal(has(audit('restic -r --help backup /srv'), 'PRONTIDAO-BACKUP-AUSENTE'), false);
    assert.equal(has(audit('restic backup -r --help /srv'), 'PRONTIDAO-BACKUP-AUSENTE'), false);
    assert.equal(has(audit('restic --help'), 'PRONTIDAO-BACKUP-AUSENTE'), true);
    for (const duration of ['30s', '1,5s']) {
      const out = audit(`timeout -- ${duration} sh -c 'echo "pg_dump df'`);
      for (const pillar of ['backup-restauracao', 'disco-memoria']) assert.equal(out.coverage.find(c => c.tool === `prontidao:requisito:${pillar}`)?.status, 'ok');
    }
    const out = audit('timeout -sT"$SINAL" TERM 30s df -P /');
    assert.equal(out.coverage.find(c => c.tool === 'prontidao:requisito:disco-memoria')?.status, 'ok');
    assert.ok(has(out, 'PRONTIDAO-DISCO-SEM-MONITORAMENTO'));
    assert.equal(audit('timeout -s"$SINAL" TERM 30s df -P /').coverage.find(c => c.tool === 'prontidao:requisito:disco-memoria')?.status, 'failed');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});


test('R15: expressões completas e posições de opções e operandos', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-r15-'));
  try {
    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    const audit = (line: string) => {
      writeFileSync(join(dir, 'scripts', 'fixture.sh'), `#!/bin/sh\n${line}\n`);
      return runCollector({repoRoot: dir, evidenceFile: '', runBin: (bin, args) => stubCollectorBins(bin, args)});
    };
    const coverage = (out: ReturnType<typeof audit>, pillar = 'backup-restauracao') => out.coverage.find(c => c.tool === `prontidao:requisito:${pillar}`);
    const has = (out: ReturnType<typeof audit>, rule: string) => out.findings.some(f => f.rule === rule);
    for (const expression of ['-mtime +7 -delete -and', '-mtime +7 -delete -name', '-mtime +7 -delete -o -print', '-mtime +7 -delete -unknown']) {
      const out = audit(`pg_dump db\nfind . ${expression}`);
      assert.equal(coverage(out)?.status, 'failed', expression);
      assert.doesNotMatch(coverage(out)?.detail ?? '', /retenção de backup identificada/, expression);
    }
    for (const expression of ['-name --help -mtime +7 -delete', '-mtime +7 -and -name -delete -delete']) {
      const out = audit(`pg_dump db\nfind . ${expression}`);
      assert.equal(coverage(out)?.status, 'ok', expression);
      assert.match(coverage(out)?.detail ?? '', /retenção de backup identificada/, expression);
    }
    const print = audit('pg_dump db\nfind . -print -o -print0');
    assert.equal(coverage(print)?.status, 'ok');
    assert.ok(has(print, 'PRONTIDAO-BACKUP-RETENCAO-AUSENTE'));
    for (const option of ["'-?'", '-V', '-vV']) assert.ok(has(audit(`pg_dump ${option}`), 'PRONTIDAO-BACKUP-AUSENTE'), option);
    const pg = audit("pg_dump -N '-falso' app > /seguro/real.sql");
    assert.equal(has(pg, 'PRONTIDAO-BACKUP-DESTINO-INSEGURO'), false);
    assert.equal(has(pg, 'PRONTIDAO-BACKUP-AUSENTE'), false);
    const restic = audit('restic -r --help --verbose backup /srv');
    assert.equal(coverage(restic)?.status, 'failed');
    for (const option of ['-vsT', '-fpvsT']) {
      const timeout = audit(`timeout ${option}"$SINAL" TERM 30s df -P /`);
      assert.equal(coverage(timeout, 'disco-memoria')?.status, 'ok', option);
      assert.ok(has(timeout, 'PRONTIDAO-DISCO-SEM-MONITORAMENTO'), option);
    }
    const shell = audit(`timeout -- 30s sh -c 'npm run personal:backup "'`);
    assert.equal(coverage(shell)?.status, 'failed');
    for (const pillar of ['disco-memoria', 'alertas-logs']) assert.equal(coverage(shell, pillar)?.status, 'ok', pillar);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});


test('R16: retenção conservadora e segmentos recuperáveis de shell malformado', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-r16-'));
  try {
    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    const audit = (line: string) => {
      writeFileSync(join(dir, 'scripts', 'fixture.sh'), `#!/bin/sh\n${line}\n`);
      return runCollector({repoRoot: dir, evidenceFile: '', runBin: (bin, args) => stubCollectorBins(bin, args)});
    };
    const coverage = (out: ReturnType<typeof audit>, pillar = 'backup-restauracao') => out.coverage.find(c => c.tool === `prontidao:requisito:${pillar}`);
    const has = (out: ReturnType<typeof audit>, rule: string) => out.findings.some(f => f.rule === rule);
    for (const expr of ['-mtime +7 -delete -mtime invalido', '-mtime 0 -mtime +7 -delete', '-type invalido -mtime +7 -delete', '-mtime +7 -delete -type invalido', '-type f -type d -mtime +7 -delete', '-mtime +7 -delete -type d', '-mtime +7 -delete -atime errado', '-size errado -mtime +7 -delete', '-mtime +999999999999999999999999 -delete']) {
      const out = audit(`pg_dump db\nfind . ${expr}`);
      assert.equal(coverage(out)?.status, 'failed', expr);
      assert.doesNotMatch(coverage(out)?.detail ?? '', /retenção de backup identificada/, expr);
    }
    for (const expr of ['-mtime +7 -delete', '-type f -mtime +7 -delete', '-name --help -mtime +7 -delete']) {
      const out = audit(`pg_dump db\nfind . ${expr}`);
      assert.equal(coverage(out)?.status, 'ok', expr);
      assert.match(coverage(out)?.detail ?? '', /retenção de backup identificada/, expr);
    }
    for (const expr of ["-printf '-delete'", "-fprint '-delete'", "-fprintf '-delete' '-mtime'", "-exec echo '-delete' '{}' +"]) {
      const out = audit(`pg_dump db\nfind . ${expr}`);
      assert.equal(coverage(out)?.status, 'ok', expr);
      assert.ok(has(out, 'PRONTIDAO-BACKUP-RETENCAO-AUSENTE'), expr);
    }
    for (const body of ['npm --silent run personal:backup "', 'npm run "personal:backup" "']) {
      const out = audit(`timeout -- 30s sh -c '${body}'`);
      assert.equal(coverage(out)?.status, 'failed', body);
      for (const pillar of ['disco-memoria', 'alertas-logs']) assert.equal(coverage(out, pillar)?.status, 'ok', body);
    }
    const mixed = audit(`timeout -- 30s sh -c 'npm run personal:backup ; df -P / "'`);
    assert.equal(coverage(mixed)?.status, 'failed');
    assert.equal(coverage(mixed, 'disco-memoria')?.status, 'failed');
    assert.equal(coverage(mixed, 'alertas-logs')?.status, 'ok');
    const raw = parseModuleCollectorOutput(JSON.stringify(mixed), {module: 'prontidao'});
    mkdirSync(join(dir, 'reports'));
    const report = await writeModuleReport({dataDirectory: join(dir, 'reports'), projectId: '11111111-1111-4111-8111-111111111111',
      module: 'prontidao', runId: '33333333-3333-4333-8333-333333333333', createdAt: new Date('2026-11-19T00:00:00Z'),
      commit: '0123456789abcdef0123456789abcdef01234567', toolCoverage: raw.coverage, fileCoverage: [], achados: [], raw});
    assert.equal(report.summary.toolFailures, raw.coverage.filter(c => c.status === 'failed').length);
    assert.ok(report.summary.toolFailures >= 2);
    const quoted = audit(`timeout -- 30s sh -c 'echo "texto ; df -P /'`);
    assert.equal(coverage(quoted, 'disco-memoria')?.status, 'ok');
    assert.ok(has(quoted, 'PRONTIDAO-DISCO-SEM-MONITORAMENTO'));
    for (const [destination, unsafe] of [['/seguro/real.sql', false], ['/tmp/real.sql', true]] as const) {
      const out = audit(`pg_dump -N '-falso' app > ${destination}`);
      assert.equal(coverage(out)?.status, 'ok');
      assert.match(coverage(out)?.detail ?? '', /Backup identificado/);
      assert.equal(has(out, 'PRONTIDAO-BACKUP-DESTINO-INSEGURO'), unsafe);
    }
    const timeout = audit('timeout -vsTERM 30s df -P /');
    assert.equal(coverage(timeout, 'disco-memoria')?.status, 'ok');
    assert.match(coverage(timeout, 'disco-memoria')?.detail ?? '', /Rotina de disco identificada/);
    assert.ok(has(audit("pg_dump '-?'"), 'PRONTIDAO-BACKUP-AUSENTE'));
    assert.equal(coverage(audit('restic -r --help --verbose backup /srv'))?.status, 'failed');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('R17: nomes de find e recuperação lexical usam classificação com argumentos', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-r17-'));
  try {
    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    const audit = (line: string) => {
      writeFileSync(join(dir, 'scripts', 'fixture.sh'), `#!/bin/sh\n${line}\n`);
      return runCollector({repoRoot: dir, evidenceFile: '', runBin: (bin, args) => stubCollectorBins(bin, args)});
    };
    const coverage = (out: ReturnType<typeof audit>, pillar: string) => out.coverage.find(c => c.tool === `prontidao:requisito:${pillar}`);
    const has = (out: ReturnType<typeof audit>, rule: string) => out.findings.some(f => f.rule === rule);
    const backup = 'backup-restauracao', disk = 'disco-memoria', alert = 'alertas-logs';
    for (const pattern of ['sub/backup.sql', '[abc', '[ab]ackup.sql', '']) {
      const out = audit(`pg_dump db\nfind . -name '${pattern}' -mtime +7 -delete`);
      assert.equal(coverage(out, backup)?.status, 'failed', pattern);
      assert.doesNotMatch(coverage(out, backup)?.detail ?? '', /retenção de backup identificada/, pattern);
    }
    for (const pattern of ['backup.sql', '*.sql', '*', 'backup-??.sql', '--help']) {
      const out = audit(`pg_dump db\nfind . -name '${pattern}' -mtime +7 -delete`);
      assert.equal(coverage(out, backup)?.status, 'ok', pattern);
      assert.match(coverage(out, backup)?.detail ?? '', /retenção de backup identificada/, pattern);
    }
    const noAction = audit("pg_dump db\nfind . -name 'sub/backup.sql' -print");
    assert.equal(coverage(noAction, backup)?.status, 'ok');
    for (const action of ['-ok', '-okdir']) {
      const out = audit(`pg_dump db\nfind . ${action} echo '{}' + '-delete' ';'`);
      assert.equal(coverage(out, backup)?.status, 'ok', action);
      assert.ok(has(out, 'PRONTIDAO-BACKUP-RETENCAO-AUSENTE'), action);
    }
    for (const action of ['-exec', '-execdir']) {
      const out = audit(`pg_dump db\nfind . ${action} echo '{}' + -mtime +7 -delete`);
      assert.equal(coverage(out, backup)?.status, 'failed', action);
    }
    const shell = (body: string) => `sh -c '${body.replace(/'/g, "'\\''")}'`;
    for (const body of ['npm run personal:backup; timeout -- 30s df -P / "', `echo "$(printf '%s' '"')"; df -P / "`]) {
      const out = audit(shell(body));
      assert.equal(coverage(out, disk)?.status, 'failed', body);
      assert.equal(coverage(out, alert)?.status, 'ok', body);
      assert.equal(coverage(out, backup)?.status, body.startsWith('npm') ? 'failed' : 'ok', body);
      assert.doesNotMatch(coverage(out, disk)?.detail ?? '', /Rotina de disco identificada/, body);
    }
    for (const body of ['pg_dump --version; echo "', 'echo pg_dump df; echo "', 'echo "df -P /; pg_dump db', 'echo ok # df -P /; pg_dump db', 'echo ${x:-df; pg_dump db}; echo "', 'echo $(printf "df; pg_dump") ; echo "']) {
      const out = audit(shell(body));
      for (const pillar of [backup, disk, alert]) assert.equal(coverage(out, pillar)?.status, 'ok', `${body}: ${pillar}`);
      assert.ok(has(out, 'PRONTIDAO-BACKUP-AUSENTE'), body);
      assert.ok(has(out, 'PRONTIDAO-DISCO-SEM-MONITORAMENTO'), body);
    }
    const query = audit(shell('pg_dump --version; echo "'));
    const raw = parseModuleCollectorOutput(JSON.stringify(query), {module: 'prontidao'});
    mkdirSync(join(dir, 'reports'));
    const report = await writeModuleReport({dataDirectory: join(dir, 'reports'), projectId: '11111111-1111-4111-8111-111111111111',
      module: 'prontidao', runId: '33333333-3333-4333-8333-333333333333', createdAt: new Date('2026-11-19T00:00:00Z'),
      commit: '0123456789abcdef0123456789abcdef01234567', toolCoverage: raw.coverage, fileCoverage: [], achados: [], raw});
    assert.equal(report.summary.toolFailures, raw.coverage.filter(c => c.status === 'failed').length);
    assert.equal(raw.coverage.find(c => c.tool === 'prontidao:requisito:backup-restauracao')?.status, 'ok');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});


test('R19: retenção demonstrável e recuperação lexical de redirecionamentos', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-r19-'));
  try {
    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    const audit = (line: string) => {
      writeFileSync(join(dir, 'scripts', 'fixture.sh'), `#!/bin/sh\n${line}\n`);
      return runCollector({repoRoot: dir, evidenceFile: '', runBin: (bin, args) => stubCollectorBins(bin, args)});
    };
    const status = (out: ReturnType<typeof audit>, pillar: string) => out.coverage.find(c => c.tool === `prontidao:requisito:${pillar}`)?.status;
    const backup = 'backup-restauracao', disk = 'disco-memoria', alert = 'alertas-logs';
    for (const expr of [
      "-path 'backup.sql' -mtime +7 -delete", "-ipath 'backup.sql' -mtime +7 -delete",
      "-name 'backup.sql' -name 'archive.sql' -mtime +7 -delete",
      "-name . -mtime +7 -delete", "-name .. -mtime +7 -delete",
      `-name ${'a'.repeat(256)} -mtime +7 -delete`,
      `-name ${'?'.repeat(256)} -mtime +7 -delete`,
      '-mtime +7 -delete -name backup.sql', '-mtime +7 -print -delete',
      '-mtime +7 -delete -delete',
    ]) {
      const out = audit(`pg_dump db\nfind /srv/backups ${expr}`);
      assert.equal(status(out, backup), 'failed', expr);
      assert.doesNotMatch(out.coverage.find(c => c.tool === `prontidao:requisito:${backup}`)?.detail ?? '', /retenção de backup identificada/, expr);
    }
    for (const expr of ['-name backup.sql -type f -mtime +7 -delete', '-mtime +7 -delete', `-name ${'a'.repeat(255)} -mtime +7 -delete`]) {
      const out = audit(`pg_dump db\nfind . ${expr}`);
      assert.equal(status(out, backup), 'ok', expr);
      assert.match(out.coverage.find(c => c.tool === `prontidao:requisito:${backup}`)?.detail ?? '', /retenção de backup identificada/, expr);
    }
    assert.equal(status(audit('pg_dump db\nfind . -path backup.sql -print'), backup), 'ok');
    const shell = (body: string) => `sh -c '${body.replace(/'/g, "'\\''")}'`;
    for (const redirect of ['>&', '<&', '2>&', '0<&', '>', '<', '&>']) {
      for (const target of ['df -P /', 'alertmanager', 'logrotate /tmp/log.conf', 'pg_dump db']) {
        const body = `echo ${redirect}${target}; echo "`;
        const out = audit(shell(body));
        for (const pillar of [backup, disk, alert]) assert.equal(status(out, pillar), 'ok', `${body}: ${pillar}`);
      }
    }
    for (const [command, pillar] of [['df -P /', disk], ['alertmanager', alert], ['logrotate /tmp/log.conf', alert], ['npm run personal:backup', backup]] as const) {
      for (const prefix of ['echo ok; ', `echo "$(printf '%s' x\\ #)"; `, `echo "$(echo $(printf '%s' x\\ #))"; `]) {
        const body = `${prefix}${command}; echo "`;
        assert.equal(status(audit(shell(body)), pillar), 'failed', body);
      }
    }
    for (const body of [`echo "$(echo # comment\ndf -P /)"; echo "`, `echo "$(echo # comment df -P /)"; echo "`, `echo "$(cat <<EOF)"; df -P /; echo "`, `echo >&; df -P /; echo "`, `echo <&; df -P /; echo "`]) {
      assert.equal(status(audit(shell(body)), disk), 'ok', body);
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});


test('R20: fronteiras conservadoras em redirecionamentos e substituições', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-r20-'));
  try {
    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    const audit = (body: string) => {
      const escaped = body.replace(/'/g, "'\\''");
      writeFileSync(join(dir, 'scripts', 'fixture.sh'), `#!/bin/sh\nsh -c '${escaped}'\n`);
      return runCollector({repoRoot: dir, evidenceFile: '', runBin: (bin, args) => stubCollectorBins(bin, args)});
    };
    const status = (out: ReturnType<typeof audit>, pillar: string) => out.coverage.find(c => c.tool === `prontidao:requisito:${pillar}`)?.status;
    const backup = 'backup-restauracao', disk = 'disco-memoria', alert = 'alertas-logs';
    const check = (body: string, expected: string | null) => {
      const out = audit(body);
      for (const pillar of [backup, disk, alert]) assert.equal(status(out, pillar), pillar === expected ? 'failed' : 'ok', `${body}: ${pillar}`);
    };
    for (const op of ['<>', '>|', '0<>', '2>|']) {
      check(`df -P / ${op}/dev/null; echo "`, disk);
      check(`echo ${op}df; echo "`, null);
      check(`echo ${op}; df -P /; echo "`, null);
    }
    check('echo $(case x in y) :; df -P /;; esac); echo "', null);
    check('npm run personal:backup; echo $(case x in y) :; df -P /;; esac); echo "', backup);
    for (const inner of ['alertmanager', 'logrotate /tmp/log.conf', 'npm run personal:backup']) {
      check(`echo $(case x in y) :; ${inner};; esac); echo "`, null);
    }
    check(`df -P / <>/dev/null\necho "`, disk);
    check(`echo <>\ndf -P /; echo "`, null);
    for (const inner of ['cat <<EOF', 'if true; then df -P /; fi', 'echo (df -P /)', 'echo ${x:-df -P /}', 'echo "${x:-df -P /}"']) {
      check(`echo $(${inner}); df -P /; echo "`, null);
    }
    for (const space of ['\u00a0', '\u2003', '\\ ']) {
      check(`echo "$(printf '%s' x${space}#)"; df -P /; echo "`, disk);
    }
    check(`echo "$(printf '%s' x # comment\n)"; df -P /; echo "`, disk);
    check(`echo "$(printf '%s' x # df -P /)"; echo "`, null);
    check(`echo ok # comment\ndf -P /; echo "`, disk);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('R21: heredocs e substituições só atravessam fronteiras comprovadas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-r21-'));
  try {
    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    const check = (body: string, expected: string | null) => {
      writeFileSync(join(dir, 'scripts', 'fixture.sh'), `#!/bin/sh\nsh -c '${body.replace(/'/g, "'\\''")}'\n`);
      const out = runCollector({repoRoot: dir, evidenceFile: '', runBin: (bin, args) => stubCollectorBins(bin, args)});
      for (const pillar of ['backup-restauracao', 'disco-memoria', 'alertas-logs']) {
        assert.equal(out.coverage.find(c => c.tool === `prontidao:requisito:${pillar}`)?.status,
          pillar === expected ? 'failed' : 'ok', `${body}: ${pillar}`);
      }
    };
    for (const op of ['<<', '0<<', '3<<-', '<<-']) {
      for (const inner of ['df -P /', 'npm run personal:backup', 'alertmanager']) {
        check(`cat ${op}EOF\n${inner}\nEOF\necho "`, null);
      }
      check(`df -P /; cat ${op}EOF\nalertmanager\nEOF\necho "`, 'disco-memoria');
    }
    check('echo $(ca\\\nse x i\\\nn y) :; df -P /;; esac); echo "', null);
    for (const head of ['ca\\\nse', 'ec\\\nho', 'printf\\\n', 'cat', '"echo"', 'env echo']) {
      check(`echo $(${head} x) :; df -P /; echo "`, null);
    }
    for (const arg of ['in', 'case', 'if', "'in'", 'x\\ #']) {
      check(`echo "$(printf '%s' ${arg})"; df -P /; echo "`, 'disco-memoria');
    }
    check(`echo "$(echo $(printf '%s' in))"; df -P /; echo "`, 'disco-memoria');
    check('echo $(echo $var); df -P /; echo "', null);
    check('echo $(echo data\ndf -P /); alertmanager; echo "', null);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
