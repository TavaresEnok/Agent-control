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
      ['cat <<EOF | wc -l', 'pg_dump -f fixture.dump', 'EOF'],
    ]) {
      const result = audit(lines);
      assert.equal(backupMissing(result), true);
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

test('dotenv multilinha e âncoras inline do Compose preservam apenas as localizações', () => {
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
    const nginxUnknown = ['https://fixture.invalid/$request_filename', 'https://$custom_host:bad/path', 'https://$host$request_uri?$custom_query'];
    writeFileSync(join(dir, 'Caddyfile'), [...invalid, ...valid, 'https://{host}{uri}'].flatMap((target, i) => [
      'http://site' + i + '.invalid {',
      '  redir /* ' + target + ' 303',
      '}',
    ]).join('\n'));
    writeFileSync(join(dir, 'nginx.conf'), [...invalidNginx, ...nginxKnown, ...nginxUnknown].map((target, i) =>
      'server { listen ' + (8000 + i) + '; return 303 "' + target + '"; }').join('\n'));
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
    writeFileSync(join(dir, 'nginx.conf'), [
      `server { listen 8000; ${root} ${app} }`,
      `server { listen 8001; absolute_redirect off; ${root} ${app} }`,
      `server { listen 8002; ${root} ${app} location = /app { ${toHttps} } }`,
      `server { listen 8003; ${toHttps} ${root} ${app} }`,
      `server { listen 8004; ${root} location /app/ { ${toHttps} } }`,
      `server { listen 8005; ${root} location /app { ${toHttps} proxy_pass http://fixture.invalid; } }`,
      `server { listen 8006; error_page 301 /redirect; ${root} ${app} }`,
      `server { listen 8007; error_page 404 /redirect; ${root} location /app/ { internal; ${toHttps} proxy_pass http://fixture.invalid; } }`,
    ].join('\n'));
    const result = auditRepositoryReadiness(dir);
    assert.deepEqual(result.findings.filter(f => f.rule === 'PRONTIDAO-TLS-DESATIVADO').map(f => f.line), [1, 2]);
    assert.deepEqual(result.coverage.filter(c => c.status === 'failed' && c.detail.startsWith('nginx.conf: linha '))
      .map(c => Number(/^nginx\.conf: linha (\d+),/.exec(c.detail)?.[1])), [7, 8]);
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
    assert.equal(absent(unresolved).length, 2);
    assert.equal(unresolved.coverage.find(c => c.tool === 'prontidao:requisito:backup-restauracao')?.status, 'failed');
    assert.equal(absent(audit('restic restore --target /var/tmp/fixture "$SNAPSHOT"')).length, 2);
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
